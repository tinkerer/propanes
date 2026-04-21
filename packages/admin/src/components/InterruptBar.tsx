import { useState, useRef, useEffect } from 'preact/hooks';
import { resumeSession, allSessions, exitedSessions } from '../lib/sessions.js';

interface Props {
  sessionId: string;
  permissionProfile?: string;
}

const TERMINAL_STATUSES = new Set(['completed', 'exited', 'failed', 'deleted', 'archived', 'killed']);

// Text input pinned to the bottom of the session view. Two modes:
//   - Running + headless (auto/yolo): "Interrupt" — kills the session and
//     resumes with the new prompt. Interactive TTY sessions skip this because
//     the terminal already accepts live input.
//   - Terminated (any profile): "Resume with prompt" — restarts the session
//     with full context plus the new prompt appended.
export function InterruptBar({ sessionId, permissionProfile }: Props) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const sess = allSessions.value.find((s: any) => s.id === sessionId);
  const profile = permissionProfile || sess?.permissionProfile;
  const isHeadless = profile === 'auto' || profile === 'yolo';
  const isPlain = profile === 'plain';
  const markedExited = exitedSessions.value.has(sessionId);
  const hasTerminalStatus = !!sess?.status && TERMINAL_STATUSES.has(sess.status);
  const isTerminated = markedExited || hasTerminalStatus;
  const isRunning = sess && (sess.status === 'running' || sess.status === 'pending') && !markedExited;

  // Interrupt mode runs against a live headless session; resume mode runs
  // against a terminated session. Plain shells have no concept of resume.
  const mode: 'interrupt' | 'resume' | null = !isPlain && isRunning && isHeadless
    ? 'interrupt'
    : !isPlain && isTerminated
      ? 'resume'
      : null;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

  if (!mode) return null;

  async function submit() {
    const prompt = text.trim();
    if (!prompt || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const newId = await resumeSession(sessionId, { additionalPrompt: prompt });
      if (!newId) throw new Error(mode === 'interrupt' ? 'Restart failed' : 'Resume failed');
      setText('');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    }
  }

  const placeholder = mode === 'interrupt' ? 'Interrupt with new prompt…' : 'Resume with new prompt…';
  const buttonTitle = mode === 'interrupt'
    ? 'Kill the current session and restart with this additional prompt (Enter to send, Shift+Enter for newline)'
    : 'Resume this session with full context plus the new prompt appended (Enter to send, Shift+Enter for newline)';
  const idleLabel = mode === 'interrupt' ? 'Interrupt' : 'Resume';
  const busyLabel = mode === 'interrupt' ? 'Restarting…' : 'Resuming…';

  return (
    <div class={`interrupt-bar interrupt-bar--${mode}`}>
      {error && <div class="interrupt-bar-error">{error}</div>}
      <div class="interrupt-bar-row">
        <textarea
          ref={(el) => { textareaRef.current = el; }}
          class="interrupt-bar-input"
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={submitting}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class="interrupt-bar-submit"
          disabled={submitting || !text.trim()}
          onClick={submit}
          title={buttonTitle}
        >
          {submitting ? busyLabel : idleLabel}
        </button>
      </div>
    </div>
  );
}
