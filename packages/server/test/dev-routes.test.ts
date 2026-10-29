import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-dev-routes-'));
process.env.DB_PATH = join(tempDir, 'test.db');
const hookLog = join(tempDir, 'hook.log');
const hook = join(tempDir, 'hook.sh');
writeFileSync(hook, `#!/bin/sh\necho "$@" >> ${hookLog}\n`);
chmodSync(hook, 0o755);
process.env.DEV_ROUTE_DOMAIN = 'dev.example.test';
process.env.DEV_ROUTE_PREFIX = 'vm';
process.env.DEV_ROUTE_HOOK = hook;
process.env.DEV_ROUTE_PORTS = '47100-47199';

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { devRouteRoutes } = await import('../src/routes/admin/dev-routes.ts');
const { proxyDevRequest, proxyDevUpgrade } = await import('../src/dev-routes.ts');
const { requireAdminAuth } = await import('../src/admin-auth.ts');
const { mintUserToken } = await import('../src/auth.ts');
const { Hono } = await import('hono');

runMigrations();
const now = new Date().toISOString();
sqlite.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
  VALUES ('u1', 'alice', 'x', 'member', 'active', ?, ?), ('u2', 'bob', 'x', 'member', 'active', ?, ?)`).run(now, now, now, now);
sqlite.prepare(`INSERT INTO applications (id, name, api_key, project_dir, owner_user_id, created_at, updated_at)
  VALUES ('a1', 'Store Front', 'k1', '/home/pp-alice/storefront', 'u1', ?, ?)`).run(now, now);

const api = new Hono();
api.use('*', requireAdminAuth);
api.route('/', devRouteRoutes);
const alice = await mintUserToken({ id: 'u1', username: 'alice', role: 'member', orgId: null });
const bob = await mintUserToken({ id: 'u2', username: 'bob', role: 'member', orgId: null });
const call = (token: string, method: string, path: string, body?: unknown) => api.request(path, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

let route: any;

test('reserving a dev URL allocates a port and hostname, publishes it once, and is idempotent', async () => {
  const res = await call(alice, 'POST', '/dev-routes', { appId: 'a1' });
  assert.equal(res.status, 201);
  route = (await res.json() as any).route;
  assert.equal(route.host, 'vm-alice-store-front.dev.example.test');
  assert.equal(route.url, 'https://vm-alice-store-front.dev.example.test');
  assert.ok(route.port >= 47100 && route.port <= 47199);
  assert.equal(route.status, 'published');
  assert.equal(route.listening, false);
  assert.equal(readFileSync(hookLog, 'utf8').trim(), `publish vm-alice-store-front vm-alice-store-front.dev.example.test ${route.port}`);

  const again = await call(alice, 'POST', '/dev-routes', { appId: 'a1' });
  assert.equal(again.status, 200);
  assert.equal((await again.json() as any).route.id, route.id);

  assert.equal((await call(bob, 'POST', '/dev-routes', { appId: 'a1' })).status, 404, "bob cannot reserve on alice's app");
  const bobs = await (await call(bob, 'POST', '/dev-routes', { name: 'scratch' })).json() as any;
  assert.notEqual(bobs.route.port, route.port);
  assert.deepEqual(((await (await call(bob, 'GET', '/dev-routes')).json()) as any).routes.map((r: any) => r.name), ['scratch'], 'each user lists only their own');
});

test('requests and WebSocket upgrades for the hostname reach the dev server', async () => {
  const seen: Record<string, string | undefined>[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, xfh: req.headers['x-forwarded-host'] as string });
    res.writeHead(200, { 'content-type': 'text/plain', 'x-dev': 'yes' });
    res.end(`dev ${req.method} ${req.url}`);
  });
  const upWss = new WebSocketServer({ server: upstream });
  upWss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  await new Promise<void>((r) => upstream.listen(route.port, '127.0.0.1', () => r()));

  const front = http.createServer((req, res) => { if (!proxyDevRequest(req, res)) { res.writeHead(404); res.end('api'); } });
  front.on('upgrade', (req, socket, head) => { if (!proxyDevUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
  const frontPort = (front.address() as AddressInfo).port;

  try {
    const get = (host: string) => fetch(`http://127.0.0.1:${frontPort}/src/main.ts?v=1`, { headers: { 'x-forwarded-host': host } });
    const hit = await get(route.host);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('x-dev'), 'yes');
    assert.equal(await hit.text(), 'dev GET /src/main.ts?v=1');
    assert.deepEqual(seen[0], { host: `localhost:${route.port}`, xfh: route.host }, 'dev servers see localhost and the public host');
    assert.equal(await (await get('other.dev.example.test')).text(), 'api', 'unknown hosts fall through to the API');

    const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/hmr`, { headers: { 'x-forwarded-host': route.host } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once('open', () => ws.send('ping'));
      ws.once('message', (m) => resolve(String(m)));
      ws.once('error', reject);
    });
    ws.close();
    assert.equal(reply, 'echo:ping');
  } finally {
    upWss.close();
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => front.close(r));
  }

  const down = http.createServer((req, res) => { if (!proxyDevRequest(req, res)) res.end(); });
  await new Promise<void>((r) => down.listen(0, '127.0.0.1', () => r()));
  const res = await fetch(`http://127.0.0.1:${(down.address() as AddressInfo).port}/`, { headers: { 'x-forwarded-host': route.host } });
  assert.equal(res.status, 502, 'a stopped dev server is a clear 502');
  await new Promise((r) => down.close(r));
});

test('deleting a dev URL unpublishes it and stops proxying', async () => {
  assert.equal((await call(bob, 'DELETE', `/dev-routes/${route.id}`)).status, 404);
  assert.equal((await call(alice, 'DELETE', `/dev-routes/${route.id}`)).status, 200);
  assert.match(readFileSync(hookLog, 'utf8'), /unpublish vm-alice-store-front /);
  const front = http.createServer((req, res) => { if (!proxyDevRequest(req, res)) res.end('api'); });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
  const res = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/`, { headers: { 'x-forwarded-host': route.host } });
  assert.equal(await res.text(), 'api');
  await new Promise((r) => front.close(r));
});
