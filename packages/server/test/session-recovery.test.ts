import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryParking } from '../src/session-recovery.js';

// Deterministic clock + timer queue so the retry schedule is assertable.
function harness() {
  let clock = 1_000;
  let nextHandle = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      pending.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clearTimer: (handle: number) => { pending.delete(handle); },
    /** Advance the clock, firing every timer that comes due. */
    advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of pending) {
          if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = target;
    },
    pendingCount: () => pending.size,
  };
}

const openSocket = () => ({ readyState: 1 });

test('parked viewers are handed the session once recovery finally works', () => {
  const h = harness();
  let live = false;
  const attempts: string[] = [];
  const recovered: Array<{ sessionId: string; count: number }> = [];

  const parking = createRecoveryParking<{ readyState: number }>({
    attemptRecovery: (sessionId) => { attempts.push(sessionId); return live; },
    onRecovered: (sessionId, sockets) => recovered.push({ sessionId, count: sockets.length }),
    retryMs: 2000,
    minGapMs: 1000,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  parking.park('s1', openSocket());
  parking.park('s1', openSocket());
  assert.equal(parking.isParked('s1'), true);
  assert.deepEqual(attempts, [], 'parking alone must not shell out to tmux');

  h.advance(2000);
  assert.deepEqual(attempts, ['s1'], 'first automatic retry');
  assert.deepEqual(recovered, [], 'still dead, nobody promoted');

  live = true;
  h.advance(2000);
  assert.deepEqual(recovered, [{ sessionId: 's1', count: 2 }], 'both viewers promoted');
  assert.equal(parking.isParked('s1'), false);
  assert.equal(h.pendingCount(), 0, 'retry timer stopped');
});

test('a keystroke retries immediately instead of waiting out the interval', () => {
  const h = harness();
  let live = true;
  let attempts = 0;
  const parking = createRecoveryParking<{ readyState: number }>({
    attemptRecovery: () => { attempts++; return live; },
    onRecovered: () => {},
    retryMs: 2000,
    minGapMs: 1000,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  parking.park('s1', openSocket());
  assert.equal(parking.tryNow('s1'), true);
  assert.equal(attempts, 1);
  assert.equal(parking.isParked('s1'), false);
  // Nothing parked: a later keystroke must not re-enter recovery.
  assert.equal(parking.tryNow('s1'), false);
  assert.equal(attempts, 1);
});

test('a burst of keystrokes cannot turn into a burst of tmux attempts', () => {
  const h = harness();
  let attempts = 0;
  const parking = createRecoveryParking<{ readyState: number }>({
    attemptRecovery: () => { attempts++; return false; },
    onRecovered: () => {},
    retryMs: 2000,
    minGapMs: 1000,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  parking.park('s1', openSocket());
  for (let i = 0; i < 25; i++) parking.tryNow('s1');
  assert.equal(attempts, 1, 'throttled to one attempt per minGapMs');

  h.advance(1000);
  parking.tryNow('s1');
  assert.equal(attempts, 2, 'allowed again once the gap has passed');
});

test('closed sockets stop the retry loop', () => {
  const h = harness();
  let attempts = 0;
  const parking = createRecoveryParking<{ readyState: number }>({
    attemptRecovery: () => { attempts++; return false; },
    onRecovered: () => {},
    retryMs: 2000,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  const socket = { readyState: 1 };
  parking.park('s1', socket);
  h.advance(2000);
  assert.equal(attempts, 1);

  socket.readyState = 3; // CLOSED
  h.advance(2000);
  assert.equal(attempts, 1, 'nobody is waiting any more');
  assert.equal(parking.isParked('s1'), false);
  assert.equal(h.pendingCount(), 0);
});

test('release() drops the session when the last viewer detaches', () => {
  const h = harness();
  const parking = createRecoveryParking<{ readyState: number }>({
    attemptRecovery: () => false,
    onRecovered: () => {},
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  const a = openSocket();
  const b = openSocket();
  parking.park('s1', a);
  parking.park('s1', b);
  parking.release('s1', a);
  assert.equal(parking.isParked('s1'), true, 'one viewer still waiting');
  parking.release('s1', b);
  assert.equal(parking.isParked('s1'), false);
  assert.equal(h.pendingCount(), 0, 'no orphaned timer');
});

test('automatic retries stop after maxAttempts, but a keystroke still works', () => {
  const h = harness();
  let live = false;
  let attempts = 0;
  let promoted = 0;
  const parking = createRecoveryParking<{ readyState: number }>({
    attemptRecovery: () => { attempts++; return live; },
    onRecovered: () => { promoted++; },
    retryMs: 2000,
    maxAttempts: 3,
    minGapMs: 1000,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  parking.park('s1', openSocket());
  h.advance(60_000);
  assert.equal(attempts, 3, 'gave up after maxAttempts');
  assert.equal(h.pendingCount(), 0);
  assert.equal(parking.isParked('s1'), true, 'viewer stays parked, not cut loose');

  live = true;
  assert.equal(parking.tryNow('s1'), true, 'a keystroke can still revive it');
  assert.equal(promoted, 1);
});

// --- Liveness ping guard (lives in agent-sessions.ts, exercised here because
// it is the other half of the same "my terminal went deaf" fix) ---

test('liveness pings are answered locally, real input is forwarded', async () => {
  const { isLivenessPing } = await import('../src/agent-sessions.js');

  assert.equal(
    isLivenessPing(JSON.stringify({ type: 'ping', sessionId: '01M2ABCDEFGHJKMNPQRSTVWXYZ', ts: Date.now() })),
    true,
    'the payload AgentTerminal actually sends',
  );

  // A user typing `ping` in a terminal produces a message containing the same
  // bytes — swallowing it would eat their keystrokes.
  assert.equal(
    isLivenessPing(JSON.stringify({
      type: 'sequenced_input',
      sessionId: '01M2ABCDEFGHJKMNPQRSTVWXYZ',
      seq: 7,
      content: { kind: 'input', data: 'ping' },
    })),
    false,
    'input that merely mentions ping must still reach the PTY',
  );

  assert.equal(isLivenessPing('not json at all'), false);
  assert.equal(isLivenessPing(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })), false);
  // Oversized payloads are not parsed at all — the guard runs on every keystroke.
  assert.equal(isLivenessPing(JSON.stringify({ type: 'ping', pad: 'x'.repeat(300) })), false);
});
