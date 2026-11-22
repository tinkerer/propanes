import { homedir } from 'node:os';
import { resolve, join, basename, dirname, normalize, isAbsolute } from 'node:path';
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';

export function computeJsonlDir(projectDir: string, homeDir = homedir()): string {
  const sanitized = projectDir.replaceAll('/', '-').replaceAll('.', '-');
  return join(homeDir, '.claude', 'projects', sanitized);
}

export function computeJsonlPath(projectDir: string, claudeSessionId: string, homeDir = homedir()): string {
  return join(computeJsonlDir(projectDir, homeDir), `${claudeSessionId}.jsonl`);
}

/** Resolve the transcript path in the filesystem where the agent actually
 * ran. The same resolver is used by the control plane for local sessions and
 * by remote launchers for their private agent-home volume. */
export function resolveSessionJsonlPath(
  appProjectDir: string | null,
  sessionCwd: string | null,
  sessionRuntime: string | null | undefined,
  claudeSessionId: string | null,
  startedAt?: string | null,
  status?: string | null,
  homeDir = homedir(),
  liveProcessId?: number | null,
): string | null {
  if (sessionRuntime === 'codex') {
    return computeCodexJsonlPath(
      sessionCwd,
      claudeSessionId,
      startedAt,
      status === 'running' || status === 'pending',
      homeDir,
    );
  }
  // `/clear` (and its `/new`/`/reset` aliases) keeps the Claude process alive
  // but rotates it to a fresh session UUID and transcript. Claude publishes
  // that current UUID in its per-process registry. Prefer it for a live PTY;
  // otherwise every structured-view poll remains pinned to the now-idle file
  // named by the UUID used when Propanes originally launched the process.
  claudeSessionId = resolveClaudeSessionIdForProcess(liveProcessId, claudeSessionId, homeDir);
  if (!claudeSessionId) return null;
  const projectDir = appProjectDir || process.cwd();
  const primary = computeJsonlPath(projectDir, claudeSessionId, homeDir);
  if (existsSync(primary)) return primary;
  if (sessionCwd && sessionCwd !== projectDir) {
    const fallback = computeJsonlPath(sessionCwd, claudeSessionId, homeDir);
    if (existsSync(fallback)) return fallback;
  }
  // The session row's cwd can change as the operator `cd`s in the terminal,
  // while Claude keeps writing under the directory where it originally
  // started. The UUID filename is exact, so scan the shallow projects folder
  // as a final fallback (especially important for long-lived remote sessions).
  const projectsRoot = join(homeDir, '.claude', 'projects');
  if (existsSync(projectsRoot)) {
    try {
      for (const entry of readdirSync(projectsRoot)) {
        const candidate = join(projectsRoot, entry, `${claudeSessionId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch { /* unreadable home — retain the expected primary below */ }
  }
  // Preserve the meaningful expected path while the CLI is still creating it.
  return primary;
}

/** Resolve the current Claude UUID for a live CLI process. The registry is
 * rewritten in place when `/clear` rotates the conversation. Treat malformed
 * or stale registry data as absent and retain the database UUID. */
export function resolveClaudeSessionIdForProcess(
  processId: number | null | undefined,
  fallbackSessionId: string | null,
  homeDir = homedir(),
): string | null {
  if (!processId || !Number.isInteger(processId) || processId <= 0) return fallbackSessionId;
  try {
    const registry = JSON.parse(readFileSync(join(homeDir, '.claude', 'sessions', `${processId}.json`), 'utf-8'));
    const current = typeof registry?.sessionId === 'string' ? registry.sessionId.trim() : '';
    // Session IDs become filenames, so accept Claude's UUID/custom-id alphabet
    // but never path separators or traversal.
    if (current && /^[A-Za-z0-9_-]+$/.test(current)) return current;
  } catch { /* registry missing while Claude starts/exits */ }
  return fallbackSessionId;
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
  // Retained for call-site compatibility. It used to force "newest rollout in
  // this cwd" for live sessions (to follow /clear or compaction rotation), but
  // that cross-contaminated concurrent sessions — see the note below — so it no
  // longer overrides the per-session resolution.
  _preferLatestByCwd = false,
  homeDir = homedir(),
): string | null {
  const codexRoot = join(homeDir, '.codex', 'sessions');
  if (!existsSync(codexRoot)) return null;

  // Direct lookup by id — rollout files embed the UUID in the filename. This is
  // the only exact signal, so always trust it when we have it.
  let direct: string | null = null;
  if (codexSessionId) {
    direct = findRolloutByCodexId(codexRoot, codexSessionId);
    if (direct) return direct;
  }

  if (!cwd) return direct;
  // Resolve by cwd + time. Several Codex sessions routinely share one cwd (e.g.
  // multiple PR reviews in the same repo running at once), and we don't always
  // have a rollout id we can match on. The only signal that distinguishes
  // concurrent sessions is time: each rollout's session_meta timestamp lands
  // within a second or two of its own session's start. So pick the rollout
  // closest to THIS session's startedAt — never the globally-newest one.
  // Using newest-by-cwd made every running session in a shared cwd resolve to
  // the most-recently-started session's rollout, so the structured view showed
  // a different session's transcript next to the correct PTY.
  return findRolloutByCwd(codexRoot, cwd, startedAt) || direct;
}

const ROLLOUT_ID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The codex thread UUID embedded in a rollout filename
 * (`rollout-2026-10-22T18-52-41-<uuid>.jsonl`), or null. */
export function codexRolloutIdFromPath(rolloutPath: string | null): string | null {
  if (!rolloutPath) return null;
  const m = ROLLOUT_ID_RE.exec(basename(rolloutPath));
  return m ? m[1].toLowerCase() : null;
}

/** The codex thread UUID a finished session can be continued from with
 * `codex resume <id>`: its recorded rollout when we stashed one, otherwise the
 * rollout that matches the session's cwd and start time. Null when no rollout
 * can be attributed to the session (callers fall back to a context rebuild). */
export function resolveCodexResumeId(
  cwd: string | null,
  codexSessionId: string | null,
  startedAt?: string | null,
  homeDir = homedir(),
): string | null {
  return codexRolloutIdFromPath(computeCodexJsonlPath(cwd, codexSessionId, startedAt, false, homeDir));
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

/** Clock slack between the session row's startedAt and codex's session_meta timestamp. */
const ROLLOUT_START_TOLERANCE_MS = 15_000;

function findRolloutsByCwd(codexRoot: string, cwd: string, startedAt?: string | null): { path: string; mtime: number }[] {
  // Search recent days around/after startedAt for rollouts whose session_meta.cwd
  // matches. Live Codex threads can rotate to a new rollout after /clear or
  // compaction, so callers may choose newest instead of closest-to-start.
  const startTs = startedAt ? Date.parse(startedAt) : Date.now();
  const startDate = isNaN(startTs) ? new Date() : new Date(startTs);
  // A rollout recorded before this session started cannot be its own: codex
  // writes session_meta a second or two after launch, and in that window the
  // closest-in-time match used to be an older session in the same cwd, so the
  // structured view (and anything following it) showed that session's
  // transcript. Better to answer "no transcript yet" than someone else's.
  const earliest = startedAt && !isNaN(startTs) ? startTs - ROLLOUT_START_TOLERANCE_MS : -Infinity;
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
        if (mtime < earliest) continue;
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

/** A missing prior key means the transcript set was replaced (not extended),
 * as happens when `/clear` rotates the main file. */
export function jsonlCursorNeedsReset(
  offsets: Record<string, number> | null,
  units: Array<Pick<JsonlUnit, 'key'>>,
): boolean {
  if (offsets === null) return true;
  const unitKeys = new Set(units.map((unit) => unit.key));
  return Object.keys(offsets).some((key) => !unitKeys.has(key));
}

export function collectJsonlUnits(
  mainJsonlPath: string,
  isCodex: boolean,
  findContinuations: (mainJsonlPath: string) => string[] = findContinuationJsonls,
): JsonlUnit[] {
  const baseDir = dirname(mainJsonlPath);
  const toKey = (p: string) => p.startsWith(baseDir + '/') ? p.slice(baseDir.length + 1) : p;
  if (isCodex) {
    return existsSync(mainJsonlPath) ? [{ key: toKey(mainJsonlPath), path: mainJsonlPath }] : [];
  }
  const files = [mainJsonlPath, ...findContinuations(mainJsonlPath)];
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
//
// `maxBytes` bounds how much is read in one call: the read stops at the last
// complete line inside the window and `more` reports that the file has bytes
// past it. A single line longer than the window is still returned whole (the
// read extends to that line's end) so a reader always makes progress — unless
// `extendOversizedLine` is false, where it is left unread (`more`) for a later
// call with a fresh window.
export function readJsonlFileDelta(
  path: string,
  fromOffset: number,
  consumePartial: boolean,
  maxBytes: number = Infinity,
  extendOversizedLine: boolean = true,
): { text: string; newOffset: number; shrunk: boolean; more: boolean } {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { text: '', newOffset: 0, shrunk: fromOffset > 0, more: false };
  }
  if (size < fromOffset) return { text: '', newOffset: 0, shrunk: true, more: false };
  if (size === fromOffset) return { text: '', newOffset: fromOffset, shrunk: false, more: false };
  const fd = openSync(path, 'r');
  try {
    const window = Math.max(1, Math.min(size - fromOffset, maxBytes));
    const first = Buffer.alloc(window);
    let read = readSync(fd, first, 0, first.length, fromOffset);
    let chunk = first.subarray(0, read);
    let atEof = read < window || fromOffset + read >= size;
    if (!atEof && chunk.lastIndexOf(0x0a) === -1) {
      if (!extendOversizedLine) return { text: '', newOffset: fromOffset, shrunk: false, more: true };
      // One line longer than the window: extend to the end of that line.
      const parts = [chunk];
      const block = Buffer.alloc(OVERSIZED_LINE_BLOCK_BYTES);
      while (!atEof) {
        const n = readSync(fd, block, 0, block.length, fromOffset + read);
        if (n <= 0) { atEof = true; break; }
        const nl = block.subarray(0, n).indexOf(0x0a);
        const take = nl === -1 ? n : nl + 1;
        parts.push(Buffer.from(block.subarray(0, take)));
        read += take;
        if (nl !== -1) break;
        if (fromOffset + read >= size) atEof = true;
      }
      chunk = Buffer.concat(parts);
    }
    const more = !atEof && fromOffset + read < size;
    const lastNl = chunk.lastIndexOf(0x0a);
    // Only the true end of file may be consumed as a partial line.
    const takePartial = consumePartial && !more;
    if (lastNl === -1 && !takePartial) return { text: '', newOffset: fromOffset, shrunk: false, more };
    const end = takePartial && lastNl < read - 1 ? read : lastNl + 1;
    return { text: chunk.subarray(0, end).toString('utf-8'), newOffset: fromOffset + end, shrunk: false, more };
  } finally {
    closeSync(fd);
  }
}

const OVERSIZED_LINE_BLOCK_BYTES = 1024 * 1024;

/** Bounds on one transcript read. A long-running session can accumulate
 *  hundreds of megabytes of subagent transcripts; reading all of it for one
 *  response blocks the event loop for seconds and overflows V8's maximum
 *  string length when the response is serialized. */
export interface JsonlReadLimits {
  /** File bytes read per response. Past it the response carries `more` and
   *  the caller polls again straight away with the returned cursor. */
  responseBytes: number;
  /** Snapshot: bytes kept across main + continuation files, newest first. */
  snapshotMainBytes: number;
  /** Snapshot: bytes kept across all subagent files, newest first. */
  snapshotSubagentBytes: number;
  /** Snapshot: bytes kept from any one subagent file. */
  snapshotSubagentFileBytes: number;
}

export const DEFAULT_JSONL_READ_LIMITS: JsonlReadLimits = {
  responseBytes: 8 * 1024 * 1024,
  snapshotMainBytes: 32 * 1024 * 1024,
  snapshotSubagentBytes: 16 * 1024 * 1024,
  snapshotSubagentFileBytes: 2 * 1024 * 1024,
};

// First line start at or after `offset` — a snapshot that skips the head of a
// file must not begin in the middle of a JSON line.
function alignJsonlOffsetToLineStart(path: string, offset: number, size: number): number {
  if (offset <= 0) return 0;
  if (offset >= size) return size;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return offset;
  }
  try {
    const block = Buffer.alloc(64 * 1024);
    // Start one byte early: a newline right before `offset` means it already
    // sits on a line start.
    let pos = offset - 1;
    while (pos < size) {
      const n = readSync(fd, block, 0, Math.min(block.length, size - pos), pos);
      if (n <= 0) break;
      const nl = block.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) return pos + nl + 1;
      pos += n;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

/** Where a fresh snapshot starts reading each file. Files that fit the limits
 *  start at 0; oversized history is skipped from the front (oldest first),
 *  keeping the newest lines. Main/continuation files and subagent files draw
 *  on separate budgets so chatty subagents can't crowd out the conversation. */
export function planJsonlSnapshotOffsets(
  units: JsonlUnit[],
  limits: JsonlReadLimits = DEFAULT_JSONL_READ_LIMITS,
): { offsets: Record<string, number>; skippedBytes: number } {
  const offsets: Record<string, number> = {};
  let skippedBytes = 0;
  let mainLeft = limits.snapshotMainBytes;
  let subLeft = limits.snapshotSubagentBytes;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    let size = 0;
    try { size = statSync(u.path).size; } catch { /* vanished → nothing to read */ }
    let keep: number;
    if (u.subagentId) {
      keep = Math.min(size, limits.snapshotSubagentFileBytes, subLeft);
      subLeft -= keep;
    } else {
      keep = Math.min(size, mainLeft);
      mainLeft -= keep;
    }
    const start = keep >= size ? 0 : alignJsonlOffsetToLineStart(u.path, size - keep, size);
    offsets[u.key] = start;
    skippedBytes += start;
  }
  return { offsets, skippedBytes };
}

export interface JsonlUnitsDelta {
  /** Per-file byte offsets to resume from; covers every unit. */
  newOffsets: Record<string, number>;
  chunks: Array<{ unit: JsonlUnit; text: string }>;
  /** Previous client buffers are stale — this is a fresh snapshot. */
  reset: boolean;
  /** The response budget ran out with bytes still unread; poll again now. */
  more: boolean;
  /** Bytes of old history a snapshot left out (0 for plain deltas). */
  skippedBytes: number;
}

/** One differential read across a session's transcript files: everything past
 *  the cursor's per-file offsets, bounded by `limits`. A null cursor, a cursor
 *  for a different file set, or a file that shrank under it yields a snapshot
 *  (`reset`). `unpagedSnapshot` lifts the per-response budget for a snapshot
 *  (the snapshot limits still apply) for callers that trim it themselves. */
export function readJsonlUnitsDelta(
  units: JsonlUnit[],
  cursorOffsets: Record<string, number> | null,
  opts: { consumePartial: boolean; unpagedSnapshot?: boolean; limits?: JsonlReadLimits },
): JsonlUnitsDelta {
  const limits = opts.limits ?? DEFAULT_JSONL_READ_LIMITS;
  let reset = jsonlCursorNeedsReset(cursorOffsets, units);

  const attempt = (): JsonlUnitsDelta | null => {
    const plan = reset ? planJsonlSnapshotOffsets(units, limits) : null;
    const starts = plan ? plan.offsets : cursorOffsets!;
    const fullBudget = reset && opts.unpagedSnapshot ? Infinity : limits.responseBytes;
    let budget = fullBudget;
    let more = false;
    const newOffsets: Record<string, number> = {};
    const chunks: JsonlUnitsDelta['chunks'] = [];
    for (const u of units) {
      const from = typeof starts[u.key] === 'number' ? starts[u.key] : 0;
      if (budget <= 0) {
        // Out of budget: carry the offset forward untouched for the next poll.
        let size = from;
        try { size = statSync(u.path).size; } catch { /* treat as unchanged */ }
        if (size < from) return null;
        if (size > from) more = true;
        newOffsets[u.key] = from;
        continue;
      }
      // Only a read with the whole budget may overshoot it for an oversized
      // line; a leftover sliver of budget defers that line to the next poll.
      const d = readJsonlFileDelta(u.path, from, opts.consumePartial, budget, budget === fullBudget);
      if (d.shrunk) return null;
      newOffsets[u.key] = d.newOffset;
      budget -= d.newOffset - from;
      if (d.more) more = true;
      if (d.text) chunks.push({ unit: u, text: d.text });
    }
    return { newOffsets, chunks, reset, more, skippedBytes: plan ? plan.skippedBytes : 0 };
  };

  let result = attempt();
  if (!result) {
    // A file got truncated/rotated under the cursor — resend a snapshot.
    reset = true;
    result = attempt();
  }
  return result ?? { newOffsets: {}, chunks: [], reset: true, more: false, skippedBytes: 0 };
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
export function listJsonlFiles(
  mainJsonlPath: string,
  findContinuations: (mainJsonlPath: string) => string[] = findContinuationJsonls,
): JsonlFileInfo[] {
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

  for (const contPath of findContinuations(mainJsonlPath)) {
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
export function exportSessionFiles(
  projectDir: string,
  claudeSessionId: string,
  findContinuations: (mainJsonlPath: string) => string[] = findContinuationJsonls,
): SessionFilePackage {
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

  for (const contPath of findContinuations(jsonlPath)) {
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
