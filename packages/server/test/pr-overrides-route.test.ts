import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-pr-overrides-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { agentSessionRoutes } = await import('../src/routes/agent-sessions.ts');

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const A = 'https://github.com/workbenchai/workbench/pull/1468';
const B = 'https://github.com/workbenchai/workbench/pull/1476';

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user' as never, { id: 'env-admin', role: 'admin', orgId: null } as never);
  await next();
});
app.route('/', agentSessionRoutes);

async function post(id: string, body: unknown) {
  const res = await app.request(`/${id}/pr-urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

test('POST /:id/pr-urls adds and removes badges without touching pr_urls', async () => {
  runMigrations();
  sqlite.prepare(`
    INSERT INTO agent_sessions (id, runtime, permission_profile, status, output_bytes, created_at, cwd, pr_urls)
    VALUES ('s1', 'codex', 'interactive-yolo', 'running', 0, ?, '/nonexistent', ?)
  `).run(new Date().toISOString(), JSON.stringify([A]));

  // Bare number resolves against the repo of the PR the session already has.
  let r = await post('s1', { add: '#1476' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.prUrls, [A, B]);

  r = await post('s1', { remove: A });
  assert.deepEqual(r.body.prUrls, [B]);

  const row = sqlite.prepare('SELECT pr_urls FROM agent_sessions WHERE id = ?').get('s1') as any;
  assert.equal(row.pr_urls, JSON.stringify([A]));

  const one = await app.request('/s1');
  assert.equal((await one.json() as any).prUrls, JSON.stringify([B]));

  r = await post('s1', { add: 'nonsense' });
  assert.equal(r.status, 400);
  r = await post('missing', { add: B });
  assert.equal(r.status, 404);
});
