import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { db, schema } from '../db/index.js';
import {
  startWiggumRun,
  pauseWiggumRun,
  resumeWiggumRun,
  stopWiggumRun,
  getActiveRunIds,
} from '../wiggum-controller.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

const app = new Hono();

function serializeRun(row: typeof schema.wiggumRuns.$inferSelect) {
  return {
    ...row,
    iterations: JSON.parse(row.iterations || '[]'),
  };
}

// List wiggum runs (optionally filtered by parentSessionId)
app.get('/', (c) => {
  const parentSessionId = c.req.query('parentSessionId');
  const query = parentSessionId
    ? db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.parentSessionId, parentSessionId))
    : db.select().from(schema.wiggumRuns);
  const rows = query.all();
  const activeIds = getActiveRunIds();
  return c.json(rows.map((r) => ({
    ...serializeRun(r),
    isActive: activeIds.includes(r.id),
  })));
});

// Create and start a new run
app.post('/', async (c) => {
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = ulid();

  if (!body.harnessConfigId) {
    return c.json({ error: 'harnessConfigId is required' }, 400);
  }
  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  db.insert(schema.wiggumRuns).values({
    id,
    agentEndpointId: body.agentEndpointId || null,
    harnessConfigId: body.harnessConfigId,
    feedbackId: body.feedbackId || null,
    appId: body.appId || null,
    prompt: body.prompt,
    deployCommand: body.deployCommand || null,
    maxIterations: body.maxIterations ?? 10,
    widgetSessionId: body.widgetSessionId || null,
    screenshotDelayMs: body.screenshotDelayMs ?? 3000,
    parentSessionId: body.parentSessionId || null,
    status: 'pending',
    currentIteration: 0,
    iterations: '[]',
    createdAt: now,
    updatedAt: now,
  }).run();

  // Start the run in the background
  startWiggumRun(id).catch((err) => {
    console.error(`[wiggum] Failed to start run ${id}:`, err.message);
  });

  const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(row!), 201);
});

// Get run details
app.get('/:id', (c) => {
  const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const screenshots = db.select().from(schema.wiggumScreenshots)
    .where(eq(schema.wiggumScreenshots.runId, row.id)).all();

  return c.json({
    ...serializeRun(row),
    isActive: getActiveRunIds().includes(row.id),
    screenshots,
  });
});

// Pause a running run
app.post('/:id/pause', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);
  if (run.status !== 'running') return c.json({ error: `Cannot pause run in status: ${run.status}` }, 400);

  pauseWiggumRun(id);
  const updated = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(updated!));
});

// Resume a paused run
app.post('/:id/resume', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);
  if (run.status !== 'paused') return c.json({ error: `Cannot resume run in status: ${run.status}` }, 400);

  resumeWiggumRun(id);
  const updated = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(updated!));
});

// Stop a run
app.post('/:id/stop', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);
  if (run.status !== 'running' && run.status !== 'paused') {
    return c.json({ error: `Cannot stop run in status: ${run.status}` }, 400);
  }

  stopWiggumRun(id);
  const updated = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(updated!));
});

// Delete a run
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);

  // Stop if active
  if (run.status === 'running' || run.status === 'paused') {
    stopWiggumRun(id);
  }

  // Cascade will delete screenshots rows; files remain on disk
  db.delete(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).run();
  return c.json({ ok: true });
});

// Serve a screenshot image
app.get('/:id/screenshots/:sid', async (c) => {
  const screenshot = db.select().from(schema.wiggumScreenshots)
    .where(eq(schema.wiggumScreenshots.id, c.req.param('sid'))).get();
  if (!screenshot || screenshot.runId !== c.req.param('id')) {
    return c.json({ error: 'Not found' }, 404);
  }

  const filePath = `${UPLOAD_DIR}/${screenshot.filename}`;
  try {
    const info = await stat(filePath);
    c.header('Content-Type', screenshot.mimeType);
    c.header('Content-Length', String(info.size));
    c.header('Cache-Control', 'public, max-age=86400');
    const stream = createReadStream(filePath);
    return new Response(stream as any, { headers: { 'Content-Type': screenshot.mimeType } });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

export default app;
