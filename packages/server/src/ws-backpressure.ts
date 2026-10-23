/**
 * Bounded WebSocket sends + a liveness sweep for every server-side socket.
 *
 * Why: a browser whose laptop slept, or an ingress proxy whose client side
 * went away, keeps its TCP connection to us half-alive. The peer reads
 * nothing, so every PTY frame we relay queues in Node's writable buffer —
 * ws.send() never fails, it just allocates. One such viewer accumulated
 * ~520 MB of unsent terminal output in the main server; the process then hit
 * V8's heap limit ("Reached heap limit Allocation failed"), and every request
 * behind the proxy answered 502 until systemd restarted it.
 *
 * Two guards, both cheap:
 *   - sendOrDrop(): refuse to enqueue once a socket already holds more than
 *     WS_MAX_BUFFERED_BYTES unsent, and terminate it instead. Every client
 *     (AgentTerminal, admin-ws, widget, launcher daemon) reconnects on an
 *     abnormal close and fetches a fresh snapshot, so dropping is safe.
 *   - startWsHealthSweep(): every WS_SWEEP_INTERVAL_MS ping each client of
 *     each WebSocketServer and terminate those that are over the cap even
 *     without new sends, or that have not answered WS_MAX_MISSED_PONGS pings
 *     in a row — a dead peer never closes on its own.
 */
import type { WebSocket, WebSocketServer } from 'ws';

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max bytes a single socket may hold unsent before it is dropped. */
export const WS_MAX_BUFFERED_BYTES = envInt('WS_MAX_BUFFERED_BYTES', 16 * 1024 * 1024);
/** How often the sweep pings clients and re-checks their backlog. */
export const WS_SWEEP_INTERVAL_MS = envInt('WS_SWEEP_INTERVAL_MS', 15_000);
/** Unanswered pings in a row before a client is considered dead. */
export const WS_MAX_MISSED_PONGS = envInt('WS_MAX_MISSED_PONGS', 3);

const OPEN = 1;

interface Liveness {
  missedPongs: number;
}

const liveness = new WeakMap<WebSocket, Liveness>();

function track(ws: WebSocket): Liveness {
  let state = liveness.get(ws);
  if (!state) {
    const fresh: Liveness = { missedPongs: 0 };
    liveness.set(ws, fresh);
    ws.on('pong', () => { fresh.missedPongs = 0; });
    state = fresh;
  }
  return state;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function overCap(ws: WebSocket): boolean {
  return ws.bufferedAmount > WS_MAX_BUFFERED_BYTES;
}

function dropSocket(ws: WebSocket, label: string, why: string): void {
  console.warn(`[ws] terminating ${label} client: ${why}`);
  try { ws.terminate(); } catch { /* already gone */ }
}

/**
 * Send unless the socket is already backed up past the cap (then terminate
 * it). Returns whether the data was queued.
 */
export function sendOrDrop(ws: WebSocket, data: string | Buffer, label: string): boolean {
  if (ws.readyState !== OPEN) return false;
  if (overCap(ws)) {
    dropSocket(ws, label, `${mb(ws.bufferedAmount)} unsent exceeds the ${mb(WS_MAX_BUFFERED_BYTES)} cap`);
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/** One sweep step for one socket. Exported for tests. */
export function sweepSocket(ws: WebSocket, label: string): void {
  if (ws.readyState !== OPEN) return;
  if (overCap(ws)) {
    dropSocket(ws, label, `${mb(ws.bufferedAmount)} unsent exceeds the ${mb(WS_MAX_BUFFERED_BYTES)} cap`);
    return;
  }
  const state = track(ws);
  if (state.missedPongs >= WS_MAX_MISSED_PONGS) {
    dropSocket(ws, label, `no pong for ${state.missedPongs} pings`);
    return;
  }
  state.missedPongs++;
  try { ws.ping(); } catch { /* socket is closing */ }
}

/**
 * Start the periodic sweep over every client of the given servers. Returns a
 * stop function. The timer is unref'd so it never keeps the process alive.
 */
export function startWsHealthSweep(
  servers: Array<{ label: string; wss: Pick<WebSocketServer, 'clients'> }>,
  intervalMs: number = WS_SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    for (const { label, wss } of servers) {
      for (const ws of wss.clients) sweepSocket(ws, label);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
