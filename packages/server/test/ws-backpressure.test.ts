import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';

const {
  sendOrDrop,
  sweepSocket,
  startWsHealthSweep,
  WS_MAX_BUFFERED_BYTES,
  WS_MAX_MISSED_PONGS,
} = await import('../src/ws-backpressure.ts');

interface Fake {
  readyState: number;
  bufferedAmount: number;
  sent: Array<string | Buffer>;
  pings: number;
  terminated: number;
  pong(): void;
}

function fakeSocket(
  overrides: Partial<Pick<Fake, 'readyState' | 'bufferedAmount'>> & { autoPong?: boolean } = {},
): Fake & WebSocket {
  const listeners: Array<() => void> = [];
  const { autoPong = false, ...fields } = overrides;
  const fake = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as Array<string | Buffer>,
    pings: 0,
    terminated: 0,
    ...fields,
    send(data: string | Buffer) { this.sent.push(data); },
    ping() { this.pings++; if (autoPong) this.pong(); },
    terminate() { this.terminated++; this.readyState = 3; },
    on(event: string, fn: () => void) { if (event === 'pong') listeners.push(fn); return this; },
    pong() { for (const fn of listeners) fn(); },
  };
  return fake as unknown as Fake & WebSocket;
}

test('sendOrDrop queues data on a healthy open socket', () => {
  const ws = fakeSocket();
  assert.equal(sendOrDrop(ws, 'hello', 'test'), true);
  assert.deepEqual(ws.sent, ['hello']);
  assert.equal(ws.terminated, 0);
});

test('sendOrDrop refuses sockets that are not open without terminating them', () => {
  const ws = fakeSocket({ readyState: 2 });
  assert.equal(sendOrDrop(ws, 'hello', 'test'), false);
  assert.deepEqual(ws.sent, []);
  assert.equal(ws.terminated, 0);
});

test('sendOrDrop terminates a socket whose unsent backlog exceeds the cap', () => {
  const ws = fakeSocket({ bufferedAmount: WS_MAX_BUFFERED_BYTES + 1 });
  assert.equal(sendOrDrop(ws, 'more output', 'test'), false);
  assert.deepEqual(ws.sent, [], 'nothing more must be enqueued behind a stalled peer');
  assert.equal(ws.terminated, 1);
});

test('sendOrDrop tolerates a backlog exactly at the cap', () => {
  const ws = fakeSocket({ bufferedAmount: WS_MAX_BUFFERED_BYTES });
  assert.equal(sendOrDrop(ws, 'x', 'test'), true);
  assert.equal(ws.terminated, 0);
});

test('sweep pings each round and terminates after the allowed missed pongs', () => {
  const ws = fakeSocket();
  for (let i = 0; i < WS_MAX_MISSED_PONGS; i++) {
    sweepSocket(ws, 'test');
    assert.equal(ws.pings, i + 1);
    assert.equal(ws.terminated, 0, `must still be alive after ${i + 1} unanswered pings`);
  }
  sweepSocket(ws, 'test');
  assert.equal(ws.terminated, 1);
  assert.equal(ws.pings, WS_MAX_MISSED_PONGS, 'no ping is sent to a socket being dropped');
});

test('a pong resets the missed counter', () => {
  const ws = fakeSocket();
  for (let i = 0; i < WS_MAX_MISSED_PONGS; i++) sweepSocket(ws, 'test');
  ws.pong();
  for (let i = 0; i < WS_MAX_MISSED_PONGS; i++) {
    sweepSocket(ws, 'test');
    assert.equal(ws.terminated, 0);
  }
  sweepSocket(ws, 'test');
  assert.equal(ws.terminated, 1);
});

test('sweep drops an over-cap socket even when nothing new is being sent', () => {
  const ws = fakeSocket({ bufferedAmount: WS_MAX_BUFFERED_BYTES * 2 });
  sweepSocket(ws, 'test');
  assert.equal(ws.terminated, 1);
  assert.equal(ws.pings, 0);
});

test('sweep ignores sockets that are not open', () => {
  const ws = fakeSocket({ readyState: 3, bufferedAmount: WS_MAX_BUFFERED_BYTES * 2 });
  sweepSocket(ws, 'test');
  assert.equal(ws.terminated, 0);
  assert.equal(ws.pings, 0);
});

test('startWsHealthSweep walks every server and can be stopped', async () => {
  const a = fakeSocket({ autoPong: true });
  const b = fakeSocket({ bufferedAmount: WS_MAX_BUFFERED_BYTES + 1 });
  const stop = startWsHealthSweep(
    [
      { label: 'one', wss: { clients: new Set([a]) } },
      { label: 'two', wss: { clients: new Set([b]) } },
    ],
    5,
  );
  await new Promise((r) => setTimeout(r, 40));
  stop();
  const pingsAtStop = a.pings;
  assert.ok(pingsAtStop >= 1, 'healthy socket was pinged');
  assert.equal(a.terminated, 0, 'a socket that answers pings stays attached');
  assert.equal(b.terminated, 1, 'backed-up socket was dropped');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.pings, pingsAtStop, 'no pings after stop');
});
