import { signal } from '@preact/signals';

/** A newer admin bundle has been deployed since this tab loaded. */
export const updateAvailable = signal(false);

// Matches the hashed entry bundle referenced by index.html, e.g.
// /admin/assets/index-CQBw-kEk.js
const BUNDLE_RE = /\/assets\/(index-[\w-]+\.js)/;

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function loadedBundle(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  const m = script?.getAttribute('src')?.match(BUNDLE_RE);
  return m ? m[1] : null;
}

let started = false;

/** Periodically re-fetch this page's HTML and compare the entry-bundle hash
 *  against the one this tab loaded. Admin bundles are hot-deployed under the
 *  running server (dist swap, no restart), so a long-lived tab never learns
 *  it's stale — bug reports kept coming in for issues the deployed bundle had
 *  already fixed. On mismatch, flip `updateAvailable` so the UpdateBanner can
 *  offer a reload; never reload automatically (live terminals, half-typed
 *  prompts). */
export function initUpdateCheck() {
  if (started) return;
  started = true;
  const current = loadedBundle();
  // Vite dev server: no hashed bundle, nothing to compare.
  if (!current) return;

  let inFlight = false;
  const check = async () => {
    if (inFlight || document.hidden || updateAvailable.value) return;
    inFlight = true;
    try {
      // Fetch whatever path this SPA was served from (`/admin/`, `/<user>`) —
      // the server answers all of them with the current index.html.
      const res = await fetch(window.location.pathname, {
        cache: 'no-store',
        headers: { accept: 'text/html' },
      });
      if (!res.ok) return;
      const m = (await res.text()).match(BUNDLE_RE);
      if (m && m[1] !== current) updateAvailable.value = true;
    } catch {
      // Offline / transient — try again on the next tick.
    } finally {
      inFlight = false;
    }
  };

  setInterval(check, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}
