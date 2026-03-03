import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, desc, asc, like, and, or, isNull, sql, inArray, ne } from 'drizzle-orm';
import {
  feedbackListSchema,
  feedbackUpdateSchema,
  adminFeedbackCreateSchema,
  batchOperationSchema,
  agentEndpointSchema,
  dispatchSchema,
} from '@prompt-widget/shared';
import { db, schema } from '../db/index.js';
import {
  dispatchTerminalSession,
  dispatchTmuxAttachSession,
  dispatchAgentSession,
  dispatchCompanionTerminal,
  dispatchHarnessSession,
  hydrateFeedback,
  DEFAULT_PROMPT_TEMPLATE,
  dispatchFeedbackToAgent,
} from '../dispatch.js';
import { inputSessionRemote, getSessionStatus, SessionServiceError } from '../session-service-client.js';
import { killSession } from '../agent-sessions.js';
import { feedbackEvents } from '../events.js';
import { verifyAdminToken } from '../auth.js';
import { listLaunchers } from '../launcher-registry.js';

const PW_TMUX_CONF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tmux-pw.conf');

export const adminRoutes = new Hono();

adminRoutes.get('/feedback/events', async (c) => {
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

adminRoutes.post('/feedback', async (c) => {
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

adminRoutes.get('/feedback', async (c) => {
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
    const fb = hydrateFeedback(item, tags, screenshots);
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

adminRoutes.get('/feedback/:id', async (c) => {
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

  return c.json(hydrateFeedback(item, tags, screenshots));
});

adminRoutes.get('/feedback/:id/context', async (c) => {
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

adminRoutes.patch('/feedback/:id', async (c) => {
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
  if (parsed.data.title) updates.title = parsed.data.title;
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

adminRoutes.delete('/feedback/:id', async (c) => {
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

adminRoutes.post('/feedback/batch', async (c) => {
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

// Agent endpoints CRUD
adminRoutes.get('/agents', async (c) => {
  const appId = c.req.query('appId');
  let agents;
  if (appId) {
    agents = db.select().from(schema.agentEndpoints)
      .where(or(eq(schema.agentEndpoints.appId, appId), isNull(schema.agentEndpoints.appId)))
      .all();
  } else {
    agents = db.select().from(schema.agentEndpoints).all();
  }
  return c.json(agents);
});

adminRoutes.post('/agents', async (c) => {
  const body = await c.req.json();
  const parsed = agentEndpointSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();

  if (parsed.data.isDefault) {
    const condition = parsed.data.appId
      ? eq(schema.agentEndpoints.appId, parsed.data.appId)
      : isNull(schema.agentEndpoints.appId);
    await db.update(schema.agentEndpoints)
      .set({ isDefault: false, updatedAt: now })
      .where(condition);
  }

  await db.insert(schema.agentEndpoints).values({
    id,
    name: parsed.data.name,
    url: parsed.data.url || '',
    authHeader: parsed.data.authHeader || null,
    isDefault: parsed.data.isDefault,
    appId: parsed.data.appId || null,
    promptTemplate: parsed.data.promptTemplate || null,
    mode: parsed.data.mode || 'webhook',
    permissionProfile: parsed.data.permissionProfile || 'interactive',
    allowedTools: parsed.data.allowedTools || null,
    autoPlan: parsed.data.autoPlan || false,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id }, 201);
});

adminRoutes.patch('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = agentEndpointSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const existing = await db.query.agentEndpoints.findFirst({
    where: eq(schema.agentEndpoints.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  const now = new Date().toISOString();

  if (parsed.data.isDefault) {
    const condition = parsed.data.appId
      ? eq(schema.agentEndpoints.appId, parsed.data.appId)
      : isNull(schema.agentEndpoints.appId);
    await db.update(schema.agentEndpoints)
      .set({ isDefault: false, updatedAt: now })
      .where(condition);
  }

  await db.update(schema.agentEndpoints).set({
    name: parsed.data.name,
    url: parsed.data.url || '',
    authHeader: parsed.data.authHeader || null,
    isDefault: parsed.data.isDefault,
    appId: parsed.data.appId || null,
    promptTemplate: parsed.data.promptTemplate || null,
    mode: parsed.data.mode || 'webhook',
    permissionProfile: parsed.data.permissionProfile || 'interactive',
    allowedTools: parsed.data.allowedTools || null,
    autoPlan: parsed.data.autoPlan || false,
    updatedAt: now,
  }).where(eq(schema.agentEndpoints.id, id));

  return c.json({ id, updated: true });
});

adminRoutes.delete('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db.query.agentEndpoints.findFirst({
    where: eq(schema.agentEndpoints.id, id),
  });
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  await db.delete(schema.agentEndpoints).where(eq(schema.agentEndpoints.id, id));
  return c.json({ id, deleted: true });
});

// Dispatch targets (connected remote launchers + running harness configs)
adminRoutes.get('/dispatch-targets', (c) => {
  const launchers = listLaunchers();
  const launcherTargets = launchers
    .filter(l => !l.isLocal && l.ws?.readyState === 1)
    .map(l => {
      let machineName: string | null = null;
      let machineId: string | null = l.machineId || null;
      let defaultCwd: string | null = null;
      if (l.machineId) {
        const machine = db.select().from(schema.machines).where(eq(schema.machines.id, l.machineId)).get();
        if (machine) {
          machineName = machine.name;
          defaultCwd = machine.defaultCwd || null;
        }
      }
      return {
        launcherId: l.id,
        name: l.name,
        hostname: l.hostname,
        machineName,
        machineId,
        defaultCwd,
        isHarness: !!l.harness,
        harnessConfigId: l.harnessConfigId || null,
        activeSessions: l.activeSessions.size,
        maxSessions: l.capabilities.maxSessions,
      };
    });

  // Also include running harness configs whose launcher is connected but
  // that don't appear as separate harness launchers
  const launcherIds = new Set(launcherTargets.filter(t => t.isHarness).map(t => t.harnessConfigId));
  const harnessConfigs = db.select().from(schema.harnessConfigs)
    .where(eq(schema.harnessConfigs.status, 'running'))
    .all();
  for (const hc of harnessConfigs) {
    if (launcherIds.has(hc.id)) continue;
    if (!hc.launcherId) continue;
    const launcher = launchers.find(l => l.id === hc.launcherId);
    if (!launcher || launcher.ws?.readyState !== 1) continue;
    let hcDefaultCwd: string | null = null;
    if (launcher.machineId) {
      const m = db.select().from(schema.machines).where(eq(schema.machines.id, launcher.machineId)).get();
      if (m) hcDefaultCwd = m.defaultCwd || null;
    }
    launcherTargets.push({
      launcherId: launcher.id,
      name: hc.name || `harness-${hc.id.slice(-6)}`,
      hostname: launcher.hostname,
      machineName: null,
      machineId: launcher.machineId || null,
      defaultCwd: hcDefaultCwd,
      isHarness: true,
      harnessConfigId: hc.id,
      activeSessions: launcher.activeSessions.size,
      maxSessions: launcher.capabilities.maxSessions,
    });
  }

  return c.json({ targets: launcherTargets });
});

// Dispatch
adminRoutes.post('/dispatch', async (c) => {
  const body = await c.req.json();
  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { feedbackId, agentEndpointId, instructions, launcherId } = parsed.data;

  try {
    // Admin-specific: detect and kill stuck sessions before dispatching
    const agent = await db.query.agentEndpoints.findFirst({
      where: eq(schema.agentEndpoints.id, agentEndpointId),
    });
    if (agent) {
      const mode = (agent.mode || 'webhook') as string;
      if (mode !== 'webhook') {
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
          const ageMs = Date.now() - new Date(existing.createdAt).getTime();

          if (ageMs > 30_000) {
            const status = await getSessionStatus(existing.id);
            const stuck = !status || status.healthy === false || (status.totalBytes ?? 0) < 15_000;

            if (stuck) {
              console.log(`[admin] Stuck session detected: ${existing.id} (age=${Math.round(ageMs / 1000)}s, bytes=${status?.totalBytes ?? 0}, healthy=${status?.healthy}) — killing`);
              await killSession(existing.id);
            } else {
              return c.json({
                dispatched: true,
                sessionId: existing.id,
                status: 200,
                response: `Existing active session: ${existing.id}`,
                existing: true,
              });
            }
          } else {
            return c.json({
              dispatched: true,
              sessionId: existing.id,
              status: 200,
              response: `Existing active session: ${existing.id}`,
              existing: true,
            });
          }
        }
      }
    }

    const result = await dispatchFeedbackToAgent({ feedbackId, agentEndpointId, instructions, launcherId });
    return c.json(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    if (errorMsg === 'Feedback not found' || errorMsg === 'Agent endpoint not found') {
      return c.json({ error: errorMsg }, 404);
    }
    if (err instanceof SessionServiceError) {
      console.error(`[admin] Session service error during dispatch:`, errorMsg);
      return c.json({ dispatched: false, error: errorMsg }, 503);
    }
    console.error(`[admin] Dispatch error:`, errorMsg);
    return c.json({ dispatched: false, error: errorMsg }, 500);
  }
});

// Default prompt template
adminRoutes.get('/default-prompt-template', (c) => {
  return c.json({ template: DEFAULT_PROMPT_TEMPLATE });
});

// Tmux configs CRUD
adminRoutes.get('/tmux-configs', (c) => {
  const configs = db.select().from(schema.tmuxConfigs).all();
  return c.json(configs);
});

adminRoutes.post('/tmux-configs', async (c) => {
  const body = await c.req.json() as { name: string; content?: string };
  if (!body.name) return c.json({ error: 'Name required' }, 400);

  const now = new Date().toISOString();
  const id = ulid();
  db.insert(schema.tmuxConfigs).values({
    id,
    name: body.name,
    content: body.content || '',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  }).run();
  return c.json({ id }, 201);
});

adminRoutes.patch('/tmux-configs/:id', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json() as { name?: string; content?: string; isDefault?: boolean };
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (body.name !== undefined) updates.name = body.name;
  if (body.content !== undefined) updates.content = body.content;
  if (body.isDefault) {
    db.update(schema.tmuxConfigs).set({ isDefault: false, updatedAt: now }).run();
    updates.isDefault = true;
  }

  db.update(schema.tmuxConfigs).set(updates).where(eq(schema.tmuxConfigs.id, id)).run();
  return c.json({ id, updated: true });
});

adminRoutes.delete('/tmux-configs/:id', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.isDefault) return c.json({ error: 'Cannot delete the default config' }, 400);

  db.delete(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).run();
  return c.json({ id, deleted: true });
});

// Edit tmux config in terminal (nano/vim)
adminRoutes.post('/tmux-configs/:id/edit-terminal', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Not found' }, 404);

  const tmpPath = `/tmp/pw-tmux-edit-${id}.conf`;
  writeFileSync(tmpPath, config.content, 'utf-8');

  const { sessionId } = await dispatchTerminalSession({ cwd: '/tmp' });

  // Send editor command after shell is ready
  setTimeout(async () => {
    try {
      await inputSessionRemote(sessionId, `\${EDITOR:-nano} ${tmpPath}\r`);
    } catch (err) {
      console.error('[admin] Failed to send editor command:', err);
    }
  }, 800);

  return c.json({ sessionId, configId: id });
});

// Save tmux config back from temp file after terminal editing
adminRoutes.post('/tmux-configs/:id/save-from-file', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Config not found' }, 404);

  const tmpPath = `/tmp/pw-tmux-edit-${id}.conf`;
  let content: string;
  try {
    content = readFileSync(tmpPath, 'utf-8');
  } catch {
    return c.json({ error: 'Temp file not found — editor may not have saved yet' }, 404);
  }

  const now = new Date().toISOString();
  db.update(schema.tmuxConfigs)
    .set({ content, updatedAt: now })
    .where(eq(schema.tmuxConfigs.id, id)).run();

  try { unlinkSync(tmpPath); } catch {}

  return c.json({ saved: true, content });
});

// Tmux config endpoints — read/write tmux-pw.conf file directly
adminRoutes.get('/tmux-conf', (c) => {
  try {
    const content = readFileSync(PW_TMUX_CONF, 'utf-8');
    return c.json({ content });
  } catch {
    return c.json({ content: '' });
  }
});

adminRoutes.put('/tmux-conf', async (c) => {
  const { content } = await c.req.json() as { content: string };
  writeFileSync(PW_TMUX_CONF, content, 'utf-8');
  return c.json({ saved: true });
});

// Perf metrics
adminRoutes.post('/perf-metrics', async (c) => {
  const body = await c.req.json() as { route?: string; timestamp?: number; durations?: Record<string, number> };
  if (!body.route || !body.durations || typeof body.durations !== 'object') {
    return c.json({ error: 'route and durations required' }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();
  db.insert(schema.perfMetrics).values({
    id,
    route: body.route,
    durations: JSON.stringify(body.durations),
    userAgent: c.req.header('User-Agent') || null,
    createdAt: now,
  }).run();
  return c.json({ id }, 201);
});

adminRoutes.get('/perf-metrics', (c) => {
  const route = c.req.query('route');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 500);

  let rows;
  if (route) {
    rows = db.select().from(schema.perfMetrics)
      .where(eq(schema.perfMetrics.route, route))
      .orderBy(desc(schema.perfMetrics.createdAt))
      .limit(limit)
      .all();
  } else {
    rows = db.select().from(schema.perfMetrics)
      .orderBy(desc(schema.perfMetrics.createdAt))
      .limit(limit)
      .all();
  }

  return c.json(rows.map((r) => ({
    ...r,
    durations: JSON.parse(r.durations),
  })));
});

// Browse directories (for directory picker UI)
adminRoutes.get('/browse-dirs', (c) => {
  const raw = c.req.query('path') || homedir();
  const target = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  const resolved = resolve(target);
  try {
    const entries = readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith('.')) return false;
        return true;
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const parent = dirname(resolved);
    return c.json({ path: resolved, parent: parent !== resolved ? parent : null, dirs });
  } catch (err: any) {
    if (err.code === 'ENOENT') return c.json({ error: 'Directory not found', path: resolved }, 404);
    if (err.code === 'EACCES') return c.json({ error: 'Permission denied', path: resolved }, 403);
    return c.json({ error: err.message, path: resolved }, 500);
  }
});

// Read a file from disk (for file viewer panel)
adminRoutes.get('/read-file', (c) => {
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'path query parameter required' }, 400);
  const resolved = resolve(filePath);
  try {
    const stat = statSync(resolved);
    const ext = resolved.split('.').pop()?.toLowerCase() || '';
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
    if (imageExts.has(ext)) {
      const data = readFileSync(resolved);
      const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };
      return new Response(data, { headers: { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
    }
    if (stat.size > 2 * 1024 * 1024) return c.json({ error: 'File too large (>2MB)' }, 413);
    const content = readFileSync(resolved, 'utf-8');
    return c.json({ path: resolved, content, size: stat.size });
  } catch (err: any) {
    if (err.code === 'ENOENT') return c.json({ error: 'File not found', path: resolved }, 404);
    if (err.code === 'EACCES') return c.json({ error: 'Permission denied', path: resolved }, 403);
    if (err.code === 'EISDIR') return c.json({ error: 'Path is a directory', path: resolved }, 400);
    return c.json({ error: err.message }, 500);
  }
});

// Setup assist — AI assistant for configuring machines and harnesses
adminRoutes.post('/setup-assist', async (c) => {
  const body = await c.req.json();
  const { request, entityType, entityId } = body as {
    request?: string;
    entityType?: 'machine' | 'harness' | 'agent';
    entityId?: string;
  };

  if (!request?.trim()) return c.json({ error: 'request text is required' }, 400);
  if (!entityType) return c.json({ error: 'entityType is required' }, 400);

  // Look up the entity (if entityId provided)
  let entity: Record<string, unknown> | null = null;
  let machine: Record<string, unknown> | null = null;

  if (entityId) {
    if (entityType === 'machine') {
      const row = db.select().from(schema.machines).where(eq(schema.machines.id, entityId)).get();
      if (!row) return c.json({ error: 'Machine not found' }, 404);
      entity = { ...row, capabilities: row.capabilities ? JSON.parse(row.capabilities) : null, tags: row.tags ? JSON.parse(row.tags) : [] };
    } else if (entityType === 'harness') {
      const row = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, entityId)).get();
      if (!row) return c.json({ error: 'Harness config not found' }, 404);
      entity = { ...row, envVars: row.envVars ? JSON.parse(row.envVars) : null };
      if (row.machineId) {
        const mRow = db.select().from(schema.machines).where(eq(schema.machines.id, row.machineId)).get();
        if (mRow) machine = { ...mRow, capabilities: mRow.capabilities ? JSON.parse(mRow.capabilities) : null, tags: mRow.tags ? JSON.parse(mRow.tags) : [] };
      }
    } else if (entityType === 'agent') {
      const row = db.select().from(schema.agentEndpoints).where(eq(schema.agentEndpoints.id, entityId)).get();
      if (!row) return c.json({ error: 'Agent endpoint not found' }, 404);
      entity = { ...row };
    }
  }

  // Find agent endpoint (default → any)
  let agentEndpointId: string | null = null;
  const defaultAgent = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.isDefault, true)).get();
  if (defaultAgent) {
    agentEndpointId = defaultAgent.id;
  } else {
    const anyAgent = db.select().from(schema.agentEndpoints).get();
    if (anyAgent) agentEndpointId = anyAgent.id;
  }
  if (!agentEndpointId) return c.json({ error: 'No agent endpoint configured' }, 400);

  const agentRow = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, agentEndpointId)).get();
  if (!agentRow) return c.json({ error: 'Agent endpoint not found' }, 404);

  const host = c.req.header('host') || 'localhost:3001';
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const baseUrl = `${proto}://${host}`;

  // Spawn companion terminal for machine entities that have a hostname/address
  let companionSessionId: string | null = null;
  let companionTmuxName: string | null = null;
  if (entityType === 'machine' && entity && ((entity as any).hostname || (entity as any).address)) {
    try {
      const companion = await dispatchCompanionTerminal({
        parentSessionId: '', // will link after agent session is created
        cwd: process.cwd(),
      });
      companionSessionId = companion.sessionId;
      companionTmuxName = `pw-${companionSessionId}`;
    } catch (err) {
      console.warn('[setup-assist] Failed to spawn companion terminal:', err);
    }
  }

  const prompt = entity
    ? buildSetupPrompt(entityType as 'machine' | 'harness' | 'agent', entity, machine, request.trim(), baseUrl, companionTmuxName)
    : buildNewEntityPrompt(entityType, request.trim(), baseUrl);

  // Create feedback item
  const feedbackId = ulid();
  const now = new Date().toISOString();
  const entityLabel = entity ? ((entity as any).name || entityId!.slice(0, 8)) : `New ${entityType}`;
  db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'request',
    status: 'dispatched',
    title: `[Setup Assist] ${entityLabel}: ${request.trim().slice(0, 60)}`,
    description: request.trim(),
    dispatchedTo: agentRow.name,
    dispatchedAt: now,
    dispatchStatus: 'dispatched',
    createdAt: now,
    updatedAt: now,
  }).run();

  try {
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd: process.cwd(),
      permissionProfile: 'interactive' as any,
      allowedTools: agentRow.allowedTools,
    });

    // Link companion terminal to agent session
    if (companionSessionId) {
      db.update(schema.agentSessions)
        .set({ companionSessionId })
        .where(eq(schema.agentSessions.id, sessionId))
        .run();
      // Also set parentSessionId on the companion
      db.update(schema.agentSessions)
        .set({ parentSessionId: sessionId })
        .where(eq(schema.agentSessions.id, companionSessionId))
        .run();
    }

    return c.json({ sessionId, feedbackId, companionSessionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});

