// send-outbox.ts — client-side send outbox for reliable operator→session
// input delivery.
//
// `api.sendKeys` is an HTTP POST: a failure while the request is in flight
// already surfaces as an error in the input bar, and the operator's text is
// preserved for manual retry. The silent-loss hole is the *offline* window —
// input submitted while the tab has no connectivity (mobile backgrounding,
// laptop sleep, network blip) fails and nothing ever resends it.
//
// The outbox closes that hole with strictly dup-free semantics:
// - A send attempted while `navigator.onLine === false` is recorded here,
//   un-transmitted. It provably never reached the transport, so resending it
//   on reconnect cannot duplicate — no server-side dedupe is needed.
// - A send that was actually dispatched is marked `transmitted` before the
//   fetch settles. If that fetch then fails, delivery is ambiguous (the
//   request may have reached the PTY), so it is deliberately NOT resent —
//   send-keys types into a live terminal and a duplicate is worse than a
//   drop. The failure surfaces to the operator exactly as before.
// - The queue is bounded; the oldest entry is evicted past the cap and
//   surfaced as failed so a perpetually-offline backlog can't grow unbounded.
//
// Flush triggers: the browser `online` event and the admin WebSocket
// reconnecting (both signal restored connectivity).

import { signal } from '@preact/signals';
import { api } from './api.js';
import { onAdminWsOpen } from './admin-ws.js';

export interface QueuedSend {
  id: number;
  sessionId: string;
  keys: string;
  enter: boolean;
  transmitted: boolean;
}

export const MAX_OUTBOX_ENTRIES = 50;

let idCounter = 0;
let entries: QueuedSend[] = [];

/** Reactive view of un-transmitted queued sends, for UI badges. */
export const queuedSends = signal<ReadonlyArray<QueuedSend>>([]);

/** Set when a queued send is evicted or fails terminally during a flush. */
export const outboxError = signal<string | null>(null);

function publish() {
  queuedSends.value = entries.filter((e) => !e.transmitted);
}

function record(sessionId: string, keys: string, enter: boolean): QueuedSend {
  const entry: QueuedSend = { id: ++idCounter, sessionId, keys, enter, transmitted: false };
  entries.push(entry);
  while (entries.length > MAX_OUTBOX_ENTRIES) {
    const dropped = entries.shift()!;
    if (!dropped.transmitted) {
      outboxError.value = `Dropped queued input (queue full): ${dropped.keys.slice(0, 60)}`;
    }
  }
  publish();
  return entry;
}

function resolve(id: number) {
  entries = entries.filter((e) => e.id !== id);
  publish();
}

export interface SendOutcome {
  ok: boolean;
  /** True when the input was queued for delivery on reconnect (not an error). */
  queued?: boolean;
  error?: string;
}

/**
 * Send keys to a session with offline queueing. Callers treat
 * `{ queued: true }` as "safe to clear the input" — the text is retained
 * here and flushes on reconnect, in submit order.
 */
export async function sendKeysReliable(
  sessionId: string,
  data: { keys: string; enter?: boolean },
): Promise<SendOutcome> {
  const entry = record(sessionId, data.keys, data.enter !== false);

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Provably never reached the transport — leave queued for the flush.
    return { ok: false, queued: true };
  }

  // Dispatched: delivery is now ambiguous on failure, so mark transmitted
  // first and never auto-resend (see module header).
  entry.transmitted = true;
  publish();
  try {
    const result = await api.sendKeys(sessionId, { keys: entry.keys, enter: entry.enter });
    resolve(entry.id);
    if (!result.ok) return { ok: false, error: result.error || 'send-keys failed' };
    return { ok: true };
  } catch (err: any) {
    resolve(entry.id);
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Cancel a queued (un-transmitted) send, e.g. from a UI badge. */
export function cancelQueuedSend(id: number) {
  entries = entries.filter((e) => e.id !== id || e.transmitted);
  publish();
}

let flushing = false;

/**
 * Flush un-transmitted entries in submit order. Each entry is marked
 * transmitted before dispatch — a flush that fails mid-flight leaves the
 * remaining (still un-transmitted) entries queued for the next trigger,
 * but never re-sends the one that was already handed to the transport.
 */
export async function flushOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const entry of entries.filter((e) => !e.transmitted)) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      entry.transmitted = true;
      publish();
      try {
        const result = await api.sendKeys(entry.sessionId, { keys: entry.keys, enter: entry.enter });
        if (!result.ok) outboxError.value = result.error || 'Queued input failed to send';
      } catch (err: any) {
        outboxError.value = err?.message || String(err);
      }
      resolve(entry.id);
    }
  } finally {
    flushing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { void flushOutbox(); });
  onAdminWsOpen(() => { void flushOutbox(); });
}
