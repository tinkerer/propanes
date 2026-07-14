import type { WebSocket } from 'ws';
import { listSessions } from './sessions.js';
import { listLaunchers, listHarnesses } from './launcher-registry.js';
import { db, schema } from './db/index.js';
import { getActiveRunIds } from './wiggum-controller.js';
import { buildSessionList } from './routes/agent-sessions.js';
import { listNotifications } from './notifications.js';
import { NOTIFICATIONS_TOPIC } from '@propanes/shared';
import type { AdminUser } from './admin-auth.js';
import { visibleToMember } from './admin-auth.js';

const adminClients = new Map<WebSocket, AdminUser>();

// Topics that expose global operator state (all live connections, machines,
// launchers, wiggum runs, cross-workspace notifications). Members never
// receive these; their pages degrade to the REST endpoints' scoped answers.
const ADMIN_ONLY_TOPICS = new Set(['live-connections', 'infrastructure', 'wiggum', NOTIFICATIONS_TOPIC]);

let sessionsTimer: ReturnType<typeof setInterval> | null = null;
let liveTimer: ReturnType<typeof setInterval> | null = null;
let infraTimer: ReturnType<typeof setInterval> | null = null;
let wiggumTimer: ReturnType<typeof setInterval> | null = null;

export function registerAdminClient(ws: WebSocket, user: AdminUser) {
  adminClients.set(ws, user);
  if (adminClients.size === 1) startTimers();

  // Send initial snapshots immediately
  sendSnapshot(ws, 'sessions');
  sendSnapshot(ws, 'live-connections');
  sendSnapshot(ws, 'infrastructure');
  sendSnapshot(ws, 'wiggum');
  sendSnapshot(ws, NOTIFICATIONS_TOPIC);
}

export function unregisterAdminClient(ws: WebSocket) {
  adminClients.delete(ws);
  if (adminClients.size === 0) stopTimers();
}

function scopeTopicData(topic: string, data: unknown, user: AdminUser): unknown | undefined {
  if (user.role === 'admin') return data;
  if (ADMIN_ONLY_TOPICS.has(topic)) return undefined;
  if (topic === 'sessions' && Array.isArray(data)) {
    return data.filter((s) => visibleToMember(s as { ownerUserId?: string | null; orgId?: string | null }, user));
  }
  return data;
}

export function broadcastAdmin(msg: { topic: string; data: unknown }) {
  if (adminClients.size === 0) return;
  for (const [ws, user] of adminClients) {
    const scoped = scopeTopicData(msg.topic, msg.data, user);
    if (scoped === undefined) continue;
    try {
      ws.send(JSON.stringify({ topic: msg.topic, data: scoped }));
    } catch {
      adminClients.delete(ws);
    }
  }
}

async function sendSnapshot(ws: WebSocket, topic: string) {
  try {
    const user = adminClients.get(ws);
    if (!user) return;
    const data = await getTopicData(topic);
    const scoped = scopeTopicData(topic, data, user);
    if (scoped === undefined) return;
    ws.send(JSON.stringify({ topic, data: scoped }));
  } catch {
    // ignore
  }
}

async function getTopicData(topic: string): Promise<unknown> {
  switch (topic) {
    case 'sessions':
      return buildSessionList();
    case 'live-connections':
      return listSessions();
    case 'infrastructure':
      return buildInfraData();
    case 'wiggum':
      return buildWiggumData();
    case NOTIFICATIONS_TOPIC:
      return { type: 'snapshot', notifications: listNotifications() };
    default:
      return null;
  }
}

function buildInfraData() {
  const machines = db
    .select()
    .from(schema.machines)
    .all()
    .map((row) => ({ ...row, tags: row.tags ? JSON.parse(row.tags) : [] }));
  const harnessConfigs = db.select().from(schema.harnessConfigs).all();
  const launchers = listLaunchers().map((l) => ({
    id: l.id,
    name: l.name,
    hostname: l.hostname,
    connectedAt: l.connectedAt,
    lastHeartbeat: l.lastHeartbeat,
    activeSessions: [...l.activeSessions],
    capabilities: l.capabilities,
    harness: l.harness,
    isLocal: l.isLocal,
    machineId: l.machineId,
    harnessConfigId: l.harnessConfigId,
    version: l.version,
  }));
  const harnesses = listHarnesses().map((l) => ({
    id: l.id,
    name: l.name,
    hostname: l.hostname,
    connectedAt: l.connectedAt,
    online: true,
    harness: l.harness,
    harnessConfigId: l.harnessConfigId,
  }));
  const spriteConfigs = db.select().from(schema.spriteConfigs).all();
  const applications = db.select().from(schema.applications).all();
  return { machines, harnessConfigs, launchers, harnesses, spriteConfigs, applications };
}

function buildWiggumData() {
  const rows = db.select().from(schema.wiggumRuns).all();
  const activeIds = getActiveRunIds();
  return rows.map((r) => ({
    ...r,
    iterations: JSON.parse(r.iterations || '[]'),
    isActive: activeIds.includes(r.id),
  }));
}

async function broadcastTopic(topic: string) {
  if (adminClients.size === 0) return;
  try {
    const data = await getTopicData(topic);
    broadcastAdmin({ topic, data });
  } catch {
    // ignore
  }
}

function startTimers() {
  sessionsTimer = setInterval(() => broadcastTopic('sessions'), 5_000);
  liveTimer = setInterval(() => broadcastTopic('live-connections'), 5_000);
  infraTimer = setInterval(() => broadcastTopic('infrastructure'), 10_000);
  wiggumTimer = setInterval(() => broadcastTopic('wiggum'), 5_000);
}

function stopTimers() {
  if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (infraTimer) { clearInterval(infraTimer); infraTimer = null; }
  if (wiggumTimer) { clearInterval(wiggumTimer); wiggumTimer = null; }
}

export function getAdminClientCount(): number {
  return adminClients.size;
}
