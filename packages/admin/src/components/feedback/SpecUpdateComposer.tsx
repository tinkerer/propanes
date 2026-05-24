import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { launchSpecUpdate } from '../../lib/spec-update.js';
import { openSession } from '../../lib/sessions.js';

interface Props {
  appId: string;
  onClose: () => void;
  onLaunched?: (sessionId: string | undefined) => void;
}

export function SpecUpdateComposer({ appId, onClose, onLaunched }: Props) {
  const [text, setText] = useState('');
  const [preferYolo, setPreferYolo] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!submitting) onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await launchSpecUpdate(appId, {
        additionalInstructions: text.trim() || undefined,
        preferYolo,
      });
      if (res.sessionId) openSession(res.sessionId);
      onLaunched?.(res.sessionId);
      onClose();
    } catch (err: any) {
      console.error('Spec update launch failed:', err);
      setError(err?.message || 'Failed to launch spec update');
      setSubmitting(false);
    }
  }

  function onTextareaKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  return createPortal(
    <div class="modal-overlay" onClick={() => { if (!submitting) onClose(); }}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Update Spec Wiki</h3>
        <p style={{ color: 'var(--pw-text-muted)', fontSize: 13, marginTop: -8, marginBottom: 12 }}>
          Rebuilds the spec wiki from tickets, CoS inputs, and agent JSONL histories.
          Add any extra direction below, or just hit Cook.
        </p>

        <div class="form-group">
          <label>Additional direction <span style={{ color: 'var(--pw-text-muted)' }}>(optional)</span></label>
          <textarea
            ref={textareaRef}
            class="request-panel-textarea"
            placeholder="e.g. emphasize the dispatch flow, skip the deprecated v1 endpoints, focus on the new aggregate module..."
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onTextareaKeyDown}
            rows={5}
            disabled={submitting}
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={preferYolo}
            onChange={(e) => setPreferYolo((e.target as HTMLInputElement).checked)}
            disabled={submitting}
          />
          <span>{'⚡'} Run YOLO (skip permission prompts)</span>
        </label>

        {error && <div class="form-error" style={{ marginTop: 12 }}>{error}</div>}

        <div class="modal-actions">
          <button class="btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button class="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Launching...' : preferYolo ? 'YOLO Cook' : 'Cook It'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
