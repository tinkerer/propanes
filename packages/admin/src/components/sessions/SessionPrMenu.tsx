import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../lib/api.js';
import { allSessions } from '../../lib/session-state.js';
import { placeSubmenu, type SubmenuPlacement } from '../../lib/submenu-position.js';
import { prNumberFromUrl } from '../PrBadges.js';

// PR section of the sidebar session menu: "Review PR #N" per badge, an × to
// drop a wrongly detected badge, and an inline "Add PR badge…" field for a PR
// the detector missed. Edits go to POST /agent-sessions/:id/pr-urls and are
// kept as overrides server-side, so later detection can't undo them.
//
// A session with several PRs gets a single "Review PRs ›" row whose flyout
// lists them, so the parent menu stays short; the flyout is capped to the
// viewport height and scrolls when the list is longer than the window.

const PR_ROW_HEIGHT = 26;
const SUBMENU_WIDTH = 190;
const SUBMENU_CLOSE_DELAY_MS = 150;

// Rows the PR section contributes to the parent menu (used by the menu's
// flip-up estimate): every PR when inline, one trigger row when collapsed.
export function prMenuRowCount(prCount: number): number {
  return prCount > 1 ? 1 : prCount;
}

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

  const prRow = (url: string) => (
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
  );

  return (
    <>
      {prUrls.length > 1
        ? <PrSubmenu count={prUrls.length}>{prUrls.map(prRow)}</PrSubmenu>
        : prUrls.map(prRow)}
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

// "Review PRs ›" trigger plus its flyout. Opens on hover or click; closes
// when the pointer leaves both the row and the flyout (after a short grace
// period so crossing the gap between them doesn't flicker it shut). The
// flyout is a fixed-position DOM child of the menu, so the document-level
// click-away handler on the parent menu still sees clicks inside it as
// "inside".
function PrSubmenu({ count, children }: { count: number; children: ComponentChildren }) {
  const [placement, setPlacement] = useState<SubmenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const open = () => {
    cancelClose();
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPlacement(placeSubmenu(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      count * PR_ROW_HEIGHT + 8,
      SUBMENU_WIDTH,
    ));
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setPlacement(null), SUBMENU_CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  return (
    <div
      class="status-dot-submenu-host"
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        class={`status-dot-submenu-trigger${placement ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!placement}
        onClick={() => { placement ? setPlacement(null) : open(); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); open(); }
          if (e.key === 'ArrowLeft' || e.key === 'Escape') { e.preventDefault(); setPlacement(null); }
        }}
      >
        Review PRs <span class="status-dot-submenu-count">{count}</span>
        <span class="status-dot-submenu-chevron">{'\u203A'}</span>
      </button>
      {placement && (
        <div
          class="status-dot-submenu"
          role="menu"
          style={{ left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${placement.maxHeight}px` }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
