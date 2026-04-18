import { Hono } from 'hono';
import { eq, desc, ne, and } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { db, schema } from '../db/index.js';
import { killSession } from '../agent-sessions.js';
import { resumeAgentSession, dispatchTerminalSession, transferSession, getTransfer } from '../dispatch.js';
import { getSessionLiveStates } from '../session-service-client.js';
import { getLauncher, sendAndWait } from '../launcher-registry.js';
import { listSessions, sendCommand } from '../sessions.js';
import {
  computeJsonlPath as computeJsonlPathFull,
  computeJsonlDir,
  findContinuationJsonlsCached,
  readJsonlWithSubagents,
  filterJsonlLines,
  extractArtifactPaths,
  exportSessionFiles,
  listJsonlFiles,
} from '../jsonl-utils.js';

function computeJsonlPath(projectDir: string | null, claudeSessionId: string | null): string | null {
  if (!projectDir || !claudeSessionId) return null;
  return computeJsonlPathFull(projectDir, claudeSessionId);
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

// Search JSONL content across all sessions
agentSessionRoutes.post('/search-content', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { query, errorsOnly, limit: rawLimit } = body as {
    query?: string;
    errorsOnly?: boolean;
    limit?: number;
  };

  const maxResults = Math.min(rawLimit || 20, 50);

  // Get recent non-deleted sessions
  const rows = db
    .select({
      session: schema.agentSessions,
      feedbackTitle: schema.feedbackItems.title,
      feedbackAppId: schema.feedbackItems.appId,
      agentName: schema.agentEndpoints.name,
      appProjectDir: schema.applications.projectDir,
    })
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.agentEndpoints, eq(schema.agentSessions.agentEndpointId, schema.agentEndpoints.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
    .where(ne(schema.agentSessions.status, 'deleted'))
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(100)
    .all();

  const results: Array<{
    sessionId: string;
    feedbackTitle: string | null;
    agentName: string | null;
    status: string;
    createdAt: string | null;
    errorCount: number;
    matches: Array<{ line: number; content: string; isError: boolean; toolName?: string }>;
  }> = [];

  const queryLower = query?.toLowerCase();

  for (const row of rows) {
    const projectDir = row.appProjectDir || process.cwd();
    const jsonlPath = computeJsonlPath(projectDir, row.session.claudeSessionId);
    if (!jsonlPath || !existsSync(jsonlPath)) continue;

    const allLines: string[] = [];
    try {
      const continuations = findContinuationJsonlsCached(jsonlPath);
      for (const fp of [jsonlPath, ...continuations]) {
        readJsonlWithSubagents(fp, allLines);
      }
    } catch { continue; }

    const matches: Array<{ line: number; content: string; isError: boolean; toolName?: string }> = [];
    let errorCount = 0;

    for (let i = 0; i < allLines.length; i++) {
      try {
        const obj = JSON.parse(allLines[i]);
        const isError = !!obj.is_error || obj.subtype === 'error_message';

        if (isError) errorCount++;

        // Extract readable content for matching
        let content = '';
        let toolName: string | undefined;

        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_use') {
              toolName = block.name;
            } else if (block.type === 'text') {
              content += block.text + '\n';
            }
          }
        } else if (obj.type === 'result') {
          if (typeof obj.result === 'string') content = obj.result;
          else if (obj.result?.content) {
            for (const b of obj.result.content) {
              if (b.type === 'text') content += b.text + '\n';
            }
          }
          if (obj.tool_name) toolName = obj.tool_name;
        }

        const shouldInclude = errorsOnly
          ? isError
          : (queryLower ? content.toLowerCase().includes(queryLower) || (toolName?.toLowerCase().includes(queryLower) ?? false) : isError);

        if (shouldInclude && content.trim()) {
          matches.push({
            line: i,
            content: content.slice(0, 500),
            isError,
            toolName,
          });
        }
      } catch { /* skip unparseable */ }
    }

    if (matches.length > 0 || (errorsOnly && errorCount > 0)) {
      results.push({
        sessionId: row.session.id,
        feedbackTitle: row.feedbackTitle || null,
        agentName: row.agentName || null,
        status: row.session.status,
        createdAt: row.session.createdAt,
        errorCount,
        matches: matches.slice(0, 10),
      });
    }

    if (results.length >= maxResults) break;
  }

  // Sort by error count descending
  results.sort((a, b) => b.errorCount - a.errorCount);

  return c.json({ results, total: results.length });
});

