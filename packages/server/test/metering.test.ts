import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-metering-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { db, schema, runMigrations, sqlite } = await import('../src/db/index.ts');
const { beginUsage, reconcileUsage, summarizeUsage, isolateClassFor } = await import('../src/metering.ts');

runMigrations();

const nowSeed = new Date().toISOString();
db.insert(schema.feedbackItems)
  .values({ id: 'fb-meter', type: 'manual', status: 'dispatched', title: 't', description: '', createdAt: nowSeed, updatedAt: nowSeed })
  .run();
db.insert(schema.agentEndpoints)
  .values({ id: 'agent-meter', name: 'Agent', url: '', mode: 'interactive', runtime: 'claude', permissionProfile: 'interactive-yolo', isDefault: false, createdAt: nowSeed, updatedAt: nowSeed })
  .run();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedSession(id: string, status: string, isolation: string, startedAt: string, completedAt?: string) {
  db.insert(schema.agentSessions)
    .values({
      id,
      feedbackId: 'fb-meter',
      agentEndpointId: 'agent-meter',
      runtime: 'claude',
      permissionProfile: 'interactive-yolo',
      status,
      outputBytes: 0,
      isolation,
      startedAt,
      completedAt: completedAt ?? null,
      createdAt: startedAt,
    })
    .run();
}

test('isolateClassFor maps per_session to the worktree substrate', () => {
  assert.equal(isolateClassFor('per_session'), 'worktree');
  assert.equal(isolateClassFor('shared'), 'shared');
  assert.equal(isolateClassFor('per_user_pod'), 'per_user_pod');
});

test('beginUsage is idempotent per session', () => {
  const start = new Date().toISOString();
  seedSession('s1', 'running', 'per_session', start);
  beginUsage({ sessionId: 's1', userId: 'u1', orgId: 'o1', isolation: 'per_session', isolateId: '/tmp/iso-s1' });
  beginUsage({ sessionId: 's1', userId: 'u1', orgId: 'o1', isolation: 'per_session', isolateId: '/tmp/iso-s1' });
  const rows = db.select().from(schema.sessionUsage).where(eq(schema.sessionUsage.sessionId, 's1')).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isolateClass, 'worktree');
});

test('reconcile finalizes wall time only once the session is terminal', () => {
  // Still running → nothing to finalize.
  assert.equal(reconcileUsage(), 0);
  const start = new Date(Date.now() - 5000).toISOString();
  const end = new Date().toISOString();
  db.update(schema.agentSessions)
    .set({ status: 'completed', startedAt: start, completedAt: end })
    .where(eq(schema.agentSessions.id, 's1'))
    .run();
  assert.equal(reconcileUsage(), 1);
  const row = db.select().from(schema.sessionUsage).where(eq(schema.sessionUsage.id, 's1')).get()!;
  assert.equal(row.status, 'completed');
  assert.ok(row.endedAt);
  assert.ok(row.wallMs! >= 4000 && row.wallMs! <= 6500, `wallMs ${row.wallMs}`);
  // Re-running is a no-op (already closed).
  assert.equal(reconcileUsage(), 0);
});

test('summarizeUsage groups by user, org, and isolation', () => {
  const now = new Date().toISOString();
  seedSession('s2', 'completed', 'shared', now, now);
  beginUsage({ sessionId: 's2', userId: 'u2', orgId: 'o1', isolation: 'shared' });
  const summary = summarizeUsage(30);
  assert.ok(summary.totals.sessions >= 2);
  assert.ok(summary.byUser.find((r) => r.key === 'u1'));
  assert.ok(summary.byUser.find((r) => r.key === 'u2'));
  assert.ok(summary.byOrg.find((r) => r.key === 'o1'));
  assert.ok(summary.byIsolation.find((r) => r.key === 'per_session'));
  assert.ok(summary.byIsolation.find((r) => r.key === 'shared'));
});
