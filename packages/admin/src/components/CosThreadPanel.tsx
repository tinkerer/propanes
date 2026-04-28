import { useEffect, useMemo, useRef } from 'preact/hooks';
import {
  chiefOfStaffAgents,
  sendChiefOfStaffMessage,
  DEFAULT_VERBOSITY,
  type ChiefOfStaffVerbosity,
  type CosImageAttachment,
  type CosElementRef,
} from '../lib/chief-of-staff.js';
import { selectedAppId } from '../lib/state.js';
import { getSessionIdForThread } from '../lib/cos-thread-meta.js';
import {
  cosActiveThread,
  getThreadDraft,
  setThreadDraft,
  clearThreadDraft,
} from '../lib/cos-popout-tree.js';
import { useTranscriptStream } from '../lib/transcript-stream.js';
import { jsonlToCosMessages } from '../lib/jsonl-to-cos.js';
import { groupIntoThreads, threadKeyOf } from './CosThread.js';
import { MessageBubble } from './CosMessage.js';
import { CosComposer } from './CosComposer.js';

/**
 * Slack-mode side panel for one thread.
 *
 * Body renders the **JSONL stream** of the thread's backing agent session —
 * the cosMessages persistence path drops assistant turns when the operator
 * types fast and never sees Task subagent transcripts at all. The JSONL has
 * both, and via `jsonlToCosMessages` we project it into the bubble's
 * ChiefOfStaffMsg[] shape so MessageBubble (the same slack-style row the
 * main bubble uses) can render it. Avatars, author headers, timestamps,
 * tool-call chips — all match the main chat exactly.
 *
 * Composer is the shared `<CosComposer>`, identical to the bubble's main
 * composer (camera + element picker + mic + paste-images), wired to dispatch
 * via `sendChiefOfStaffMessage` with replyToTs set to the thread's anchor
 * timestamp so the reply lands back in this thread's session.
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

  // No agent or no selected thread → close the pane instead of rendering an
  // empty placeholder. Effect avoids calling the parent setter during render.
  const isEmpty = !agent || !active || !found;
  useEffect(() => {
    if (isEmpty) onClose();
  }, [isEmpty, onClose]);

  // Stable reference for the per-thread draft binding so CosComposer's
  // `useEffect([draft])` re-fires when (and only when) the operator switches
  // threads. Re-creating the object on every render would thrash the
  // composer's internal state.
  const draftBinding = useMemo(() => {
    if (!active) return undefined;
    const { agentId: aid, threadKey: tk } = active;
    return {
      read: () => getThreadDraft(aid, tk),
      write: (text: string) => setThreadDraft(aid, tk, text),
      clear: () => clearThreadDraft(aid, tk),
    };
  }, [active?.agentId, active?.threadKey]);

  if (isEmpty) return null;

  const { userMsg, replies } = found;
  const threadServerId =
    userMsg?.threadId ?? replies.find((r) => r.msg.threadId)?.msg.threadId ?? null;
  const anchorTs = userMsg?.timestamp;
  const sessionId = getSessionIdForThread(threadServerId);
  const isAgentStreaming = replies.some((r) => r.msg.streaming);
  // Title preview: first ~60 chars of the anchor user message, falls back to
  // the agent name. Helps the operator know which thread is in the panel
  // without needing to read message bodies.
  const titlePreview = (() => {
    const t = (userMsg?.text || '').trim().replace(/\s+/g, ' ');
    if (!t) return agent.name;
    return t.length > 60 ? t.slice(0, 58) + '…' : t;
  })();

  function handleSend(
    text: string,
    attachments: CosImageAttachment[],
    elementRefs: CosElementRef[],
  ) {
    if (!text && attachments.length === 0 && elementRefs.length === 0) return;
    sendChiefOfStaffMessage(text, selectedAppId.value, {
      replyToTs: anchorTs,
      attachments,
      elementRefs,
    });
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
      <ThreadPanelBody
        sessionId={sessionId}
        agentId={agentId}
        agentName={agent.name}
        verbosity={agent.verbosity || DEFAULT_VERBOSITY}
      />
      <div class="cos-thread-panel-composer">
        <CosComposer
          placeholder={isAgentStreaming ? 'Reply (agent is responding…)' : 'Reply in this thread… (paste images to attach)'}
          draft={draftBinding}
          onSend={handleSend}
          onEscapeWhenEmpty={() => {
            if (userMsg?.text) onReply('user', userMsg.text, anchorTs, threadServerId);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Renders the thread's JSONL transcript as slack-style message rows. Polls
 * the session's JSONL via useTranscriptStream, projects ParsedMessage[] into
 * the bubble's ChiefOfStaffMsg[] shape via jsonlToCosMessages, and renders
 * each turn with MessageBubble — the same component the bubble's main chat
 * uses. So avatars, author headers, timestamps, and tool-call chips all
 * match the main bubble.
 */
function ThreadPanelBody({
  sessionId,
  agentId,
  agentName,
  verbosity,
}: {
  sessionId: string | null;
  agentId: string;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const { messages, loading, error } = useTranscriptStream(sessionId || '', {
    pollMs: sessionId ? undefined : 0,
  });
  const projected = useMemo(() => jsonlToCosMessages(messages), [messages]);

  // Stick to bottom when new messages arrive while pinned. Scroll listener
  // updates the pinned flag so manual scroll-up disables auto-stick.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      wasAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [sessionId]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [projected.length]);

  if (!sessionId) {
    return (
      <div class="cos-thread-panel-jsonl">
        <div class="cos-thread-panel-empty-msg">
          Session warming up — the agent's JSONL appears here once the first
          turn writes a line.
        </div>
      </div>
    );
  }

  return (
    <div class="cos-thread-panel-jsonl" ref={scrollRef}>
      {loading && projected.length === 0 && (
        <div class="cos-thread-panel-empty-msg">Loading transcript…</div>
      )}
      {error && projected.length === 0 && (
        <div class="cos-thread-panel-empty-msg" style="color:#f87171">{error}</div>
      )}
      {projected.map((msg, idx) => (
        <MessageBubble
          key={`${msg.timestamp}-${idx}`}
          msg={msg}
          msgIdx={idx}
          highlighted={false}
          showTools
          onArtifactPopout={() => { /* artifact popout from panel TBD */ }}
          agentId={agentId}
          agentName={agentName}
          verbosity={verbosity}
          searchHighlight={null}
        />
      ))}
    </div>
  );
}
