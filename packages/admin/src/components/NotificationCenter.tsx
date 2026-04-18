import { useEffect } from 'preact/hooks';
import {
  notifications,
  notificationCenterOpen,
  closeNotificationCenter,
  dismissNotification,
  deleteNotification,
  clearResolvedNotifications,
  resolveNotification,
} from '../lib/notifications.js';
import { openSession } from '../lib/sessions.js';
import type { Notification, PlanReviewPayload, QnaPayload, QnaQuestion, ApprovalPayload } from '../lib/notification-types.js';

const SEVERITY_ICONS: Record<string, string> = {
  info: '\u{2139}\uFE0F',
  success: '\u{2705}',
  warning: '\u{26A0}\uFE0F',
  error: '\u{274C}',
};

export function NotificationCenter() {
  const open = notificationCenterOpen.value;
  const list = notifications.value;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeNotificationCenter();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div class="notif-center-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeNotificationCenter(); }}>
      <div class="notif-center-panel">
        <div class="notif-center-header">
          <div class="notif-center-title">Notifications</div>
          <div class="notif-center-actions">
            {list.some((n) => n.resolved) && (
              <button class="btn btn-sm" onClick={() => clearResolvedNotifications()}>Clear resolved</button>
            )}
            <button class="btn btn-sm" onClick={closeNotificationCenter}>Close</button>
          </div>
        </div>
        <div class="notif-center-list">
          {list.length === 0 && (
            <div class="notif-center-empty">No notifications</div>
          )}
          {list.map((n) => (
            <NotificationItem key={n.id} n={n} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NotificationItem({ n }: { n: Notification }) {
  const severity = n.severity || 'info';
  const icon = SEVERITY_ICONS[severity] || SEVERITY_ICONS.info;
  const isResolved = !!n.resolved;

  return (
    <div class={`notif-item severity-${severity} ${isResolved ? 'resolved' : ''}`}>
      <div class="notif-item-head">
        <span class="notif-item-icon">{icon}</span>
        <div class="notif-item-body">
          <div class="notif-item-title">{n.title}</div>
          {n.body && <div class="notif-item-desc">{n.body}</div>}
          <div class="notif-item-meta">
            {formatAge(n.createdAt)}
            {n.sessionId && (
              <>
                {' \u00B7 '}
                <button class="notif-item-link" onClick={() => { openSession(n.sessionId!); closeNotificationCenter(); }}>
                  open session
                </button>
              </>
            )}
            {isResolved && n.resolved && (
              <span class="notif-item-resolved"> \u00B7 {n.resolved.action}</span>
            )}
          </div>
        </div>
        <div class="notif-item-row-actions">
          {!isResolved && (
            <button class="notif-item-dismiss" title="Dismiss" onClick={() => dismissNotification(n.id)}>{'\u2715'}</button>
          )}
          {isResolved && (
            <button class="notif-item-dismiss" title="Delete" onClick={() => deleteNotification(n.id)}>{'\u{1F5D1}'}</button>
          )}
        </div>
      </div>
      {!isResolved && n.payload && (
        <InteractivePane n={n} />
      )}
    </div>
  );
}

function InteractivePane({ n }: { n: Notification }) {
  if (!n.payload) return null;
  if (n.payload.kind === 'plan-review') return <PlanReviewPane n={n} payload={n.payload.planReview} />;
  if (n.payload.kind === 'qna') return <QnaPane n={n} payload={n.payload.qna} />;
  if (n.payload.kind === 'approval') return <ApprovalPane n={n} payload={n.payload.approval} />;
  return null;
}

function PlanReviewPane({ n, payload }: { n: Notification; payload: PlanReviewPayload }) {
  return (
    <div class="notif-pane">
      <div class="notif-pane-label">Plan for review</div>
      <pre class="notif-plan-md">{payload.planMarkdown}</pre>
      <div class="notif-pane-actions">
        <button class="btn btn-sm btn-primary" onClick={() => resolveNotification(n.id, 'approved')}>
          Approve &amp; run
        </button>
        <button class="btn btn-sm" onClick={() => resolveNotification(n.id, 'rejected')}>
          Reject
        </button>
      </div>
    </div>
  );
}

function QnaPane({ n, payload }: { n: Notification; payload: QnaPayload }) {
  const answers: Record<string, string | boolean> = {};
  for (const q of payload.questions) {
    if (q.default !== undefined) answers[q.id] = q.default;
  }

  function setAnswer(qid: string, value: string | boolean) {
    answers[qid] = value;
  }

  return (
    <div class="notif-pane">
      {payload.context && <div class="notif-pane-label">{payload.context}</div>}
      <div class="notif-qna-questions">
        {payload.questions.map((q: QnaQuestion) => (
          <div key={q.id} class="notif-qna-q">
            <div class="notif-qna-qtext">{q.text}</div>
            {q.type === 'boolean' && (
              <div class="notif-qna-options">
                <label><input type="radio" name={`${n.id}-${q.id}`} defaultChecked={q.default === true} onChange={() => setAnswer(q.id, true)} /> Yes</label>
                <label><input type="radio" name={`${n.id}-${q.id}`} defaultChecked={q.default === false} onChange={() => setAnswer(q.id, false)} /> No</label>
              </div>
            )}
            {q.type === 'choice' && q.options && (
              <div class="notif-qna-options">
                {q.options.map((o: { value: string; label: string; description?: string }) => (
                  <label key={o.value}>
                    <input
                      type="radio"
                      name={`${n.id}-${q.id}`}
                      defaultChecked={q.default === o.value}
                      onChange={() => setAnswer(q.id, o.value)}
                    />
                    {o.label}
                    {o.description && <span class="notif-qna-opt-desc"> — {o.description}</span>}
                  </label>
                ))}
              </div>
            )}
            {q.type === 'text' && (
              <input
                type="text"
                class="dispatch-dialog-input"
                defaultValue={(q.default as string) || ''}
                onInput={(e) => setAnswer(q.id, (e.target as HTMLInputElement).value)}
              />
            )}
          </div>
        ))}
      </div>
      <div class="notif-pane-actions">
        <button class="btn btn-sm btn-primary" onClick={() => resolveNotification(n.id, 'answered', answers)}>
          Submit answers
        </button>
        <button class="btn btn-sm" onClick={() => resolveNotification(n.id, 'dismissed')}>
          Skip
        </button>
      </div>
    </div>
  );
}

function ApprovalPane({ n, payload }: { n: Notification; payload: ApprovalPayload }) {
  return (
    <div class="notif-pane">
      <div class="notif-pane-label">{payload.description}</div>
      <div class="notif-pane-actions">
        <button class="btn btn-sm btn-primary" onClick={() => resolveNotification(n.id, 'approved')}>
          {payload.approveLabel || 'Approve'}
        </button>
        <button class="btn btn-sm" onClick={() => resolveNotification(n.id, 'rejected')}>
          {payload.rejectLabel || 'Reject'}
        </button>
      </div>
    </div>
  );
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}
