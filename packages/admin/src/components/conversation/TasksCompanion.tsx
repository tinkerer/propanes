import { useMemo, useState } from 'preact/hooks';
import { useTranscriptStream } from '../../lib/transcript-stream.js';
import { buildSummary, type TaskInfo } from '../sessions/SessionSummaryView.js';

interface TasksCompanionProps {
  sessionId: string;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '\u2713';
    case 'in_progress': return '\u2192';
    case 'pending': return '\u25CB';
    case 'deleted':
    case 'failed': return '\u2717';
    default: return '\u25CB';
  }
}

function TaskRow({ t }: { t: TaskInfo }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!t.description;
  return (
    <div class="tasks-companion-item">
      <div
        class={`tasks-companion-row tasks-companion-status-${t.status}`}
        onClick={hasDetail ? () => setOpen(o => !o) : undefined}
        style={hasDetail ? { cursor: 'pointer' } : undefined}
      >
        <span class="tasks-companion-icon">{statusIcon(t.status)}</span>
        <span class="tasks-companion-id">#{t.taskId}</span>
        <span class={`tasks-companion-badge tasks-companion-badge-${t.status}`}>{t.status}</span>
        <span class="tasks-companion-subject">{t.subject || <em style={{ color: '#64748b' }}>(no subject)</em>}</span>
        {hasDetail && <span class="tasks-companion-expand">{open ? '\u25BE' : '\u25B8'}</span>}
      </div>
      {open && t.description && (
        <div class="tasks-companion-desc">{t.description}</div>
      )}
    </div>
  );
}

export function TasksCompanion({ sessionId }: TasksCompanionProps) {
  const { messages, loading, error, isSessionDone, isRunning } = useTranscriptStream(sessionId);

  const summary = useMemo(() => buildSummary(messages), [messages]);
  const tasks = summary.tasks;

  // Group by status for a quick overview
  const completed = tasks.filter(t => t.status === 'completed').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const pending = tasks.filter(t => t.status === 'pending').length;

  if (loading && messages.length === 0) {
    const msg = isSessionDone
      ? 'Loading tasks...'
      : isRunning
        ? 'Session running, waiting for tasks...'
        : 'Waiting for agent to start...';
    return (
      <div class="tasks-companion">
        <div class="tasks-companion-empty">{msg}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="tasks-companion">
        <div class="tasks-companion-empty" style={{ color: '#f87171' }}>{error}</div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div class="tasks-companion">
        <div class="tasks-companion-empty">No tasks found</div>
      </div>
    );
  }

  return (
    <div class="tasks-companion">
      <div class="tasks-companion-header">
        <span class="tasks-companion-title">Tasks</span>
        <span class="tasks-companion-stats">
          {completed > 0 && <span class="tasks-companion-stat tasks-companion-stat-completed">{completed} done</span>}
          {inProgress > 0 && <span class="tasks-companion-stat tasks-companion-stat-progress">{inProgress} active</span>}
          {pending > 0 && <span class="tasks-companion-stat tasks-companion-stat-pending">{pending} pending</span>}
        </span>
      </div>
      <div class="tasks-companion-list">
        {tasks.map(t => <TaskRow key={t.taskId} t={t} />)}
      </div>
    </div>
  );
}
