import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleDotMenu } from '../src/lib/dot-menu.js';

const a = { sessionId: 'a', x: 10, y: 20 };
const b = { sessionId: 'b', x: 30, y: 40 };

test('opens the menu when none is open', () => {
  assert.deepEqual(toggleDotMenu(null, a), a);
  assert.deepEqual(toggleDotMenu(undefined, a), a);
});

test('clicking the same dot again closes the menu', () => {
  assert.equal(toggleDotMenu(a, { ...a, x: 11 }), null);
});

test('clicking a different dot moves the menu there', () => {
  assert.deepEqual(toggleDotMenu(a, b), b);
});

test('custom identity: same session in a different pane re-anchors instead of closing', () => {
  const inLeaf1 = { sessionId: 'a', leafId: 'l1', x: 0, y: 0 };
  const inLeaf2 = { sessionId: 'a', leafId: 'l2', x: 5, y: 5 };
  const same = (p: typeof inLeaf1, q: typeof inLeaf1) => p.sessionId === q.sessionId && p.leafId === q.leafId;
  assert.deepEqual(toggleDotMenu(inLeaf1, inLeaf2, same), inLeaf2);
  assert.equal(toggleDotMenu(inLeaf1, { ...inLeaf1, x: 9 }, same), null);
});
