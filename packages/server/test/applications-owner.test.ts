import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-app-owner-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { applicationRoutes } = await import('../src/routes/applications.ts');

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function appAs(user: { id: string; role: string; orgId: string | null }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, user as never);
    await next();
  });
  app.route('/', applicationRoutes);
  return app;
}

test('GET / tags apps owned by another user with that user\'s name', async () => {
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1', 'alice', 'x', 'member', ?, ?)`).run(now, now);
  const insert = sqlite.prepare(`
    INSERT INTO applications (id, name, api_key, project_dir, owner_user_id, created_at, updated_at)
    VALUES (?, 'My App', ?, ?, ?, ?, ?)
  `);
  insert.run('legacy', 'pw_a', '/srv/my-app', null, now, now);
  insert.run('mine', 'pw_b', '/srv/my-app-2', 'env-admin', now, now);
  insert.run('member', 'pw_c', '/home/alice/my-app', 'u1', now, now);

  const asAdmin = await (await appAs({ id: 'env-admin', role: 'admin', orgId: null }).request('/')).json() as any[];
  const owners = Object.fromEntries(asAdmin.map((a) => [a.id, a.ownerName]));
  assert.deepEqual(owners, { legacy: null, mine: null, member: 'alice' });

  // The member sees their own copy as theirs, untagged.
  const asMember = await (await appAs({ id: 'u1', role: 'member', orgId: null }).request('/')).json() as any[];
  assert.deepEqual(asMember.map((a) => [a.id, a.ownerName]), [['member', null]]);
});
