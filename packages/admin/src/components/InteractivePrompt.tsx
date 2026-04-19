import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api.js';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

interface Props {
  sessionId: string;
  questions: Question[];
  disabled?: boolean;
  onSubmitted?: () => void;
}

type QAnswer = { kind: 'single'; value: string | null } | { kind: 'multi'; values: Set<string> } | { kind: 'text'; value: string };

function initAnswer(q: Question): QAnswer {
  if (!q.options || q.options.length === 0) return { kind: 'text', value: '' };
  if (q.multiSelect) return { kind: 'multi', values: new Set() };
  return { kind: 'single', value: null };
}

function serializeAnswer(a: QAnswer): string {
  if (a.kind === 'text') return a.value.trim();
  if (a.kind === 'single') return a.value || '';
  return [...a.values].join(', ');
}

export function AskUserQuestionPrompt({ sessionId, questions, disabled, onSubmitted }: Props) {
  const [answers, setAnswers] = useState<QAnswer[]>(() => questions.map(initAnswer));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    setAnswers(questions.map(initAnswer));
  }, [questions.length]);

  useEffect(() => {
    const t = setTimeout(() => firstInputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const canSubmit = !disabled && !submitting && questions.every((q, i) => {
    const a = answers[i];
    if (a.kind === 'single') return a.value !== null;
    if (a.kind === 'multi') return a.values.size > 0;
    return a.value.trim().length > 0;
  });

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // Strategy: send each answer line-by-line. For single questions, just
      // send the label text followed by Enter. Claude CLI's AskUserQuestion
      // accepts free-text input of the option label (matched case-insensitively).
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const a = answers[i];
        const text = serializeAnswer(a);
        if (!text) continue;
        const result = await api.sendKeys(sessionId, {
          keys: text,
          enter: true,
        });
        if (!result.ok) throw new Error(result.error || 'send-keys failed');
        // Claude CLI needs a small delay between multi-question answers so it
        // registers each as a separate input.
        if (i < questions.length - 1) await new Promise(r => setTimeout(r, 60));
      }
      onSubmitted?.();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function updateAnswer(i: number, update: (prev: QAnswer) => QAnswer) {
    setAnswers(prev => prev.map((a, idx) => idx === i ? update(a) : a));
  }

  function onTextKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    }
  }

  return (
    <div class="sm-iprompt" data-kind="askuserquestion">
      <div class="sm-iprompt-header">
        <span class="sm-iprompt-icon">❓</span>
        <span class="sm-iprompt-title">Agent is asking</span>
        {disabled && <span class="sm-iprompt-badge muted">read-only</span>}
        {!disabled && <span class="sm-iprompt-badge live">awaiting input</span>}
      </div>
      {questions.map((q, qi) => {
        const a = answers[qi];
        return (
          <div key={qi} class="sm-iprompt-question">
            {q.header && <div class="sm-iprompt-q-badge">{q.header}</div>}
            <div class="sm-iprompt-q-text">{q.question}</div>
            {a.kind === 'text' ? (
              <textarea
                ref={qi === 0 ? (el => { firstInputRef.current = el; }) : undefined}
                class="sm-iprompt-textarea"
                rows={3}
                value={a.value}
                disabled={disabled || submitting}
                placeholder="Type your answer. Enter to submit, Shift+Enter for newline."
                onInput={(e) => {
                  const v = (e.target as HTMLTextAreaElement).value;
                  updateAnswer(qi, () => ({ kind: 'text', value: v }));
                }}
                onKeyDown={onTextKeyDown}
              />
            ) : a.kind === 'single' ? (
              <div class="sm-iprompt-options">
                {q.options!.map((opt, oi) => {
                  const selected = a.value === opt.label;
                  return (
                    <button
                      key={oi}
                      type="button"
                      class={`sm-iprompt-option ${selected ? 'selected' : ''}`}
                      disabled={disabled || submitting}
                      onClick={() => updateAnswer(qi, () => ({ kind: 'single', value: opt.label }))}
                    >
                      <span class="sm-iprompt-option-marker">{selected ? '●' : '○'}</span>
                      <span class="sm-iprompt-option-body">
                        <span class="sm-iprompt-option-label">{opt.label}</span>
                        {opt.description && <span class="sm-iprompt-option-desc">{opt.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div class="sm-iprompt-options">
                {q.options!.map((opt, oi) => {
                  const selected = a.values.has(opt.label);
                  return (
                    <button
                      key={oi}
                      type="button"
                      class={`sm-iprompt-option ${selected ? 'selected' : ''}`}
                      disabled={disabled || submitting}
                      onClick={() => updateAnswer(qi, prev => {
                        if (prev.kind !== 'multi') return prev;
                        const next = new Set(prev.values);
                        if (next.has(opt.label)) next.delete(opt.label);
                        else next.add(opt.label);
                        return { kind: 'multi', values: next };
                      })}
                    >
                      <span class="sm-iprompt-option-marker">{selected ? '☑' : '☐'}</span>
                      <span class="sm-iprompt-option-body">
                        <span class="sm-iprompt-option-label">{opt.label}</span>
                        {opt.description && <span class="sm-iprompt-option-desc">{opt.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {error && <div class="sm-iprompt-error">{error}</div>}
      <div class="sm-iprompt-actions">
        <button
          type="button"
          class="sm-iprompt-submit"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </div>
  );
}

// --- Generic yes/no/approve prompt (for permission-request style interactions) ---

export interface ChoiceOption {
  label: string;
  keys: string;      // what to send via send-keys (e.g. "1", "y", "2")
  kind?: 'approve' | 'approve-all' | 'deny' | 'neutral';
  description?: string;
}

interface ChoicePromptProps {
  sessionId: string;
  title?: string;
  prompt: string;
  choices: ChoiceOption[];
  onSubmitted?: () => void;
  disabled?: boolean;
}

export function ChoicePrompt({ sessionId, title, prompt, choices, onSubmitted, disabled }: ChoicePromptProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastChoice, setLastChoice] = useState<string | null>(null);

  async function submit(choice: ChoiceOption) {
    if (submitting || disabled) return;
    setSubmitting(true);
    setError(null);
    setLastChoice(choice.label);
    try {
      const result = await api.sendKeys(sessionId, { keys: choice.keys, enter: true });
      if (!result.ok) throw new Error(result.error || 'send-keys failed');
      onSubmitted?.();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="sm-iprompt" data-kind="choice">
      <div class="sm-iprompt-header">
        <span class="sm-iprompt-icon">⚡</span>
        <span class="sm-iprompt-title">{title || 'Permission required'}</span>
        {!disabled && <span class="sm-iprompt-badge live">awaiting input</span>}
      </div>
      <div class="sm-iprompt-question">
        <div class="sm-iprompt-q-text">{prompt}</div>
        <div class="sm-iprompt-choice-row">
          {choices.map((c, i) => (
            <button
              key={i}
              type="button"
              class={`sm-iprompt-choice sm-iprompt-choice-${c.kind || 'neutral'} ${lastChoice === c.label ? 'active' : ''}`}
              disabled={submitting || disabled}
              onClick={() => submit(c)}
              title={c.description}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {error && <div class="sm-iprompt-error">{error}</div>}
    </div>
  );
}
