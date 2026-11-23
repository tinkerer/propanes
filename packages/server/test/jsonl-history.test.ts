import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decodeJsonlHistoryCursor,
  readJsonlHistoryChunk,
  readJsonlUnitsDelta,
  trimJsonlDeltaTail,
  jsonlHistoryState,
  type JsonlUnit,
} from '../src/jsonl-utils.js';

const line = (tag: string, i: number) => `${tag}-${String(i).padStart(4, '0')}\n`; // 7 bytes
const lines = (tag: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => line(tag, from + i)).join('');

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-history-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('history pages walk back from the snapshot floor to the start, contiguously', () => withDir((dir) => {
  const cont = join(dir, 'cont.jsonl');
  const main = join(dir, 'main.jsonl');
  const sub = join(dir, 'sub.jsonl');
  writeFileSync(main, lines('m', 0, 10));
  writeFileSync(sub, lines('s', 0, 10));
  writeFileSync(cont, lines('c', 0, 10));
  const units: JsonlUnit[] = [
    { key: 'main.jsonl', path: main },
    { key: 'sub.jsonl', path: sub, subagentId: 's' },
    { key: 'cont.jsonl', path: cont },
  ];
  const limits = { responseBytes: 1000, snapshotMainBytes: 35, snapshotSubagentBytes: 14, snapshotSubagentFileBytes: 14 };
  const snap = readJsonlUnitsDelta(units, null, { consumePartial: false, limits });
  const loaded: Record<string, string> = {};
  for (const c of snap.chunks) loaded[c.unit.key] = c.text;
  assert.equal(loaded['cont.jsonl'], lines('c', 5, 10));
  assert.equal(loaded['main.jsonl'], undefined);

  const start = jsonlHistoryState(units, snap.floorOffsets);
  let cursor = start.cursor;
  assert.ok(cursor);
  // Subagent history is skipped but not paged.
  assert.equal(start.remainingBytes, snap.skippedBytes - 56);
  let remaining = start.remainingBytes;
  let pages = 0;
  const order: string[] = [];
  while (cursor) {
    const page = readJsonlHistoryChunk(units, decodeJsonlHistoryCursor(cursor)!, 20);
    const bytes = page.chunks.reduce((n, c) => n + c.text.length, 0);
    assert.ok(bytes <= 20, `page of ${bytes} bytes exceeds the budget`);
    assert.ok(bytes > 0, 'a page made no progress');
    for (const c of page.chunks) {
      loaded[c.unit.key] = c.text + (loaded[c.unit.key] || '');
      order.push(c.unit.key);
    }
    assert.equal(page.remainingBytes, remaining - bytes);
    remaining = page.remainingBytes;
    cursor = page.cursor;
    assert.ok(++pages < 50, 'paging did not terminate');
  }
  assert.equal(remaining, 0);
  assert.equal(loaded['main.jsonl'], lines('m', 0, 10));
  assert.equal(loaded['cont.jsonl'], lines('c', 0, 10));
  assert.equal(loaded['sub.jsonl'], lines('s', 8, 10));
  assert.equal(order.includes('sub.jsonl'), false);
  // Newest conversation file first.
  assert.equal(order.indexOf('main.jsonl') > order.lastIndexOf('cont.jsonl'), true);
}));

test('a line larger than the history budget is returned whole', () => withDir((dir) => {
  const main = join(dir, 'main.jsonl');
  const big = 'x'.repeat(100) + '\n';
  writeFileSync(main, line('m', 0) + big + line('m', 2));
  const units: JsonlUnit[] = [{ key: 'main.jsonl', path: main }];
  const floor = { 'main.jsonl': 7 + big.length };
  const page = readJsonlHistoryChunk(units, floor, 10);
  assert.deepEqual(page.chunks.map(c => c.text), [big]);
  const rest = readJsonlHistoryChunk(units, decodeJsonlHistoryCursor(page.cursor!)!, 10);
  assert.deepEqual(rest.chunks.map(c => c.text), [line('m', 0)]);
  assert.equal(rest.cursor, null);
}));

test('tail trimming moves the history floor so trimmed lines stay loadable', () => withDir((dir) => {
  const main = join(dir, 'main.jsonl');
  const progress = JSON.stringify({ type: 'progress' }) + '\n';
  const msg = (i: number) => JSON.stringify({ type: 'user', i }) + '\n';
  const text = msg(0) + msg(1) + progress + msg(2) + msg(3);
  writeFileSync(main, text);
  const units: JsonlUnit[] = [{ key: 'main.jsonl', path: main }];
  const snap = readJsonlUnitsDelta(units, null, { consumePartial: true });
  assert.equal(snap.skippedBytes, 0);
  trimJsonlDeltaTail(snap, 2, false);
  assert.equal(snap.chunks[0].text, msg(2) + msg(3));
  const floor = text.length - (msg(2) + msg(3)).length;
  assert.deepEqual(snap.floorOffsets, { 'main.jsonl': floor });
  assert.equal(snap.skippedBytes, floor);
  // The live cursor is unaffected: appends still continue from the end.
  assert.equal(snap.newOffsets['main.jsonl'], text.length);

  const page = readJsonlHistoryChunk(units, decodeJsonlHistoryCursor(jsonlHistoryState(units, snap.floorOffsets).cursor!)!, 1 << 20);
  assert.deepEqual(page.chunks.map(c => c.text), [msg(0) + msg(1) + progress]);
  assert.equal(page.cursor, null);
}));

test('a whole file trimmed by the tail becomes history', () => withDir((dir) => {
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  writeFileSync(a, 'a0\na1\n');
  writeFileSync(b, 'b0\nb1\n');
  const units: JsonlUnit[] = [{ key: 'a.jsonl', path: a }, { key: 'b.jsonl', path: b }];
  const snap = readJsonlUnitsDelta(units, null, { consumePartial: true });
  trimJsonlDeltaTail(snap, 1, true);
  assert.deepEqual(snap.chunks.map(c => [c.unit.key, c.text]), [['b.jsonl', 'b1\n']]);
  assert.deepEqual(snap.floorOffsets, { 'a.jsonl': 6, 'b.jsonl': 3 });
  assert.equal(snap.skippedBytes, 9);
}));

test('history cursors drop exhausted and subagent files and reject garbage', () => {
  const units: JsonlUnit[] = [{ key: 'a', path: 'a' }, { key: 'b', path: 'b' }, { key: 's', path: 's', subagentId: 's' }];
  assert.deepEqual(jsonlHistoryState(units, { a: 0 }), { cursor: null, remainingBytes: 0 });
  assert.deepEqual(jsonlHistoryState(units, undefined), { cursor: null, remainingBytes: 0 });
  const state = jsonlHistoryState(units, { a: 0, b: 12, s: 40 });
  assert.equal(state.remainingBytes, 12);
  assert.deepEqual(decodeJsonlHistoryCursor(state.cursor!), { b: 12 });
  assert.equal(decodeJsonlHistoryCursor('not-a-cursor'), null);
});
