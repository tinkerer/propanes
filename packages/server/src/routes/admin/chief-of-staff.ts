import { Hono } from 'hono';
import { eq, desc, and, inArray, like, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';
import {
  spawnSessionRemote,
  killSessionRemote,
  getSessionStatus,
} from '../../session-service-client.js';
import {
  type Verbosity,
  type ReplyStyle,
  DEFAULT_SYSTEM_PROMPT,
  COORDINATION_INSTRUCTIONS,
  structuredReplyInstructions,
  buildThreadSystemPrompt,
} from './cos-system-prompts.js';
import {
  type CosClaudeEvent,
  type CosTurnStatus,
  type CosBusEvent,
  appendTurnReplay,
  clearTurnReplay,
  recordTurnFinalStatus,
  getTurnFinalStatus,
  getTurnReplay,
  subscribeThreadEvents,
  subscribeAgentEvents,
  publishBusEvent,
} from './cos-event-bus.js';
import {
  type ActiveSession,
  activeSessions,
  inFlightByThread,
  killProc,
  serializeSession,
  releaseAllLocks,
  cosLocksRoutes,
} from './cos-locks.js';
import {
  runCosTurnConsumer,
  recoverInFlightTurns,
} from './cos-turn-consumer.js';

export const chiefOfStaffRoutes = new Hono();
chiefOfStaffRoutes.route('/', cosLocksRoutes);


function resolveRepoRoot(): string {
  const envDir = process.env.CHIEF_OF_STAFF_CWD;
  if (envDir && existsSync(envDir)) return pathResolve(envDir);
  // Default: assume server runs from packages/server; repo root is two levels up.
  const guess = pathResolve(process.cwd(), '..', '..');
  if (existsSync(pathResolve(guess, 'CLAUDE.md'))) return guess;
  return pathResolve(process.cwd());
}



// ────────────────────────────────────────────────────────────────────────────
// Thread CRUD routes
// ────────────────────────────────────────────────────────────────────────────

// Operator's compose-textarea draft, scoped per (agentId, appId, threadId).
// threadId='' is the "new top-level thread" compose draft; non-empty values
// are reply-in-thread drafts. The listing returns every scope so the UI can
// light tab indicators (any draft in any scope == "agent has unsent text").
// Empty bodies delete the row, so a missing entry == "no draft here".
chiefOfStaffRoutes.get('/chief-of-staff/drafts', async (c) => {
  const agentId = c.req.query('agentId');
  const appId = c.req.query('appId') ?? '';
  const conditions = [eq(schema.cosDrafts.appId, appId)];
  if (agentId) conditions.push(eq(schema.cosDrafts.agentId, agentId));
  const rows = await db
    .select()
    .from(schema.cosDrafts)
    .where(and(...conditions));
  return c.json({ drafts: rows });
});

chiefOfStaffRoutes.put('/chief-of-staff/drafts', async (c) => {
  let body: { agentId?: string; appId?: string | null; threadId?: string | null; text?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const agentId = (body.agentId || '').trim();
  if (!agentId) return c.json({ error: 'agentId is required' }, 400);
  const appId = body.appId == null ? '' : String(body.appId);
  const threadId = body.threadId == null ? '' : String(body.threadId);
  const text = typeof body.text === 'string' ? body.text : '';
  const now = Date.now();
  const scope = and(
    eq(schema.cosDrafts.agentId, agentId),
    eq(schema.cosDrafts.appId, appId),
    eq(schema.cosDrafts.threadId, threadId),
  );

  if (text.length === 0) {
    await db.delete(schema.cosDrafts).where(scope);
    return c.json({ ok: true, cleared: true });
  }

  const existing = await db.select().from(schema.cosDrafts).where(scope).limit(1);
  if (existing.length > 0) {
    await db.update(schema.cosDrafts).set({ text, updatedAt: now }).where(scope);
  } else {
    await db.insert(schema.cosDrafts).values({
      id: ulid(),
      agentId,
      appId,
      threadId,
      text,
      updatedAt: now,
    });
  }
  return c.json({ ok: true, agentId, appId, threadId, text, updatedAt: now });
});

// Left-join the linked agent session so callers can derive per-thread health
// (running / idle / completed / failed / killed / null=gc'd) without a second
// round trip. Wrapped in a helper because both /threads and /history return
// the same shape.
async function fetchThreadsWithSessionStatus(
  conditions: ReturnType<typeof eq>[],
  limit?: number,
) {
  const baseQuery = db
    .select({
      id: schema.cosThreads.id,
      agentId: schema.cosThreads.agentId,
      appId: schema.cosThreads.appId,
      name: schema.cosThreads.name,
      systemPrompt: schema.cosThreads.systemPrompt,
      model: schema.cosThreads.model,
      claudeSessionId: schema.cosThreads.claudeSessionId,
      agentSessionId: schema.cosThreads.agentSessionId,
      turnStartedAt: schema.cosThreads.turnStartedAt,
      turnStartSeq: schema.cosThreads.turnStartSeq,
      turnUserText: schema.cosThreads.turnUserText,
      turnRequestId: schema.cosThreads.turnRequestId,
      resolvedAt: schema.cosThreads.resolvedAt,
      archivedAt: schema.cosThreads.archivedAt,
      createdAt: schema.cosThreads.createdAt,
      updatedAt: schema.cosThreads.updatedAt,
      sessionStatus: schema.agentSessions.status,
      sessionExitCode: schema.agentSessions.exitCode,
    })
    .from(schema.cosThreads)
    .leftJoin(
      schema.agentSessions,
      eq(schema.cosThreads.agentSessionId, schema.agentSessions.id),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.cosThreads.updatedAt));
  return limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;
}

chiefOfStaffRoutes.get('/chief-of-staff/threads', async (c) => {
  const agentId = c.req.query('agentId');
  const appId = c.req.query('appId');

  const conditions = [];
  if (agentId) conditions.push(eq(schema.cosThreads.agentId, agentId));
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));

  const rows = await fetchThreadsWithSessionStatus(conditions, 100);
  return c.json({ threads: rows });
});

