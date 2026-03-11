import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq } from 'drizzle-orm';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { feedbackSubmitSchema } from '@prompt-widget/shared';
import { db, schema } from '../db/index.js';
import { getSession } from '../sessions.js';
import { feedbackEvents } from '../events.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

function resolveAppId(apiKey: string | undefined, sessionId: string | undefined, appId?: string): string | null {
  if (sessionId) {
    const session = getSession(sessionId);
    if (session?.appId) return session.appId;
  }
  if (apiKey) {
    const app = db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.apiKey, apiKey))
      .get();
    if (app) return app.id;
  }
  if (appId) {
    const app = db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.id, appId))
      .get();
    if (app) return app.id;
  }
  return null;
}

export const feedbackRoutes = new Hono();

feedbackRoutes.post('/', async (c) => {
  const contentType = c.req.header('content-type') || '';

  let feedbackData: Record<string, unknown>;
  const imageFiles: { data: ArrayBuffer; name: string; type: string }[] = [];

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const jsonStr = formData.get('feedback');
    if (!jsonStr || typeof jsonStr !== 'string') {
      return c.json({ error: 'Missing feedback field in form data' }, 400);
    }
    feedbackData = JSON.parse(jsonStr);

    const files = formData.getAll('screenshots');
    for (const file of files) {
      if (file instanceof File) {
        imageFiles.push({
          data: await file.arrayBuffer(),
          name: file.name,
          type: file.type || 'image/png',
        });
      }
    }
  } else {
    feedbackData = await c.req.json();
  }

  const parsed = feedbackSubmitSchema.safeParse(feedbackData);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();
  const input = parsed.data;
  const title = input.title || input.description.slice(0, 200) || 'Untitled';

  const apiKey = c.req.header('x-api-key');
  const appId = resolveAppId(apiKey, input.sessionId, input.appId);
  if (!appId) {
    return c.json({ error: 'Could not resolve application. Provide a valid X-API-Key header, sessionId, or appId.' }, 400);
  }

  await db.insert(schema.feedbackItems).values({
    id,
    type: input.type,
    status: 'new',
    title,
    description: input.description,
    data: input.data ? JSON.stringify(input.data) : null,
    context: input.context ? JSON.stringify(input.context) : null,
    sourceUrl: input.sourceUrl || null,
    userAgent: input.userAgent || null,
    viewport: input.viewport || null,
    sessionId: input.sessionId || null,
    userId: input.userId || null,
    appId,
    createdAt: now,
    updatedAt: now,
  });

  if (input.tags && input.tags.length > 0) {
    await db.insert(schema.feedbackTags).values(
      input.tags.map((tag) => ({ feedbackId: id, tag }))
    );
  }

  if (imageFiles.length > 0) {
    await mkdir(UPLOAD_DIR, { recursive: true });
    for (const file of imageFiles) {
      const screenshotId = ulid();
      const ext = file.type.split('/')[1] || 'png';
      const filename = `${screenshotId}.${ext}`;
      await writeFile(join(UPLOAD_DIR, filename), Buffer.from(file.data));
      await db.insert(schema.feedbackScreenshots).values({
        id: screenshotId,
        feedbackId: id,
        filename,
        mimeType: file.type,
        size: file.data.byteLength,
        createdAt: now,
      });
    }
  }

  feedbackEvents.emit('new', { id, appId, autoDispatch: !!input.autoDispatch, launcherId: input.launcherId });
  return c.json({ id, appId, status: 'new', createdAt: now }, 201);
});

