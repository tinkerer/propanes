import { Hono } from 'hono';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../db/index.js';
import { verifyAdminToken } from '../auth.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

export const imageRoutes = new Hono();

imageRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const screenshot = await db.query.feedbackScreenshots.findFirst({
    where: eq(schema.feedbackScreenshots.id, id),
  });

  if (!screenshot) {
    return c.json({ error: 'Image not found' }, 404);
  }

  try {
    const filePath = join(UPLOAD_DIR, screenshot.filename);
    const data = await readFile(filePath);
    c.header('Content-Type', screenshot.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(data);
  } catch {
    return c.json({ error: 'Image file not found' }, 404);
  }
});

// Overwrite existing image with cropped version
imageRoutes.put('/:id', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token || !(await verifyAdminToken(token))) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const screenshot = await db.query.feedbackScreenshots.findFirst({
    where: eq(schema.feedbackScreenshots.id, id),
  });
  if (!screenshot) return c.json({ error: 'Image not found' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('image');
  if (!(file instanceof File)) return c.json({ error: 'Missing image file' }, 400);

  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(join(UPLOAD_DIR, screenshot.filename), buf);
  await db.update(schema.feedbackScreenshots)
    .set({ size: buf.byteLength })
    .where(eq(schema.feedbackScreenshots.id, id));

  return c.json({ id, size: buf.byteLength, replaced: true });
});

// Save cropped image as new screenshot linked to same feedback
imageRoutes.post('/', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token || !(await verifyAdminToken(token))) return c.json({ error: 'Unauthorized' }, 401);

  const formData = await c.req.formData();
  const file = formData.get('image');
  const feedbackId = formData.get('feedbackId');
  if (!(file instanceof File)) return c.json({ error: 'Missing image file' }, 400);
  if (typeof feedbackId !== 'string' || !feedbackId) return c.json({ error: 'Missing feedbackId' }, 400);

  const screenshotId = ulid();
  const ext = file.type.split('/')[1] || 'png';
  const filename = `${screenshotId}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, filename), buf);

  const now = new Date().toISOString();
  await db.insert(schema.feedbackScreenshots).values({
    id: screenshotId,
    feedbackId,
    filename,
    mimeType: file.type,
    size: buf.byteLength,
    createdAt: now,
  });

  return c.json({ id: screenshotId, feedbackId, filename, size: buf.byteLength });
});

imageRoutes.delete('/:id', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token || !(await verifyAdminToken(token))) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const screenshot = await db.query.feedbackScreenshots.findFirst({
    where: eq(schema.feedbackScreenshots.id, id),
  });
  if (!screenshot) return c.json({ error: 'Image not found' }, 404);

  try {
    await unlink(join(UPLOAD_DIR, screenshot.filename));
  } catch {
    // file may already be gone
  }

  await db.delete(schema.feedbackScreenshots).where(eq(schema.feedbackScreenshots.id, id));
  return c.json({ id, deleted: true });
});
