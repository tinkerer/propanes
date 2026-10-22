import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

// Spawns must fail fast instead of reaching a real session-service.
process.env.SESSION_SERVICE_URL = 'http://127.0.0.1:9';
const tempDir = mkdtempSync(join(tmpdir(), 'propanes-codex-resume-'));
process.env.DB_PATH = join(tempDir, 'test.db');
const fakeHome = join(tempDir, 'home');
process.env.HOME = fakeHome;

const { db, schema, runMigrations, sqlite } = await import('../src/db/index.ts');
const { resumeAgentSession } = await import('../src/dispatch.ts');
const { buildCodexArgs } = await import('../src/codex-bin.ts');
const { codexRolloutIdFromPath, resolveCodexResumeId } = await import('../src/jsonl-utils.ts');

runMigrations();
test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const ROLLOUT_ID = '01a164f5-5246-7ea0-8786-00de3a5c5d94';
const CWD = '/srv/project';

function writeRollout(home: string, id: string, cwd: string, startedAt: string): string {
  const d = new Date(startedAt);
  const day = join(home, '.codex', 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const stamp = startedAt.slice(0, 19).replace(/:/g, '-');
  const path = join(day, `rollout-${stamp}-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'session_meta', timestamp: startedAt, payload: { id, cwd, timestamp: startedAt } }) + '\n');
  return path;
}

function seed(parent: { runtime: 'codex' | 'claude'; claudeSessionId: string | null; cwd: string; startedAt: string; withFeedback?: boolean }) {
  sqlite.exec('DELETE FROM agent_sessions; DELETE FROM agent_endpoints; DELETE FROM feedback_items;');
  const now = new Date().toISOString();
  if (parent.withFeedback) {
    db.insert(schema.feedbackItems).values({ id: 'fb-1', type: 'manual', status: 'dispatched', title: 'Feedback', description: 'desc', appId: null, createdAt: now, updatedAt: now }).run();
  }
  db.insert(schema.agentSessions).values({
    id: 'parent-1',
    feedbackId: parent.withFeedback ? 'fb-1' : null,
    runtime: parent.runtime,
    permissionProfile: 'interactive-yolo',
    status: 'killed',
    outputBytes: 0,
    claudeSessionId: parent.claudeSessionId,
    cwd: parent.cwd,
    startedAt: parent.startedAt,
    createdAt: now,
  }).run();
}

test('codex args: a resume continues the rollout with `codex resume <id> [prompt]`', () => {
  assert.deepEqual(
    buildCodexArgs({ pipe: false, skip: true, prompt: 'carry on', resumeSessionId: ROLLOUT_ID }),
    ['resume', '--no-daemon', '--dangerously-bypass-approvals-and-sandbox', ROLLOUT_ID, 'carry on'],
  );
  assert.deepEqual(
    buildCodexArgs({ pipe: true, skip: true, prompt: 'carry on', resumeSessionId: ROLLOUT_ID }),
    ['exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', ROLLOUT_ID, 'carry on'],
  );
  // Fresh sessions are unchanged.
  assert.deepEqual(buildCodexArgs({ pipe: false, skip: false, prompt: 'hi' }), ['--no-daemon', 'hi']);
  assert.deepEqual(buildCodexArgs({ pipe: true, skip: true, prompt: 'hi' }), ['exec', '--dangerously-bypass-approvals-and-sandbox', 'hi']);
  assert.deepEqual(buildCodexArgs({ pipe: false, skip: true, resumeSessionId: ROLLOUT_ID }), ['resume', '--no-daemon', '--dangerously-bypass-approvals-and-sandbox', ROLLOUT_ID]);
});

test('rollout id comes from the filename; unrelated paths yield null', () => {
  assert.equal(codexRolloutIdFromPath(`/x/rollout-2026-10-22T18-52-41-${ROLLOUT_ID}.jsonl`), ROLLOUT_ID);
  assert.equal(codexRolloutIdFromPath('/x/0c271277-e2d6-47f0-9ccc-74c6c12c913b.jsonl'), null);
  assert.equal(codexRolloutIdFromPath(null), null);
});

test('resolveCodexResumeId: by stashed id, else by cwd + start time, else null', () => {
  const home = mkdtempSync(join(tmpdir(), 'propanes-codex-id-'));
  try {
    writeRollout(home, ROLLOUT_ID, CWD, '2026-10-22T18:52:41.000Z');
    const other = '01a164f6-18df-7133-9ad4-ce8518431534';
    writeRollout(home, other, CWD, '2026-10-22T20:39:00.000Z');
    assert.equal(resolveCodexResumeId('/elsewhere', ROLLOUT_ID, null, home), ROLLOUT_ID);
    assert.equal(resolveCodexResumeId(CWD, 'not-a-rollout', '2026-10-22T18:52:43.000Z', home), ROLLOUT_ID);
    assert.equal(resolveCodexResumeId(CWD, null, '2026-10-22T20:39:02.000Z', home), other);
    assert.equal(resolveCodexResumeId('/nowhere', null, '2026-10-22T18:52:43.000Z', home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resuming a codex session continues its rollout natively and records the thread id', async () => {
  writeRollout(fakeHome, ROLLOUT_ID, CWD, '2026-10-22T18:52:41.000Z');
  seed({ runtime: 'codex', claudeSessionId: 'stashed-random-uuid', cwd: CWD, startedAt: '2026-10-22T18:52:42.000Z' });

  const { sessionId } = await resumeAgentSession('parent-1', null, null, 'finish the tests');
  const child = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get();
  assert.ok(child);
  assert.equal(child.parentSessionId, 'parent-1');
  assert.equal(child.runtime, 'codex');
  assert.equal(child.permissionProfile, 'interactive-yolo');
  assert.equal(child.claudeSessionId, ROLLOUT_ID);
});

test('a codex session with no attributable rollout still resumes through the context rebuild', async () => {
  seed({ runtime: 'codex', claudeSessionId: null, cwd: '/no/rollout/here', startedAt: '2026-10-22T18:52:42.000Z', withFeedback: true });
  const { sessionId } = await resumeAgentSession('parent-1', null, null, 'finish the tests');
  const child = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get();
  assert.ok(child);
  assert.equal(child.claudeSessionId, null);
});

test('a codex session with no rollout and no feedback reports why it cannot resume', async () => {
  seed({ runtime: 'codex', claudeSessionId: null, cwd: '/no/rollout/here', startedAt: '2026-10-22T18:52:42.000Z' });
  await assert.rejects(resumeAgentSession('parent-1'), /no claudeSessionId stored and no original feedback/);
});
