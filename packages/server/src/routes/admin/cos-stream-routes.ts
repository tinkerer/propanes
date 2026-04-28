// Live SSE endpoints for the Chief-of-Staff chat:
//
//   GET /chief-of-staff/threads/:id/events  — per-thread live stream with
//        per-turn replay-buffer backfill (used by the chat sender to follow
//        a freshly-fired turn through to completion).
//   GET /chief-of-staff/agents/:agentId/stream — agent-scoped fan-out (used
//        by the bubble for idle-dashboard turn-status awareness; no replay).
//
// Both subscribe to the in-memory cos-event-bus and translate bus events
// into SSE frames. They do not directly drive any agent — POST /chat does
// that — they only consume the bus.

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import {
  getTurnFinalStatus,
  getTurnReplay,
  subscribeThreadEvents,
  subscribeAgentEvents,
} from './cos-event-bus.js';

export const cosStreamRoutes = new Hono();

// Per-thread live event stream. Replaces the old /attach endpoint and the
// SSE response body of POST /chat. POST /chat now returns 202 immediately;
// the client opens this stream to receive:
//
//   • claude_event — { turnId, seq, line } envelopes for the live in-flight
//                    turn (matches the wire format the previous SSE used).
//   • turn_status  — { kind: 'started'|'completed'|'failed', ...} events
//                    so the client can finalize the turn without polling.
//
// Pass ?fromSeq=N to backfill any claude_event with seq>N from the per-turn
// ring buffer before live events flow. The buffer is keyed by turnId and
// retained for ~30s past completion so a slow subscriber still gets the
// tail of the last turn. EventSource auto-reconnects on transient drops;
// the client just bumps fromSeq to its lastSeenSeq and re-subscribes.
cosStreamRoutes.get('/chief-of-staff/threads/:id/events', async (c) => {
  const threadId = c.req.param('id');
  const fromSeqRaw = c.req.query('fromSeq');
  const fromSeq = fromSeqRaw != null && !Number.isNaN(Number(fromSeqRaw)) ? Number(fromSeqRaw) : 0;
  // Optional: replay from this specific turn's buffer instead of the
  // thread's current in-flight turn. Used by the chat sender so a stop-path
  // synthetic turn (which never sets thread.turnRequestId) is still
  // replayable, and so a reconnecting subscriber pins to its own turn even
  // if a later turn has already started on the same thread.
  const replayTurnId = c.req.query('turnId') || null;

  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const enqueue = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      enqueue('hello', {
        threadId,
        at: Date.now(),
        currentTurnId: thread.turnRequestId || null,
        currentTurnStartSeq: thread.turnStartSeq ?? null,
        replayTurnId,
      });

      // Replay buffered claude events so a late subscriber (or a reconnect)
      // sees the gap between fromSeq and live. Prefer the explicit turnId
      // from the query string; fall back to the thread's current in-flight
      // turn for callers that didn't pin one (e.g. an idle dashboard).
      const turnIdToReplay = replayTurnId || thread.turnRequestId || null;
      if (turnIdToReplay) {
        const replay = getTurnReplay(turnIdToReplay, fromSeq);
        for (const ev of replay) enqueue('claude_event', ev);
      }

      // Replay the final turn_status if the requested turn has already
      // ended. The live bus only delivers turn_status once, so a subscriber
      // that joined post-completion (or one that reconnected after a brief
      // EventSource drop while turn_status fired) would otherwise sit
      // forever waiting and the optimistic assistant row would stay in
      // "thinking" state indefinitely.
      if (replayTurnId) {
        const finalStatus = getTurnFinalStatus(replayTurnId);
        if (finalStatus) {
          enqueue('turn_status', finalStatus);
        } else if (replayTurnId !== thread.turnRequestId) {
          // No buffered status but the turn isn't current either — either
          // the buffer was cleared (~30s after completion) or this turnId
          // never existed. Either way the requested turn is definitively
          // done from the server's perspective; synthesize a completed
          // event so the client can settle.
          enqueue('turn_status', {
            kind: 'completed',
            threadId,
            turnId: replayTurnId,
            exitCode: 0,
            cancelled: false,
          });
        }
      }

      const unsubscribe = subscribeThreadEvents(threadId, (ev) => {
        if (closed) { try { unsubscribe(); } catch { /* ignore */ } return; }
        if (ev.kind === 'claude_event') {
          // Already replayed; suppress events the client has already seen.
          if (ev.payload.seq > fromSeq) enqueue('claude_event', ev.payload);
        } else if (ev.kind === 'turn_status') enqueue('turn_status', ev.payload);
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`)); } catch { closed = true; }
      }, 25_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        try { unsubscribe(); } catch { /* ignore */ }
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      c.req.raw.signal.addEventListener('abort', cleanup);
    },
  });
  return c.body(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// Agent-scoped live SSE: forwards every event for any thread under this
// agent. Used by the bubble while it's open as a low-cost listener so an
// idle dashboard sees turn progress without opening a thread-specific
// stream. Per-turn replay is not supported here — a chat send always opens
// its own /threads/:id/events stream which covers the gap.
cosStreamRoutes.get('/chief-of-staff/agents/:agentId/stream', (c) => {
  const agentId = c.req.param('agentId');
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const enqueue = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      enqueue('hello', { agentId, at: Date.now() });
      const unsubscribe = subscribeAgentEvents(agentId, (ev) => {
        if (closed) { try { unsubscribe(); } catch { /* ignore */ } return; }
        if (ev.kind === 'claude_event') enqueue('claude_event', ev.payload);
        else if (ev.kind === 'turn_status') enqueue('turn_status', ev.payload);
      });
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ping\ndata: ${Date.now()}\n\n`)); } catch { closed = true; }
      }, 25_000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        try { unsubscribe(); } catch { /* ignore */ }
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      c.req.raw.signal.addEventListener('abort', cleanup);
    },
  });
  return c.body(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
