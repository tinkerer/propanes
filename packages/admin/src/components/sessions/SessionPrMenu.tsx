import { useState } from 'preact/hooks';
import { api } from '../../lib/api.js';
import { allSessions } from '../../lib/session-state.js';
import { prNumberFromUrl } from '../PrBadges.js';

// PR section of the sidebar session menu: "Review PR #N" per badge, an × to
// drop a wrongly detected badge, and an inline "Add PR badge…" field for a PR
// the detector missed. Edits go to POST /agent-sessions/:id/pr-urls and are
// kept as overrides server-side, so later detection can't undo them.

function applyPrUrls(sessionId: string, prUrls: string[]) {
  allSessions.value = allSessions.value.map((s: any) =>
    s.id === sessionId ? { ...s, prUrls: prUrls.length ? prUrls : null } : s,
  );
}

export function SessionPrMenu({ sessionId, prUrls, onReview, onDone }: {
  sessionId: string;
  prUrls: string[];
  onReview: (url: string, anchor: { x: number; y: number }) => void;
  onDone: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function change(op: { add?: string; remove?: string }) {
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateSessionPrUrls(sessionId, op);
      applyPrUrls(sessionId, res.prUrls);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    if (!value.trim() || saving) return;
    if (await change({ add: value.trim() })) {
      setValue('');
      setAdding(false);
      onDone();
    }
  }

  return (
    <>
      {prUrls.map((url) => (
        <div key={url} class="status-dot-menu-row">
          <button
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onReview(url, { x: rect.right + 8, y: rect.top });
            }}
          >Review PR #{prNumberFromUrl(url)}</button>
          <button
            class="status-dot-menu-row-remove"
            title={`Remove PR #${prNumberFromUrl(url)} badge`}
            disabled={saving}
            onClick={() => { change({ remove: url }); }}
          >{'×'}</button>
        </div>
      ))}
      {adding ? (
        <div class="status-dot-menu-input">
          <input
            type="text"
            placeholder="PR URL, owner/repo#123 or 123"
            value={value}
            disabled={saving}
            onInput={(e) => { setValue((e.target as HTMLInputElement).value); setError(null); }}
            onKeyDown={(e) => {
              // Keep keystrokes away from the global shortcut layer / xterm.
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setError(null); }
            }}
            ref={(el) => { if (el && document.activeElement !== el && !saving) el.focus(); }}
          />
          <button disabled={saving || !value.trim()} onClick={submit}>Add</button>
        </div>
      ) : (
        <button onClick={() => { setAdding(true); setError(null); }}>Add PR badge{'…'}</button>
      )}
      {error && <div class="status-dot-menu-error">{error}</div>}
    </>
  );
}
