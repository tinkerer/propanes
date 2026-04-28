// Detects a "shake" mouse gesture (rapid horizontal back-and-forth) and
// fires a callback. Used to trigger a screenshot without the user having to
// open the widget and click the camera button.
//
// Tuning rationale: the gesture must be uncommon enough not to false-trigger
// during normal use (selection, drag, scroll), but quick enough that it feels
// like a flick rather than a deliberate drawing. Three direction reversals
// inside 800 ms, with each leg covering at least MIN_LEG_PX, hits that mark.

export interface ShakeOptions {
  windowMs?: number;
  minLegPx?: number;
  minTotalPx?: number;
  minReversals?: number;
  cooldownMs?: number;
}

interface Sample { x: number; y: number; t: number }

export function installShakeGesture(
  onShake: (origin: { x: number; y: number }) => void,
  opts: ShakeOptions = {},
): () => void {
  const windowMs = opts.windowMs ?? 800;
  const minLegPx = opts.minLegPx ?? 40;
  const minTotalPx = opts.minTotalPx ?? 200;
  const minReversals = opts.minReversals ?? 3;
  const cooldownMs = opts.cooldownMs ?? 2000;

  const samples: Sample[] = [];
  let lastFireAt = 0;

  function onMove(e: MouseEvent) {
    // Ignore synthetic events dispatched by the agent-driven cursor — only
    // real human motion should trigger a screenshot.
    if (!e.isTrusted) return;
    const now = performance.now();
    samples.push({ x: e.clientX, y: e.clientY, t: now });

    // Drop samples outside the detection window
    const cutoff = now - windowMs;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();

    if (now - lastFireAt < cooldownMs) return;
    if (samples.length < 4) return;

    // Walk the samples and count direction reversals on the X axis.
    // A reversal is counted only when the current "leg" exceeds minLegPx,
    // which filters out jitter from a steady drag.
    let reversals = 0;
    let total = 0;
    let legStart = samples[0].x;
    let dir = 0;

    for (let i = 1; i < samples.length; i++) {
      const dx = samples[i].x - samples[i - 1].x;
      total += Math.abs(dx);
      if (dx === 0) continue;
      const newDir = dx > 0 ? 1 : -1;
      if (dir === 0) {
        dir = newDir;
        continue;
      }
      if (newDir !== dir) {
        const leg = Math.abs(samples[i - 1].x - legStart);
        if (leg >= minLegPx) {
          reversals++;
          legStart = samples[i - 1].x;
          dir = newDir;
        }
      }
    }

    if (reversals >= minReversals && total >= minTotalPx) {
      lastFireAt = now;
      samples.length = 0;
      const last = { x: e.clientX, y: e.clientY };
      onShake(last);
    }
  }

  document.addEventListener('mousemove', onMove, { passive: true });
  return () => document.removeEventListener('mousemove', onMove);
}