function buildSetupPrompt(
  entityType: 'machine' | 'harness' | 'agent',
  entity: Record<string, unknown>,
  machine: Record<string, unknown> | null,
  request: string,
  baseUrl: string,
  companionTmuxName?: string | null,
): string {
  const parts: string[] = [];
  const typeLabel = entityType === 'machine' ? 'Machine' : entityType === 'harness' ? 'Harness' : 'Agent';
  parts.push(`# Setup Assistant — ${typeLabel} Configuration`);
  parts.push('');

  if (entityType === 'agent') {
    const a = entity as any;
    parts.push('## Current Agent Configuration');
    parts.push(`- **ID**: ${a.id}`);
    parts.push(`- **Name**: ${a.name}`);
    parts.push(`- **Mode**: ${a.mode || 'interactive'}`);
    parts.push(`- **Permission Profile**: ${a.permissionProfile || 'interactive'}`);
    parts.push(`- **Is Default**: ${a.isDefault ? 'Yes' : 'No'}`);
    parts.push(`- **App ID**: ${a.appId || '(global)'}`);
    parts.push(`- **Allowed Tools**: ${a.allowedTools || '(none)'}`);
    parts.push(`- **Auto Plan**: ${a.autoPlan ? 'Yes' : 'No'}`);
    if (a.url) parts.push(`- **Webhook URL**: ${a.url}`);
    parts.push('');
    parts.push('## Update API');
    parts.push(`PATCH ${baseUrl}/api/v1/admin/agents/${a.id}`);
    parts.push('Fields: name, url, authHeader, isDefault, appId, mode (interactive|headless|webhook), promptTemplate, permissionProfile (interactive|auto|yolo), allowedTools, autoPlan');
    parts.push('');
  } else if (entityType === 'machine') {
    const m = entity as any;
    parts.push('## Current Machine Configuration');
    parts.push(`- **ID**: ${m.id}`);
    parts.push(`- **Name**: ${m.name}`);
    parts.push(`- **Hostname**: ${m.hostname || '(not set)'}`);
    parts.push(`- **Address**: ${m.address || '(not set)'}`);
    parts.push(`- **Type**: ${m.type}`);
    parts.push(`- **Status**: ${m.status}`);
    parts.push(`- **Capabilities**: ${JSON.stringify(m.capabilities || {})}`);
    parts.push(`- **Tags**: ${(m.tags || []).join(', ') || '(none)'}`);
    parts.push('');
    parts.push('## Update API');
    parts.push(`PATCH ${baseUrl}/api/v1/admin/machines/${m.id}`);
    parts.push('Fields: name, hostname, address, type, capabilities (object with hasDocker, hasTmux, hasClaudeCli booleans), tags (string array), authToken');
    parts.push('');
    parts.push('## Setup Steps');
    parts.push('1. If the machine has an address, verify SSH connectivity: `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new <address> "echo ok"`');
    parts.push('2. Check for Docker: `ssh <address> "docker --version" 2>&1`');
    parts.push('3. Check for tmux: `ssh <address> "tmux -V" 2>&1`');
    parts.push('4. Check for Claude CLI: `ssh <address> "which claude" 2>&1`');
    parts.push('5. Update capabilities via the PATCH API: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/' + m.id + ' -H "Content-Type: application/json" -d \'{"capabilities":{"hasDocker":true,"hasTmux":true,"hasClaudeCli":false}}\'`');
    parts.push('6. Help configure auth token for launcher daemon if requested');
    parts.push('');
    parts.push('Note: The admin UI auto-refreshes every 10 seconds, so updates via PATCH will appear automatically.');
  } else {
    const h = entity as any;
    parts.push('## Current Harness Configuration');
    parts.push(`- **ID**: ${h.id}`);
    parts.push(`- **Name**: ${h.name}`);
    parts.push(`- **Status**: ${h.status}`);
    parts.push(`- **App ID**: ${h.appId || '(none)'}`);
    parts.push(`- **Machine ID**: ${h.machineId || '(none)'}`);
    parts.push(`- **App Image**: ${h.appImage || '(not set)'}`);
    parts.push(`- **App Port**: ${h.appPort || '(not set)'}`);
    parts.push(`- **Internal Port**: ${h.appInternalPort || '(not set)'}`);
    parts.push(`- **Server Port**: ${h.serverPort || '(not set)'}`);
    parts.push(`- **Browser MCP Port**: ${h.browserMcpPort || '(not set)'}`);
    parts.push(`- **Target App URL**: ${h.targetAppUrl || '(not set)'}`);
    parts.push(`- **Env Vars**: ${JSON.stringify(h.envVars || {})}`);
    if (machine) {
      const m = machine as any;
      parts.push('');
      parts.push('## Assigned Machine');
      parts.push(`- **Name**: ${m.name}`);
      parts.push(`- **Address**: ${m.address || '(not set)'}`);
      parts.push(`- **Capabilities**: ${JSON.stringify(m.capabilities || {})}`);
    }
    parts.push('');
    parts.push('## Update API');
    parts.push(`PATCH ${baseUrl}/api/v1/admin/harness-configs/${h.id}`);
    parts.push('Fields: name, appId, machineId, appImage, appPort, appInternalPort, serverPort, browserMcpPort, targetAppUrl, envVars (JSON object)');
    parts.push('');
    parts.push('## Setup Steps');
    parts.push('1. If a machine is assigned, verify Docker is available: `ssh <machine-address> "docker --version"`');
    parts.push('2. If an app image is set, check if it exists: `ssh <machine-address> "docker image inspect <image>" 2>&1`');
    parts.push('3. Help configure ports (ensure no conflicts)');
    parts.push('4. Set up environment variables as needed');
    parts.push('5. Update config via the PATCH API: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/harness-configs/' + h.id + ' -H "Content-Type: application/json" -d \'{"appPort":8080}\'`');
    parts.push('');
    parts.push('Note: The admin UI auto-refreshes every 10 seconds, so updates via PATCH will appear automatically.');
  }

  if (companionTmuxName) {
    parts.push('');
    parts.push('## Companion Terminal');
    parts.push(`You have a companion terminal at tmux session \`${companionTmuxName}\`.`);
    parts.push(`Use \`tmux send-keys -t ${companionTmuxName} "command" Enter\` to run commands.`);
    parts.push(`Use \`tmux capture-pane -t ${companionTmuxName} -p\` to read output.`);
    parts.push('Use the companion terminal for SSH connectivity checks, capability detection, and any shell commands needed for setup.');
  }

  parts.push('');
  parts.push('## User Request');
  parts.push(request);
  parts.push('');
  parts.push('## Instructions');
  parts.push('- Ask clarifying questions if the request is ambiguous');
  parts.push('- Use the PATCH API to update fields as you discover information');
  parts.push('- Show the user what you find and what you plan to update before making changes');
  if (companionTmuxName) {
    parts.push('- Use the companion terminal for running shell commands instead of trying to execute them directly');
  }

  return parts.join('\n');
}

