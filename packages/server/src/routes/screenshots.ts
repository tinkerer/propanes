import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, desc } from 'drizzle-orm';
import { readFile, writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { db, schema } from '../db/index.js';
import { getSession } from '../sessions.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const TMP_LINK_DIR = '/tmp';

async function linkToTmp(absPath: string, filename: string): Promise<string> {
  const tmpPath = join(TMP_LINK_DIR, filename);
  try { await unlink(tmpPath); } catch {}
  try {
    await symlink(absPath, tmpPath);
    return tmpPath;
  } catch {
    return absPath;
  }
}

function resolveAppId(apiKey: string | undefined, sessionId: string | undefined, appId?: string): string | null {
  if (sessionId) {
    const session = getSession(sessionId);
    if (session?.appId) return session.appId;
  }
  if (apiKey) {
    const app = db.select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.apiKey, apiKey))
      .get();
    if (app) return app.id;
  }
  if (appId) {
    const app = db.select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.id, appId))
      .get();
    if (app) return app.id;
  }
  return null;
}

export const screenshotRoutes = new Hono();

// Upload one or more screenshots (multipart/form-data) — no feedback item created
screenshotRoutes.post('/', async (c) => {
  const contentType = c.req.header('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await c.req.formData();
  const metaStr = formData.get('meta');
  const meta: Record<string, unknown> = typeof metaStr === 'string' ? JSON.parse(metaStr) : {};

  const apiKey = c.req.header('x-api-key');
  const appId = resolveAppId(apiKey, meta.sessionId as string | undefined, meta.appId as string | undefined);

  const files = formData.getAll('screenshots');
  if (files.length === 0) {
    return c.json({ error: 'No screenshots provided' }, 400);
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const now = new Date().toISOString();
  const results: { id: string; filename: string; path: string }[] = [];

  for (const file of files) {
    if (!(file instanceof File)) continue;
    const screenshotId = ulid();
    const mimeType = file.type || 'image/png';
    const ext = mimeType.split('/')[1] || 'png';
    const filename = `${screenshotId}.${ext}`;
    const absPath = resolve(UPLOAD_DIR, filename);
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(absPath, buf);
    db.insert(schema.screenshots).values({
      id: screenshotId,
      appId,
      sessionId: (meta.sessionId as string) || null,
      userId: (meta.userId as string) || null,
      sourceUrl: (meta.sourceUrl as string) || null,
      filename,
      mimeType,
      size: buf.byteLength,
      width: typeof meta.width === 'number' ? meta.width : null,
      height: typeof meta.height === 'number' ? meta.height : null,
      createdAt: now,
    }).run();
    const tmpPath = await linkToTmp(absPath, filename);
    results.push({ id: screenshotId, filename, path: tmpPath });
  }

  return c.json({ appId, createdAt: now, screenshots: results }, 201);
});

// List screenshots (admin)
screenshotRoutes.get('/', async (c) => {
  const appId = c.req.query('appId');
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const rows = appId
    ? db.select().from(schema.screenshots)
        .where(eq(schema.screenshots.appId, appId))
        .orderBy(desc(schema.screenshots.createdAt))
        .limit(limit).all()
    : db.select().from(schema.screenshots)
        .orderBy(desc(schema.screenshots.createdAt))
        .limit(limit).all();
  return c.json(rows);
});

// Get screenshot image bytes
screenshotRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = db.select()
    .from(schema.screenshots)
    .where(eq(schema.screenshots.id, id))
    .get();
  if (!row) return c.json({ error: 'Screenshot not found' }, 404);

  try {
    const data = await readFile(join(UPLOAD_DIR, row.filename));
    c.header('Content-Type', row.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(data);
  } catch {
    return c.json({ error: 'Screenshot file not found' }, 404);
  }
});

// Delete a screenshot
screenshotRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const row = db.select()
    .from(schema.screenshots)
    .where(eq(schema.screenshots.id, id))
    .get();
  if (!row) return c.json({ error: 'Screenshot not found' }, 404);
  try { await unlink(join(UPLOAD_DIR, row.filename)); } catch {}
  db.delete(schema.screenshots).where(eq(schema.screenshots.id, id)).run();
  return c.json({ id, deleted: true });
});
