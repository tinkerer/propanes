import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { JsonOutputParser, CodexOutputParser, type ParsedMessage } from '../lib/output-parser.js';
import { api } from '../lib/api.js';
import { allSessions, exitedSessions } from '../lib/sessions.js';
import { openFileViewer } from '../lib/file-viewer.js';
import { computeDiff, type DiffLine } from './MessageRenderer.js';

interface Props { sessionId: string }

export interface TaskInfo {
  // Stable ordering key — first time we see this task in the stream.
  order: number;
  taskId: string;
  subject: string;
  description?: string;
  status: string;
  activeForm?: string;
}

export interface FileReadInfo {
  path: string;
  count: number;
  ranges: string[];
}

export interface FileEditInfo {
  path: string;
  edits: Array<{ oldStr: string; newStr: string; replaceAll: boolean }>;
  // For Write tools the entire content replaces the file.
  writeContent?: string;
  added: number;
  removed: number;
}

export interface Summary {
  tasks: TaskInfo[];
  filesRead: FileReadInfo[];
  filesEdited: FileEditInfo[];
}

const TASK_RESULT_ID_RE = /Task\s+#?(\d+)\s+(?:created|updated|set)/i;

export function buildSummary(messages: ParsedMessage[]): Summary {
  const tasksMap = new Map<string, TaskInfo>();
  const readsMap = new Map<string, FileReadInfo>();
  const editsMap = new Map<string, FileEditInfo>();

  // tool_use_id -> pending TaskCreate input (subject/description) waiting for
  // matching tool_result so we can pull the new taskId off the result.
  const pendingTaskCreate = new Map<string, { subject: string; description?: string; activeForm?: string }>();
  let order = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'tool_use' && msg.toolName) {
      const input = msg.toolInput || {};
      switch (msg.toolName) {
        case 'TaskCreate': {
          const subject = String(input.subject || '').trim();
          const description = input.description ? String(input.description) : undefined;
          const activeForm = input.activeForm ? String(input.activeForm) : undefined;
          if (msg.toolUseId) {
            pendingTaskCreate.set(msg.toolUseId, { subject, description, activeForm });
          }
          break;
        }
        case 'TaskUpdate': {
          const taskId = input.taskId ? String(input.taskId) : '';
          if (!taskId) break;
          const existing = tasksMap.get(taskId);
          const status = input.status ? String(input.status) : (existing?.status ?? 'pending');
          const subject = input.subject ? String(input.subject) : (existing?.subject ?? '');
          const description = input.description ? String(input.description) : existing?.description;
          const activeForm = input.activeForm ? String(input.activeForm) : existing?.activeForm;
          if (existing) {
            existing.status = status;
            if (input.subject) existing.subject = subject;
            if (input.description) existing.description = description;
            if (input.activeForm) existing.activeForm = activeForm;
          } else {
            tasksMap.set(taskId, { order: order++, taskId, subject, description, status, activeForm });
          }
          break;
        }
        case 'Read': {
          const path = String(input.file_path || '').trim();
          if (!path) break;
          const info = readsMap.get(path) || { path, count: 0, ranges: [] };
          info.count++;
          const offset = input.offset ? Number(input.offset) : null;
          const limit = input.limit ? Number(input.limit) : null;
          if (offset && limit) info.ranges.push(`${offset}-${offset + limit}`);
          else if (offset) info.ranges.push(`from ${offset}`);
          else if (limit) info.ranges.push(`first ${limit}`);
          readsMap.set(path, info);
          break;
        }
        case 'Edit': {
          const path = String(input.file_path || '').trim();
          if (!path) break;
          const oldStr = String(input.old_string || '');
          const newStr = String(input.new_string || '');
          const replaceAll = input.replace_all === true || input.replace_all === 'true';
          const info = editsMap.get(path) || { path, edits: [], added: 0, removed: 0 };
          info.edits.push({ oldStr, newStr, replaceAll });
          const dl = computeDiff(oldStr, newStr);
          for (const d of dl) {
            if (d.type === 'added') info.added++;
            else if (d.type === 'removed') info.removed++;
          }
          editsMap.set(path, info);
          break;
        }
        case 'Write': {
          const path = String(input.file_path || '').trim();
          if (!path) break;
          const content = String(input.content || '');
          const info = editsMap.get(path) || { path, edits: [], added: 0, removed: 0 };
          info.writeContent = content;
          // Count every line in the new file as added (write replaces file).
          const lineCount = content.split('\n').length;
          info.added = Math.max(info.added, lineCount);
          editsMap.set(path, info);
          break;
        }
      }
    } else if (msg.role === 'tool_result' && msg.toolUseResultId) {
      const pend = pendingTaskCreate.get(msg.toolUseResultId);
      if (pend) {
        pendingTaskCreate.delete(msg.toolUseResultId);
        const m = TASK_RESULT_ID_RE.exec(msg.content || '');
        const taskId = m ? m[1] : `tmp-${order}`;
        if (!tasksMap.has(taskId)) {
          tasksMap.set(taskId, {
            order: order++,
            taskId,
            subject: pend.subject,
            description: pend.description,
            activeForm: pend.activeForm,
            status: 'pending',
          });
        } else {
          const existing = tasksMap.get(taskId)!;
          if (!existing.subject) existing.subject = pend.subject;
          if (!existing.description) existing.description = pend.description;
        }
      }
    }
  }

  const tasks = [...tasksMap.values()].sort((a, b) => a.order - b.order);
  const filesRead = [...readsMap.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const filesEdited = [...editsMap.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
  return { tasks, filesRead, filesEdited };
}

export function shortenPath(p: string): string {
  if (p.length <= 60) return p;
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}

export function TaskItem({ t }: { t: TaskInfo }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!t.description;
  return (
    <div class="ssum-task">
      <div
        class="ssum-task-row"
        onClick={hasDetail ? () => setOpen(o => !o) : undefined}
        style={hasDetail ? { cursor: 'pointer' } : undefined}
      >
        <span class="ssum-task-id">#{t.taskId}</span>
        <span class={`sm-task-status sm-task-status-${t.status}`}>{t.status}</span>
        <span class="ssum-task-subject">{t.subject || <em style={{ color: '#64748b' }}>(no subject)</em>}</span>
        {hasDetail && <span class="sm-expand-indicator">{open ? '▾' : '▸'}</span>}
      </div>
      {open && t.description && <div class="sm-task-desc">{t.description}</div>}
    </div>
  );
}

export function FileReadItem({ r }: { r: FileReadInfo }) {
  const rangeText = r.ranges.length > 0
    ? r.ranges.slice(0, 3).join(', ') + (r.ranges.length > 3 ? ` +${r.ranges.length - 3} more` : '')
    : '';
  return (
    <div class="ssum-file-row">
      <span
        class="sm-file-path sm-file-path-clickable"
        title={r.path}
        onClick={(e) => { e.stopPropagation(); openFileViewer(r.path); }}
      >
        {shortenPath(r.path)}
      </span>
      <span class="ssum-file-meta">
        {r.count > 1 && <span class="ssum-file-count">×{r.count}</span>}
        {rangeText && <span class="ssum-file-range">{rangeText}</span>}
      </span>
    </div>
  );
}

export function FileEditItem({ e }: { e: FileEditInfo }) {
  const [open, setOpen] = useState(false);
  // Concatenate every Edit's diff into a single rendered diff block.
  const diff = useMemo<DiffLine[]>(() => {
    const out: DiffLine[] = [];
    for (let i = 0; i < e.edits.length; i++) {
      if (i > 0) out.push({ type: 'context', text: '···' });
      const d = computeDiff(e.edits[i].oldStr, e.edits[i].newStr);
      out.push(...d);
    }
    return out;
  }, [e.edits]);
  const hasDetail = diff.length > 0 || !!e.writeContent;

  return (
    <div class="ssum-edit">
      <div
        class="ssum-edit-row"
        onClick={hasDetail ? () => setOpen(o => !o) : undefined}
        style={hasDetail ? { cursor: 'pointer' } : undefined}
      >
        <span
          class="sm-file-path sm-file-path-clickable"
          title={e.path}
          onClick={(ev) => { ev.stopPropagation(); openFileViewer(e.path); }}
        >
          {shortenPath(e.path)}
        </span>
        <span class="ssum-file-meta">
          {e.edits.length > 0 && <span class="ssum-edit-count">{e.edits.length} edit{e.edits.length === 1 ? '' : 's'}</span>}
          {e.writeContent != null && <span class="ssum-edit-count">written</span>}
          {e.added > 0 && <span class="sm-diff-stat-add">+{e.added}</span>}
          {e.removed > 0 && <span class="sm-diff-stat-del">-{e.removed}</span>}
          {hasDetail && <span class="sm-expand-indicator">{open ? '▾' : '▸'}</span>}
        </span>
      </div>
      {open && diff.length > 0 && (
        <div class="sm-diff-view">
          {diff.map((dl, i) => (
            <div key={i} class={`sm-diff-line sm-diff-${dl.type}`}>
              <span class="sm-diff-marker">{dl.type === 'removed' ? '-' : dl.type === 'added' ? '+' : ' '}</span>
              <span class="sm-diff-text">{dl.text}</span>
            </div>
          ))}
        </div>
      )}
      {open && diff.length === 0 && e.writeContent != null && (
        <div class="sm-diff-view">
          {e.writeContent.split('\n').slice(0, 200).map((line, i) => (
            <div key={i} class="sm-diff-line sm-diff-added">
              <span class="sm-diff-marker">+</span>
              <span class="sm-diff-text">{line}</span>
            </div>
          ))}
          {e.writeContent.split('\n').length > 200 && (
            <div class="ssum-truncated">… {e.writeContent.split('\n').length - 200} more lines</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionSummaryView({ sessionId }: Props) {
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastLength = useRef(0);

  const sessionRecord = allSessions.value.find((s: any) => s.id === sessionId);
  const terminalStatus = sessionRecord?.status && ['completed', 'exited', 'failed', 'deleted', 'archived'].includes(sessionRecord.status);
  const isSessionDone = exitedSessions.value.has(sessionId) || !!terminalStatus;

  useEffect(() => {
    lastLength.current = 0;
    setMessages([]);
    setLoading(true);
    setError(null);
    let cancelled = false;
    let inFlight = false;
    const fetchJsonl = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const text = await api.getJsonl(sessionId);
        if (cancelled) return;
        if (text.length === lastLength.current) {
          setLoading(false);
          return;
        }
        lastLength.current = text.length;
        const parser = sessionRecord?.runtime === 'codex'
          ? new CodexOutputParser()
          : new JsonOutputParser();
        parser.feed(text + '\n');
        setMessages(parser.getMessages());
        setError(null);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.status;
        const isMissing = status === 404 || status === 400;
        if (isMissing && !isSessionDone) {
          setLoading(true);
          setError(null);
        } else if (isMissing) {
          setError(null);
          setLoading(false);
        } else {
          setError(err.message);
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };
    fetchJsonl();
    if (isSessionDone) return () => { cancelled = true; };
    const interval = setInterval(() => { if (!document.hidden) fetchJsonl(); }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId, isSessionDone]);

  const summary = useMemo(() => buildSummary(messages), [messages]);

  if (loading && messages.length === 0) {
    return <div class="ssum-view"><div class="sm-empty">Loading session summary…</div></div>;
  }
  if (error) {
    return <div class="ssum-view"><div class="sm-empty" style="color: #f87171">{error}</div></div>;
  }

  const empty = summary.tasks.length === 0 && summary.filesRead.length === 0 && summary.filesEdited.length === 0;
  if (empty) {
    return <div class="ssum-view"><div class="sm-empty">Nothing to summarize yet — no Tasks, Reads, or Edits have appeared in the JSONL.</div></div>;
  }

  return (
    <div class="ssum-view">
      <Section title="Tasks" count={summary.tasks.length}>
        {summary.tasks.length === 0
          ? <div class="ssum-empty">No tasks created or updated.</div>
          : summary.tasks.map(t => <TaskItem key={t.taskId} t={t} />)}
      </Section>
      <Section title="Files Read" count={summary.filesRead.length}>
        {summary.filesRead.length === 0
          ? <div class="ssum-empty">No files read.</div>
          : summary.filesRead.map(r => <FileReadItem key={r.path} r={r} />)}
      </Section>
      <Section title="Files Edited" count={summary.filesEdited.length}>
        {summary.filesEdited.length === 0
          ? <div class="ssum-empty">No files edited or written.</div>
          : summary.filesEdited.map(e => <FileEditItem key={e.path} e={e} />)}
      </Section>
    </div>
  );
}

export function Section({ title, count, children }: { title: string; count: number; children: any }) {
  const [open, setOpen] = useState(true);
  return (
    <div class="ssum-section">
      <button class="ssum-section-header" onClick={() => setOpen(o => !o)}>
        <span class="ssum-section-caret">{open ? '▾' : '▸'}</span>
        <span class="ssum-section-title">{title}</span>
        <span class="ssum-section-count">{count}</span>
      </button>
      {open && <div class="ssum-section-body">{children}</div>}
    </div>
  );
}