function buildNewEntityPrompt(
  entityType: 'machine' | 'harness' | 'agent',
  request: string,
  baseUrl: string,
): string {
  const parts: string[] = [];
  const typeLabel = entityType === 'machine' ? 'Machine' : entityType === 'harness' ? 'Harness' : 'Agent';
  parts.push(`# Setup Assistant — Create New ${typeLabel}`);
  parts.push('');

  // Gather existing entities for context
  if (entityType === 'machine') {
    const existing = db.select().from(schema.machines).all();
    if (existing.length > 0) {
      parts.push('## Existing Machines');
      for (const m of existing) {
        parts.push(`- ${m.name} (${m.type}, ${m.status}) — ${m.hostname || m.address || 'no address'}`);
      }
      parts.push('');
    }
    parts.push('## Create API');
    parts.push(`POST ${baseUrl}/api/v1/admin/machines`);
    parts.push('Fields: name (required), hostname, address, type (local|remote|cloud), capabilities (object with hasDocker, hasTmux, hasClaudeCli booleans), tags (string array)');
    parts.push('');
    parts.push('## Workflow');
    parts.push('1. Ask the user for the machine details (name, hostname/address, type)');
    parts.push('2. Create the machine via POST API');
    parts.push('3. If the machine has an address, verify SSH connectivity');
    parts.push('4. Detect capabilities (Docker, tmux, Claude CLI)');
    parts.push('5. Update capabilities via PATCH API');
  } else if (entityType === 'harness') {
    const existing = db.select().from(schema.harnessConfigs).all();
    const machineList = db.select().from(schema.machines).all();
    const appList = db.select().from(schema.applications).all();
    if (existing.length > 0) {
      parts.push('## Existing Harness Configs');
      for (const h of existing) {
        parts.push(`- ${h.name} (${h.status}) — image: ${h.appImage || 'none'}`);
      }
      parts.push('');
    }
    if (machineList.length > 0) {
      parts.push('## Available Machines');
      for (const m of machineList) {
        parts.push(`- ${m.name} (id: ${m.id}, ${m.type}, ${m.status})`);
      }
      parts.push('');
    }
    if (appList.length > 0) {
      parts.push('## Available Applications');
      for (const a of appList) {
        parts.push(`- ${a.name} (id: ${a.id})`);
      }
      parts.push('');
    }
    parts.push('## Create API');
    parts.push(`POST ${baseUrl}/api/v1/admin/harness-configs`);
    parts.push('Fields: name (required), appId, machineId, appImage, appPort, appInternalPort, serverPort, browserMcpPort, targetAppUrl, envVars (JSON object)');
    parts.push('');
    parts.push('## Workflow');
    parts.push('1. Ask the user which application and machine to use');
    parts.push('2. Help choose Docker image and configure ports');
    parts.push('3. Create the harness config via POST API');
    parts.push('4. Suggest starting the harness if ready');
  } else {
    const existing = db.select().from(schema.agentEndpoints).all();
    const appList = db.select().from(schema.applications).all();
    if (existing.length > 0) {
      parts.push('## Existing Agents');
      for (const a of existing) {
        parts.push(`- ${a.name} (${a.mode || 'interactive'}, ${a.isDefault ? 'default' : 'non-default'})`);
      }
      parts.push('');
    }
    if (appList.length > 0) {
      parts.push('## Available Applications');
      for (const a of appList) {
        parts.push(`- ${a.name} (id: ${a.id})`);
      }
      parts.push('');
    }
    parts.push('## Create API');
    parts.push(`POST ${baseUrl}/api/v1/admin/agents`);
    parts.push('Fields: name (required), mode (interactive|headless|webhook), permissionProfile (interactive|auto|yolo), isDefault, appId, allowedTools, autoPlan, url (webhook only), authHeader (webhook only), promptTemplate');
    parts.push('');
    parts.push('## Agent Modes');
    parts.push('- **interactive**: Claude Code runs in a terminal with real-time supervision. Best for development.');
    parts.push('- **headless**: Claude Code runs without a terminal UI. Good for automation.');
    parts.push('- **webhook**: Forwards dispatch to an external URL. For custom integrations.');
    parts.push('');
    parts.push('## Permission Levels');
    parts.push('- **interactive**: User approves each tool use in real-time');
    parts.push('- **auto**: Pre-approved tools run automatically, others prompt');
    parts.push('- **yolo**: No permission checks (only use in sandboxed environments)');
    parts.push('');
    parts.push('## Workflow');
    parts.push('1. Ask the user what kind of agent they need');
    parts.push('2. Recommend mode and permission level based on use case');
    parts.push('3. Create the agent via POST API');
    parts.push('4. Optionally set as default if no default exists');
  }

  parts.push('');
  parts.push('## User Request');
  parts.push(request);
  parts.push('');
  parts.push('## Instructions');
  parts.push('- Ask clarifying questions if the request is ambiguous');
  parts.push('- Use the POST API to create the new entity');
  parts.push('- Show the user what you plan to create before making the API call');
  parts.push('- The admin UI auto-refreshes every 10 seconds, so new entities will appear automatically');

  return parts.join('\n');
}