// Toggle the per-thread "resolved" / "archived" flags. Used by the rail's
// inline resolve/archive actions so operators can clear failed/idle threads
// from triage without deleting them. Both flags can be set independently in
// one PATCH; empty body is treated as { resolved: true } for backward compat.
chiefOfStaffRoutes.patch('/chief-of-staff/threads/:id', async (c) => {
  const id = c.req.param('id');
  let body: { resolved?: boolean; archived?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body = treat as resolve */
  }
  const now = Date.now();
  const updates: Partial<typeof schema.cosThreads.$inferInsert> = { updatedAt: now };
  if ('resolved' in body) {
    updates.resolvedAt = body.resolved === false ? null : now;
  } else if (!('archived' in body)) {
    // Empty body / legacy callers — preserve old default of "resolve".
    updates.resolvedAt = now;
  }
  if ('archived' in body) {
    updates.archivedAt = body.archived === false ? null : now;
    // Archiving implicitly resolves so the thread also disappears from the
    // resolved-only view; unarchiving leaves resolvedAt untouched so a
    // previously-resolved thread stays resolved.
    if (body.archived !== false && !('resolved' in body)) {
      updates.resolvedAt = now;
    }
  }
  await db
    .update(schema.cosThreads)
    .set(updates)
    .where(eq(schema.cosThreads.id, id));
  const [row] = await db
    .select({ resolvedAt: schema.cosThreads.resolvedAt, archivedAt: schema.cosThreads.archivedAt })
    .from(schema.cosThreads)
    .where(eq(schema.cosThreads.id, id))
    .limit(1);
  return c.json({ ok: true, id, resolvedAt: row?.resolvedAt ?? null, archivedAt: row?.archivedAt ?? null });
});

// Every CoS thread has exactly one persistent headless-stream agent session.
// Provision it if missing (e.g. a thread created before the auto-provision
// migration). Returns the agentSessionId that's now linked to the thread.
async function ensureAgentSessionForThread(
  thread: typeof schema.cosThreads.$inferSelect,
): Promise<string> {
  if (thread.agentSessionId) return thread.agentSessionId;
  const agentSessionId = ulid();
  const nowIso = new Date().toISOString();
  await db.insert(schema.agentSessions).values({
    id: agentSessionId,
    cosThreadId: thread.id,
    runtime: 'claude',
    permissionProfile: 'headless-stream-yolo',
    status: 'idle',
    outputBytes: 0,
    title: thread.name,
    cwd: resolveRepoRoot(),
    createdAt: nowIso,
    startedAt: nowIso,
    lastActivityAt: nowIso,
  });
  await db.update(schema.cosThreads)
    .set({ agentSessionId })
    .where(eq(schema.cosThreads.id, thread.id));
  return agentSessionId;
}

