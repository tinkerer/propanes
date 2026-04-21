import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';

export const cosLearningsRoutes = new Hono();

const ALLOWED_TYPES = new Set(['pitfall', 'suggestion', 'tool_gap']);
const ALLOWED_SEVERITY = new Set(['low', 'medium', 'high']);

cosLearningsRoutes.get('/cos/learnings', async (c) => {
  const type = c.req.query('type');
  const severity = c.req.query('severity');

  const conditions = [];
  if (type && ALLOWED_TYPES.has(type)) conditions.push(eq(schema.cosLearnings.type, type));
  if (severity && ALLOWED_SEVERITY.has(severity)) conditions.push(eq(schema.cosLearnings.severity, severity));

  const rows = await db
    .select()
    .from(schema.cosLearnings)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.cosLearnings.createdAt))
    .limit(500);

  return c.json({ learnings: rows });
});

cosLearningsRoutes.post('/cos/learnings', async (c) => {
  let body: {
    learnings?: Array<{
      sessionJsonl?: string | null;
      type?: string;
      title?: string;
      body?: string;
      severity?: string;
    }>;
    sessionJsonl?: string | null;
    type?: string;
    title?: string;
    body?: string;
    severity?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const items = Array.isArray(body.learnings)
    ? body.learnings
    : (body.type || body.title)
      ? [{
          sessionJsonl: body.sessionJsonl,
          type: body.type,
          title: body.title,
          body: body.body,
          severity: body.severity,
        }]
      : [];

  if (items.length === 0) return c.json({ error: 'No learnings provided' }, 400);

  const now = Date.now();
  const inserted: Array<typeof schema.cosLearnings.$inferSelect> = [];
  const skipped: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const type = (it.type || '').trim();
    const title = (it.title || '').trim();
    const text = (it.body || '').trim();
    const severity = (it.severity || 'medium').trim();
    if (!ALLOWED_TYPES.has(type)) {
      skipped.push({ index: i, reason: `invalid type "${type}"` });
      continue;
    }
    if (!title) {
      skipped.push({ index: i, reason: 'title required' });
      continue;
    }
    if (!ALLOWED_SEVERITY.has(severity)) {
      skipped.push({ index: i, reason: `invalid severity "${severity}"` });
      continue;
    }
    const row = {
      id: ulid(),
      sessionJsonl: it.sessionJsonl ?? null,
      type,
      title: title.slice(0, 200),
      body: text,
      severity,
      createdAt: now + i,
    };
    await db.insert(schema.cosLearnings).values(row);
    inserted.push(row as typeof schema.cosLearnings.$inferSelect);
  }

  return c.json({ inserted, skipped, count: inserted.length });
});

cosLearningsRoutes.delete('/cos/learnings/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(schema.cosLearnings).where(eq(schema.cosLearnings.id, id));
  return c.json({ ok: true });
});

// Wiggum posts a summary of its findings here. The summary is stashed in
// cos_metadata so the Learnings UI can show the banner. (When the CoS thread
// schema lands, this endpoint will also insert a system-role message into the
// named thread.)
cosLearningsRoutes.post('/cos/learnings/announce', async (c) => {
  let body: { threadId?: string; summary?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const threadId = (body.threadId || '').trim();
  const summary = (body.summary || '').trim();
  if (!summary) return c.json({ error: 'summary required' }, 400);

  const now = Date.now();
  const announcement = JSON.stringify({ summary, threadId: threadId || null, at: now });
  const existing = await db.query.cosMetadata.findFirst({
    where: eq(schema.cosMetadata.key, 'wiggum.lastAnnouncement'),
  });
  if (existing) {
    await db.update(schema.cosMetadata)
      .set({ value: announcement })
      .where(eq(schema.cosMetadata.key, 'wiggum.lastAnnouncement'));
  } else {
    await db.insert(schema.cosMetadata).values({ key: 'wiggum.lastAnnouncement', value: announcement });
  }

  return c.json({ ok: true });
});

cosLearningsRoutes.get('/cos/learnings/announcement', async (c) => {
  const row = await db.query.cosMetadata.findFirst({
    where: eq(schema.cosMetadata.key, 'wiggum.lastAnnouncement'),
  });
  if (!row) return c.json({ announcement: null });
  try {
    return c.json({ announcement: JSON.parse(row.value) });
  } catch {
    return c.json({ announcement: null });
  }
});
