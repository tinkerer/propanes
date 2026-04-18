import WebSocket from 'ws';
import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { openExecWebSocket } from './sprite-client.js';
import { broadcastToLauncherSessionAdmins } from './agent-sessions.js';

interface ActiveSpriteSession {
  sessionId: string;
  spriteConfigId: string;
  ws: WebSocket;
  seq: number;
}

const activeSessions = new Map<string, ActiveSpriteSession>();

export function launchSpriteSession(params: {
  sessionId: string;
  spriteConfigId: string;
  spriteName: string;
  token: string | null;
  cmdArgs: string[];
  cols?: number;
  rows?: number;
}): void {
  const { sessionId, spriteConfigId, spriteName, token, cmdArgs, cols, rows } = params;

  const ws = openExecWebSocket(spriteName, token, cmdArgs, {
    tty: true,
    stdin: true,
    cols: cols || 120,
    rows: rows || 40,
  });

  const session: ActiveSpriteSession = { sessionId, spriteConfigId, ws, seq: 0 };
  activeSessions.set(sessionId, session);

  ws.on('open', () => {
    const now = new Date().toISOString();
    db.update(schema.agentSessions)
      .set({ status: 'running', startedAt: now })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    console.log(`[sprite] Session ${sessionId} connected to sprite ${spriteName}`);
  });

  ws.on('message', (raw: Buffer | string) => {
    const data = raw.toString();
    session.seq++;
    const output = {
      type: 'output',
      content: { type: 'stdout', data },
      seq: session.seq,
    };
    broadcastToLauncherSessionAdmins(sessionId, JSON.stringify(output));

    // Accumulate in DB
    const row = db.select().from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId)).get();
    if (row) {
      const existing = row.outputLog || '';
      const updated = (existing + data).slice(-500 * 1024);
      db.update(schema.agentSessions)
        .set({
          outputLog: updated,
          outputBytes: (row.outputBytes || 0) + Buffer.byteLength(data),
          lastOutputSeq: session.seq,
        })
        .where(eq(schema.agentSessions.id, sessionId))
        .run();
    }
  });

  ws.on('close', (code) => {
    activeSessions.delete(sessionId);
    const completedAt = new Date().toISOString();
    const status = code === 1000 ? 'completed' : 'failed';
    db.update(schema.agentSessions)
      .set({ status, completedAt })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    broadcastToLauncherSessionAdmins(sessionId, JSON.stringify({
      type: 'exit',
      exitCode: code === 1000 ? 0 : code,
      status,
    }));
    console.log(`[sprite] Session ${sessionId} closed (code=${code})`);
  });

  ws.on('error', (err) => {
    console.error(`[sprite] Session ${sessionId} error:`, err.message);
    activeSessions.delete(sessionId);
    const completedAt = new Date().toISOString();
    db.update(schema.agentSessions)
      .set({ status: 'failed', completedAt })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    broadcastToLauncherSessionAdmins(sessionId, JSON.stringify({
      type: 'exit',
      exitCode: 1,
      status: 'failed',
    }));
  });
}

export function countActiveSpriteSessions(spriteConfigId: string): number {
  let count = 0;
  for (const s of activeSessions.values()) {
    if (s.spriteConfigId === spriteConfigId) count++;
  }
  return count;
}

export function getActiveSpriteSession(sessionId: string): ActiveSpriteSession | undefined {
  return activeSessions.get(sessionId);
}

export function sendInputToSprite(sessionId: string, data: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
  session.ws.send(data);
  return true;
}

export function resizeSpriteSession(sessionId: string, cols: number, rows: number): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
  // Sprites exec WS accepts JSON resize messages
  session.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  return true;
}

export function killSpriteSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  try { session.ws.close(); } catch {}
  activeSessions.delete(sessionId);
  return true;
}

export function isSpriteSession(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}
