// "Continue in Slack" requests from the admin session menu. The amirobot
// Slack listener (packages/slack-bot) has no inbound HTTP — it holds a Socket
// Mode connection to Slack — so it polls this queue with its bearer token,
// opens a thread for each claimed session and reports the outcome, which the
// admin polls to show a toast. Requests are transient: a server restart drops
// queued ones, and the admin reports that the request expired.
import { ulid } from 'ulidx';

export type SlackHandoffStatus = 'queued' | 'claimed' | 'done' | 'failed';

export interface SlackHandoff {
  id: string;
  sessionId: string;
  requestedBy: string;
  status: SlackHandoffStatus;
  message: string | null;
  permalink: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The listener polls every few seconds; silence longer than this means it is not running. */
export const LISTENER_STALE_MS = 30_000;
/** A claimed request the listener never reported on is failed after this long. */
const CLAIM_TIMEOUT_MS = 2 * 60_000;
const RETAIN_MS = 60 * 60_000;

const handoffs = new Map<string, SlackHandoff>();
let lastClaimAt = 0;

function prune(now: number): void {
  for (const [id, h] of handoffs) {
    if (now - h.updatedAt > RETAIN_MS) handoffs.delete(id);
    else if (h.status === 'claimed' && now - h.updatedAt > CLAIM_TIMEOUT_MS) {
      Object.assign(h, { status: 'failed', message: 'The Slack listener did not report back', updatedAt: now });
    }
  }
}

export function slackListenerConnected(now = Date.now()): boolean {
  return now - lastClaimAt <= LISTENER_STALE_MS;
}

/** Queue a session; repeat requests for a session already waiting reuse its entry. */
export function requestSlackHandoff(sessionId: string, requestedBy: string, now = Date.now()): SlackHandoff {
  prune(now);
  for (const h of handoffs.values()) {
    if (h.sessionId === sessionId && (h.status === 'queued' || h.status === 'claimed')) return h;
  }
  const h: SlackHandoff = { id: ulid(), sessionId, requestedBy, status: 'queued', message: null, permalink: null, createdAt: now, updatedAt: now };
  handoffs.set(h.id, h);
  return h;
}

/** The listener's poll: hands over every queued request and marks the listener alive. */
export function claimSlackHandoffs(now = Date.now()): SlackHandoff[] {
  lastClaimAt = now;
  prune(now);
  const claimed: SlackHandoff[] = [];
  for (const h of handoffs.values()) {
    if (h.status !== 'queued') continue;
    h.status = 'claimed';
    h.updatedAt = now;
    claimed.push({ ...h });
  }
  return claimed;
}

export function completeSlackHandoff(id: string, result: { ok: boolean; message?: string | null; permalink?: string | null }, now = Date.now()): SlackHandoff | null {
  const h = handoffs.get(id);
  if (!h) return null;
  h.status = result.ok ? 'done' : 'failed';
  h.message = result.message?.slice(0, 500) || null;
  h.permalink = result.permalink && /^https:\/\//.test(result.permalink) ? result.permalink : null;
  h.updatedAt = now;
  return { ...h };
}

export function getSlackHandoff(id: string, now = Date.now()): SlackHandoff | null {
  prune(now);
  const h = handoffs.get(id);
  return h ? { ...h } : null;
}

/** Test hook. */
export function resetSlackHandoffs(): void {
  handoffs.clear();
  lastClaimAt = 0;
}
