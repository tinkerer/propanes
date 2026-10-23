/**
 * Toggle semantics for the per-session status-dot menus.
 *
 * Every status dot stops click propagation (so the dot's own click doesn't
 * reach the document-level click-away handler), then writes the menu
 * signal. Writing unconditionally meant a second click on the same dot
 * re-opened the menu instead of closing it. This helper returns the next
 * menu state: `null` when the click is on the dot whose menu is already
 * open, otherwise the new anchor (also switching cleanly between dots).
 */
export function toggleDotMenu<T extends { sessionId: string }>(
  current: T | null | undefined,
  next: T,
  sameTarget: (a: T, b: T) => boolean = (a, b) => a.sessionId === b.sessionId,
): T | null {
  if (current && sameTarget(current, next)) return null;
  return next;
}
