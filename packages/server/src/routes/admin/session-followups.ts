import { Hono } from 'hono';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { resumeAgentSession } from '../../dispatch.js';

export const sessionFollowupRoutes = new Hono();

// List pending followups for a session (parent).
sessionFollowupRoutes.get('/agent-sessions/:id/followups', async (c) => {
  const sessionId = c.req.param('id');
  const rows = db
    .select()
    .from(schema.sessionFollowups)
    .where(eq(schema.sessionFollowups.parentSessionId, sessionId))
    .orderBy(asc(schema.sessionFollowups.createdAt))
    .all();
  return c.json({ followups: rows });
});

const enqueueSchema = z.object({ prompt: z.string().min(1).max(20_000) });

// Enqueue a followup prompt for a session. The followup fires when the session
// exits (completes/fails/is killed) — never while it's still running, so you
// can queue work without interrupting an in-flight turn.
sessionFollowupRoutes.post('/agent-sessions/:id/followup', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = enqueueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  const parent = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  if (!parent) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const id = ulid();
  const now = new Date().toISOString();
  db.insert(schema.sessionFollowups).values({
    id,
    parentSessionId: sessionId,
    feedbackId: parent.feedbackId,
    agentEndpointId: parent.agentEndpointId,
    prompt: parsed.data.prompt,
    status: 'pending',
    createdAt: now,
  }).run();

  return c.json({ id, status: 'pending', willDispatchOnExit: parent.status === 'running' || parent.status === 'pending' });
});

sessionFollowupRoutes.delete('/agent-sessions/followups/:id', async (c) => {
  const id = c.req.param('id');
  db.update(schema.sessionFollowups)
    .set({ status: 'canceled' })
    .where(and(
      eq(schema.sessionFollowups.id, id),
      eq(schema.sessionFollowups.status, 'pending'),
    ))
    .run();
  return c.json({ ok: true });
});

// Manually trigger the watcher sweep — useful for tests / debugging.
sessionFollowupRoutes.post('/session-followups/sweep', async (c) => {
  const dispatched = await dispatchPendingFollowups();
  return c.json({ dispatched });
});

// ────────────────────────────────────────────────────────────────────────────
// Watcher: dispatches pending followups once their parent session has exited.
// Called on a timer from the main server; also reachable via the sweep endpoint.
// ────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed']);

let sweepInFlight = false;

export async function dispatchPendingFollowups(): Promise<Array<{ id: string; dispatchedSessionId?: string; error?: string }>> {
  if (sweepInFlight) return [];
  sweepInFlight = true;
  const results: Array<{ id: string; dispatchedSessionId?: string; error?: string }> = [];
  try {
    const pending = db
      .select()
      .from(schema.sessionFollowups)
      .where(eq(schema.sessionFollowups.status, 'pending'))
      .orderBy(asc(schema.sessionFollowups.createdAt))
      .all();
    if (pending.length === 0) return results;

    const parentIds = Array.from(new Set(pending.map((p) => p.parentSessionId)));
    const parents = db
      .select()
      .from(schema.agentSessions)
      .where(inArray(schema.agentSessions.id, parentIds))
      .all();
    const parentById = new Map(parents.map((p) => [p.id, p]));
    // Track which parents we've already dispatched *this sweep* so multiple
    // queued followups on the same parent don't all race to spawn at once.
    // Instead they chain: the newly-dispatched session becomes the parent for
    // the next followup on the next sweep tick.
    const handledParentsThisSweep = new Set<string>();

    for (const followup of pending) {
      if (handledParentsThisSweep.has(followup.parentSessionId)) continue;
      const parent = parentById.get(followup.parentSessionId);
      if (!parent) {
        db.update(schema.sessionFollowups)
          .set({ status: 'failed', errorMessage: 'Parent session not found' })
          .where(eq(schema.sessionFollowups.id, followup.id))
          .run();
        results.push({ id: followup.id, error: 'Parent session not found' });
        continue;
      }
      if (!TERMINAL_STATUSES.has(parent.status)) continue; // still running; wait

      try {
        const { sessionId: newSessionId } = await resumeAgentSession(
          parent.id,
          undefined,
          null,
          followup.prompt,
          null,
        );
        const now = new Date().toISOString();
        db.update(schema.sessionFollowups)
          .set({ status: 'dispatched', dispatchedAt: now, dispatchedSessionId: newSessionId })
          .where(eq(schema.sessionFollowups.id, followup.id))
          .run();
        handledParentsThisSweep.add(followup.parentSessionId);
        results.push({ id: followup.id, dispatchedSessionId: newSessionId });
      } catch (err: any) {
        db.update(schema.sessionFollowups)
          .set({ status: 'failed', errorMessage: (err?.message || String(err)).slice(0, 500) })
          .where(eq(schema.sessionFollowups.id, followup.id))
          .run();
        results.push({ id: followup.id, error: err?.message || String(err) });
      }
    }
  } finally {
    sweepInFlight = false;
  }
  return results;
}