chiefOfStaffRoutes.post('/chief-of-staff/threads', async (c) => {
  let body: { agentId?: string; appId?: string; name?: string; systemPrompt?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const agentId = (body.agentId || '').trim();
  const name = (body.name || '').trim();
  if (!agentId || !name) return c.json({ error: 'agentId and name are required' }, 400);

  const now = Date.now();
  const id = ulid();
  const agentSessionId = ulid();
  const nowIso = new Date(now).toISOString();

  const thread = {
    id,
    agentId,
    appId: body.appId || null,
    name,
    systemPrompt: body.systemPrompt || null,
    model: body.model || null,
    agentSessionId,
    createdAt: now,
    updatedAt: now,
  };

  const cwd = resolveRepoRoot();
  await db.insert(schema.cosThreads).values(thread);
  await db.insert(schema.agentSessions).values({
    id: agentSessionId,
    cosThreadId: id,
    runtime: 'claude',
    permissionProfile: 'headless-stream-yolo',
    status: 'idle',
    outputBytes: 0,
    title: name,
    cwd,
    createdAt: nowIso,
    startedAt: nowIso,
    lastActivityAt: nowIso,
  });

  return c.json(thread);
});


chiefOfStaffRoutes.delete('/chief-of-staff/threads/:id', async (c) => {
  const id = c.req.param('id');
  // Cascade deletes messages due to FK
  await db.delete(schema.cosThreads).where(eq(schema.cosThreads.id, id));
  return c.json({ ok: true });
});

chiefOfStaffRoutes.get('/chief-of-staff/threads/:id/messages', async (c) => {
  const threadId = c.req.param('id');
  const messages = await db
    .select()
    .from(schema.cosMessages)
    .where(eq(schema.cosMessages.threadId, threadId))
    .orderBy(schema.cosMessages.createdAt);
  return c.json({ messages });
});

// Full-text search across CoS messages. Used by the global cmd-K spotlight
// and the per-agent toolbar search button. Returns message rows joined with
// their thread (so callers can resolve agentId/appId/thread name without a
// second round-trip). Match is a case-insensitive LIKE on cosMessages.text.
chiefOfStaffRoutes.get('/chief-of-staff/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ results: [] });
  const agentId = c.req.query('agentId');
  const appId = c.req.query('appId');
  const role = c.req.query('role'); // 'user' | 'assistant' | 'system' | undefined
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);

  const needle = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const conditions = [sql`LOWER(${schema.cosMessages.text}) LIKE LOWER(${needle}) ESCAPE '\\'`];
  if (agentId) conditions.push(eq(schema.cosThreads.agentId, agentId));
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));
  if (role) conditions.push(eq(schema.cosMessages.role, role));

  const rows = await db
    .select({
      messageId: schema.cosMessages.id,
      threadId: schema.cosMessages.threadId,
      role: schema.cosMessages.role,
      text: schema.cosMessages.text,
      createdAt: schema.cosMessages.createdAt,
      agentId: schema.cosThreads.agentId,
      appId: schema.cosThreads.appId,
      threadName: schema.cosThreads.name,
    })
    .from(schema.cosMessages)
    .innerJoin(schema.cosThreads, eq(schema.cosMessages.threadId, schema.cosThreads.id))
    .where(and(...conditions))
    .orderBy(desc(schema.cosMessages.createdAt))
    .limit(limit);

  const lowerQ = q.toLowerCase();
  const results = rows.map((r) => {
    const text = r.text || '';
    const idx = text.toLowerCase().indexOf(lowerQ);
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + q.length + 80);
    const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    return { ...r, snippet };
  });

  return c.json({ results });
});

// History lookup keyed by agentId — returns ALL threads for the agent and the
// interleaved message log across them. Client uses this on startup to
// rehydrate CoS conversation state without depending on localStorage. Each
// message carries its threadId so the client can route replies back to the
// right server-side thread (== its own Claude session).
chiefOfStaffRoutes.get('/chief-of-staff/history/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const appId = c.req.query('appId');

  const conditions = [eq(schema.cosThreads.agentId, agentId)];
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));

  const threads = await fetchThreadsWithSessionStatus(conditions);

  if (threads.length === 0) {
    return c.json({ threads: [], thread: null, messages: [] });
  }

  const threadIds = threads.map((t) => t.id);
  const messages = await db
    .select()
    .from(schema.cosMessages)
    .where(inArray(schema.cosMessages.threadId, threadIds))
    .orderBy(schema.cosMessages.createdAt);

  // `thread` retained for backward-compat — points at the most-recently
  // updated thread. New clients read `threads` + per-message threadId.
  return c.json({ threads, thread: threads[0], messages });
});

// ────────────────────────────────────────────────────────────────────────────
// Dispatch index — derives "which CoS thread launched which session/feedback"
// by parsing tool_calls_json on persisted CoS messages. The Sessions sidebar
// uses this to nest CoS-dispatched agent sessions under their originating
// thread. Mirrors extractDispatchInfo() in packages/admin/src/lib/chief-of-staff.ts.
// ────────────────────────────────────────────────────────────────────────────

type DispatchToolCall = {
  id?: string;
  name?: string;
  input?: { command?: unknown };
  result?: unknown;
  error?: unknown;
};

