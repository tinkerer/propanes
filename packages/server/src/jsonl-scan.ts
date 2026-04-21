import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Scan a Claude `.claude/projects/<sanitized>` directory for `.jsonl` files
// touched since `sinceMs`, excluding the caller's own JSONL so reflection
// scans never discover themselves and bail as "another instance running".
//
// `selfClaudeSessionId` wins over env; if omitted, falls back to
// `process.env.CLAUDE_SESSION_ID` (set automatically inside a Claude Code
// session). Extra exclusions can be passed for cases where multiple sibling
// scanners share a project dir.
export async function findRecentProjectJsonl(
  projectJsonlDir: string,
  sinceMs: number,
  selfClaudeSessionId?: string | null,
  extraExcludeIds: string[] = [],
): Promise<string[]> {
  if (!existsSync(projectJsonlDir)) return [];

  const exclude = new Set<string>();
  const envSelf = process.env.CLAUDE_SESSION_ID?.trim();
  if (selfClaudeSessionId) exclude.add(selfClaudeSessionId);
  else if (envSelf) exclude.add(envSelf);
  for (const id of extraExcludeIds) if (id) exclude.add(id);

  let names: string[];
  try {
    names = await readdir(projectJsonlDir);
  } catch {
    return [];
  }

  const entries: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (exclude.has(id)) continue;
    const full = resolve(projectJsonlDir, name);
    try {
      const s = await stat(full);
      if (s.mtimeMs > sinceMs) entries.push({ path: full, mtime: s.mtimeMs });
    } catch { /* skip unreadable */ }
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  return entries.map((e) => e.path);
}
