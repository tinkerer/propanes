import { useEffect, useMemo } from 'preact/hooks';
import { selectedAppId } from '../lib/state.js';
import {
  type ChiefOfStaffMsg,
  type ChiefOfStaffVerbosity,
  type DispatchInfo,
  extractDispatchInfo,
  getCachedFeedbackTitle,
  fetchFeedbackTitle,
  feedbackTitlesVersion,
  getSessionIdForThread,
  interruptThread,
  cosThreadMeta,
  getThreadMeta,
  setThreadResolved,
  setThreadArchived,
} from '../lib/chief-of-staff.js';
import { openSession, openFeedbackItem, toggleCompanion } from '../lib/sessions.js';
import {
  MessageAvatar,
  MessageAttachments,
  MessageBubble,
  Timestamp,
  HighlightedText,
  getAgentAvatarSrc,
} from './CosMessage.js';

export type Thread = {
  userIdx: number | null;
  userMsg: ChiefOfStaffMsg | null;
  replies: { idx: number; msg: ChiefOfStaffMsg }[];
};

function collectDispatches(replies: { idx: number; msg: ChiefOfStaffMsg }[]): DispatchInfo[] {
  const out: DispatchInfo[] = [];
  for (const r of replies) {
    if (!r.msg.toolCalls) continue;
    for (const call of r.msg.toolCalls) {
      const info = extractDispatchInfo(call);
      if (info) out.push(info);
    }
  }
  return out;
}

export function groupIntoThreads(messages: ChiefOfStaffMsg[]): Thread[] {
  const threads: Thread[] = [];
  const byThreadId = new Map<string, Thread>();
  // Route a "Reply in thread" user message back to its anchor thread instead
  // of starting a new top-level thread. Keyed by the anchor user-msg timestamp.
  const byAnchorTs = new Map<number, Thread>();
  let legacyCurrent: Thread | null = null;
  const pushIfNew = (t: Thread) => { if (!threads.includes(t)) threads.push(t); };

  messages.forEach((m, i) => {
    const tid = m.threadId;
    if (tid) {
      // Primary grouping: backend cosThread id. Handles interleaved parallel
      // turns cleanly — an assistant reply from thread A that arrives after a
      // user message in thread B lands back in thread A.
      let t = byThreadId.get(tid);
      if (!t) {
        t = m.role === 'user'
          ? { userIdx: i, userMsg: m, replies: [] }
          : { userIdx: null, userMsg: null, replies: [{ idx: i, msg: m }] };
        byThreadId.set(tid, t);
        pushIfNew(t);
        if (m.role === 'user' && m.timestamp) byAnchorTs.set(m.timestamp, t);
      } else if (m.role === 'user') {
        if (!t.userMsg) {
          t.userIdx = i;
          t.userMsg = m;
          if (m.timestamp) byAnchorTs.set(m.timestamp, t);
        } else {
          t.replies.push({ idx: i, msg: m });
        }
      } else {
        t.replies.push({ idx: i, msg: m });
      }
      legacyCurrent = t;
      return;
    }

    // Legacy fallback for messages without a threadId (pre-fix rows).
    if (m.role === 'user') {
      if (typeof m.replyToTs === 'number') {
        const target = byAnchorTs.get(m.replyToTs);
        if (target) {
          target.replies.push({ idx: i, msg: m });
          legacyCurrent = target;
          return;
        }
      }
      const t: Thread = { userIdx: i, userMsg: m, replies: [] };
      threads.push(t);
      if (m.timestamp) byAnchorTs.set(m.timestamp, t);
      legacyCurrent = t;
    } else {
      if (!legacyCurrent) {
        legacyCurrent = { userIdx: null, userMsg: null, replies: [] };
      }
      legacyCurrent.replies.push({ idx: i, msg: m });
      pushIfNew(legacyCurrent);
    }
  });

  return threads;
}

/**
 * Stable key for slack-mode thread routing. Prefer the server-side cosThread
 * id; fall back to the anchor user-message index (stable within an agent's
 * message array). Orphans collapse to a single bucket.
 */
