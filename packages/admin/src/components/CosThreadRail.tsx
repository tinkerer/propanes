import { type Thread } from './CosThread.js';
import { setThreadResolved, setThreadArchived } from '../lib/chief-of-staff.js';

export type RailStatus = 'streaming' | 'unread' | 'failed' | 'idle' | 'gc' | 'resolved' | 'archived';

const STATUS_LABEL: Record<RailStatus, string> = {
  streaming: 'thinking',
  unread: 'new reply',
  failed: 'failed',
  idle: 'idle',
  gc: 'no session',
  resolved: 'resolved',
  archived: 'archived',
};

/**
 * Left-edge numbered nav rail surfacing every visible thread. Each item is
 * a status dot + thread number + (when relevant) unread badge, plus inline
 * resolve/archive buttons on the right of each row.
 *
 * Pure presentational: status / anchor / title / server-id derivations stay
 * in the bubble and are passed in as callbacks. The rail just renders.
 */
export function CosThreadRail({
  threads,
  unreadByThread,
  threadAnchorIdx,
  threadTitle,
  threadServerIdFor,
  railStatusFor,
  onJumpToThread,
}: {
  threads: Thread[];
  unreadByThread: Map<number | null, { count: number } | undefined>;
  threadAnchorIdx: (t: Thread) => number | null;
  threadTitle: (t: Thread) => string;
  threadServerIdFor: (t: Thread) => string | null;
  railStatusFor: (t: Thread) => RailStatus;
  onJumpToThread: (t: Thread) => void;
}) {
  return (
    <nav class="cos-thread-rail" aria-label="Threads">
      {threads.map((t, i) => {
        const unread = unreadByThread.get(t.userIdx);
        const anchor = threadAnchorIdx(t);
        if (anchor === null) return null;
        const title = threadTitle(t);
        const label = title.length > 64 ? title.slice(0, 64) + '…' : title;
        const num = i + 1;
        const status = railStatusFor(t);
        const tid = threadServerIdFor(t);
        const isResolved = status === 'resolved';
        const isArchived = status === 'archived';
        const fullTitle = unread
          ? `${label} — ${unread.count} new (${STATUS_LABEL[status]})`
          : `${label} (${STATUS_LABEL[status]})`;
        return (
          <div
            class="cos-thread-rail-item"
            key={t.userIdx ?? `pre-${i}`}
          >
            <button
              type="button"
              class={`cos-thread-rail-btn cos-thread-rail-btn-${status}${unread ? ' cos-thread-rail-btn-unread' : ''}`}
              data-status={status}
              onClick={() => onJumpToThread(t)}
              title={fullTitle}
              aria-label={`Jump to thread ${num}, ${STATUS_LABEL[status]}${unread ? `, ${unread.count} new` : ''}`}
            >
              <span class="cos-thread-rail-status" aria-hidden="true" />
              <span class="cos-thread-rail-num">{num}</span>
              {unread && (
                <span class="cos-thread-rail-badge" aria-hidden="true">
                  {unread.count > 9 ? '9+' : unread.count}
                </span>
              )}
            </button>
            {tid && (
              <>
                <button
                  type="button"
                  class={`cos-thread-rail-resolve${isResolved || isArchived ? ' cos-thread-rail-resolve-active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isArchived) void setThreadArchived(tid, false);
                    else void setThreadResolved(tid, !isResolved);
                  }}
                  title={isArchived ? 'Reopen archived thread' : (isResolved ? 'Reopen thread' : 'Mark thread resolved')}
                  aria-label={isArchived ? `Reopen archived thread ${num}` : (isResolved ? `Reopen thread ${num}` : `Resolve thread ${num}`)}
                >
                  {isResolved || isArchived ? (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
                      <path d="M3 12h18" />
                    </svg>
                  ) : (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
                {!isArchived && (
                  <button
                    type="button"
                    class="cos-thread-rail-archive"
                    onClick={(e) => {
                      e.stopPropagation();
                      void setThreadArchived(tid, true);
                    }}
                    title="Archive thread (hides from triage and from Resolved view)"
                    aria-label={`Archive thread ${num}`}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 7h18M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M9 11h6" />
                    </svg>
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </nav>
  );
}
