// "PR #123" tag shown next to a session wherever it's listed. The server
// detects GitHub PR URLs in session output (pr-detect.ts) and exposes them as
// `prUrls` — string[] from the list API, raw JSON string from the single-row
// endpoint — so normalize both here.

export function parsePrUrls(prUrls: unknown): string[] {
  let arr: unknown = prUrls;
  if (typeof arr === 'string' && arr) {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter((u): u is string => typeof u === 'string' && u.includes('/pull/')))];
}

export function prNumberFromUrl(url: string): string {
  return (url.split('/pull/')[1] || '').replace(/[^\d].*$/, '');
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