feedbackRoutes.post('/:id/append', async (c) => {
  const feedbackId = c.req.param('id');
  const existing = db
    .select()
    .from(schema.feedbackItems)
    .where(eq(schema.feedbackItems.id, feedbackId))
    .get();

  if (!existing) {
    return c.json({ error: 'Feedback not found' }, 404);
  }

  const contentType = c.req.header('content-type') || '';
  let appendData: Record<string, unknown>;
  const imageFiles: { data: ArrayBuffer; name: string; type: string }[] = [];

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const jsonStr = formData.get('feedback');
    if (!jsonStr || typeof jsonStr !== 'string') {
      return c.json({ error: 'Missing feedback field in form data' }, 400);
    }
    appendData = JSON.parse(jsonStr);
    const files = formData.getAll('screenshots');
    for (const file of files) {
      if (file instanceof File) {
        imageFiles.push({
          data: await file.arrayBuffer(),
          name: file.name,
          type: file.type || 'image/png',
        });
      }
    }
  } else {
    appendData = await c.req.json();
  }

  const apiKey = c.req.header('x-api-key');
  const sessionId = appendData.sessionId as string | undefined;
  const appId = resolveAppId(apiKey, sessionId, appendData.appId as string | undefined);
  if (!appId || appId !== existing.appId) {
    return c.json({ error: 'App mismatch or could not resolve application' }, 403);
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };

  // Append description
  const newDesc = (appendData.description as string || '').trim();
  if (newDesc) {
    const timestamp = new Date().toLocaleString();
    const separator = `\n\n---\n**Note** (${timestamp}):\n`;
    updates.description = (existing.description || '') + separator + newDesc;
  }

  // Merge data.selectedElements
  const existingData = existing.data ? JSON.parse(existing.data as string) : {};
  const appendSelectedElements = (appendData.data as any)?.selectedElements;
  if (appendSelectedElements?.length) {
    existingData.selectedElements = [
      ...(existingData.selectedElements || []),
      ...appendSelectedElements,
    ];
    updates.data = JSON.stringify(existingData);
  }

  // Merge context
  const existingContext = existing.context ? JSON.parse(existing.context as string) : {};
  const appendContext = appendData.context as Record<string, unknown> | undefined;
  if (appendContext) {
    if (appendContext.consoleLogs && Array.isArray(appendContext.consoleLogs)) {
      existingContext.consoleLogs = [
        ...(existingContext.consoleLogs || []),
        ...appendContext.consoleLogs,
      ];
    }
    if (appendContext.networkErrors && Array.isArray(appendContext.networkErrors)) {
      existingContext.networkErrors = [
        ...(existingContext.networkErrors || []),
        ...appendContext.networkErrors,
      ];
    }
    if (appendContext.performanceTiming) {
      existingContext.performanceTiming = appendContext.performanceTiming;
    }
    if (appendContext.environment) {
      existingContext.environment = appendContext.environment;
    }
    updates.context = JSON.stringify(existingContext);
  }

  await db.update(schema.feedbackItems)
    .set(updates)
    .where(eq(schema.feedbackItems.id, feedbackId))
    .run();

  // Handle screenshots
  if (imageFiles.length > 0) {
    await mkdir(UPLOAD_DIR, { recursive: true });
    for (const file of imageFiles) {
      const screenshotId = ulid();
      const ext = file.type.split('/')[1] || 'png';
      const filename = `${screenshotId}.${ext}`;
      await writeFile(join(UPLOAD_DIR, filename), Buffer.from(file.data));
      await db.insert(schema.feedbackScreenshots).values({
        id: screenshotId,
        feedbackId,
        filename,
        mimeType: file.type,
        size: file.data.byteLength,
        createdAt: now,
      });
    }
  }

  return c.json({ id: feedbackId, appended: true });
});

feedbackRoutes.post('/programmatic', async (c) => {
  const body = await c.req.json();
  const parsed = feedbackSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();
  const input = parsed.data;
  const progTitle = input.title || input.description.slice(0, 200) || 'Untitled';

  const progApiKey = c.req.header('x-api-key');
  const progAppId = resolveAppId(progApiKey, input.sessionId, input.appId);
  if (!progAppId) {
    return c.json({ error: 'Could not resolve application. Provide a valid X-API-Key header, sessionId, or appId.' }, 400);
  }

  await db.insert(schema.feedbackItems).values({
    id,
    type: input.type,
    status: 'new',
    title: progTitle,
    description: input.description,
    data: input.data ? JSON.stringify(input.data) : null,
    context: input.context ? JSON.stringify(input.context) : null,
    sourceUrl: input.sourceUrl || null,
    userAgent: input.userAgent || null,
    viewport: input.viewport || null,
    sessionId: input.sessionId || null,
    userId: input.userId || null,
    appId: progAppId,
    createdAt: now,
    updatedAt: now,
  });

  if (input.tags && input.tags.length > 0) {
    await db.insert(schema.feedbackTags).values(
      input.tags.map((tag) => ({ feedbackId: id, tag }))
    );
  }

  feedbackEvents.emit('new', { id, appId: progAppId, autoDispatch: !!input.autoDispatch, launcherId: input.launcherId });
  return c.json({ id, appId: progAppId, status: 'new', createdAt: now }, 201);
});
