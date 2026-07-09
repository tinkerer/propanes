import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { and, eq, isNotNull, inArray } from 'drizzle-orm';
import { app } from './app.js';
import { runMigrations, db, schema } from './db/index.js';
import { reconcileUsage } from './metering.js';
import { destroyWorktreeIsolate, branchForIsolatePath } from './isolates.js';
import { registerSession } from './sessions.js';
import { verifyAdminToken } from './auth.js';
import {
  attachAdmin,
  detachAdmin,
  forwardToService,
  broadcastToLauncherSessionAdmins,
  cleanupOrphanedSessions,
} from './agent-sessions.js';
import { startFAFOPoller } from './fafo-controller.js';
import {
  registerLauncher,
  unregisterLauncher,
  updateHeartbeat,
  removeSessionFromLauncher,
  addSessionToLauncher,
  startPruneTimer,
  stopPruneTimer,
  resolveLauncherResponse,
  getLauncher,
} from './launcher-registry.js';
import type { LaunchSession, LauncherToServerMessage, LauncherRegistered } from '@propanes/shared';
import { ptyColsForProfile } from '@propanes/shared';
import { registerAutoDispatch } from './auto-dispatch.js';
import { rearmPendingDispatchesOnStartup } from './voice/deferred-dispatch.js';
import { updateFeedbackOnSessionEnd, fixStaleDispatchStatuses } from './feedback-status.js';
import { cleanupSyncBranch } from './dispatch.js';
import { detectAndStoreJsonlContinuations } from './jsonl-utils.js';
import { registerAdminClient, unregisterAdminClient } from './admin-push.js';
import { startAdminWatcher } from './admin-watcher.js';
import { dispatchPendingFollowups } from './routes/admin/session-followups.js';
import { startRetentionSweeper } from './routes/admin/cos-retention.js';
import { ensureCosThreadsForOrphanSessions } from './cos-inbox.js';
import { detectClaudeAuthRequired } from './claude-auth-detect.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const LAUNCHER_AUTH_TOKEN = process.env.LAUNCHER_AUTH_TOKEN || '';

runMigrations();
registerAutoDispatch();
rearmPendingDispatchesOnStartup();
startPruneTimer();

const staleFixed = fixStaleDispatchStatuses();
if (staleFixed > 0) console.log(`[startup] Fixed ${staleFixed} stale dispatch statuses`);

function maybeOpenLauncherClaudeLoginCompanion(sessionId: string, data?: string): void {
  if (!data) return;

  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  if (!session) return;
  if (!detectClaudeAuthRequired(`${session.outputLog || ''}${data}`)) return;
  if (session.runtime !== 'claude' || session.permissionProfile === 'plain') return;
  if (!session.launcherId || session.companionSessionId) return;

  const launcher = getLauncher(session.launcherId);
  if (!launcher || launcher.ws.readyState !== 1) return;

  const companionSessionId = ulid();
  const now = new Date().toISOString();
  db.insert(schema.agentSessions)
    .values({
      id: companionSessionId,
      feedbackId: null,
      agentEndpointId: null,
      runtime: 'claude',
      permissionProfile: 'interactive-require',
      parentSessionId: sessionId,
      status: 'pending',
      outputBytes: 0,
      launcherId: launcher.id,
      cwd: session.cwd || null,
      title: `Claude login ${sessionId.slice(-6)}`,
      createdAt: now,
    })
    .run();
  db.update(schema.agentSessions)
    .set({ companionSessionId })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();

  const msg: LaunchSession = {
    type: 'launch_session',
    sessionId: companionSessionId,
    prompt: '',
    cwd: session.cwd || '~',
    runtime: 'claude',
    permissionProfile: 'interactive-require',
    cols: ptyColsForProfile('interactive-require'),
    rows: 40,
  };
  launcher.ws.send(JSON.stringify(msg));
  addSessionToLauncher(launcher.id, companionSessionId);
  broadcastToLauncherSessionAdmins(sessionId, JSON.stringify({
    type: 'login_required',
    sessionId,
    companionSessionId,
  }));
  console.log(`[launcher] Claude auth required for ${sessionId}; spawned login companion ${companionSessionId}`);
}

// Delay orphan cleanup so the session-service has time to recover tmux sessions
setTimeout(() => {
  cleanupOrphanedSessions().catch(err => {
    console.error('Failed to cleanup orphaned sessions:', err);
  });
}, 10_000);

// Sweep for pending follow-up prompts on exited sessions every 5s. Latency
// between a session exit and the follow-up dispatch is bounded by this
// interval plus the admin-watcher poll that picks up the new session.
setInterval(() => {
  dispatchPendingFollowups().catch((err) => {
    console.error('[session-followups] sweep failed:', err);
  });
}, 5_000);

