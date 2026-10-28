import test from 'node:test';
import assert from 'node:assert/strict';
import { livePtyProfile } from '../src/session-pty-profile.js';

test('interactive Claude repairs a stream profile even when its prompt mentions stream flags', () => {
  assert.equal(livePtyProfile('headless-stream-yolo', [[
    'claude', '--dangerously-skip-permissions', '--resume', 'thread',
    'Please fix --output-format stream-json and use -p for printing',
  ], ['bash', '-c', 'claude --print --output-format stream-json']]), 'interactive-yolo');
  assert.equal(livePtyProfile('headless-stream-require', [['/usr/bin/claude', '--resume', 'thread']]), 'interactive-require');
});

test('genuine print and stream agents retain their wide profile', () => {
  for (const flags of [
    ['--print'], ['-p', 'prompt'], ['--input-format', 'stream-json'],
    ['--output-format', 'stream-json'], ['--output-format=stream-json'],
  ]) {
    assert.equal(livePtyProfile('headless-stream-yolo', [['claude', ...flags]]), 'headless-stream-yolo');
  }
});

test('wrapper children are inspected but unrelated commands cannot change permissions', () => {
  assert.equal(livePtyProfile('headless-stream-require', [
    ['bash', '-c', 'wrapper'], ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--resume', 'thread'],
  ]), 'interactive-require');
  for (const commands of [[], [['bash', '-c', 'claude --dangerously-skip-permissions']], [['node', '/app/server.js']]]) {
    assert.equal(livePtyProfile('headless-stream-require', commands), 'headless-stream-require');
  }
  assert.equal(livePtyProfile('interactive-yolo', [['claude', '--print']]), 'interactive-yolo');
});
