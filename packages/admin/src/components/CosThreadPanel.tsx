import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  chiefOfStaffAgents,
  sendChiefOfStaffMessage,
  type ChiefOfStaffVerbosity,
} from '../lib/chief-of-staff.js';
import { selectedAppId } from '../lib/state.js';
import { getSessionIdForThread } from '../lib/cos-thread-meta.js';
import { cosActiveThread } from '../lib/cos-popout-tree.js';
import { groupIntoThreads, threadKeyOf } from './CosThread.js';
import { StructuredView } from './StructuredView.js';

/**
 * Slack-mode side panel for one thread.
 *
 * The body is rendered from the **JSONL stream** of the thread's backing
 * agent session — not from cosMessages — because the cosMessages persistence
 * path drops assistant turns when the operator types fast and never sees
 * sub-agent (Task) transcripts at all. The JSONL has both. We delegate to
 * `StructuredView` (the same component that drives the JSONL companion tab)
 * with chat-mode opts so the rendering matches the bubble's compact style.
 *
 * The composer at the bottom is wired to `sendChiefOfStaffMessage` with
 * `replyToTs` set to the thread's anchor timestamp, so a reply lands in
 * this thread's session rather than starting a new top-level thread.
 */
export function ThreadPanel({
  agentId,
  showTools: _showTools,
  verbosity: _verbosity,
  onArtifactPopout,
  onReply,
  onClose,
  compact,
}: {
  agentId: string;
  showTools: boolean;
  verbosity: ChiefOfStaffVerbosity;
  onArtifactPopout: (artifactId: string) => void;
  onReply: (role: string, text: string, anchorTs?: number, threadServerId?: string | null) => void;
  onClose: () => void;
  compact?: boolean;
}) {
  void onArtifactPopout; // routed through the structured-view chat opts below if needed later
  const active = cosActiveThread.value;
  const agents = chiefOfStaffAgents.value;
  const agent = agents.find((a) => a.id === agentId) || null;
  const threads = useMemo(
    () => (agent ? groupIntoThreads(agent.messages) : []),
    [agent?.messages],
  );
  const found = active && agent && active.agentId === agentId
    ? threads.find((t) => threadKeyOf(t) === active.threadKey) || null
    : null;

  if (!agent) {
    return (
      <div class="cos-thread-panel cos-thread-panel-empty">
        <div class="cos-thread-panel-header">
          <span class="cos-thread-panel-title">Thread</span>
          <button type="button" class="cos-thread-panel-close" onClick={onClose} aria-label="Close panel">×</button>
        </div>
        <div class="cos-thread-panel-empty-msg">No active agent.</div>
      </div>
    );
  }
  if (!active || !found) {
    return (
      <div class="cos-thread-panel cos-thread-panel-empty">
        <div class="cos-thread-panel-header">
          <span class="cos-thread-panel-title">Thread</span>
          <button type="button" class="cos-thread-panel-close" onClick={onClose} aria-label="Close panel">×</button>
        </div>
        <div class="cos-thread-panel-empty-msg">
          Pick a thread from chat to open it here.
        </div>
      </div>
    );
  }

  const { userMsg, replies } = found;
  const threadServerId =
    userMsg?.threadId ?? replies.find((r) => r.msg.threadId)?.msg.threadId ?? null;
  const anchorTs = userMsg?.timestamp;
  const sessionId = getSessionIdForThread(threadServerId);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerText, setComposerText] = useState('');
  const isAgentStreaming = replies.some((r) => r.msg.streaming);
  // Title preview: first ~60 chars of the anchor user message, falls back to
  // the agent name. Helps the operator know which thread is in the panel
  // without needing to read message bodies.
  const titlePreview = (() => {
    const t = (userMsg?.text || '').trim().replace(/\s+/g, ' ');
    if (!t) return agent.name;
    return t.length > 60 ? t.slice(0, 58) + '…' : t;
  })();

  // Reset composer when switching threads — drafts are per-thread; ephemeral
  // text in this panel is for "reply right now" only and shouldn't leak across.
  useEffect(() => {
    setComposerText('');
  }, [active?.threadKey, active?.agentId]);

  function submitReply() {
    const trimmed = composerText.trim();
    if (!trimmed) return;
    sendChiefOfStaffMessage(trimmed, selectedAppId.value, {
      replyToTs: anchorTs,
    });
    setComposerText('');
  }

  return (
    <div class={`cos-thread-panel${compact ? ' cos-thread-panel-compact' : ''}`}>
      <div class="cos-thread-panel-header">
        <span class="cos-thread-panel-title" title={userMsg?.text || ''}>{titlePreview}</span>
        <button
          type="button"
          class="cos-thread-panel-close"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >×</button>
      </div>
      <div class="cos-thread-panel-jsonl">
        {sessionId ? (
          <StructuredView sessionId={sessionId} chat={{}} />
        ) : (
          <div class="cos-thread-panel-empty-msg">
            Session warming up — the agent's JSONL appears here once the first
            turn writes a line.
          </div>
        )}
      </div>
      <div class="cos-thread-panel-composer">
        <textarea
          ref={composerRef}
          class="cos-input cos-thread-panel-input"
          value={composerText}
          placeholder={isAgentStreaming ? 'Reply (agent is responding…)' : 'Reply in this thread…'}
          onInput={(e) => setComposerText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitReply();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (composerText) setComposerText('');
              else if (userMsg?.text) onReply('user', userMsg.text, anchorTs, threadServerId);
            }
          }}
          rows={2}
        />
        <div class="cos-thread-panel-composer-actions">
          <button
            type="button"
            class="cos-link-btn cos-thread-panel-handoff"
            onClick={() => {
              // Hand off to the main composer so the operator can attach
              // images, paste element refs, or work on a longer reply.
              if (userMsg?.text) onReply('user', userMsg.text, anchorTs, threadServerId);
            }}
            title="Reply from main chat (lets you attach images / element refs)"
          >
            Reply in main chat
          </button>
          <button
            type="button"
            class="cos-send"
            onClick={submitReply}
            disabled={!composerText.trim()}
            title="Send (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12l14-7-7 14-2-5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
