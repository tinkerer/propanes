import { Hono } from 'hono';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { verifyAdminToken } from '../auth.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

export const audioRoutes = new Hono();

audioRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const audio = await db.query.feedbackAudio.findFirst({
    where: eq(schema.feedbackAudio.id, id),
  });

  if (!audio) {
    return c.json({ error: 'Audio not found' }, 404);
  }

  try {
    const filePath = join(UPLOAD_DIR, audio.filename);
    const data = await readFile(filePath);
    c.header('Content-Type', audio.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(data);
  } catch {
    return c.json({ error: 'Audio file not found' }, 404);
  }
});

audioRoutes.delete('/:id', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token || !(await verifyAdminToken(token))) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const audio = await db.query.feedbackAudio.findFirst({
    where: eq(schema.feedbackAudio.id, id),
  });
  if (!audio) return c.json({ error: 'Audio not found' }, 404);

  try {
    await unlink(join(UPLOAD_DIR, audio.filename));
  } catch {
    // file may already be gone
  }

  await db.delete(schema.feedbackAudio).where(eq(schema.feedbackAudio.id, id));
  return c.json({ id, deleted: true });
});
