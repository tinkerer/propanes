import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyInputState, type InputStateProcess } from '../src/session-input-transitions.js';
import { classifyOutput, type InputState } from '../src/session-input-state.js';

function fixture() {
  const proc: InputStateProcess = { inputState: 'waiting', waitingDebounce: null, lastStateBroadcast: 0 };
  const broadcasts: InputState[] = [];
  const update = (state: InputState) => applyInputState(proc, state, state => broadcasts.push(state));
  return { proc, broadcasts, update };
}

test('typing and prompt redraws keep the session waiting without broadcasting flicker', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const f = fixture();
  for (const key of 'editing a response\b\r') {
    f.update('active'); // markUserInput's tentative state
    assert.equal(f.proc.inputState, 'waiting', `key ${JSON.stringify(key)} must not clear waiting`);
    t.mock.timers.tick(100);
    f.update(classifyOutput('✳ Review', `Response: ${key}\nEsc to cancel`));
    t.mock.timers.tick(1600);
    assert.equal(f.proc.inputState, 'waiting');
  }
  assert.deepEqual(f.broadcasts, []);
});

test('submitted input with sustained working output leaves waiting after the debounce', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const f = fixture();
  f.update('active');
  t.mock.timers.tick(500);
  f.update(classifyOutput('⠋ Working', 'Processing response'));
  t.mock.timers.tick(999);
  assert.equal(f.proc.inputState, 'waiting');
  t.mock.timers.tick(1);
  assert.equal(f.proc.inputState, 'active');
  assert.deepEqual(f.broadcasts, ['active']);
});

test('a waiting prompt cancels a pending departure, and a later submission can still run', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const f = fixture();
  f.update('active');
  t.mock.timers.tick(1499);
  f.update('waiting');
  t.mock.timers.tick(2000);
  assert.deepEqual(f.broadcasts, []);
  f.update('active');
  t.mock.timers.tick(1500);
  assert.deepEqual(f.broadcasts, ['active']);
  f.update('waiting');
  t.mock.timers.tick(500);
  assert.equal(f.proc.inputState, 'waiting');
  assert.deepEqual(f.broadcasts, ['active', 'waiting']);
});
