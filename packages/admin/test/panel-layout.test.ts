import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cascadeLayout,
  centerLayout,
  clampRectToViewport,
  fitSizeToViewport,
  PANEL_HEADER_HEIGHT,
  MIN_VISIBLE_WIDTH,
} from '../../widget/src/panel-layout.js';

const VP = { width: 1600, height: 900 };

test('clampRectToViewport pulls a header that slipped above the top back to y=0', () => {
  const r = clampRectToViewport({ x: 300, y: -120, width: 750, height: 500 }, VP);
  assert.equal(r.y, 0);
  assert.equal(r.x, 300);
  assert.equal(r.width, 750);
  assert.equal(r.height, 500);
});

test('clampRectToViewport keeps the header above the bottom edge', () => {
  const r = clampRectToViewport({ x: 0, y: 5000, width: 400, height: 300 }, VP);
  assert.equal(r.y, VP.height - PANEL_HEADER_HEIGHT);
});

test('clampRectToViewport keeps MIN_VISIBLE_WIDTH on screen horizontally', () => {
  const left = clampRectToViewport({ x: -2000, y: 10, width: 400, height: 300 }, VP);
  assert.equal(left.x, MIN_VISIBLE_WIDTH - 400);
  const right = clampRectToViewport({ x: 5000, y: 10, width: 400, height: 300 }, VP);
  assert.equal(right.x, VP.width - MIN_VISIBLE_WIDTH);
});

test('clampRectToViewport leaves an on-screen rect untouched', () => {
  const rect = { x: 120, y: 80, width: 650, height: 500 };
  assert.deepEqual(clampRectToViewport(rect, VP), rect);
});

test('fitSizeToViewport shrinks oversized panels but respects minimums', () => {
  assert.deepEqual(fitSizeToViewport(3000, 2000, VP), { width: 1560, height: 860 });
  assert.deepEqual(fitSizeToViewport(10, 10, VP), { width: 320, height: 200 });
  // Tiny viewport: minimums win over the margin rule.
  assert.deepEqual(fitSizeToViewport(900, 700, { width: 300, height: 200 }), { width: 320, height: 200 });
});

test('cascadeLayout staggers panels diagonally in order and keeps every header visible', () => {
  const rects = [
    { x: -500, y: -300, width: 650, height: 500 },
    { x: 900, y: 2000, width: 750, height: 500 },
    { x: 0, y: 0, width: 480, height: 620 },
  ];
  const out = cascadeLayout(rects, VP);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => [r.x, r.y]), [[40, 40], [70, 70], [100, 100]]);
  for (const r of out) {
    assert.ok(r.y >= 0 && r.y <= VP.height - PANEL_HEADER_HEIGHT);
    assert.ok(r.x + r.width >= MIN_VISIBLE_WIDTH && r.x <= VP.width - MIN_VISIBLE_WIDTH);
  }
  // Sizes preserved when they already fit.
  assert.deepEqual(out.map((r) => [r.width, r.height]), [[650, 500], [750, 500], [480, 620]]);
});

test('cascadeLayout wraps back to the origin when the diagonal runs out of room', () => {
  const small = { width: 800, height: 400 };
  const rects = Array.from({ length: 6 }, () => ({ x: 0, y: 0, width: 600, height: 300 }));
  const out = cascadeLayout(rects, small);
  // 40,70,100 fit (100+300 = 400 > 380 → wrap at step 3)
  assert.deepEqual(out.map((r) => r.y), [40, 70, 40, 70, 40, 70]);
});

test('centerLayout centers every panel, shrinking the ones that do not fit', () => {
  const out = centerLayout([
    { x: 0, y: 0, width: 600, height: 400 },
    { x: 0, y: 0, width: 5000, height: 5000 },
  ], VP);
  assert.deepEqual(out[0], { x: 500, y: 250, width: 600, height: 400 });
  assert.deepEqual(out[1], { x: 20, y: 20, width: 1560, height: 860 });
});
