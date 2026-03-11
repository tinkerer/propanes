import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../db/index.js';
import { listLaunchers, getLauncher, sendAndWait } from '../launcher-registry.js';
import { dispatchHarnessSession } from '../dispatch.js';
import type { StartHarness, StopHarness, PermissionProfile, ListTmuxSessions, ListTmuxSessionsResult, CheckClaudeAuth, CheckClaudeAuthResult, CheckContainerClaude, CheckContainerClaudeResult } from '@prompt-widget/shared';

const app = new Hono();

function serializeHarnessConfig(row: typeof schema.harnessConfigs.$inferSelect) {
  return {
    ...row,
    envVars: row.envVars ? JSON.parse(row.envVars) : null,
  };
}

app.get('/', (c) => {
  const appId = c.req.query('appId');
  let rows;
  if (appId) {
    rows = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.appId, appId)).all();
  } else {
    rows = db.select().from(schema.harnessConfigs).all();
  }
  return c.json(rows.map(serializeHarnessConfig));
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = ulid();

  db.insert(schema.harnessConfigs)
    .values({
      id,
      appId: body.appId || null,
      machineId: body.machineId || null,
      name: body.name || 'Unnamed Harness',
      status: 'stopped',
      appImage: body.appImage || null,
      appPort: body.appPort || null,
      appInternalPort: body.appInternalPort || null,
      serverPort: body.serverPort || null,
      browserMcpPort: body.browserMcpPort || null,
      targetAppUrl: body.targetAppUrl || null,
      composeDir: body.composeDir || null,
      envVars: body.envVars ? JSON.stringify(body.envVars) : null,
      hostTerminalAccess: body.hostTerminalAccess ?? false,
      claudeHomePath: body.claudeHomePath || null,
      anthropicApiKey: body.anthropicApiKey || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const row = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  return c.json(serializeHarnessConfig(row!), 201);
});

app.get('/:id', (c) => {
  const row = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Harness config not found' }, 404);
  return c.json(serializeHarnessConfig(row));
});

app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Harness config not found' }, 404);

  const body = await c.req.json();
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };

  if (body.appId !== undefined) updates.appId = body.appId;
  if (body.machineId !== undefined) updates.machineId = body.machineId;
  if (body.name !== undefined) updates.name = body.name;
  if (body.appImage !== undefined) updates.appImage = body.appImage;
  if (body.appPort !== undefined) updates.appPort = body.appPort;
  if (body.appInternalPort !== undefined) updates.appInternalPort = body.appInternalPort;
  if (body.serverPort !== undefined) updates.serverPort = body.serverPort;
  if (body.browserMcpPort !== undefined) updates.browserMcpPort = body.browserMcpPort;
  if (body.targetAppUrl !== undefined) updates.targetAppUrl = body.targetAppUrl;
  if (body.composeDir !== undefined) updates.composeDir = body.composeDir;
  if (body.envVars !== undefined) updates.envVars = body.envVars ? JSON.stringify(body.envVars) : null;
  if (body.hostTerminalAccess !== undefined) updates.hostTerminalAccess = body.hostTerminalAccess;
  if (body.claudeHomePath !== undefined) updates.claudeHomePath = body.claudeHomePath;
  if (body.anthropicApiKey !== undefined) updates.anthropicApiKey = body.anthropicApiKey;

  db.update(schema.harnessConfigs).set(updates).where(eq(schema.harnessConfigs.id, id)).run();
  const row = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  return c.json(serializeHarnessConfig(row!));
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Harness config not found' }, 404);

  db.delete(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).run();
  return c.json({ ok: true, id });
});

app.post('/:id/start', (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);

  if (!config.machineId) {
    return c.json({ error: 'No machine assigned to this harness' }, 400);
  }

  // Find a launcher connected from this machine
  const launchers = listLaunchers();
  const machineLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  if (!machineLauncher) {
    return c.json({ error: 'Machine is offline — no launcher connected' }, 400);
  }

  const msg: StartHarness = {
    type: 'start_harness',
    harnessConfigId: id,
    appImage: config.appImage || undefined,
    appPort: config.appPort || undefined,
    appInternalPort: config.appInternalPort || undefined,
    serverPort: config.serverPort || undefined,
    browserMcpPort: config.browserMcpPort || undefined,
    targetAppUrl: config.targetAppUrl || undefined,
    composeDir: config.composeDir || undefined,
    envVars: config.envVars ? JSON.parse(config.envVars) : undefined,
    claudeHomePath: config.claudeHomePath || undefined,
    anthropicApiKey: config.anthropicApiKey || undefined,
  };

  try {
    machineLauncher.ws.send(JSON.stringify(msg));
  } catch (err) {
    return c.json({ error: 'Failed to send start command to launcher' }, 500);
  }

  const now = new Date().toISOString();
  db.update(schema.harnessConfigs)
    .set({ status: 'starting', lastStartedAt: now, errorMessage: null, updatedAt: now })
    .where(eq(schema.harnessConfigs.id, id))
    .run();

  return c.json({ ok: true, status: 'starting' });
});

