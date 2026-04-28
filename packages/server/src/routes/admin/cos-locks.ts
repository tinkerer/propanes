// Advisory-lock + active-session subsystem for the Chief-of-Staff chat agent.
//
// `activeSessions` tracks every in-flight CoS turn so a running turn can see
// "what other operators are working on right now" through the system prompt.
// `locks` is a per-key advisory mutex any CoS turn can grab via the lock API
// to coordinate concurrent edits (e.g. "I'm editing applications/X — wait").
// `inFlightByThread` is a map of threadId → spawned proc so /interrupt and
// the chat handler can SIGTERM a running turn.
//
// Self-contained: no imports from chief-of-staff.ts. The route file mounts the
// sub-Hono `cosLocksRoutes` under its main app, then the chat handler reaches
// into `activeSessions` / `inFlightByThread` / `releaseAllLocks` / `killProc`
// directly.

import { Hono } from 'hono';
import type { spawn } from 'node:child_process';

export type ActiveSession = {
  requestId: string;
  sessionId: string;
  text: string;
  startedAt: number;
  lockKeys: Set<string>;
};

export const activeSessions = new Map<string, ActiveSession>();
const locks = new Map<string, { owner: string; since: number }>();

// Track in-flight processes by threadId so they can be interrupted.
// `cancelled` records that we killed the proc on purpose (interrupt, supersede,
// client abort) so the close handler can distinguish a clean cancel from a
// real crash — SIGTERM surfaces as exit code 143 and should not surface as
// "Send failed" in the UI.
export type InFlightEntry = { proc: ReturnType<typeof spawn>; cancelled: boolean };
export const inFlightByThread = new Map<string, InFlightEntry>();

export function killProc(entry: InFlightEntry): void {
  entry.cancelled = true;
  const pid = entry.proc.pid;
  if (!pid) return;
  // Kill the entire process group so subprocesses (tool calls) also die
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
  // SIGKILL fallback after 3s in case SIGTERM is ignored
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ } }, 3000);
}

export function serializeSession(s: ActiveSession) {
  return {
    requestId: s.requestId,
    sessionId: s.sessionId,
    text: s.text,
    startedAt: s.startedAt,
    lockKeys: Array.from(s.lockKeys),
  };
}

export function releaseAllLocks(requestId: string): void {
  const session = activeSessions.get(requestId);
  if (session) {
    for (const key of session.lockKeys) {
      const held = locks.get(key);
      if (held && held.owner === requestId) locks.delete(key);
    }
    session.lockKeys.clear();
  }
  // Also sweep in case of drift
  for (const [key, held] of locks) {
    if (held.owner === requestId) locks.delete(key);
  }
}

export const cosLocksRoutes = new Hono();

cosLocksRoutes.get('/chief-of-staff/sessions', (c) => {
  const sessions = Array.from(activeSessions.values()).map(serializeSession);
  return c.json({ sessions });
});

cosLocksRoutes.post('/chief-of-staff/lock', async (c) => {
  let body: { requestId?: string; key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const requestId = (body.requestId || '').trim();
  const key = (body.key || '').trim();
  if (!requestId || !key) return c.json({ error: 'requestId and key are required' }, 400);

  const existing = locks.get(key);
  if (existing && existing.owner !== requestId) {
    return c.json({ granted: false, heldBy: existing.owner, heldSince: existing.since });
  }
  const now = Date.now();
  if (!existing) locks.set(key, { owner: requestId, since: now });
  const session = activeSessions.get(requestId);
  if (session) session.lockKeys.add(key);
  return c.json({ granted: true, heldSince: (locks.get(key) || { since: now }).since });
});

cosLocksRoutes.delete('/chief-of-staff/lock/:requestId/:key', (c) => {
  const requestId = c.req.param('requestId');
  const key = c.req.param('key');
  const held = locks.get(key);
  if (!held) return c.json({ released: false, reason: 'not held' });
  if (held.owner !== requestId) {
    return c.json({ released: false, reason: 'not owner', heldBy: held.owner }, 403);
  }
  locks.delete(key);
  const session = activeSessions.get(requestId);
  if (session) session.lockKeys.delete(key);
  return c.json({ released: true });
});
