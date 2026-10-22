import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sqlite } from './db/index.js';
import { computeJsonlDir, computeJsonlPath, findContinuationJsonls } from './jsonl-utils.js';

// Server-only: continuation lookups backed by the control-plane db. Kept out of
// jsonl-utils so the launcher bundle doesn't pull in better-sqlite3.

// DB-backed continuation lookup — O(1) per hop instead of scanning all files.
// Falls back to file scan if DB has no data, then populates DB.
export function findContinuationJsonlsCached(mainJsonlPath: string): string[] {
  const dir = dirname(mainJsonlPath);
  const mainSessionId = basename(mainJsonlPath, '.jsonl');
  const sanitized = dir.split('/').pop() || '';
  // projectDir is the last two path components of the jsonl dir (projects/<sanitized>)
  // but we store the sanitized dir name directly
  const projectDir = sanitized;

  const stmtQuery = sqlite.prepare(
    'SELECT child_session_id FROM jsonl_continuations WHERE parent_session_id = ? AND project_dir = ?'
  );

  // Follow chain in DB
  const chain: string[] = [];
  const visited = new Set<string>();
  let currentId = mainSessionId;

  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const row = stmtQuery.get(currentId, projectDir) as { child_session_id: string } | undefined;
    if (!row) break;
    const childPath = join(dir, `${row.child_session_id}.jsonl`);
    if (!existsSync(childPath)) break;
    chain.push(childPath);
    currentId = row.child_session_id;
  }

  // Even if DB had entries, try to extend the chain via file scan from the last known child.
  // This catches new continuation files created since the DB was last populated.
  const lastKnownId = chain.length > 0 ? basename(chain[chain.length - 1], '.jsonl') : mainSessionId;
  const lastKnownPath = chain.length > 0 ? chain[chain.length - 1] : mainJsonlPath;

  // Only do a file scan if the last known file exists (session is likely still active)
  if (existsSync(lastKnownPath)) {
    const extended = findContinuationJsonls(lastKnownPath);
    if (extended.length > 0) {
      storeJsonlContinuations(lastKnownId, projectDir, extended);
      chain.push(...extended);
    }
  }

  if (chain.length > 0) return chain;

  // DB had nothing — fall back to full file scan and populate
  const scanned = findContinuationJsonls(mainJsonlPath);
  if (scanned.length > 0) {
    storeJsonlContinuations(mainSessionId, projectDir, scanned);
  }
  return scanned;
}

// Store continuation relationships in DB from a scanned chain
function storeJsonlContinuations(mainSessionId: string, projectDir: string, chain: string[]): void {
  const stmtInsert = sqlite.prepare(
    'INSERT OR IGNORE INTO jsonl_continuations (child_session_id, parent_session_id, project_dir, discovered_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  let parentId = mainSessionId;
  for (const filePath of chain) {
    const childId = basename(filePath, '.jsonl');
    stmtInsert.run(childId, parentId, projectDir, now);
    parentId = childId;
  }
}

// Detect continuation chain for a session and store in DB.
// Called on session end and during startup backfill.
export function detectAndStoreJsonlContinuations(claudeSessionId: string, projectDir: string): void {
  const jsonlPath = computeJsonlPath(projectDir, claudeSessionId);
  if (!existsSync(jsonlPath)) return;

  const sanitizedDir = computeJsonlDir(projectDir).split('/').pop() || '';
  const chain = findContinuationJsonls(jsonlPath);
  if (chain.length > 0) {
    storeJsonlContinuations(claudeSessionId, sanitizedDir, chain);
  }
}
