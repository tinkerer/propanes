export type PathMap = Array<[from: string, to: string]>;

/**
 * Parse LAUNCHER_PATH_MAP: comma-separated `serverPrefix=localPrefix` pairs,
 * e.g. `/home/agent/work=/Users/amir/work`. The server sends its own project
 * paths; a launcher on a machine with a different layout (a Mac dialing a
 * Linux VM) needs them rewritten before it can cd, sync or find transcripts.
 */
export function parsePathMap(raw: string | undefined): PathMap {
  if (!raw) return [];
  const map: PathMap = [];
  for (const entry of raw.split(',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const from = entry.slice(0, eq).trim().replace(/\/+$/, '');
    const to = entry.slice(eq + 1).trim().replace(/\/+$/, '');
    if (from && to) map.push([from, to]);
  }
  // Longest prefix wins so a nested mapping can override its parent.
  return map.sort((a, b) => b[0].length - a[0].length);
}

export function mapPath(p: string, map: PathMap): string {
  for (const [from, to] of map) {
    if (p === from) return to;
    if (p.startsWith(from + '/')) return to + p.slice(from.length);
  }
  return p;
}

/** Rewrite the server-path fields a launcher message can carry, in place. */
export function mapMessagePaths<T extends Record<string, any>>(msg: T, map: PathMap): T {
  if (!map.length) return msg;
  const m = msg as Record<string, any>;
  if (typeof m.cwd === 'string') m.cwd = mapPath(m.cwd, map);
  if (typeof m.projectDir === 'string') m.projectDir = mapPath(m.projectDir, map);
  if (Array.isArray(m.artifactPaths)) {
    m.artifactPaths = m.artifactPaths.map((p: unknown) => (typeof p === 'string' ? mapPath(p, map) : p));
  }
  return msg;
}
