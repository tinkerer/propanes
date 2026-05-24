import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { db, schema } from '../db/index.js';
import { listLaunchers } from '../launcher-registry.js';

const app = new Hono();

function serializeMachine(row: typeof schema.machines.$inferSelect) {
  return {
    ...row,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

function collectDiskStats() {
  try {
    const isLinux = process.platform === 'linux';
    const output = execSync(isLinux ? 'df -B1 -P -x tmpfs -x devtmpfs' : 'df -k -P', { stdio: 'pipe', timeout: 5_000 }).toString();
    const blockSize = isLinux ? 1 : 1024;
    return output.trim().split('\n').slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        total: (Number(parts[1]) || 0) * blockSize,
        used: (Number(parts[2]) || 0) * blockSize,
        available: (Number(parts[3]) || 0) * blockSize,
        usePercent: Number((parts[4] || '').replace('%', '')) || 0,
        mount: parts.slice(5).join(' '),
      };
    }).filter((disk) => disk.mount && disk.total > 0);
  } catch {
    return [];
  }
}

function collectNetworkStats() {
  try {
    return readFileSync('/proc/net/dev', 'utf-8').trim().split('\n').slice(2).map((line) => {
      const [ifaceRaw, valuesRaw] = line.split(':');
      const values = valuesRaw.trim().split(/\s+/).map((v) => Number(v) || 0);
      return { interface: ifaceRaw.trim(), rxBytes: values[0] || 0, txBytes: values[8] || 0 };
    }).filter((net) => net.interface !== 'lo');
  } catch {
    return [];
  }
}

app.get('/', (c) => {
  const rows = db.select().from(schema.machines).all();

  // Merge live launcher status
  const launchers = listLaunchers();
  const machineMap = new Map(rows.map(r => [r.id, serializeMachine(r)]));
  for (const launcher of launchers) {
    if (launcher.machineId && machineMap.has(launcher.machineId)) {
      const m = machineMap.get(launcher.machineId)!;
      m.status = 'online';
    }
  }

  return c.json(Array.from(machineMap.values()));
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = ulid();

  db.insert(schema.machines)
    .values({
      id,
      name: body.name || 'Unnamed Machine',
      hostname: body.hostname || null,
      address: body.address || null,
      type: body.type || 'local',
      status: 'offline',
      capabilities: body.capabilities ? JSON.stringify(body.capabilities) : null,
      tags: body.tags ? JSON.stringify(body.tags) : null,
      authToken: body.authToken || null,
      defaultCwd: body.defaultCwd || null,
      adminUrl: body.adminUrl || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const row = db.select().from(schema.machines).where(eq(schema.machines.id, id)).get();
  return c.json(serializeMachine(row!), 201);
});

app.get('/:id', (c) => {
  const row = db.select().from(schema.machines).where(eq(schema.machines.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Machine not found' }, 404);

  const machine = serializeMachine(row);
  // Check live status
  const launchers = listLaunchers();
  for (const l of launchers) {
    if (l.machineId === row.id) {
      machine.status = 'online';
      break;
    }
  }

  return c.json(machine);
});

app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.machines).where(eq(schema.machines.id, id)).get();
  if (!existing) return c.json({ error: 'Machine not found' }, 404);

  const body = await c.req.json();
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };

  if (body.name !== undefined) updates.name = body.name;
  if (body.hostname !== undefined) updates.hostname = body.hostname;
  if (body.address !== undefined) updates.address = body.address;
  if (body.type !== undefined) updates.type = body.type;
  if (body.capabilities !== undefined) updates.capabilities = JSON.stringify(body.capabilities);
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags);
  if (body.authToken !== undefined) updates.authToken = body.authToken;
  if (body.defaultCwd !== undefined) updates.defaultCwd = body.defaultCwd;
  if (body.adminUrl !== undefined) updates.adminUrl = body.adminUrl;

  db.update(schema.machines).set(updates).where(eq(schema.machines.id, id)).run();
  const row = db.select().from(schema.machines).where(eq(schema.machines.id, id)).get();
  return c.json(serializeMachine(row!));
});