// Tear down worktree isolates whose per_session session has reached a terminal
// status. isolate_id is cleared after a successful sweep so we don't reprocess
// historical rows every tick.
function sweepTerminalIsolates(): void {
  const rows = db
    .select({ id: schema.agentSessions.id, isolateId: schema.agentSessions.isolateId })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.isolation, 'per_session'),
        isNotNull(schema.agentSessions.isolateId),
        inArray(schema.agentSessions.status, ['completed', 'failed', 'killed', 'deleted']),
      ),
    )
    .all();
  for (const row of rows) {
    if (!row.isolateId) continue;
    destroyWorktreeIsolate({ path: row.isolateId, branch: branchForIsolatePath(row.isolateId) });
    db.update(schema.agentSessions).set({ isolateId: null }).where(eq(schema.agentSessions.id, row.id)).run();
  }
}

// Phase 5 — every 60s: finalize the usage meter from terminal session state
// and tear down worktree isolates whose session has ended. Both are idempotent
// and cover all session exit paths (local session-service, remote launcher,
// harness, sprite) without threading teardown through each one.
setInterval(() => {
  try {
    reconcileUsage();
    sweepTerminalIsolates();
  } catch (err) {
    console.error('[phase5] usage/isolate sweep failed:', err);
  }
}, 60_000);

// Channel retention: every 5 min, archive threads in channels whose
// policy.retention.archiveAfterDays cutoff has passed.
startRetentionSweeper();

// Auto-mint a cos_threads row (under SESSIONS_AGENT_ID) for every agent_sessions
// row that lacks one, so every running session shows up as a thread in the CoS
// pane. Runs at startup and on a 30s sweep to catch sessions inserted by code
// paths that don't yet call ensureCosThreadsForOrphanSessions directly.
ensureCosThreadsForOrphanSessions()
  .then((n) => { if (n > 0) console.log(`[startup] Auto-minted ${n} session threads`); })
  .catch((err) => console.error('[startup] ensureCosThreadsForOrphanSessions failed:', err));
setInterval(() => {
  ensureCosThreadsForOrphanSessions().catch((err) => {
    console.error('[cos-inbox] orphan-session sweep failed:', err);
  });
}, 30_000);

// Backfill JSONL continuation cache for completed sessions
setTimeout(() => {
  try {
    const rows = db.select({
      claudeSessionId: schema.agentSessions.claudeSessionId,
      appProjectDir: schema.applications.projectDir,
    })
      .from(schema.agentSessions)
      .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
      .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
      .all();

    let backfilled = 0;
    for (const row of rows) {
      if (!row.claudeSessionId) continue;
      const projDir = row.appProjectDir || process.cwd();
      try {
        detectAndStoreJsonlContinuations(row.claudeSessionId, projDir);
        backfilled++;
      } catch { /* skip individual failures */ }
    }
    if (backfilled > 0) console.log(`[startup] Backfilled JSONL continuations for ${backfilled} sessions`);
  } catch (err) {
    console.error('[startup] Failed to backfill JSONL continuations:', err);
  }
}, 5_000);

import { hostname } from 'node:os';
import { ulid } from 'ulidx';
import type { HarnessMetadata } from '@propanes/shared';

function ensureLocalMachine(): string {
  const existing = db.select().from(schema.machines).where(eq(schema.machines.type, 'local')).get();
  if (existing) return existing.id;

  const id = ulid();
  const now = new Date().toISOString();
  const name = hostname();
  db.insert(schema.machines).values({
    id,
    name,
    hostname: name,
    type: 'local',
    status: 'online',
    tags: JSON.stringify(['local']),
    createdAt: now,
    updatedAt: now,
  }).run();
  console.log(`[startup] Auto-created local machine "${name}" (${id})`);
  return id;
}

const localMachineId = ensureLocalMachine();

// Start FAFO auto-advance poller (checks every 15s for completed generations)
startFAFOPoller(15_000);

// Auto-rebuild admin bundle when src changes (opt-in via env).
// The server serves packages/admin/dist statically; without this watcher a
// stale bundle gets served after agents edit packages/admin/src until someone
// runs `vite build` by hand.
if (process.env.ADMIN_WATCH === '1') {
  startAdminWatcher();
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`Server running on ${url}`);
  console.log('');
  console.log('━━━ Copy this into your Claude Code session ━━━');
  console.log('');
  console.log(`Read ${url}/GETTING_STARTED.md — it has everything you need to register an app, create an agent endpoint, and embed the widget.`);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Self-register as a harness when running inside Docker harness
  if (process.env.HARNESS_MODE === 'true') {
    const harness: HarnessMetadata = {
      targetAppUrl: process.env.TARGET_APP_URL || 'http://pw-app:80',
      browserMcpUrl: process.env.BROWSER_MCP_URL || 'http://pw-browser:8931/mcp',
      appImage: process.env.APP_IMAGE || undefined,
      appPort: process.env.APP_PORT ? parseInt(process.env.APP_PORT, 10) : undefined,
      serverPort: info.port,
    };
    const now = new Date().toISOString();
    registerLauncher({
      id: process.env.HARNESS_ID || `harness-${hostname()}`,
      name: process.env.HARNESS_NAME || 'Docker Harness',
      hostname: hostname(),
      ws: null as any,
      connectedAt: now,
      lastHeartbeat: now,
      activeSessions: new Set(),
      capabilities: { maxSessions: 0, hasClaudeCli: false },
      harness,
      isLocal: true,
      machineId: localMachineId,
    });
    console.log('[harness] Self-registered as harness');
  }
});

