// Detect GitHub PR URLs in an agent's transcript (the Claude/Codex JSONL on
// disk) instead of relying only on the PTY stream.
//
// The terminal is a poor source for "which PR is this session on": Claude
// Code collapses tool results to a few lines, so the URL printed by
// `gh pr create` / `gh pr view` never reaches the screen, and what does get
// painted is shredded by cursor-positioning sequences (pr-detect.ts fights
// that with a join pass). The transcript has every tool command and result
// in full, as plain JSON — a session that only ever typed `gh pr view 1353`
// still has the PR URL sitting in that command's result. Better still, Claude
// Code records the PRs it associates with the session as `pr-link` records
// (`{"type":"pr-link","prUrl":...}`), which we take verbatim.

import { readJsonlFileDelta } from './jsonl-utils.js';
import { extractPrUrls } from './pr-detect.js';

export interface TranscriptScanCursor {
  /** Transcript last scanned. A different path (e.g. `/clear` rotating the file) restarts from 0. */
  path: string | null;
  /** Byte offset already consumed in `path`. */
  offset: number;
}

export function newTranscriptCursor(): TranscriptScanCursor {
  return { path: null, offset: 0 };
}

/**
 * A single non-assistant record (a tool result, a pasted prompt) that mentions
 * more distinct PRs than this is a listing — `gh pr list --json url`,
 * `gh search prs`, a page of notifications — not the PR the session is
 * working on. Assistant records are exempt: what the agent itself writes or
 * runs is a deliberate reference.
 */
export const MAX_PRS_PER_RESULT_RECORD = 3;

function parseRecord(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isAssistantRecord(rec: any): boolean {
  return rec?.type === 'assistant'
    || rec?.message?.role === 'assistant'
    || rec?.payload?.role === 'assistant'; // codex response_item
}

/** The PR URL of a Claude Code `pr-link` record, if `line` is one. */
export function prLinkUrl(rec: any): string | null {
  if (rec?.type !== 'pr-link' || typeof rec.prUrl !== 'string') return null;
  return /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d{1,7}$/.test(rec.prUrl) ? rec.prUrl : null;
}

/** PR URLs referenced by the transcript records in `text` (one JSON record per line). */
export function prUrlsFromTranscriptText(text: string): string[] {
  const found = new Set<string>();
  for (const rawLine of text.split('\n')) {
    if (!rawLine.includes('pull')) continue;
    // Some encoders escape forward slashes inside JSON strings.
    const line = rawLine.replace(/\\\//g, '/');
    if (!line.includes('/pull/')) continue;
    const rec = parseRecord(line);
    const linked = prLinkUrl(rec);
    if (linked) {
      found.add(linked);
      continue;
    }
    const urls = extractPrUrls(line);
    if (!urls.length) continue;
    if (urls.length > MAX_PRS_PER_RESULT_RECORD && !isAssistantRecord(rec)) continue;
    for (const url of urls) found.add(url);
  }
  return [...found];
}

/**
 * Scan the part of the transcript at `path` not yet covered by `cursor` and
 * return the PR URLs it references. The cursor advances so repeated calls are
 * incremental; a truncated/rotated file restarts from the beginning.
 * `consumePartial` reads a trailing line without a newline too — pass it on
 * the final scan of an ended session, when no more writes are coming.
 */
export function scanTranscriptForPrUrls(
  path: string | null,
  cursor: TranscriptScanCursor,
  consumePartial = false,
): string[] {
  if (!path) return [];
  if (cursor.path !== path) {
    cursor.path = path;
    cursor.offset = 0;
  }
  let delta = readJsonlFileDelta(path, cursor.offset, consumePartial);
  if (delta.shrunk) delta = readJsonlFileDelta(path, 0, consumePartial);
  cursor.offset = delta.newOffset;
  return delta.text ? prUrlsFromTranscriptText(delta.text) : [];
}
