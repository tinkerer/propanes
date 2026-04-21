import { Hono } from 'hono';
import { eq, desc, ne, and, inArray, or, sql } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { db, schema } from '../db/index.js';
import { killSession } from '../agent-sessions.js';
import { resumeAgentSession, dispatchTerminalSession, transferSession, getTransfer } from '../dispatch.js';
import { getSessionLiveStates, inputSessionRemote } from '../session-service-client.js';
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

// Resolve the JSONL path, falling back to session cwd when the app's projectDir doesn't match.
// Fafo runs use a temp directory as cwd, so the JSONL file lives under that path, not the app's projectDir.
function resolveJsonlPath(appProjectDir: string | null, sessionCwd: string | null, claudeSessionId: string | null): string | null {
  const primary = computeJsonlPath(appProjectDir || process.cwd(), claudeSessionId);
  if (primary && existsSync(primary)) return primary;
  if (sessionCwd && sessionCwd !== (appProjectDir || process.cwd())) {
    const fallback = computeJsonlPath(sessionCwd, claudeSessionId);
    if (fallback && existsSync(fallback)) return fallback;
  }
  return primary; // return primary even if missing, so callers get a meaningful error path
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
    const jsonlPath = resolveJsonlPath(row.appProjectDir, row.session.cwd, row.session.claudeSessionId);
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
    const jsonlPath = resolveJsonlPath(row.appProjectDir, row.session.cwd, row.session.claudeSessionId);
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

// Select specific columns — exclude output_log (up to 512KB per row) for list queries
const sessionSelectFields = {
  id: schema.agentSessions.id,
  feedbackId: schema.agentSessions.feedbackId,
  agentEndpointId: schema.agentSessions.agentEndpointId,
  permissionProfile: schema.agentSessions.permissionProfile,
  parentSessionId: schema.agentSessions.parentSessionId,
  status: schema.agentSessions.status,
  pid: schema.agentSessions.pid,
  exitCode: schema.agentSessions.exitCode,
  outputBytes: schema.agentSessions.outputBytes,
  lastOutputSeq: schema.agentSessions.lastOutputSeq,
  lastInputSeq: schema.agentSessions.lastInputSeq,
  launcherId: schema.agentSessions.launcherId,
  machineId: schema.agentSessions.machineId,
  claudeSessionId: schema.agentSessions.claudeSessionId,
  companionSessionId: schema.agentSessions.companionSessionId,
  cwd: schema.agentSessions.cwd,
  spriteConfigId: schema.agentSessions.spriteConfigId,
  spriteExecSessionId: schema.agentSessions.spriteExecSessionId,
  createdAt: schema.agentSessions.createdAt,
  startedAt: schema.agentSessions.startedAt,
  completedAt: schema.agentSessions.completedAt,
  lastActivityAt: schema.agentSessions.lastActivityAt,
  feedbackTitle: schema.feedbackItems.title,
  feedbackAppId: schema.feedbackItems.appId,
  agentName: schema.agentEndpoints.name,
  agentAppId: schema.agentEndpoints.appId,
  appProjectDir: schema.applications.projectDir,
};

function sessionBaseQuery() {
  return db
    .select(sessionSelectFields)
    .from(schema.agentSessions)
    .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
    .leftJoin(schema.agentEndpoints, eq(schema.agentSessions.agentEndpointId, schema.agentEndpoints.id))
    .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id));
}

type SessionRow = ReturnType<typeof sessionBaseQuery>['_']['result'][number];

