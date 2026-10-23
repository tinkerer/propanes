import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeSubmenu, SUBMENU_VIEWPORT_MARGIN as M } from '../src/lib/submenu-position.js';

const vp = { width: 1200, height: 800 };
const row = { top: 100, bottom: 126, left: 20, right: 180 };

test('opens to the right of the row, aligned with its top', () => {
  const p = placeSubmenu(row, vp, 120);
  assert.equal(p.left, 180);
  assert.equal(p.top, 100);
});

test('caps height to the viewport so long lists scroll', () => {
  const p = placeSubmenu(row, vp, 5000);
  assert.equal(p.maxHeight, 800 - M * 2);
  assert.equal(p.top, M);
});

test('slides up when the list would overflow the bottom', () => {
  const p = placeSubmenu({ ...row, top: 700, bottom: 726 }, vp, 300);
  assert.equal(p.top, 800 - M - 300);
});

test('flips to the left when there is no room on the right', () => {
  const nearRight = { top: 100, bottom: 126, left: 1000, right: 1160 };
  const p = placeSubmenu(nearRight, vp, 120, 180);
  assert.equal(p.left, 1000 - 180);
});

test('never places left of the margin', () => {
  const nearRight = { top: 100, bottom: 126, left: 50, right: 1160 };
  const p = placeSubmenu(nearRight, vp, 120, 180);
  assert.equal(p.left, M);
});
