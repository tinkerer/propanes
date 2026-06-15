import { useState, useRef, useEffect } from 'preact/hooks';
import { api } from '../../lib/api.js';
import { resumeSession, lastResumeError } from '../../lib/sessions.js';
import type { ParsedMessage } from '../../lib/output-parser.js';

export interface SessionInputBarProps {
  sessionId: string;
  /** The last message in the conversation — used to detect pending tool calls */
  lastMessage?: ParsedMessage | null;
  /** Session input state: 'active' | 'waiting' | 'idle' */
  inputState: 'active' | 'waiting' | 'idle';
  /** Whether session is still running */
  isRunning: boolean;
}

// ---------------------------------------------------------------------------
// AskUserQuestion detection helpers
// ---------------------------------------------------------------------------

interface AskQuestion {
  question: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  defaultAnswer?: string;
}

function extractAskUserQuestion(msg: ParsedMessage | null | undefined): AskQuestion | null {
  if (!msg) return null;
  if (msg.role !== 'tool_use' || msg.toolName !== 'AskUserQuestion') return null;
  const inp = msg.toolInput as Record<string, unknown> | undefined;
  if (!inp) return null;
  const question = (typeof inp.question === 'string' ? inp.question : '') ||
                   (typeof inp.text === 'string' ? inp.text : '');
  if (!question) return null;

  let options: AskQuestion['options'] = undefined;
  if (Array.isArray(inp.options)) {
    options = (inp.options as any[]).map((o) => {
      if (typeof o === 'string') return { label: o };
      return { label: String(o?.label ?? o), description: o?.description };
    });
  }

  return {
    question,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: !!inp.multiSelect || !!inp.multi_select,
    defaultAnswer: typeof inp.default_answer === 'string' ? inp.default_answer :
                   typeof inp.defaultAnswer === 'string' ? inp.defaultAnswer : undefined,
  };
}

// ---------------------------------------------------------------------------
// Answer state helpers (mirrors InteractivePrompt logic)
// ---------------------------------------------------------------------------

type AnswerState =
  | { kind: 'text'; value: string }
  | { kind: 'single'; value: string | null }
  | { kind: 'multi'; values: Set<string> };

function initAnswer(q: AskQuestion): AnswerState {
  if (!q.options || q.options.length === 0) return { kind: 'text', value: q.defaultAnswer || '' };
  if (q.multiSelect) return { kind: 'multi', values: new Set() };
  return { kind: 'single', value: null };
}

function serializeAnswer(a: AnswerState): string {
  if (a.kind === 'text') return a.value.trim();
  if (a.kind === 'single') return a.value || '';
  return [...a.values].join(', ');
}

function canSubmitAnswer(a: AnswerState): boolean {
  if (a.kind === 'text') return a.value.trim().length > 0;
  if (a.kind === 'single') return a.value !== null;
  return a.values.size > 0;
}

// ---------------------------------------------------------------------------
// Quick-action buttons for generic waiting state
// ---------------------------------------------------------------------------

const QUICK_ACTIONS = [
  { label: 'Yes', keys: 'y' },
  { label: 'No', keys: 'n' },
  { label: '1', keys: '1' },
  { label: '2', keys: '2' },
  { label: '3', keys: '3' },
];

// ---------------------------------------------------------------------------
// Pending tool context summary
// ---------------------------------------------------------------------------

