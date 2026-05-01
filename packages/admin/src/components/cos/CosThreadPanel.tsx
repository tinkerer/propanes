import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  chiefOfStaffAgents,
  sendChiefOfStaffMessage,
  interruptThread,
  DEFAULT_VERBOSITY,
  type ChiefOfStaffVerbosity,
  type CosImageAttachment,
  type CosElementRef,
  type ChiefOfStaffMsg,
} from '../lib/chief-of-staff.js';
import {
  cosFollowups,
  enqueueCosFollowup,
} from '../lib/cos-followups.js';
import { CosEnqueuedList } from './CosEnqueuedList.js';
import { selectedAppId } from '../lib/state.js';
import { getSessionIdForThread, getThreadMeta } from '../lib/cos-thread-meta.js';
import { openSession, openThreadAsInteractive } from '../lib/sessions.js';
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
import { CosComposer, type CosComposerHandle } from './CosComposer.js';
import {
  cosSavedDrafts,
  saveCosDraft,
  deleteCosDraft,
  getThreadSavedDrafts,
  type CosSavedDraft,
} from '../lib/cos-saved-drafts.js';
import { CosSavedDraftsList } from './CosSavedDraftsList.js';

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
  showTools,
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

  // All hooks below MUST run on every render — including when isEmpty. A prior
  // version put `useTranscriptStream` + the two `useMemo`s after the
  // `if (isEmpty) return null` early-return, so opening a thread (isEmpty
  // flipping false) reordered the hook slots and Preact crashed the whole
  // CoS subtree to blank. Derive thread-locals with optional fallbacks so the
  // hooks always run with a stable shape; the JSX below the early-return
  // re-narrows from `found` directly.
  const composerRef = useRef<CosComposerHandle | null>(null);
  const _savedDraftsTick = cosSavedDrafts.value;
  void _savedDraftsTick;
  const _followupsTick = cosFollowups.value;
  void _followupsTick;

  const fUserMsg = found?.userMsg ?? null;
  const fReplies = found?.replies ?? [];
  const threadServerId =
    fUserMsg?.threadId ?? fReplies.find((r) => r.msg.threadId)?.msg.threadId ?? null;
  const anchorTs = fUserMsg?.timestamp;
  const sessionId = getSessionIdForThread(threadServerId);

  // Lift the JSONL stream up here so we can dedupe optimistic user messages
  // against what's already landed on disk. The body below renders `projected`
  // — same content, no extra fetch.
  const { messages: jsonlRaw } = useTranscriptStream(sessionId || '', {
    pollMs: sessionId ? undefined : 0,
  });
  const projected = useMemo(() => jsonlToCosMessages(jsonlRaw), [jsonlRaw]);

  // Pending in-flight messages: optimistic rows from `agent.messages` for this
  // thread that haven't surfaced in the JSONL yet. Without these, the operator
  // hits send, the composer clears (POST 202 ack arrived), but the panel body
  // stays empty until the next JSONL poll cycle — leaving a confusing gap
  // where it looks like nothing happened. Rendering them inline closes the
  // gap so "press send → see the message → input clears" all happens together.
  const pendingMessages = useMemo<ChiefOfStaffMsg[]>(() => {
    if (!agent) return [];
    // Whitespace-insensitive match: the optimistic row stores the operator's
    // typed text trimmed; the projected row comes from stripTurnPreamble over
    // the JSONL user_input, which can drift in newline / context-block
    // joiners. Collapsing any run of whitespace to a single space dedupes
    // through that drift instead of getting stuck on `\n\n---\n` vs
    // `\n\n---\n\n` boundaries.
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
    const projectedTexts = new Set<string>();
    let projectedHasUserInThread = false;
    for (const p of projected) {
      if (p.role === 'user' && p.text) {
        projectedTexts.add(norm(p.text));
        projectedHasUserInThread = true;
      }
    }
    return agent.messages.filter((m) => {
      if (m.role !== 'user') return false;
      // Only this thread: match by threadId when known, else by replyToTs ↔
      // the anchor's timestamp (legacy/optimistic rows have no threadId yet).
      const matchesThread = threadServerId
        ? m.threadId === threadServerId
        : (anchorTs != null && m.replyToTs === anchorTs);
      if (!matchesThread) return false;
      // Skip the anchor itself — it's already represented in JSONL as the
      // first user_input.
      if (anchorTs != null && m.timestamp === anchorTs) return false;
      // Skip rows that JSONL already has by text match.
      if (m.text && projectedTexts.has(norm(m.text))) return false;
      // Belt-and-braces fallback: once an assistant reply *after* this user
      // row has finished streaming AND projected has at least one user msg
      // in the thread, the optimistic row is stale — drop it even if the
      // text-match missed. Without this fallback the row sticks on
      // "Sending…" until the operator refreshes the page.
      if (projectedHasUserInThread) {
        const assistantSettled = agent.messages.some(
          (a) => a.role === 'assistant'
            && a.threadId === (m.threadId ?? threadServerId)
            && a.timestamp > m.timestamp
            && a.streaming !== true
            && a.sending !== true,
        );
        if (assistantSettled) return false;
      }
      return true;
    });
  }, [agent?.messages, projected, threadServerId, anchorTs]);

  if (isEmpty) return null;

  const { userMsg, replies } = found;
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
  ): Promise<void> {
    if (!text && attachments.length === 0 && elementRefs.length === 0) return Promise.resolve();
    return sendChiefOfStaffMessage(text, selectedAppId.value, {
      replyToTs: anchorTs,
      attachments,
      elementRefs,
    });
  }

  const threadDrafts = threadServerId
    ? getThreadSavedDrafts(agentId, selectedAppId.value, threadServerId)
    : [];
  const threadFollowups = threadServerId
    ? cosFollowups.value.filter((f) => f.agentId === agentId && f.threadServerId === threadServerId)
    : [];

  function handleSaveAsDraft(
    text: string,
    attachments: CosImageAttachment[],
    elementRefs: CosElementRef[],
  ) {
    if (!text.trim() && attachments.length === 0 && elementRefs.length === 0) return;
    if (!threadServerId) return;
    saveCosDraft({
      agentId,
      appId: selectedAppId.value,
      threadId: threadServerId,
      replyToTs: anchorTs,
      text,
      attachments,
      elementRefs,
    });
  }

  function handleLoadSavedDraft(draft: CosSavedDraft) {
    const snap = composerRef.current?.getSnapshot();
    const hasText = !!snap?.text.trim();
    const hasAtts = (snap?.attachments?.length ?? 0) > 0;
    const hasRefs = (snap?.elementRefs?.length ?? 0) > 0;
    if (snap && (hasText || hasAtts || hasRefs) && threadServerId) {
      saveCosDraft({
        agentId,
        appId: selectedAppId.value,
        threadId: threadServerId,
        replyToTs: anchorTs,
        text: snap.text,
        attachments: snap.attachments,
        elementRefs: snap.elementRefs,
      });
    }
    deleteCosDraft(draft.id);
    composerRef.current?.loadSnapshot({
      text: draft.text,
      attachments: draft.attachments,
      elementRefs: draft.elementRefs,
    });
  }

  return (
    <div class={`cos-thread-panel${compact ? ' cos-thread-panel-compact' : ''}`}>
      <div class="cos-thread-panel-header">
        <span class="cos-thread-panel-title" title={userMsg?.text || ''}>{titlePreview}</span>
        <ThreadInteractivePanelButton
          threadServerId={threadServerId}
          sessionId={sessionId}
        />
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
        showTools={showTools}
        onArtifactPopout={onArtifactPopout}
        projected={projected}
        pendingMessages={pendingMessages}
      />
      {threadDrafts.length > 0 && (
        <div class="cos-thread-panel-drafts">
          <CosSavedDraftsList
            drafts={threadDrafts}
            onLoad={handleLoadSavedDraft}
            onDelete={(d) => { deleteCosDraft(d.id); }}
            scope="thread"
          />
        </div>
      )}
      {threadFollowups.length > 0 && (
        <div class="cos-thread-panel-drafts">
          <CosEnqueuedList followups={threadFollowups} scope="thread" />
        </div>
      )}
      <div class="cos-thread-panel-composer">
        <CosComposer
          ref={composerRef}
          placeholder={isAgentStreaming ? 'Reply (agent is responding…)' : 'Reply in this thread… (paste images to attach)'}
          draft={draftBinding}
          onSend={handleSend}
          onSaveDraft={threadServerId ? handleSaveAsDraft : undefined}
          streaming={isAgentStreaming}
          onStop={threadServerId ? () => { void interruptThread(threadServerId); } : undefined}
          onEnqueueAfterCurrent={threadServerId ? (text, attachments, elementRefs) => {
            enqueueCosFollowup({
              agentId,
              appId: selectedAppId.value,
              threadServerId,
              replyToTs: anchorTs,
              text,
              attachments,
              elementRefs,
            });
          } : undefined}
          onSendAndInterrupt={threadServerId ? async (text, attachments, elementRefs) => {
            await interruptThread(threadServerId);
            await sendChiefOfStaffMessage(text, selectedAppId.value, {
              replyToTs: anchorTs,
              attachments,
              elementRefs,
            });
          } : undefined}
          onEscapeWhenEmpty={() => {
            if (userMsg?.text) onReply('user', userMsg.text, anchorTs, threadServerId);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Renders the thread's JSONL transcript as slack-style message rows. The
 * parent panel owns the JSONL fetch + projection so it can also dedupe
 * optimistic in-flight rows; this component just paints the projected list +
 * any still-pending messages at the bottom with a "sending" visual.
 */
function ThreadPanelBody({
  sessionId,
  agentId,
  agentName,
  verbosity,
  showTools,
  onArtifactPopout,
  projected,
  pendingMessages,
}: {
  sessionId: string | null;
  agentId: string;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
  showTools: boolean;
  onArtifactPopout: (artifactId: string) => void;
  projected: ChiefOfStaffMsg[];
  pendingMessages: ChiefOfStaffMsg[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

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
  }, [projected.length, pendingMessages.length]);

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
      {projected.length === 0 && pendingMessages.length === 0 && (
        <div class="cos-thread-panel-empty-msg">Loading transcript…</div>
      )}
      {projected.map((msg, idx) => (
        <MessageBubble
          key={`${msg.timestamp}-${idx}`}
          msg={msg}
          msgIdx={idx}
          highlighted={false}
          showTools={showTools}
          onArtifactPopout={onArtifactPopout}
          agentId={agentId}
          agentName={agentName}
          verbosity={verbosity}
          searchHighlight={null}
        />
      ))}
      {pendingMessages.map((msg, idx) => (
        <div class="cos-msg-pending-wrap" key={`pending-${msg.timestamp}-${idx}`}>
          <MessageBubble
            msg={msg}
            msgIdx={projected.length + idx}
            highlighted={false}
            showTools={showTools}
            onArtifactPopout={onArtifactPopout}
            agentId={agentId}
            agentName={agentName}
            verbosity={verbosity}
            searchHighlight={null}
          />
          <span class="cos-msg-pending-pill" aria-live="polite">
            <span class="cos-sending-spinner" aria-hidden="true" />
            Sending…
          </span>
        </div>
      ))}
    </div>
  );
}

function ThreadInteractivePanelButton({
  threadServerId,
  sessionId,
}: {
  threadServerId: string | null;
  sessionId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const meta = threadServerId ? getThreadMeta(threadServerId) : null;
  const status = meta?.sessionStatus ?? null;
  const profile = meta?.sessionPermissionProfile ?? null;
  const isRunning = status === 'running' || status === 'pending';
  const isInteractiveAlready = profile === 'interactive-yolo' || profile === 'interactive-require';
  const focusOnly = isRunning && isInteractiveAlready && !!sessionId;

  const label = focusOnly
    ? 'Open interactive panel'
    : isRunning
      ? 'Convert to interactive'
      : 'Open as interactive';
  const tooltip = focusOnly
    ? 'Focus the live interactive session in the main pane'
    : isRunning
      ? 'Kill the headless run and re-spawn as a TTY (interactive-yolo)'
      : 'Spawn an interactive (TTY + skip-permissions) Claude session for this thread';

  async function handleClick() {
    if (busy) return;
    if (focusOnly && sessionId) {
      openSession(sessionId);
      return;
    }
    if (!threadServerId) return;
    setBusy(true);
    try {
      await openThreadAsInteractive(threadServerId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      class="cos-thread-panel-interactive"
      onClick={handleClick}
      disabled={busy || (!threadServerId && !focusOnly)}
      title={tooltip}
      aria-label={tooltip}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <span>{busy ? 'Opening…' : label}</span>
    </button>
  );
}
