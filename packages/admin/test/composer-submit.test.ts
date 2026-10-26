import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerEnterAction, canExplicitlyResume } from '../src/lib/composer-submit.js';

const enter = { key: 'Enter', shiftKey: false, isComposing: false, repeat: false };
test('Enter sends only to a running session and requires explicit resume otherwise', () => {
  assert.equal(composerEnterAction(enter, true), 'send');
  assert.equal(composerEnterAction(enter, false), 'explicit-resume-required');
});
test('IME composition, key repeats, shift-enter and unrelated keys never submit', () => {
  for (const event of [
    { ...enter, isComposing: true }, { ...enter, repeat: true },
    { ...enter, shiftKey: true }, { ...enter, key: 'Escape' },
  ]) {
    assert.equal(composerEnterAction(event, true), null);
    assert.equal(composerEnterAction(event, false), null);
  }
});
test('synthetic clicks cannot resume a stopped session', () => {
  assert.equal(canExplicitlyResume({ isTrusted: false }), false);
  assert.equal(canExplicitlyResume({ isTrusted: true }), true);
});
