import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenSession } from '../src/lib/open-session-counts.js';
test('open counts include running/waiting PTYs and pending launches, not history', () => {
  for (const status of ['running', 'pending']) assert.equal(isOpenSession({ status }), true);
  for (const status of ['completed', 'failed', 'killed', 'deleted']) assert.equal(isOpenSession({ status }), false);
});
