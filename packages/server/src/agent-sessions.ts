import { WebSocket as WsWebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import type { PermissionProfile, InputToSession } from '@propanes/shared';
import {
  spawnSessionRemote,
  killSessionRemote,
  getSessionServiceWsUrl,
  getSessionServiceActiveSessions,
} from './session-service-client.js';
import { getLauncher, listLaunchers } from './launcher-registry.js';
import { updateFeedbackOnSessionEnd } from './feedback-status.js';
import { detectAndStoreJsonlContinuations } from './jsonl-utils.js';
import { sendInputToSprite, killSpriteSession, isSpriteSession } from './sprite-sessions.js';

// Maps admin WS → upstream target (either session-service WS or launcher info)
interface LocalBridge {
  kind: 'local';
  serviceWs: WsWebSocket;
}

interface LauncherBridge {
  kind: 'launcher';
  launcherId: string;
  sessionId: string;
}

interface SpriteBridge {
  kind: 'sprite';
  sessionId: string;
}

type Bridge = LocalBridge | LauncherBridge | SpriteBridge;

const adminBridges = new Map<WsWebSocket, Bridge>();

// Track admin sockets per launcher session so we can push output to them
const launcherSessionAdmins = new Map<string, Set<WsWebSocket>>();

export async function spawnAgentSession(params: {
  sessionId: string;
  prompt?: string;
  cwd: string;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  claudeSessionId?: string;
  resumeSessionId?: string;
}): Promise<void> {
  await spawnSessionRemote(params);
}

export function attachAdmin(sessionId: string, ws: WsWebSocket): boolean {
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();

  // Sprite session — bridge input via sprite-sessions module
  if (session?.spriteConfigId && isSpriteSession(sessionId)) {
    adminBridges.set(ws, { kind: 'sprite', sessionId });
    if (!launcherSessionAdmins.has(sessionId)) {
      launcherSessionAdmins.set(sessionId, new Set());
    }
    launcherSessionAdmins.get(sessionId)!.add(ws);

    if (session.outputLog) {
      ws.send(JSON.stringify({ type: 'history', data: session.outputLog }));
    } else {
      ws.send(JSON.stringify({ type: 'history', data: '' }));
    }
    if (session.status !== 'pending' && session.status !== 'running') {
      ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode, status: session.status }));
    }
    return true;
  }

  if (session?.launcherId) {
    const launcher = getLauncher(session.launcherId);
    if (launcher && launcher.ws.readyState === 1) {
      adminBridges.set(ws, { kind: 'launcher', launcherId: session.launcherId, sessionId });
      if (!launcherSessionAdmins.has(sessionId)) {
        launcherSessionAdmins.set(sessionId, new Set());
      }
      launcherSessionAdmins.get(sessionId)!.add(ws);

      // Send stored output history
      if (session.outputLog) {
        ws.send(JSON.stringify({ type: 'history', data: session.outputLog }));
      } else {
        ws.send(JSON.stringify({ type: 'history', data: '' }));
      }
      if (session.status !== 'pending' && session.status !== 'running') {
        ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode, status: session.status }));
      }
      return true;
    }
    // Launcher offline — fall through to DB-only path below
  }

  // No DB record at all → reject immediately
  if (!session) {
    return false;
  }

  // Local session: send DB history immediately (same as launcher path) so the
  // admin sees content right away instead of waiting for the service WS to connect.
  if (session.outputLog) {
    ws.send(JSON.stringify({ type: 'history', data: session.outputLog }));
  }
  if (session.status !== 'pending' && session.status !== 'running') {
    ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode, status: session.status }));
    return true;
  }

  // Bridge to session-service for live output
  const serviceWsUrl = getSessionServiceWsUrl(sessionId);
  const serviceWs = new WsWebSocket(serviceWsUrl);

  // Register bridge immediately so forwardToService can find it;
  // the readyState check in forwardToService handles the not-yet-open case.
  adminBridges.set(ws, { kind: 'local', serviceWs });

  let connected = false;

  serviceWs.on('open', () => {
    connected = true;
  });

  serviceWs.on('message', (raw) => {
    try {
      ws.send(raw.toString());
    } catch {
      serviceWs.close();
    }
  });

  serviceWs.on('close', (code) => {
    adminBridges.delete(ws);
    if (connected) {
      // Forward 4004 from session-service so the client stops reconnecting
      const closeCode = code === 4004 ? 4004 : 4010;
      const reason = code === 4004 ? 'Session not found' : 'Session service disconnected';
      try { ws.close(closeCode, reason); } catch {}
    }
  });

  serviceWs.on('error', () => {
    adminBridges.delete(ws);
    if (!connected) {
      if (session.status !== 'pending' && session.status !== 'running') {
        ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode, status: session.status }));
      } else {
        // Session is still pending/running but we lost the bridge — close the
        // browser WS so the terminal reconnects and gets a fresh bridge
        try { ws.close(4010, 'Session service unavailable, reconnecting'); } catch {}
      }
    }
  });

  return true;
}

