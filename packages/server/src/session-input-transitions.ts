import type { InputState } from './session-input-state.js';

export interface InputStateProcess {
  inputState: InputState;
  waitingDebounce: ReturnType<typeof setTimeout> | null;
  lastStateBroadcast: number;
}

// Debounce delay before transitioning away from 'waiting' state.
// Claude Code briefly flashes spinner titles even while at a permission prompt,
// causing rapid waiting→active→waiting flicker on the UI status dots.
const WAITING_EXIT_DEBOUNCE_MS = 1500;

// Minimum interval between any state broadcasts to prevent rapid blinking.
// Real-time OSC detection can fire many times per second; throttle to ~2 updates/sec.
const STATE_BROADCAST_MIN_INTERVAL_MS = 500;

export function applyInputState(proc: InputStateProcess, newState: InputState, broadcast: (state: InputState) => void): void {
  if (newState === proc.inputState) {
    // Same state — cancel any pending debounce
    if (proc.waitingDebounce) { clearTimeout(proc.waitingDebounce); proc.waitingDebounce = null; }
    return;
  }
  // Transitioning away from 'waiting' — debounce to avoid flicker
  if (proc.inputState === 'waiting' && newState !== 'waiting') {
    if (!proc.waitingDebounce) {
      proc.waitingDebounce = setTimeout(() => {
        proc.waitingDebounce = null;
        // Re-check: if still not waiting after debounce, apply
        if (proc.inputState === 'waiting') {
          commitInputState(proc, newState, broadcast);
        }
      }, WAITING_EXIT_DEBOUNCE_MS);
    }
    return;
  }
  // Transitioning TO waiting (or between active/idle) — apply with throttle
  if (proc.waitingDebounce) { clearTimeout(proc.waitingDebounce); proc.waitingDebounce = null; }
  commitInputState(proc, newState, broadcast);
}

/** Actually update state + broadcast, but throttle to avoid flooding the client. */
function commitInputState(proc: InputStateProcess, newState: InputState, broadcast: (state: InputState) => void): void {
  const now = Date.now();
  const elapsed = now - (proc.lastStateBroadcast || 0);
  if (elapsed < STATE_BROADCAST_MIN_INTERVAL_MS) {
    // Schedule a deferred broadcast if not already pending
    if (!proc.waitingDebounce) {
      proc.waitingDebounce = setTimeout(() => {
        proc.waitingDebounce = null;
        // Apply whatever the latest desired state is at fire time
        if (proc.inputState !== newState) {
          proc.inputState = newState;
          proc.lastStateBroadcast = Date.now();
          broadcast(newState);
        }
      }, STATE_BROADCAST_MIN_INTERVAL_MS - elapsed);
    }
    return;
  }
  proc.inputState = newState;
  proc.lastStateBroadcast = now;
  broadcast(newState);
}

