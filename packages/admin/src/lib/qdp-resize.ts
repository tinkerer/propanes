// Pure geometry for the Quick Dispatch panel's bottom-left resize grip.
// Kept free of DOM/app imports so it can be unit-tested in node.

export const QDP_PANEL_W = 400;
export const QDP_PANEL_H = 220;
export const QDP_PANEL_MIN_W = 320;
export const QDP_PANEL_MIN_H = 200;
const GUTTER = 8;

export interface PanelSize { w: number; h: number }

/**
 * Resize from the bottom-left corner: the panel's top-right corner stays put,
 * so growing leftwards shifts `left` by however much the width changed.
 * Mirrors the widget's corner-handle math (`initResize` in widget.ts), with
 * the left edge stopping at the viewport gutter.
 */
export function resizeFromBottomLeft(
  start: { x: number; w: number; h: number },
  dx: number,
  dy: number,
  viewportW: number,
): { x: number; w: number; h: number } {
  const right = start.x + start.w;
  const maxW = Math.max(QDP_PANEL_MIN_W, right - GUTTER, viewportW - 2 * GUTTER);
  const w = Math.min(maxW, Math.max(QDP_PANEL_MIN_W, start.w - dx));
  const h = Math.max(QDP_PANEL_MIN_H, start.h + dy);
  const x = Math.max(GUTTER, right - w);
  return { x, w: right - x, h };
}

/** Clamp a persisted size to something sane for the current viewport. */
export function clampPanelSize(width: unknown, height: unknown, viewportW: number): PanelSize | null {
  if (typeof width !== 'number' || typeof height !== 'number' || !isFinite(width) || !isFinite(height)) return null;
  const maxW = Math.max(QDP_PANEL_MIN_W, viewportW - 2 * GUTTER);
  return {
    w: Math.min(maxW, Math.max(QDP_PANEL_MIN_W, Math.round(width))),
    h: Math.max(QDP_PANEL_MIN_H, Math.round(height)),
  };
}
