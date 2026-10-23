import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Auth portal: an SSO gateway that fronts a ProPanes server and redirects
 * every request without its session cookie to a login page — including the
 * launcher's WebSocket upgrade. A launcher dialing such a server first turns
 * a long-lived portal token (a CLI/device credential) into that session
 * cookie and sends it on the upgrade.
 *
 * The portal protocol is generic: `POST <url>/auth/cli/session {host}` with
 * the token as a bearer answers `{sso_url}`; GETting the sso_url (without
 * following its redirect) sets the session cookie(s) for `host`. Which portal,
 * which token and which cookie are deployment specifics and come from the
 * environment or the CLI's stored login, never from code:
 *
 *   PROPANES_PORTAL_URL     portal base URL (e.g. the SSO login host)
 *   PROPANES_PORTAL_TOKEN   portal token for this machine
 *   PROPANES_PORTAL_HOST    host the session is minted for (default: the server's host)
 *   PROPANES_PORTAL_COOKIE  name of the session cookie (default: accept whatever the callback sets)
 *
 * Without PROPANES_PORTAL_TOKEN the launcher reads what `propanes login
 * --portal` stored for the server's origin in ~/.config/propanes/config.json
 * (`servers[origin].portal = {url, token, host?, cookie?}`). Returns null when
 * the server is not gated or no token is available.
 */
export interface PortalConfig {
  url: string;
  token: string;
  host: string;
  /** Session cookie name; unset = any cookie the callback sets. */
  cookie?: string;
}

export function resolvePortalConfig(
  serverWsUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = join(env.HOME || homedir(), '.config', 'propanes', 'config.json'),
): PortalConfig | null {
  let url: URL;
  try {
    url = new URL(serverWsUrl);
  } catch {
    return null;
  }
  const host = env.PROPANES_PORTAL_HOST || url.host;
  const cookie = env.PROPANES_PORTAL_COOKIE || undefined;
  if (env.PROPANES_PORTAL_TOKEN) {
    if (!env.PROPANES_PORTAL_URL) throw new PortalAuthError('PROPANES_PORTAL_TOKEN is set but PROPANES_PORTAL_URL is not');
    return { url: env.PROPANES_PORTAL_URL.replace(/\/+$/, ''), token: env.PROPANES_PORTAL_TOKEN, host, ...(cookie ? { cookie } : {}) };
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    const origin = `${url.protocol === 'ws:' ? 'http:' : 'https:'}//${url.host}`;
    const stored = cfg.servers?.[origin]?.portal;
    if (stored?.token && (env.PROPANES_PORTAL_URL || stored.url)) {
      const c = cookie || stored.cookie || undefined;
      return { url: (env.PROPANES_PORTAL_URL || stored.url).replace(/\/+$/, ''), token: stored.token, host: env.PROPANES_PORTAL_HOST || stored.host || host, ...(c ? { cookie: c } : {}) };
    }
  } catch {}
  return null;
}

export class PortalAuthError extends Error {}

/**
 * Exchange the portal token for the session cookie(s) for `cfg.host`. The
 * portal answers /auth/cli/session with a one-shot sso_url; GETting it
 * (without following the redirect) is what sets the cookie.
 */
export async function fetchPortalSession(
  cfg: PortalConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ cookie: string; expiresAt: number }> {
  const res = await fetchImpl(`${cfg.url}/auth/cli/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ host: cfg.host }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new PortalAuthError(`Auth portal refused a session for ${cfg.host}: ${res.status} ${body.error || ''}`.trim());
  }
  const { sso_url } = await res.json() as { sso_url?: string };
  if (!sso_url) throw new PortalAuthError('Auth portal returned no sso_url');

  const cb = await fetchImpl(sso_url, { redirect: 'manual' });
  const setCookies = typeof cb.headers.getSetCookie === 'function'
    ? cb.headers.getSetCookie()
    : [cb.headers.get('set-cookie') || ''];
  const parts: string[] = [];
  let maxAge: number | null = null;
  let sawSession = false;
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    if (!pair.includes('=')) continue;
    parts.push(pair);
    const isSession = cfg.cookie ? pair.startsWith(`${cfg.cookie}=`) : parts.length === 1;
    if (isSession) {
      sawSession = true;
      const m = raw.match(/max-age=(\d+)/i);
      if (m) maxAge = Number(m[1]);
    }
  }
  if (!parts.length || !sawSession) {
    const want = cfg.cookie ? `no ${cfg.cookie} cookie` : 'no cookie';
    throw new PortalAuthError(`Auth portal callback set ${want} (status ${cb.status})`);
  }
  // Refresh an hour before the advertised lifetime; assume a week when the
  // portal does not say.
  const ttlSec = Math.max((maxAge ?? 7 * 24 * 3600) - 3600, 60);
  return { cookie: parts.join('; '), expiresAt: Date.now() + ttlSec * 1000 };
}

export function createPortalSession(cfg: PortalConfig, fetchImpl: typeof fetch = fetch) {
  let cached: { cookie: string; expiresAt: number } | null = null;
  return {
    async cookie(): Promise<string> {
      if (!cached || cached.expiresAt <= Date.now()) cached = await fetchPortalSession(cfg, fetchImpl);
      return cached.cookie;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