// Widget session WebSocket
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');
  const apiKey = url.searchParams.get('apiKey');

  if (!sessionId) {
    ws.close(4001, 'Missing sessionId');
    return;
  }

  let appId: string | undefined;
  let screenshotIncludeWidget = true;
  let autoDispatch = true;
  if (apiKey) {
    const application = db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.apiKey, apiKey))
      .get();
    if (application) {
      appId = application.id;
      screenshotIncludeWidget = !!application.screenshotIncludeWidget;
      autoDispatch = !!application.autoDispatch;
    }
  }

  ws.send(JSON.stringify({ type: 'config', screenshotIncludeWidget, autoDispatch }));

  const session = registerSession(sessionId, ws, {
    userAgent: req.headers['user-agent'],
    appId,
  });

  console.log(`Session connected: ${sessionId}${appId ? ` (app: ${appId})` : ''}`);

  ws.on('close', () => {
    console.log(`Session disconnected: ${sessionId}`);
  });
});

// Agent session WebSocket — auth here, then bridge to session service
const agentWss = new WebSocketServer({ noServer: true });

agentWss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');
  const token = url.searchParams.get('token');

  if (!sessionId || !token) {
    ws.close(4001, 'Missing sessionId or token');
    return;
  }

  const isValid = await verifyAdminToken(token);
  if (!isValid) {
    ws.close(4003, 'Invalid token');
    return;
  }

  const attached = attachAdmin(sessionId, ws);
  if (!attached) {
    ws.close(4004, 'Session not found');
    return;
  }

  console.log(`Admin attached to agent session: ${sessionId}`);

  ws.on('message', (raw) => {
    forwardToService(ws, raw.toString());
  });

  ws.on('close', () => {
    detachAdmin(sessionId, ws);
    console.log(`Admin detached from agent session: ${sessionId}`);
  });
});

// Admin push WebSocket — broadcasts state updates to admin UI
const adminWss = new WebSocketServer({ noServer: true });

adminWss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  const isValid = await verifyAdminToken(token);
  if (!isValid) {
    ws.close(4003, 'Invalid token');
    return;
  }

  registerAdminClient(ws);
  console.log(`[admin-ws] Client connected`);

  ws.on('close', () => {
    unregisterAdminClient(ws);
    console.log(`[admin-ws] Client disconnected`);
  });

  ws.on('error', () => {
    unregisterAdminClient(ws);
  });
});

// Launcher WebSocket — launcher daemons connect here
const launcherWss = new WebSocketServer({ noServer: true });

