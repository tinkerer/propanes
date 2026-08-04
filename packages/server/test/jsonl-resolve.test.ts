import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeJsonlPath, resolveSessionJsonlPath } from '../src/jsonl-utils.js';

test('resolves a Claude transcript by id when the recorded cwd changed', () => {
  const home = mkdtempSync(join(tmpdir(), 'propanes-jsonl-resolve-'));
  try {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const originalCwd = '/data/agent-home';
    const transcript = computeJsonlPath(originalCwd, sessionId, home);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{"type":"user"}\n');

    assert.equal(
      resolveSessionJsonlPath(
        '/mnt/stage-nfs-src/maksym/workbench',
        '/mnt/stage-nfs-src/maksym/workbench',
        'claude',
        sessionId,
        null,
        'running',
        home,
      ),
      transcript,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