// Probe a machine's adminUrl to check if it's alive
app.get('/:id/admin-health', async (c) => {
  const row = db.select().from(schema.machines).where(eq(schema.machines.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Machine not found' }, 404);
  if (!row.adminUrl) return c.json({ alive: false, reason: 'no adminUrl configured' });

  try {
    const url = row.adminUrl.replace(/\/$/, '') + '/../api/v1/admin/applications';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return c.json({ alive: res.ok, status: res.status });
  } catch (err: any) {
    return c.json({ alive: false, reason: err.message });
  }
});

app.get('/:id/system-health', (c) => {
  const row = db.select().from(schema.machines).where(eq(schema.machines.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Machine not found' }, 404);
  if (row.type !== 'local') return c.json({ error: 'System health is available through the connected launcher for remote machines' }, 400);

  return c.json({
    uptime: os.uptime(),
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpu: { cores: os.cpus().length, loadAverage: os.loadavg() },
    memory: { total: os.totalmem(), free: os.freemem() },
    disks: collectDiskStats(),
    network: collectNetworkStats(),
  });
});

// Start the pw-server on a remote machine via its launcher
app.post('/:id/admin-start', async (c) => {
  const row = db.select().from(schema.machines).where(eq(schema.machines.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Machine not found' }, 404);

  const launcher = listLaunchers().find(l => l.machineId === row.id && !l.isLocal);
  if (!launcher || launcher.ws.readyState !== 1) {
    return c.json({ error: 'No connected launcher for this machine' }, 400);
  }

  const pwDir = row.defaultCwd || '~/work/github.com/propanes';
  const cmd = `cd ${pwDir}/packages/server && tmux new-session -d -s pw-server 'npm start 2>&1 | tee /tmp/pw-server.log'`;

  // Spawn a short-lived terminal to run the command
  const { dispatchTerminalSession } = await import('../dispatch.js');
  const { sessionId } = await dispatchTerminalSession({ cwd: '~', launcherId: launcher.id, permissionProfile: 'plain' });

  // Send the command after a short delay for shell to be ready
  setTimeout(async () => {
    try {
      const { inputSessionRemote } = await import('../session-service-client.js');
      // For launcher sessions, send via launcher WS
      launcher.ws.send(JSON.stringify({ type: 'input_to_session', sessionId, data: cmd + '\r' }));
      // Auto-exit the helper terminal after a moment
      setTimeout(() => {
        launcher.ws.send(JSON.stringify({ type: 'input_to_session', sessionId, data: 'exit\r' }));
      }, 3000);
    } catch {}
  }, 1000);

  return c.json({ ok: true, sessionId, command: cmd });
});

// Stop the pw-server on a remote machine via its launcher
app.post('/:id/admin-stop', async (c) => {
  const row = db.select().from(schema.machines).where(eq(schema.machines.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Machine not found' }, 404);

  const launcher = listLaunchers().find(l => l.machineId === row.id && !l.isLocal);
  if (!launcher || launcher.ws.readyState !== 1) {
    return c.json({ error: 'No connected launcher for this machine' }, 400);
  }

  const cmd = `tmux kill-session -t pw-server 2>/dev/null; tmux kill-session -t pw-sessions 2>/dev/null; echo 'stopped'`;

  const { dispatchTerminalSession } = await import('../dispatch.js');
  const { sessionId } = await dispatchTerminalSession({ cwd: '~', launcherId: launcher.id, permissionProfile: 'plain' });

  setTimeout(() => {
    try {
      launcher.ws.send(JSON.stringify({ type: 'input_to_session', sessionId, data: cmd + '\r' }));
      setTimeout(() => {
        launcher.ws.send(JSON.stringify({ type: 'input_to_session', sessionId, data: 'exit\r' }));
      }, 2000);
    } catch {}
  }, 1000);

  return c.json({ ok: true, sessionId, command: cmd });
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.machines).where(eq(schema.machines.id, id)).get();
  if (!existing) return c.json({ error: 'Machine not found' }, 404);

  // Unlink harness configs from this machine
  db.update(schema.harnessConfigs)
    .set({ machineId: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.harnessConfigs.machineId, id))
    .run();

  db.delete(schema.machines).where(eq(schema.machines.id, id)).run();
  return c.json({ ok: true, id });
});

export default app;
