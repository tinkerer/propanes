import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, desc } from 'drizzle-orm';
import { readFile, writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { join, resolve, extname, basename } from 'node:path';
import { db, schema } from '../db/index.js';
import { getSession } from '../sessions.js';

// Generic file uploads — mirrors the screenshots flow but for arbitrary files
// dragged into the admin composer. Files are written to UPLOAD_DIR and
// symlinked into /tmp so an agent running on the server host can read them by
// path. The admin shows a "copy path" affordance for the returned /tmp path.

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

// Keep a recognizable, filesystem-safe version of the original name. We prefix
// with a ULID for collision-freedom, so the human-facing part can be lossy.
function sanitizeName(name: string): string {
  const base = basename(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return base.slice(0, 120) || 'file';
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

export const uploadRoutes = new Hono();

export interface StoredUpload {
  id: string;
  filename: string;
  originalName: string;
  path: string;
  size: number;
  mimeType: string;
}

// Persist uploaded Files to UPLOAD_DIR + DB and symlink into /tmp. Shared by
// the generic /uploads route and the per-session drop-files route.
export async function storeUploads(
  files: File[],
  meta: { sessionId?: string; userId?: string; sourceUrl?: string; appId?: string | null },
): Promise<StoredUpload[]> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const now = new Date().toISOString();
  const results: StoredUpload[] = [];

  for (const file of files) {
    const id = ulid();
    const originalName = sanitizeName(file.name);
    // Storage filename: <ulid>-<original> so /tmp paths stay readable and unique.
    const filename = `${id}-${originalName}`;
    const mimeType = file.type || 'application/octet-stream';
    const absPath = resolve(UPLOAD_DIR, filename);
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(absPath, buf);
    db.insert(schema.uploads).values({
      id,
      appId: meta.appId || null,
      sessionId: meta.sessionId || null,
      userId: meta.userId || null,
      sourceUrl: meta.sourceUrl || null,
      filename,
      originalName: file.name || originalName,
      mimeType,
      size: buf.byteLength,
      createdAt: now,
    }).run();
    const tmpPath = await linkToTmp(absPath, filename);
    results.push({ id, filename, originalName: file.name || originalName, path: tmpPath, size: buf.byteLength, mimeType });
  }
  return results;
}

// Upload one or more arbitrary files (multipart/form-data, field `files`).
uploadRoutes.post('/', async (c) => {
  const contentType = c.req.header('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const formData = await c.req.formData();
  const metaStr = formData.get('meta');
  const meta: Record<string, unknown> = typeof metaStr === 'string' ? JSON.parse(metaStr) : {};

  const apiKey = c.req.header('x-api-key');
  const appId = resolveAppId(apiKey, meta.sessionId as string | undefined, meta.appId as string | undefined);

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return c.json({ error: 'No files provided' }, 400);
  }

  const results = await storeUploads(files, {
    appId,
    sessionId: meta.sessionId as string | undefined,
    userId: meta.userId as string | undefined,
    sourceUrl: meta.sourceUrl as string | undefined,
  });

  return c.json({ appId, createdAt: new Date().toISOString(), files: results }, 201);
});

// List uploads (admin)
uploadRoutes.get('/', async (c) => {
  const appId = c.req.query('appId');
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const rows = appId
    ? db.select().from(schema.uploads)
        .where(eq(schema.uploads.appId, appId))
        .orderBy(desc(schema.uploads.createdAt))
        .limit(limit).all()
    : db.select().from(schema.uploads)
        .orderBy(desc(schema.uploads.createdAt))
        .limit(limit).all();
  return c.json(rows);
});

// Get file bytes (download). Served with the original name as a sensible default.
uploadRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = db.select()
    .from(schema.uploads)
    .where(eq(schema.uploads.id, id))
    .get();
  if (!row) return c.json({ error: 'Upload not found' }, 404);

  try {
    const data = await readFile(join(UPLOAD_DIR, row.filename));
    c.header('Content-Type', row.mimeType);
    const safeName = (row.originalName || row.filename).replace(/["\\\r\n]/g, '_');
    c.header('Content-Disposition', `inline; filename="${safeName}"`);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(data);
  } catch {
    return c.json({ error: 'Upload file not found' }, 404);
  }
});

// Delete an upload
uploadRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const row = db.select()
    .from(schema.uploads)
    .where(eq(schema.uploads.id, id))
    .get();
  if (!row) return c.json({ error: 'Upload not found' }, 404);
  try { await unlink(join(UPLOAD_DIR, row.filename)); } catch {}
  try { await unlink(join(TMP_LINK_DIR, row.filename)); } catch {}
  db.delete(schema.uploads).where(eq(schema.uploads.id, id)).run();
  return c.json({ id, deleted: true });
});
