import { WebSocket } from 'ws';
import { ulid } from 'ulidx';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface ActivityEntry {
  ts: string;
  command: string;
  category: string;
  ok: boolean;
  durationMs: number;
}

const COMMAND_CATEGORIES: Record<string, string> = {
  screenshot: 'screenshot',
  execute: 'script',
  navigate: 'navigation',
  click: 'interaction',
  type: 'interaction',
  getDom: 'inspect',
  getConsole: 'inspect',
  getNetwork: 'inspect',
  getEnvironment: 'inspect',
  getPerformance: 'inspect',
  moveMouse: 'mouse',
  clickAt: 'mouse',
  hover: 'mouse',
  drag: 'mouse',
  mouseDown: 'mouse',
  mouseUp: 'mouse',
  pressKey: 'keyboard',
  keyDown: 'keyboard',
  keyUp: 'keyboard',
  typeText: 'keyboard',
  waitFor: 'interaction',
  openAdmin: 'widget',
  closeAdmin: 'widget',
  widgetSubmit: 'widget',
};

function categorize(command: string): string {
  return COMMAND_CATEGORIES[command] || 'other';
}

const MAX_ACTIVITY_LOG = 200;

export interface SessionInfo {
  sessionId: string;
  ws: WebSocket;
  connectedAt: string;
  lastActivity: string;
  userAgent: string | null;
  url: string | null;
  userId: string | null;
  viewport: string | null;
  appId: string | null;
  name: string | null;
  tags: string[];
  pendingRequests: Map<string, PendingRequest>;
  activityLog: ActivityEntry[];
}

const sessions = new Map<string, SessionInfo>();
const aliases = new Map<string, string>();

const REQUEST_TIMEOUT = 15_000;

export function resolveSessionId(idOrAlias: string): string {
  return aliases.get(idOrAlias) ?? idOrAlias;
}

export function setAlias(alias: string, sessionId: string) {
  aliases.set(alias, sessionId);
}

export function removeAlias(alias: string) {
  aliases.delete(alias);
}

export function getAliasesForSession(sessionId: string): string[] {
  const result: string[] = [];
  for (const [alias, sid] of aliases) {
    if (sid === sessionId) result.push(alias);
  }
  return result;
}

export function registerSession(sessionId: string, ws: WebSocket, meta: { userAgent?: string; url?: string; userId?: string; viewport?: string; appId?: string }) {
  const existing = sessions.get(sessionId);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.ws.close(1000, 'replaced');
  }

  const session: SessionInfo = {
    sessionId,
    ws,
    connectedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    userAgent: meta.userAgent || null,
    url: meta.url || null,
    userId: meta.userId || null,
    viewport: meta.viewport || null,
    appId: meta.appId || null,
    name: null,
    tags: [],
    pendingRequests: new Map(),
    activityLog: [],
  };

  sessions.set(sessionId, session);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      session.lastActivity = new Date().toISOString();

      if (msg.type === 'response' && msg.requestId) {
        const pending = session.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          session.pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.data);
          }
        }
      }

      if (msg.type === 'meta') {
        if (msg.url) session.url = msg.url;
        if (msg.viewport) session.viewport = msg.viewport;
        if (msg.userId) session.userId = msg.userId;
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    const current = sessions.get(sessionId);
    if (current && current.ws === ws) {
      for (const [, pending] of current.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Session disconnected'));
      }
      sessions.delete(sessionId);
      // Clean up any aliases pointing to this session
      for (const [alias, sid] of aliases) {
        if (sid === sessionId) aliases.delete(alias);
      }
    }
  });

  return session;
}

export function getSession(sessionId: string): SessionInfo | undefined {
  const session = sessions.get(sessionId);
  if (session && session.ws.readyState !== WebSocket.OPEN) {
    sessions.delete(sessionId);
    return undefined;
  }
  return session;
}

export function listSessions(): Omit<SessionInfo, 'ws' | 'pendingRequests'>[] {
  const result: Omit<SessionInfo, 'ws' | 'pendingRequests'>[] = [];
  for (const [, session] of sessions) {
    if (session.ws.readyState === WebSocket.OPEN) {
      const { ws, pendingRequests, ...info } = session;
      result.push(info);
    }
  }
  return result;
}

export function getSessionActivityLog(sessionId: string): ActivityEntry[] {
  const session = getSession(sessionId);
  return session?.activityLog ?? [];
}

export function sendCommand(sessionId: string, command: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
  const session = getSession(sessionId);
  if (!session) {
    return Promise.reject(new Error('Session not found or disconnected'));
  }

  const requestId = ulid();
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const logActivity = (ok: boolean) => {
      const entry: ActivityEntry = {
        ts: new Date().toISOString(),
        command,
        category: categorize(command),
        ok,
        durationMs: Date.now() - startTime,
      };
      session.activityLog.push(entry);
      if (session.activityLog.length > MAX_ACTIVITY_LOG) {
        session.activityLog.splice(0, session.activityLog.length - MAX_ACTIVITY_LOG);
      }
    };

    const timeout = setTimeout(() => {
      session.pendingRequests.delete(requestId);
      logActivity(false);
      reject(new Error('Request timed out'));
    }, timeoutMs ?? REQUEST_TIMEOUT);

    session.pendingRequests.set(requestId, {
      resolve: (value) => { logActivity(true); resolve(value); },
      reject: (reason) => { logActivity(false); reject(reason); },
      timeout,
    });

    session.ws.send(JSON.stringify({
      type: 'command',
      requestId,
      command,
      params,
    }));
  });
}
