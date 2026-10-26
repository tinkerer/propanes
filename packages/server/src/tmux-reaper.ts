/**
 * Orphaned tmux session reaper.
 *
 * Why: killing a session only ever killed the session-service's *attach
 * client* (`tmux attach-session`), never the tmux session the agent runs in.
 * The DB row went to `killed`, the pane kept running claude/codex, and
 * nothing ever came back for it — startup recovery only re-attaches rows
 * that are still `running`. Deleting a row that was already killed skipped
 * the kill entirely. One VM accumulated 107 such sessions holding ~21 GB of
 * agent processes, pushed the host 15 GB into swap, and every PTY stream in
 * the admin UI crawled.
 *
 * The planner here is pure so it can be unit-tested; session-service wires
 * it to tmux and the DB. A tmux session is reaped only when ALL of these
 * hold:
 *   - it is not one this process owns (activeSessions) or is still trying
 *     to recover (recovery parking);
 *   - no client is attached to it — an attached client means some
 *     session-service (this one, or another instance sharing the tmux
 *     socket) is driving it, or an operator attached from a shell;
 *   - it is older than TMUX_REAP_MIN_AGE_MS, so a session whose row is
 *     being written right now is never raced;
 *   - its DB row is missing or already terminal (killed / completed /
 *     failed / deleted). `running`, `pending` and `idle` rows are left alone.
 */

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Sessions younger than this are never touched (ms). */
export const TMUX_REAP_MIN_AGE_MS = envInt('TMUX_REAP_MIN_AGE_MS', 10 * 60_000);
/** How often the sweep runs after the one at startup (ms). */
export const TMUX_REAP_INTERVAL_MS = envInt('TMUX_REAP_INTERVAL_MS', 5 * 60_000);

/** DB statuses whose tmux session has no business staying alive. `deleted`
 * is the soft delete (feedback routes, metering): the row stays for history
 * but the session is as finished as a killed one. */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set(['killed', 'completed', 'failed', 'deleted']);

export interface TmuxSessionFact {
  sessionId: string;
  /** tmux `#{session_created}` in ms since epoch. */
  createdAt: number;
  /** tmux `#{session_attached}` > 0. */
  attached: boolean;
}

export interface ReapPlanInput {
  tmuxSessions: TmuxSessionFact[];
  /** DB status for the row, or null when there is no row. */
  lookupStatus: (sessionId: string) => string | null;
  /** This process currently drives the session (activeSessions). */
  isActive: (sessionId: string) => boolean;
  /** Viewers are parked waiting for a late recovery of this session. */
  isParked: (sessionId: string) => boolean;
  now?: number;
  minAgeMs?: number;
}

export interface ReapCandidate {
  sessionId: string;
  /** `missing-row` or the terminal status the row holds. */
  reason: string;
  ageMs: number;
}

export function planTmuxReap(input: ReapPlanInput): ReapCandidate[] {
  const now = input.now ?? Date.now();
  const minAge = input.minAgeMs ?? TMUX_REAP_MIN_AGE_MS;
  const out: ReapCandidate[] = [];
  for (const s of input.tmuxSessions) {
    if (input.isActive(s.sessionId)) continue;
    if (input.isParked(s.sessionId)) continue;
    if (s.attached) continue;
    const ageMs = now - s.createdAt;
    if (!(ageMs >= minAge)) continue;
    const status = input.lookupStatus(s.sessionId);
    if (status === null) {
      out.push({ sessionId: s.sessionId, reason: 'missing-row', ageMs });
    } else if (TERMINAL_SESSION_STATUSES.has(status)) {
      out.push({ sessionId: s.sessionId, reason: status, ageMs });
    }
  }
  return out;
}
