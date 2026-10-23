import test from 'node:test';
import assert from 'node:assert/strict';
import { isSlackSession, parseFeedbackTags } from '../src/lib/session-source.ts';

test('parseFeedbackTags accepts the list-API array and the detail-API JSON string', () => {
  assert.deepEqual(parseFeedbackTags(['slack', 'amirobot']), ['slack', 'amirobot']);
  assert.deepEqual(parseFeedbackTags('["slack"]'), ['slack']);
  assert.deepEqual(parseFeedbackTags(null), []);
  assert.deepEqual(parseFeedbackTags('not json'), []);
  assert.deepEqual(parseFeedbackTags([1, 'slack', null]), ['slack']);
});

test('isSlackSession keys off the slack tag, not the title', () => {
  assert.equal(isSlackSession({ feedbackTags: ['amirobot', 'slack'] }), true);
  assert.equal(isSlackSession({ feedbackTags: ['bug'] }), false);
  assert.equal(isSlackSession({ feedbackTags: null }), false);
  assert.equal(isSlackSession({}), false);
  assert.equal(isSlackSession(null), false);
  assert.equal(isSlackSession(undefined), false);
});
