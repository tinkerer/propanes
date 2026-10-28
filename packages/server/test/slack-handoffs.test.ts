import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-slack-handoffs-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { slackHandoffRoutes } = await import('../src/routes/slack-handoffs.ts');
const { claimSlackHandoffs, resetSlackHandoffs, LISTENER_STALE_MS } = await import('../src/slack-handoffs.ts');

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function appAs(user: { id: string; role: 'admin' | 'member'; orgId: string | null }) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user' as never, user as never); await next(); });
  app.route('/', slackHandoffRoutes);
  return app;
}
const admin = appAs({ id: 'env-admin', role: 'admin', orgId: null });
const orgAdmin = appAs({ id: 'org-admin', role: 'admin', orgId: 'org-1' });

async function call(app: Hono, path: string, body?: unknown) {
  const res = await app.request(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

function insertSession(id: string, permissionProfile = 'interactive-yolo', status = 'running') {
  sqlite.prepare(`INSERT INTO agent_sessions (id, runtime, permission_profile, status, output_bytes, created_at)
    VALUES (?, 'claude', ?, ?, 0, ?)`).run(id, permissionProfile, status, new Date().toISOString());
}

test('a handoff is queued, claimed once by the listener and reports its outcome', async () => {
  runMigrations();
  resetSlackHandoffs();
  insertSession('s1');

  // No listener has polled yet: the request is refused instead of waiting forever.
  assert.equal((await call(admin, '/', { sessionId: 's1' })).status, 503);

  assert.deepEqual((await call(admin, '/claim', {})).body, { handoffs: [] });
  const queued = await call(admin, '/', { sessionId: 's1' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, 'queued');
  // A second click while it is pending reuses the request.
  assert.equal((await call(admin, '/', { sessionId: 's1' })).body.id, queued.body.id);

  const claimed = await call(admin, '/claim', {});
  assert.deepEqual(claimed.body.handoffs.map((h: any) => h.sessionId), ['s1']);
  assert.deepEqual((await call(admin, '/claim', {})).body.handoffs, []);

  const done = await call(admin, `/${queued.body.id}/result`, { ok: true, permalink: 'https://slack.example.test/archives/C1/p1', message: 'Moved' });
  assert.equal(done.body.status, 'done');
  const polled = await call(admin, `/${queued.body.id}`);
  assert.equal(polled.body.status, 'done');
  assert.equal(polled.body.permalink, 'https://slack.example.test/archives/C1/p1');

  const bad = await call(admin, `/${queued.body.id}/result`, { ok: false, permalink: 'javascript:alert(1)' });
  assert.equal(bad.body.permalink, null);
  assert.equal(bad.body.status, 'failed');
});

test('only the global operator may hand off, and terminals or unknown sessions are refused', async () => {
  runMigrations();
  resetSlackHandoffs();
  insertSession('s2');
  insertSession('t1', 'plain');
  claimSlackHandoffs();
  assert.equal((await call(orgAdmin, '/', { sessionId: 's2' })).status, 403);
  assert.equal((await call(orgAdmin, '/claim', {})).status, 403);
  assert.equal((await call(admin, '/', { sessionId: 't1' })).status, 400);
  assert.equal((await call(admin, '/', { sessionId: 'missing' })).status, 404);
  assert.equal((await call(admin, '/', {})).status, 400);
});

test('the listener counts as disconnected once its polls stop', async () => {
  resetSlackHandoffs();
  const { slackListenerConnected } = await import('../src/slack-handoffs.ts');
  claimSlackHandoffs(1_000);
  assert.equal(slackListenerConnected(1_000 + LISTENER_STALE_MS), true);
  assert.equal(slackListenerConnected(1_000 + LISTENER_STALE_MS + 1), false);
});

test('a Slack-linked member hands off only their own sessions and follows only their own requests', async () => {
  resetSlackHandoffs();
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, role, status, slack_user_id, created_at, updated_at)
    VALUES ('m1', 'alice', 'x', 'member', 'active', 'UALICE', ?, ?), ('m2', 'bob', 'x', 'member', 'active', NULL, ?, ?)`).run(now, now, now, now);
  insertSession('mine');
  insertSession('theirs');
  sqlite.prepare(`UPDATE agent_sessions SET owner_user_id = 'm1' WHERE id = 'mine'`).run();
  sqlite.prepare(`UPDATE agent_sessions SET owner_user_id = 'm2' WHERE id = 'theirs'`).run();
  const alice = appAs({ id: 'm1', role: 'member', orgId: null });
  const bob = appAs({ id: 'm2', role: 'member', orgId: null });
  await call(admin, '/claim', {}); // the listener is alive

  assert.equal((await call(bob, '/', { sessionId: 'theirs' })).status, 403, 'not linked to Slack');
  assert.equal((await call(alice, '/', { sessionId: 'theirs' })).status, 404, "someone else's session");
  const queued = await call(alice, '/', { sessionId: 'mine' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.requestedBy, 'm1');

  assert.equal((await call(alice, '/claim', {})).status, 403, 'only the operator drains the queue');
  const [claimed] = (await call(admin, '/claim', {})).body.handoffs;
  assert.equal(claimed.requestedBy, 'm1');

  // The bot reports with alice's token; bob can neither report nor read it.
  assert.equal((await call(bob, `/${queued.body.id}/result`, { ok: true, message: 'x' })).status, 403);
  assert.equal((await call(alice, `/${queued.body.id}/result`, { ok: true, message: 'Moved' })).status, 200);
  assert.equal((await call(bob, `/${queued.body.id}`)).status, 404);
  assert.equal((await call(alice, `/${queued.body.id}`)).body.status, 'done');
});
