// Detect GitHub pull-request URLs in agent session output so sessions that
// opened a PR can carry a "PR #123" tag in the admin UI.
//
// Matching is against raw PTY output, which means two hazards:
//   1. ANSI/OSC control sequences interleave the text. We replace them with
//      newlines rather than deleting them — deletion glues unrelated screen
//      fragments together and can fabricate matches; a separator can only
//      split a candidate, and the join pass below recovers those.
//   2. tmux/PTY repaints hard-wrap long lines at the pane width, splitting a
//      URL mid-token. A second pass with line breaks removed catches these.

const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,7})/g;

function stripControlToSeparators(data: string): string {
  return data
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '\n')      // CSI (incl. DECSET)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '\n') // OSC
    .replace(/\x1b\([A-Z]/g, '\n')                    // charset designators
    .replace(/\x1b[>=][0-9;]*[a-zA-Z]/g, '\n')        // DEC private
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '\n');   // remaining 2-char ESC
}

export function extractPrUrls(raw: string): string[] {
  if (!raw || !raw.includes('github.com')) return [];
  const visible = stripControlToSeparators(raw);

  const direct = new Map<string, { repo: string; num: string }>();
  for (const m of visible.matchAll(PR_URL_RE)) {
    direct.set(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, { repo: `${m[1]}/${m[2]}`, num: m[3] });
  }

  // Join pass: recover URLs the PTY wrapped across lines. A join can also glue
  // trailing digits from the next line onto a number the direct pass already
  // matched (763 → 7634), so drop joined matches whose number merely extends a
  // direct same-repo match.
  const found = new Map(direct);
  const joined = visible.replace(/[\r\n]+/g, '');
  for (const m of joined.matchAll(PR_URL_RE)) {
    const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
    if (found.has(url)) continue;
    const repo = `${m[1]}/${m[2]}`;
    let isJoinArtifact = false;
    for (const d of direct.values()) {
      if (d.repo === repo && m[3] !== d.num && m[3].startsWith(d.num)) { isJoinArtifact = true; break; }
    }
    if (!isJoinArtifact) found.set(url, { repo, num: m[3] });
  }
  return [...found.keys()];
}

/**
 * Merge PR URLs found in `text` into an existing JSON-array column value.
 * Returns the updated JSON string when new URLs were found, or null when
 * nothing changed (callers skip the DB write).
 */
export function mergePrUrls(existingJson: string | null | undefined, text: string): string | null {
  const detected = extractPrUrls(text);
  if (!detected.length) return null;
  let existing: string[] = [];
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (Array.isArray(parsed)) existing = parsed.filter((u): u is string => typeof u === 'string');
    } catch { /* treat malformed as empty */ }
  }
  const merged = new Set(existing);
  let changed = false;
  for (const url of detected) {
    if (!merged.has(url)) { merged.add(url); changed = true; }
  }
  return changed ? JSON.stringify([...merged]) : null;
}
