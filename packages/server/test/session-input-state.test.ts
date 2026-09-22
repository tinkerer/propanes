import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutput, extractOscTitle } from '../src/session-input-state.js';

test('a prompt can disappear without another title update', () => {
  const title = extractOscTitle('\x1b]0;✳ Review PRs\x07')!;
  assert.equal(classifyOutput(title, 'Do you want to proceed?\nEsc to cancel'), 'waiting');
  const output = 'Do you want to proceed?\nEsc to cancel\n'
    + 'Background agent output\n'.repeat(8)
    + 'Waiting for 1 background agent to finish\n↓ 153.1k tokens';
  assert.equal(classifyOutput(title, output), 'idle');
});

test('token counters are not arrow-key selection prompts', () => {
  assert.equal(classifyOutput('✳ Review PRs', '↑ 48.2k tokens · ↓ 52.0k tokens'), 'idle');
  assert.equal(classifyOutput('✳ Review PRs', '↓ 52.0k tokens · ↑ 48.2k tokens'), 'idle');
  assert.equal(classifyOutput('✳ Review PRs', '↑ ↓ to navigate'), 'waiting');
});

test('permission prompts remain waiting and working titles override old prompts', () => {
  for (const prompt of ['Allow Deny', 'Yes No', 'Would you like to proceed', 'Enter to select']) {
    assert.equal(classifyOutput('✳ Review PRs', prompt), 'waiting');
    assert.equal(classifyOutput('⠋ Review PRs', prompt), 'active');
  }
});
