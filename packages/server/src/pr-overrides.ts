// Manual corrections to a session's detected PR badges.
//
// Detection (pr-detect.ts on the PTY, pr-transcript-scan.ts on the JSONL)
// misses PRs the agent never printed a URL for and occasionally picks up one
// the session merely mentioned. The admin session menu lets a user add or
// remove a badge by hand. Those edits live in their own columns —
// `pr_urls_added` / `pr_urls_hidden` — rather than in `pr_urls`, because the
// session-service holds `pr_urls` in memory for a live session and rewrites
// the whole column on every flush: an edit made there would be clobbered, and
// a removed URL would simply be detected again.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseUrlList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

/** Detected URLs minus the hidden ones, then the manually added ones. */
export function effectivePrUrls(
  detectedJson: string | null | undefined,
  addedJson: string | null | undefined,
  hiddenJson: string | null | undefined,
): string[] {
  const hidden = new Set(parseUrlList(hiddenJson));
  const out = new Set(parseUrlList(detectedJson).filter((u) => !hidden.has(u)));
  for (const url of parseUrlList(addedJson)) out.add(url);
  return [...out];
}

/** `owner/repo` of a GitHub remote URL (https or ssh form), or null. */
export function githubRepoFromRemote(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Turn what a user typed into a canonical PR URL. Accepts a full URL (any
 * trailing `/files`, query or fragment is dropped), `owner/repo#123`, or a
 * bare `123` / `#123` resolved against `defaultRepo`. Returns null when the
 * input can't be read as a PR.
 */
export function normalizePrInput(input: string, defaultRepo: string | null): string | null {
  const s = input.trim();
  const url = s.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,7})(?:[/?#].*)?$/);
  if (url) return `https://github.com/${url[1]}/${url[2]}/pull/${url[3]}`;
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,7})$/);
  if (short) return `https://github.com/${short[1]}/${short[2]}/pull/${short[3]}`;
  const bare = s.match(/^(?:PR\s*)?#?(\d{1,7})$/i);
  if (bare && defaultRepo) return `https://github.com/${defaultRepo}/pull/${bare[1]}`;
  return null;
}

/**
 * The repo a bare PR number should resolve against: the repo of a PR the
 * session already has, else the `origin` remote of its working directory.
 */
export async function defaultRepoForSession(knownUrls: string[], cwd: string | null): Promise<string | null> {
  for (const url of knownUrls) {
    const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//);
    if (m) return m[1];
  }
  if (!cwd) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 3000 });
    return githubRepoFromRemote(stdout);
  } catch {
    return null;
  }
}

/**
 * Apply an add or remove to the override lists. Adding un-hides a URL and
 * records it as added unless detection already has it; removing drops a
 * manual add and hides a detected URL so the next scan can't bring it back.
 */
export function applyPrOverride(
  detected: string[],
  added: string[],
  hidden: string[],
  op: { add?: string; remove?: string },
): { added: string[]; hidden: string[] } {
  let nextAdded = [...added];
  let nextHidden = [...hidden];
  if (op.add) {
    const url = op.add;
    nextHidden = nextHidden.filter((u) => u !== url);
    if (!detected.includes(url) && !nextAdded.includes(url)) nextAdded.push(url);
  }
  if (op.remove) {
    const url = op.remove;
    nextAdded = nextAdded.filter((u) => u !== url);
    if (detected.includes(url) && !nextHidden.includes(url)) nextHidden.push(url);
  }
  return { added: nextAdded, hidden: nextHidden };
}