// Plain terminal session (no agent, no feedback)
adminRoutes.post('/terminal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cwd, appId, launcherId, harnessConfigId } = body as { cwd?: string; appId?: string; launcherId?: string; harnessConfigId?: string };
  // Harness terminal: exec into the container
  if (harnessConfigId && launcherId) {
    try {
      const hc = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, harnessConfigId)).get();
      const { sessionId } = await dispatchHarnessSession({
        harnessConfigId,
        launcherId,
        prompt: '',
        composeDir: hc?.composeDir || undefined,
        serviceName: 'pw-server',
        permissionProfile: 'plain',
      });
      return c.json({ sessionId });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: errorMsg }, 500);
    }
  }

  let resolvedCwd = cwd || process.cwd();
  if (!cwd && appId) {
    const app = await db.query.applications.findFirst({
      where: eq(schema.applications.id, appId),
    });
    if (app?.projectDir) resolvedCwd = app.projectDir;
  }

  try {
    const { sessionId } = await dispatchTerminalSession({ cwd: resolvedCwd, appId, launcherId });
    return c.json({ sessionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});

// List tmux sessions from the default tmux server
adminRoutes.get('/tmux-sessions', async (c) => {
  const { listDefaultTmuxSessions } = await import('../tmux-pty.js');
  return c.json({ sessions: listDefaultTmuxSessions() });
});

// Attach to an existing tmux session from the default server
adminRoutes.post('/terminal/attach-tmux', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { tmuxTarget, appId } = body as { tmuxTarget?: string; appId?: string };

  if (!tmuxTarget) {
    return c.json({ error: 'tmuxTarget is required' }, 400);
  }

  try {
    const { sessionId } = await dispatchTmuxAttachSession({ tmuxTarget, appId });
    return c.json({ sessionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});
