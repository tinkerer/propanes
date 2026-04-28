import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  chiefOfStaffAgents,
  sendChiefOfStaffMessage,
  type ChiefOfStaffVerbosity,
} from '../lib/chief-of-staff.js';
import { selectedAppId } from '../lib/state.js';
import { cosActiveThread } from '../lib/cos-popout-tree.js';
import {
  MessageAvatar,
  MessageAttachments,
  MessageBubble,
  Timestamp,
  HighlightedText,
} from './CosMessage.js';
import { groupIntoThreads, threadKeyOf } from './CosThread.js';

/**
 * Slack-mode side panel: renders the currently-selected thread's replies in a
 * dedicated companion (popout tab or inPane drawer). Reads `cosActiveThread`
 * to find which thread to render against the supplied agent's messages.
 */
export function ThreadPanel({
  agentId,
  showTools,
  verbosity,
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
  const replyCount = replies.length;
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [composerText, setComposerText] = useState('');
  const wasAtBottomRef = useRef(true);
  const isAgentStreaming = replies.some((r) => r.msg.streaming);

  function isBodyAtBottom(el: HTMLElement | null): boolean {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }
  function scrollBodyToBottom(behavior: ScrollBehavior = 'auto') {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isBodyAtBottom(el);
      wasAtBottomRef.current = atBottom;
      setShowScrollDown(!atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [active?.threadKey, active?.agentId]);

  // Auto-stick to bottom when new replies arrive while pinned.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollDown(false);
    }
  }, [replies.length, active?.threadKey, active?.agentId]);

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
    // Stick to bottom so the new user message + streaming reply are visible.
    wasAtBottomRef.current = true;
  }

  return (
    <div class={`cos-thread-panel${compact ? ' cos-thread-panel-compact' : ''}`}>
      <div class="cos-thread-panel-header">
        <span class="cos-thread-panel-title">Thread</span>
        <span class="cos-thread-panel-count">
          {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
        </span>
        <button
          type="button"
          class="cos-thread-panel-close"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >×</button>
      </div>
      <div class="cos-thread-panel-scroll">
      <div class="cos-thread-panel-body" ref={bodyRef}>
        {userMsg && (
          <div class="cos-thread-panel-anchor cos-msg cos-row cos-row-user cos-row-post">
            <div class="cos-row-avatar">
              <MessageAvatar role="user" label="You" />
            </div>
            <div class="cos-row-main">
              <div class="cos-row-header">
                <span class="cos-row-author">You</span>
                {userMsg.timestamp && <Timestamp ts={userMsg.timestamp} />}
              </div>
              {userMsg.text && (
                <div class="cos-row-content cos-msg-text">
                  <HighlightedText text={userMsg.text} highlight={null} />
                </div>
              )}
              <MessageAttachments attachments={userMsg.attachments} elementRefs={userMsg.elementRefs} />
            </div>
          </div>
        )}
        {replies.length === 0 ? (
          <div class="cos-thread-panel-empty-msg">No replies yet.</div>
        ) : (
          replies.map((r) => (
            <MessageBubble
              key={r.idx}
              msg={r.msg}
              msgIdx={r.idx}
              highlighted={false}
              showTools={showTools}
              onArtifactPopout={onArtifactPopout}
              agentId={agentId}
              agentName={agent.name}
              verbosity={verbosity}
              searchHighlight={null}
            />
          ))
        )}
      </div>
      <div class="cos-floating-actions" aria-hidden={!showScrollDown}>
        {showScrollDown && (
          <button
            type="button"
            class="cos-scroll-down-btn"
            onClick={() => scrollBodyToBottom('auto')}
            title="Scroll to latest"
            aria-label="Scroll to latest message"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      </div>
      {userMsg && (
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
                else if (userMsg.text) onReply('user', userMsg.text, anchorTs, threadServerId);
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
                if (userMsg.text) onReply('user', userMsg.text, anchorTs, threadServerId);
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
      )}
    </div>
  );
}
