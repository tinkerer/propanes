import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-admin-app-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { runMigrations, sqlite, db, schema } = await import('../src/db/index.ts');
const { isAdminApp, pickAdminApp, resolveAdminApp } = await import('../src/admin-app.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const workbench = { id: 'wb', name: 'Workbench', apiKey: 'pw_EGMXr', projectDir: '/data/workspaces/workbench' };
const admin = { id: 'pp', name: 'ProPanes Admin', apiKey: 'pw_VYnZn', projectDir: '/data/workspaces/propanes' };

test('isAdminApp matches the admin row regardless of name casing or where the server runs', () => {
  assert.equal(isAdminApp({ name: 'ProPanes Admin', projectDir: '/srv/x' }), true);
  assert.equal(isAdminApp({ name: 'Propanes Admin', projectDir: '/srv/x' }), true);
  assert.equal(isAdminApp({ name: 'propanes', projectDir: '/srv/x' }), true);
  assert.equal(isAdminApp({ name: 'My App', projectDir: '/data/workspaces/propanes/' }), true);
  assert.equal(isAdminApp({ name: 'My App', projectDir: resolve(process.cwd(), '..', '..') }), true);
  assert.equal(isAdminApp({ name: 'Workbench', projectDir: '/data/workspaces/workbench' }), false);
  assert.equal(isAdminApp({ name: 'Propanes Docs', projectDir: '/data/workspaces/propanes-docs' }), false);
});

test('pickAdminApp never guesses among several applications', () => {
  assert.equal(pickAdminApp([workbench, admin])?.id, 'pp');
  assert.equal(pickAdminApp([admin, workbench])?.id, 'pp');
  assert.equal(pickAdminApp([workbench, { ...workbench, id: 'other', name: 'Other' }]), null);
  // A single-app install has nothing else the feedback could belong to.
  assert.equal(pickAdminApp([workbench])?.id, 'wb');
  assert.equal(pickAdminApp([]), null);
});

test('resolveAdminApp returns the ProPanes Admin key, not whichever row the index yields first', () => {
  const now = new Date().toISOString();
  // Insert the admin app after Workbench and with the lexically larger key so
  // neither rowid order nor an api_key index scan would pick it by accident.
  for (const app of [workbench, admin]) {
    db.insert(schema.applications).values({ ...app, createdAt: now, updatedAt: now } as any).run();
  }
  assert.deepEqual(resolveAdminApp(), { id: 'pp', apiKey: 'pw_VYnZn' });
});
