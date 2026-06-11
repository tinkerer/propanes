import { homedir } from 'node:os';
import { resolve, join, basename, dirname, normalize, isAbsolute } from 'node:path';
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { sqlite } from './db/index.js';

export function computeJsonlDir(projectDir: string): string {
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
  return join(homedir(), '.claude', 'projects', sanitized);
}

export function computeJsonlPath(projectDir: string, claudeSessionId: string): string {
  return join(computeJsonlDir(projectDir), `${claudeSessionId}.jsonl`);
}

// Codex stores rollout files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
// keyed by date and a per-session UUID. Codex doesn't expose --session-id, so
// we have to find the file by scanning. Strategy:
//   1. If `claudeSessionId` is set (we may have stashed the codex thread id
//      there after detection), look for rollout-*-${id}.jsonl directly.
//   2. Otherwise, find a rollout file whose session_meta.payload.cwd matches
//      the session's cwd. Completed sessions use closest-to-start; live
//      sessions can opt into newest-by-cwd to follow /clear or compaction.
// Returns the resolved path or null if nothing matches.
export function computeCodexJsonlPath(
  cwd: string | null,
  codexSessionId: string | null,
  startedAt?: string | null,
  preferLatestByCwd = false,
): string | null {
  const codexRoot = join(homedir(), '.codex', 'sessions');
  if (!existsSync(codexRoot)) return null;

  // Direct lookup by id — rollout files embed the UUID in the filename.
  let direct: string | null = null;
  if (codexSessionId) {
    direct = findRolloutByCodexId(codexRoot, codexSessionId);
    if (direct && !preferLatestByCwd) return direct;
  }

  if (!cwd) return direct;
  if (preferLatestByCwd) {
    return findLatestRolloutByCwd(codexRoot, cwd, startedAt) || direct;
  }
  return direct || findRolloutByCwd(codexRoot, cwd, startedAt);
}

