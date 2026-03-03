import { Hono } from 'hono';
import { eq, desc, ne, and } from 'drizzle-orm';
import { homedir } from 'node:os';
import { resolve, dirname, normalize, isAbsolute } from 'node:path';
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { db, schema } from '../db/index.js';
import { killSession } from '../agent-sessions.js';
import { resumeAgentSession, dispatchTerminalSession, transferSession, getTransfer } from '../dispatch.js';
import { getSessionLiveStates } from '../session-service-client.js';
import { getLauncher } from '../launcher-registry.js';

function computeJsonlPath(projectDir: string | null, claudeSessionId: string | null): string | null {
  if (!projectDir || !claudeSessionId) return null;
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
  return `${homedir()}/.claude/projects/${sanitized}/${claudeSessionId}.jsonl`;
}

// Find continuation JSONL files when Claude Code rotates sessionId mid-conversation.
// Returns ordered list of JSONL paths: [original, continuation1, continuation2, ...]
function findContinuationJsonls(mainJsonlPath: string): string[] {
  const dir = mainJsonlPath.replace(/\/[^/]+$/, '');
  if (!existsSync(dir)) return [];

  // Get the last timestamp from the main file
  const mainContent = readFileSync(mainJsonlPath, 'utf-8');
  const mainLines = mainContent.trimEnd().split('\n');
  let lastTimestamp = '';
  for (let i = mainLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(mainLines[i]);
      if (obj.timestamp) { lastTimestamp = obj.timestamp; break; }
    } catch { /* skip */ }
  }
  if (!lastTimestamp) return [];

  const mainBasename = mainJsonlPath.split('/').pop()!;
  const candidates: { path: string; firstTimestamp: string }[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl') || file === mainBasename) continue;
    const fullPath = `${dir}/${file}`;
    try {
      // Read just the first few KB to find the first timestamp
      const fd = openSync(fullPath, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = readSync(fd, buf, 0, 4096, 0);
      closeSync(fd);
      const head = buf.toString('utf-8', 0, bytesRead);
      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.timestamp && obj.type !== 'file-history-snapshot') {
            // Only include if its first timestamp matches the main file's last timestamp (within 1s)
            const mainTime = new Date(lastTimestamp).getTime();
            const candidateTime = new Date(obj.timestamp).getTime();
            if (Math.abs(candidateTime - mainTime) < 2000) {
              candidates.push({ path: fullPath, firstTimestamp: obj.timestamp });
            }
            break;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip unreadable files */ }
  }

  // Sort by first timestamp
  candidates.sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp));
  return candidates.map(c => c.path);
}

function filterJsonlLines(text: string): string[] {
  return text.split('\n').filter(line => {
    if (!line.trim()) return false;
    try {
      const obj = JSON.parse(line);
      return obj.type !== 'progress' && obj.type !== 'file-history-snapshot';
    } catch {
      return true;
    }
  });
}

function readJsonlWithSubagents(filePath: string, out: string[]): void {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, 'utf-8');
  out.push(...filterJsonlLines(raw));

  // Include subagent JSONL files
  const subagentDir = filePath.replace(/\.jsonl$/, '') + '/subagents';
  if (existsSync(subagentDir)) {
    try {
      const files = readdirSync(subagentDir).filter(f => f.endsWith('.jsonl')).sort();
      for (const file of files) {
        const content = readFileSync(`${subagentDir}/${file}`, 'utf-8');
        const agentId = file.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        for (const line of filterJsonlLines(content)) {
          try {
            const obj = JSON.parse(line);
            obj._subagentId = agentId;
            out.push(JSON.stringify(obj));
          } catch {
            out.push(line);
          }
        }
      }
    } catch { /* ignore */ }
  }
}