launcherWss.on('connection', (ws, req) => {
  let launcherId: string | null = null;
  console.log(`[launcher-ws] New connection from ${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    try {
      const msg: LauncherToServerMessage = JSON.parse(raw.toString());

      // Check if this is a response to a pending sendAndWait request
      if (resolveLauncherResponse(msg)) return;

      switch (msg.type) {
        case 'launcher_register': {
          if (LAUNCHER_AUTH_TOKEN && msg.authToken !== LAUNCHER_AUTH_TOKEN) {
            const reply: LauncherRegistered = { type: 'launcher_registered', ok: false, error: 'Invalid auth token' };
            ws.send(JSON.stringify(reply));
            ws.close(4003, 'Invalid auth token');
            return;
          }
          launcherId = msg.id;
          registerLauncher({
            id: msg.id,
            name: msg.name,
            hostname: msg.hostname,
            ws,
            connectedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            activeSessions: new Set(),
            capabilities: msg.capabilities,
            harness: msg.harness,
            machineId: msg.machineId,
            harnessConfigId: msg.harnessConfigId,
            version: msg.version,
          });
          const reply: LauncherRegistered = { type: 'launcher_registered', ok: true };
          ws.send(JSON.stringify(reply));
          break;
        }

        case 'launcher_heartbeat':
          if (launcherId) {
            updateHeartbeat(launcherId, msg.activeSessions);
          }
          break;

        case 'launcher_session_started': {
          const now = new Date().toISOString();
          db.update(schema.agentSessions)
            .set({
              status: 'running',
              pid: msg.pid,
              startedAt: now,
              completedAt: null,
              exitCode: null,
              lastOutputSeq: 0,
              lastInputSeq: 0,
              outputBytes: 0,
            })
            .where(eq(schema.agentSessions.id, msg.sessionId))
            .run();
          break;
        }

        case 'launcher_session_output': {
          const output = msg.output;
          broadcastToLauncherSessionAdmins(msg.sessionId, JSON.stringify(output));
          maybeOpenLauncherClaudeLoginCompanion(msg.sessionId, output.content?.data);

          // Also accumulate in DB
          if (output.content?.data) {
            const session = db
              .select()
              .from(schema.agentSessions)
              .where(eq(schema.agentSessions.id, msg.sessionId))
              .get();
            if (session) {
              const existing = session.outputLog || '';
              const updated = (existing + output.content.data).slice(-500 * 1024);
              db.update(schema.agentSessions)
                .set({
                  outputLog: updated,
                  outputBytes: (session.outputBytes || 0) + Buffer.byteLength(output.content.data),
                  lastOutputSeq: output.seq,
                })
                .where(eq(schema.agentSessions.id, msg.sessionId))
                .run();
            }
          }
          break;
        }

        case 'launcher_session_ended': {
          const completedAt = new Date().toISOString();
          db.update(schema.agentSessions)
            .set({
              status: msg.status,
              exitCode: msg.exitCode,
              outputLog: msg.outputLog.slice(-500 * 1024),
              completedAt,
            })
            .where(eq(schema.agentSessions.id, msg.sessionId))
            .run();

          updateFeedbackOnSessionEnd(msg.sessionId, msg.status);

          // Look up session context for cleanup and continuations
          let endedSessionProjectDir: string | null = null;
          try {
            const endedSession = db.select({
              claudeSessionId: schema.agentSessions.claudeSessionId,
              appProjectDir: schema.applications.projectDir,
            })
              .from(schema.agentSessions)
              .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
              .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
              .where(eq(schema.agentSessions.id, msg.sessionId))
              .get();
            endedSessionProjectDir = endedSession?.appProjectDir || process.cwd();
            if (endedSession?.claudeSessionId && endedSessionProjectDir) {
              detectAndStoreJsonlContinuations(endedSession.claudeSessionId, endedSessionProjectDir);
            }
          } catch (err) {
            console.error('[jsonl-continuations] Failed to detect continuations on session end:', err);
          }

          if (launcherId) {
            removeSessionFromLauncher(launcherId, msg.sessionId);

            // Clean up sync branch (best-effort, non-blocking)
            if (endedSessionProjectDir) {
              try { cleanupSyncBranch(endedSessionProjectDir, msg.sessionId); } catch {}
            }
          }

          broadcastToLauncherSessionAdmins(msg.sessionId, JSON.stringify({
            type: 'exit',
            exitCode: msg.exitCode,
            status: msg.status,
          }));
          break;
        }

        case 'harness_status': {
          const now = new Date().toISOString();
          const updates: Record<string, unknown> = {
            status: msg.status,
            updatedAt: now,
          };
          if (msg.errorMessage) updates.errorMessage = msg.errorMessage;
          if (msg.status === 'running') {
            updates.launcherId = launcherId;
            updates.errorMessage = null;
          }
          if (msg.status === 'stopped') {
            updates.launcherId = null;
            updates.lastStoppedAt = now;
          }
          db.update(schema.harnessConfigs)
            .set(updates)
            .where(eq(schema.harnessConfigs.id, msg.harnessConfigId))
            .run();
          break;
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[launcher-ws] Connection closed: launcher=${launcherId} code=${code} reason=${reason?.toString()}`);
    if (launcherId) {
      // Only unregister if the registry still holds THIS WebSocket
      // (avoids race when a reconnecting launcher replaces the old connection)
      const current = getLauncher(launcherId);
      if (current && current.ws === ws) {
        unregisterLauncher(launcherId);
      }
    }
  });

  ws.on('error', (err) => {
    console.log(`[launcher-ws] Connection error: launcher=${launcherId} err=${err.message}`);
    if (launcherId) {
      const current = getLauncher(launcherId);
      if (current && current.ws === ws) {
        unregisterLauncher(launcherId);
      }
    }
  });
});

// Route upgrades to appropriate WebSocket server
(server as unknown as Server).on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/ws/admin') {
    adminWss.handleUpgrade(req, socket, head, (ws) => {
      adminWss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws/agent-session') {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws/launcher') {
    launcherWss.handleUpgrade(req, socket, head, (ws) => {
      launcherWss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

process.on('SIGTERM', () => { stopPruneTimer(); process.exit(0); });
process.on('SIGINT', () => { stopPruneTimer(); process.exit(0); });
