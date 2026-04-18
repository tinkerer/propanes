import { homedir } from 'node:os';
import { resolve, join, basename, dirname, normalize, isAbsolute } from 'node:path';
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { sqlite } from './db/index.js';

export function computeJsonlDir(projectDir: string): string {
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
  return join(homedir(), '.claude', 'projects', sanitized);
}

export function computeJsonlPath(projectDir: string, claudeSessionId: string): string {
  return join(computeJsonlDir(projectDir), `${claudeSessionId}.jsonl`);
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
