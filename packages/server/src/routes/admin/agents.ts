import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { agentEndpointSchema, dispatchSchema } from '@propanes/shared';
import { db, schema } from '../../db/index.js';
import {
  dispatchFeedbackToAgent,
  DEFAULT_PROMPT_TEMPLATE,
} from '../../dispatch.js';
import { getSessionStatus, SessionServiceError } from '../../session-service-client.js';
import { killSession } from '../../agent-sessions.js';
import { listLaunchers, getLauncher } from '../../launcher-registry.js';
import { countActiveSpriteSessions } from '../../sprite-sessions.js';

export const agentRoutes = new Hono();

// Agent endpoints CRUD
agentRoutes.get('/agents', async (c) => {
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

agentRoutes.post('/agents', async (c) => {
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

agentRoutes.patch('/agents/:id', async (c) => {
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
    preferredLauncherId: parsed.data.preferredLauncherId ?? existing.preferredLauncherId,
    harnessConfigId: parsed.data.harnessConfigId ?? existing.harnessConfigId,
    spriteConfigId: parsed.data.spriteConfigId ?? existing.spriteConfigId,
    updatedAt: now,
  }).where(eq(schema.agentEndpoints.id, id));

  return c.json({ id, updated: true });
});

agentRoutes.delete('/agents/:id', async (c) => {
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

// Dispatch targets (connected remote launchers + running harness configs + DB-sourced offline targets)
agentRoutes.get('/dispatch-targets', (c) => {
  const launchers = listLaunchers();
  const launcherTargets: Array<Record<string, unknown>> = launchers
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
        online: true,
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
      online: true,
    });
  }

  // Include DB-sourced machines with status='online' that don't already have a connected launcher
  const connectedMachineIds = new Set(launcherTargets.filter(t => !t.isHarness && t.machineId).map(t => t.machineId));
  const dbMachines = db.select().from(schema.machines)
    .where(eq(schema.machines.status, 'online'))
    .all();
  for (const m of dbMachines) {
    if (connectedMachineIds.has(m.id)) continue;
    if (m.type === 'local') continue;
    launcherTargets.push({
      launcherId: `db-machine:${m.id}`,
      name: m.name,
      hostname: m.hostname || m.address || '',
      machineName: m.name,
      machineId: m.id,
      defaultCwd: m.defaultCwd || null,
      isHarness: false,
      harnessConfigId: null,
      activeSessions: 0,
      maxSessions: 0,
      online: false,
    });
  }

  // Include DB-sourced harness configs with status='running' that don't already have a target
  const existingHarnessIds = new Set(launcherTargets.filter(t => t.isHarness && t.harnessConfigId).map(t => t.harnessConfigId));
  for (const hc of harnessConfigs) {
    if (existingHarnessIds.has(hc.id)) continue;
    launcherTargets.push({
      launcherId: `db-harness:${hc.id}`,
      name: hc.name || `harness-${hc.id.slice(-6)}`,
      hostname: '',
      machineName: null,
      machineId: hc.machineId || null,
      defaultCwd: null,
      isHarness: true,
      harnessConfigId: hc.id,
      activeSessions: 0,
      maxSessions: 0,
      online: false,
    });
  }

  // Include sprite configs as targets
  const spriteConfigs = db.select().from(schema.spriteConfigs).all();
  for (const sc of spriteConfigs) {
    launcherTargets.push({
      launcherId: `sprite:${sc.id}`,
      name: sc.name,
      hostname: `${sc.spriteName}.sprites.app`,
      machineName: null,
      machineId: null,
      defaultCwd: sc.defaultCwd || null,
      isHarness: false,
      isSprite: true,
      spriteConfigId: sc.id,
      harnessConfigId: null,
      activeSessions: countActiveSpriteSessions(sc.id),
      maxSessions: sc.maxSessions,
      online: sc.status !== 'error' && sc.status !== 'destroyed',
    });
  }

  return c.json({ targets: launcherTargets });
});

// Dispatch
agentRoutes.post('/dispatch', async (c) => {
  const body = await c.req.json();
  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { feedbackId, agentEndpointId, instructions, launcherId, harnessConfigId } = parsed.data;

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

    const result = await dispatchFeedbackToAgent({ feedbackId, agentEndpointId, instructions, launcherId, harnessConfigId });
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
agentRoutes.get('/default-prompt-template', (c) => {
  return c.json({ template: DEFAULT_PROMPT_TEMPLATE });
});
