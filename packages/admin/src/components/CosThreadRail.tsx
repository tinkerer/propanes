import { useEffect, useRef, useState } from 'preact/hooks';
import { type Thread } from './CosThread.js';
import {
  setThreadResolved,
  setThreadArchived,
  leavingThreadIds,
  isThreadLeaving,
  markThreadLeaving,
} from '../lib/chief-of-staff.js';
import { cosShowResolved, cosShowArchived } from '../lib/cos-popout-tree.js';
import { openThreadAsInteractive } from '../lib/sessions.js';

export type RailStatus =
  | 'streaming'
  | 'unread'
  | 'attention'
  | 'failed'
  | 'idle'
  | 'gc'
  | 'resolved'
  | 'archived'
  | 'interactive';

const STATUS_LABEL: Record<RailStatus, string> = {
  streaming: 'thinking',
  unread: 'new reply',
  attention: 'needs review',
  failed: 'failed',
  idle: 'idle',
  gc: 'no session',
  resolved: 'resolved',
  archived: 'archived',
  interactive: 'interactive (live TTY)',
};

type PopupState = {
  tid: string;
  num: number;
  status: RailStatus;
  top: number;
  left: number;
};

/**
 * Left-edge numbered nav rail surfacing every visible thread. Each item is
 * a status dot + thread number + (when relevant) unread badge. Resolve /
 * archive actions are surfaced via a popup that opens on double-click of
 * the rail button or click on the bottom-right status pip.
 *
 * Pure presentational: status / anchor / title / server-id derivations stay
 * in the bubble and are passed in as callbacks.
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
  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  function openPopup(tid: string, num: number, status: RailStatus, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    setPopup({ tid, num, status, top: r.top + r.height / 2, left: r.right + 6 });
  }
  function closePopup() {
    setPopup(null);
  }

  useEffect(() => {
    if (!popup) return;
    function onDocPointer(e: PointerEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.closest('.cos-thread-rail-popup')) return;
      if (el?.closest('.cos-thread-rail-status-trigger')) return;
      closePopup();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePopup();
    }
    function onScrollOrResize() {
      closePopup();
    }
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [popup]);

  const isResolvedStatus = popup?.status === 'resolved';
  const isArchivedStatus = popup?.status === 'archived';
  // Subscribe to the leaving set so each rail item picks up the
  // .cos-thread-rail-item-leaving modifier when its thread is animating out.
  const _leavingVersion = leavingThreadIds.value;
  void _leavingVersion;

  return (
    <>
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
          const leaving = isThreadLeaving(tid);
          const fullTitle = unread
            ? `${label} — ${unread.count} new (${STATUS_LABEL[status]})`
            : `${label} (${STATUS_LABEL[status]})`;
          return (
            <div
              class={`cos-thread-rail-item${leaving ? ' cos-thread-rail-item-leaving' : ''}`}
              key={t.userIdx ?? `pre-${i}`}
            >
              <button
                type="button"
                class={`cos-thread-rail-btn cos-thread-rail-btn-${status}${unread ? ' cos-thread-rail-btn-unread' : ''}`}
                data-status={status}
                onClick={() => onJumpToThread(t)}
                onDblClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (tid) openPopup(tid, num, status, e.currentTarget as HTMLElement);
                }}
                title={fullTitle}
                aria-label={`Jump to thread ${num}, ${STATUS_LABEL[status]}${unread ? `, ${unread.count} new` : ''} (double-click for actions)`}
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
                <button
                  type="button"
                  class="cos-thread-rail-status-trigger"
                  onClick={(e) => {
                    e.stopPropagation();
                    const item = (e.currentTarget as HTMLElement).parentElement;
                    const btn = item?.querySelector('.cos-thread-rail-btn') as HTMLElement | null;
                    openPopup(tid, num, status, btn ?? (e.currentTarget as HTMLElement));
                  }}
                  title={`Thread ${num} actions (${STATUS_LABEL[status]})`}
                  aria-label={`Thread ${num} actions`}
                />
              )}
            </div>
          );
        })}
      </nav>
      {popup && (
        <div
          ref={popupRef}
          class="cos-thread-rail-popup"
          role="menu"
          style={{ top: popup.top + 'px', left: popup.left + 'px' }}
        >
          <div class="cos-thread-rail-popup-title">Thread {popup.num}</div>
          <button
            type="button"
            role="menuitem"
            class="cos-thread-rail-popup-btn"
            onClick={() => {
              void openThreadAsInteractive(popup.tid);
              closePopup();
            }}
          >
            {popup.status === 'interactive' ? 'Focus interactive panel' : 'Open as interactive'}
          </button>
          <button
            type="button"
            role="menuitem"
            class="cos-thread-rail-popup-btn"
            onClick={() => {
              if (isArchivedStatus) {
                void setThreadArchived(popup.tid, false);
              } else {
                // Mark leaving only when the thread is *transitioning into*
                // a hidden state (resolving while hide-resolved is on).
                if (!isResolvedStatus && !cosShowResolved.value) markThreadLeaving(popup.tid);
                void setThreadResolved(popup.tid, !isResolvedStatus);
              }
              closePopup();
            }}
          >
            {isArchivedStatus
              ? 'Reopen (unarchive)'
              : isResolvedStatus
                ? 'Reopen thread'
                : 'Resolve thread'}
          </button>
          {!isArchivedStatus && (
            <button
              type="button"
              role="menuitem"
              class="cos-thread-rail-popup-btn"
              onClick={() => {
                if (!cosShowArchived.value) markThreadLeaving(popup.tid);
                void setThreadArchived(popup.tid, true);
                closePopup();
              }}
            >
              Archive thread
            </button>
          )}
        </div>
      )}
    </>
  );
}

