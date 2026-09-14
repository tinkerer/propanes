import { test } from 'node:test';
import assert from 'node:assert/strict';

type Listener = () => void;

function makeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, cb: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: Listener) {
      listeners.get(type)?.delete(cb);
    },
    dispatch(type: string) {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

const windowTarget = makeTarget();
const documentTarget = makeTarget();
const doc = Object.assign(documentTarget, { hidden: false });

Object.assign(globalThis, { window: windowTarget, document: doc });

const { onWake, __resetWakeForTests } = await import('../src/lib/wake.ts');

test('a burst of wake signals is reported once', () => {
  __resetWakeForTests();
  const seen: string[] = [];
  const off = onWake((reason) => seen.push(reason));

  // A real wake fires several of these within a few milliseconds.
  windowTarget.dispatch('online');
  windowTarget.dispatch('focus');
  documentTarget.dispatch('visibilitychange');

  assert.deepEqual(seen, ['online']);
  off();
});

test('a hidden tab becoming visible is not a wake until it is visible', () => {
  __resetWakeForTests();
  const seen: string[] = [];
  const off = onWake((reason) => seen.push(reason));

  doc.hidden = true;
  documentTarget.dispatch('visibilitychange');
  assert.deepEqual(seen, [], 'going hidden is not a wake');

  off();
});

test('listeners are installed on first subscriber and removed with the last', () => {
  __resetWakeForTests();
  const off1 = onWake(() => {});
  const off2 = onWake(() => {});
  assert.equal(windowTarget.count('focus'), 1);
  assert.equal(windowTarget.count('online'), 1);
  assert.equal(documentTarget.count('visibilitychange'), 1);

  off1();
  assert.equal(windowTarget.count('focus'), 1, 'still one subscriber left');
  off2();
  assert.equal(windowTarget.count('focus'), 0);
  assert.equal(windowTarget.count('online'), 0);
  assert.equal(documentTarget.count('visibilitychange'), 0);
});

test('a suspended host is detected by the clock gap, a healthy one is not', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  __resetWakeForTests();
  const seen: string[] = [];
  const off = onWake((reason) => seen.push(reason));

  // Timers ticking on schedule: the page was awake the whole time. Advance one
  // interval at a time — a single large tick would fire every missed iteration
  // against an already-advanced clock, which is the suspend case, not this one.
  for (let i = 0; i < 12; i++) t.mock.timers.tick(5_000);
  assert.deepEqual(seen, [], 'a healthy page must not report a wake');

  // The host sleeps: the wall clock jumps while the timer does not run.
  t.mock.timers.setTime(Date.now() + 10 * 60_000);
  t.mock.timers.tick(5_000);
  assert.deepEqual(seen, ['clock-gap']);

  off();
  t.mock.timers.reset();
});