function findRolloutByCodexId(codexRoot: string, sessionId: string): string | null {
  // Scan year/month/day directories. Bounded by ~3 years of history; in
  // practice the file is in the past few days so we walk newest-first.
  try {
    const years = readdirSync(codexRoot).filter(d => /^\d{4}$/.test(d)).sort().reverse();
    for (const year of years) {
      const yearDir = join(codexRoot, year);
      const months = readdirSync(yearDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        const days = readdirSync(monthDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
        for (const day of days) {
          const dayDir = join(monthDir, day);
          const files = readdirSync(dayDir);
          const match = files.find(f => f.endsWith(`${sessionId}.jsonl`));
          if (match) return join(dayDir, match);
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Read just the first line of a file. Codex rollout session_meta lines can
// be >10KB, so we can't rely on a small fixed buffer.
function readFirstLine(filePath: string): string | null {
  const fd = openSync(filePath, 'r');
  try {
    const chunk = Buffer.alloc(8192);
    let offset = 0;
    let acc = '';
    while (true) {
      const n = readSync(fd, chunk, 0, chunk.length, offset);
      if (n <= 0) return acc || null;
      const str = chunk.toString('utf-8', 0, n);
      const nl = str.indexOf('\n');
      if (nl >= 0) return acc + str.slice(0, nl);
      acc += str;
      offset += n;
      // Bounded: a rollout first line is tens of KB at most; stop well before OOM.
      if (acc.length > 1024 * 1024) return acc;
    }
  } finally {
    closeSync(fd);
  }
}

function findRolloutByCwd(codexRoot: string, cwd: string, startedAt?: string | null): string | null {
  const candidates = findRolloutsByCwd(codexRoot, cwd, startedAt);
  if (candidates.length === 0) return null;
  // Pick the candidate closest in time to startedAt.
  const startTs = startedAt ? Date.parse(startedAt) : Date.now();
  const targetTs = isNaN(startTs) ? Date.now() : startTs;
  candidates.sort((a, b) => Math.abs(a.mtime - targetTs) - Math.abs(b.mtime - targetTs));
  return candidates[0].path;
}

function findLatestRolloutByCwd(codexRoot: string, cwd: string, startedAt?: string | null): string | null {
  const candidates = findRolloutsByCwd(codexRoot, cwd, startedAt);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

function findRolloutsByCwd(codexRoot: string, cwd: string, startedAt?: string | null): { path: string; mtime: number }[] {
  // Search recent days around/after startedAt for rollouts whose session_meta.cwd
  // matches. Live Codex threads can rotate to a new rollout after /clear or
  // compaction, so callers may choose newest instead of closest-to-start.
  const startTs = startedAt ? Date.parse(startedAt) : Date.now();
  const startDate = isNaN(startTs) ? new Date() : new Date(startTs);
  const candidates: { path: string; mtime: number }[] = [];
  const seenDays = new Set<string>();

  for (let dayOffset = -1; dayOffset < 7; dayOffset++) {
    const d = new Date(startDate.getTime() - dayOffset * 86400000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dayKey = `${yyyy}/${mm}/${dd}`;
    if (seenDays.has(dayKey)) continue;
    seenDays.add(dayKey);
    const dayDir = join(codexRoot, yyyy, mm, dd);
    if (!existsSync(dayDir)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(dayDir); } catch { continue; }
    for (const file of entries) {
      if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
      const filePath = join(dayDir, file);
      try {
        const firstLine = readFirstLine(filePath);
        if (!firstLine) continue;
        const obj = JSON.parse(firstLine);
        if (obj?.type !== 'session_meta') continue;
        const fileCwd = obj?.payload?.cwd;
        if (fileCwd !== cwd) continue;
        const ts = Date.parse(obj?.payload?.timestamp || obj?.timestamp || '');
        const mtime = isNaN(ts) ? statSync(filePath).mtimeMs : ts;
        candidates.push({ path: filePath, mtime });
      } catch { /* skip unreadable */ }
    }
  }

  return candidates;
}

// Find continuation JSONL files when Claude Code rotates sessionId mid-conversation.
// A continuation file's first `sessionId` field references a *different* UUID than the
// file's own name — that's the parent it continues from.
// We follow the chain: main → child → grandchild → ...
// Returns ordered list of continuation JSONL paths (not including the main file itself).
export function findContinuationJsonls(mainJsonlPath: string): string[] {
  const dir = dirname(mainJsonlPath);
  if (!existsSync(dir)) return [];

  const mainBasename = basename(mainJsonlPath);
  const mainSessionId = mainBasename.replace('.jsonl', '');

  // Build a map: parentSessionId → child file path
  const parentToChild = new Map<string, string>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl') || file === mainBasename) continue;
    const fullPath = join(dir, file);
    const fileSessionId = file.replace('.jsonl', '');
    try {
      const fd = openSync(fullPath, 'r');
      const buf = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buf, 0, 8192, 0);
      closeSync(fd);
      const head = buf.toString('utf-8', 0, bytesRead);
      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.sessionId && obj.type !== 'file-history-snapshot') {
            if (obj.sessionId !== fileSessionId) {
              parentToChild.set(obj.sessionId, fullPath);
            }
            break;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip unreadable files */ }
  }

  // Follow the chain from mainSessionId
  const chain: string[] = [];
  let currentId = mainSessionId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const childPath = parentToChild.get(currentId);
    if (!childPath) break;
    chain.push(childPath);
    currentId = basename(childPath, '.jsonl');
  }

  return chain;
}

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

export function filterJsonlLines(text: string): string[] {
  return text.split('\n').filter(line => {
    if (!line.trim()) return false;
    try {
      const obj = JSON.parse(line);
      return obj.type !== 'progress' && obj.type !== 'file-history-snapshot';
    } catch {
      return true;
    }
  });
}

export function readJsonlWithSubagents(filePath: string, out: string[]): void {
  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, 'utf-8');
  out.push(...filterJsonlLines(raw));

  const subagentDir = filePath.replace(/\.jsonl$/, '') + '/subagents';
  if (existsSync(subagentDir)) {
    try {
      const files = readdirSync(subagentDir).filter(f => f.endsWith('.jsonl')).sort();
      for (const file of files) {
        const content = readFileSync(join(subagentDir, file), 'utf-8');
        const agentId = file.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        for (const line of filterJsonlLines(content)) {
          try {
            const obj = JSON.parse(line);
            obj._subagentId = agentId;
            out.push(JSON.stringify(obj));
          } catch {
            out.push(line);
          }
        }
      }
    } catch { /* ignore */ }
  }
}

// A "unit" is one physical transcript file in the merged stream, in merge
// order: each main/continuation file followed by its subagent files (sorted
// by filename) — the same order readJsonlWithSubagents emits. `key` is the
// path relative to the main JSONL's directory, used as the stable identifier
// in differential-update cursors (short, and stable across requests).
export interface JsonlUnit {
  key: string;
  path: string;
  subagentId?: string;
}

export function collectJsonlUnits(mainJsonlPath: string, isCodex: boolean): JsonlUnit[] {
  const baseDir = dirname(mainJsonlPath);
  const toKey = (p: string) => p.startsWith(baseDir + '/') ? p.slice(baseDir.length + 1) : p;
  if (isCodex) {
    return existsSync(mainJsonlPath) ? [{ key: toKey(mainJsonlPath), path: mainJsonlPath }] : [];
  }
  const files = [mainJsonlPath, ...findContinuationJsonlsCached(mainJsonlPath)];
  const units: JsonlUnit[] = [];
  for (const fp of files) {
    if (!existsSync(fp)) continue;
    units.push({ key: toKey(fp), path: fp });
    const subagentDir = fp.replace(/\.jsonl$/, '') + '/subagents';
    if (!existsSync(subagentDir)) continue;
    try {
      const subs = readdirSync(subagentDir).filter(f => f.endsWith('.jsonl')).sort();
      for (const f of subs) {
        const p = join(subagentDir, f);
        units.push({ key: toKey(p), path: p, subagentId: f.replace(/^agent-/, '').replace(/\.jsonl$/, '') });
      }
    } catch { /* ignore */ }
  }
  return units;
}

// Read the bytes appended past `fromOffset`, consuming only complete
// (newline-terminated) lines so a mid-write partial line stays unread until
// the writer finishes it. `consumePartial` (terminal-status sessions) takes
// the remainder even without a trailing newline — no more writes are coming,
// so a held-back final line would otherwise never be delivered. `shrunk`
// means the file got smaller than the cursor (truncation/rotation); the
// caller should fall back to a full snapshot.
export function readJsonlFileDelta(
  path: string,
  fromOffset: number,
  consumePartial: boolean,
): { text: string; newOffset: number; shrunk: boolean } {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { text: '', newOffset: 0, shrunk: fromOffset > 0 };
  }
  if (size < fromOffset) return { text: '', newOffset: 0, shrunk: true };
  if (size === fromOffset) return { text: '', newOffset: fromOffset, shrunk: false };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - fromOffset);
    const read = readSync(fd, buf, 0, buf.length, fromOffset);
    const chunk = buf.subarray(0, read);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1 && !consumePartial) return { text: '', newOffset: fromOffset, shrunk: false };
    const end = consumePartial && lastNl < read - 1 ? read : lastNl + 1;
    return { text: chunk.subarray(0, end).toString('utf-8'), newOffset: fromOffset + end, shrunk: false };
  } finally {
    closeSync(fd);
  }
}