function summarizePendingTool(msg: ParsedMessage | null | undefined): string | null {
  if (!msg || msg.role !== 'tool_use') return null;
  const name = msg.toolName || 'tool call';
  const inp = msg.toolInput as Record<string, unknown> | undefined;
  if (!inp) return name;

  // Extract a meaningful one-liner for common tools
  if (name === 'Bash' || name === 'bash') {
    const cmd = typeof inp.command === 'string' ? inp.command : null;
    if (cmd) return `Bash: ${cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd}`;
  }
  if (name === 'Edit' || name === 'edit') {
    const fp = typeof inp.file_path === 'string' ? inp.file_path : null;
    if (fp) return `Edit: ${fp}`;
  }
  if (name === 'Write' || name === 'write') {
    const fp = typeof inp.file_path === 'string' ? inp.file_path : null;
    if (fp) return `Write: ${fp}`;
  }
  if (name === 'Read' || name === 'read') {
    const fp = typeof inp.file_path === 'string' ? inp.file_path : null;
    if (fp) return `Read: ${fp}`;
  }
  // Fallback: tool name + first string-valued key
  for (const [k, v] of Object.entries(inp)) {
    if (typeof v === 'string' && v.length > 0) {
      const snippet = v.length > 100 ? v.slice(0, 97) + '...' : v;
      return `${name}: ${snippet}`;
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionInputBar({ sessionId, lastMessage, inputState, isRunning }: SessionInputBarProps) {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isWaiting = inputState === 'waiting';
  const askQuestion = isWaiting ? extractAskUserQuestion(lastMessage) : null;

  // Reset answer state when question changes
  useEffect(() => {
    if (askQuestion) {
      setAnswer(initAnswer(askQuestion));
    } else {
      setAnswer(null);
    }
  }, [askQuestion?.question, askQuestion?.options?.length]);

  // Auto-focus when entering waiting state
  useEffect(() => {
    if (isWaiting) {
      setTimeout(() => {
        if (askQuestion && !askQuestion.options) {
          textareaRef.current?.focus();
        } else if (!askQuestion) {
          inputRef.current?.focus();
        }
      }, 100);
    }
  }, [isWaiting, !!askQuestion]);

  async function sendTerminalText(value: string) {
    if (!value.trim() || submitting || stopping) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.sendKeys(sessionId, { keys: value, enter: true });
      if (!result.ok) throw new Error(result.error || 'send-keys failed');
      setText('');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPrompt(value: string) {
    const additionalPrompt = value.trim();
    if (!additionalPrompt || submitting || stopping) return;
    setSubmitting(true);
    setError(null);
    try {
      const newId = await resumeSession(sessionId, { additionalPrompt });
      if (!newId) {
        const real = lastResumeError.value;
        const realMsg = real && real.sessionId === sessionId ? real.message : null;
        throw new Error(realMsg ? `Resume failed: ${realMsg}` : 'Resume failed');
      }
      setText('');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function sendAnswer() {
    if (!answer || !canSubmitAnswer(answer) || submitting || stopping) return;
    const value = serializeAnswer(answer);
    if (!value) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.sendKeys(sessionId, { keys: value, enter: true });
      if (!result.ok) throw new Error(result.error || 'send-keys failed');
      setAnswer(null);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function sendQuickAction(keys: string) {
    if (submitting || stopping) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.sendKeys(sessionId, { keys, enter: true });
      if (!result.ok) throw new Error(result.error || 'send-keys failed');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeWithInterruption(value: string) {
    const additionalPrompt = value.trim();
    if (!additionalPrompt || submitting || stopping) return;
    setStopping(true);
    setError(null);
    try {
      const newId = await resumeSession(sessionId, { additionalPrompt });
      if (!newId) {
        const real = lastResumeError.value;
        const realMsg = real && real.sessionId === sessionId ? real.message : null;
        throw new Error(realMsg ? `Stop and resume failed: ${realMsg}` : 'Stop and resume failed');
      }
      setText('');
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setStopping(false);
    }
  }

  function onTerminalInputKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendTerminalText(text);
    }
  }

  function onGeneralInputKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (isRunning) {
        sendTerminalText(text);
      } else {
        submitPrompt(text);
      }
    }
  }

  function onTextareaKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendAnswer();
    }
  }

  const dimmed = !isRunning || inputState === 'idle';

  // -- State 1: AskUserQuestion with options or text --
  if (isWaiting && askQuestion && answer) {
    return (
      <div class="conv-input-bar conv-input-bar-ask">
        <div class="conv-input-bar-question">{askQuestion.question}</div>

        {askQuestion.options && answer.kind === 'single' && (
          <div class="conv-input-bar-options">
            {askQuestion.options.map((opt, i) => {
              const selected = answer.value === opt.label;
              return (
                <button
                  key={i}
                  type="button"
                  class={`conv-input-bar-opt${selected ? ' conv-input-bar-opt-sel' : ''}`}
                  disabled={submitting}
                  onClick={() => setAnswer({ kind: 'single', value: opt.label })}
                >
                  <span class="conv-input-bar-opt-marker">{selected ? '\u25cf' : '\u25cb'}</span>
                  <span class="conv-input-bar-opt-body">
                    <span class="conv-input-bar-opt-label">{opt.label}</span>
                    {opt.description && <span class="conv-input-bar-opt-desc">{opt.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {askQuestion.options && answer.kind === 'multi' && (
          <div class="conv-input-bar-options">
            {askQuestion.options.map((opt, i) => {
              const selected = answer.values.has(opt.label);
              return (
                <button
                  key={i}
                  type="button"
                  class={`conv-input-bar-opt${selected ? ' conv-input-bar-opt-sel' : ''}`}
                  disabled={submitting}
                  onClick={() => {
                    setAnswer((prev) => {
                      if (!prev || prev.kind !== 'multi') return prev;
                      const next = new Set(prev.values);
                      if (next.has(opt.label)) next.delete(opt.label); else next.add(opt.label);
                      return { kind: 'multi', values: next };
                    });
                  }}
                >
                  <span class="conv-input-bar-opt-marker">{selected ? '\u2611' : '\u2610'}</span>
                  <span class="conv-input-bar-opt-body">
                    <span class="conv-input-bar-opt-label">{opt.label}</span>
                    {opt.description && <span class="conv-input-bar-opt-desc">{opt.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!askQuestion.options && answer.kind === 'text' && (
          <textarea
            ref={textareaRef}
            class="conv-input-bar-textarea"
            rows={2}
            placeholder="Type your answer... (Enter to send, Shift+Enter for newline)"
            value={answer.value}
            disabled={submitting}
            onInput={(e) => setAnswer({ kind: 'text', value: (e.target as HTMLTextAreaElement).value })}
            onKeyDown={onTextareaKeyDown}
          />
        )}

        {error && <div class="conv-input-bar-error">{error}</div>}

        <div class="conv-input-bar-actions">
          <button
            type="button"
            class="conv-input-bar-submit"
            disabled={!canSubmitAnswer(answer) || submitting}
            onClick={sendAnswer}
          >
            {submitting ? 'Sending...' : 'Send answer'}
          </button>
        </div>
      </div>
    );
  }

  // -- State 2: Generic waiting --
  if (isWaiting) {
    const pendingContext = summarizePendingTool(lastMessage);
    return (
      <div class="conv-input-bar conv-input-bar-waiting">
        {pendingContext && (
          <div class="conv-input-bar-context">{pendingContext}</div>
        )}
        <div class="conv-input-bar-quick">
          {QUICK_ACTIONS.map((qa) => (
            <button
              key={qa.label}
              type="button"
              class="conv-input-bar-quick-btn"
              disabled={submitting || stopping}
              onClick={() => sendQuickAction(qa.keys)}
            >
              {qa.label}
            </button>
          ))}
        </div>
        <div class="conv-input-bar-row">
          <input
            ref={inputRef}
            type="text"
            class="conv-input-bar-input"
            placeholder="Type a response..."
            value={text}
            disabled={submitting || stopping}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            onKeyDown={onTerminalInputKeyDown}
          />
          {isRunning && (
            <button
              type="button"
              class="conv-input-bar-stop"
              disabled={!text.trim() || submitting || stopping}
              onClick={() => resumeWithInterruption(text)}
              title="Stop the running session and resume with this text"
            >
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          )}
          <button
            type="button"
            class="conv-input-bar-send"
            disabled={!text.trim() || submitting || stopping}
            onClick={() => sendTerminalText(text)}
          >
            Send
          </button>
        </div>
        {error && <div class="conv-input-bar-error">{error}</div>}
      </div>
    );
  }

  // -- State 3: Active/idle (general-purpose input) --
  return (
    <div class={`conv-input-bar conv-input-bar-general${dimmed ? ' conv-input-bar-dimmed' : ''}`}>
      <div class="conv-input-bar-row">
        <input
          ref={inputRef}
          type="text"
          class="conv-input-bar-input"
          placeholder={isRunning ? 'Send prompt to session...' : 'Resume with a follow-up...'}
          value={text}
          disabled={submitting || stopping}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={onGeneralInputKeyDown}
        />
        {isRunning && (
          <button
            type="button"
            class="conv-input-bar-stop"
            disabled={!text.trim() || submitting || stopping}
            onClick={() => resumeWithInterruption(text)}
            title="Stop the running session and resume with this text"
          >
            {stopping ? 'Stopping...' : 'Stop'}
          </button>
        )}
        <button
          type="button"
          class="conv-input-bar-send"
          disabled={!text.trim() || submitting || stopping}
          onClick={() => isRunning ? sendTerminalText(text) : submitPrompt(text)}
          title={isRunning ? 'Send this text and press Enter in the running session' : 'Resume with this prompt'}
        >
          {isRunning ? 'Send' : 'Resume'}
        </button>
      </div>
      {error && <div class="conv-input-bar-error">{error}</div>}
    </div>
  );
}
