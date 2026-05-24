import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-approvals-route-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { app } = await import('../src/app.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('admin approvals route is mounted under /api/v1/admin', async () => {
  const res = await app.request('/api/v1/admin/chief-of-staff/approvals?status=pending');

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { approvals: [] });
});
