import { useState } from 'preact/hooks';
import { publicAssetPath } from '../lib/base-path.js';
import { isSlackSession } from '../lib/session-source.js';

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

// Runtime tag — shown next to the PR badges wherever an agent session is
// listed. Renders the vendor's favicon (claude.ai / chatgpt.com, checked into
// public/badges) rather than a text label so the rows stay narrow; the name
// lives in the tooltip. Hidden for plain terminals and unknown sessions.
const RUNTIME_BADGES = {
  claude: { icon: 'badges/claude.png', label: 'Claude' },
  codex: { icon: 'badges/chatgpt.png', label: 'Codex (OpenAI)' },
} as const;

export function RuntimeBadge({ runtime, permissionProfile }: { runtime?: string | null; permissionProfile?: string | null }) {
  if (permissionProfile === 'plain' || (!runtime && !permissionProfile)) return null;
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  const { icon, label } = RUNTIME_BADGES[rt];
  return (
    <span class={`session-runtime-badge rt-${rt}`} title={`Runtime: ${label}`} aria-label={`Runtime: ${label}`}>
      <img class="session-badge-icon" src={publicAssetPath(icon)} alt="" draggable={false} />
    </span>
  );
}

// Source tag — a Slack favicon on sessions the amirobot bridge dispatched from
// a Slack thread (feedback tagged `slack`, see lib/session-source.ts). Pass a
// session row, or `slack` directly for an aggregate (a CoS thread divider).
export function SourceBadge({ session, slack }: { session?: { feedbackTags?: unknown } | null; slack?: boolean }) {
  if (!(slack ?? isSlackSession(session))) return null;
  return (
    <span class="session-source-badge src-slack" title="amirobot Slack thread" aria-label="amirobot Slack thread">
      <img class="session-badge-icon" src={publicAssetPath('badges/slack.png')} alt="" draggable={false} />
    </span>
  );
}

// Compact rows (sidebar items) only get this many badges inline; the rest
// collapse into a "+N" chip so a session with a dozen PRs can't crowd its
// title out of the row. Clicking the chip reveals the full set.
const COMPACT_PR_BADGE_LIMIT = 2;

export function PrBadges({ prUrls, compact }: { prUrls?: unknown; compact?: boolean }) {
  const urls = parsePrUrls(prUrls);
  const [expanded, setExpanded] = useState(false);
  if (!urls.length) return null;
  const collapsible = !!compact && urls.length > COMPACT_PR_BADGE_LIMIT + 1;
  const collapse = collapsible && !expanded;
  const visible = collapse ? urls.slice(0, COMPACT_PR_BADGE_LIMIT) : urls;
  const hidden = collapse ? urls.slice(COMPACT_PR_BADGE_LIMIT) : [];
  return (
    <span class={`session-pr-badges${compact ? ' compact' : ''}${collapsible && expanded ? ' expanded' : ''}`}>
      {visible.map((url) => {
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
      {hidden.length > 0 && (
        <button
          type="button"
          class="session-pr-badge session-pr-badge-more"
          title={hidden.map((u) => `PR #${prNumberFromUrl(u)} — ${u}`).join('\n')}
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        >
          +{hidden.length}
        </button>
      )}
      {collapsible && expanded && (
        <button
          type="button"
          class="session-pr-badge session-pr-badge-more"
          title="Show fewer"
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        >
          {'\u2212'}
        </button>
      )}
    </span>
  );
}
