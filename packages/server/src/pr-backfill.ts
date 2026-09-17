// One-off transcript pass for sessions that ended without a PR badge.
//
// Live sessions are covered by their flush timer (session-service) or the
// launcher's scan; this catches rows that ended before transcript scanning
// existed, or whose PR URL never reached the PTY. Bounded on purpose: ended
// rows only, nothing recorded yet, a recent window, a row cap. A scan that
// finds nothing writes `[]` so the row is not revisited on the next boot; a
// row whose transcript is not on this disk is left alone.

import { existsSync } from 'node:fs';
import { and, desc, eq, gt, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { resolveSessionJsonlPath } from './jsonl-utils.js';
import { canonicalizePrUrls, mergePrUrlList } from './pr-detect.js';
import { newTranscriptCursor, scanTranscriptForPrUrls } from './pr-transcript-scan.js';

export const BACKFILL_WINDOW_DAYS = 30;
export const BACKFILL_MAX_ROWS = 500;

export interface BackfillResult {
  scanned: number;
  tagged: number;
  /** Rows whose transcript could not be found (left untouched). */
  missing: number;
  /** Rows whose stored URLs contained damaged duplicates that were scrubbed. */
  scrubbed: number;
}

/**
 * Scrub stored lists that still carry PTY-damaged duplicates (see
 * dropShadowedPrUrls) recorded before the detector learned to avoid them.
 * DB-only; cheap enough to run every boot.
 */
export function scrubStoredPrUrls(): number {
  const rows = db
    .select({ id: schema.agentSessions.id, prUrls: schema.agentSessions.prUrls })
    .from(schema.agentSessions)
    .where(isNotNull(schema.agentSessions.prUrls))
    .all();
  let scrubbed = 0;
  for (const row of rows) {
    const cleaned = canonicalizePrUrls(row.prUrls);
    if (cleaned === null) continue;
    db.update(schema.agentSessions).set({ prUrls: cleaned }).where(eq(schema.agentSessions.id, row.id)).run();
    scrubbed++;
  }
  return scrubbed;
}

export function backfillTranscriptPrUrls(agentHome: string, now = Date.now()): BackfillResult {
  const since = new Date(now - BACKFILL_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = db
    .select({
      id: schema.agentSessions.id,
      claudeSessionId: schema.agentSessions.claudeSessionId,
      cwd: schema.agentSessions.cwd,
      runtime: schema.agentSessions.runtime,
      startedAt: schema.agentSessions.startedAt,
      status: schema.agentSessions.status,
    })
    .from(schema.agentSessions)
    .where(and(
      isNull(schema.agentSessions.prUrls),
      isNotNull(schema.agentSessions.claudeSessionId),
      notInArray(schema.agentSessions.status, ['running', 'pending']),
      gt(schema.agentSessions.createdAt, since),
    ))
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(BACKFILL_MAX_ROWS)
    .all();

  const result: BackfillResult = { scanned: 0, tagged: 0, missing: 0, scrubbed: scrubStoredPrUrls() };
  for (const row of rows) {
    let path: string | null = null;
    try {
      const projectDir = row.cwd || process.cwd();
      path = resolveSessionJsonlPath(projectDir, row.cwd, row.runtime, row.claudeSessionId, row.startedAt, row.status, agentHome, null);
    } catch { /* treat as missing */ }
    if (!path || !existsSync(path)) {
      result.missing++;
      continue;
    }
    let urls: string[] = [];
    try {
      urls = scanTranscriptForPrUrls(path, newTranscriptCursor(), true);
    } catch (err) {
      console.error(`[pr-backfill] scan failed for ${row.id}:`, err);
      continue;
    }
    result.scanned++;
    const merged = mergePrUrlList(null, urls) ?? '[]';
    if (urls.length) result.tagged++;
    db.update(schema.agentSessions)
      .set({ prUrls: merged })
      .where(eq(schema.agentSessions.id, row.id))
      .run();
  }
  return result;
}
