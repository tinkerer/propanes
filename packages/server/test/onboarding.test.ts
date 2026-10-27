import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-onboarding-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { onboardUser, parseOnboardPlan, pinnedLauncherFor, OnboardError } = await import('../src/onboarding.ts');
const { userRoutes } = await import('../src/routes/admin/users.ts');
const { mintUserToken, verifyToken } = await import('../src/auth.ts');
const { dispatchAgentSession } = await import('../src/dispatch.ts');

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const now = new Date().toISOString();

function seed() {
  runMigrations();
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
    VALUES ('u1', 'alice', 'x', 'member', 'active', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO applications (id, name, api_key, project_dir, sub_apps, hooks, description, server_url, created_at, updated_at)
    VALUES ('src1', 'Storefront', 'pw_src', '/home/admin/storefront', ?, ?, 'The product', 'http://localhost:5173', ?, ?)`)
    .run(JSON.stringify([{ name: 'web', dir: 'web' }]), JSON.stringify([{ cmd: 'rm -rf /' }]), now, now);
}

test('onboardUser creates owned apps, preset agents, machine and pin — idempotently', () => {
  seed();
  const plan = parseOnboardPlan({
    apps: [{ fromAppId: 'src1', projectDir: '/home/pp-alice/storefront' }],
    launcherId: 'vm-alice',
    machine: { name: 'alice @ vm', hostname: 'vm' },
  });
  const first = onboardUser('u1', plan);
  assert.equal(first.launcherId, 'vm-alice');
  assert.equal(first.machine?.created, true);
  assert.equal(first.apps.length, 1);
  assert.equal(first.apps[0].created, true);
  assert.equal(first.agents.length, 4);

  const app = sqlite.prepare('SELECT * FROM applications WHERE id = ?').get(first.apps[0].id) as any;
  assert.equal(app.owner_user_id, 'u1');
  assert.equal(app.name, 'Storefront');
  assert.equal(app.project_dir, '/home/pp-alice/storefront');
  assert.equal(app.description, 'The product');
  assert.equal(app.hooks, '[]', 'server-side hooks are never copied to a member');
  assert.equal(app.sub_apps, JSON.stringify([{ name: 'web', dir: 'web' }]));
  assert.notEqual(app.api_key, 'pw_src');

  const agents = sqlite.prepare('SELECT * FROM agent_endpoints WHERE app_id = ? ORDER BY name').all(app.id) as any[];
  assert.deepEqual(agents.map((a) => [a.name, a.runtime, a.permission_profile, a.mode]), [
    ['Claude', 'claude', 'interactive-require', 'interactive'],
    ['Claude YOLO', 'claude', 'interactive-yolo', 'interactive'],
    ['Codex', 'codex', 'interactive-require', 'interactive'],
    ['Codex YOLO', 'codex', 'interactive-yolo', 'interactive'],
  ]);
  assert.deepEqual(agents.filter((a) => a.is_default).map((a) => a.name), ['Claude']);

  const again = onboardUser('u1', plan);
  assert.equal(again.apps[0].id, first.apps[0].id);
  assert.equal(again.apps[0].created, false);
  assert.ok(again.agents.every((a) => !a.created));
  assert.equal(again.machine?.id, first.machine?.id);
  assert.equal((sqlite.prepare('SELECT count(*) n FROM applications').get() as any).n, 2);
  assert.equal((sqlite.prepare('SELECT count(*) n FROM agent_endpoints WHERE app_id IS NOT NULL').get() as any).n, 4);
});

test('parseOnboardPlan rejects bad input before anything is written', () => {
  assert.throws(() => parseOnboardPlan({ apps: [{ fromAppId: 'x', projectDir: 'relative' }] }), OnboardError);
  assert.throws(() => parseOnboardPlan({ apps: [{ projectDir: '/a' }] }), OnboardError);
  assert.throws(() => parseOnboardPlan({ apps: [], agents: ['bogus'] }), OnboardError);
  assert.throws(() => onboardUser('u1', parseOnboardPlan({ apps: [{ fromAppId: 'missing', projectDir: '/a' }] })), /not found/);
});

test('pinnedLauncherFor pins members only', () => {
  assert.equal(pinnedLauncherFor('u1'), 'vm-alice');
  assert.equal(pinnedLauncherFor('env-admin'), null);
  assert.equal(pinnedLauncherFor(null), null);
  sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = 'u1'").run();
  assert.equal(pinnedLauncherFor('u1'), null);
  sqlite.prepare("UPDATE users SET role = 'member' WHERE id = 'u1'").run();
});

test('dispatch for a pinned member refuses to fall back to a local run', async () => {
  const agent = sqlite.prepare("SELECT id FROM agent_endpoints WHERE name = 'Claude'").get() as any;
  await assert.rejects(
    dispatchAgentSession({
      agentEndpointId: agent.id,
      prompt: 'hi',
      cwd: '/home/pp-alice/storefront',
      permissionProfile: 'interactive-require',
      ownerUserId: 'u1',
    }),
    /vm-alice .*not connected/,
  );
  assert.equal((sqlite.prepare('SELECT count(*) n FROM agent_sessions').get() as any).n, 0);
});

test('onboard route is admin-only and mints a member-scoped token on request', async () => {
  const admin = await mintUserToken({ id: 'env-admin', username: 'admin', role: 'admin', orgId: null });
  const member = await mintUserToken({ id: 'u1', username: 'alice', role: 'member', orgId: null });
  const call = (token: string, body: unknown) => userRoutes.request('/users/u1/onboard', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal((await call(member, { apps: [] })).status, 403);
  assert.equal((await call(admin, { apps: [{ projectDir: 'nope', name: 'x' }] })).status, 400);

  const res = await call(admin, { apps: [], mintToken: true });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  const payload = await verifyToken(body.token);
  assert.equal(payload?.sub, 'u1');
  assert.equal(payload?.role, 'member');

  const info = await userRoutes.request('/users/u1/onboarding', { headers: { Authorization: `Bearer ${admin}` } });
  const data = await info.json() as any;
  assert.deepEqual(data.suggestions.map((a: any) => a.name), ['Storefront']);
  assert.deepEqual(data.owned.map((a: any) => a.projectDir), ['/home/pp-alice/storefront']);
});

test('reset-onboarding removes the member workspace and unpins, leaving others alone', async () => {
  const admin = await mintUserToken({ id: 'env-admin', username: 'admin', role: 'admin', orgId: null });
  const before = sqlite.prepare("SELECT count(*) n FROM agent_endpoints WHERE app_id IS NULL").get() as any;
  const res = await userRoutes.request('/users/u1/reset-onboarding', {
    method: 'POST', headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual(body.apps.map((a: any) => a.name), ['Storefront']);
  assert.equal(body.agentsRemoved, 4);
  assert.equal(body.machineRemoved, true);
  assert.equal(body.launcherCleared, 'vm-alice');

  assert.equal((sqlite.prepare("SELECT count(*) n FROM applications WHERE owner_user_id = 'u1'").get() as any).n, 0);
  assert.ok(sqlite.prepare("SELECT id FROM applications WHERE id = 'src1'").get(), 'suggested source app survives');
  assert.equal((sqlite.prepare("SELECT count(*) n FROM agent_endpoints WHERE app_id IS NULL").get() as any).n, before.n,
    'member agents are deleted, not orphaned into global ones');
  assert.equal((sqlite.prepare('SELECT count(*) n FROM machines').get() as any).n, 0);
  assert.equal(pinnedLauncherFor('u1'), null);

  // Onboarding again starts from scratch.
  const again = onboardUser('u1', parseOnboardPlan({ apps: [{ fromAppId: 'src1', projectDir: '/home/pp-alice/storefront' }] }));
  assert.equal(again.apps[0].created, true);
});
