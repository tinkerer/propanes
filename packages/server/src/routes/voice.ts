/**
 * Voice ambient listen-mode routes.
 *
 * Flow:
 *   1) Widget calls POST /api/v1/voice/sessions to start a listen-mode
 *      session. Server returns a voiceSessionId.
 *   2) For each chunk, widget calls
 *      POST /api/v1/voice/sessions/:id/windows with the transcript.
 *      Server classifies. If actionable, creates a feedback item and
 *      returns the classification + feedbackId so the widget can show
 *      a ticket card with dispatch options.
 *   3) Widget calls POST /api/v1/voice/dispatch with the user's chosen
 *      runtime + mode to launch the session. No pre-configured agent
 *      endpoint needed.
 *   4) Widget calls POST /api/v1/voice/sessions/:id/stop when listen
 *      mode turns off or safeguards fire.
 */

import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { classifyVoiceWindow, summarizeConversation } from '../voice/classifier.js';
import { feedbackEvents } from '../events.js';
import {
  dispatchAgentSession,
  renderPromptTemplate,
  DEFAULT_PROMPT_TEMPLATE,
  hydrateFeedback,
} from '../dispatch.js';
import type { AgentRuntime, PermissionProfile } from '@propanes/shared';

export const voiceRoutes = new Hono();

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

  // Fetch all previous window texts for context/summary
  const prevRows = db
    .select()
    .from(schema.voiceTranscripts)
    .where(eq(schema.voiceTranscripts.voiceSessionId, voiceSessionId))
    .all()
    .sort((a, b) => a.windowIndex - b.windowIndex);
  const prev = prevRows[prevRows.length - 1];

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

  // Build conversation summary from previous chunks for context
  const previousTexts = prevRows.map((r) => r.text).filter(Boolean);
  const conversationSummary = previousTexts.length >= 2
    ? await summarizeConversation(previousTexts)
    : undefined;

  const classification = await classifyVoiceWindow({
    text: win.text,
    previousText: prev?.text,
    conversationSummary,
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

  // Use routed app ID if the classifier determined a better target app
  const effectiveAppId = classification.routedAppId || session.appId;

  // Create a feedback item — but do NOT auto-dispatch.
  // Widget shows a ticket card and user picks runtime + mode.
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
      conversationSummary,
    }),
    context: null,
    sourceUrl: session.sourceUrl,
    userAgent: null,
    viewport: null,
    sessionId: session.widgetSessionId,
    userId: session.userId,
    appId: effectiveAppId,
    createdAt: now,
    updatedAt: now,
  });
  const tags = ['voice-captured', ...(classification.tags || [])];
  await db.insert(schema.feedbackTags).values(
    tags.map((tag) => ({ feedbackId, tag }))
  );

  feedbackEvents.emit('new', {
    id: feedbackId,
    appId: effectiveAppId,
    autoDispatch: false,
  });

  await db
    .update(schema.voiceTranscripts)
    .set({ feedbackId })
    .where(eq(schema.voiceTranscripts.id, transcriptId));

  return c.json({
    transcriptId,
    classification,
    feedbackId,
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

// --- Inline voice dispatch (no agent endpoint required) ---

const dispatchSchema = z.object({
  feedbackId: z.string(),
  runtime: z.enum(['claude', 'codex']).default('claude'),
  mode: z.enum(['interactive', 'headless']).default('interactive'),
  instructions: z.string().optional(),
});

/** Map user-facing mode to a permission profile. */
function resolveProfile(mode: 'interactive' | 'headless'): PermissionProfile {
  // interactive = TUI with skip-permissions (no approval prompts from brainstorm)
  // headless = one-shot pipe with skip-permissions
  return mode === 'headless' ? 'headless-yolo' : 'interactive-yolo';
}

voiceRoutes.post('/dispatch', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const { feedbackId, runtime, mode, instructions } = parsed.data;

  const feedback = db
    .select()
    .from(schema.feedbackItems)
    .where(eq(schema.feedbackItems.id, feedbackId))
    .get();
  if (!feedback) return c.json({ error: 'Feedback not found' }, 404);

  // Check for existing active session
  const existing = db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.feedbackId, feedbackId),
        sql`${schema.agentSessions.status} IN ('pending', 'running')`
      )
    )
    .get();
  if (existing) {
    return c.json({ sessionId: existing.id, existing: true });
  }

  const tags = db
    .select()
    .from(schema.feedbackTags)
    .where(eq(schema.feedbackTags.feedbackId, feedbackId))
    .all()
    .map((t) => t.tag);
  const screenshots = db
    .select()
    .from(schema.feedbackScreenshots)
    .where(eq(schema.feedbackScreenshots.feedbackId, feedbackId))
    .all();
  const hydratedFeedback = hydrateFeedback(feedback, tags, screenshots);

  let app = null;
  if (feedback.appId) {
    const appRow = db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, feedback.appId))
      .get();
    if (appRow) {
      app = { ...appRow, hooks: JSON.parse(appRow.hooks) };
    }
  }

  const cwd = app?.projectDir || process.cwd();
  const permissionProfile = resolveProfile(mode);
  const prompt = renderPromptTemplate(DEFAULT_PROMPT_TEMPLATE, hydratedFeedback, app, instructions);

  // Find any agent endpoint to satisfy the FK, or use a placeholder
  const anyAgent = db.select().from(schema.agentEndpoints).limit(1).get();
  const agentEndpointId = anyAgent?.id || 'voice-inline';

  const { sessionId } = await dispatchAgentSession({
    feedbackId,
    agentEndpointId,
    prompt,
    cwd,
    runtime: runtime as AgentRuntime,
    permissionProfile,
  });

  const now = new Date().toISOString();
  db.update(schema.feedbackItems).set({
    status: 'dispatched',
    dispatchedTo: `Voice ${runtime} (${mode})`,
    dispatchedAt: now,
    dispatchStatus: 'running',
    dispatchResponse: `Agent session started: ${sessionId}`,
    updatedAt: now,
  }).where(eq(schema.feedbackItems.id, feedbackId)).run();

  feedbackEvents.emit('updated', { id: feedbackId, appId: feedback.appId });

  return c.json({ sessionId, runtime, mode, permissionProfile });
});

// --- Dismiss a voice ticket (delete the feedback item) ---

voiceRoutes.post('/dismiss', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const feedbackId = body?.feedbackId;
  if (!feedbackId) return c.json({ error: 'feedbackId required' }, 400);
  await db.delete(schema.feedbackItems).where(eq(schema.feedbackItems.id, feedbackId));
  return c.json({ dismissed: true });
});