export function threadKeyOf(t: Thread): string {
  const tid =
    t.userMsg?.threadId ??
    t.replies.find((r) => r.msg.threadId)?.msg.threadId ??
    null;
  if (tid) return `tid:${tid}`;
  if (t.userIdx != null) return `idx:${t.userIdx}`;
  return 'orphan';
}

function DispatchStatusLine({ dispatches }: { dispatches: DispatchInfo[] }) {
  // Observe title-cache invalidation so titles re-render after async fetch.
  const _titlesVersion = feedbackTitlesVersion.value;
  void _titlesVersion;

  useEffect(() => {
    for (const d of dispatches) {
      if (!getCachedFeedbackTitle(d.feedbackId)) {
        void fetchFeedbackTitle(d.feedbackId);
      }
    }
  }, [dispatches]);

  return (
    <div class="cos-dispatch-status" role="status">
      {dispatches.map((d, i) => {
        const title = getCachedFeedbackTitle(d.feedbackId);
        const appId = selectedAppId.value;
        const feedbackHref = `#${appId ? `/app/${appId}/tickets/${d.feedbackId}` : `/tickets/${d.feedbackId}`}`;
        return (
          <div key={`${d.feedbackId}-${i}`} class="cos-dispatch-status-item">
            <a
              class="cos-dispatch-status-title"
              href={feedbackHref}
              title={d.feedbackId}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openFeedbackItem(d.feedbackId);
              }}
            >
              → {title || d.feedbackId.slice(0, 14) + '…'}
            </a>
            {d.sessionId && (
              <span class="cos-dispatch-session-pills">
                <button
                  type="button"
                  class="cos-dispatch-session-pill"
                  title={`Open terminal for session ${d.sessionId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSession(d.sessionId!);
                  }}
                >
                  ⌥ {d.sessionId.slice(0, 14)}
                </button>
                <button
                  type="button"
                  class="cos-dispatch-session-pill cos-dispatch-session-pill-jsonl"
                  title={`Open JSONL viewer for session ${d.sessionId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSession(d.sessionId!);
                    toggleCompanion(d.sessionId!, 'jsonl');
                  }}
                >
                  JSONL
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ThreadBlock({
  thread,
  collapsed,
  onToggle,
  onStop,
  showTools,
  highlightMsgIdx,
  onReply,
  onArtifactPopout,
  hasUnread,
  agentId,
  agentName,
  verbosity,
  searchHighlight,
  slackMode,
  isActiveInPanel,
  onOpenInPanel,
}: {
  thread: Thread;
  collapsed: boolean;
  onToggle: () => void;
  onStop: () => void;
  showTools: boolean;
  highlightMsgIdx: number | null;
  onReply: (role: string, text: string, anchorTs?: number, threadServerId?: string | null) => void;
  onArtifactPopout: (artifactId: string) => void;
  hasUnread: boolean;
  agentId: string;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
  searchHighlight?: string | null;
  slackMode: boolean;
  isActiveInPanel: boolean;
  onOpenInPanel: () => void;
}) {
  const { userMsg, userIdx, replies } = thread;
  const dispatches = useMemo(() => collectDispatches(replies), [replies]);
  const isRunning = replies.some((r) => r.msg.streaming);
  const replyCount = replies.length;
  const hasReplies = replyCount > 0;
  const lastReply = replies[replies.length - 1]?.msg;
  // In slack mode, never expand replies inline — the side panel owns them. We
  // still render orphan groups (no userMsg) inline, since they don't fit the
  // anchor-then-thread metaphor.
  const slackCollapse = slackMode && !!userMsg && hasReplies;
  const effectiveCollapsed = slackCollapse ? true : collapsed;
  const showSummaryCollapsed = !!userMsg && effectiveCollapsed && hasReplies;
  const showExpandedReplies = !userMsg || !effectiveCollapsed;
  const threadContext = userMsg?.text || '';
  const anchorTs = userMsg?.timestamp;
  const agentAvatarSrc = getAgentAvatarSrc(agentId);
  // Each UI thread maps to one server-side cosThread. Pull the id from any
  // tagged message so Stop targets just this thread's Claude session instead
  // of interrupting unrelated in-flight threads for the same agent.
  const threadServerId =
    userMsg?.threadId ?? replies.find((r) => r.msg.threadId)?.msg.threadId ?? null;
  // Read the cosThreadMeta signal so this block re-renders when the operator
  // toggles `resolved` from anywhere (rail button, this action row, another
  // tab). getThreadMeta resolves to null when no meta has loaded yet.
  const _metaVersion = cosThreadMeta.value;
  void _metaVersion;
  const threadMeta = threadServerId ? getThreadMeta(threadServerId) : null;
  const isResolved = !!threadMeta?.resolvedAt;
  const isArchived = !!threadMeta?.archivedAt;
  const handleThreadStop = () => {
    if (threadServerId) void interruptThread(threadServerId);
    else onStop();
  };
  const handleThreadReply = () => {
    if (threadContext) onReply('user', threadContext, anchorTs, threadServerId);
  };
  const handleToggleResolved = () => {
    if (!threadServerId) return;
    void setThreadResolved(threadServerId, !isResolved);
  };
  const handleToggleArchived = () => {
    if (!threadServerId) return;
    void setThreadArchived(threadServerId, !isArchived);
  };
  return (
    <div class={`cos-thread-block${hasUnread ? ' cos-thread-block-unread' : ''}${userMsg ? '' : ' cos-thread-block-orphan'}${isResolved ? ' cos-thread-block-resolved' : ''}${isArchived ? ' cos-thread-block-archived' : ''}`}>
      {userMsg && (
        <div
          class={`cos-msg cos-row cos-row-user cos-row-post${highlightMsgIdx === userIdx ? ' cos-msg-highlight' : ''}${hasUnread ? ' cos-row-unread' : ''}`}
          data-cos-msg-idx={userIdx ?? undefined}
          data-cos-thread-anchor={userIdx ?? undefined}
        >
          <div class="cos-row-avatar">
            <MessageAvatar role="user" label="You" />
          </div>
          <div class="cos-row-main">
            <div class="cos-row-header">
              <span class="cos-row-author">You</span>
              {userMsg.timestamp && <Timestamp ts={userMsg.timestamp} />}
              {hasUnread && (
                <span class="cos-row-unread-dot" title="Unread reply" aria-label="Unread reply" />
              )}
            </div>
            {userMsg.text && (
              <div class="cos-row-content cos-msg-text"><HighlightedText text={userMsg.text} highlight={searchHighlight} /></div>
            )}
            <MessageAttachments attachments={userMsg.attachments} elementRefs={userMsg.elementRefs} />
          </div>
        </div>
      )}
      {(hasReplies || dispatches.length > 0) && (
        <div class="cos-thread-children">
          {showExpandedReplies && userMsg && hasReplies && (
            <button
              type="button"
              class="cos-thread-collapse-rail"
              onClick={onToggle}
              aria-label="Collapse thread"
              title="Collapse thread"
            />
          )}
          {dispatches.length > 0 && <DispatchStatusLine dispatches={dispatches} />}
          {showSummaryCollapsed && (
            <button
              type="button"
              class={`cos-thread-summary${hasUnread ? ' cos-thread-summary-unread' : ''}${slackCollapse && isActiveInPanel ? ' cos-thread-summary-active' : ''}`}
              onClick={slackCollapse ? onOpenInPanel : onToggle}
              aria-expanded="false"
              aria-label={slackCollapse
                ? `Open thread in panel (${replyCount} repl${replyCount === 1 ? 'y' : 'ies'})`
                : `Expand ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`}
            >
              <span class="cos-thread-summary-avatars" aria-hidden="true">
                <MessageAvatar role="assistant" label={agentName} size="sm" imageSrc={agentAvatarSrc} />
              </span>
              <span class="cos-thread-summary-count">
                {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
              </span>
              {lastReply?.timestamp && (
                <span class="cos-thread-summary-time">
                  Last reply <Timestamp ts={lastReply.timestamp} />
                </span>
              )}
              <span class="cos-thread-summary-hint">
                {slackCollapse ? (isActiveInPanel ? 'Open in panel' : 'View in panel →') : 'View thread'}
              </span>
            </button>
          )}
          {showExpandedReplies && (
            <>
              {userMsg && (() => {
                const linkSid = getSessionIdForThread(threadServerId);
                const openSessionLog = () => {
                  if (!linkSid) return;
                  openSession(linkSid);
                  toggleCompanion(linkSid, 'jsonl');
                };
                return (
                  <div class="cos-thread-header-row">
                    <span class="cos-thread-header-count">
                      {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
                    </span>
                    {linkSid && (
                      <button
                        type="button"
                        class="cos-thread-header-btn cos-thread-header-btn-log"
                        onClick={openSessionLog}
                        title="Open full session log"
                      >
                        Session log
                      </button>
                    )}
                    <button
                      type="button"
                      class="cos-thread-header-btn"
                      onClick={onToggle}
                      aria-expanded="true"
                      title="Collapse thread"
                    >
                      Collapse
                    </button>
                  </div>
                );
              })()}
              {replies.map((r) => (
                <MessageBubble
                  key={r.idx}
                  msg={r.msg}
                  msgIdx={r.idx}
                  highlighted={highlightMsgIdx === r.idx}
                  showTools={showTools}
                  onArtifactPopout={onArtifactPopout}
                  agentId={agentId}
                  agentName={agentName}
                  verbosity={verbosity}
                  searchHighlight={searchHighlight}
                />
              ))}
            </>
          )}
        </div>
      )}
      {userMsg && !(collapsed && hasReplies) && (() => {
        const actionsLinkSid = getSessionIdForThread(threadServerId);
        const openActionsSessionLog = () => {
          if (!actionsLinkSid) return;
          openSession(actionsLinkSid);
          toggleCompanion(actionsLinkSid, 'jsonl');
        };
        return (
          <div class="cos-thread-actions">
            {isRunning && (
              <button
                type="button"
                class="cos-thread-reply-btn cos-thread-reply-btn-running"
                onClick={handleThreadStop}
                title="Interrupt current response"
                aria-label="Interrupt current response"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
                <span>Stop</span>
              </button>
            )}
            <button
              type="button"
              class="cos-thread-reply-btn"
              onClick={handleThreadReply}
              title="Reply in thread"
              aria-label="Reply in thread"
              disabled={!threadContext}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="9 17 4 12 9 7" />
                <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
              <span>Reply in thread</span>
            </button>
            {actionsLinkSid && (
              <button
                type="button"
                class="cos-thread-reply-btn"
                onClick={openActionsSessionLog}
                title={`Open full session log (${actionsLinkSid})`}
                aria-label="Open session log"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                <span>Session log</span>
              </button>
            )}
            {threadServerId && (
              <button
                type="button"
                class={`cos-thread-reply-btn cos-thread-resolve-btn${isResolved || isArchived ? ' cos-thread-resolve-btn-active' : ''}`}
                onClick={isArchived ? handleToggleArchived : handleToggleResolved}
                title={isArchived ? 'Reopen this archived thread' : (isResolved ? 'Reopen this thread' : 'Mark this thread resolved (clears it from triage)')}
                aria-label={isArchived ? 'Reopen archived thread' : (isResolved ? 'Reopen thread' : 'Resolve thread')}
              >
                {isResolved || isArchived ? (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                    <span>Reopen</span>
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>Resolve</span>
                  </>
                )}
              </button>
            )}
            {threadServerId && !isArchived && (
              <button
                type="button"
                class="cos-thread-reply-btn cos-thread-archive-btn"
                onClick={handleToggleArchived}
                title="Archive this thread (hides it from triage and from the resolved view)"
                aria-label="Archive thread"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 7h18M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M9 11h6" />
                </svg>
                <span>Archive</span>
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}
