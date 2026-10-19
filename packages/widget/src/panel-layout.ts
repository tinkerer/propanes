/**
 * Pure geometry helpers for the widget's floating overlay panels. Kept free
 * of DOM access so the arrangement rules (cascade / center / viewport clamp)
 * are easy to reason about and test in isolation.
 */

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Height of `.pw-overlay-header` — the grab bar must stay on screen. */
export const PANEL_HEADER_HEIGHT = 36;
/** How much of a panel must remain visible horizontally so it can be grabbed. */
export const MIN_VISIBLE_WIDTH = 100;
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MIN_HEIGHT = 200;

const CASCADE_ORIGIN = 40;
const CASCADE_STEP = 30;
const VIEWPORT_MARGIN = 20;

/** Shrink a size so it fits the viewport (with margin), never below the panel minimums. */
export function fitSizeToViewport(width: number, height: number, vp: Viewport): { width: number; height: number } {
  const maxW = Math.max(PANEL_MIN_WIDTH, vp.width - VIEWPORT_MARGIN * 2);
  const maxH = Math.max(PANEL_MIN_HEIGHT, vp.height - VIEWPORT_MARGIN * 2);
  return {
    width: Math.min(Math.max(PANEL_MIN_WIDTH, width), maxW),
    height: Math.min(Math.max(PANEL_MIN_HEIGHT, height), maxH),
  };
}

/**
 * Keep a panel recoverable: its header may never sit above the top edge or
 * below the bottom edge, and at least MIN_VISIBLE_WIDTH of it must stay
 * on-screen horizontally. Size is left untouched — only the position moves.
 */
export function clampRectToViewport(rect: PanelRect, vp: Viewport): PanelRect {
  const maxY = Math.max(0, vp.height - PANEL_HEADER_HEIGHT);
  const minX = Math.min(0, MIN_VISIBLE_WIDTH - rect.width);
  const maxX = Math.max(minX, vp.width - MIN_VISIBLE_WIDTH);
  const x = Math.min(Math.max(minX, rect.x), maxX);
  const y = Math.min(Math.max(0, rect.y), maxY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ...rect, x: 0, y: 0 };
  return { ...rect, x, y };
}

/**
 * Stagger panels diagonally from the top-left, in the given (z-)order, so
 * every header is visible and reachable. Panels that would overflow the
 * viewport are shrunk to fit; the diagonal wraps back to the origin once it
 * runs out of room.
 */
export function cascadeLayout(rects: PanelRect[], vp: Viewport): PanelRect[] {
  const out: PanelRect[] = [];
  let step = 0;
  for (const rect of rects) {
    const size = fitSizeToViewport(rect.width, rect.height, vp);
    let x = CASCADE_ORIGIN + step * CASCADE_STEP;
    let y = CASCADE_ORIGIN + step * CASCADE_STEP;
    // Wrap when the offset would push the panel's header past the lower-right
    // region of the viewport.
    if (x + size.width > vp.width - VIEWPORT_MARGIN || y + size.height > vp.height - VIEWPORT_MARGIN) {
      step = 0;
      x = CASCADE_ORIGIN;
      y = CASCADE_ORIGIN;
    }
    out.push(clampRectToViewport({ x, y, ...size }, vp));
    step++;
  }
  return out;
}

/** Center every panel in the viewport, shrinking any that would not fit. */
export function centerLayout(rects: PanelRect[], vp: Viewport): PanelRect[] {
  return rects.map((rect) => {
    const size = fitSizeToViewport(rect.width, rect.height, vp);
    return clampRectToViewport({
      x: Math.round((vp.width - size.width) / 2),
      y: Math.round((vp.height - size.height) / 2),
      ...size,
    }, vp);
  });
}
