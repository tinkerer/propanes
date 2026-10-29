import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-restore-queue-test-'));
const dbPath = join(tempDir, 'test.db');
process.env.DB_PATH = dbPath;
// No session-service reachable in this test environment: getSessionServiceHealthSnapshot()
// resolves null, so liveness checks fall through to "inconclusive" for any session not on a
// registered launcher — that's what listRestoreQueue tests other than the self-heal one rely on.
process.env.SESSION_SERVICE_URL = 'http://127.0.0.1:1';

const { db, schema, runMigrations, sqlite } = await import('../src/db/index.ts');
const { registerLauncher, unregisterLauncher } = await import('../src/launcher-registry.ts');
const {
  listRestoreQueue,
  dismissRestoreQueueItem,
  classifySessionOutcome,
} = await import('../src/restore-queue.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

let seq = 0;
function seedSession(overrides: Partial<typeof schema.agentSessions.$inferInsert> & { id: string }) {
  seq += 1;
  const now = new Date(2026, 9, 12, 18, 30, seq).toISOString();
  db.insert(schema.agentSessions).values({
    runtime: 'claude',
    permissionProfile: 'headless-stream-yolo',
    status: 'failed',
    outputBytes: 0,
    cwd: '/home/dev/storefront',
    createdAt: now,
    lastActivityAt: now,
    completedAt: now,
    ...overrides,
  }).run();
}

test.beforeEach(() => {
  db.delete(schema.agentSessions).run();
});

test('lists an orphaned-restart session', async () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', title: 'Task A' });

  const items = await listRestoreQueue();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 's1');
  assert.equal(items[0].collapsedRowCount, 1);
});

test('excludes an ordinary failure (no failureReason) from the queue', async () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: null, status: 'failed' });

  const items = await listRestoreQueue();
  assert.equal(items.length, 0);
});

test('dedup: collapses multiple rows for the same conversation into the most recent, with a count', async () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', lastActivityAt: '2026-10-12T18:00:00.000Z', createdAt: '2026-10-12T18:00:00.000Z' });
  seedSession({ id: 's2', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', lastActivityAt: '2026-10-12T18:30:00.000Z', createdAt: '2026-10-12T18:30:00.000Z' });
  seedSession({ id: 's3', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', lastActivityAt: '2026-10-12T18:45:00.000Z', createdAt: '2026-10-12T18:45:00.000Z' });

  const items = await listRestoreQueue();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 's3', 'keeps the most recently active row as the representative');
  assert.equal(items[0].collapsedRowCount, 3);
});

test('dedup: a conversation already resumed (newer row, not orphaned) drops out of the queue entirely', async () => {
  // s1 was orphaned by the restart; s2 is a later manual/automatic resume of the
  // same conversation that is now running — the queue must not show s1 again.
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', status: 'failed', lastActivityAt: '2026-10-12T18:30:00.000Z' });
  seedSession({ id: 's2', claudeSessionId: 'conv-1', failureReason: null, status: 'running', lastActivityAt: '2026-10-12T19:00:00.000Z' });

  const items = await listRestoreQueue();
  assert.equal(items.length, 0);
});

test('dedup: a dismissed-and-superseded head keeps the group out, even if an older row is still orphaned-looking', async () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', lastActivityAt: '2026-10-12T18:00:00.000Z' });
  seedSession({ id: 's2', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', restoreDismissedAt: '2026-10-12T19:00:00.000Z', lastActivityAt: '2026-10-12T18:30:00.000Z' });

  const items = await listRestoreQueue();
  assert.equal(items.length, 0, 'the most recent row (s2) is dismissed, so the whole conversation is considered handled');
});

test('liveness recheck: a session actually alive on a connected launcher is excluded and self-healed', async () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart', status: 'failed', launcherId: 'launcher-1' });

  registerLauncher({
    id: 'launcher-1',
    name: 'test-launcher',
    hostname: 'test',
    ws: { readyState: 1, close() {} } as any,
    connectedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    activeSessions: new Set(['s1']),
    capabilities: {} as any,
  });

  try {
    const items = await listRestoreQueue();
    assert.equal(items.length, 0, 'actually-alive session must not appear in the restore queue');

    const row = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, 's1')).get();
    assert.equal(row?.status, 'running', 'self-healed back to running');
    assert.equal(row?.failureReason, null, 'failureReason cleared once confirmed alive');
  } finally {
    unregisterLauncher('launcher-1');
  }
});

test('dismiss removes an item from the queue without resuming it', async () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: 'orphaned_restart' });

  const ok = dismissRestoreQueueItem('s1');
  assert.equal(ok, true);

  const items = await listRestoreQueue();
  assert.equal(items.length, 0);

  const row = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, 's1')).get();
  assert.equal(row?.status, 'failed', 'dismiss does not touch status — it is not a restore');
});

test('dismiss on a session with no orphaned_restart reason is a no-op', () => {
  seedSession({ id: 's1', claudeSessionId: 'conv-1', failureReason: null });
  const ok = dismissRestoreQueueItem('s1');
  assert.equal(ok, false);
});

test('outcome classification: running/pending/failed/killed pass through as-is', () => {
  assert.equal(classifySessionOutcome({ status: 'running', outputLog: null }), 'running');
  assert.equal(classifySessionOutcome({ status: 'pending', outputLog: null }), 'pending');
  assert.equal(classifySessionOutcome({ status: 'failed', outputLog: null }), 'failed');
  assert.equal(classifySessionOutcome({ status: 'killed', outputLog: null }), 'killed');
  assert.equal(classifySessionOutcome(null), 'unknown');
});

test('outcome classification: a completed session is genuine completion when there is no rate-limit marker', () => {
  const outcome = classifySessionOutcome({
    status: 'completed',
    outputLog: 'That task was already complete, and it has since taken effect.\nNo further changes were needed.',
  });
  assert.equal(outcome, 'completed');
});

test('outcome classification: a completed session that actually hit the usage-credit 429 is flagged rate_limited, not completed', () => {
  const outputLog = [
    'Resuming conversation...',
    JSON.stringify({ api_error_status: 429, api_error: 'model_requires_usage_credits' }),
    "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
  ].join('\n');
  const outcome = classifySessionOutcome({ status: 'completed', outputLog });
  assert.equal(outcome, 'rate_limited');
});

test('outcome classification: rate-limit marker is still found through interleaved ANSI escape codes', () => {
  const outputLog = '\x1b[2K\x1b[1Gmodel_requires\x1b[0m_usage_credits\x1b[2K';
  const outcome = classifySessionOutcome({ status: 'completed', outputLog });
  assert.equal(outcome, 'rate_limited');
});
