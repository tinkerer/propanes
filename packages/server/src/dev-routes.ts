/** Public URLs for dev servers: each one gets a reserved local port and a
 * hostname under DEV_ROUTE_DOMAIN. This server proxies requests (and
 * WebSocket upgrades, for HMR) by hostname to that port, so one front port —
 * the one the edge already reaches — serves every member's dev setups.
 *
 * Hostnames are matched against X-Forwarded-Host first: edge gateways commonly
 * rewrite Host to the backend address. The edge is expected to gate access to
 * the hostname; this proxy adds no auth of its own (anything on this machine
 * could reach the port directly anyway).
 *
 * Publishing a new hostname at the edge is deployment-specific, so it is a
 * hook: DEV_ROUTE_HOOK runs as `<hook> publish|unpublish <subdomain> <host>
 * <port>`; without one, routes are local-only until published by hand. */
import { execFile } from 'node:child_process';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from './db/index.js';

export type DevRoute = typeof schema.devRoutes.$inferSelect;

export interface DevRouteConfig {
  /** Parent domain for dev hostnames; unset = feature off. */
  domain: string | null;
  /** Optional leading label part, e.g. a machine name: `<prefix>-<user>-<name>`. */
  prefix: string;
  portMin: number;
  portMax: number;
  hook: string | null;
}

export function devRouteConfig(env: NodeJS.ProcessEnv = process.env): DevRouteConfig {
  const [min, max] = (env.DEV_ROUTE_PORTS || '4100-4999').split('-').map((n) => parseInt(n, 10));
  return {
    domain: (env.DEV_ROUTE_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '') || null,
    prefix: slug(env.DEV_ROUTE_PREFIX || ''),
    portMin: Number.isFinite(min) ? min : 4100,
    portMax: Number.isFinite(max) ? max : 4999,
    hook: env.DEV_ROUTE_HOOK || null,
  };
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `<prefix>-<user>-<name>`, a single DNS label (≤ 63) so one wildcard record covers it. */
export function subdomainFor(cfg: DevRouteConfig, username: string, name: string): string {
  const label = [cfg.prefix, slug(username), slug(name)].filter(Boolean).join('-');
  return label.slice(0, 63).replace(/-+$/, '') || 'dev';
}

// --- Host → port lookup (hot path: every request) ---------------------------

let byHost: Map<string, number> | null = null;
export function invalidateDevRoutes(): void { byHost = null; }

function routeTable(): Map<string, number> {
  if (!byHost) {
    byHost = new Map(db.select().from(schema.devRoutes).all().map((r) => [r.host, r.port]));
  }
  return byHost;
}

function requestHost(req: IncomingMessage): string {
  const raw = req.headers['x-forwarded-host'] ?? req.headers.host ?? '';
  const first = (Array.isArray(raw) ? raw[0] : raw).split(',')[0].trim().toLowerCase();
  return first.replace(/:\d+$/, '');
}

export function devRoutePort(req: IncomingMessage): number | undefined {
  const host = requestHost(req);
  return host ? routeTable().get(host) : undefined;
}

function upstreamHeaders(req: IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const publicHost = requestHost(req);
  // Dev servers check Host (e.g. Vite's allowedHosts); they always accept localhost.
  return {
    ...req.headers,
    host: `localhost:${port}`,
    'x-forwarded-host': publicHost,
    'x-forwarded-proto': (req.headers['x-forwarded-proto'] as string) || 'https',
  };
}

/** Proxy an HTTP request for a dev hostname; false = not a dev hostname. */
export function proxyDevRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const port = devRoutePort(req);
  if (port === undefined) return false;
  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req, port) }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.rawHeaders as unknown as http.OutgoingHttpHeaders);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Nothing is listening on port ${port} for this dev URL yet. Start the dev server on that port.\n`);
  });
  req.pipe(upstream);
  return true;
}

/** Proxy a WebSocket upgrade for a dev hostname; false = not a dev hostname. */
export function proxyDevUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const port = devRoutePort(req);
  if (port === undefined) return false;
  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req, port) });
  upstream.on('upgrade', (up, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on('response', (up) => {
    // The dev server refused the upgrade; relay its answer.
    const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage ?? ''}`];
    for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    up.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
  return true;
}

// --- Allocation -------------------------------------------------------------

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function allocatePort(cfg: DevRouteConfig): Promise<number> {
  const taken = new Set(db.select({ port: schema.devRoutes.port }).from(schema.devRoutes).all().map((r) => r.port));
  for (let port = cfg.portMin; port <= cfg.portMax; port++) {
    if (!taken.has(port) && await portFree(port)) return port;
  }
  throw new Error(`No free dev port in ${cfg.portMin}-${cfg.portMax}`);
}

export async function createDevRoute(cfg: DevRouteConfig, input: { ownerUserId: string; username: string; name: string; appId: string | null }): Promise<{ route: DevRoute; created: boolean }> {
  if (!cfg.domain) throw new Error('Dev URLs are not configured on this server (DEV_ROUTE_DOMAIN is unset)');
  const name = slug(input.name);
  if (!name) throw new Error('name must contain letters or digits');
  const existing = db.select().from(schema.devRoutes).all()
    .find((r) => r.ownerUserId === input.ownerUserId && r.name === name);
  if (existing) return { route: existing, created: false };
  const base = subdomainFor(cfg, input.username, name);
  const hosts = new Set(db.select({ host: schema.devRoutes.host }).from(schema.devRoutes).all().map((r) => r.host));
  let subdomain = base;
  for (let n = 2; hosts.has(`${subdomain}.${cfg.domain}`); n++) subdomain = `${base.slice(0, 60)}-${n}`;
  const port = await allocatePort(cfg);
  const now = new Date().toISOString();
  const route: DevRoute = {
    id: ulid(), ownerUserId: input.ownerUserId, appId: input.appId, name, subdomain,
    host: `${subdomain}.${cfg.domain}`, port,
    status: cfg.hook ? 'pending' : 'local', error: null, createdAt: now, updatedAt: now,
  };
  db.insert(schema.devRoutes).values(route).run();
  invalidateDevRoutes();
  if (cfg.hook) {
    const result = await runHook(cfg.hook, ['publish', route.subdomain, route.host, String(route.port)]);
    setStatus(route.id, result.ok ? 'published' : 'failed', result.ok ? null : result.error);
    route.status = result.ok ? 'published' : 'failed';
    route.error = result.ok ? null : result.error;
  }
  return { route, created: true };
}

export async function deleteDevRoute(cfg: DevRouteConfig, route: DevRoute): Promise<void> {
  db.delete(schema.devRoutes).where(eq(schema.devRoutes.id, route.id)).run();
  invalidateDevRoutes();
  if (cfg.hook && route.status === 'published') {
    await runHook(cfg.hook, ['unpublish', route.subdomain, route.host, String(route.port)]);
  }
}

function setStatus(id: string, status: string, error: string | null): void {
  db.update(schema.devRoutes).set({ status, error, updatedAt: new Date().toISOString() }).where(eq(schema.devRoutes.id, id)).run();
}

function runHook(hook: string, args: string[]): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    execFile(hook, args, { timeout: 120_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true, error: null });
      const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 500);
      resolve({ ok: false, error: detail || 'publish hook failed' });
    });
  });
}

/** Whether a dev server is listening on the route's port right now. */
export function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