app.post('/:id/stop', (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);

  // Find the launcher that's running this harness
  let targetLauncher;
  if (config.launcherId) {
    targetLauncher = getLauncher(config.launcherId);
  }
  if (!targetLauncher && config.machineId) {
    const launchers = listLaunchers();
    targetLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }

  if (targetLauncher && targetLauncher.ws?.readyState === 1) {
    const msg: StopHarness = {
      type: 'stop_harness',
      harnessConfigId: id,
      composeDir: config.composeDir || undefined,
    };
    try {
      targetLauncher.ws.send(JSON.stringify(msg));
    } catch {}
  }

  const now = new Date().toISOString();
  db.update(schema.harnessConfigs)
    .set({ status: 'stopping', updatedAt: now })
    .where(eq(schema.harnessConfigs.id, id))
    .run();

  return c.json({ ok: true, status: 'stopping' });
});

app.post('/:id/session', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);

  if (config.status !== 'running') {
    return c.json({ error: 'Harness is not running' }, 400);
  }

  // Find the launcher for this harness
  let targetLauncher;
  if (config.launcherId) {
    targetLauncher = getLauncher(config.launcherId);
  }
  if (!targetLauncher && config.machineId) {
    const launchers = listLaunchers();
    targetLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }

  if (!targetLauncher || targetLauncher.ws?.readyState !== 1) {
    return c.json({ error: 'No connected launcher for this harness' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const prompt = body.prompt || 'You are running inside a harness container. Await instructions.';
  const permissionProfile = (body.permissionProfile || 'yolo') as PermissionProfile;

  try {
    const { sessionId } = await dispatchHarnessSession({
      harnessConfigId: id,
      launcherId: targetLauncher.id,
      prompt,
      composeDir: config.composeDir || undefined,
      serviceName: body.serviceName || 'pw-server',
      permissionProfile,
    });
    return c.json({ ok: true, sessionId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/:id/check-auth', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);

  let targetLauncher;
  if (config.launcherId) targetLauncher = getLauncher(config.launcherId);
  if (!targetLauncher && config.machineId) {
    const launchers = listLaunchers();
    targetLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }
  if (!targetLauncher || targetLauncher.ws?.readyState !== 1) {
    return c.json({ error: 'No connected launcher for this harness' }, 400);
  }

  try {
    const sessionId = ulid();
    const msg: CheckClaudeAuth = {
      type: 'check_claude_auth',
      sessionId,
      claudeHomePath: config.claudeHomePath || undefined,
    };
    const result = await sendAndWait(targetLauncher.id, msg as any, 'check_claude_auth_result', 15_000) as CheckClaudeAuthResult;
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/:id/check-container-claude', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);
  if (config.status !== 'running') return c.json({ error: 'Harness is not running' }, 400);

  let targetLauncher;
  if (config.launcherId) targetLauncher = getLauncher(config.launcherId);
  if (!targetLauncher && config.machineId) {
    const launchers = listLaunchers();
    targetLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }
  if (!targetLauncher || targetLauncher.ws?.readyState !== 1) {
    return c.json({ error: 'No connected launcher for this harness' }, 400);
  }

  try {
    const sessionId = ulid();
    const msg: CheckContainerClaude = {
      type: 'check_container_claude',
      sessionId,
      harnessConfigId: id,
      composeDir: config.composeDir || undefined,
    };
    const result = await sendAndWait(targetLauncher.id, msg as any, 'check_container_claude_result', 20_000) as CheckContainerClaudeResult;
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/:id/host-tmux-sessions', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);

  if (!config.hostTerminalAccess) {
    return c.json({ error: 'Host terminal access is not enabled for this harness' }, 400);
  }

  // Find the launcher for the machine
  let targetLauncher;
  if (config.launcherId) {
    targetLauncher = getLauncher(config.launcherId);
  }
  if (!targetLauncher && config.machineId) {
    const launchers = listLaunchers();
    targetLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }

  if (!targetLauncher || targetLauncher.ws?.readyState !== 1) {
    return c.json({ error: 'No connected launcher for this harness' }, 400);
  }

  try {
    const sessionId = ulid();
    const msg: ListTmuxSessions = {
      type: 'list_tmux_sessions',
      sessionId,
    };
    const result = await sendAndWait(targetLauncher.id, msg, 'list_tmux_sessions_result', 10_000) as ListTmuxSessionsResult;
    return c.json({ sessions: result.sessions });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
