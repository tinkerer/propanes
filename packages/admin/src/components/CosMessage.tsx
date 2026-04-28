import { useEffect, useState } from 'preact/hooks';
import {
  getSessionIdForThread,
  retryFailedAssistantMessage,
  dismissFailedAssistantMessage,
  type ChiefOfStaffMsg,
  type ChiefOfStaffVerbosity,
} from '../lib/chief-of-staff.js';
import { stripCosReplyMarkers } from '../lib/cos-reply-tags.js';
import { openSession, toggleCompanion } from '../lib/sessions.js';
import { MessageRenderer } from './MessageRenderer.js';
import { MessageAttachments } from './CosMessageAttachments.js';
import { AssistantContent } from './CosAssistantContent.js';

// Re-export pure helpers/types so existing imports of CosMessage continue to
// resolve while keeping the heavy parsing logic in lib/cos-markdown.ts and
// the artifact / prose rendering in CosAssistantContent.tsx.
export { linkifyHtml, parseAssistantContent } from '../lib/cos-markdown.js';
export type { ArtifactKind, ContentSegment } from '../lib/cos-markdown.js';
export { MessageAttachments };

// Splits `text` on (case-insensitive) occurrences of `highlight` and wraps the
// matches in `<mark class="cos-search-hit">`. Falls back to plain text when
// highlight is empty / not found. Used for inline search-result highlighting.
export function HighlightedText({ text, highlight }: { text: string; highlight?: string | null }) {
  if (!highlight) return <>{text}</>;
  const q = highlight.trim();
  if (!q) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  if (!lowerText.includes(lowerQ)) return <>{text}</>;
  const parts: import('preact').ComponentChildren[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const hit = lowerText.indexOf(lowerQ, i);
    if (hit < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<mark key={key++} class="cos-search-hit">{text.slice(hit, hit + q.length)}</mark>);
    i = hit + q.length;
  }
  return <>{parts}</>;
}

function formatRelativeTime(ts: number, now: number): { rel: string; abs: string } {
  const d = new Date(ts);
  const abs = d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  let rel: string;
  if (s < 10) rel = 'just now';
  else if (s < 60) rel = `${s}s ago`;
  else if (s < 3600) rel = `${Math.floor(s / 60)}m ago`;
  else if (s < 86400) rel = `${Math.floor(s / 3600)}h ago`;
  else if (s < 86400 * 7) rel = `${Math.floor(s / 86400)}d ago`;
  else rel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { rel, abs };
}

export function Timestamp({ ts }: { ts: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const age = Date.now() - ts;
    const tickMs = age < 60_000 ? 5_000 : age < 3_600_000 ? 30_000 : 300_000;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [ts]);
  const { rel, abs } = formatRelativeTime(ts, now);
  return <span class="cos-msg-time" title={abs}>{rel}</span>;
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfYesterday) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DayDivider({ ts }: { ts: number }) {
  const label = dayLabel(ts);
  return (
    <div class="cos-day-divider" role="separator" aria-label={label}>
      <span class="cos-day-divider-label">{label}</span>
    </div>
  );
}

export function getAgentAvatarSrc(agentId: string | null | undefined): string | null {
  if (agentId === 'default') {
    // import.meta.env is a Vite augmentation not visible to the bare ts
    // compiler; cast through unknown so the avatar path picks up the
    // configured base URL without dragging vite/client types into tsconfig.
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    return `${env?.BASE_URL ?? '/'}chief-of-staff-avatar.svg`;
  }
  return null;
}

