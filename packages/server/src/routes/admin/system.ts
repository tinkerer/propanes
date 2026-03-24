import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import {
  dispatchTerminalSession,
  dispatchTmuxAttachSession,
  dispatchAgentSession,
  dispatchCompanionTerminal,
  dispatchHarnessSession,
} from '../../dispatch.js';
import { inputSessionRemote } from '../../session-service-client.js';
import { getLauncher, sendAndWait } from '../../launcher-registry.js';

const PW_TMUX_CONF = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmux-pw.conf');

export const systemRoutes = new Hono();

// Tmux configs CRUD
systemRoutes.get('/tmux-configs', (c) => {
  const configs = db.select().from(schema.tmuxConfigs).all();
  return c.json(configs);
});

systemRoutes.post('/tmux-configs', async (c) => {
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

systemRoutes.patch('/tmux-configs/:id', async (c) => {
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

systemRoutes.delete('/tmux-configs/:id', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.isDefault) return c.json({ error: 'Cannot delete the default config' }, 400);

  db.delete(schema.tmuxConfigs).where(eq(schema.tmuxConfigs.id, id)).run();
  return c.json({ id, deleted: true });
});

// Edit tmux config in terminal (nano/vim)
systemRoutes.post('/tmux-configs/:id/edit-terminal', async (c) => {
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
systemRoutes.post('/tmux-configs/:id/save-from-file', async (c) => {
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
systemRoutes.get('/tmux-conf', (c) => {
  try {
    const content = readFileSync(PW_TMUX_CONF, 'utf-8');
    return c.json({ content });
  } catch {
    return c.json({ content: '' });
  }
});

systemRoutes.put('/tmux-conf', async (c) => {
  const { content } = await c.req.json() as { content: string };
  writeFileSync(PW_TMUX_CONF, content, 'utf-8');
  return c.json({ saved: true });
});

// Perf metrics
systemRoutes.post('/perf-metrics', async (c) => {
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

systemRoutes.get('/perf-metrics', (c) => {
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
systemRoutes.get('/browse-dirs', (c) => {
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
systemRoutes.get('/read-file', (c) => {
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

// Browse files in an app's projectDir (files + directories)
systemRoutes.get('/browse-files', (c) => {
  const appId = c.req.query('appId');
  const relPath = c.req.query('path') || '.';
  if (!appId) return c.json({ error: 'appId query parameter required' }, 400);

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  if (!app) return c.json({ error: 'Application not found' }, 404);
  if (!app.projectDir) return c.json({ error: 'Application has no projectDir' }, 400);

  const projectDir = resolve(app.projectDir);
  const target = resolve(projectDir, relPath);
  if (!target.startsWith(projectDir)) return c.json({ error: 'Path traversal not allowed' }, 403);

  try {
    const entries = readdirSync(target, { withFileTypes: true });
    const items = entries
      .filter((e) => e.name !== '.git' && !e.name.startsWith('.'))
      .map((e) => {
        const result: { name: string; type: 'file' | 'dir'; size?: number; ext?: string } = {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        };
        if (!e.isDirectory()) {
          try {
            const st = statSync(join(target, e.name));
            result.size = st.size;
          } catch { /* ignore */ }
          const ext2 = extname(e.name).slice(1).toLowerCase();
          if (ext2) result.ext = ext2;
        }
        return result;
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    const relativePath = relative(projectDir, target) || '.';
    const parent = target === projectDir ? null : relative(projectDir, dirname(target)) || '.';
    let isGitRepo = false;
    try { isGitRepo = existsSync(join(projectDir, '.git')); } catch { /* ignore */ }

    return c.json({ path: target, relativePath, parent, entries: items, isGitRepo });
  } catch (err: any) {
    if (err.code === 'ENOENT') return c.json({ error: 'Directory not found', path: target }, 404);
    if (err.code === 'EACCES') return c.json({ error: 'Permission denied', path: target }, 403);
    return c.json({ error: err.message, path: target }, 500);
  }
});

// Git status for an app's projectDir
systemRoutes.get('/git-status', (c) => {
  const appId = c.req.query('appId');
  if (!appId) return c.json({ error: 'appId query parameter required' }, 400);

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  if (!app) return c.json({ error: 'Application not found' }, 404);
  if (!app.projectDir) return c.json({ error: 'Application has no projectDir' }, 400);

  const projectDir = resolve(app.projectDir);
  try {
    existsSync(join(projectDir, '.git'));
  } catch {
    return c.json({ isGitRepo: false, branch: null, files: [] });
  }
  if (!existsSync(join(projectDir, '.git'))) {
    return c.json({ isGitRepo: false, branch: null, files: [] });
  }

  try {
    const branchRaw = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 }).trim();
    const statusRaw = execSync('git status --porcelain=v1', { cwd: projectDir, encoding: 'utf-8', timeout: 10000 });
    const files = statusRaw.split('\n').filter(Boolean).map((line) => {
      const staged = line[0];
      const unstaged = line[1];
      const path = line.slice(3);
      let status = 'modified';
      const code = staged !== ' ' && staged !== '?' ? staged : unstaged;
      if (code === 'A') status = 'added';
      else if (code === 'D') status = 'deleted';
      else if (code === '?') status = 'untracked';
      else if (code === 'R') status = 'renamed';
      else if (code === 'C') status = 'copied';
      return { path, status, staged, unstaged };
    });
    return c.json({ isGitRepo: true, branch: branchRaw, files });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git diff for an app's projectDir
systemRoutes.get('/git-diff', (c) => {
  const appId = c.req.query('appId');
  const filePath = c.req.query('path') || '';
  const staged = c.req.query('staged') === 'true';
  if (!appId) return c.json({ error: 'appId query parameter required' }, 400);

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  if (!app) return c.json({ error: 'Application not found' }, 404);
  if (!app.projectDir) return c.json({ error: 'Application has no projectDir' }, 400);

  const projectDir = resolve(app.projectDir);
  if (!existsSync(join(projectDir, '.git'))) {
    return c.json({ diff: '' });
  }

  try {
    const args = ['git', 'diff'];
    if (staged) args.push('--cached');
    if (filePath) args.push('--', filePath);
    const diff = execSync(args.join(' '), { cwd: projectDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return c.json({ diff });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Setup assist — AI assistant for configuring machines and harnesses
systemRoutes.post('/setup-assist', async (c) => {
  const body = await c.req.json();
  const { request, entityType, entityId } = body as {
    request?: string;
    entityType?: 'machine' | 'harness' | 'agent' | 'sprite';
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
    } else if (entityType === 'sprite') {
      const row = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, entityId)).get();
      if (!row) return c.json({ error: 'Sprite config not found' }, 404);
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

  // Spawn companion terminal for all machine entities (existing or new)
  let companionSessionId: string | null = null;
  let companionTmuxName: string | null = null;
  if (entityType === 'machine') {
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
    ? buildSetupPrompt(entityType as 'machine' | 'harness' | 'agent' | 'sprite', entity, machine, request.trim(), baseUrl, companionTmuxName)
    : buildNewEntityPrompt(entityType, request.trim(), baseUrl, companionTmuxName);

  // Find the app whose projectDir matches this server's cwd (for linking feedback + JSONL)
  const serverCwd = process.cwd();
  const adminApp = db.select().from(schema.applications)
    .where(eq(schema.applications.projectDir, serverCwd)).get();

  // Create feedback item
  const feedbackId = ulid();
  const now = new Date().toISOString();
  const entityLabel = entity ? ((entity as any).name || entityId!.slice(0, 8)) : `New ${entityType}`;
  db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'request',
    status: 'dispatched',
    title: `[Admin Assist] ${entityLabel}: ${request.trim().slice(0, 60)}`,
    description: request.trim(),
    appId: adminApp?.id || null,
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
  entityType: 'machine' | 'harness' | 'agent' | 'sprite',
  entity: Record<string, unknown>,
  machine: Record<string, unknown> | null,
  request: string,
  baseUrl: string,
  companionTmuxName?: string | null,
): string {
  const parts: string[] = [];
  const typeLabel = entityType === 'machine' ? 'Machine' : entityType === 'harness' ? 'Harness' : entityType === 'sprite' ? 'Sprite' : 'Agent';
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
    parts.push(`- **Admin URL**: ${m.adminUrl || '(not set)'}`);
    parts.push('');
    parts.push('## Update API');
    parts.push(`PATCH ${baseUrl}/api/v1/admin/machines/${m.id}`);
    parts.push('Fields: name, hostname, address, type, capabilities (object with hasDocker, hasTmux, hasClaudeCli booleans), tags (string array), authToken, adminUrl');
    parts.push('');
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    parts.push('## Setup Phases');
    parts.push('');
    parts.push('### Phase 1: SSH & Prerequisites');
    parts.push('1. Verify SSH connectivity: `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ' + (m.address || '<address>') + ' "echo ok"`');
    parts.push('2. Install tmux if missing: `ssh ' + (m.address || '<address>') + ' "which tmux || (sudo apt-get update && sudo apt-get install -y tmux)"`');
    parts.push('3. Check Node.js (v18+): `ssh ' + (m.address || '<address>') + ' "node --version"`');
    parts.push('4. Update capabilities: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/' + m.id + ' -H "Content-Type: application/json" -d \'{"capabilities":{"hasTmux":true}}\'`');
    parts.push('');
    parts.push('### Phase 2: Deploy Launcher Daemon');
    parts.push('1. Build the launcher bundle locally: `cd ' + process.cwd() + ' && node esbuild-launcher.mjs`');
    parts.push('2. SCP the bundle to the remote machine: `scp ' + process.cwd() + '/dist/launcher-bundle.mjs ' + (m.address || '<address>') + ':~/launcher-bundle.mjs`');
    parts.push('3. Install node-pty on the remote machine: `ssh ' + (m.address || '<address>') + ' "cd ~ && npm install node-pty"`');
    parts.push('4. Start the launcher daemon on the remote machine (in a tmux session so it persists):');
    parts.push('   ```');
    parts.push('   ssh ' + (m.address || '<address>') + ' "tmux new-session -d -s pw-launcher \'SERVER_WS_URL=' + wsUrl + '/ws/launcher LAUNCHER_ID=' + (m.hostname || m.name || 'launcher') + ' MACHINE_ID=' + m.id + ' MAX_SESSIONS=5 node ~/launcher-bundle.mjs\'"');
    parts.push('   ```');
    parts.push('5. Verify the launcher connects — poll until it appears: `curl -s ' + baseUrl + '/api/v1/launchers | python3 -c "import sys,json; launchers=json.load(sys.stdin); print([l for l in launchers if l.get(\'machineId\')==\'' + m.id + '\'])"`');
    parts.push('');
    parts.push('### Phase 3: Launch a Terminal Session');
    parts.push('Once the launcher is connected, launch a terminal session through the server API to prove it works:');
    parts.push('1. Get the launcher ID from the launchers list above');
    parts.push('2. Launch a terminal: `curl -s -X POST ' + baseUrl + '/api/v1/admin/terminal -H "Content-Type: application/json" -d \'{"launcherId":"<LAUNCHER_ID>"}\'`');
    parts.push('3. Verify the session was created and is active');
    parts.push('');
    parts.push('### Phase 4: Install Claude CLI');
    parts.push('Check if Claude CLI is installed on the remote machine. If not, install it:');
    parts.push('1. Check: `ssh ' + (m.address || '<address>') + ' "which claude"`');
    parts.push('2. Install if missing: `ssh ' + (m.address || '<address>') + ' "curl -fsSL https://claude.ai/install.sh | bash"`');
    parts.push('3. Verify: `ssh ' + (m.address || '<address>') + ' "claude --version"`');
    parts.push('4. Update capabilities: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/' + m.id + ' -H "Content-Type: application/json" -d \'{"capabilities":{"hasClaudeCli":true}}\'`');
    parts.push('');
    parts.push('### Phase 5: Hardware Investigation');
    parts.push('Launch a Claude agent session on the remote machine to investigate hardware:');
    parts.push('1. SSH into the machine and run claude with a hardware investigation prompt:');
    parts.push('   ```');
    parts.push('   ssh ' + (m.address || '<address>') + ' "claude -p \'Investigate this machine hardware and output a JSON object with: cpu (model, cores, threads), memory (total_gb), gpus (array of {name, vram_gb, pcie_gen, pcie_lanes}), pcie_devices (array of {slot, device, driver}), disks (array of {device, size, type, mount}), os (name, version, kernel), network (array of {interface, speed}). Only output the JSON, no other text.\' --output-format json"');
    parts.push('   ```');
    parts.push('2. Capture the JSON output');
    parts.push('');
    parts.push('### Phase 6: Tag Machine');
    parts.push('Parse the hardware investigation results and update the machine with tags:');
    parts.push('1. Extract tags from the JSON: CPU model, RAM amount, GPU names, OS');
    parts.push('2. Example tags: `["cpu:AMD EPYC 7513", "ram:256GB", "gpu:RTX 4090 x2", "os:Ubuntu 22.04"]`');
    parts.push('3. Update: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/' + m.id + ' -H "Content-Type: application/json" -d \'{"tags":["tag1","tag2",...]}\'`');
    parts.push('');
    parts.push('### Phase 7: Deploy Prompt-Widget Admin on Remote Machine');
    parts.push('After the core setup is done, ask the user: "Would you like me to deploy the prompt-widget admin dashboard on this machine too?"');
    parts.push('If yes, follow these steps using the companion terminal:');
    const addr = m.address || '<address>';
    const repoUrl = 'https://github.com/tinkerer/prompt-widget.git';
    const pwDir = '~/work/github.com/prompt-widget';
    parts.push('');
    parts.push('1. Check if the repo already exists:');
    parts.push(`   \`ssh ${addr} "test -d ${pwDir} && echo EXISTS || echo MISSING"\``);
    parts.push('2. Clone if missing:');
    parts.push(`   \`ssh ${addr} "mkdir -p ~/work/github.com && git clone ${repoUrl} ${pwDir}"\``);
    parts.push('   Or if it exists, pull latest:');
    parts.push(`   \`ssh ${addr} "cd ${pwDir} && git pull"\``);
    parts.push('3. Install dependencies:');
    parts.push(`   \`ssh ${addr} "cd ${pwDir} && npm install"\``);
    parts.push('4. Build all packages:');
    parts.push(`   \`ssh ${addr} "cd ${pwDir} && npm run build --workspaces"\``);
    parts.push('5. Start the server in a persistent tmux session:');
    parts.push(`   \`ssh ${addr} "tmux new-session -d -s pw-server 'cd ${pwDir}/packages/server && node dist/index.js'"\``);
    parts.push(`   If "npm run dev" is preferred (with auto-reload): \`ssh ${addr} "tmux new-session -d -s pw-server 'cd ${pwDir}/packages/server && npm run dev'"\``);
    parts.push('6. Verify the server is running:');
    parts.push(`   \`curl -s --connect-timeout 3 http://${addr}:3001/api/v1/admin/applications\``);
    parts.push('7. Set the admin URL on the machine record:');
    parts.push(`   \`curl -s -X PATCH ${baseUrl}/api/v1/admin/machines/${m.id} -H "Content-Type: application/json" -d '{"adminUrl":"http://${addr}:3001/admin/"}'\``);
    parts.push('');
    parts.push('Note: You can skip phases if they are already done (e.g., launcher already connected, Claude CLI already installed). The admin UI auto-refreshes every 10 seconds.');
  } else if (entityType === 'harness') {
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
  } else if (entityType === 'sprite') {
    const s = entity as any;
    parts.push('## Current Sprite Configuration');
    parts.push(`- **ID**: ${s.id}`);
    parts.push(`- **Name**: ${s.name}`);
    parts.push(`- **Sprite Name**: ${s.spriteName}`);
    parts.push(`- **Status**: ${s.status}`);
    parts.push(`- **Max Sessions**: ${s.maxSessions}`);
    parts.push(`- **Default CWD**: ${s.defaultCwd || '(not set)'}`);
    parts.push(`- **App ID**: ${s.appId || '(none)'}`);
    parts.push(`- **Token**: ${s.token ? '(set)' : '(not set — using SPRITES_TOKEN env)'}`);
    if (s.spriteUrl) parts.push(`- **Sprite URL**: ${s.spriteUrl}`);
    if (s.spriteId) parts.push(`- **Sprite ID**: ${s.spriteId}`);
    if (s.errorMessage) parts.push(`- **Error**: ${s.errorMessage}`);
    parts.push('');
    parts.push('## Sprite Management APIs');
    parts.push(`- Update config: \`PATCH ${baseUrl}/api/v1/admin/sprite-configs/${s.id}\``);
    parts.push(`  Fields: name, spriteName, token, maxSessions, defaultCwd, appId`);
    parts.push(`- Provision: \`POST ${baseUrl}/api/v1/admin/sprite-configs/${s.id}/provision\``);
    parts.push(`- Destroy: \`POST ${baseUrl}/api/v1/admin/sprite-configs/${s.id}/destroy\``);
    parts.push(`- Check status: \`POST ${baseUrl}/api/v1/admin/sprite-configs/${s.id}/status\``);
    parts.push(`- Launch session: \`POST ${baseUrl}/api/v1/admin/sprite-configs/${s.id}/session\``);
    parts.push('');
  }

  if (companionTmuxName) {
    parts.push('');
    parts.push('## Companion Terminal');
    parts.push(`You have a companion terminal at tmux session \`${companionTmuxName}\`.`);
    parts.push(`Use \`tmux send-keys -t ${companionTmuxName} "command" Enter\` to run commands.`);
    parts.push(`Use \`tmux capture-pane -t ${companionTmuxName} -p\` to read output.`);
    parts.push('Use the companion terminal for SSH connectivity checks, capability detection, and any shell commands needed for setup.');
    parts.push('');
    parts.push('### Remote Terminal API (for any session)');
    parts.push('You can also interact with any agent session\'s tmux pane via HTTP:');
    parts.push(`- Send keys: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/send-keys -H 'Content-Type: application/json' -d '{"keys":"echo hello"}'\``);
    parts.push(`- Send keys without Enter: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/send-keys -H 'Content-Type: application/json' -d '{"keys":"text","enter":false}'\``);
    parts.push(`- Capture pane output: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/capture-pane -H 'Content-Type: application/json' -d '{}'\``);
    parts.push(`- Capture last N lines: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/capture-pane -H 'Content-Type: application/json' -d '{"lastN":30}'\``);
    parts.push('These work for both local and remote sessions — the server routes to the correct launcher automatically.');
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
    parts.push('- For interacting with remote session terminals, use the send-keys/capture-pane HTTP API');
  }

  return parts.join('\n');
}

function buildNewEntityPrompt(
  entityType: 'machine' | 'harness' | 'agent' | 'sprite',
  request: string,
  baseUrl: string,
  companionTmuxName?: string | null,
): string {
  const parts: string[] = [];
  const typeLabel = entityType === 'machine' ? 'Machine' : entityType === 'harness' ? 'Harness' : entityType === 'sprite' ? 'Sprite' : 'Agent';
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
    parts.push('Fields: name (required), hostname, address, type (local|remote|cloud), capabilities (object with hasDocker, hasTmux, hasClaudeCli booleans), tags (string array), adminUrl');
    parts.push('');
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    parts.push('## Workflow');
    parts.push('');
    parts.push('### Step 0: Create Machine');
    parts.push('1. Ask the user for machine details (name, hostname/address, type)');
    parts.push('2. Create via POST: `curl -s -X POST ' + baseUrl + '/api/v1/admin/machines -H "Content-Type: application/json" -d \'{"name":"<name>","hostname":"<hostname>","address":"<address>","type":"remote"}\'`');
    parts.push('3. Note the machine ID from the response');
    parts.push('');
    parts.push('### Phase 1: SSH & Prerequisites');
    parts.push('1. Verify SSH: `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new <address> "echo ok"`');
    parts.push('2. Install tmux if missing: `ssh <address> "which tmux || (sudo apt-get update && sudo apt-get install -y tmux)"`');
    parts.push('3. Check Node.js (v18+): `ssh <address> "node --version"`');
    parts.push('');
    parts.push('### Phase 2: Deploy Launcher Daemon');
    parts.push('1. Build launcher bundle: `cd ' + process.cwd() + ' && node esbuild-launcher.mjs`');
    parts.push('2. SCP bundle: `scp ' + process.cwd() + '/dist/launcher-bundle.mjs <address>:~/launcher-bundle.mjs`');
    parts.push('3. Install node-pty: `ssh <address> "cd ~ && npm install node-pty"`');
    parts.push('4. Start launcher: `ssh <address> "tmux new-session -d -s pw-launcher \'SERVER_WS_URL=' + wsUrl + '/ws/launcher LAUNCHER_ID=<hostname> MACHINE_ID=<machine-id> MAX_SESSIONS=5 node ~/launcher-bundle.mjs\'"`');
    parts.push('5. Verify connected: `curl -s ' + baseUrl + '/api/v1/launchers`');
    parts.push('');
    parts.push('### Phase 3: Launch Terminal Session');
    parts.push('1. Launch terminal through server: `curl -s -X POST ' + baseUrl + '/api/v1/admin/terminal -H "Content-Type: application/json" -d \'{"launcherId":"<LAUNCHER_ID>"}\'`');
    parts.push('');
    parts.push('### Phase 4: Install Claude CLI');
    parts.push('1. Check: `ssh <address> "which claude"`');
    parts.push('2. Install if missing: `ssh <address> "curl -fsSL https://claude.ai/install.sh | bash"`');
    parts.push('3. Update capabilities: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/<machine-id> -H "Content-Type: application/json" -d \'{"capabilities":{"hasClaudeCli":true}}\'`');
    parts.push('');
    parts.push('### Phase 5: Hardware Investigation');
    parts.push('1. Run claude on the remote machine to investigate hardware:');
    parts.push('   `ssh <address> "claude -p \'Investigate this machine hardware and output a JSON object with: cpu, memory, gpus, pcie_devices, disks, os, network. Only output the JSON.\' --output-format json"`');
    parts.push('');
    parts.push('### Phase 6: Tag Machine');
    parts.push('1. Parse the hardware JSON and create tags (e.g., `["cpu:AMD EPYC 7513", "ram:256GB", "gpu:RTX 4090 x2"]`)');
    parts.push('2. Update: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/<machine-id> -H "Content-Type: application/json" -d \'{"tags":[...]}\'`');
    parts.push('');
    parts.push('### Phase 7: Deploy Prompt-Widget Admin on Remote Machine');
    parts.push('After the core setup is done, ask the user: "Would you like me to deploy the prompt-widget admin dashboard on this machine too?"');
    parts.push('If yes:');
    const newRepoUrl = 'https://github.com/tinkerer/prompt-widget.git';
    const newPwDir = '~/work/github.com/prompt-widget';
    parts.push('1. Check if repo exists: `ssh <address> "test -d ' + newPwDir + ' && echo EXISTS || echo MISSING"`');
    parts.push('2. Clone if missing: `ssh <address> "mkdir -p ~/work/github.com && git clone ' + newRepoUrl + ' ' + newPwDir + '"`');
    parts.push('   Or pull latest: `ssh <address> "cd ' + newPwDir + ' && git pull"`');
    parts.push('3. Install: `ssh <address> "cd ' + newPwDir + ' && npm install"`');
    parts.push('4. Build: `ssh <address> "cd ' + newPwDir + ' && npm run build --workspaces"`');
    parts.push('5. Start in tmux: `ssh <address> "tmux new-session -d -s pw-server \'cd ' + newPwDir + '/packages/server && npm run dev\'"`');
    parts.push('6. Verify: `curl -s --connect-timeout 3 http://<address>:3001/api/v1/admin/applications`');
    parts.push('7. Set adminUrl: `curl -s -X PATCH ' + baseUrl + '/api/v1/admin/machines/<machine-id> -H "Content-Type: application/json" -d \'{"adminUrl":"http://<address>:3001/admin/"}\'`');
    parts.push('');
    parts.push('Note: Skip phases already done. The admin UI auto-refreshes.');
    if (companionTmuxName) {
      parts.push('');
      parts.push('## Companion Terminal');
      parts.push(`You have a companion terminal at tmux session \`${companionTmuxName}\`.`);
      parts.push(`Use \`tmux send-keys -t ${companionTmuxName} "command" Enter\` to run commands.`);
      parts.push(`Use \`tmux capture-pane -t ${companionTmuxName} -p\` to read output.`);
      parts.push('Use the companion terminal for SSH connectivity checks, capability detection, and any shell commands needed for setup.');
      parts.push('');
      parts.push('### Remote Terminal API (for any session)');
      parts.push('You can also interact with any agent session\'s tmux pane via HTTP:');
      parts.push(`- Send keys: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/send-keys -H 'Content-Type: application/json' -d '{"keys":"echo hello"}'\``);
      parts.push(`- Capture pane: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/capture-pane -H 'Content-Type: application/json' -d '{}'\``);
      parts.push(`- Capture last N lines: \`curl -s -X POST ${baseUrl}/api/v1/admin/agent-sessions/SESSION_ID/capture-pane -H 'Content-Type: application/json' -d '{"lastN":30}'\``);
      parts.push('These work for both local and remote sessions.');
    }
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
  } else if (entityType === 'sprite') {
    const existing = db.select().from(schema.spriteConfigs).all();
    const appList = db.select().from(schema.applications).all();
    if (existing.length > 0) {
      parts.push('## Existing Sprites');
      for (const s of existing) {
        parts.push(`- ${s.name} (${s.status}) — sprite: ${s.spriteName}`);
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
    parts.push(`POST ${baseUrl}/api/v1/admin/sprite-configs`);
    parts.push('Fields: name (required), spriteName (auto-generated if omitted), token (optional, falls back to SPRITES_TOKEN env), maxSessions (default 3), defaultCwd, appId, provisionNow (boolean)');
    parts.push('');
    parts.push('## Workflow');
    parts.push('1. Ask the user for a display name and any preferences');
    parts.push('2. Create the sprite config via POST API (with provisionNow=true to provision immediately)');
    parts.push('3. Check status to verify provisioning succeeded');
    parts.push('4. Optionally launch a test session to verify it works');
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
systemRoutes.post('/terminal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cwd, appId, launcherId, harnessConfigId, permissionProfile, tmuxTarget } = body as { cwd?: string; appId?: string; launcherId?: string; harnessConfigId?: string; permissionProfile?: string; tmuxTarget?: string };
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
    const { sessionId } = await dispatchTerminalSession({ cwd: resolvedCwd, appId, launcherId, permissionProfile: (permissionProfile || 'plain') as any, tmuxTarget });
    return c.json({ sessionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});

// List tmux sessions from the default tmux server
systemRoutes.get('/tmux-sessions', async (c) => {
  const { listDefaultTmuxSessions } = await import('../../tmux-pty.js');
  return c.json({ sessions: listDefaultTmuxSessions() });
});

// List tmux sessions on a remote launcher
systemRoutes.get('/launcher/:launcherId/tmux-sessions', async (c) => {
  const launcherId = c.req.param('launcherId');
  const launcher = getLauncher(launcherId);
  if (!launcher || launcher.ws?.readyState !== 1) {
    return c.json({ error: 'Launcher not connected' }, 400);
  }
  try {
    const sessionId = ulid();
    const msg = { type: 'list_tmux_sessions' as const, sessionId };
    const result = await sendAndWait(launcher.id, msg as any, 'list_tmux_sessions_result', 10_000) as { sessions: { name: string; windows: number; created: string; attached: boolean }[] };
    return c.json({ sessions: result.sessions });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Attach to an existing tmux session from the default server
systemRoutes.post('/terminal/attach-tmux', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { tmuxTarget, appId, launcherId } = body as { tmuxTarget?: string; appId?: string; launcherId?: string };

  if (!tmuxTarget) {
    return c.json({ error: 'tmuxTarget is required' }, 400);
  }

  try {
    if (launcherId) {
      const { sessionId } = await dispatchTerminalSession({ cwd: '~', launcherId, tmuxTarget });
      return c.json({ sessionId });
    }
    const { sessionId } = await dispatchTmuxAttachSession({ tmuxTarget, appId });
    return c.json({ sessionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});
