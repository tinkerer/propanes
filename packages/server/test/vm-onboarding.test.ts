import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-vm-onboard-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.JWT_SECRET ||= 'test-secret';

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { getVmOnboardJob, isVmOnboarding, startVmOnboarding } = await import('../src/vm-onboarding.ts');
const { userRoutes } = await import('../src/routes/admin/users.ts');
const { mintUserToken } = await import('../src/auth.ts');

runMigrations();

test.after(() => {
  delete process.env.PROPANES_VM_ONBOARD_SCRIPT;
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const spawn = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts.env });
    return child;
  }) as never;
  return { calls, child, spawn };
}

test('runs the script non-interactively under sudo, passing the token by environment', () => {
  process.env.PROPANES_VM_ONBOARD_SCRIPT = '/srv/onboard-user.sh';
  const { calls, child, spawn } = fakeSpawn();
  startVmOnboarding({ userId: 'job-1', username: 'carol', appIds: ['a1', 'a2'], adminToken: 'tok' }, spawn);
  assert.equal(calls[0].cmd, 'sudo');
  assert.equal(calls[0].args[0], '-n');
  assert.deepEqual(calls[0].args.slice(2), ['/srv/onboard-user.sh', '--user', 'carol', '--app', 'a1', '--app', 'a2']);
  assert.ok(!calls[0].args.includes('tok'), 'the token never reaches the command line');
  assert.equal(calls[0].env.PROPANES_TOKEN, 'tok');
  assert.equal(isVmOnboarding('job-1'), true);
  assert.throws(() => startVmOnboarding({ userId: 'job-1', username: 'carol', appIds: ['a1'], adminToken: 'tok' }, spawn), /already running/);

  child.stdout.emit('data', Buffer.from('==> Done.\n'));
  child.emit('close', 0);
  assert.equal(getVmOnboardJob('job-1')?.status, 'succeeded');
  assert.match(getVmOnboardJob('job-1')!.log, /Done/);
  assert.equal(isVmOnboarding('job-1'), false);
});

test('a failing or unstartable script is reported, with the reason in the log', () => {
  process.env.PROPANES_VM_ONBOARD_SCRIPT = '/srv/onboard-user.sh';
  const a = fakeSpawn();
  startVmOnboarding({ userId: 'job-2', username: 'carol', appIds: ['a1'], adminToken: 'tok' }, a.spawn);
  a.child.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
  a.child.emit('close', 1);
  assert.equal(getVmOnboardJob('job-2')?.status, 'failed');
  assert.match(getVmOnboardJob('job-2')!.log, /password is required[\s\S]*code 1/);

  const b = fakeSpawn();
  startVmOnboarding({ userId: 'job-3', username: 'carol', appIds: ['a1'], adminToken: 'tok' }, b.spawn);
  b.child.emit('error', new Error('ENOENT'));
  assert.equal(getVmOnboardJob('job-3')?.status, 'failed');
});

// These all stop before anything is spawned.
test('POST /users/:id/onboard-vm is opt-in, operator-only and validates its input', async () => {
  const now = new Date().toISOString();
  const addUser = sqlite.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, ?)`);
  addUser.run('m1', 'carol', 'member', now, now);
  addUser.run('m2', 'Not A Linux Name', 'member', now, now);
  addUser.run('a1', 'root-admin', 'admin', now, now);
  sqlite.prepare(`INSERT INTO applications (id, name, api_key, project_dir, created_at, updated_at) VALUES ('app1', 'App', 'pw_x', '/srv/app', ?, ?)`).run(now, now);
  const op = await mintUserToken({ id: 'a1', username: 'root-admin', role: 'admin', orgId: null });
  const member = await mintUserToken({ id: 'm1', username: 'carol', role: 'member', orgId: null });
  const orgAdmin = await mintUserToken({ id: 'a2', username: 'org-admin', role: 'admin', orgId: 'org1' });
  const post = (id: string, token: string, apps: unknown) => userRoutes.request(`/users/${id}/onboard-vm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apps }),
  });

  delete process.env.PROPANES_VM_ONBOARD_SCRIPT;
  assert.equal((await post('m1', op, ['app1'])).status, 400, 'off unless the deployment opts in');

  process.env.PROPANES_VM_ONBOARD_SCRIPT = '/srv/onboard-user.sh';
  assert.equal((await post('m1', member, ['app1'])).status, 403);
  assert.equal((await post('m1', orgAdmin, ['app1'])).status, 403, 'org admins cannot run a root script');
  assert.equal((await post('nope', op, ['app1'])).status, 404);
  assert.equal((await post('a1', op, ['app1'])).status, 400, 'admins get no machine account');
  assert.equal((await post('m2', op, ['app1'])).status, 400, 'username must be a valid Linux name');
  assert.equal((await post('m1', op, [])).status, 400, 'an app is required');
  assert.equal((await post('m1', op, ['app1; rm -rf /'])).status, 400, 'only known app ids');
});
