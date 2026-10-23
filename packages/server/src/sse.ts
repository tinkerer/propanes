// Shared Server-Sent Events response builder.
//
// Every SSE endpoint the admin opens is long-lived, and the edge in front of
// a public deployment (e.g. an Envoy Gateway HTTPRoute behind a CDN) commonly
// enforces an absolute per-request timeout — 120s in the deployment this was
// written against. When that fires mid-stream the proxy *resets* the stream
// instead of ending it, which
// the browser reports as a network failure — `net::ERR_QUIC_PROTOCOL_ERROR
// 200 (OK)` over HTTP/3, `ERR_HTTP2_PROTOCOL_ERROR` over h2 — and logs a red
// console line on every reconnect, forever.
//
// EventSource reconnects either way, but a stream the *server* ends cleanly
// reconnects silently: the response completes normally, so there is nothing
// for the network layer to complain about. So instead of holding a stream
// open until something upstream kills it, every stream built here is
// recycled by the server shortly before the edge would cut it, and carries a
// `retry:` hint so the browser comes straight back. Consumers must therefore
// tolerate a reconnect every `maxLifetimeMs` (replay from a cursor, or
// refetch on `open`).

import type { Context } from 'hono';

/** Recycle streams well under the 120s edge request timeout. */
export const DEFAULT_SSE_MAX_LIFETIME_MS = 90_000;
/** Comment frames keep Cloudflare's ~100s no-data timer from firing. */
export const DEFAULT_SSE_KEEPALIVE_MS = 25_000;
/** Reconnect delay advertised to the browser (`retry:` field). */
export const DEFAULT_SSE_RETRY_MS = 1_000;

/**
 * Max stream lifetime, overridable with SSE_MAX_LIFETIME_MS. `0` disables
 * recycling (useful on deployments with no proxy timeout in the path).
 */
export function sseMaxLifetimeMs(): number {
  const raw = (process.env.SSE_MAX_LIFETIME_MS ?? '').trim();
  if (raw === '') return DEFAULT_SSE_MAX_LIFETIME_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SSE_MAX_LIFETIME_MS;
}

export interface SseSink {
  /** Emit a named event with a JSON-serialised payload. No-op once closed. */
  send(event: string, data: unknown): void;
  /** Emit a comment frame (`: text`). Never dispatched to the client's listeners. */
  comment(text: string): void;
  /** End the stream cleanly; runs the setup's cleanup exactly once. */
  close(): void;
  readonly closed: boolean;
}

export interface SseOptions {
  /** Recycle the stream after this long; 0 = never. Defaults to {@link sseMaxLifetimeMs}. */
  maxLifetimeMs?: number;
  /** Keepalive comment interval; 0 = none. */
  keepaliveMs?: number;
  /** `retry:` hint sent as the first frame. */
  retryMs?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

export type SseSetup = (sink: SseSink) => void | (() => void);

/**
 * Build a `text/event-stream` response. `setup` runs once the stream is open
 * and may return a cleanup callback; cleanup runs exactly once, whichever
 * comes first: the client going away, the lifetime timer, or `sink.close()`.
 */
export function sseResponse(c: Context, setup: SseSetup, opts: SseOptions = {}): Response {
  const maxLifetimeMs = opts.maxLifetimeMs ?? sseMaxLifetimeMs();
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_SSE_KEEPALIVE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_SSE_RETRY_MS;
  const encoder = new TextEncoder();

  let sink: SseSink | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cleanup: (() => void) | undefined;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;

      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Consumer already gone; finish tearing down.
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        if (lifetime) clearTimeout(lifetime);
        c.req.raw.signal.removeEventListener('abort', close);
        try { cleanup?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* already closed */ }
      };

      sink = {
        send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        comment: (text) => write(`: ${text}\n\n`),
        close,
        get closed() { return closed; },
      };

      write(`retry: ${retryMs}\n\n`);
      if (keepaliveMs > 0) keepalive = setInterval(() => sink?.comment('keepalive'), keepaliveMs);
      if (maxLifetimeMs > 0) lifetime = setTimeout(close, maxLifetimeMs);
      if (c.req.raw.signal.aborted) {
        close();
        return;
      }
      c.req.raw.signal.addEventListener('abort', close);

      const ret = setup(sink);
      if (typeof ret === 'function') cleanup = ret;
      // setup may have closed synchronously before cleanup was registered.
      if (closed) { try { cleanup?.(); } catch { /* ignore */ } cleanup = undefined; }
    },
    cancel() {
      sink?.close();
    },
  });

  return c.body(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...opts.headers,
    },
  });
}
