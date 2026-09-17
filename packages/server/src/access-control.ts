// access-control.ts — env-driven network access control.
//
// Why this exists: when propanes is reverse-proxied UNDER a path prefix next to
// another app (e.g. https://host/propanes alongside Workbench at https://host/),
// the host deployment often puts a browser-SSO proxy in front of the whole
// prefix. That proxy 302s any non-browser client, and its session cookie is
// HttpOnly on a different origin from the CLI's localhost callback — so no
// command-line client can ever hold one. `propanes login --web` succeeds and
// every subsequent API call is redirected to a sign-in page.
//
// The fix is to stop gating propanes' /api and /ws at the proxy and let
// propanes enforce access itself: its own bearer auth, plus the IP allowlist
// here. That keeps the restriction versioned in this repo and configurable per
// deployment, instead of hand-edited into someone's nginx.
//
// All three settings default to "no restriction", so an existing deployment
// behaves exactly as before until it opts in.
//
//   PROPANES_ALLOWED_IPS      CSV of IPs/CIDRs permitted to reach the guarded
//                             paths. Unset/empty = allow all.
//   PROPANES_TRUSTED_PROXIES  CSV of IPs/CIDRs whose X-Forwarded-For is
//                             believed. Unset/empty = trust nothing and use the
//                             socket address. NEVER set this to 0.0.0.0/0: any
//                             client could then spoof its own address.
//   PROPANES_GUARDED_PATHS    CSV of path prefixes the allowlist applies to.
//                             Default "/api,/ws".
import type { Context, Next } from 'hono';

type Net = { base: bigint; bits: number; v6: boolean };

/** ::ffff:10.0.0.1 -> 10.0.0.1 . Node reports v4 peers this way on a dual-stack
 *  socket, so without this every v4 rule silently fails to match. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

function toBig(ip: string): { v: bigint; v6: boolean } | null {
  const s = unmap(ip.trim());
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return { v: p.reduce((a, n) => (a << 8n) | BigInt(n), 0n), v6: false };
  }
  if (!s.includes(':')) return null;
  const [head, tail] = s.split('::');
  const hs = head ? head.split(':') : [];
  const ts = tail ? tail.split(':') : [];
  if (hs.length + ts.length > 8) return null;
  const parts = s.includes('::')
    ? [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts]
    : s.split(':');
  if (parts.length !== 8) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^[0-9a-f]{0,4}$/i.test(p)) return null;
    v = (v << 16n) | BigInt(parseInt(p || '0', 16));
  }
  return { v, v6: true };
}

function parseNets(csv: string | undefined, label: string): { nets: Net[]; bad: number } {
  let bad = 0;
  const nets: Net[] = [];
  for (const raw of (csv || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, maskRaw] = raw.split('/');
    const p = toBig(addr);
    if (!p) { bad++; console.error(`[access-control] ${label}: cannot parse ${raw!}`); continue; }
    const full = p.v6 ? 128 : 32;
    const bits = maskRaw === undefined ? full : Number(maskRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > full) {
      bad++; console.error(`[access-control] ${label}: bad prefix length in ${raw}`); continue;
    }
    nets.push({ base: p.v >> BigInt(full - bits), bits, v6: p.v6 });
  }
  return { nets, bad };
}

function inNets(ip: string, nets: Net[]): boolean {
  const p = toBig(ip);
  if (!p) return false;
  const full = p.v6 ? 128 : 32;
  return nets.some((n) => n.v6 === p.v6 && p.v >> BigInt(full - n.bits) === n.base);
}

const ALLOWED = parseNets(process.env.PROPANES_ALLOWED_IPS, 'PROPANES_ALLOWED_IPS');
const TRUSTED = parseNets(process.env.PROPANES_TRUSTED_PROXIES, 'PROPANES_TRUSTED_PROXIES');
const GUARDED = (process.env.PROPANES_GUARDED_PATHS || '/api,/ws')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Fail CLOSED on a misconfigured allowlist. If the operator set the variable
// they intended a restriction; silently serving everything because the value
// did not parse is the worst outcome for a security control.
const BROKEN = ALLOWED.bad > 0 && ALLOWED.nets.length === 0;
if (BROKEN) {
  console.error('[access-control] PROPANES_ALLOWED_IPS was set but nothing parsed — DENYING all guarded requests');
}
export const accessControlEnabled = ALLOWED.nets.length > 0 || BROKEN;

/** The peer address of the TCP connection, i.e. the proxy when behind one. */
function socketAddr(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress || '';
}

/** Resolve the real client. Only consults X-Forwarded-For when the immediate
 *  peer is itself a trusted proxy — otherwise any caller could set the header
 *  and choose its own identity. Walks right-to-left, skipping trusted hops, so
 *  the result is the first address the trusted chain did not vouch for. */
export function clientIp(c: Context): string {
  const peer = unmap(socketAddr(c));
  if (!TRUSTED.nets.length || !inNets(peer, TRUSTED.nets)) return peer;
  const chain = (c.req.header('x-forwarded-for') || '')
    .split(',').map((s) => unmap(s.trim())).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!inNets(chain[i]!, TRUSTED.nets)) return chain[i]!;
  }
  return chain[0] || peer;
}

export async function enforceIpAllowlist(c: Context, next: Next) {
  if (!accessControlEnabled) return next();
  const path = c.req.path;
  if (!GUARDED.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))) {
    return next();
  }
  if (BROKEN) return c.json({ error: 'Forbidden' }, 403);
  const ip = clientIp(c);
  if (!ip || !inNets(ip, ALLOWED.nets)) {
    console.warn(`[access-control] denied ${ip || '<unknown>'} -> ${path}`);
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
}
