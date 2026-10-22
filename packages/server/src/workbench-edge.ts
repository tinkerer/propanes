import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_WB_EDGE = 'https://app.myworkbench.ai';

export interface EdgeConfig {
  token: string;
  edge: string;
  host: string;
}

/**
 * Hosts under *.myworkbench.ai sit behind the Workbench SSO gateway, which 302s
 * any request without a `wb_session` cookie — including the launcher's
 * WebSocket upgrade. A launcher dialing such a server needs a `wbcli_` token
 * (the CLI device-flow credential) to mint that cookie.
 *
 * Resolution order: WORKBENCH_CLI_TOKEN env, then the token `propanes login
 * --workbench --server https://<host>` stored in ~/.config/propanes/config.json.
 * Returns null when the server isn't gated or no token is available.
 */
export function resolveEdgeConfig(
  serverWsUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = join(env.HOME || homedir(), '.config', 'propanes', 'config.json'),
): EdgeConfig | null {
  let url: URL;
  try {
    url = new URL(serverWsUrl);
  } catch {
    return null;
  }
  const host = env.WORKBENCH_HOST || url.host;
  if (env.WORKBENCH_CLI_TOKEN) {
    return { token: env.WORKBENCH_CLI_TOKEN, edge: env.WORKBENCH_EDGE || DEFAULT_WB_EDGE, host };
  }
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    const origin = `${url.protocol === 'ws:' ? 'http:' : 'https:'}//${url.host}`;
    const wb = cfg.servers?.[origin]?.workbench;
    if (wb?.token) {
      return { token: wb.token, edge: env.WORKBENCH_EDGE || wb.edge || DEFAULT_WB_EDGE, host: wb.host || host };
    }
  } catch {}
  return null;
}

export class EdgeAuthError extends Error {}

/**
 * Exchange the `wbcli_` token for a `wb_session` cookie for `host`. The edge
 * answers /auth/cli/session with a one-shot sso_url; GETting it (without
 * following the redirect) is what sets the cookie.
 */
export async function fetchEdgeSession(
  cfg: EdgeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ cookie: string; expiresAt: number }> {
  const res = await fetchImpl(`${cfg.edge}/auth/cli/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ host: cfg.host }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new EdgeAuthError(`Workbench edge refused session for ${cfg.host}: ${res.status} ${body.error || ''}`.trim());
  }
  const { sso_url } = await res.json() as { sso_url?: string };
  if (!sso_url) throw new EdgeAuthError('Workbench edge returned no sso_url');

  const cb = await fetchImpl(sso_url, { redirect: 'manual' });
  const setCookies = typeof cb.headers.getSetCookie === 'function'
    ? cb.headers.getSetCookie()
    : [cb.headers.get('set-cookie') || ''];
  const parts: string[] = [];
  let maxAge: number | null = null;
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    if (!pair.includes('=')) continue;
    parts.push(pair);
    if (pair.startsWith('wb_session=')) {
      const m = raw.match(/max-age=(\d+)/i);
      if (m) maxAge = Number(m[1]);
    }
  }
  if (!parts.some((p) => p.startsWith('wb_session='))) {
    throw new EdgeAuthError(`Workbench sso callback set no wb_session cookie (status ${cb.status})`);
  }
  // Refresh an hour before the advertised lifetime; the edge issues 7-day
  // sessions when it doesn't say.
  const ttlSec = Math.max((maxAge ?? 7 * 24 * 3600) - 3600, 60);
  return { cookie: parts.join('; '), expiresAt: Date.now() + ttlSec * 1000 };
}

export function createEdgeSession(cfg: EdgeConfig, fetchImpl: typeof fetch = fetch) {
  let cached: { cookie: string; expiresAt: number } | null = null;
  return {
    async cookie(): Promise<string> {
      if (!cached || cached.expiresAt <= Date.now()) cached = await fetchEdgeSession(cfg, fetchImpl);
      return cached.cookie;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