export function detachAdmin(sessionId: string, ws: WsWebSocket): void {
  const bridge = adminBridges.get(ws);
  if (!bridge) return;

  if (bridge.kind === 'local') {
    bridge.serviceWs.close();
  } else {
    // launcher or sprite — both use launcherSessionAdmins
    const admins = launcherSessionAdmins.get(sessionId);
    if (admins) {
      admins.delete(ws);
      if (admins.size === 0) launcherSessionAdmins.delete(sessionId);
    }
  }
  adminBridges.delete(ws);
}

export function forwardToService(ws: WsWebSocket, data: string): void {
  const bridge = adminBridges.get(ws);
  if (!bridge) return;

  if (bridge.kind === 'sprite') {
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'input' && parsed.data) {
        sendInputToSprite(bridge.sessionId, parsed.data);
      } else if (parsed.type === 'resize') {
        // resize handled separately if needed
      }
    } catch {}
    return;
  }

  if (bridge.kind === 'local') {
    if (bridge.serviceWs.readyState === WsWebSocket.OPEN) {
      bridge.serviceWs.send(data);
    }
  } else {
    // Forward to launcher, wrapping in InputToSession
    const launcher = getLauncher(bridge.launcherId);
    if (launcher && launcher.ws.readyState === 1) {
      try {
        const parsed = JSON.parse(data);
        const msg: InputToSession = {
          type: 'input_to_session',
          sessionId: bridge.sessionId,
          input: parsed,
        };
        launcher.ws.send(JSON.stringify(msg));
      } catch {
        // malformed, ignore
      }
    }
  }
}

export function broadcastToLauncherSessionAdmins(sessionId: string, data: string): void {
  const admins = launcherSessionAdmins.get(sessionId);
  if (!admins) return;
  for (const ws of admins) {
    try {
      ws.send(data);
    } catch {
      admins.delete(ws);
    }
  }
}

export async function killSession(sessionId: string): Promise<boolean> {
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();

  if (!session || (session.status !== 'running' && session.status !== 'pending')) {
    return false;
  }

  // If session is on a sprite, kill via sprite-sessions
  if (session.spriteConfigId && isSpriteSession(sessionId)) {
    killSpriteSession(sessionId);
    db.update(schema.agentSessions)
      .set({ status: 'killed', completedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    updateFeedbackOnSessionEnd(sessionId, 'killed');
    return true;
  }

  // If session is on a launcher, send kill to launcher
  if (session.launcherId) {
    const launcher = getLauncher(session.launcherId);
    if (launcher && launcher.ws.readyState === 1) {
      launcher.ws.send(JSON.stringify({ type: 'kill_session', sessionId }));
      return true;
    }
  }

  // Local session — try session-service, then always update DB as safety net
  try {
    await killSessionRemote(sessionId);
  } catch {
    // Session service unreachable — DB update below handles it
  }

  // Always update DB directly so the main server sees 'killed' immediately,
  // even if the session-service already did it (idempotent)
  db.update(schema.agentSessions)
    .set({ status: 'killed', completedAt: new Date().toISOString() })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();

  updateFeedbackOnSessionEnd(sessionId, 'killed');

  // Detect and cache JSONL continuation chains (fire-and-forget)
  try {
    if (session.claudeSessionId) {
      const app = db.select({ projectDir: schema.applications.projectDir })
        .from(schema.feedbackItems)
        .leftJoin(schema.applications, eq(schema.feedbackItems.appId, schema.applications.id))
        .where(eq(schema.feedbackItems.id, session.feedbackId!))
        .get();
      if (app?.projectDir) {
        detectAndStoreJsonlContinuations(session.claudeSessionId, app.projectDir);
      }
    }
  } catch { /* non-critical */ }

  return true;
}

export async function cleanupOrphanedSessions(): Promise<void> {
  const runningSessions = db
    .select({ id: schema.agentSessions.id, launcherId: schema.agentSessions.launcherId })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.status, 'running'))
    .all();

  if (runningSessions.length === 0) return;

  // Check which sessions are still alive in the session-service
  // Returns null if the service is unreachable
  const activeSvcResult = await getSessionServiceActiveSessions();

  // Check which sessions are on connected launchers
  const launcherSessions = new Set<string>();
  for (const launcher of listLaunchers()) {
    if (launcher.ws.readyState === 1) {
      for (const sid of launcher.activeSessions) {
        launcherSessions.add(sid);
      }
    }
  }

  const activeSvcSessions = activeSvcResult ? new Set(activeSvcResult) : null;

  const now = new Date().toISOString();
  for (const session of runningSessions) {
    // Session-service confirms it's alive
    if (activeSvcSessions?.has(session.id)) continue;
    // Sprite session still active
    if (isSpriteSession(session.id)) continue;
    // Launcher confirms it's alive
    if (session.launcherId && launcherSessions.has(session.id)) continue;
    // Session-service was unreachable — can't confirm liveness, skip
    if (!activeSvcSessions) continue;

    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt: now })
      .where(eq(schema.agentSessions.id, session.id))
      .run();
    updateFeedbackOnSessionEnd(session.id, 'failed');
  }
}

export function getSessionStatus(sessionId: string): string | null {
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  return session?.status || null;
}