function parseDispatchToolCall(call: DispatchToolCall): { feedbackId: string; sessionId: string | null } | null {
  if (call.error) return null;
  if (call.name !== 'Bash') return null;
  const cmd = typeof call.input?.command === 'string' ? call.input.command : '';
  if (!cmd) return null;
  if (!/-X\s+POST/i.test(cmd)) return null;

  let feedbackId: string | null = null;
  const pathMatch = cmd.match(/\/api\/v1\/admin\/feedback\/([A-Z0-9]{20,})\/dispatch/i);
  if (pathMatch) {
    feedbackId = pathMatch[1];
  } else {
    if (!/\/api\/v1\/admin\/dispatch\b/.test(cmd)) return null;
    const bodyMatch = cmd.match(/["']feedbackId["']\s*:\s*["']([A-Z0-9]{20,})["']/i);
    if (!bodyMatch) return null;
    feedbackId = bodyMatch[1];
  }

  let sessionId: string | null = null;
  const res = call.result;
  if (typeof res === 'string' && res.trim()) {
    const m = res.match(/["']sessionId["']\s*:\s*["']([A-Za-z0-9-]+)["']/);
    if (m) sessionId = m[1];
  } else if (res && typeof res === 'object' && typeof (res as { sessionId?: unknown }).sessionId === 'string') {
    sessionId = (res as { sessionId: string }).sessionId;
  }

  return { feedbackId, sessionId };
}

chiefOfStaffRoutes.get('/chief-of-staff/dispatches', async (c) => {
  const rows = await db
    .select({
      messageId: schema.cosMessages.id,
      threadId: schema.cosMessages.threadId,
      toolCallsJson: schema.cosMessages.toolCallsJson,
      createdAt: schema.cosMessages.createdAt,
      threadName: schema.cosThreads.name,
      threadAgentId: schema.cosThreads.agentId,
      threadAppId: schema.cosThreads.appId,
    })
    .from(schema.cosMessages)
    .innerJoin(schema.cosThreads, eq(schema.cosMessages.threadId, schema.cosThreads.id))
    .orderBy(desc(schema.cosMessages.createdAt))
    .limit(2000);

  const dispatches: Array<{
    sessionId: string | null;
    feedbackId: string;
    cosThreadId: string;
    cosThreadName: string;
    cosAgentId: string;
    cosAppId: string | null;
    cosMessageId: string;
    createdAt: number;
  }> = [];

  for (const row of rows) {
    if (!row.toolCallsJson) continue;
    let calls: unknown;
    try { calls = JSON.parse(row.toolCallsJson); } catch { continue; }
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const info = parseDispatchToolCall(call as DispatchToolCall);
      if (!info) continue;
      dispatches.push({
        sessionId: info.sessionId,
        feedbackId: info.feedbackId,
        cosThreadId: row.threadId,
        cosThreadName: row.threadName,
        cosAgentId: row.threadAgentId,
        cosAppId: row.threadAppId,
        cosMessageId: row.messageId,
        createdAt: row.createdAt,
      });
    }
  }

  return c.json({ dispatches });
});

// ────────────────────────────────────────────────────────────────────────────
// Interrupt route
// ────────────────────────────────────────────────────────────────────────────

chiefOfStaffRoutes.post('/chief-of-staff/threads/:id/interrupt', async (c) => {
  const threadId = c.req.param('id');
  let interrupted = false;

  // Legacy spawn path: a real claude proc tracked by threadId.
  const entry = inFlightByThread.get(threadId);
  if (entry) {
    killProc(entry);
    inFlightByThread.delete(threadId);
    interrupted = true;
  }

  // Persistent headless-stream path: the in-flight turn is owned by
  // session-service. Killing the underlying agent session ends the current
  // turn; the next user message respawns and resumes via claudeSessionId.
  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (thread?.agentSessionId) {
    const killed = await killSessionRemote(thread.agentSessionId).catch(() => false);
    if (killed) {
      db.update(schema.cosThreads)
        .set({ turnStartedAt: null, turnStartSeq: null, turnUserText: null, turnRequestId: null })
        .where(eq(schema.cosThreads.id, threadId))
        .run();
      interrupted = true;
    }
  }

  return c.json({ ok: true, interrupted });
});

// ────────────────────────────────────────────────────────────────────────────
// Status / live event routes
// ────────────────────────────────────────────────────────────────────────────

// Query thread status without invoking the LLM. Answers "is the bot working?"
// and, when the turn is running through the session-service (persistent-
// stream path), "what seq should I re-attach from if my SSE dropped?".
chiefOfStaffRoutes.get('/chief-of-staff/threads/:id/status', async (c) => {
  const threadId = c.req.param('id');
  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const live = thread.agentSessionId
    ? await getSessionStatus(thread.agentSessionId).catch(() => null)
    : null;
  const inFlight = thread.turnStartedAt != null;
  // A re-attach is possible when the session-service is still holding the
  // output buffer for this turn. For the direct-spawn (non-persistent) path
  // turnStartSeq is null — the turn is observable but not re-attachable.
  const resumable = inFlight && thread.turnStartSeq != null && live?.active === true;

  return c.json({
    threadId,
    inFlight,
    resumable,
    turnStartedAt: thread.turnStartedAt,
    turnStartSeq: thread.turnStartSeq,
    turnUserText: thread.turnUserText,
    turnRequestId: thread.turnRequestId,
    agentSessionId: thread.agentSessionId,
    agentSessionStatus: live?.status ?? null,
    agentSessionActive: live?.active ?? null,
    currentOutputSeq: live?.outputSeq ?? null,
    updatedAt: thread.updatedAt,
    serverTime: Date.now(),
  });
});

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
chiefOfStaffRoutes.get('/chief-of-staff/threads/:id/events', async (c) => {
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
chiefOfStaffRoutes.get('/chief-of-staff/agents/:agentId/stream', (c) => {
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

// ────────────────────────────────────────────────────────────────────────────
// Chat route
// ────────────────────────────────────────────────────────────────────────────

type CosImageAttachment = {
  kind: 'image';
  dataUrl: string;
  name?: string;
};

type CosElementRef = {
  selector: string;
  tagName: string;
  id?: string;
  classes?: string[];
  textContent?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
};

function writeImageAttachmentsToTmp(
  attachments: CosImageAttachment[],
): Array<{ absPath: string; name: string }> {
  if (!attachments.length) return [];
  const dir = pathJoin(tmpdir(), `cos-attach-${ulid()}`);
  mkdirSync(dir, { recursive: true });
  const out: Array<{ absPath: string; name: string }> = [];
  attachments.forEach((att, i) => {
    if (att.kind !== 'image' || typeof att.dataUrl !== 'string') return;
    const m = /^data:([^;,]+);base64,(.*)$/i.exec(att.dataUrl);
    if (!m) return;
    const mime = m[1].toLowerCase();
    const ext =
      mime === 'image/png' ? 'png' :
      mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' :
      mime === 'image/gif' ? 'gif' :
      mime === 'image/webp' ? 'webp' :
      'png';
    const filename = (att.name && /^[\w.\-]+$/.test(att.name)) ? att.name : `image-${i + 1}.${ext}`;
    const absPath = pathJoin(dir, filename);
    writeFileSync(absPath, Buffer.from(m[2], 'base64'));
    out.push({ absPath, name: filename });
  });
  return out;
}

function renderElementRefsBlock(refs: CosElementRef[]): string {
  if (!refs.length) return '';
  const lines = refs.map((r, i) => {
    const parts: string[] = [`[${i + 1}] <${r.tagName || 'element'}>`];
    if (r.id) parts.push(`#${r.id}`);
    if (r.classes && r.classes.length) parts.push(`.${r.classes.slice(0, 3).join('.')}`);
    if (r.selector) parts.push(`selector=${JSON.stringify(r.selector)}`);
    if (r.boundingRect) {
      const br = r.boundingRect;
      parts.push(`rect={x:${Math.round(br.x)},y:${Math.round(br.y)},w:${Math.round(br.width)},h:${Math.round(br.height)}}`);
    }
    if (r.textContent) {
      const t = r.textContent.trim().slice(0, 120);
      if (t) parts.push(`text=${JSON.stringify(t)}`);
    }
    return parts.join(' ');
  });
  return `Selected DOM elements (from the operator's browser):\n${lines.join('\n')}`;
}

chiefOfStaffRoutes.post('/chief-of-staff/chat', async (c) => {
  let body: {
    text?: string;
    systemPrompt?: string;
    appId?: string;
    model?: string;
    threadId?: string;
    verbosity?: Verbosity;
    style?: ReplyStyle;
    messages?: Array<{ role: string; text?: string }>;
    attachments?: CosImageAttachment[];
    elementRefs?: CosElementRef[];
    replyToTs?: number;
    clientTs?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Back-compat: earlier client versions sent {messages:[{role,text},...]}
  // instead of {text}. Pick up the last user message from either shape.
  let text = (body.text || '').trim();
  if (!text && Array.isArray(body.messages) && body.messages.length > 0) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m?.role === 'user' && typeof m.text === 'string' && m.text.trim()) {
        text = m.text.trim();
        break;
      }
    }
  }
  if (!text) return c.json({ error: 'text is required (reload the admin page to pick up the latest client)' }, 400);

  const cwd = resolveRepoRoot();

  // Every chat turn belongs to a thread. The client always creates one via
  // POST /chief-of-staff/threads before sending, which also provisions the
  // persistent headless-stream agent session for that thread.
  if (!body.threadId) return c.json({ error: 'threadId is required' }, 400);
  let thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, body.threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  // Pre-migration threads may not yet have an agentSessionId — provision one
  // now so the persistent-stream path below always has a session to drive.
  if (!thread.agentSessionId) {
    await ensureAgentSessionForThread(thread);
    thread = await db.query.cosThreads.findFirst({
      where: eq(schema.cosThreads.id, body.threadId),
    });
    if (!thread?.agentSessionId) {
      return c.json({ error: 'Failed to provision CoS agent session' }, 500);
    }
  }

  // Stop keyword: if the operator sent just "stop"/"halt"/"cancel"/"kill",
  // interrupt the in-flight claude proc for this thread and return a short
  // SSE stream with a "Stopped." reply. No new turn is fired.
  const STOP_RE = /^\s*(stop|halt|cancel|kill)\s*\.?\s*$/i;
  if (body.threadId && thread && STOP_RE.test(text)) {
    const existing = inFlightByThread.get(body.threadId);
    const wasRunning = !!existing;
    if (existing) {
      killProc(existing);
      inFlightByThread.delete(body.threadId);
    }
    const now = Date.now();
    const userTs = typeof body.clientTs === 'number' ? body.clientTs : now;
    db.insert(schema.cosMessages).values({
      id: ulid(),
      threadId: thread.id,
      role: 'user',
      text,
      toolCallsJson: null,
      attachmentsJson: null,
      createdAt: userTs,
    }).catch(() => { /* non-fatal */ });
    const ackText = wasRunning ? 'Stopped.' : 'Nothing running.';
    db.insert(schema.cosMessages).values({
      id: ulid(),
      threadId: thread.id,
      role: 'assistant',
      text: `<cos-reply>${ackText}</cos-reply>`,
      toolCallsJson: null,
      attachmentsJson: null,
      createdAt: userTs + 1,
    }).catch(() => { /* non-fatal */ });
    db.update(schema.cosThreads)
      .set({ updatedAt: now })
      .where(eq(schema.cosThreads.id, thread.id))
      .catch(() => { /* non-fatal */ });

    // Synthetic "stop" turn: no agent run, but emit the same shape of events
    // a normal turn would so the client can finalize its optimistic row via
    // its /threads/:id/events subscription. Stage to the replay buffer
    // immediately (so a subscriber that connects after the 202 will replay
    // it), then publish live after a short delay so the EventSource has
    // time to open + register listeners.
    const stopTurnId = randomUUID();
    const stopEvent: CosClaudeEvent = {
      threadId: thread.id,
      turnId: stopTurnId,
      seq: 1,
      line: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `<cos-reply>${ackText}</cos-reply>` }] },
      }),
    };
    appendTurnReplay(stopEvent);
    setTimeout(() => {
      publishBusEvent(thread!.id, { kind: 'claude_event', payload: stopEvent }, thread!.agentId);
      const stopStatus: CosTurnStatus = {
        kind: 'completed', threadId: thread!.id, turnId: stopTurnId, exitCode: 0, cancelled: false,
      };
      recordTurnFinalStatus(stopStatus);
      publishBusEvent(thread!.id, { kind: 'turn_status', payload: stopStatus }, thread!.agentId);
      setTimeout(() => clearTurnReplay(stopTurnId), 30_000);
    }, 100);

    return c.json({
      turnId: stopTurnId,
      threadId: thread.id,
      agentSessionId: thread.agentSessionId,
      startSeq: 0,
      stopped: wasRunning,
      ackText,
    }, 202);
  }

  // Concurrent follow-up: the persistent session-service session accepts
  // stream-json messages over stdin, so a new turn from the operator queues
  // naturally behind the running one. Just clear any stale inFlightByThread
  // stub from a prior turn so the new turn's stub replaces it cleanly.
  if (body.threadId) inFlightByThread.delete(body.threadId);

  let appContext = '';
  const appId = body.appId || (thread?.appId ?? undefined);
  if (appId) {
    const app = await db.query.applications.findFirst({
      where: eq(schema.applications.id, appId),
    });
    if (app) {
      appContext = `\n\nCurrent app context: appId=${app.id}, name="${app.name}"${
        app.projectDir ? `, projectDir=${app.projectDir}` : ''
      }. When listing feedback/sessions, default to filtering by this appId unless asked otherwise.`;
    } else {
      appContext = `\n\nCurrent app context: appId=${appId}.`;
    }
  }

  // If the thread already has a claude session id, resume it so the CLI carries
  // full prior context itself (no need to re-inject history into the prompt).
  // Otherwise we start a fresh session with a new UUID, and capture the session
  // id from the stream to persist on the thread for the next turn.
  //
  // Safety guard: if the JSONL file for the stored session exceeds 5 MB, loading
  // it on every turn makes startup slow enough that the concurrent-follow-up
  // killer fires before the first ack goes out (SIGTERM → exit 143). In that
  // case drop the resume and let the thread start fresh.
  const JSONL_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB
  let rawResumeId = thread?.claudeSessionId ?? null;
  if (rawResumeId) {
    const cwdForSize = resolveRepoRoot();
    const projectSlug = cwdForSize.replace(/\//g, '-');
    const jsonlPath = pathJoin(homedir(), '.claude', 'projects', projectSlug, `${rawResumeId}.jsonl`);
    try {
      const { size } = statSync(jsonlPath);
      if (size > JSONL_SIZE_LIMIT) {
        console.warn(`[cos] session ${rawResumeId} JSONL is ${size} bytes (>${JSONL_SIZE_LIMIT}) — dropping resume to avoid slow startup`);
        rawResumeId = null;
        if (body.threadId) {
          db.update(schema.cosThreads)
            .set({ claudeSessionId: null })
            .where(eq(schema.cosThreads.id, body.threadId))
            .run();
        }
      }
    } catch { /* file not found or unreadable — proceed normally */ }
  }
  const resumeSessionId = rawResumeId;
  const requestId = randomUUID();
  const startedAt = Date.now();
  const otherSessions = Array.from(activeSessions.values()).map(serializeSession);
  const session: ActiveSession = {
    requestId,
    sessionId: resumeSessionId || requestId,
    text,
    startedAt,
    lockKeys: new Set(),
  };
  activeSessions.set(requestId, session);

  const concurrencyContext =
    `\n\nYour requestId is ${requestId} (pass it to the lock API).` +
    (body.threadId ? `\n\nYour threadId is ${body.threadId}.` : '') +
    (otherSessions.length > 0
      ? `\n\nOther active Ops sessions right now:\n${JSON.stringify(otherSessions, null, 2)}`
      : `\n\nNo other Ops sessions are active right now.`) +
    `\n\n${COORDINATION_INSTRUCTIONS}`;

  // Build base system prompt from thread or body
  const baseSystemPrompt = (thread?.systemPrompt || body.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;

  const verbosity: Verbosity = body.verbosity === 'normal' || body.verbosity === 'verbose' ? body.verbosity : 'terse';
  const style: ReplyStyle = body.style === 'neutral' || body.style === 'friendly' ? body.style : 'dry';
  const replyProtocol = '\n\n' + structuredReplyInstructions(verbosity, style);

  const systemPrompt = baseSystemPrompt + appContext + concurrencyContext + replyProtocol;

  const resolvedModel = thread?.model || body.model;

  // Write any image attachments to a per-turn tmp dir and inject their absolute
  // paths into the prompt. Claude will use the Read tool to view them.
  const attachmentsIn = Array.isArray(body.attachments) ? body.attachments : [];
  const elementRefs = Array.isArray(body.elementRefs) ? body.elementRefs : [];
  let tmpImagePaths: Array<{ absPath: string; name: string }> = [];
  try {
    tmpImagePaths = writeImageAttachmentsToTmp(attachmentsIn);
  } catch (err) {
    console.error('[cos] failed to write image attachments:', err);
  }

  const contextBlocks: string[] = [];
  if (tmpImagePaths.length > 0) {
    const lines = tmpImagePaths.map((p, i) => `[${i + 1}] ${p.absPath}`);
    contextBlocks.push(
      `Attached images from the operator (use the Read tool on these absolute paths to view them):\n${lines.join('\n')}`,
    );
  }
  const elementBlock = renderElementRefsBlock(elementRefs);
  if (elementBlock) contextBlocks.push(elementBlock);

  const promptText = contextBlocks.length > 0
    ? `${contextBlocks.join('\n\n')}\n\n---\n\n${text}`
    : text;

  // ── Persistent headless-stream path ──────────────────────────────────────
  // Every CoS thread has exactly one persistent headless-stream agent session
  // (provisioned at thread creation or backfilled above). If the session is
  // alive in the session-service, forward the turn's user message as stdin
  // JSON and proxy the output as SSE; otherwise spawn it fresh with this
  // message as the initial prompt. Per-turn context (requestId, other active
  // sessions) is prepended so the persistent session sees it.
  {
    // Prepend per-turn metadata so the model has requestId / lock context.
    const turnMeta = [
      `[TURN requestId=${requestId}]`,
      otherSessions.length > 0 ? `Other active Ops sessions: ${JSON.stringify(otherSessions)}` : null,
    ].filter(Boolean).join('\n');
    const fullTurnText = turnMeta ? `${turnMeta}\n\n${promptText}` : promptText;

    const liveStatus = await getSessionStatus(thread.agentSessionId).catch(() => null);
    const isLive = liveStatus?.active && liveStatus.status === 'running';

    // If session is dead or idle, spawn it with the first user message as the initial prompt.
    // headless-stream requires at least one prompt to start; subsequent turns go via stdin.
    if (!isLive) {
      const nowIso2 = new Date().toISOString();
      // If the thread already has a claudeSessionId from an earlier turn, pass
      // it as `resumeSessionId` so the CLI runs `--resume <id>` and picks up
      // prior context. Passing it as `claudeSessionId` would map to
      // `--session-id <id>`, which claude rejects with
      // "Session ID … is already in use" when the JSONL already exists — that
      // made the session exit in <1s and the UI showed "send failed" with no
      // reply. `resumeSessionId` honours the JSONL-size guard above (rawResumeId
      // gets nulled if the stored session's JSONL exceeds 5 MB).
      const priorResumeId = resumeSessionId;
      const freshSessionId = priorResumeId ? null : randomUUID();
      const effectiveClaudeSessionId = priorResumeId ?? freshSessionId!;
      db.update(schema.agentSessions)
        .set({ status: 'running', claudeSessionId: effectiveClaudeSessionId, startedAt: nowIso2, lastActivityAt: nowIso2 })
        .where(eq(schema.agentSessions.id, thread.agentSessionId))
        .run();
      const threadSp = buildThreadSystemPrompt(thread.id, thread.appId, thread.systemPrompt);
      let spawnErr: unknown = null;
      try {
        await spawnSessionRemote({
          sessionId: thread.agentSessionId,
          prompt: fullTurnText,
          cwd,
          permissionProfile: 'headless-stream-yolo',
          claudeSessionId: freshSessionId ?? undefined,
          resumeSessionId: priorResumeId ?? undefined,
          appendSystemPrompt: threadSp,
        });
      } catch (err) {
        spawnErr = err;
        console.error('[cos] spawn failed:', err);
      }
      // Give it a moment to start before we try to proxy output
      await new Promise((r) => setTimeout(r, 800));

      // If the spawn itself rejected, surface a real error to the client
      // instead of falling through to a WebSocket that'll time out against a
      // non-running session. Also flip the agentSessions row back to failed
      // so the sidebar reflects reality.
      if (spawnErr) {
        db.update(schema.agentSessions)
          .set({ status: 'failed', completedAt: new Date().toISOString() })
          .where(eq(schema.agentSessions.id, thread.agentSessionId))
          .run();
        activeSessions.delete(requestId);
        if (body.threadId) inFlightByThread.delete(body.threadId);
        for (const p of tmpImagePaths) { try { unlinkSync(p.absPath); } catch { /* ignore */ } }
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        return c.json({ error: `Failed to start CoS agent session: ${msg}` }, 502);
      }
    }

    // Persist user message row upfront.
    const userMsgStartedAt2 = typeof body.clientTs === 'number' ? body.clientTs : Date.now();
    const userMsgId2 = ulid();
    const hasExtras2 = attachmentsIn.length > 0 || elementRefs.length > 0 || typeof body.replyToTs === 'number';
    const userAttachmentsJson2 = hasExtras2 ? JSON.stringify({
      images: attachmentsIn.filter((a) => a.kind === 'image').map((a) => ({ dataUrl: a.dataUrl, name: a.name })),
      elements: elementRefs,
      ...(typeof body.replyToTs === 'number' ? { replyToTs: body.replyToTs } : {}),
    }) : null;
    if (body.threadId && thread) {
      db.insert(schema.cosMessages).values({
        id: userMsgId2, threadId: thread.id, role: 'user', text,
        toolCallsJson: null, attachmentsJson: userAttachmentsJson2, createdAt: userMsgStartedAt2,
      }).run();
    }

    // Update agentSession to show running state.
    db.update(schema.agentSessions).set({
      status: 'running',
      lastActivityAt: new Date().toISOString(),
      title: text.slice(0, 160),
    }).where(eq(schema.agentSessions.id, thread.agentSessionId)).run();

    activeSessions.set(requestId, { requestId, sessionId: thread.agentSessionId, text, startedAt, lockKeys: new Set() });
    if (body.threadId) inFlightByThread.set(body.threadId, { proc: { pid: undefined } as any, cancelled: false });

    // Snapshot the session-service outputSeq once, before kicking off the
    // detached consumer, so the caller can return it in the 202 response and
    // the consumer uses the same boundary for WS replay.
    const statusForSeq = await getSessionStatus(thread.agentSessionId).catch(() => null);
    const startSeq = statusForSeq?.outputSeq ?? 0;

    // Mark the turn as in-flight so /threads/:id/status can answer "is the
    // bot busy?" without invoking the LLM, and so /threads/:id/events knows
    // which turnId to backfill from the replay buffer for late subscribers.
    db.update(schema.cosThreads).set({
      turnStartedAt: startedAt,
      turnStartSeq: startSeq,
      turnUserText: text.slice(0, 500),
      turnRequestId: requestId,
    }).where(eq(schema.cosThreads.id, thread.id)).run();

    // Snapshot what the consumer's onDone needs from `thread`/`body` so the
    // detached closure isn't tied to the response lifecycle.
    const threadIdForCallbacks = thread.id;
    const agentSessionIdForCallbacks = thread.agentSessionId;
    const agentIdForCallbacks = thread.agentId;
    const threadIdForBody = body.threadId;

    // Fire the consumer detached — POST /chat returns 202 immediately and the
    // client subscribes to /threads/:id/events to receive content. Errors are
    // surfaced via `turn_status: failed` events, never thrown out.
    void runCosTurnConsumer({
      agentSessionId: agentSessionIdForCallbacks,
      userMessage: isLive ? fullTurnText : null,
      turnId: requestId,
      threadId: threadIdForCallbacks,
      agentId: agentIdForCallbacks,
      startSeq,
      onAssistantText: (finalText, toolCallsById, toolOrder) => {
        if (!finalText) return;
        const now2 = Date.now();
        const toolCallsArr = toolOrder.map((id) => toolCallsById.get(id)).filter(Boolean);
        db.insert(schema.cosMessages).values({
          id: ulid(), threadId: threadIdForCallbacks, role: 'assistant', text: finalText,
          toolCallsJson: toolCallsArr.length > 0 ? JSON.stringify(toolCallsArr) : null,
          attachmentsJson: null, createdAt: now2,
        }).run();
        db.update(schema.cosThreads).set({ updatedAt: now2 }).where(eq(schema.cosThreads.id, threadIdForCallbacks)).run();
        db.update(schema.agentSessions).set({
          status: 'running', lastActivityAt: new Date().toISOString(),
        }).where(eq(schema.agentSessions.id, agentSessionIdForCallbacks)).run();
      },
      onCapturedSessionId: (sid) => {
        db.update(schema.cosThreads).set({ claudeSessionId: sid }).where(eq(schema.cosThreads.id, threadIdForCallbacks)).run();
        db.update(schema.agentSessions).set({ claudeSessionId: sid }).where(eq(schema.agentSessions.id, agentSessionIdForCallbacks)).run();
      },
      onDone: () => {
        releaseAllLocks(requestId);
        activeSessions.delete(requestId);
        if (threadIdForBody) inFlightByThread.delete(threadIdForBody);
        db.update(schema.cosThreads).set({
          turnStartedAt: null,
          turnStartSeq: null,
          turnUserText: null,
          turnRequestId: null,
        }).where(eq(schema.cosThreads.id, threadIdForCallbacks)).run();
        for (const p of tmpImagePaths) { try { unlinkSync(p.absPath); } catch { /* ignore */ } }
      },
    }).catch((err) => {
      // runCosTurnConsumer always resolves (errors are surfaced as
      // turn_status events). This catch is here only to satisfy the
      // promise-rejection lint.
      console.error('[cos] consumer crashed:', err);
    });

    return c.json({
      turnId: requestId,
      threadId: thread.id,
      agentSessionId: thread.agentSessionId,
      startSeq,
    }, 202);
  }
  // ── End persistent headless-stream path ───────────────────────────────────

  // Unreachable: every chat turn above routed through the persistent path and
  // already returned.
  return c.json({ error: 'Internal routing error' }, 500);
});

// Run shortly after module load so the db + session-service have time to
// settle. Best-effort: failures here only delay assistant-row persistence
// for a single turn and never crash the server.
setTimeout(() => { void recoverInFlightTurns(); }, 1500);
