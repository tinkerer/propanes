// Phase 5 — per-session usage meter.
//
// The billable unit is "a session, run in isolate class X, by user U in org O,
// for D milliseconds." We record one session_usage row per dispatched session
// at begin time, then finalize wall time from the session's terminal state.
//
// Finalization is reconcile-based rather than threaded through every exit path
// (local session-service, remote launcher, harness, sprite all end sessions in
// different places): `reconcileUsage()` walks open usage rows whose backing
// agent_session has reached a terminal status and stamps ended_at / wall_ms.
// It runs on read (the usage view) and on a periodic sweep.

import { eq, isNull, gte } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const TERMINAL_STATUSES = ['completed', 'failed', 'killed', 'deleted'];

export function isolateClassFor(isolation: string): string {
  if (isolation === 'per_session') return 'worktree';
  return isolation; // 'shared' | 'per_user_pod'
}

export function beginUsage(params: {
  sessionId: string;
  userId?: string | null;
  orgId?: string | null;
  isolation: string;
  isolateId?: string | null;
}): void {
  const now = new Date().toISOString();
  try {
    // Idempotent: keyed by sessionId, so a retried dispatch won't double-count.
    db.insert(schema.sessionUsage)
      .values({
        id: params.sessionId,
        sessionId: params.sessionId,
        userId: params.userId ?? null,
        orgId: params.orgId ?? null,
        isolation: params.isolation,
        isolateClass: isolateClassFor(params.isolation),
        isolateId: params.isolateId ?? null,
        startedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    console.warn(`[metering] beginUsage failed for ${params.sessionId}:`, err instanceof Error ? err.message : err);
  }
}

// Finalize any open usage rows whose session has ended. Returns the number of
// rows finalized. Safe to call repeatedly.
export function reconcileUsage(): number {
  const openRows = db
    .select({ id: schema.sessionUsage.id, sessionId: schema.sessionUsage.sessionId, startedAt: schema.sessionUsage.startedAt })
    .from(schema.sessionUsage)
    .where(isNull(schema.sessionUsage.endedAt))
    .all();
  if (openRows.length === 0) return 0;

  let finalized = 0;
  for (const row of openRows) {
    const session = db
      .select({
        status: schema.agentSessions.status,
        startedAt: schema.agentSessions.startedAt,
        completedAt: schema.agentSessions.completedAt,
      })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, row.sessionId))
      .get();
    // Session row gone (purged) — close the meter at "now" so it doesn't leak.
    const terminal = !session || TERMINAL_STATUSES.includes(session.status);
    if (!terminal) continue;

    const endedAt = session?.completedAt || new Date().toISOString();
    const startMs = new Date(session?.startedAt || row.startedAt).getTime();
    const endMs = new Date(endedAt).getTime();
    const wallMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
    db.update(schema.sessionUsage)
      .set({ endedAt, wallMs, status: session?.status ?? 'deleted' })
      .where(eq(schema.sessionUsage.id, row.id))
      .run();
    finalized++;
  }
  return finalized;
}

export interface UsageSummaryRow {
  key: string;
  sessions: number;
  totalWallMs: number;
  activeSessions: number;
}

export interface UsageSummary {
  totals: { sessions: number; totalWallMs: number; activeSessions: number };
  byUser: UsageSummaryRow[];
  byOrg: UsageSummaryRow[];
  byIsolation: UsageSummaryRow[];
  recent: Array<{
    sessionId: string;
    userId: string | null;
    orgId: string | null;
    isolation: string;
    isolateClass: string | null;
    startedAt: string;
    endedAt: string | null;
    wallMs: number | null;
    status: string | null;
  }>;
}

// Aggregate the ledger. `sinceDays` bounds the window (default 30).
export function summarizeUsage(sinceDays = 30): UsageSummary {
  reconcileUsage();
  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const rows = db
    .select()
    .from(schema.sessionUsage)
    .where(gte(schema.sessionUsage.startedAt, cutoff))
    .all();

  const groupBy = (keyFn: (r: typeof rows[number]) => string): UsageSummaryRow[] => {
    const map = new Map<string, UsageSummaryRow>();
    for (const r of rows) {
      const key = keyFn(r);
      const agg = map.get(key) || { key, sessions: 0, totalWallMs: 0, activeSessions: 0 };
      agg.sessions++;
      agg.totalWallMs += r.wallMs ?? 0;
      if (!r.endedAt) agg.activeSessions++;
      map.set(key, agg);
    }
    return Array.from(map.values()).sort((a, b) => b.totalWallMs - a.totalWallMs);
  };

  const totals = rows.reduce(
    (acc, r) => {
      acc.sessions++;
      acc.totalWallMs += r.wallMs ?? 0;
      if (!r.endedAt) acc.activeSessions++;
      return acc;
    },
    { sessions: 0, totalWallMs: 0, activeSessions: 0 },
  );

  const recent = [...rows]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, 50)
    .map((r) => ({
      sessionId: r.sessionId,
      userId: r.userId,
      orgId: r.orgId,
      isolation: r.isolation,
      isolateClass: r.isolateClass,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      wallMs: r.wallMs,
      status: r.status,
    }));

  return {
    totals,
    byUser: groupBy((r) => r.userId || '(unassigned)'),
    byOrg: groupBy((r) => r.orgId || '(no org)'),
    byIsolation: groupBy((r) => r.isolation),
    recent,
  };
}
