import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'resume-conflicts-'));
process.env.DB_PATH = join(dir, 'test.db');
const { sqlite, runMigrations } = await import('../src/db/index.js');
const { assertResumeAvailable, ResumeConflictError } = await import('../src/resume-conflicts.js');
const { resumeAgentSession } = await import('../src/dispatch.js');
runMigrations();
test.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(() => { sqlite.exec('DELETE FROM agent_sessions'); });
function add(id: string, parent: string | null = null, status = 'killed', thread: string | null = null, conversation: string | null = null) {
  sqlite.prepare(`INSERT INTO agent_sessions
    (id,parent_session_id,status,cos_thread_id,claude_session_id,runtime,permission_profile,created_at)
    VALUES (?,?,?,?,?,'claude','interactive-yolo',?)`).run(id,parent,status,thread,conversation,new Date().toISOString());
  return { id, permissionProfile: 'interactive-yolo', cosThreadId: thread, claudeSessionId: conversation, runtime: 'claude' };
}
test('an active child blocks resuming its stopped ancestor without creating a row', async () => {
  add('old'); add('new', 'old', 'running');
  await assert.rejects(resumeAgentSession('old'), ResumeConflictError);
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM agent_sessions').get() as { n: number }).n, 2);
});
test('a pending sibling blocks another resume through a different stopped child', () => {
  add('root'); const parent = add('old', 'root'); add('new', 'root', 'pending');
  assert.throws(() => assertResumeAvailable(parent), ResumeConflictError);
});
test('a shared thread or conversation blocks disconnected imports', () => {
  const parent = add('old', null, 'killed', 'thread', 'conversation');
  add('new', null, 'running', 'thread');
  assert.throws(() => assertResumeAvailable(parent), ResumeConflictError);
  sqlite.prepare('UPDATE agent_sessions SET cos_thread_id = NULL, claude_session_id = ? WHERE id = ?').run('conversation', 'new');
  assert.throws(() => assertResumeAvailable(parent), ResumeConflictError);
});
test('completed or failed descendants and unrelated active conversations do not block', () => {
  const parent = add('old'); add('done', 'old', 'completed'); add('failed', 'old', 'failed');
  add('unrelated', null, 'running', 'other', 'different');
  assert.doesNotThrow(() => assertResumeAvailable(parent));
});
test('cycles terminate and a pending reservation blocks the next check', () => {
  const parent = add('old');
  assert.doesNotThrow(() => assertResumeAvailable(parent));
  add('pending', 'old', 'pending');
  sqlite.prepare('UPDATE agent_sessions SET parent_session_id = ? WHERE id = ?').run('pending', 'old');
  assert.throws(() => assertResumeAvailable(parent), ResumeConflictError);
});
test('plain terminals retain their separate-shell behavior', () => {
  const parent = add('old'); add('new', 'old', 'running');
  assert.doesNotThrow(() => assertResumeAvailable({ ...parent, permissionProfile: 'plain' }));
});
test('independent native forks can resume while their original conversation remains active', () => {
  const original = add('original', null, 'running', null, 'original-native-id');
  const fork = add('fork', 'original', 'completed', null, 'fork-native-id');
  assert.doesNotThrow(() => assertResumeAvailable(fork));
  sqlite.prepare("UPDATE agent_sessions SET status = 'completed' WHERE id = 'original'").run();
  sqlite.prepare("UPDATE agent_sessions SET status = 'running' WHERE id = 'fork'").run();
  assert.doesNotThrow(() => assertResumeAvailable(original));
  add('fork-resume', 'fork', 'pending', null, 'fork-native-id');
  assert.throws(() => assertResumeAvailable(fork), ResumeConflictError);
});
test('changing runtime remains part of the resume lineage', () => {
  const parent = add('original', null, 'completed', null, 'claude-id');
  add('continued', 'original', 'running', null, 'codex-id');
  sqlite.prepare("UPDATE agent_sessions SET runtime = 'codex' WHERE id = 'continued'").run();
  assert.throws(() => assertResumeAvailable(parent), ResumeConflictError);
});
test('resume HTTP route authenticates callers and returns 409 for stale clients and active relatives', async () => {
  const { app } = await import('../src/app.js');
  const { mintUserToken } = await import('../src/auth.js');
  const token = await mintUserToken({ id: 'env-admin', username: 'admin', role: 'admin' });
  add('original');
  const path = '/api/v1/admin/agent-sessions/original/resume';
  assert.equal((await app.request(path, { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const stale = await app.request(path, { method: 'POST', headers: { ...headers, 'x-propanes-resume-source': 'conversation.submit-prompt' }, body: '{}' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /Refresh this ProPanes page/);
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM agent_sessions').get() as { n: number }).n, 1);
  add('running', 'original', 'running');
  const explicit = await app.request(path, { method: 'POST', headers: { ...headers, 'x-propanes-resume-source': 'conversation.submit-prompt.click.trusted' }, body: '{}' });
  assert.equal(explicit.status, 409);
  assert.match((await explicit.json()).error, /already running/);
  assert.equal((sqlite.prepare('SELECT COUNT(*) n FROM agent_sessions').get() as { n: number }).n, 2);
});