async function enrichSessions(rows: SessionRow[]) {
  const liveStates = await getSessionLiveStates();

  // Build session→swarm/run lookup from wiggumRuns
  const allRunsForLookup = db.select({
    id: schema.wiggumRuns.id,
    sessionId: schema.wiggumRuns.sessionId,
    swarmId: schema.wiggumRuns.swarmId,
    iterations: schema.wiggumRuns.iterations,
  }).from(schema.wiggumRuns).all();
  const runBySessionId = new Map<string, { runId: string; swarmId: string | null }>();
  for (const r of allRunsForLookup) {
    if (r.sessionId) runBySessionId.set(r.sessionId, { runId: r.id, swarmId: r.swarmId });
    // Also check iterations JSON for legacy wiggum runs
    try {
      const iters = JSON.parse(r.iterations || '[]');
      for (const iter of iters) {
        if (iter.sessionId && !runBySessionId.has(iter.sessionId)) {
          runBySessionId.set(iter.sessionId, { runId: r.id, swarmId: r.swarmId });
        }
      }
    } catch { /* ignore */ }
  }
  const allSwarms = db.select({ id: schema.wiggumSwarms.id, name: schema.wiggumSwarms.name }).from(schema.wiggumSwarms).all();
  const swarmNameMap = new Map(allSwarms.map(s => [s.id, s.name]));

  const allMachines = db.select().from(schema.machines).all();
  const machineMap = new Map(allMachines.map(m => [m.id, m]));
  const allHarnessConfigs = db.select().from(schema.harnessConfigs).all();
  const harnessConfigMap = new Map(allHarnessConfigs.map(h => [h.id, h]));

  return rows.map((r) => {
    const live = liveStates[r.id];

    let launcherName: string | null = null;
    let launcherHostname: string | null = null;
    let machineName: string | null = null;
    let harnessName: string | null = null;
    let harnessAppPort: number | null = null;
    let isRemote = false;
    let isHarness = false;

    if (r.launcherId) {
      const launcher = getLauncher(r.launcherId);
      if (launcher) {
        launcherName = launcher.name;
        launcherHostname = launcher.hostname;
        isRemote = !launcher.isLocal;
        isHarness = !!launcher.harness;
        if (launcher.harness?.appPort) harnessAppPort = launcher.harness.appPort;
        if (launcher.machineId) {
          const machine = machineMap.get(launcher.machineId);
          if (machine) machineName = machine.name;
        }
        if (launcher.harnessConfigId) {
          const harness = harnessConfigMap.get(launcher.harnessConfigId);
          if (harness) {
            harnessName = harness.name;
            if (!harnessAppPort && harness.appPort) harnessAppPort = harness.appPort;
          }
        }
      } else {
        if (r.machineId) {
          const machine = machineMap.get(r.machineId);
          if (machine) { machineName = machine.name; isRemote = machine.type !== 'local'; }
        }
      }
    }

    return {
      id: r.id,
      feedbackId: r.feedbackId,
      agentEndpointId: r.agentEndpointId,
      permissionProfile: r.permissionProfile,
      parentSessionId: r.parentSessionId,
      status: r.status,
      pid: r.pid,
      exitCode: r.exitCode,
      outputBytes: r.outputBytes,
      lastOutputSeq: r.lastOutputSeq,
      lastInputSeq: r.lastInputSeq,
      launcherId: r.launcherId,
      machineId: r.machineId,
      claudeSessionId: r.claudeSessionId,
      companionSessionId: r.companionSessionId,
      cwd: r.cwd || null,
      spriteConfigId: r.spriteConfigId,
      spriteExecSessionId: r.spriteExecSessionId,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      lastActivityAt: r.lastActivityAt,
      feedbackTitle: r.feedbackTitle || null,
      agentName: r.agentName || null,
      appId: r.feedbackAppId || r.agentAppId || null,
      inputState: live?.inputState || (r.status === 'running' ? 'active' : null),
      paneTitle: live?.paneTitle || null,
      paneCommand: live?.paneCommand || null,
      panePath: live?.panePath || null,
      jsonlPath: resolveJsonlPath(r.appProjectDir, r.cwd, r.claudeSessionId),
      launcherName,
      launcherHostname,
      machineName,
      harnessName,
      isRemote,
      isHarness,
      harnessAppPort,
      // Swarm/wiggum run linkage
      ...((() => {
        const runInfo = runBySessionId.get(r.id);
        if (!runInfo) return {};
        return {
          wiggumRunId: runInfo.runId,
          swarmId: runInfo.swarmId || null,
          swarmName: runInfo.swarmId ? (swarmNameMap.get(runInfo.swarmId) || null) : null,
        };
      })()),
    };
  });
}

