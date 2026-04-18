import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, desc, asc, like, and, or, inArray, ne, sql } from 'drizzle-orm';
import {
  feedbackListSchema,
  feedbackUpdateSchema,
  adminFeedbackCreateSchema,
  batchOperationSchema,
} from '@prompt-widget/shared';
import { db, schema, sqlite } from '../../db/index.js';
import { hydrateFeedback } from '../../dispatch.js';
import { feedbackEvents } from '../../events.js';
import { verifyAdminToken } from '../../auth.js';

export const feedbackRoutes = new Hono();

feedbackRoutes.get('/feedback/tags', async (c) => {
  const appId = c.req.query('appId');

  let rows: { tag: string; count: number }[];
  if (appId) {
    if (appId === '__unlinked__') {
      rows = sqlite.prepare(
        `SELECT ft.tag, COUNT(*) as count FROM feedback_tags ft JOIN feedback_items fi ON ft.feedback_id = fi.id WHERE fi.app_id IS NULL GROUP BY ft.tag ORDER BY count DESC`
      ).all() as { tag: string; count: number }[];
    } else {
      rows = sqlite.prepare(
        `SELECT ft.tag, COUNT(*) as count FROM feedback_tags ft JOIN feedback_items fi ON ft.feedback_id = fi.id WHERE fi.app_id = ? GROUP BY ft.tag ORDER BY count DESC`
      ).all(appId) as { tag: string; count: number }[];
    }
  } else {
    rows = sqlite.prepare(
      `SELECT tag, COUNT(*) as count FROM feedback_tags GROUP BY tag ORDER BY count DESC`
    ).all() as { tag: string; count: number }[];
  }

  return c.json(rows);
});

feedbackRoutes.get('/feedback/events', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.query('token');
  if (!token || !(await verifyAdminToken(token))) return c.json({ error: 'Unauthorized' }, 401);

  return c.body(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        send('connected', { ts: Date.now() });

        const onNew = (item: { id: string; appId: string | null }) => send('new-feedback', item);
        const onUpdated = (item: { id: string; appId: string | null }) => send('feedback-updated', item);
        feedbackEvents.on('new', onNew);
        feedbackEvents.on('updated', onUpdated);

        const keepalive = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* closed */ }
        }, 30_000);

        c.req.raw.signal.addEventListener('abort', () => {
          feedbackEvents.off('new', onNew);
          feedbackEvents.off('updated', onUpdated);
          clearInterval(keepalive);
        });
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }
  );
});

feedbackRoutes.post('/feedback', async (c) => {
  const body = await c.req.json();
  const parsed = adminFeedbackCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();
  const input = parsed.data;

  await db.insert(schema.feedbackItems).values({
    id,
    type: input.type,
    status: 'new',
    title: input.title,
    description: input.description,
    appId: input.appId,
    createdAt: now,
    updatedAt: now,
  });

  if (input.tags && input.tags.length > 0) {
    await db.insert(schema.feedbackTags).values(
      input.tags.map((tag) => ({ feedbackId: id, tag }))
    );
  }

  feedbackEvents.emit('new', { id, appId: input.appId });
  return c.json({ id, status: 'new', createdAt: now }, 201);
});