export function MessageAvatar({
  role,
  label,
  size,
  imageSrc,
}: {
  role: 'user' | 'assistant' | string;
  label: string;
  size?: 'sm';
  imageSrc?: string | null;
}) {
  const cls = `cos-avatar cos-avatar-${role === 'user' ? 'user' : 'assistant'}${size ? ' cos-avatar-' + size : ''}`;
  if (role === 'user') {
    return (
      <div class={cls} title={label} aria-hidden="true">
        <svg width={size === 'sm' ? 10 : 14} height={size === 'sm' ? 10 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </div>
    );
  }
  if (imageSrc) {
    return (
      <div class={cls} title={label} aria-hidden="true">
        <img class="cos-avatar-img" src={imageSrc} alt="" />
      </div>
    );
  }
  const initial = (label || 'O').trim().charAt(0).toUpperCase() || 'O';
  return (
    <div class={cls} title={label} aria-hidden="true">
      <span class="cos-avatar-initial">{initial}</span>
    </div>
  );
}

// MessageImageThumb / MessageElementChip / MessageAttachments now live in
// CosMessageAttachments.tsx — see the top-of-file import / re-export.

function ElapsedSince({ ts }: { ts: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return <>{sec}s</>;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return <>{min}m {remSec.toString().padStart(2, '0')}s</>;
}

export function MessageBubble({
  msg,
  msgIdx,
  highlighted,
  showTools,
  onArtifactPopout,
  agentId,
  agentName,
  verbosity: _verbosity,
  searchHighlight,
}: {
  msg: ChiefOfStaffMsg;
  msgIdx: number;
  highlighted: boolean;
  showTools: boolean;
  onArtifactPopout: (artifactId: string) => void;
  agentId: string;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
  searchHighlight?: string | null;
}) {
  const hasTools = !!(msg.toolCalls && msg.toolCalls.length > 0);
  // Always show every text part the model emitted (markers stripped) so
  // nothing the JSONL captured is silently dropped from the Ops view. The
  // verbosity setting is passed to the model server-side as a tone hint
  // (terse = brief replies, verbose = with context) but is no longer a
  // client-side filter — that filter was hiding intro / explanatory text
  // the model emitted outside <cos-reply> tags.
  const assistantDisplay = msg.role === 'assistant' ? stripCosReplyMarkers(msg.text) : '';
  const showAssistantText = msg.role === 'assistant' && assistantDisplay;
  const showUserText = msg.role === 'user' && msg.text;
  const showEarlyAck =
    msg.role === 'assistant' && msg.streaming && msg.sending && !showAssistantText && !hasTools;
  const showElapsed = msg.role === 'assistant' && msg.streaming && !msg.sending;
  const authorLabel = msg.role === 'user' ? 'You' : (agentName || 'Ops');
  const avatarSrc = msg.role === 'assistant' ? getAgentAvatarSrc(agentId) : null;
  const showAttachments = !!(msg.attachments?.length || msg.elementRefs?.length);

  // Skip rendering empty assistant messages (no text, no tools, not streaming, no error)
  if (
    msg.role === 'assistant' &&
    !assistantDisplay &&
    !hasTools &&
    !msg.streaming &&
    !msg.error &&
    !showAttachments
  ) return null;

  return (
    <div
      class={`cos-msg cos-row cos-row-${msg.role}${highlighted ? ' cos-msg-highlight' : ''}`}
      data-cos-msg-idx={msgIdx}
    >
      <div class="cos-row-avatar">
        <MessageAvatar role={msg.role} label={authorLabel} imageSrc={avatarSrc} />
      </div>
      <div class="cos-row-main">
        <div class="cos-row-header">
          <span class="cos-row-author">{authorLabel}</span>
          {msg.timestamp && !msg.streaming && <Timestamp ts={msg.timestamp} />}
        </div>
        {hasTools && showTools && (
          <div class="cos-tools">
            {msg.toolCalls!.map((c, i) => (
              <MessageRenderer
                key={i}
                message={{
                  id: `cos-${msg.timestamp}-tool-${i}`,
                  role: 'tool_use',
                  timestamp: msg.timestamp,
                  toolName: c.name,
                  // Stash result/error on a private key so the chat-mode
                  // chip can show them when expanded. tool_result is
                  // suppressed in chat mode, so we have to thread the data
                  // in through the tool_use's input bag.
                  toolInput: {
                    ...c.input,
                    __chatExtras: { result: c.result, error: c.error },
                  },
                  toolUseId: c.id,
                  content: '',
                }}
                chat={{}}
              />
            ))}
          </div>
        )}
        {hasTools && !showTools && !msg.streaming && (
          <div class="cos-tools-hidden-hint" aria-hidden="true">
            {msg.toolCalls!.length} tool call{msg.toolCalls!.length === 1 ? '' : 's'} hidden
          </div>
        )}
        {showAssistantText && (
          <div class="cos-row-content cos-msg-text cos-msg-text-md">
            <AssistantContent text={assistantDisplay} onArtifactPopout={onArtifactPopout} searchHighlight={searchHighlight} />
          </div>
        )}
        {showUserText && (
          <div class="cos-row-content cos-msg-text"><HighlightedText text={msg.text} highlight={searchHighlight} /></div>
        )}
        {showAttachments && (
          <MessageAttachments attachments={msg.attachments} elementRefs={msg.elementRefs} />
        )}
        {msg.streaming && (() => {
          // Surface a shortcut to the backing session's jsonl log so the
          // operator can peek at the in-flight turn directly when the reply
          // takes too long or extraction drops output. The session is
          // provisioned at thread creation; even if the UI hasn't received
          // any assistant bytes yet, the jsonl file is already live.
          const linkSid = getSessionIdForThread(msg.threadId);
          const openJsonl = () => {
            if (!linkSid) return;
            openSession(linkSid);
            toggleCompanion(linkSid, 'jsonl');
          };
          return (
            <div class="cos-thinking-row">
              <div class="cos-thinking">
                <span /><span /><span />
              </div>
              {showEarlyAck && (
                linkSid ? (
                  <button
                    type="button"
                    class="cos-thinking-label cos-thinking-label-link"
                    onClick={(e) => { e.stopPropagation(); openJsonl(); }}
                    title="Open session jsonl log"
                  >
                    Working on it…
                  </button>
                ) : (
                  <span class="cos-thinking-label">Working on it…</span>
                )
              )}
              {showElapsed && (
                linkSid ? (
                  <button
                    type="button"
                    class="cos-thinking-label cos-thinking-label-elapsed cos-thinking-label-link"
                    onClick={(e) => { e.stopPropagation(); openJsonl(); }}
                    title="Open session jsonl log"
                  >
                    <ElapsedSince ts={msg.timestamp} />
                  </button>
                ) : (
                  <span class="cos-thinking-label cos-thinking-label-elapsed">
                    <ElapsedSince ts={msg.timestamp} />
                  </span>
                )
              )}
            </div>
          );
        })()}
        {msg.error && (() => {
          const linkSid = getSessionIdForThread(msg.threadId);
          return (
            <div class="cos-msg-error" role="alert">
              <div class="cos-msg-error-text">
                <strong>Send failed:</strong> {msg.error}
              </div>
              <div class="cos-msg-error-actions">
                {msg.retryPayload && (
                  <button
                    type="button"
                    class="cos-msg-error-btn"
                    onClick={(e) => { e.stopPropagation(); retryFailedAssistantMessage(msg.timestamp); }}
                  >
                    Retry
                  </button>
                )}
                {linkSid && (
                  <button
                    type="button"
                    class="cos-msg-error-btn cos-msg-error-btn-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSession(linkSid);
                      toggleCompanion(linkSid, 'jsonl');
                    }}
                    title="Open session jsonl log"
                  >
                    Open JSONL
                  </button>
                )}
                <button
                  type="button"
                  class="cos-msg-error-btn cos-msg-error-btn-secondary"
                  onClick={(e) => { e.stopPropagation(); dismissFailedAssistantMessage(msg.timestamp); }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
