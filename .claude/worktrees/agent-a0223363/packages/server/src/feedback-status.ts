import { eq, desc, and, ne, sql } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { feedbackEvents } from './events.js';

export function updateFeedbackOnSessionEnd(sessionId: string, sessionStatus: string): void {
  const session = db
    .select({ feedbackId: schema.agentSessions.feedbackId })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();

  if (!session?.feedbackId) return;

  // Only update if this is the latest session for this feedback
  const latestSession = db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.feedbackId, session.feedbackId))
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1)
    .get();

  if (!latestSession || latestSession.id !== sessionId) return;

  let dispatchStatus: string;
  if (sessionStatus === 'completed') dispatchStatus = 'completed';
  else if (sessionStatus === 'killed') dispatchStatus = 'killed';
  else dispatchStatus = 'failed';

  const now = new Date().toISOString();
  const feedback = db
    .select({ appId: schema.feedbackItems.appId })
    .from(schema.feedbackItems)
    .where(eq(schema.feedbackItems.id, session.feedbackId))
    .get();

  db.update(schema.feedbackItems)
    .set({ dispatchStatus, updatedAt: now })
    .where(eq(schema.feedbackItems.id, session.feedbackId))
    .run();

  feedbackEvents.emit('updated', { id: session.feedbackId, appId: feedback?.appId || null });
}

export function fixStaleDispatchStatuses(): number {
  const stale = db
    .select({
      feedbackId: schema.feedbackItems.id,
    })
    .from(schema.feedbackItems)
    .where(eq(schema.feedbackItems.dispatchStatus, 'running'))
    .all();

  let fixed = 0;
  const now = new Date().toISOString();
  for (const { feedbackId } of stale) {
    const latestSession = db
      .select({ id: schema.agentSessions.id, status: schema.agentSessions.status })
      .from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.feedbackId, feedbackId),
        ne(schema.agentSessions.status, 'deleted'),
      ))
      .orderBy(desc(schema.agentSessions.createdAt))
      .limit(1)
      .get();

    if (!latestSession) continue;
    if (latestSession.status === 'running' || latestSession.status === 'pending') continue;

    let dispatchStatus: string;
    if (latestSession.status === 'completed') dispatchStatus = 'completed';
    else if (latestSession.status === 'killed') dispatchStatus = 'killed';
    else dispatchStatus = 'failed';

    db.update(schema.feedbackItems)
      .set({ dispatchStatus, updatedAt: now })
      .where(eq(schema.feedbackItems.id, feedbackId))
      .run();
    fixed++;
  }
  return fixed;
}