feedbackRoutes.get('/feedback', async (c) => {
  const query = feedbackListSchema.safeParse(c.req.query());
  if (!query.success) {
    return c.json({ error: 'Invalid query', details: query.error.flatten() }, 400);
  }

  const { page, limit, type, status, dispatchStatus, tag, search, appId, sortBy, sortOrder } = query.data;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (type) conditions.push(eq(schema.feedbackItems.type, type));

  // Build status + dispatchStatus as OR branches
  const statusBranches = [];
  if (status) {
    const statuses = status.split(',').filter(Boolean);
    if (statuses.length === 1) {
      statusBranches.push(eq(schema.feedbackItems.status, statuses[0]));
    } else if (statuses.length > 1) {
      statusBranches.push(inArray(schema.feedbackItems.status, statuses));
    }
  }
  if (dispatchStatus) {
    const dStatuses = dispatchStatus.split(',').filter(Boolean);
    const dCond = dStatuses.length === 1
      ? eq(schema.feedbackItems.dispatchStatus, dStatuses[0])
      : inArray(schema.feedbackItems.dispatchStatus, dStatuses);
    statusBranches.push(and(eq(schema.feedbackItems.status, 'dispatched'), dCond)!);
  }
  if (statusBranches.length > 1) {
    conditions.push(or(...statusBranches)!);
  } else if (statusBranches.length === 1) {
    conditions.push(statusBranches[0]);
  } else {
    // Exclude deleted items by default unless explicitly requested
    conditions.push(sql`${schema.feedbackItems.status} != 'deleted'`);
  }
  if (search) conditions.push(like(schema.feedbackItems.title, `%${search}%`));
  if (appId) {
    if (appId === '__unlinked__') {
      conditions.push(sql`${schema.feedbackItems.appId} IS NULL`);
    } else {
      conditions.push(eq(schema.feedbackItems.appId, appId));
    }
  }

  let whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  if (tag) {
    const taggedIds = db
      .select({ feedbackId: schema.feedbackTags.feedbackId })
      .from(schema.feedbackTags)
      .where(eq(schema.feedbackTags.tag, tag))
      .all()
      .map((r) => r.feedbackId);

    if (taggedIds.length === 0) {
      return c.json({ items: [], total: 0, page, limit, totalPages: 0 });
    }

    const inClause = sql`${schema.feedbackItems.id} IN (${sql.join(
      taggedIds.map((id) => sql`${id}`),
      sql`, `
    )})`;
    whereClause = whereClause ? and(whereClause, inClause) : inClause;
  }

  const sortColumn =
    sortBy === 'updatedAt'
      ? schema.feedbackItems.updatedAt
      : schema.feedbackItems.createdAt;
  const orderFn = sortOrder === 'asc' ? asc : desc;

  const items = db
    .select()
    .from(schema.feedbackItems)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset)
    .all();

  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.feedbackItems)
    .where(whereClause)
    .get();
  const total = countResult?.count || 0;

  // Fetch latest session info for dispatched feedback items
  const feedbackIds = items.map((i) => i.id);
  const sessionMap = new Map<string, { latestSessionId: string; latestSessionStatus: string; sessionCount: number }>();
  if (feedbackIds.length > 0) {
    const sessions = db
      .select({
        feedbackId: schema.agentSessions.feedbackId,
        id: schema.agentSessions.id,
        status: schema.agentSessions.status,
      })
      .from(schema.agentSessions)
      .where(and(
        inArray(schema.agentSessions.feedbackId, feedbackIds),
        ne(schema.agentSessions.status, 'deleted'),
      ))
      .orderBy(desc(schema.agentSessions.createdAt))
      .all();
    for (const s of sessions) {
      if (!s.feedbackId) continue;
      const existing = sessionMap.get(s.feedbackId);
      if (existing) {
        existing.sessionCount++;
      } else {
        sessionMap.set(s.feedbackId, { latestSessionId: s.id, latestSessionStatus: s.status, sessionCount: 1 });
      }
    }
  }

  const hydrated = items.map((item) => {
    const tags = db
      .select()
      .from(schema.feedbackTags)
      .where(eq(schema.feedbackTags.feedbackId, item.id))
      .all()
      .map((t) => t.tag);
    const screenshots = db
      .select()
      .from(schema.feedbackScreenshots)
      .where(eq(schema.feedbackScreenshots.feedbackId, item.id))
      .all();
    const audioFiles = db
      .select()
      .from(schema.feedbackAudio)
      .where(eq(schema.feedbackAudio.feedbackId, item.id))
      .all();
    const fb = hydrateFeedback(item, tags, screenshots, audioFiles);
    const si = sessionMap.get(item.id);
    return si ? { ...fb, latestSessionId: si.latestSessionId, latestSessionStatus: si.latestSessionStatus, sessionCount: si.sessionCount } : fb;
  });

  return c.json({
    items: hydrated,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
});

