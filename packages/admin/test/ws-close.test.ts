import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSocketQuietly } from '../src/lib/ws-close.js';

function fakeSocket(readyState: number) {
  const ws = {
    readyState,
    closes: 0,
    onopen: (() => {}) as (() => void) | null,
    onmessage: (() => {}) as (() => void) | null,
    onclose: (() => {}) as (() => void) | null,
    onerror: (() => {}) as (() => void) | null,
    close() { this.closes++; this.readyState = 2; },
  };
  return ws as unknown as WebSocket & typeof ws;
}

test('an OPEN socket is closed at once with its handlers detached', () => {
  const ws = fakeSocket(1);
  closeSocketQuietly(ws);
  assert.equal(ws.closes, 1);
  assert.equal(ws.onmessage, null);
  assert.equal(ws.onclose, null);
});

test('a CONNECTING socket is closed only once the handshake completes', () => {
  const ws = fakeSocket(0);
  closeSocketQuietly(ws);
  // Not yet: closing now is what Chrome reports as an error.
  assert.equal(ws.closes, 0);
  assert.equal(ws.onmessage, null, 'the caller no longer observes this socket');
  assert.equal(ws.onclose, null);
  ws.readyState = 1;
  ws.onopen!();
  assert.equal(ws.closes, 1);
});

test('a CONNECTING socket whose handshake fails is simply dropped', () => {
  const ws = fakeSocket(0);
  closeSocketQuietly(ws);
  assert.equal(ws.onerror, null);
  assert.equal(ws.closes, 0);
});

test('closing and closed sockets are left alone', () => {
  for (const state of [2, 3]) {
    const ws = fakeSocket(state);
    closeSocketQuietly(ws);
    assert.equal(ws.closes, 0);
  }
  closeSocketQuietly(null);
  closeSocketQuietly(undefined);
});
