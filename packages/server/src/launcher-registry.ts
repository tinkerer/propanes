import type { WebSocket } from 'ws';
import type { LauncherCapabilities, HarnessMetadata, ServerToLauncherMessage, LauncherToServerMessage } from '@prompt-widget/shared';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

export interface LauncherInfo {
  id: string;
  name: string;
  hostname: string;
  ws: WebSocket;
  connectedAt: string;
  lastHeartbeat: string;
  activeSessions: Set<string>;
  capabilities: LauncherCapabilities;
  harness?: HarnessMetadata;
  isLocal?: boolean;
  machineId?: string;
  harnessConfigId?: string;
}

const launchers = new Map<string, LauncherInfo>();

let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function registerLauncher(info: LauncherInfo): void {
  const existing = launchers.get(info.id);
  if (existing && existing.ws && existing.ws !== info.ws) {
    try { existing.ws.close(4010, 'Replaced by new connection'); } catch {}
  }
  launchers.set(info.id, info);
  console.log(`[launcher-registry] Registered: ${info.id} (${info.name}@${info.hostname})${info.harness ? ' [harness]' : ''}${info.machineId ? ` [machine:${info.machineId}]` : ''}`);

  const now = new Date().toISOString();

  // Update machine status to online
  if (info.machineId) {
    try {
      db.update(schema.machines)
        .set({ status: 'online', lastSeenAt: now, updatedAt: now })
        .where(eq(schema.machines.id, info.machineId))
        .run();
    } catch {}
  }

  // Update harness config status to running
  if (info.harnessConfigId) {
    try {
      db.update(schema.harnessConfigs)
        .set({ status: 'running', launcherId: info.id, updatedAt: now })
        .where(eq(schema.harnessConfigs.id, info.harnessConfigId))
        .run();
    } catch {}
  }
}

export function unregisterLauncher(id: string): void {
  const info = launchers.get(id);
  launchers.delete(id);
  console.log(`[launcher-registry] Unregistered: ${id}`);

  if (!info) return;
  const now = new Date().toISOString();

  // Check if machine still has other launchers before marking offline
  if (info.machineId) {
    const otherFromSameMachine = Array.from(launchers.values()).some(
      l => l.machineId === info.machineId
    );
    if (!otherFromSameMachine) {
      try {
        db.update(schema.machines)
          .set({ status: 'offline', updatedAt: now })
          .where(eq(schema.machines.id, info.machineId))
          .run();
      } catch {}
    }
  }

  // Update harness config status
  if (info.harnessConfigId) {
    try {
      db.update(schema.harnessConfigs)
        .set({ status: 'stopped', launcherId: null, lastStoppedAt: now, updatedAt: now })
        .where(eq(schema.harnessConfigs.id, info.harnessConfigId))
        .run();
    } catch {}
  }
}

export function getLauncher(id: string): LauncherInfo | undefined {
  return launchers.get(id);
}

export function listLaunchers(): LauncherInfo[] {
  return Array.from(launchers.values());
}

export function findAvailableLauncher(): LauncherInfo | undefined {
  let best: LauncherInfo | undefined;
  let bestLoad = Infinity;
  for (const launcher of launchers.values()) {
    if (launcher.isLocal) continue;
    if (launcher.ws.readyState !== 1) continue; // not OPEN
    const load = launcher.activeSessions.size;
    if (load < launcher.capabilities.maxSessions && load < bestLoad) {
      best = launcher;
      bestLoad = load;
    }
  }
  return best;
}

export function updateHeartbeat(id: string, activeSessions: string[]): void {
  const launcher = launchers.get(id);
  if (!launcher) return;
  launcher.lastHeartbeat = new Date().toISOString();
  launcher.activeSessions = new Set(activeSessions);
}

export function addSessionToLauncher(launcherId: string, sessionId: string): void {
  const launcher = launchers.get(launcherId);
  if (launcher) launcher.activeSessions.add(sessionId);
}

export function removeSessionFromLauncher(launcherId: string, sessionId: string): void {
  const launcher = launchers.get(launcherId);
  if (launcher) launcher.activeSessions.delete(sessionId);
}

export function pruneStaleLaunchers(): void {
  const cutoff = Date.now() - 90_000;
  for (const [id, launcher] of launchers) {
    if (launcher.isLocal) continue;
    const lastBeat = new Date(launcher.lastHeartbeat).getTime();
    if (lastBeat < cutoff) {
      console.log(`[launcher-registry] Pruning stale launcher: ${id}`);
      try { launcher.ws.close(4011, 'Stale heartbeat'); } catch {}
      launchers.delete(id);
    }
  }
}

export function startPruneTimer(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(pruneStaleLaunchers, 30_000);
}

export function stopPruneTimer(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export function serializeLauncher(l: LauncherInfo) {
  return {
    id: l.id,
    name: l.name,
    hostname: l.hostname,
    connectedAt: l.connectedAt,
    lastHeartbeat: l.lastHeartbeat,
    activeSessions: Array.from(l.activeSessions),
    capabilities: l.capabilities,
    online: l.isLocal ? true : l.ws?.readyState === 1,
    isHarness: !!l.harness,
    harness: l.harness || null,
    machineId: l.machineId || null,
    harnessConfigId: l.harnessConfigId || null,
  };
}

export function listHarnesses(): LauncherInfo[] {
  return Array.from(launchers.values()).filter(l => !!l.harness);
}

// --- Request/response mechanism for launcher messages ---

interface PendingLauncherRequest {
  resolve: (msg: LauncherToServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Key: `${sessionId}:${expectedResponseType}`
const pendingRequests = new Map<string, PendingLauncherRequest>();

export function sendAndWait(
  launcherId: string,
  message: ServerToLauncherMessage & { sessionId: string },
  responseType: string,
  timeoutMs = 60_000,
): Promise<LauncherToServerMessage> {
  const launcher = launchers.get(launcherId);
  if (!launcher || launcher.ws.readyState !== 1) {
    return Promise.reject(new Error(`Launcher ${launcherId} not connected`));
  }

  const key = `${message.sessionId}:${responseType}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(key);
      reject(new Error(`Timeout waiting for ${responseType} from launcher ${launcherId}`));
    }, timeoutMs);

    pendingRequests.set(key, { resolve, reject, timer });
    launcher.ws.send(JSON.stringify(message));
  });
}

export function resolveLauncherResponse(msg: LauncherToServerMessage & { sessionId?: string }): boolean {
  if (!msg.sessionId) return false;
  const key = `${msg.sessionId}:${msg.type}`;
  const pending = pendingRequests.get(key);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingRequests.delete(key);
  pending.resolve(msg);
  return true;
}
