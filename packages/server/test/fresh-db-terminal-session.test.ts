import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-fresh-db-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { runMigrations, sqlite } = await import('../src/db/index.ts');

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('fresh database permits a terminal session without feedback or endpoint', () => {
  runMigrations();

  const columns = sqlite.pragma('table_info(agent_sessions)') as Array<{
    name: string;
    notnull: number;
  }>;
  assert.equal(columns.find(({ name }) => name === 'feedback_id')?.notnull, 0);
  assert.equal(columns.find(({ name }) => name === 'agent_endpoint_id')?.notnull, 0);

  assert.doesNotThrow(() => {
    sqlite.prepare(`
      INSERT INTO agent_sessions
        (id, runtime, permission_profile, status, output_bytes, created_at)
      VALUES
        ('terminal-1', 'terminal', 'interactive-require', 'pending', 0, '2026-09-03T00:00:00.000Z')
    `).run();
  });
});