/** Build the full session list (no filters). Used by admin-push for WebSocket broadcast. */
export async function buildSessionList() {
  const rows = sessionBaseQuery()
    .where(ne(schema.agentSessions.status, 'deleted'))
    .orderBy(desc(schema.agentSessions.createdAt))
    .all();
  return enrichSessions(rows);
}

agentSessionRoutes.get('/', async (c) => {
  const feedbackId = c.req.query('feedbackId');
  const includeDeleted = c.req.query('includeDeleted') === 'true';
  const includeParam = c.req.query('include');
  const includeIds = includeParam ? includeParam.split(',').filter(Boolean) : [];
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 1000) : 0;

  let rows;
  if (feedbackId) {
    const where = includeDeleted
      ? eq(schema.agentSessions.feedbackId, feedbackId)
      : and(eq(schema.agentSessions.feedbackId, feedbackId), ne(schema.agentSessions.status, 'deleted'));
    rows = sessionBaseQuery()
      .where(where)
      .orderBy(desc(schema.agentSessions.createdAt))
      .all();
  } else if (includeIds.length > 0) {
    const activeStatuses = ['running', 'pending', 'dispatching'];
    const notDeleted = ne(schema.agentSessions.status, 'deleted');
    const isActive = inArray(schema.agentSessions.status, activeStatuses);
    const isIncluded = inArray(schema.agentSessions.id, includeIds);
    const where = includeDeleted
      ? or(isActive, isIncluded)
      : and(notDeleted, or(isActive, isIncluded));
    rows = sessionBaseQuery()
      .where(where)
      .orderBy(desc(schema.agentSessions.createdAt))
      .all();
    const recentLimit = limit || 100;
    const existingIds = new Set(rows.map(r => r.id));
    const recentWhere = includeDeleted ? undefined : notDeleted;
    const recentRows = sessionBaseQuery()
      .where(recentWhere)
      .orderBy(desc(schema.agentSessions.createdAt))
      .limit(recentLimit)
      .all();
    for (const r of recentRows) {
      if (!existingIds.has(r.id)) {
        rows.push(r);
        existingIds.add(r.id);
      }
    }
  } else {
    const where = includeDeleted ? undefined : ne(schema.agentSessions.status, 'deleted');
    const q = sessionBaseQuery()
      .where(where)
      .orderBy(desc(schema.agentSessions.createdAt));
    rows = limit ? q.limit(limit).all() : q.all();
  }

  const sessions = await enrichSessions(rows);
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
  const permissionProfile = body.permissionProfile || undefined;
  const additionalPrompt = typeof body.additionalPrompt === 'string' ? body.additionalPrompt : undefined;
  try {
    const { sessionId } = await resumeAgentSession(id, targetLauncherId, permissionProfile, additionalPrompt);
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
  if (process.platform !== 'darwin') {
    return c.json({ error: 'Open in Terminal.app is only supported on macOS' }, 400);
  }
  const sessionId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { sshUser, sshHost, sshPort } = body as { sshUser?: string; sshHost?: string; sshPort?: number };

  let command: string;
  if (sshUser && sshHost) {
    if (!/^[a-zA-Z0-9._-]+$/.test(sshUser) || !/^[a-zA-Z0-9._-]+$/.test(sshHost)) {
      return c.json({ error: 'Invalid sshUser or sshHost' }, 400);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return c.json({ error: 'Invalid sessionId' }, 400);
    }
    const portFlag = sshPort ? ` -p ${Number(sshPort)}` : '';
    command = `ssh ${sshUser}@${sshHost}${portFlag} -t "tmux -L propanes attach-session -t pw-${sessionId}"`;
  } else {
    command = `tmux -L propanes attach-session -t pw-${sessionId}`;
  }

  const { exec } = await import('node:child_process');
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  exec(`osascript -e 'tell application "Terminal" to do script "${escaped}"' -e 'tell application "Terminal" to activate'`);
  return c.json({ ok: true, command });
});

