import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewerSizes } from '../src/viewer-sizes.js';

test('latest viewer request wins, not the largest', () => {
  const sizes = new ViewerSizes<string>();
  sizes.set('tall', { cols: 150, rows: 55 });
  sizes.set('short', { cols: 100, rows: 30 });
  assert.deepEqual(sizes.latest(), { cols: 100, rows: 30 });
  sizes.set('tall', { cols: 150, rows: 55 });
  assert.deepEqual(sizes.latest(), { cols: 150, rows: 55 });
});

test('removing the latest viewer falls back to the next most recent', () => {
  const sizes = new ViewerSizes<string>();
  sizes.set('a', { cols: 80, rows: 24 });
  sizes.set('b', { cols: 200, rows: 20 });
  sizes.set('c', { cols: 80, rows: 60 });
  assert.ok(sizes.delete('c'));
  assert.deepEqual(sizes.latest(), { cols: 200, rows: 20 });
  sizes.prune(new Set(['a']));
  assert.equal(sizes.size, 1);
  assert.deepEqual(sizes.latest(), { cols: 80, rows: 24 });
  sizes.prune(new Set());
  assert.equal(sizes.latest(), null);
});

test('latest can be restricted to one session\'s viewers', () => {
  const sizes = new ViewerSizes<string>();
  sizes.set('s1-a', { cols: 100, rows: 30 });
  sizes.set('s2-a', { cols: 120, rows: 40 });
  assert.deepEqual(sizes.latest(['s1-a']), { cols: 100, rows: 30 });
  assert.deepEqual(sizes.latest(['s1-a', 's2-a']), { cols: 120, rows: 40 });
  assert.equal(sizes.latest(['nobody']), null);
});
