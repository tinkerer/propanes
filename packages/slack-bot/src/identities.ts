/** Which ProPanes user each Slack member acts as. One shared Slack app serves
 * everyone: the operator links a Slack member id to a ProPanes user on the
 * Users page, and the bot then works for that person with a short-lived token
 * minted for them, so their sessions are theirs (their apps, their pinned
 * launcher, their agent logins). Requires the operator's (org-less admin)
 * PROPANES_TOKEN; with any other token the directory stays empty. */
import { PropanesApiError, type PropanesFetch } from './propanes';

export interface SlackIdentity {
  userId: string;
  username: string;
  role: string;
  slackUserId: string;
  /** Display name for replies to this user; null = the bot's own name. */
  persona: string | null;
  /** May also start requests as the operator with `[operator]`. */
  operatorAccess?: boolean;
  /** The launcher their sessions are pinned to; null = not onboarded onto their own machine account. */
  launcherId?: string | null;
}

export interface IdentityDirectoryOptions {
  now?: () => number;
  /** An unknown Slack member re-reads the list at most this often. */
  minRefreshGapMs?: number;
  /** Re-mint a user token once less than this much of its life is left. */
  tokenRenewMs?: number;
  log?: (message: string) => void;
}

export class IdentityDirectory {
  private bySlack = new Map<string, SlackIdentity>();
  private tokens = new Map<string, { token: string; expiresAt: number; pending?: Promise<string> }>();
  private lastRefresh = 0;
  private inflight: Promise<void> | undefined;
  /** False once the server refused the listing (not the operator's token). */
  enabled = true;
  private readonly now: () => number;
  private readonly minGap: number;
  private readonly renewMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly api: PropanesFetch, opts: IdentityDirectoryOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.minGap = opts.minRefreshGapMs ?? 15_000;
    this.renewMs = opts.tokenRenewMs ?? 12 * 60 * 60_000;
    this.log = opts.log ?? (() => undefined);
  }

  all(): SlackIdentity[] { return [...this.bySlack.values()]; }

  async refresh(): Promise<void> {
    if (!this.enabled) return;
    this.inflight ??= (async () => {
      try {
        const r = await this.api('/api/v1/admin/slack-identities');
        const rows: SlackIdentity[] = Array.isArray(r?.identities) ? r.identities : [];
        this.bySlack = new Map(rows.filter(i => i.slackUserId && i.userId).map(i => [i.slackUserId, i]));
        // Unlinked users lose their cached token with their link.
        const linked = new Set(rows.map(i => i.userId));
        for (const userId of this.tokens.keys()) if (!linked.has(userId)) this.tokens.delete(userId);
      } catch (err) {
        if (err instanceof PropanesApiError && (err.status === 403 || err.status === 404)) {
          this.enabled = false;
          this.log('Slack identity links are unavailable (PROPANES_TOKEN is not the server operator\'s, or the server predates them); everyone acts as the operator');
          return;
        }
        throw err;
      } finally {
        this.lastRefresh = this.now();
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** The linked identity, re-reading the list (rate-limited) for a member not seen yet. */
  async lookup(slackUserId: string | undefined): Promise<SlackIdentity | undefined> {
    if (!slackUserId || !this.enabled) return undefined;
    const hit = this.bySlack.get(slackUserId);
    if (hit || this.now() - this.lastRefresh < this.minGap) return hit;
    try { await this.refresh(); } catch (err) {
      this.log(`identity refresh failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    return this.bySlack.get(slackUserId);
  }

  /** A bearer token for the user, minted on first use and renewed before expiry. */
  async token(userId: string): Promise<string> {
    const cached = this.tokens.get(userId);
    if (cached?.pending) return cached.pending;
    if (cached && cached.expiresAt - this.now() > this.renewMs) return cached.token;
    const pending = (async () => {
      try {
        const r = await this.api(`/api/v1/admin/slack-identities/${encodeURIComponent(userId)}/token`, { method: 'POST', body: '{}' });
        if (typeof r?.token !== 'string') throw new Error('the server did not return a token');
        const expiresAt = Date.parse(r.expiresAt) || this.now() + 24 * 60 * 60_000;
        this.tokens.set(userId, { token: r.token, expiresAt });
        return r.token as string;
      } catch (err) {
        if (cached) this.tokens.set(userId, cached); else this.tokens.delete(userId);
        throw err;
      }
    })();
    this.tokens.set(userId, { token: cached?.token ?? '', expiresAt: cached?.expiresAt ?? 0, pending });
    return pending;
  }
}