feedbackRoutes.get('/feedback/:id', async (c) => {
  const id = c.req.param('id');
  let item = await db.query.feedbackItems.findFirst({
    where: eq(schema.feedbackItems.id, id),
  });

  // Fall back to short ID suffix match (last 6+ chars)
  if (!item && id.length >= 4 && id.length < 26) {
    item = await db.query.feedbackItems.findFirst({
      where: like(schema.feedbackItems.id, `%${id}`),
    });
  }

  if (!item) {
    return c.json({ error: 'Not found' }, 404);
  }

  const tags = db
    .select()
    .from(schema.feedbackTags)
    .where(eq(schema.feedbackTags.feedbackId, id))
    .all()
    .map((t) => t.tag);
  const screenshots = db
    .select()
    .from(schema.feedbackScreenshots)
    .where(eq(schema.feedbackScreenshots.feedbackId, id))
    .all();
  const audioFiles = db
    .select()
    .from(schema.feedbackAudio)
    .where(eq(schema.feedbackAudio.feedbackId, id))
    .all();

  return c.json(hydrateFeedback(item, tags, screenshots, audioFiles));
});

feedbackRoutes.get('/feedback/:id/context', async (c) => {
  const id = c.req.param('id');
  const item = await db.query.feedbackItems.findFirst({
    where: eq(schema.feedbackItems.id, id),
  });

  if (!item) {
    return c.json({ error: 'Not found' }, 404);
  }

  const context = item.context ? JSON.parse(item.context) : null;
  const lines: string[] = [];

  lines.push(`# Feedback Context: ${id}`);
  lines.push(`Title: ${item.title}`);
  lines.push(`Description: ${item.description}`);
  lines.push(`URL: ${item.sourceUrl || 'N/A'}`);
  lines.push(`Created: ${item.createdAt}`);
  lines.push('');

  if (context?.environment) {
    const env = context.environment;
    lines.push('## Page Info');
    lines.push(`URL: ${env.url}`);
    lines.push(`Referrer: ${env.referrer || 'none'}`);
    lines.push(`Viewport: ${env.viewport}`);
    lines.push(`Screen: ${env.screenResolution}`);
    lines.push(`Platform: ${env.platform}`);
    lines.push(`Language: ${env.language}`);
    lines.push(`User-Agent: ${env.userAgent}`);
    lines.push(`Timestamp: ${new Date(env.timestamp).toISOString()}`);
    lines.push('');
  }

  if (context?.consoleLogs && context.consoleLogs.length > 0) {
    lines.push('## Console Logs');
    for (const log of context.consoleLogs) {
      const ts = new Date(log.timestamp).toISOString();
      lines.push(`[${ts}] ${log.level.toUpperCase()}: ${log.message}`);
    }
    lines.push('');
  }

  if (context?.networkErrors && context.networkErrors.length > 0) {
    lines.push('## Network Errors');
    for (const err of context.networkErrors) {
      const ts = new Date(err.timestamp).toISOString();
      lines.push(`[${ts}] ${err.method} ${err.url} → ${err.status} ${err.statusText}`);
    }
    lines.push('');
  }

  if (context?.performanceTiming) {
    const perf = context.performanceTiming;
    lines.push('## Performance');
    if (perf.loadTime != null) lines.push(`Load time: ${perf.loadTime.toFixed(1)}ms`);
    if (perf.domContentLoaded != null) lines.push(`DOM content loaded: ${perf.domContentLoaded.toFixed(1)}ms`);
    if (perf.firstContentfulPaint != null) lines.push(`First contentful paint: ${perf.firstContentfulPaint.toFixed(1)}ms`);
    lines.push('');
  }

  const screenshots = db
    .select()
    .from(schema.feedbackScreenshots)
    .where(eq(schema.feedbackScreenshots.feedbackId, id))
    .all();

  if (screenshots.length > 0) {
    lines.push('## Screenshots');
    for (const ss of screenshots) {
      const baseUrl = new URL(c.req.url).origin;
      lines.push(`- ${baseUrl}/api/v1/images/${ss.id} (${ss.mimeType}, ${ss.size} bytes)`);
    }
    lines.push('');
  }

  return c.text(lines.join('\n'));
});

