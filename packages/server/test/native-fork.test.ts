import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeForkArgs, forkCodexSession } from '../src/native-fork.ts';

const temp = mkdtempSync(join(tmpdir(), 'propanes-native-fork-'));
const bin = join(temp, 'codex');
const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const previousBin = process.env.CODEX_BIN;
process.env.CODEX_BIN = bin;
test.after(() => {
  if (previousBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previousBin;
  rmSync(temp, { recursive: true, force: true });
});

function fakeCli(event: unknown) {
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));\nconsole.log(${JSON.stringify(JSON.stringify(event))});\n`, { mode: 0o700 });
}

test('Codex copies history with no prompt/model turn and uses the new ID', () => {
  fakeCli({ type: 'thread.started', thread_id: child });
  assert.equal(forkCodexSession(parent, temp), child);
  assert.deepEqual(JSON.parse(readFileSync(join(temp, 'argv.json'), 'utf8')), ['exec', 'fork', '--json', '--skip-git-repo-check', parent]);
});

test('Codex never resumes the parent when the fork returns no independent ID', () => {
  for (const event of [{}, { type: 'thread.started', thread_id: parent }, { type: 'thread.started', thread_id: 'invalid' }]) {
    fakeCli(event);
    assert.throws(() => forkCodexSession(parent, temp), /independent conversation ID/);
  }
});

test('Claude uses native fork flags and a distinct ID for transcript routing', () => {
  assert.deepEqual(claudeForkArgs(parent, child), ['--resume', parent, '--fork-session', '--session-id', child]);
  assert.throws(() => claudeForkArgs(parent, parent), /independent/);
  assert.throws(() => claudeForkArgs(parent, undefined), /independent/);
});
