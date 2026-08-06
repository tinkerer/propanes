import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeJsonlPath, jsonlCursorNeedsReset, resolveClaudeSessionIdForProcess, resolveSessionJsonlPath } from '../src/jsonl-utils.js';

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

test('follows Claude transcript rotation from the live process registry after /clear', () => {
  const home = mkdtempSync(join(tmpdir(), 'propanes-jsonl-clear-'));
  try {
    const originalId = '11111111-2222-3333-4444-555555555555';
    const clearedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const cwd = '/data/project';
    const pid = 4242;
    const original = computeJsonlPath(cwd, originalId, home);
    const cleared = computeJsonlPath(cwd, clearedId, home);
    mkdirSync(dirname(original), { recursive: true });
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(original, '{"type":"user","message":"before clear"}\n');
    writeFileSync(cleared, '{"type":"user","message":"after clear"}\n');
    writeFileSync(join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ sessionId: clearedId, cwd }));

    assert.equal(resolveClaudeSessionIdForProcess(pid, originalId, home), clearedId);
    assert.equal(
      resolveSessionJsonlPath(cwd, cwd, 'claude', originalId, null, 'running', home, pid),
      cleared,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('retains the stored Claude session id when the live registry is unavailable or unsafe', () => {
  const home = mkdtempSync(join(tmpdir(), 'propanes-jsonl-registry-'));
  try {
    const originalId = '11111111-2222-3333-4444-555555555555';
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'sessions', '4242.json'), JSON.stringify({ sessionId: '../escape' }));
    assert.equal(resolveClaudeSessionIdForProcess(4242, originalId, home), originalId);
    assert.equal(resolveClaudeSessionIdForProcess(9999, originalId, home), originalId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resets a differential cursor when /clear replaces the main transcript key', () => {
  assert.equal(jsonlCursorNeedsReset(null, [{ key: 'new.jsonl' }]), true);
  assert.equal(jsonlCursorNeedsReset({ 'old.jsonl': 100 }, [{ key: 'new.jsonl' }]), true);
  assert.equal(jsonlCursorNeedsReset({ 'main.jsonl': 100 }, [{ key: 'main.jsonl' }, { key: 'subagent.jsonl' }]), false);
});