feedbackRoutes.patch('/feedback/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = feedbackUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const existing = await db.query.feedbackItems.findFirst({
    where: eq(schema.feedbackItems.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (parsed.data.status) updates.status = parsed.data.status;
  if (parsed.data.title && parsed.data.title !== existing.title) {
    updates.title = parsed.data.title;
    let history: { title: string; changedAt: string }[] = [];
    if (existing.titleHistory) {
      try {
        const parsedHist = JSON.parse(existing.titleHistory);
        if (Array.isArray(parsedHist)) history = parsedHist;
      } catch { /* ignore */ }
    }
    history.push({ title: existing.title, changedAt: existing.updatedAt });
    updates.titleHistory = JSON.stringify(history);
  }
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;

  if (parsed.data.data) {
    const existingData = existing.data ? JSON.parse(existing.data as string) : {};
    updates.data = JSON.stringify({ ...existingData, ...parsed.data.data });
  }

  if (parsed.data.context) {
    const existingCtx = existing.context ? JSON.parse(existing.context as string) : {};
    const merged = { ...existingCtx };
    if (parsed.data.context.consoleLogs) {
      merged.consoleLogs = [...(existingCtx.consoleLogs || []), ...parsed.data.context.consoleLogs];
    }
    if (parsed.data.context.networkErrors) {
      merged.networkErrors = [...(existingCtx.networkErrors || []), ...parsed.data.context.networkErrors];
    }
    if (parsed.data.context.performanceTiming) {
      merged.performanceTiming = parsed.data.context.performanceTiming;
    }
    if (parsed.data.context.environment) {
      merged.environment = parsed.data.context.environment;
    }
    updates.context = JSON.stringify(merged);
  }

  await db.update(schema.feedbackItems).set(updates).where(eq(schema.feedbackItems.id, id));

  if (parsed.data.tags) {
    await db.delete(schema.feedbackTags).where(eq(schema.feedbackTags.feedbackId, id));
    if (parsed.data.tags.length > 0) {
      await db.insert(schema.feedbackTags).values(
        parsed.data.tags.map((tag) => ({ feedbackId: id, tag }))
      );
    }
  }

  return c.json({ id, updated: true });
});

feedbackRoutes.delete('/feedback/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db.query.feedbackItems.findFirst({
    where: eq(schema.feedbackItems.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  await db.delete(schema.feedbackItems).where(eq(schema.feedbackItems.id, id));
  return c.json({ id, deleted: true });
});

feedbackRoutes.post('/feedback/batch', async (c) => {
  const body = await c.req.json();
  const parsed = batchOperationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { ids, operation, value } = parsed.data;
  const now = new Date().toISOString();
  let affected = 0;

  for (const id of ids) {
    const existing = await db.query.feedbackItems.findFirst({
      where: eq(schema.feedbackItems.id, id),
    });
    if (!existing) continue;

    switch (operation) {
      case 'updateStatus':
        if (value) {
          await db.update(schema.feedbackItems)
            .set({ status: value, updatedAt: now })
            .where(eq(schema.feedbackItems.id, id));
          affected++;
        }
        break;
      case 'addTag':
        if (value) {
          const existingTag = db
            .select()
            .from(schema.feedbackTags)
            .where(and(eq(schema.feedbackTags.feedbackId, id), eq(schema.feedbackTags.tag, value)))
            .get();
          if (!existingTag) {
            await db.insert(schema.feedbackTags).values({ feedbackId: id, tag: value });
          }
          affected++;
        }
        break;
      case 'removeTag':
        if (value) {
          await db.delete(schema.feedbackTags)
            .where(and(eq(schema.feedbackTags.feedbackId, id), eq(schema.feedbackTags.tag, value)));
          affected++;
        }
        break;
      case 'delete':
        await db.update(schema.feedbackItems)
          .set({ status: 'deleted', updatedAt: now })
          .where(eq(schema.feedbackItems.id, id));
        affected++;
        break;
      case 'permanentDelete':
        await db.delete(schema.feedbackItems).where(eq(schema.feedbackItems.id, id));
        affected++;
        break;
    }
  }

  return c.json({ operation, affected });
});
