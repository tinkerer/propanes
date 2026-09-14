// session-recovery.ts — parking lot for viewers attached to a session whose
// PTY is not (yet) live.
//
// A session whose DB row says `running` and whose tmux session still exists,
// but which we could not reattach — the tmux server was still coming up after
// a host reboot, a fork failed under boot load — used to be accepted silently:
// the browser got the stored history, the pane looked healthy, and every
// keystroke went into a void because there was no PTY behind the socket. The
// only way out was reloading the page, because a reload retried the recovery.
//
// So park those sockets here instead and keep retrying. When recovery finally
// works, the waiting sockets are handed the live PTY where they stand.

/** `ws` WebSocket.OPEN. Duplicated so this module stays dependency-free. */
const WS_OPEN = 1;

export interface ParkedSocket {
  readyState: number;
}

export interface RecoveryParkingOptions<S extends ParkedSocket> {
  /** Attempt to make the session live. Return true once it is. */
  attemptRecovery: (sessionId: string) => boolean;
  /** Called once recovery succeeds, with the still-open sockets that waited. */
  onRecovered: (sessionId: string, sockets: S[]) => void;
  /** Delay between automatic retries. */
  retryMs?: number;
  /** Automatic retries before we stop trying on our own. */
  maxAttempts?: number;
  /**
   * Floor between two recovery attempts. Recovery shells out to tmux, so a
   * burst of keystrokes must not turn into a burst of subprocesses.
   */
  minGapMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
}

export interface RecoveryParking<S extends ParkedSocket> {
  /** Park a socket and start retrying recovery for its session. */
  park(sessionId: string, socket: S): void;
  /** Drop a socket (it closed); stops retrying when it was the last one. */
  release(sessionId: string, socket: S): void;
  isParked(sessionId: string): boolean;
  /** Retry right now — e.g. because someone just typed. True once live. */
  tryNow(sessionId: string): boolean;
  /** Sessions currently parked (diagnostics/tests). */
  parkedSessions(): string[];
  /** Stop every timer (shutdown). */
  clear(): void;
}

export function createRecoveryParking<S extends ParkedSocket>(
  opts: RecoveryParkingOptions<S>,
): RecoveryParking<S> {
  const retryMs = opts.retryMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 30;
  const minGapMs = opts.minGapMs ?? 1000;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  const parked = new Map<string, Set<S>>();
  const timers = new Map<string, any>();
  const lastAttemptAt = new Map<string, number>();

  function forget(sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer !== undefined) { clearTimer(timer); timers.delete(sessionId); }
    parked.delete(sessionId);
    lastAttemptAt.delete(sessionId);
  }

  function promote(sessionId: string): void {
    const waiting = parked.get(sessionId);
    const sockets = waiting ? [...waiting].filter((s) => s.readyState === WS_OPEN) : [];
    forget(sessionId);
    opts.onRecovered(sessionId, sockets);
  }

  function attempt(sessionId: string): boolean {
    const at = now();
    if (at - (lastAttemptAt.get(sessionId) ?? -Infinity) < minGapMs) return false;
    lastAttemptAt.set(sessionId, at);
    if (!opts.attemptRecovery(sessionId)) return false;
    promote(sessionId);
    return true;
  }

  function schedule(sessionId: string, attemptsSoFar: number): void {
    if (timers.has(sessionId)) return;
    // Out of automatic retries. The sockets stay parked rather than being cut
    // loose: a keystroke can still drive tryNow, and the session may yet come
    // back (tmux restarted, the host finished booting).
    if (attemptsSoFar >= maxAttempts) return;
    const handle = setTimer(() => {
      timers.delete(sessionId);
      const waiting = parked.get(sessionId);
      if (!waiting) return;
      for (const socket of waiting) {
        if (socket.readyState !== WS_OPEN) waiting.delete(socket);
      }
      if (waiting.size === 0) { forget(sessionId); return; }
      if (!attempt(sessionId)) schedule(sessionId, attemptsSoFar + 1);
    }, retryMs);
    timers.set(sessionId, handle);
  }

  return {
    park(sessionId, socket) {
      let set = parked.get(sessionId);
      if (!set) { set = new Set(); parked.set(sessionId, set); }
      set.add(socket);
      schedule(sessionId, 0);
    },
    release(sessionId, socket) {
      const set = parked.get(sessionId);
      if (!set) return;
      set.delete(socket);
      if (set.size === 0) forget(sessionId);
    },
    isParked(sessionId) {
      return parked.has(sessionId);
    },
    tryNow(sessionId) {
      if (!parked.has(sessionId)) return false;
      return attempt(sessionId);
    },
    parkedSessions() {
      return [...parked.keys()];
    },
    clear() {
      for (const sessionId of [...parked.keys()]) forget(sessionId);
    },
  };
}
