import { signal } from '@preact/signals';
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession, loadAllSessions } from '../lib/sessions.js';
import { selectedAppId, applications } from '../lib/state.js';

const panelOpen = signal(false);

export function RequestPanel() {
  const appId = selectedAppId.value;
  if (!appId || appId === '__unlinked__') return null;

  const app = applications.value.find((a: any) => a.id === appId);
  if (!app) return null;

  const config = app.requestPanel || { suggestions: [], preferences: [] };

  return (
    <>
      <button
        class="request-panel-trigger"
        onClick={() => { panelOpen.value = !panelOpen.value; }}
        title="Send a request"
      >
        {'\u2728'}
      </button>
      {panelOpen.value && (
        <RequestPopover app={app} config={config} onClose={() => { panelOpen.value = false; }} />
      )}
    </>
  );
}

function RequestPopover({ app, config, onClose }: { app: any; config: any; onClose: () => void }) {
  const [text, setText] = useState('');
  const [checkedPrefs, setCheckedPrefs] = useState<Set<string>>(() => {
    const defaults = new Set<string>();
    for (const p of config.preferences || []) {
      if (p.default) defaults.add(p.id);
    }
    return defaults;
  });
  const [submitting, setSubmitting] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const trigger = document.querySelector('.request-panel-trigger');
        if (trigger && trigger.contains(e.target as Node)) return;
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  function togglePref(id: string) {
    setCheckedPrefs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { sessionId } = await api.submitAppRequest(app.id, {
        request: text.trim(),
        preferences: Array.from(checkedPrefs),
      });
      openSession(sessionId);
      loadAllSessions();
      onClose();
    } catch (err: any) {
      console.error('Request failed:', err.message);
    }
    setSubmitting(false);
  }

  const suggestions = config.suggestions || [];
  const preferences = config.preferences || [];

  return (
    <div class="request-panel-popover" ref={panelRef}>
      <div class="request-panel-header">
        <span style="font-weight:600;font-size:13px">Request</span>
        <button class="request-panel-close" onClick={onClose}>{'\u2715'}</button>
      </div>

      <textarea
        ref={textareaRef}
        class="request-panel-textarea"
        placeholder="What would you like the agent to do?"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
      />

      {suggestions.length > 0 && (
        <div class="request-panel-suggestions">
          <button
            class="request-panel-suggestions-toggle"
            onClick={() => setShowSuggestions(!showSuggestions)}
          >
            {showSuggestions ? '\u25BC' : '\u25B6'} Suggestions
          </button>
          {showSuggestions && (
            <div class="request-panel-suggestions-list">
              {suggestions.map((s: any) => (
                <button
                  key={s.label}
                  class="request-panel-suggestion-chip"
                  onClick={() => { setText(s.prompt); setShowSuggestions(false); textareaRef.current?.focus(); }}
                  title={s.prompt}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {preferences.length > 0 && (
        <div class="request-panel-preferences">
          {preferences.map((p: any) => (
            <label key={p.id} class="request-panel-pref-label">
              <input
                type="checkbox"
                checked={checkedPrefs.has(p.id)}
                onChange={() => togglePref(p.id)}
              />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
      )}

      <div class="request-panel-footer">
        <button
          class="btn btn-sm btn-primary"
          disabled={!text.trim() || submitting}
          onClick={submit}
        >
          {submitting ? 'Sending...' : 'Submit'}
        </button>
        <span class="request-panel-hint">{'\u2318'}+Enter</span>
      </div>
    </div>
  );
}
