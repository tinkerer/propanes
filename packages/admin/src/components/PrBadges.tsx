// "PR #123" tag shown next to a session wherever it's listed. The server
// detects GitHub PR URLs in the session's PTY output (pr-detect.ts) and in its
// transcript on disk (pr-transcript-scan.ts — where collapsed `gh pr` results
// live) and exposes them as `prUrls` — string[] from the list API, raw JSON
// string from the single-row endpoint — so normalize both here. Rows stored
// before the detector stopped fabricating character-dropped URLs are scrubbed
// on read too (dropShadowedPrUrls), so a badge never links to `workbenhai`.

// Mirror of the server's pr-detect.ts dropShadowedPrUrls: a URL that is a
// strict subsequence of another one here is the same URL with characters
// lost in the PTY, so it goes.
export function dropShadowedPrUrls(urls: string[]): string[] {
  const unique = [...new Set(urls)];
  return unique.filter((u) => !unique.some((other) => other !== u && other.length > u.length && isSubsequence(u, other)));
}

function isSubsequence(short: string, long: string): boolean {
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) {
    if (long[j] === short[i]) i++;
  }
  return i === short.length;
}

export function parsePrUrls(prUrls: unknown): string[] {
  let arr: unknown = prUrls;
  if (typeof arr === 'string' && arr) {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return dropShadowedPrUrls(arr.filter((u): u is string => typeof u === 'string' && u.includes('/pull/')));
}

export function prNumberFromUrl(url: string): string {
  return (url.split('/pull/')[1] || '').replace(/[^\d].*$/, '');
}

export function prSearchText(prUrls: unknown): string {
  return parsePrUrls(prUrls).map((url) => {
    const num = prNumberFromUrl(url);
    return `${url} PR #${num} PR ${num}`;
  }).join(' ').toLowerCase();
}

// Runtime tag (claude / codex) — shown next to the PR badges wherever an agent
// session is listed. Hidden for plain terminals and unknown sessions.
export function RuntimeBadge({ runtime, permissionProfile }: { runtime?: string | null; permissionProfile?: string | null }) {
  if (permissionProfile === 'plain' || (!runtime && !permissionProfile)) return null;
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  return (
    <span class={`session-runtime-badge rt-${rt}`} title={`Runtime: ${rt === 'codex' ? 'Codex' : 'Claude'}`}>
      {rt}
    </span>
  );
}

export function PrBadges({ prUrls, compact }: { prUrls?: unknown; compact?: boolean }) {
  const urls = parsePrUrls(prUrls);
  if (!urls.length) return null;
  return (
    <span class={`session-pr-badges${compact ? ' compact' : ''}`}>
      {urls.map((url) => {
        const num = prNumberFromUrl(url);
        return (
          <a
            key={url}
            class="session-pr-badge"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            onClick={(e) => e.stopPropagation()}
          >
            PR #{num}
          </a>
        );
      })}
    </span>
  );
}
