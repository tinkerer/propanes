import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeFromBottomLeft, clampPanelSize } from '../src/lib/qdp-resize.js';

test('dragging the bottom-left grip left/down grows the panel and keeps the right edge pinned', () => {
  const start = { x: 500, w: 400, h: 250 };
  const r = resizeFromBottomLeft(start, -100, 60, 1600);
  assert.deepEqual(r, { x: 400, w: 500, h: 310 });
  assert.equal(r.x + r.w, start.x + start.w);
});

test('dragging right/up shrinks the panel but not below the minimums', () => {
  const start = { x: 500, w: 400, h: 250 };
  const r = resizeFromBottomLeft(start, 300, -300, 1600);
  assert.deepEqual(r, { x: 580, w: 320, h: 200 });
  assert.equal(r.x + r.w, start.x + start.w);
});

test('the left edge stops at the viewport gutter without moving the right edge', () => {
  const start = { x: 100, w: 400, h: 250 };
  const r = resizeFromBottomLeft(start, -500, 0, 1600);
  assert.equal(r.x, 8);
  assert.equal(r.w, 492);
  assert.equal(r.x + r.w, start.x + start.w);
});

test('persisted sizes are clamped to the minimums and the viewport', () => {
  assert.equal(clampPanelSize(undefined, undefined, 1600), null);
  assert.equal(clampPanelSize('400', 300, 1600), null);
  assert.deepEqual(clampPanelSize(100, 50, 1600), { w: 320, h: 200 });
  assert.deepEqual(clampPanelSize(5000, 400, 1600), { w: 1584, h: 400 });
  assert.deepEqual(clampPanelSize(640.4, 333.6, 1600), { w: 640, h: 334 });
});
