import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ulid } from 'ulidx';
import {
  listLaunchers,
  listHarnesses,
  getLauncher,
  unregisterLauncher,
  serializeLauncher,
  sendAndWait,
} from '../launcher-registry.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { LauncherHealthCheckResult } from '@prompt-widget/shared';

const app = new Hono();

let _templateCache: string | null = null;
function loadTemplate(): string {
  if (_templateCache) return _templateCache;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    _templateCache = readFileSync(join(__dirname, '../../launcher.service.template'), 'utf-8');
  } catch {
    _templateCache = '';
  }
  return _templateCache;
}

app.get('/', (c) => {
  const all = listLaunchers().map(serializeLauncher);
  return c.json({ launchers: all });
});

app.get('/harnesses', (c) => {
  const harnesses = listHarnesses().map(serializeLauncher);
  return c.json({ harnesses });
});

app.get('/:id', (c) => {
  const launcher = getLauncher(c.req.param('id'));
  if (!launcher) return c.json({ error: 'Launcher not found' }, 404);
  return c.json(serializeLauncher(launcher));
});

app.post('/:id/restart', (c) => {
  const launcher = getLauncher(c.req.param('id'));
  if (!launcher) return c.json({ error: 'Launcher not found' }, 404);
  if (launcher.ws?.readyState !== 1) return c.json({ error: 'Launcher not connected' }, 400);
  try {
    launcher.ws.send(JSON.stringify({ type: 'restart_launcher' }));
  } catch {
    return c.json({ error: 'Failed to send restart command' }, 500);
  }
  return c.json({ ok: true });
});

app.get('/:id/health', async (c) => {
  const launcher = getLauncher(c.req.param('id'));
  if (!launcher) return c.json({ error: 'Launcher not found' }, 404);
  if (launcher.ws?.readyState !== 1) return c.json({ error: 'Launcher not connected' }, 400);
  try {
    const sessionId = ulid();
    const result = await sendAndWait(
      c.req.param('id'),
      { type: 'health_check', sessionId } as any,
      'health_check_result',
      15_000,
    ) as LauncherHealthCheckResult;
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/:id/systemd-template', (c) => {
  const launcher = getLauncher(c.req.param('id'));
  if (!launcher) return c.json({ error: 'Launcher not found' }, 404);

  const template = loadTemplate();
  if (!template) return c.json({ error: 'Template file not found' }, 500);

  const machine = launcher.machineId
    ? db.select().from(schema.machines).where(eq(schema.machines.id, launcher.machineId)).get()
    : null;

  const serverHost = c.req.header('host') || 'localhost:3001';
  const serverWsUrl = `ws://${serverHost}/ws/launcher`;

  const rendered = template
    .replace(/\{\{LAUNCHER_ID\}\}/g, launcher.id)
    .replace(/\{\{LAUNCHER_NAME\}\}/g, launcher.name)
    .replace(/\{\{SERVER_WS_URL\}\}/g, serverWsUrl)
    .replace(/\{\{LAUNCHER_AUTH_TOKEN\}\}/g, '')
    .replace(/\{\{MACHINE_ID\}\}/g, launcher.machineId || '')
    .replace(/\{\{MAX_SESSIONS\}\}/g, String(launcher.capabilities.maxSessions || 5))
    .replace(/\{\{USER\}\}/g, 'root')
    .replace(/\{\{WORKING_DIR\}\}/g, machine?.defaultCwd || '/root')
    .replace(/\{\{LAUNCHER_PATH\}\}/g, '/root/launcher-bundle.mjs');

  return c.text(rendered, 200, { 'Content-Type': 'text/plain' });
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const launcher = getLauncher(id);
  if (!launcher) return c.json({ error: 'Launcher not found' }, 404);
  if (launcher.ws) {
    try { launcher.ws.close(4012, 'Force disconnected by admin'); } catch {}
  }
  unregisterLauncher(id);
  return c.json({ ok: true, id });
});

export default app;