export interface JsonlFileInfo {
  id: string; // unique identifier for selection: "main:<uuid>", "cont:<uuid>", "sub:<parentUuid>:<agentId>"
  claudeSessionId: string;
  type: 'main' | 'continuation' | 'subagent';
  label: string;
  parentSessionId?: string; // for subagents, which session they belong to
  agentId?: string; // for subagents
  filePath: string;
  order: number;
}

// List all JSONL files for a session: main + continuations + subagents
export function listJsonlFiles(mainJsonlPath: string): JsonlFileInfo[] {
  const files: JsonlFileInfo[] = [];
  const mainSessionId = basename(mainJsonlPath, '.jsonl');
  let order = 0;

  if (existsSync(mainJsonlPath)) {
    files.push({
      id: `main:${mainSessionId}`,
      claudeSessionId: mainSessionId,
      type: 'main',
      label: `Main: ${mainSessionId.slice(0, 8)}...`,
      filePath: mainJsonlPath,
      order: order++,
    });
    collectSubagentFileInfos(mainJsonlPath, mainSessionId, files, order);
    order = files.length;
  }

  const continuations = findContinuationJsonlsCached(mainJsonlPath);
  for (const contPath of continuations) {
    const contId = basename(contPath, '.jsonl');
    files.push({
      id: `cont:${contId}`,
      claudeSessionId: contId,
      type: 'continuation',
      label: `Continuation: ${contId.slice(0, 8)}...`,
      filePath: contPath,
      order: order++,
    });
    collectSubagentFileInfos(contPath, contId, files, order);
    order = files.length;
  }

  return files;
}

function collectSubagentFileInfos(
  jsonlPath: string,
  parentSessionId: string,
  out: JsonlFileInfo[],
  startOrder: number,
): void {
  const subagentDir = jsonlPath.replace(/\.jsonl$/, '') + '/subagents';
  if (!existsSync(subagentDir)) return;
  try {
    const files = readdirSync(subagentDir).filter(f => f.endsWith('.jsonl')).sort();
    let order = startOrder;
    for (const file of files) {
      const agentId = file.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      out.push({
        id: `sub:${parentSessionId}:${agentId}`,
        claudeSessionId: parentSessionId,
        type: 'subagent',
        label: `Subagent: ${agentId.slice(0, 8)}...`,
        parentSessionId,
        agentId,
        filePath: join(subagentDir, file),
        order: order++,
      });
    }
  } catch { /* ignore */ }
}

