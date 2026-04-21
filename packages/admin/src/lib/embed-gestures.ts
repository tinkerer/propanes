/**
 * Two-finger pan + pinch-zoom relay.
 *
 * When the admin is embedded as a workbench popout (in the widget), iOS Safari
 * has no native way to move/zoom just the popout — pinch-zoom hits the host
 * page and one-finger drags scroll the iframe content. This module captures
 * touchstart/touchmove/touchend with 2 fingers, prevents default, and
 * postMessages centroid deltas + pinch ratios to the parent (widget) which
 * applies them to the panel.
 */

interface GestureState {
  active: boolean;
  startCentroidX: number;
  startCentroidY: number;
  startDist: number;
  lastCentroidX: number;
  lastCentroidY: number;
  lastDist: number;
}

function centroid(touches: TouchList): { x: number; y: number } {
  let x = 0, y = 0;
  for (let i = 0; i < touches.length; i++) {
    x += touches[i].clientX;
    y += touches[i].clientY;
  }
  return { x: x / touches.length, y: y / touches.length };
}

function distance(touches: TouchList): number {
  if (touches.length < 2) return 0;
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

export function initEmbedGestures() {
  if (window.parent === window) return; // not embedded
  const state: GestureState = {
    active: false,
    startCentroidX: 0,
    startCentroidY: 0,
    startDist: 0,
    lastCentroidX: 0,
    lastCentroidY: 0,
    lastDist: 0,
  };

  const post = (msg: any) => {
    try { window.parent.postMessage({ type: 'pw-embed-gesture', ...msg }, '*'); } catch { /* ignore */ }
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length < 2) return;
    e.preventDefault();
    const c = centroid(e.touches);
    const d = distance(e.touches);
    state.active = true;
    state.startCentroidX = state.lastCentroidX = c.x;
    state.startCentroidY = state.lastCentroidY = c.y;
    state.startDist = state.lastDist = d;
    post({ phase: 'start' });
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!state.active) return;
    if (e.touches.length < 2) return;
    e.preventDefault();
    const c = centroid(e.touches);
    const d = distance(e.touches);
    const dx = c.x - state.lastCentroidX;
    const dy = c.y - state.lastCentroidY;
    const scaleDelta = state.lastDist > 0 ? d / state.lastDist : 1;
    state.lastCentroidX = c.x;
    state.lastCentroidY = c.y;
    state.lastDist = d;
    post({ phase: 'move', dx, dy, scaleDelta });
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!state.active) return;
    if (e.touches.length >= 2) return;
    state.active = false;
    post({ phase: 'end' });
  };

  // Capture phase + non-passive so we can preventDefault the native pinch/pan.
  // touchstart/move must be non-passive for preventDefault to take effect.
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  window.addEventListener('touchstart', onTouchStart, opts);
  window.addEventListener('touchmove', onTouchMove, opts);
  window.addEventListener('touchend', onTouchEnd, opts);
  window.addEventListener('touchcancel', onTouchEnd, opts);

  // Block iOS Safari pinch-zoom of the page itself when embedded
  const blockGesture = (e: Event) => e.preventDefault();
  window.addEventListener('gesturestart', blockGesture, opts);
  window.addEventListener('gesturechange', blockGesture, opts);
  window.addEventListener('gestureend', blockGesture, opts);
}
