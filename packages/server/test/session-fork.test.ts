import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';

const temp = mkdtempSync(join(tmpdir(), 'propanes-session-fork-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
const requests: Record<string, any>[] = [];
const service = createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"nativeForks":true}'); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
});
service.listen(0, '127.0.0.1');
await once(service, 'listening');
process.env.SESSION_SERVICE_URL = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
const { db, schema, sqlite, runMigrations } = await import('../src/db/index.ts');
const { forkAgentSession } = await import('../src/dispatch.ts');
const { registerLauncher, unregisterLauncher } = await import('../src/launcher-registry.ts');
const { app } = await import('../src/app.ts');
const { mintUserToken } = await import('../src/auth.ts');
runMigrations();
const now = new Date().toISOString();
db.insert(schema.orgs).values({ id: 'org', name: 'Org', createdAt: now }).run();
db.insert(schema.users).values({ id: 'owner', orgId: 'org', username: 'owner', passwordHash: 'unused', role: 'member', createdAt: now, updatedAt: now }).run();
test.after(() => { service.close(); service.closeAllConnections(); sqlite.close(); rmSync(temp, { recursive: true, force: true }); });

function parent(id: string, extra: Record<string, any> = {}) {
  db.insert(schema.agentSessions).values({
    id, runtime: 'claude', permissionProfile: 'interactive-yolo', status: 'running', outputBytes: 0,
    claudeSessionId: '11111111-1111-4111-8111-111111111111', cwd: temp,
    ownerUserId: 'owner', orgId: 'org', createdAt: new Date().toISOString(), ...extra,
  }).run();
}

test('forking a live parent preserves its state, permissions, owner and org with an independent native ID', async () => {
  parent('live');
  const before = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, 'live')).get()!;
  const { sessionId } = await forkAgentSession('live', 'alternative approach');
  const child = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get()!;
  assert.deepEqual(db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, 'live')).get(), before);
  assert.equal(child.parentSessionId, 'live');
  assert.equal(child.ownerUserId, before.ownerUserId);
  assert.equal(child.orgId, before.orgId);
  assert.equal(child.permissionProfile, before.permissionProfile);
  assert.notEqual(child.claudeSessionId, before.claudeSessionId);
  assert.equal(child.cosThreadId, null);
  assert.equal(requests.at(-1)!.forkSessionId, before.claudeSessionId);
  assert.equal(requests.at(-1)!.claudeSessionId, child.claudeSessionId);
  assert.equal(requests.at(-1)!.prompt, 'alternative approach');
  assert.equal(requests.at(-1)!.resumeSessionId, undefined);
});

test('remote Codex forks run on the parent machine and resolve its rollout there when needed', async () => {
  const sent: any[] = [];
  registerLauncher({ id: 'remote', name: 'Remote', hostname: 'remote', ws: { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) } as any,
    capabilities: { maxSessions: 5, hasClaudeCli: true, nativeForks: true }, activeSessions: new Set(), connectedAt: 'now', lastHeartbeat: 'now' });
  parent('codex-remote', { runtime: 'codex', launcherId: 'remote', claudeSessionId: null, startedAt: '2026-10-23T00:00:00Z' });
  const { sessionId } = await forkAgentSession('codex-remote', 'branch');
  assert.equal(sent[0].sessionId, sessionId);
  assert.equal(sent[0].forkSessionId, '');
  assert.equal(sent[0].forkStartedAt, '2026-10-23T00:00:00Z');
  assert.equal(sent[0].runtime, 'codex');
  assert.equal(sent[0].resumeSessionId, undefined);
  unregisterLauncher('remote');
});

test('missing native context, shell terminals, offline machines and older launchers fail before creating a row', async () => {
  parent('no-context', { claudeSessionId: null });
  parent('shell', { permissionProfile: 'plain' });
  parent('sprite', { spriteConfigId: 'sprite' });
  parent('offline', { launcherId: 'offline' });
  registerLauncher({ id: 'old', name: 'Old', hostname: 'old', ws: { readyState: 1 } as any,
    capabilities: { maxSessions: 5, hasClaudeCli: true }, activeSessions: new Set(), connectedAt: 'now', lastHeartbeat: 'now' });
  parent('old', { launcherId: 'old' });
  const before = db.select().from(schema.agentSessions).all().length;
  for (const id of ['no-context', 'shell', 'sprite', 'offline', 'old']) await assert.rejects(forkAgentSession(id));
  assert.equal(db.select().from(schema.agentSessions).all().length, before);
  unregisterLauncher('old');
});

test('fork endpoint requires authentication and rejects malformed prompts before dispatch', async () => {
  const path = '/api/v1/admin/agent-sessions/live/fork';
  assert.equal((await app.request(path, { method: 'POST' })).status, 401);
  const token = await mintUserToken({ id: 'env-admin', username: 'admin', role: 'admin' });
  const res = await app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"additionalPrompt":42}' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must be a string/);
  db.insert(schema.users).values({ id: 'outsider', username: 'outsider', passwordHash: 'unused', role: 'member', createdAt: now, updatedAt: now }).run();
  const outsider = await mintUserToken({ id: 'outsider', username: 'outsider', role: 'member', orgId: 'another-org' });
  assert.equal((await app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${outsider}` } })).status, 404);
});
