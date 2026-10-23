import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-session-tags-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { app } = await import('../src/app.ts');
const { mintUserToken } = await import('../src/auth.ts');
const { parseFeedbackTags } = await import('../src/session-source.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const NOW = '2026-10-23T00:00:00.000Z';

function seed() {
  sqlite.prepare(`INSERT INTO applications (id, name, api_key, project_dir, created_at, updated_at) VALUES ('app-1', 'App', 'key-1', '/tmp/app', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`
    INSERT INTO feedback_items (id, type, status, title, app_id, created_at, updated_at)
    VALUES ('fb-slack', 'manual', 'dispatched', 'Slack: hello', 'app-1', ?, ?),
           ('fb-plain', 'manual', 'dispatched', 'hand dispatched', 'app-1', ?, ?)
  `).run(NOW, NOW, NOW, NOW);
  // The bridge tags its feedback slack + amirobot.
  sqlite.prepare(`INSERT INTO feedback_tags (feedback_id, tag) VALUES ('fb-slack', 'slack'), ('fb-slack', 'amirobot')`).run();
  sqlite.prepare(`
    INSERT INTO agent_sessions (id, feedback_id, runtime, permission_profile, status, output_bytes, created_at)
    VALUES ('sess-slack', 'fb-slack', 'claude', 'interactive-yolo', 'running', 0, ?),
           ('sess-plain', 'fb-plain', 'codex', 'interactive-yolo', 'running', 0, ?),
           ('sess-term', NULL, 'terminal', 'plain', 'running', 0, ?)
  `).run(NOW, NOW, NOW);
}

test('parseFeedbackTags normalizes group_concat output', () => {
  assert.equal(parseFeedbackTags(null), null);
  assert.equal(parseFeedbackTags(''), null);
  assert.equal(parseFeedbackTags(' , '), null);
  assert.deepEqual(parseFeedbackTags('slack,amirobot,slack'), ['amirobot', 'slack']);
});

test('session list and detail expose the linked feedback tags', async () => {
  seed();
  const token = await mintUserToken({ id: 'env-admin', username: 'admin', role: 'admin' });
  const headers = { Authorization: `Bearer ${token}` };

  const list = await app.request('/api/v1/admin/agent-sessions', { headers });
  assert.equal(list.status, 200);
  const rows = (await list.json()) as Array<{ id: string; feedbackTags: string[] | null }>;
  const byId = new Map(rows.map((r) => [r.id, r.feedbackTags]));
  assert.deepEqual(byId.get('sess-slack'), ['amirobot', 'slack']);
  assert.equal(byId.get('sess-plain'), null);
  assert.equal(byId.get('sess-term'), null);

  for (const [id, expected] of [['sess-slack', ['amirobot', 'slack']], ['sess-plain', null], ['sess-term', null]] as const) {
    const res = await app.request(`/api/v1/admin/agent-sessions/${id}`, { headers });
    assert.equal(res.status, 200, id);
    const body = (await res.json()) as { feedbackTags: string[] | null };
    assert.deepEqual(body.feedbackTags, expected, id);
  }
});