// Get error summary across all sessions
agentSessionRoutes.get('/error-summary', async (c) => {
  const rows = db
    .select({
      session: schema.agentSessions,
      feedbackTitle: schema.feedbackItems.title,
      agentName: schema.agentEndpoints.name,
      appProjectDir: schema.applications.projectDir,
    })
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.agentEndpoints, eq(schema.agentSessions.agentEndpointId, schema.agentEndpoints.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
    .where(ne(schema.agentSessions.status, 'deleted'))
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(50)
    .all();

  const sessions: Array<{
    sessionId: string;
    feedbackTitle: string | null;
    agentName: string | null;
    status: string;
    errorCount: number;
    errors: Array<{ content: string; toolName?: string }>;
  }> = [];

  for (const row of rows) {
    const projectDir = row.appProjectDir || process.cwd();
    const jsonlPath = computeJsonlPath(projectDir, row.session.claudeSessionId);
    if (!jsonlPath || !existsSync(jsonlPath)) continue;

    const allLines: string[] = [];
    try {
      const continuations = findContinuationJsonlsCached(jsonlPath);
      for (const fp of [jsonlPath, ...continuations]) {
        readJsonlWithSubagents(fp, allLines);
      }
    } catch { continue; }

    const errors: Array<{ content: string; toolName?: string }> = [];

    for (const line of allLines) {
      try {
        const obj = JSON.parse(line);
        if (!obj.is_error && obj.subtype !== 'error_message') continue;

        let content = '';
        let toolName: string | undefined;

        if (obj.type === 'result') {
          if (typeof obj.result === 'string') content = obj.result;
          else if (obj.result?.content) {
            for (const b of obj.result.content) {
              if (b.type === 'text') content += b.text + '\n';
            }
          }
          if (obj.tool_name) toolName = obj.tool_name;
        } else if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text') content += block.text + '\n';
          }
        }

        if (content.trim()) {
          errors.push({ content: content.slice(0, 300), toolName });
        }
      } catch { /* skip */ }
    }

    if (errors.length > 0) {
      sessions.push({
        sessionId: row.session.id,
        feedbackTitle: row.feedbackTitle || null,
        agentName: row.agentName || null,
        status: row.session.status,
        errorCount: errors.length,
        errors: errors.slice(0, 5),
      });
    }
  }

  sessions.sort((a, b) => b.errorCount - a.errorCount);

  // Also gather console errors from live widget sessions
  const consoleErrors: Array<{ widgetSessionId: string; url: string | null; errors: Array<{ level: string; message: string; source?: string }> }> = [];
  try {
    const liveSessions = listSessions();
    const errorPromises = liveSessions.map(async (ls) => {
      try {
        const result = await sendCommand(ls.sessionId, 'getConsole', {}, 3000) as { logs?: Array<{ level: string; message: string; source?: string }> };
        const errorLogs = (result?.logs || []).filter((l: any) => l.level === 'error' || l.level === 'warn');
        if (errorLogs.length > 0) {
          consoleErrors.push({
            widgetSessionId: ls.sessionId,
            url: ls.url || null,
            errors: errorLogs.slice(0, 10),
          });
        }
      } catch { /* session may not respond */ }
    });
    await Promise.allSettled(errorPromises);
  } catch { /* ignore */ }

  return c.json({ sessions, totalErrorSessions: sessions.length, consoleErrors });
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
    let harnessAppPort: number | null = null;
    let isRemote = false;
    let isHarness = false;

    if (r.session.launcherId) {
      const launcher = getLauncher(r.session.launcherId);
      if (launcher) {
        launcherName = launcher.name;
        launcherHostname = launcher.hostname;
        isRemote = !launcher.isLocal;
        isHarness = !!launcher.harness;
        if (launcher.harness?.appPort) harnessAppPort = launcher.harness.appPort;
        if (launcher.machineId) {
          const machine = db.select().from(schema.machines)
            .where(eq(schema.machines.id, launcher.machineId)).get();
          if (machine) machineName = machine.name;
        }
        if (launcher.harnessConfigId) {
          const harness = db.select().from(schema.harnessConfigs)
            .where(eq(schema.harnessConfigs.id, launcher.harnessConfigId)).get();
          if (harness) {
            harnessName = harness.name;
            if (!harnessAppPort && harness.appPort) harnessAppPort = harness.appPort;
          }
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
      cwd: r.session.cwd || null,
      jsonlPath: computeJsonlPath(r.appProjectDir || process.cwd(), r.session.claudeSessionId),
      launcherName,
      launcherHostname,
      machineName,
      harnessName,
      isRemote,
      isHarness,
      harnessAppPort,
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
  const { writeFileSync, chmodSync, mkdtempSync } = await import('node:fs');

  // Check if session is remote
  const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get();
  let isRemote = false;
  let hostname: string | null = null;
  if (session?.launcherId) {
    const launcher = getLauncher(session.launcherId);
    if (launcher && !launcher.isLocal) {
      isRemote = true;
      hostname = launcher.hostname;
    }
  }

  if (isRemote && hostname) {
    // Remote session — generate .command file with SSH
    try {
      const tmpDir = mkdtempSync('/tmp/pw-open-');
      const tmpFile = resolve(tmpDir, 'open.command');
      const cmd = `ssh -t ${hostname} 'TMUX= tmux -L prompt-widget attach-session -t ${tmuxName}'\nrm -rf "${tmpDir}"\n`;
      writeFileSync(tmpFile, cmd);
      chmodSync(tmpFile, 0o755);
      execFileSync('open', ['-a', 'Terminal', '-e', tmpFile], { stdio: 'pipe' });
      return c.json({ ok: true, tmuxName, remote: true, hostname });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  }

  // Local session — check tmux and use existing script
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

agentSessionRoutes.post('/:id/send-keys', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { keys, enter, tmuxTarget } = body as { keys?: string; enter?: boolean; tmuxTarget?: string };
  if (!keys) return c.json({ error: 'keys is required' }, 400);

  const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get();
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const tmuxName = tmuxTarget || `pw-${id}`;

  if (session.launcherId) {
    const launcher = getLauncher(session.launcherId);
    if (launcher && !launcher.isLocal) {
      try {
        const { ulid } = await import('ulidx');
        const reqId = ulid();
        const result = await sendAndWait(session.launcherId, {
          type: 'send_keys' as const,
          sessionId: reqId,
          targetSessionId: id,
          keys,
          enter,
          tmuxTarget,
        }, 'send_keys_result', 10_000) as any;
        return c.json({ ok: result.ok, error: result.error });
      } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
      }
    }
  }

  // Local
  try {
    const { execFileSync } = await import('node:child_process');
    const args = ['-L', 'prompt-widget', 'send-keys', '-t', tmuxName, keys];
    if (enter !== false) args.push('Enter');
    execFileSync('tmux', args, { stdio: 'pipe', timeout: 10_000 });
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

agentSessionRoutes.post('/:id/capture-pane', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { lastN, tmuxTarget } = body as { lastN?: number; tmuxTarget?: string };

  const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get();
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const tmuxName = tmuxTarget || `pw-${id}`;

  if (session.launcherId) {
    const launcher = getLauncher(session.launcherId);
    if (launcher && !launcher.isLocal) {
      try {
        const { ulid } = await import('ulidx');
        const reqId = ulid();
        const result = await sendAndWait(session.launcherId, {
          type: 'capture_pane' as const,
          sessionId: reqId,
          targetSessionId: id,
          lastN,
          tmuxTarget,
        }, 'capture_pane_result', 10_000) as any;
        return c.json({ ok: result.ok, content: result.content, error: result.error });
      } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
      }
    }
  }

  // Local
  try {
    const { execFileSync } = await import('node:child_process');
    const args = ['-L', 'prompt-widget', 'capture-pane', '-t', tmuxName, '-p'];
    if (lastN) args.push('-S', String(-lastN));
    const content = execFileSync('tmux', args, { stdio: 'pipe', timeout: 10_000 }).toString();
    return c.json({ ok: true, content });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

agentSessionRoutes.get('/:id/jsonl-files', async (c) => {
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

  const jsonlPath = computeJsonlPath(row.appProjectDir || process.cwd(), row.claudeSessionId);
  if (!jsonlPath) {
    return c.json({ error: 'No JSONL path available' }, 400);
  }

  const files = existsSync(jsonlPath) ? listJsonlFiles(jsonlPath) : [];
  return c.json({
    claudeSessionId: row.claudeSessionId,
    files: files.map(f => ({
      id: f.id,
      claudeSessionId: f.claudeSessionId,
      type: f.type,
      label: f.label,
      parentSessionId: f.parentSessionId || null,
      agentId: f.agentId || null,
      order: f.order,
    })),
  });
});

agentSessionRoutes.get('/:id/jsonl', async (c) => {
  const id = c.req.param('id');
  const fileFilter = c.req.query('file'); // optional: specific file id like "main:uuid", "cont:uuid", "sub:uuid:agentId"
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

  const jsonlPath = computeJsonlPath(row.appProjectDir || process.cwd(), row.claudeSessionId);
  if (!jsonlPath) {
    return c.json({ error: 'No JSONL path available' }, 400);
  }
  if (!existsSync(jsonlPath)) {
    return c.json({ error: `JSONL file not found: ${jsonlPath}` }, 404);
  }

  // If a specific file is requested, load just that one
  if (fileFilter) {
    const allFiles = listJsonlFiles(jsonlPath);
    const target = allFiles.find(f => f.id === fileFilter);
    if (!target) {
      return c.json({ error: `File not found: ${fileFilter}` }, 404);
    }
    if (!existsSync(target.filePath)) {
      return c.json({ error: `File missing on disk: ${target.filePath}` }, 404);
    }
    const raw = readFileSync(target.filePath, 'utf-8');
    const lines = filterJsonlLines(raw);
    return c.text(lines.join('\n'));
  }

  // Default: merged view (all files)
  const allLines: string[] = [];
  const continuations = findContinuationJsonlsCached(jsonlPath);
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

  const jsonlPath = computeJsonlPath(row.appProjectDir || process.cwd(), row.claudeSessionId);
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

  const projectDir = row.appProjectDir || process.cwd();
  const claudeSessionId = row.session.claudeSessionId;
  if (!projectDir || !claudeSessionId) {
    return c.json({ error: 'Missing projectDir or claudeSessionId' }, 400);
  }

  const jsonlPath = computeJsonlPath(projectDir, claudeSessionId);
  if (!jsonlPath || !existsSync(jsonlPath)) {
    return c.json({ error: 'JSONL file not found' }, 404);
  }

  const pkg = exportSessionFiles(projectDir, claudeSessionId);
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');

  return c.json({
    claudeSessionId,
    projectDir,
    sanitizedProjectDir: sanitized,
    jsonlFiles: pkg.jsonlFiles,
    artifactFiles: pkg.artifactFiles,
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
