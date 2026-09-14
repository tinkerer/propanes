// wake.ts — "the machine (or this tab) just came back" detection.
//
// A laptop that sleeps, a tab the browser froze, or a machine that boots with
// the page restored before Wi-Fi is up all leave open WebSockets in a state
// the page cannot distinguish from a healthy one: readyState is still OPEN
// because the TCP connection was never closed — it just stopped delivering.
// The browser only notices when its retransmit timer gives up, which is
// minutes away. Until then keystrokes are handed to a dead socket and vanish,
// which is the "I have to refresh before I can type into a session" bug.
//
// No single browser event means "you were away", so we fire on the union:
//   - visibilitychange → visible : tab switch, window unminimized
//   - window focus               : app switch / browser refocused
//   - online                     : network returned (covers a reboot whose
//                                  restored tabs load before Wi-Fi is up)
//   - clock gap                  : timers stopped ticking, i.e. the host was
//                                  suspended — the ONLY signal for a lid
//                                  close/open where the tab stayed visible
//                                  and focused the whole time
//
// Subscribers are expected to *verify* their connection (a cheap ping), not
// to blindly reconnect, so extra fires are harmless.

export type WakeReason = 'visible' | 'focus' | 'online' | 'clock-gap';

/** How often the clock-gap detector samples. */
const TICK_MS = 5_000;
/** A tick this late means the timer (and so the whole page) was suspended. */
const CLOCK_GAP_MS = 15_000;
/** A real wake fires several signals at once — report it as one event. */
const COALESCE_MS = 1_000;

const listeners = new Set<(reason: WakeReason) => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let lastFiredAt = 0;

function fire(reason: WakeReason): void {
  const now = Date.now();
  if (now - lastFiredAt < COALESCE_MS) return;
  lastFiredAt = now;
  // Copy: a subscriber may unsubscribe from inside its own callback.
  for (const cb of [...listeners]) {
    try { cb(reason); } catch { /* a bad subscriber must not stop the rest */ }
  }
}

function onVisibility(): void {
  if (!document.hidden) fire('visible');
}
function onFocus(): void { fire('focus'); }
function onOnline(): void { fire('online'); }

function onTick(): void {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  // Background tabs have their timers throttled to ~1/min, which looks exactly
  // like a suspend. That is fine: a hidden tab still wants a live socket (it
  // is receiving output), and verifying one is cheap.
  if (gap > CLOCK_GAP_MS) fire('clock-gap');
}

function start(): void {
  if (tickTimer || typeof window === 'undefined') return;
  lastTick = Date.now();
  tickTimer = setInterval(onTick, TICK_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
}

function stop(): void {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('online', onOnline);
}

/**
 * Subscribe to wake events. Returns an unsubscribe function; the underlying
 * listeners/timer exist only while at least one subscriber is registered.
 */
export function onWake(cb: (reason: WakeReason) => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stop();
  };
}

/** Test seam: forget the coalescing window and the last tick. */
export function __resetWakeForTests(): void {
  lastFiredAt = 0;
  lastTick = Date.now();
}
