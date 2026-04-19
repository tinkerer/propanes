/**
 * Voice ambient listen-mode routes.
 *
 * Flow:
 *   1) Widget calls POST /api/v1/voice/sessions to start a listen-mode
 *      session. Server returns a voiceSessionId.
 *   2) For each rolling ~30s window, widget calls
 *      POST /api/v1/voice/sessions/:id/windows with the transcript.
 *      Server classifies the window. If actionable, server creates a
 *      feedback item tagged `voice-captured` and schedules a deferred
 *      dispatch (notification with Cancel/Edit/Launch-now).
 *   3) Widget calls POST /api/v1/voice/sessions/:id/stop when listen
 *      mode turns off or safeguards fire.
 *
 * The classifier and dispatcher are pluggable — see
 * ./voice/classifier.ts and ./voice/deferred-dispatch.ts.
 */

import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { classifyVoiceWindow } from '../voice/classifier.js';
import {
  scheduleDeferredDispatch,
  cancelDeferredDispatch,
  fireDeferredDispatchNow,
} from '../voice/deferred-dispatch.js';
import { feedbackEvents } from '../events.js';

export const voiceRoutes = new Hono();

const VOICE_DISPATCH_DELAY_MS = Number(process.env.VOICE_DISPATCH_DELAY_MS || 10_000);
const VOICE_MIN_WINDOW_CHARS = 30;

function resolveAppIdFromApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  const app = db
    .select({ id: schema.applications.id })
    .from(schema.applications)
    .where(eq(schema.applications.apiKey, apiKey))
    .get();
  return app?.id ?? null;
}

function resolveYoloAgent(appId: string | null): string | null {
  if (!appId) {
    const any = db
      .select()
      .from(schema.agentEndpoints)
      .where(eq(schema.agentEndpoints.permissionProfile, 'yolo'))
      .all();
    return any[0]?.id ?? null;
  }
  const appYolo = db
    .select()
    .from(schema.agentEndpoints)
    .where(and(
      eq(schema.agentEndpoints.appId, appId),
      eq(schema.agentEndpoints.permissionProfile, 'yolo'),
    ))
    .all();
  if (appYolo.length) return appYolo[0].id;
  const globalYolo = db
    .select()
    .from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.permissionProfile, 'yolo'))
    .all();
  if (globalYolo.length) return globalYolo[0].id;
  // Fall back: app's default agent
  const agents = db.select().from(schema.agentEndpoints).all();
  const def =
    agents.find((a) => a.isDefault && a.appId === appId) ||
    agents.find((a) => a.isDefault && !a.appId) ||
    agents[0];
  return def?.id ?? null;
}

const startSchema = z.object({
  appId: z.string().optional(),
  widgetSessionId: z.string().optional(),
  userId: z.string().optional(),
  sourceUrl: z.string().optional(),
});

voiceRoutes.post('/sessions', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const apiKey = c.req.header('x-api-key');
  const appId = parsed.data.appId || resolveAppIdFromApiKey(apiKey);

  const id = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.voiceSessions).values({
    id,
    appId: appId || null,
    widgetSessionId: parsed.data.widgetSessionId || null,
    userId: parsed.data.userId || null,
    sourceUrl: parsed.data.sourceUrl || null,
    status: 'active',
    startedAt: now,
    lastActivityAt: now,
  });
  return c.json({ id, startedAt: now }, 201);
});

const windowSchema = z.object({
  text: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  windowIndex: z.number().int().min(0),
});

