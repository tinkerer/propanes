import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-admin-root-route-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { app } = await import('../src/app.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('service root serves the SPA shell (no longer redirects to /admin)', async () => {
  // Per-user workspaces: the root serves the app shell directly (which shows
  // login, then sends the operator to their own /<username> path) instead of
  // hard-redirecting everyone to /admin.
  const res = await app.request('/');
  // 200 when the built admin/dist/index.html is present, 500 with a build hint
  // when it isn't (unit env) — either way it is NOT a 302 to /admin.
  assert.notEqual(res.status, 302);
  assert.ok(res.status === 200 || res.status === 500, `unexpected status ${res.status}`);
});

test('per-user path /:username serves the SPA shell, reserved paths do not', async () => {
  const userRes = await app.request('/maksym');
  assert.notEqual(userRes.status, 404); // served by the per-user shell handler
  // Reserved top-level segments must not be swallowed by the per-user route.
  const apiRes = await app.request('/api/v1/health');
  assert.equal(apiRes.status, 200);
});
