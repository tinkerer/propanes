import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeCodexJsonlPath, computeJsonlPath, jsonlCursorNeedsReset, readJsonlFileDelta, readJsonlUnitsDelta, resolveClaudeSessionIdForProcess, resolveSessionJsonlPath } from '../src/jsonl-utils.js';

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
        '/srv/stage-src/alice/storefront',
        '/srv/stage-src/alice/storefront',
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

test('a codex session is never attributed a rollout recorded before it started', () => {
  const home = mkdtempSync(join(tmpdir(), 'propanes-jsonl-rollout-floor-'));
  try {
    const cwd = '/srv/project';
    const day = join(home, '.codex', 'sessions', '2026', '10', '22');
    mkdirSync(day, { recursive: true });
    const older = join(day, 'rollout-2026-10-22T18-46-57-01a164f0-1437-7130-adfe-68e321f07a81.jsonl');
    writeFileSync(older, JSON.stringify({ type: 'session_meta', timestamp: '2026-10-22T18:46:57.000Z', payload: { cwd, timestamp: '2026-10-22T18:46:57.000Z' } }) + '\n');

    // The new session launched at 20:38:59 and codex has not written its rollout yet.
    assert.equal(computeCodexJsonlPath(cwd, null, '2026-10-22T20:38:59.348Z', true, home), null);

    const own = join(day, 'rollout-2026-10-22T20-39-00-01a16556-a9cd-7ee0-964b-39721bbec16c.jsonl');
    writeFileSync(own, JSON.stringify({ type: 'session_meta', timestamp: '2026-10-22T20:39:00.500Z', payload: { cwd, timestamp: '2026-10-22T20:39:00.500Z' } }) + '\n');
    assert.equal(computeCodexJsonlPath(cwd, null, '2026-10-22T20:38:59.348Z', true, home), own);
    // Small clock skew (rollout stamped just before the row) still matches.
    assert.equal(computeCodexJsonlPath(cwd, null, '2026-10-22T20:39:05.000Z', false, home), own);
    // The older session still resolves to its own rollout.
    assert.equal(computeCodexJsonlPath(cwd, null, '2026-10-22T18:46:56.154Z', false, home), older);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('readJsonlFileDelta stops at the last complete line inside the byte window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-delta-'));
  try {
    const file = join(dir, 'a.jsonl');
    writeFileSync(file, 'aaaa\nbbbb\ncccc\n');
    const first = readJsonlFileDelta(file, 0, false, 12);
    assert.deepEqual(first, { text: 'aaaa\nbbbb\n', newOffset: 10, shrunk: false, more: true });
    const rest = readJsonlFileDelta(file, first.newOffset, false, 12);
    assert.deepEqual(rest, { text: 'cccc\n', newOffset: 15, shrunk: false, more: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonlFileDelta returns a line longer than the window whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-delta-'));
  try {
    const file = join(dir, 'a.jsonl');
    const long = 'x'.repeat(3 * 1024 * 1024);
    writeFileSync(file, `${long}\nshort\ntail-without-newline`);
    const first = readJsonlFileDelta(file, 0, true, 16);
    assert.equal(first.text, `${long}\n`);
    assert.equal(first.more, true);
    // Only the true end of file is consumed as a partial line.
    const rest = readJsonlFileDelta(file, first.newOffset, true, 1024);
    assert.equal(rest.text, 'short\ntail-without-newline');
    assert.equal(rest.more, false);
    const live = readJsonlFileDelta(file, first.newOffset, false, 1024);
    assert.equal(live.text, 'short\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonlUnitsDelta pages a large backlog and caps the snapshot per file class', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-units-'));
  try {
    const line = (tag: string, i: number) => `${tag}-${String(i).padStart(4, '0')}\n`; // 7 bytes
    const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => line(tag, i)).join('');
    const main = join(dir, 'main.jsonl');
    const subA = join(dir, 'a.jsonl');
    const subB = join(dir, 'b.jsonl');
    writeFileSync(main, lines('m', 10)); // 70 bytes
    writeFileSync(subA, lines('a', 10));
    writeFileSync(subB, lines('b', 10));
    const units = [
      { key: 'main.jsonl', path: main },
      { key: 'a.jsonl', path: subA, subagentId: 'a' },
      { key: 'b.jsonl', path: subB, subagentId: 'b' },
    ];
    const limits = { responseBytes: 40, snapshotMainBytes: 50, snapshotSubagentBytes: 30, snapshotSubagentFileBytes: 20 };

    const seen: Record<string, string> = {};
    let offsets: Record<string, number> | null = null;
    let pages = 0;
    let skipped = 0;
    for (;;) {
      const d = readJsonlUnitsDelta(units, offsets, { consumePartial: false, limits });
      assert.equal(d.reset, pages === 0);
      if (pages === 0) skipped = d.skippedBytes;
      const bytes = d.chunks.reduce((n, c) => n + c.text.length, 0);
      assert.ok(bytes <= limits.responseBytes, `page of ${bytes} bytes exceeds the budget`);
      for (const c of d.chunks) seen[c.unit.key] = (seen[c.unit.key] || '') + c.text;
      offsets = d.newOffsets;
      pages++;
      if (!d.more) break;
      assert.ok(pages < 20, 'paging did not terminate');
    }
    assert.ok(pages > 1);
    // Newest whole lines only: 50 bytes of main → 7 lines; subagents share 30
    // bytes newest-first at ≤20 each → b keeps 2 lines, a keeps 1.
    assert.equal(seen['main.jsonl'], lines('m', 10).slice(21));
    assert.equal(seen['b.jsonl'], line('b', 8) + line('b', 9));
    assert.equal(seen['a.jsonl'], line('a', 9));
    assert.equal(skipped, 21 + 56 + 63);

    // Appends after the snapshot arrive as a plain delta.
    appendFileSync(subA, line('a', 10));
    const next = readJsonlUnitsDelta(units, offsets, { consumePartial: false, limits });
    assert.equal(next.reset, false);
    assert.equal(next.skippedBytes, 0);
    assert.deepEqual(next.chunks.map(c => [c.unit.key, c.text]), [['a.jsonl', line('a', 10)]]);

    // A truncated file falls back to a fresh snapshot.
    writeFileSync(main, line('m', 0));
    const afterTruncate = readJsonlUnitsDelta(units, next.newOffsets, { consumePartial: false, limits });
    assert.equal(afterTruncate.reset, true);
    assert.equal(afterTruncate.chunks[0].text, line('m', 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