export function extractArtifactPaths(jsonlContent: string, projectDir: string): string[] {
  const paths = new Set<string>();

  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      // Look for tool_use blocks in assistant messages
      let toolUses: any[] = [];
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        toolUses = obj.message.content.filter((b: any) => b.type === 'tool_use');
      }

      for (const tu of toolUses) {
        const toolName = tu.name;
        const input = tu.input;
        if (!input) continue;

        let filePath: string | undefined;
        if (toolName === 'Write' || toolName === 'Edit') {
          filePath = input.file_path;
        } else if (toolName === 'NotebookEdit') {
          filePath = input.notebook_path;
        }

        if (!filePath || typeof filePath !== 'string') continue;

        // Convert absolute path to relative
        let rel: string;
        if (isAbsolute(filePath)) {
          if (!filePath.startsWith(projectDir)) continue;
          rel = filePath.slice(projectDir.length).replace(/^\//, '');
        } else {
          rel = filePath;
        }

        const normalized = normalize(rel);
        if (normalized.startsWith('..')) continue;
        paths.add(normalized);
      }
    } catch { /* skip unparseable */ }
  }

  // Also include .claude/plans files
  const plansDir = resolve(projectDir, '.claude', 'plans');
  if (existsSync(plansDir)) {
    try {
      for (const f of readdirSync(plansDir)) {
        if (f.endsWith('.md')) {
          paths.add(`.claude/plans/${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  return Array.from(paths);
}

export const agentSessionRoutes = new Hono();

// Transfer status route — must be before /:id to avoid being caught by the param
agentSessionRoutes.get('/transfers/:transferId', async (c) => {
  const transferId = c.req.param('transferId');
  const transfer = getTransfer(transferId);

  if (!transfer) {
    return c.json({ error: 'Transfer not found' }, 404);
  }

  return c.json({
    transferId: transfer.id,
    status: transfer.status,
    sessionId: transfer.sessionId,
    parentSessionId: transfer.parentSessionId,
    error: transfer.error,
  });
});

agentSessionRoutes.get('/', async (c) => {
  const feedbackId = c.req.query('feedbackId');
  const includeDeleted = c.req.query('includeDeleted') === 'true';

  const selectFields = {
    session: schema.agentSessions,
    feedbackTitle: schema.feedbackItems.title,
    feedbackAppId: schema.feedbackItems.appId,
    agentName: schema.agentEndpoints.name,
    agentAppId: schema.agentEndpoints.appId,
    appProjectDir: schema.applications.projectDir,
  };

  const baseQuery = () => db
    .select(selectFields)
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.agentEndpoints, eq(schema.agentSessions.agentEndpointId, schema.agentEndpoints.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id));

  let rows;
  if (feedbackId) {
    const where = includeDeleted
      ? eq(schema.agentSessions.feedbackId, feedbackId)
      : and(eq(schema.agentSessions.feedbackId, feedbackId), ne(schema.agentSessions.status, 'deleted'));
    rows = baseQuery()
      .where(where)
      .orderBy(desc(schema.agentSessions.createdAt))
      .all();
  } else {
    const where = includeDeleted ? undefined : ne(schema.agentSessions.status, 'deleted');
    rows = baseQuery()
      .where(where)
      .orderBy(desc(schema.agentSessions.createdAt))
      .all();
  }

  const liveStates = await getSessionLiveStates();

  const sessions = rows.map((r) => {
    const live = liveStates[r.session.id];

    // Enrich with launcher/machine/harness metadata
    let launcherName: string | null = null;
    let launcherHostname: string | null = null;
    let machineName: string | null = null;
    let harnessName: string | null = null;
    let isRemote = false;
    let isHarness = false;

    if (r.session.launcherId) {
      const launcher = getLauncher(r.session.launcherId);
      if (launcher) {
        launcherName = launcher.name;
        launcherHostname = launcher.hostname;
        isRemote = !launcher.isLocal;
        isHarness = !!launcher.harness;
        if (launcher.machineId) {
          const machine = db.select().from(schema.machines)
            .where(eq(schema.machines.id, launcher.machineId)).get();
          if (machine) machineName = machine.name;
        }
        if (launcher.harnessConfigId) {
          const harness = db.select().from(schema.harnessConfigs)
            .where(eq(schema.harnessConfigs.id, launcher.harnessConfigId)).get();
          if (harness) harnessName = harness.name;
        }
      } else {
        // Launcher disconnected — try to resolve from DB
        if (r.session.machineId) {
          const machine = db.select().from(schema.machines)
            .where(eq(schema.machines.id, r.session.machineId)).get();
          if (machine) { machineName = machine.name; isRemote = machine.type !== 'local'; }
        }
      }
    }

    return {
      ...r.session,
      feedbackTitle: r.feedbackTitle || null,
      agentName: r.agentName || null,
      appId: r.feedbackAppId || r.agentAppId || null,
      inputState: live?.inputState || (r.session.status === 'running' ? 'active' : null),
      paneTitle: live?.paneTitle || null,
      paneCommand: live?.paneCommand || null,
      panePath: live?.panePath || null,
      jsonlPath: computeJsonlPath(r.appProjectDir || null, r.session.claudeSessionId),
      launcherName,
      launcherHostname,
      machineName,
      harnessName,
      isRemote,
      isHarness,
    };
  });

  return c.json(sessions);
});

agentSessionRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!session) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json(session);
});

agentSessionRoutes.post('/:id/kill', async (c) => {
  const id = c.req.param('id');
  const killed = await killSession(id);

  if (!killed) {
    return c.json({ error: 'Session not running or not found' }, 404);
  }

  return c.json({ id, killed: true });
});

agentSessionRoutes.post('/:id/resume', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const targetLauncherId = body.launcherId || undefined;
  try {
    const { sessionId } = await resumeAgentSession(id, targetLauncherId);
    return c.json({ sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Resume failed';
    return c.json({ error: msg }, 400);
  }
});

agentSessionRoutes.post('/:id/archive', async (c) => {
  const id = c.req.param('id');
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!session) {
    return c.json({ error: 'Not found' }, 404);
  }

  if (session.status === 'running' || session.status === 'pending') {
    await killSession(id);
  }

  db.update(schema.agentSessions)
    .set({ status: 'deleted', completedAt: session.completedAt || new Date().toISOString() })
    .where(eq(schema.agentSessions.id, id))
    .run();

  return c.json({ id, archived: true });
});

agentSessionRoutes.post('/:id/open-terminal', async (c) => {
  const id = c.req.param('id');
  const tmuxName = `pw-${id}`;
  const { execFileSync } = await import('node:child_process');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  try {
    execFileSync('tmux', ['-L', 'prompt-widget', 'has-session', '-t', tmuxName], { stdio: 'pipe' });
  } catch {
    return c.json({ error: 'Tmux session not found' }, 404);
  }
  try {
    const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'open-in-terminal.sh');
    execFileSync(scriptPath, [tmuxName], { stdio: 'pipe' });
    return c.json({ ok: true, tmuxName });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

agentSessionRoutes.get('/:id/jsonl', async (c) => {
  const id = c.req.param('id');
  const row = db
    .select({
      claudeSessionId: schema.agentSessions.claudeSessionId,
      appProjectDir: schema.applications.projectDir,
    })
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!row) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const jsonlPath = computeJsonlPath(row.appProjectDir || null, row.claudeSessionId);
  if (!jsonlPath) {
    return c.json({ error: 'No JSONL path available' }, 400);
  }
  if (!existsSync(jsonlPath)) {
    return c.json({ error: `JSONL file not found: ${jsonlPath}` }, 404);
  }

  const allLines: string[] = [];
  // Read main file + continuations
  const continuations = findContinuationJsonls(jsonlPath);
  console.log(`[jsonl] ${id}: main=${jsonlPath}, continuations=${continuations.length}`, continuations);
  const jsonlFiles = [jsonlPath, ...continuations];
  for (const filePath of jsonlFiles) {
    readJsonlWithSubagents(filePath, allLines);
  }
  console.log(`[jsonl] ${id}: total lines=${allLines.length}`);

  return c.text(allLines.join('\n'));
});

agentSessionRoutes.post('/:id/tail-jsonl', async (c) => {
  const id = c.req.param('id');
  const row = db
    .select({
      claudeSessionId: schema.agentSessions.claudeSessionId,
      appProjectDir: schema.applications.projectDir,
    })
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!row) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const jsonlPath = computeJsonlPath(row.appProjectDir || null, row.claudeSessionId);
  if (!jsonlPath) {
    return c.json({ error: 'No JSONL path available (missing projectDir or claudeSessionId)' }, 400);
  }
  if (!existsSync(jsonlPath)) {
    return c.json({ error: `JSONL file not found: ${jsonlPath}` }, 404);
  }

  const { sessionId } = await dispatchTerminalSession({ cwd: '/tmp' });

  const tmuxName = `pw-${sessionId}`;
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('tmux', ['-L', 'prompt-widget', 'send-keys', '-t', tmuxName, `tail -f ${jsonlPath}`, 'Enter'], { stdio: 'pipe' });
  } catch (err: any) {
    console.error('Failed to send tail command:', err.message);
  }

  return c.json({ sessionId, jsonlPath });
});

agentSessionRoutes.post('/:id/transfer', async (c) => {
  const id = c.req.param('id');
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (session.status === 'running' || session.status === 'pending') {
    return c.json({ error: 'Cannot transfer an active session' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const targetLauncherId = body.targetLauncherId || null;
  const targetCwd = body.targetCwd || undefined;

  try {
    const transferId = await transferSession(id, targetLauncherId, targetCwd);
    return c.json({ transferId, status: 'pending' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Transfer failed';
    return c.json({ error: msg }, 400);
  }
});

agentSessionRoutes.get('/:id/export-context', async (c) => {
  const id = c.req.param('id');
  const row = db
    .select({
      session: schema.agentSessions,
      appProjectDir: schema.applications.projectDir,
    })
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!row) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const projectDir = row.appProjectDir || null;
  const claudeSessionId = row.session.claudeSessionId;
  if (!projectDir || !claudeSessionId) {
    return c.json({ error: 'Missing projectDir or claudeSessionId' }, 400);
  }

  const jsonlPath = computeJsonlPath(projectDir, claudeSessionId);
  if (!jsonlPath || !existsSync(jsonlPath)) {
    return c.json({ error: 'JSONL file not found' }, 404);
  }

  // Collect all JSONL content
  const allLines: string[] = [];
  const continuations = findContinuationJsonls(jsonlPath);
  const jsonlPaths = [jsonlPath, ...continuations];

  const jsonlFiles: Array<{ relativePath: string; content: string }> = [];
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
  const jsonlDir = `${homedir()}/.claude/projects/${sanitized}`;

  // Main JSONL
  jsonlFiles.push({
    relativePath: `${claudeSessionId}.jsonl`,
    content: readFileSync(jsonlPath, 'utf-8'),
  });

  // Continuations
  for (const cont of continuations) {
    const relPath = cont.startsWith(jsonlDir) ? cont.slice(jsonlDir.length + 1) : cont.split('/').pop()!;
    jsonlFiles.push({
      relativePath: relPath,
      content: readFileSync(cont, 'utf-8'),
    });
  }

  // Subagent files
  const subagentDir = jsonlPath.replace(/\.jsonl$/, '') + '/subagents';
  if (existsSync(subagentDir)) {
    try {
      for (const file of readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'))) {
        jsonlFiles.push({
          relativePath: `${claudeSessionId}/subagents/${file}`,
          content: readFileSync(`${subagentDir}/${file}`, 'utf-8'),
        });
      }
    } catch { /* ignore */ }
  }

  // Extract artifact paths from all JSONL content
  const allJsonlContent = jsonlFiles.map(f => f.content).join('\n');
  readJsonlWithSubagents(jsonlPath, allLines);
  const artifactPaths = extractArtifactPaths(allJsonlContent, projectDir);

  // Read artifact files from disk
  const artifactFiles: Array<{ path: string; content: string }> = [];
  for (const relPath of artifactPaths) {
    const full = resolve(projectDir, relPath);
    if (!full.startsWith(projectDir)) continue;
    if (existsSync(full)) {
      try {
        artifactFiles.push({ path: relPath, content: readFileSync(full, 'utf-8') });
      } catch { /* skip binary/unreadable */ }
    }
  }

  return c.json({
    claudeSessionId,
    projectDir,
    sanitizedProjectDir: sanitized,
    jsonlFiles,
    artifactFiles,
    sessionMetadata: {
      id: row.session.id,
      status: row.session.status,
      feedbackId: row.session.feedbackId,
      agentEndpointId: row.session.agentEndpointId,
      parentSessionId: row.session.parentSessionId,
      launcherId: row.session.launcherId,
      permissionProfile: row.session.permissionProfile,
    },
  });
});

agentSessionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, id))
    .get();

  if (!session) {
    return c.json({ error: 'Not found' }, 404);
  }

  if (session.status === 'running' || session.status === 'pending') {
    await killSession(id);
  }

  await db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, id));
  return c.json({ id, deleted: true });
});