voiceRoutes.post('/sessions/:id/windows', async (c) => {
  const voiceSessionId = c.req.param('id');
  const session = db
    .select()
    .from(schema.voiceSessions)
    .where(eq(schema.voiceSessions.id, voiceSessionId))
    .get();
  if (!session) return c.json({ error: 'Voice session not found' }, 404);
  if (session.status !== 'active') {
    return c.json({ error: 'Voice session is stopped' }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = windowSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const win = parsed.data;
  const now = new Date().toISOString();

  // Fetch previous window text for short context
  const prevRows = db
    .select()
    .from(schema.voiceTranscripts)
    .where(eq(schema.voiceTranscripts.voiceSessionId, voiceSessionId))
    .all();
  const prev = prevRows.sort((a, b) => b.windowIndex - a.windowIndex)[0];

  const transcriptId = ulid();
  await db.insert(schema.voiceTranscripts).values({
    id: transcriptId,
    voiceSessionId,
    windowIndex: win.windowIndex,
    text: win.text,
    startedAt: win.startedAt,
    endedAt: win.endedAt,
    classification: null,
    feedbackId: null,
    createdAt: now,
  });

  await db
    .update(schema.voiceSessions)
    .set({ lastActivityAt: now })
    .where(eq(schema.voiceSessions.id, voiceSessionId));

  if (win.text.trim().length < VOICE_MIN_WINDOW_CHARS) {
    return c.json({
      transcriptId,
      classification: { actionable: false, reason: 'too-short' },
    });
  }

  const classification = await classifyVoiceWindow({
    text: win.text,
    previousText: prev?.text,
    appId: session.appId,
    sourceUrl: session.sourceUrl,
  });

  await db
    .update(schema.voiceTranscripts)
    .set({ classification: JSON.stringify(classification) })
    .where(eq(schema.voiceTranscripts.id, transcriptId));

  if (!classification.actionable) {
    return c.json({ transcriptId, classification });
  }

  const agentId = resolveYoloAgent(session.appId);
  if (!agentId) {
    return c.json({
      transcriptId,
      classification,
      warning: 'no-yolo-agent-configured',
    });
  }

  // Create a feedback item tagged voice-captured
  const feedbackId = ulid();
  const title = classification.title || 'Voice idea';
  const description = classification.description || win.text;
  await db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'manual',
    status: 'new',
    title,
    description,
    data: JSON.stringify({
      voiceSessionId,
      voiceTranscriptId: transcriptId,
      classification,
    }),
    context: null,
    sourceUrl: session.sourceUrl,
    userAgent: null,
    viewport: null,
    sessionId: session.widgetSessionId,
    userId: session.userId,
    appId: session.appId,
    createdAt: now,
    updatedAt: now,
  });
  const tags = ['voice-captured', ...(classification.tags || [])];
  await db.insert(schema.feedbackTags).values(
    tags.map((tag) => ({ feedbackId, tag }))
  );
  // Notify feedback stream (matches POST /feedback emission shape but with autoDispatch=false,
  // since we're handling the deferred-dispatch ourselves).
  feedbackEvents.emit('new', {
    id: feedbackId,
    appId: session.appId,
    autoDispatch: false,
  });

  await db
    .update(schema.voiceTranscripts)
    .set({ feedbackId })
    .where(eq(schema.voiceTranscripts.id, transcriptId));

  const scheduled = await scheduleDeferredDispatch({
    feedbackId,
    agentEndpointId: agentId,
    appId: session.appId,
    delayMs: VOICE_DISPATCH_DELAY_MS,
    title,
    description,
    source: 'voice',
  });

  return c.json({
    transcriptId,
    classification,
    feedbackId,
    pendingDispatchId: scheduled.pendingId,
    dispatchAt: scheduled.dispatchAt,
    notificationId: scheduled.notificationId,
  });
});

const stopSchema = z.object({
  reason: z.string().optional(),
});

voiceRoutes.post('/sessions/:id/stop', async (c) => {
  const voiceSessionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = stopSchema.safeParse(body);
  const reason = parsed.success ? parsed.data.reason : undefined;
  const session = db
    .select()
    .from(schema.voiceSessions)
    .where(eq(schema.voiceSessions.id, voiceSessionId))
    .get();
  if (!session) return c.json({ error: 'Voice session not found' }, 404);
  if (session.status === 'stopped') {
    return c.json({ id: voiceSessionId, status: 'stopped' });
  }
  const now = new Date().toISOString();
  await db
    .update(schema.voiceSessions)
    .set({ status: 'stopped', stoppedAt: now, stopReason: reason || 'user' })
    .where(eq(schema.voiceSessions.id, voiceSessionId));
  return c.json({ id: voiceSessionId, status: 'stopped', stoppedAt: now });
});

voiceRoutes.get('/sessions/:id', (c) => {
  const id = c.req.param('id');
  const session = db
    .select()
    .from(schema.voiceSessions)
    .where(eq(schema.voiceSessions.id, id))
    .get();
  if (!session) return c.json({ error: 'Voice session not found' }, 404);
  const transcripts = db
    .select()
    .from(schema.voiceTranscripts)
    .where(eq(schema.voiceTranscripts.voiceSessionId, id))
    .all();
  return c.json({ session, transcripts });
});

// --- Pending-dispatch control surface (used by the notification toast) ---

voiceRoutes.post('/pending-dispatches/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const result = await cancelDeferredDispatch(id, { deleteFeedback: true });
  if (!result.cancelled) return c.json({ error: 'not found or already resolved' }, 404);
  return c.json({ cancelled: true, deletedFeedback: !!result.deletedFeedback });
});

voiceRoutes.post('/pending-dispatches/:id/launch-now', async (c) => {
  const id = c.req.param('id');
  await fireDeferredDispatchNow(id);
  return c.json({ ok: true });
});

voiceRoutes.post('/pending-dispatches/:id/edit', async (c) => {
  // "Edit" cancels the timer but keeps the feedback item so the user
  // can tweak it in the feedback detail drawer.
  const id = c.req.param('id');
  const result = await cancelDeferredDispatch(id, { deleteFeedback: false });
  if (!result.cancelled) return c.json({ error: 'not found or already resolved' }, 404);
  const row = db
    .select()
    .from(schema.pendingDispatches)
    .where(eq(schema.pendingDispatches.id, id))
    .get();
  return c.json({ cancelled: true, feedbackId: row?.feedbackId });
});