export function extractArtifactPaths(jsonlContent: string, projectDir: string): string[] {
  const paths = new Set<string>();

  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      let toolUses: any[] = [];
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        toolUses = obj.message.content.filter((b: any) => b.type === 'tool_use');
      }

      for (const tu of toolUses) {
        const toolName = tu.name;
        const input = tu.input;
        if (!input) continue;

        let filePath: string | undefined;
        if (toolName === 'Write' || toolName === 'Edit') {
          filePath = input.file_path;
        } else if (toolName === 'NotebookEdit') {
          filePath = input.notebook_path;
        }

        if (!filePath || typeof filePath !== 'string') continue;

        let rel: string;
        if (isAbsolute(filePath)) {
          if (!filePath.startsWith(projectDir)) continue;
          rel = filePath.slice(projectDir.length).replace(/^\//, '');
        } else {
          rel = filePath;
        }

        const normalized = normalize(rel);
        if (normalized.startsWith('..')) continue;
        paths.add(normalized);
      }
    } catch { /* skip unparseable */ }
  }

  // Also include .claude/plans files
  const plansDir = resolve(projectDir, '.claude', 'plans');
  if (existsSync(plansDir)) {
    try {
      for (const f of readdirSync(plansDir)) {
        if (f.endsWith('.md')) {
          paths.add(`.claude/plans/${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  return Array.from(paths);
}

export interface SessionFilePackage {
  jsonlFiles: Array<{ relativePath: string; content: string }>;
  artifactFiles: Array<{ path: string; content: string }>;
  artifactPaths: string[];
}

// Package all session JSONL files (main + continuations + subagents) and artifact files for export
export function exportSessionFiles(projectDir: string, claudeSessionId: string): SessionFilePackage {
  const jsonlPath = computeJsonlPath(projectDir, claudeSessionId);
  const jsonlDir = computeJsonlDir(projectDir);
  const jsonlFiles: Array<{ relativePath: string; content: string }> = [];

  if (existsSync(jsonlPath)) {
    jsonlFiles.push({
      relativePath: `${claudeSessionId}.jsonl`,
      content: readFileSync(jsonlPath, 'utf-8'),
    });

    // Subagent files for main session
    collectSubagentFiles(jsonlDir, claudeSessionId, jsonlFiles);
  }

  // Find and include continuation chain (DB-backed, falls back to file scan)
  const continuations = findContinuationJsonlsCached(jsonlPath);
  for (const contPath of continuations) {
    const relPath = contPath.startsWith(jsonlDir)
      ? contPath.slice(jsonlDir.length + 1)
      : basename(contPath);
    jsonlFiles.push({
      relativePath: relPath,
      content: readFileSync(contPath, 'utf-8'),
    });
    const contSessionId = basename(contPath, '.jsonl');
    collectSubagentFiles(jsonlDir, contSessionId, jsonlFiles);
  }

  // Extract artifact paths from all JSONL content
  const allContent = jsonlFiles.map(f => f.content).join('\n');
  const artifactPaths = extractArtifactPaths(allContent, projectDir);

  // Read artifact files from disk
  const artifactFiles: Array<{ path: string; content: string }> = [];
  for (const relPath of artifactPaths) {
    const full = resolve(projectDir, relPath);
    if (!full.startsWith(projectDir)) continue;
    if (existsSync(full)) {
      try {
        artifactFiles.push({ path: relPath, content: readFileSync(full, 'utf-8') });
      } catch { /* skip binary/unreadable */ }
    }
  }

  return { jsonlFiles, artifactFiles, artifactPaths };
}

function collectSubagentFiles(
  jsonlDir: string,
  sessionId: string,
  out: Array<{ relativePath: string; content: string }>,
): void {
  const subagentDir = join(jsonlDir, sessionId, 'subagents');
  if (!existsSync(subagentDir)) return;
  for (const file of readdirSync(subagentDir)) {
    if (!file.endsWith('.jsonl')) continue;
    out.push({
      relativePath: join(sessionId, 'subagents', file),
      content: readFileSync(join(subagentDir, file), 'utf-8'),
    });
  }
}