agentSessionRoutes.post('/:id/send-keys', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { keys, enter } = body as { keys?: string; enter?: boolean };
  if (!keys) return c.json({ error: 'keys is required' }, 400);

  const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get();
  if (!session) return c.json({ error: 'Session not found' }, 404);

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
        }, 'send_keys_result', 10_000) as any;
        return c.json({ ok: result.ok, error: result.error });
      } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
      }
    }
  }

  // Local — write to PTY via session-service
  try {
    const data = keys + (enter !== false ? '\r' : '');
    await inputSessionRemote(id, data);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

agentSessionRoutes.post('/:id/capture-pane', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { lastN } = body as { lastN?: number };

  const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get();
  if (!session) return c.json({ error: 'Session not found' }, 404);

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
        }, 'capture_pane_result', 10_000) as any;
        return c.json({ ok: result.ok, content: result.content, error: result.error });
      } catch (err: any) {
        return c.json({ ok: false, error: err.message }, 500);
      }
    }
  }

  // Local — get output buffer from session-service
  try {
    const { captureSessionOutput } = await import('../session-service-client.js');
    const content = await captureSessionOutput(id);
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
      cwd: schema.agentSessions.cwd,
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

  const jsonlPath = resolveJsonlPath(row.appProjectDir, row.cwd, row.claudeSessionId);
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
  // Optional: return only the last N lines of the merged output. Keeps the
  // initial payload small for mobile clients that freeze parsing multi-MB
  // JSONL synchronously. Desktop callers can omit it for the full history.
  const tailParam = c.req.query('tail');
  const tailN = tailParam ? Math.max(0, parseInt(tailParam, 10) || 0) : 0;
  const row = db
    .select({
      claudeSessionId: schema.agentSessions.claudeSessionId,
      cwd: schema.agentSessions.cwd,
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

  const jsonlPath = resolveJsonlPath(row.appProjectDir, row.cwd, row.claudeSessionId);
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
    const out = tailN > 0 ? lines.slice(-tailN) : lines;
    return c.text(out.join('\n'));
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

  const out = tailN > 0 ? allLines.slice(-tailN) : allLines;
  return c.text(out.join('\n'));
});

agentSessionRoutes.post('/:id/tail-jsonl', async (c) => {
  const id = c.req.param('id');
  const row = db
    .select({
      claudeSessionId: schema.agentSessions.claudeSessionId,
      cwd: schema.agentSessions.cwd,
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

  const jsonlPath = resolveJsonlPath(row.appProjectDir, row.cwd, row.claudeSessionId);
  if (!jsonlPath) {
    return c.json({ error: 'No JSONL path available (missing projectDir or claudeSessionId)' }, 400);
  }
  if (!existsSync(jsonlPath)) {
    return c.json({ error: `JSONL file not found: ${jsonlPath}` }, 404);
  }

  const { sessionId } = await dispatchTerminalSession({ cwd: '/tmp' });

  // Send tail command to the new terminal after shell starts
  setTimeout(async () => {
    try {
      await inputSessionRemote(sessionId, `tail -f ${jsonlPath}\r`);
    } catch (err: any) {
      console.error('Failed to send tail command:', err.message);
    }
  }, 800);

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

  const claudeSessionId = row.session.claudeSessionId;
  if (!claudeSessionId) {
    return c.json({ error: 'Missing claudeSessionId' }, 400);
  }

  const jsonlPath = resolveJsonlPath(row.appProjectDir, row.session.cwd, claudeSessionId);
  if (!jsonlPath || !existsSync(jsonlPath)) {
    return c.json({ error: 'JSONL file not found' }, 404);
  }

  // Derive the effective projectDir from the resolved jsonlPath
  const effectiveProjectDir = computeJsonlPath(row.appProjectDir || process.cwd(), claudeSessionId) === jsonlPath
    ? (row.appProjectDir || process.cwd())
    : (row.session.cwd || row.appProjectDir || process.cwd());
  const pkg = exportSessionFiles(effectiveProjectDir, claudeSessionId);
  const sanitized = effectiveProjectDir.replaceAll('/', '-').replaceAll('.', '-');

  return c.json({
    claudeSessionId,
    projectDir: effectiveProjectDir,
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
