// CoS thread CRUD + drafts + history + search + supporting helpers.
//
// Drafts: per (agentId, appId, threadId) compose-textarea state so the UI
// can light tab indicators for unsent text.
// Threads: list / create / patch (resolve+archive) / delete plus
//   /threads/:id/messages and /history/:agentId.
// Search: full-text LIKE across cosMessages.
//
// Helpers `resolveRepoRoot`, `ensureAgentSessionForThread`, and
// `fetchThreadsWithSessionStatus` are exported so the chat handler in
// chief-of-staff.ts can reuse them.

import { Hono } from 'hono';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { resolve as pathResolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';
import { mintFeedbackThread } from '../../cos-inbox.js';
import { resumeAgentSession } from '../../dispatch.js';
import {
  spawnSessionRemote,
  killSessionRemote,
} from '../../session-service-client.js';

export function resolveRepoRoot(): string {
  const envDir = process.env.CHIEF_OF_STAFF_CWD;
  if (envDir && existsSync(envDir)) return pathResolve(envDir);
  // Default: assume server runs from packages/server; repo root is two levels up.
  const guess = pathResolve(process.cwd(), '..', '..');
  if (existsSync(pathResolve(guess, 'CLAUDE.md'))) return guess;
  return pathResolve(process.cwd());
}

// Left-join the linked agent session so callers can derive per-thread health
// (running / idle / completed / failed / killed / null=gc'd) without a second
// round trip. Wrapped in a helper because both /threads and /history return
// the same shape.
//
// `agentSessionId` is the thread's *chat* session (headless-stream-yolo,
// driven by ensureAgentSessionForThread). `latestAgentSessionId` is the most
// recent agent_sessions row claiming this thread regardless of profile —
// dispatched interactive/headless sessions land here too. The UI's Session
// log button + rail status indicator should prefer `latest*` so a thread
// that's been dispatched against (but never chatted with) still surfaces
// its session.
export async function fetchThreadsWithSessionStatus(
  conditions: ReturnType<typeof eq>[],
  limit?: number,
) {
  const latestSessionIdExpr = sql<string | null>`(
    SELECT s.id FROM agent_sessions s
    WHERE s.cos_thread_id = ${schema.cosThreads.id}
    ORDER BY s.created_at DESC LIMIT 1
  )`;
  const latestSessionStatusExpr = sql<string | null>`(
    SELECT s.status FROM agent_sessions s
    WHERE s.cos_thread_id = ${schema.cosThreads.id}
    ORDER BY s.created_at DESC LIMIT 1
  )`;
  const latestSessionProfileExpr = sql<string | null>`(
    SELECT s.permission_profile FROM agent_sessions s
    WHERE s.cos_thread_id = ${schema.cosThreads.id}
    ORDER BY s.created_at DESC LIMIT 1
  )`;
  const latestSessionExitExpr = sql<number | null>`(
    SELECT s.exit_code FROM agent_sessions s
    WHERE s.cos_thread_id = ${schema.cosThreads.id}
    ORDER BY s.created_at DESC LIMIT 1
  )`;
  const latestSessionFeedbackExpr = sql<string | null>`(
    SELECT s.feedback_id FROM agent_sessions s
    WHERE s.cos_thread_id = ${schema.cosThreads.id}
    ORDER BY s.created_at DESC LIMIT 1
  )`;

  const baseQuery = db
    .select({
      id: schema.cosThreads.id,
      agentId: schema.cosThreads.agentId,
      appId: schema.cosThreads.appId,
      channelId: schema.cosThreads.channelId,
      // Prefer the latest-session's feedbackId (covers dispatched sessions
      // that landed after the chat session was first provisioned); fall back
      // to the chat session's feedbackId for backward compat.
      feedbackId: sql<string | null>`COALESCE(${latestSessionFeedbackExpr}, ${schema.agentSessions.feedbackId}, ${schema.cosThreads.feedbackId})`,
      name: schema.cosThreads.name,
      systemPrompt: schema.cosThreads.systemPrompt,
      model: schema.cosThreads.model,
      claudeSessionId: schema.cosThreads.claudeSessionId,
      agentSessionId: schema.cosThreads.agentSessionId,
      // Most recent agent_session linked to this thread, regardless of
      // profile. Drives the Session log button + rail status so dispatched
      // sessions surface even when they're not the chat session.
      latestAgentSessionId: latestSessionIdExpr,
      latestAgentSessionStatus: latestSessionStatusExpr,
      latestAgentSessionPermissionProfile: latestSessionProfileExpr,
      latestAgentSessionExitCode: latestSessionExitExpr,
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
      sessionPermissionProfile: schema.agentSessions.permissionProfile,
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

// Every CoS thread has exactly one persistent headless-stream agent session.
// Provision it if missing (e.g. a thread created before the auto-provision
// migration). Returns the agentSessionId that's now linked to the thread.
export async function ensureAgentSessionForThread(
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

export const cosThreadRoutes = new Hono();

// Operator's compose-textarea draft, scoped per (agentId, appId, threadId).
// threadId='' is the "new top-level thread" compose draft; non-empty values
// are reply-in-thread drafts. The listing returns every scope so the UI can
// light tab indicators (any draft in any scope == "agent has unsent text").
// Empty bodies delete the row, so a missing entry == "no draft here".
cosThreadRoutes.get('/chief-of-staff/drafts', async (c) => {
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

cosThreadRoutes.put('/chief-of-staff/drafts', async (c) => {
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

cosThreadRoutes.get('/chief-of-staff/threads', async (c) => {
  const agentId = c.req.query('agentId');
  const appId = c.req.query('appId');
  // Accept an explicit limit (?limit=N, max 2000). Default is 100 for the
  // unscoped case to stay cheap; when scoped by appId we lift to 1000 because
  // the channel-list UX depends on seeing every thread in the workspace
  // (#sessions auto-populates one thread per agent_sessions row, easily 500+).
  const rawLimit = parseInt(c.req.query('limit') || '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 2000)
    : (appId ? 1000 : 100);

  const conditions = [];
  if (agentId) conditions.push(eq(schema.cosThreads.agentId, agentId));
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));

  const rows = await fetchThreadsWithSessionStatus(conditions, limit);
  return c.json({ threads: rows });
});

// Toggle the per-thread "resolved" / "archived" flags. Used by the rail's
// inline resolve/archive actions so operators can clear failed/idle threads
// from triage without deleting them. Both flags can be set independently in
// one PATCH; empty body is treated as { resolved: true } for backward compat.
cosThreadRoutes.patch('/chief-of-staff/threads/:id', async (c) => {
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

// Promote a CoS thread to a live interactive TTY session.
//
// Resolution order:
//   1. Thread has a backing agentSession (any status)
//      → kill it if running, then resume with override profile
//        `interactive-yolo` so the new session inherits --resume <claudeSid>
//        and a TTY frontend.
//   2. Thread has no backing agentSession yet (pre-migration row, or one
//      that lost its row to GC)
//      → ensure one, then route through (1).
//   3. New session has no claudeSessionId to resume from
//      → spawn a fresh interactive-yolo claude TTY in the repo's cwd.
//
// In every case the thread's `agentSessionId` column is updated to point at
// the new live session so the next chat turn (or future "Open as
// interactive" click) finds it correctly.
cosThreadRoutes.post('/chief-of-staff/threads/:id/spawn-interactive', async (c) => {
  const threadId = c.req.param('id');
  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  // Make sure a row exists so the resume path has a parent. The migration
  // helper handles "thread predates auto-provision" cleanly.
  await ensureAgentSessionForThread(thread);
  const fresh = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!fresh?.agentSessionId) {
    return c.json({ error: 'Failed to provision agent session for thread' }, 500);
  }

  const existing = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, fresh.agentSessionId))
    .get();
  if (!existing) {
    return c.json({ error: 'Linked agent session row missing' }, 500);
  }

  // If the existing session is still running we have to terminate it first
  // — claude won't let two TTYs share one --session-id.
  if (existing.status === 'running' || existing.status === 'pending') {
    await killSessionRemote(existing.id).catch(() => false);
    db.update(schema.agentSessions)
      .set({ status: 'killed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, existing.id))
      .run();
  }

  // Path A — we have a claudeSessionId. Use the standard resume helper so
  // the new TTY launches with `--resume <claudeSid> --session-id <new>` and
  // inherits full prior context. resumeAgentSession was extended to accept
  // thread-only parents (no feedback/agent-endpoint) so this just works.
  const claudeSessionId = fresh.claudeSessionId || existing.claudeSessionId || null;
  if (claudeSessionId) {
    // Prime the parent's claudeSessionId column if it was only on the thread
    // row (older threads stored it on cosThreads but not on agentSessions).
    if (!existing.claudeSessionId && claudeSessionId) {
      db.update(schema.agentSessions)
        .set({ claudeSessionId })
        .where(eq(schema.agentSessions.id, existing.id))
        .run();
    }
    try {
      const { sessionId } = await resumeAgentSession(
        existing.id,
        null,
        'interactive-yolo',
        null,
        'claude',
      );
      // Re-link the thread to the new live session.
      db.update(schema.cosThreads)
        .set({ agentSessionId: sessionId, updatedAt: Date.now() })
        .where(eq(schema.cosThreads.id, threadId))
        .run();
      return c.json({ sessionId, mode: 'resumed' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resume failed';
      return c.json({ error: msg }, 500);
    }
  }

  // Path B — fresh thread, no prior claude session. Allocate a new session
  // id and spawn an interactive-yolo TTY against the repo root so the
  // operator can drive claude directly. The thread's chat composer keeps
  // working too — it just queues stream-json against the same agentSession
  // row on the next /chat call.
  const newSessionId = ulid();
  const nowIso = new Date().toISOString();
  const newClaudeSessionId = crypto.randomUUID();
  const cwd = existing.cwd || resolveRepoRoot();

  db.insert(schema.agentSessions).values({
    id: newSessionId,
    cosThreadId: threadId,
    parentSessionId: existing.id,
    runtime: 'claude',
    permissionProfile: 'interactive-yolo',
    status: 'pending',
    outputBytes: 0,
    title: thread.name,
    claudeSessionId: newClaudeSessionId,
    cwd,
    createdAt: nowIso,
    startedAt: nowIso,
    lastActivityAt: nowIso,
  }).run();

  try {
    await spawnSessionRemote({
      sessionId: newSessionId,
      cwd,
      runtime: 'claude',
      permissionProfile: 'interactive-yolo',
      claudeSessionId: newClaudeSessionId,
    });
  } catch (err) {
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, newSessionId))
      .run();
    const msg = err instanceof Error ? err.message : 'Spawn failed';
    return c.json({ error: msg }, 500);
  }

  // Re-link the thread to the new live session and remember the
  // claudeSessionId so future resumes have a context to re-attach to.
  db.update(schema.cosThreads)
    .set({
      agentSessionId: newSessionId,
      claudeSessionId: newClaudeSessionId,
      updatedAt: Date.now(),
    })
    .where(eq(schema.cosThreads.id, threadId))
    .run();

  return c.json({ sessionId: newSessionId, mode: 'fresh' });
});

cosThreadRoutes.post('/chief-of-staff/threads', async (c) => {
  let body: { agentId?: string; appId?: string; channelId?: string; name?: string; systemPrompt?: string; model?: string };
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
    channelId: body.channelId || null,
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


cosThreadRoutes.delete('/chief-of-staff/threads/:id', async (c) => {
  const id = c.req.param('id');
  // Cascade deletes messages due to FK
  await db.delete(schema.cosThreads).where(eq(schema.cosThreads.id, id));
  return c.json({ ok: true });
});

cosThreadRoutes.get('/chief-of-staff/threads/:id/messages', async (c) => {
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
cosThreadRoutes.get('/chief-of-staff/search', async (c) => {
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
cosThreadRoutes.get('/chief-of-staff/history/:agentId', async (c) => {
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

// Look up a thread by feedbackId — returns { thread, messages } so the
// FeedbackDetailPage can render the linked CoS thread inline. If no thread
// exists yet (legacy feedback rows from before mintFeedbackThread was wired
// up), a `mint=1` query string flag opts in to creating one on the fly.
cosThreadRoutes.get('/chief-of-staff/threads/by-feedback/:feedbackId', async (c) => {
  const feedbackId = c.req.param('feedbackId');
  const wantMint = c.req.query('mint') === '1';

  let thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.feedbackId, feedbackId),
  });

  if (!thread && wantMint) {
    const fb = await db.query.feedbackItems.findFirst({
      where: eq(schema.feedbackItems.id, feedbackId),
    });
    if (!fb) return c.json({ error: 'Feedback not found' }, 404);
    if (!fb.appId) return c.json({ error: 'Feedback has no appId; cannot mint thread' }, 400);
    const newThreadId = await mintFeedbackThread({
      feedbackId: fb.id,
      appId: fb.appId,
      title: fb.title || `Ticket ${fb.id.slice(-6)}`,
      description: fb.description || '',
    });
    if (!newThreadId) return c.json({ error: 'Failed to mint thread' }, 500);
    thread = await db.query.cosThreads.findFirst({
      where: eq(schema.cosThreads.id, newThreadId),
    });
  }

  if (!thread) {
    return c.json({ thread: null, messages: [] });
  }

  const messages = await db
    .select()
    .from(schema.cosMessages)
    .where(eq(schema.cosMessages.threadId, thread.id))
    .orderBy(schema.cosMessages.createdAt);

  return c.json({ thread, messages });
});

// Append a plain user note to a thread without firing an agent turn. Used by
// the FeedbackDetailPage composer so operators can capture clarifying context
// on a draft thread (no running session yet) or after a session has wrapped.
// Hitting POST /chat would also work but always spawns/queues an agent turn,
// which is the wrong default for "add some triage notes".
cosThreadRoutes.post('/chief-of-staff/threads/:id/note', async (c) => {
  const threadId = c.req.param('id');
  let body: { text?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const text = (body.text || '').trim();
  if (!text) return c.json({ error: 'text is required' }, 400);

  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const id = ulid();
  const now = Date.now();
  await db.insert(schema.cosMessages).values({
    id,
    threadId,
    role: 'user',
    text,
    toolCallsJson: null,
    attachmentsJson: null,
    mentionsJson: null,
    slashCommand: null,
    createdAt: now,
  });
  await db.update(schema.cosThreads)
    .set({ updatedAt: now })
    .where(eq(schema.cosThreads.id, threadId));

  return c.json({ id, threadId, role: 'user' as const, text, createdAt: now });
});
