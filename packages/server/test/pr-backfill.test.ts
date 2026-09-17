import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-pr-backfill-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { computeJsonlPath } = await import('../src/jsonl-utils.ts');
const { backfillTranscriptPrUrls } = await import('../src/pr-backfill.ts');

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const PR = 'https://github.com/workbenchai/workbench/pull/1353';
const home = join(tempDir, 'agent-home');
const cwd = '/data/workspaces/workbench';

function insert(id: string, claudeId: string | null, status: string, prUrls: string | null, createdAt: string) {
  sqlite.prepare(`
    INSERT INTO agent_sessions (id, runtime, permission_profile, status, output_bytes, created_at, claude_session_id, cwd, pr_urls)
    VALUES (?, 'claude', 'headless-yolo', ?, 0, ?, ?, ?, ?)
  `).run(id, status, createdAt, claudeId, cwd, prUrls);
}
function prUrlsOf(id: string): string | null {
  return (sqlite.prepare('SELECT pr_urls FROM agent_sessions WHERE id = ?').get(id) as any).pr_urls;
}
function writeTranscript(claudeId: string, body: string) {
  const p = computeJsonlPath(cwd, claudeId, home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

test('backfills ended sessions from their transcripts, once', () => {
  runMigrations();
  const recent = new Date().toISOString();
  const ancient = '2020-01-01T00:00:00.000Z';

  insert('S_HIT', 'aaaaaaaa-0000-0000-0000-000000000001', 'killed', null, recent);
  writeTranscript('aaaaaaaa-0000-0000-0000-000000000001',
    JSON.stringify({ type: 'pr-link', prNumber: 1353, prUrl: PR, prRepository: 'workbenchai/workbench' }) + '\n');

  insert('S_NONE', 'aaaaaaaa-0000-0000-0000-000000000002', 'completed', null, recent);
  writeTranscript('aaaaaaaa-0000-0000-0000-000000000002', '{"type":"assistant","message":{"content":"no PRs here"}}\n');

  insert('S_MISSING', 'aaaaaaaa-0000-0000-0000-000000000003', 'failed', null, recent); // no transcript on disk
  insert('S_RUNNING', 'aaaaaaaa-0000-0000-0000-000000000004', 'running', null, recent);
  writeTranscript('aaaaaaaa-0000-0000-0000-000000000004', JSON.stringify({ type: 'pr-link', prUrl: PR }) + '\n');
  insert('S_TAGGED', 'aaaaaaaa-0000-0000-0000-000000000005', 'killed', '["https://github.com/o/r/pull/9"]', recent);
  insert('S_OLD', 'aaaaaaaa-0000-0000-0000-000000000006', 'killed', null, ancient);
  writeTranscript('aaaaaaaa-0000-0000-0000-000000000006', JSON.stringify({ type: 'pr-link', prUrl: PR }) + '\n');
  insert('S_TERMINAL', null, 'killed', null, recent);
  insert('S_DAMAGED', 'aaaaaaaa-0000-0000-0000-000000000007', 'killed',
    JSON.stringify(['https://github.com/workbenhai/workbench/pull/1356', PR, 'https://github.com/workbenchai/workbench/pull/1356', 'https://github.com/workbenchai/workbench/pull/1']), recent);

  assert.deepEqual(backfillTranscriptPrUrls(home), { scanned: 2, tagged: 1, missing: 1, scrubbed: 1 });
  assert.equal(prUrlsOf('S_DAMAGED'), JSON.stringify([PR, 'https://github.com/workbenchai/workbench/pull/1356']));
  assert.equal(prUrlsOf('S_HIT'), JSON.stringify([PR]));
  assert.equal(prUrlsOf('S_NONE'), '[]');
  assert.equal(prUrlsOf('S_MISSING'), null);
  assert.equal(prUrlsOf('S_RUNNING'), null);
  assert.equal(prUrlsOf('S_TAGGED'), '["https://github.com/o/r/pull/9"]');
  assert.equal(prUrlsOf('S_OLD'), null);
  assert.equal(prUrlsOf('S_TERMINAL'), null);

  // Second boot: only the transcript-less row is looked at again, nothing is rewritten.
  assert.deepEqual(backfillTranscriptPrUrls(home), { scanned: 0, tagged: 0, missing: 1, scrubbed: 0 });
});
