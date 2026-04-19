/**
 * Deferred dispatch manager.
 *
 * Schedules an agent dispatch to fire after a delay unless cancelled
 * first. Used by voice-mode to give the user a 10-second undo window
 * after an actionable idea is detected.
 *
 * The dispatcher is pluggable so tests can stub the actual agent
 * launch — see setDispatcher().
 */

import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../db/index.js';
import { dispatchFeedbackToAgent } from '../dispatch.js';
import { emitNotification, resolveNotification } from '../notifications.js';
import { broadcastAdmin } from '../admin-push.js';
import { NOTIFICATIONS_TOPIC } from '@propanes/shared';

export interface ScheduleDispatchParams {
  feedbackId: string;
  agentEndpointId: string;
  appId: string | null;
  delayMs: number;
  title: string;
  description?: string;
  source?: string;
  instructions?: string;
}

export interface ScheduleDispatchResult {
  pendingId: string;
  dispatchAt: string;
  notificationId: string;
}

export type DispatchExecutor = (params: {
  feedbackId: string;
  agentEndpointId: string;
  instructions?: string;
}) => Promise<{ sessionId?: string }>;

let executor: DispatchExecutor = async (p) => {
  const result = await dispatchFeedbackToAgent({
    feedbackId: p.feedbackId,
    agentEndpointId: p.agentEndpointId,
    instructions: p.instructions,
  });
  return { sessionId: result.sessionId };
};

export function setDeferredDispatchExecutor(fn: DispatchExecutor): void {
  executor = fn;
}

export function resetDeferredDispatchExecutor(): void {
  executor = async (p) => {
    const result = await dispatchFeedbackToAgent({
      feedbackId: p.feedbackId,
      agentEndpointId: p.agentEndpointId,
      instructions: p.instructions,
    });
    return { sessionId: result.sessionId };
  };
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export async function scheduleDeferredDispatch(
  params: ScheduleDispatchParams
): Promise<ScheduleDispatchResult> {
  const pendingId = ulid();
  const now = new Date();
  const dispatchAtDate = new Date(now.getTime() + Math.max(0, params.delayMs));
  const dispatchAt = dispatchAtDate.toISOString();

  const notif = emitNotification({
    kind: 'voice-dispatch',
    severity: 'info',
    title: `Launching agent: ${params.title}`,
    body: params.description
      ? `Will launch in ${Math.round(params.delayMs / 1000)}s unless cancelled. — ${params.description}`
      : `Will launch in ${Math.round(params.delayMs / 1000)}s unless cancelled.`,
    appId: params.appId,
    feedbackId: params.feedbackId,
    payload: {
      kind: 'voice-dispatch',
      voiceDispatch: {
        pendingDispatchId: pendingId,
        feedbackId: params.feedbackId,
        agentEndpointId: params.agentEndpointId,
        dispatchAt,
        title: params.title,
        description: params.description || '',
      },
    },
  });

  await db.insert(schema.pendingDispatches).values({
    id: pendingId,
    feedbackId: params.feedbackId,
    agentEndpointId: params.agentEndpointId,
    appId: params.appId,
    notificationId: notif.id,
    status: 'pending',
    dispatchAt,
    source: params.source || 'voice',
    metadata: JSON.stringify({
      title: params.title,
      description: params.description || '',
      instructions: params.instructions || '',
    }),
    createdAt: now.toISOString(),
  });

  const timer = setTimeout(() => {
    fireDispatch(pendingId).catch((err) => {
      console.error(`[deferred-dispatch] Fire failed for ${pendingId}:`, err);
    });
  }, Math.max(0, params.delayMs));
  timers.set(pendingId, timer);

  return { pendingId, dispatchAt, notificationId: notif.id };
}

async function fireDispatch(pendingId: string): Promise<void> {
  timers.delete(pendingId);
  const row = db
    .select()
    .from(schema.pendingDispatches)
    .where(eq(schema.pendingDispatches.id, pendingId))
    .get();
  if (!row || row.status !== 'pending') return;

  const metadata = row.metadata ? JSON.parse(row.metadata) : {};
  try {
    if (!row.agentEndpointId) {
      throw new Error('pending dispatch has no agent endpoint');
    }
    await executor({
      feedbackId: row.feedbackId,
      agentEndpointId: row.agentEndpointId,
      instructions: metadata.instructions || undefined,
    });
    await db
      .update(schema.pendingDispatches)
      .set({ status: 'dispatched', resolvedAt: new Date().toISOString() })
      .where(eq(schema.pendingDispatches.id, pendingId));
    if (row.notificationId) {
      resolveNotification(row.notificationId, 'approved');
    }
  } catch (err) {
    console.error(`[deferred-dispatch] Dispatch failed for ${pendingId}:`, err);
    await db
      .update(schema.pendingDispatches)
      .set({ status: 'cancelled', resolvedAt: new Date().toISOString() })
      .where(eq(schema.pendingDispatches.id, pendingId));
    // Bubble a warning notification but don't crash
    broadcastAdmin({
      topic: NOTIFICATIONS_TOPIC,
      data: { type: 'updated', notification: { ...row, status: 'cancelled' } },
    });
  }
}

export async function cancelDeferredDispatch(
  pendingId: string,
  opts: { deleteFeedback?: boolean } = {}
): Promise<{ cancelled: boolean; deletedFeedback?: boolean }> {
  const timer = timers.get(pendingId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(pendingId);
  }
  const row = db
    .select()
    .from(schema.pendingDispatches)
    .where(eq(schema.pendingDispatches.id, pendingId))
    .get();
  if (!row) return { cancelled: false };
  if (row.status !== 'pending') return { cancelled: false };

  await db
    .update(schema.pendingDispatches)
    .set({ status: 'cancelled', resolvedAt: new Date().toISOString() })
    .where(eq(schema.pendingDispatches.id, pendingId));

  if (row.notificationId) {
    resolveNotification(row.notificationId, 'rejected');
  }

  let deletedFeedback = false;
  if (opts.deleteFeedback) {
    await db
      .delete(schema.feedbackItems)
      .where(eq(schema.feedbackItems.id, row.feedbackId));
    deletedFeedback = true;
  }
  return { cancelled: true, deletedFeedback };
}

export async function fireDeferredDispatchNow(pendingId: string): Promise<void> {
  const timer = timers.get(pendingId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(pendingId);
  }
  await fireDispatch(pendingId);
}

export function hasActiveTimer(pendingId: string): boolean {
  return timers.has(pendingId);
}

/** Re-arm timers for any still-pending rows (e.g. after server restart). */
export function rearmPendingDispatchesOnStartup(): void {
  const rows = db
    .select()
    .from(schema.pendingDispatches)
    .where(eq(schema.pendingDispatches.status, 'pending'))
    .all();
  const now = Date.now();
  for (const row of rows) {
    const at = new Date(row.dispatchAt).getTime();
    const delay = Math.max(0, at - now);
    const timer = setTimeout(() => {
      fireDispatch(row.id).catch((err) => {
        console.error(`[deferred-dispatch] Rearmed fire failed for ${row.id}:`, err);
      });
    }, delay);
    timers.set(row.id, timer);
  }
}
