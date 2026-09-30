import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-agent-env-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
delete process.env.PROPANES_TOKEN;
delete process.env.PROPANES_API_URL;
process.env.PORT = '3999';

const { db, schema, runMigrations, sqlite } = await import('../src/db/index.ts');
const { sessionAgentEnv } = await import('../src/session-agent-env.ts');
const { verifyToken } = await import('../src/auth.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedSession(id: string, ownerUserId: string | null) {
  db.insert(schema.agentSessions).values({
    id,
    runtime: 'claude',
    permissionProfile: 'interactive-yolo',
    status: 'pending',
    outputBytes: 0,
    ownerUserId,
    createdAt: new Date().toISOString(),
  }).run();
}

test('unowned session gets an env-admin token and the local API url', async () => {
  seedSession('s-unowned', null);
  const env = await sessionAgentEnv('s-unowned');
  assert.equal(env.PROPANES_API_URL, 'http://localhost:3999');
  const payload = await verifyToken(env.PROPANES_TOKEN);
  assert.equal(payload?.sub, 'env-admin');
  assert.equal(payload?.role, 'admin');
});

test('owned session gets a token scoped to its owner', async () => {
  const now = new Date().toISOString();
  db.insert(schema.users).values({
    id: 'u-member',
    username: 'member1',
    passwordHash: 'x',
    role: 'member',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }).run();
  seedSession('s-owned', 'u-member');
  const payload = await verifyToken((await sessionAgentEnv('s-owned')).PROPANES_TOKEN);
  assert.equal(payload?.sub, 'u-member');
  assert.equal(payload?.role, 'member');
});

test('pod-provided token and url are left to the process env', async () => {
  process.env.PROPANES_TOKEN = 'pod-token';
  process.env.PROPANES_API_URL = 'http://svc:3001';
  try {
    assert.deepEqual(await sessionAgentEnv('s-owned'), {});
  } finally {
    delete process.env.PROPANES_TOKEN;
    delete process.env.PROPANES_API_URL;
  }
});
