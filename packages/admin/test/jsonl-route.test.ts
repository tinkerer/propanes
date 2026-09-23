import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingRouteResponse, jsonlDeltaQuery } from '../src/lib/jsonl-route.ts';

test('a bare router 404 means the POST route is missing', async () => {
  assert.equal(await isMissingRouteResponse(new Response('404 Not Found', { status: 404 })), true);
  assert.equal(await isMissingRouteResponse(new Response('', { status: 405 })), true);
});

test('a handler 404 with a JSON error is not a missing route', async () => {
  const res = new Response(JSON.stringify({ error: 'Session not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(await isMissingRouteResponse(res), false);
  // The body is still readable for the caller's error message.
  assert.equal((await res.json()).error, 'Session not found');
});

test('successful and other error responses are not missing routes', async () => {
  assert.equal(await isMissingRouteResponse(new Response('{}', { status: 200 })), false);
  assert.equal(await isMissingRouteResponse(new Response('x', { status: 431 })), false);
});

test('GET fallback query carries cursor, file and tail', () => {
  const q = new URLSearchParams(jsonlDeltaQuery('abc_-', { fileFilter: 'agent-1.jsonl', tail: 500 }));
  assert.equal(q.get('cursor'), 'abc_-');
  assert.equal(q.get('file'), 'agent-1.jsonl');
  assert.equal(q.get('tail'), '500');
  assert.equal(new URLSearchParams(jsonlDeltaQuery('init', { tail: 0 })).has('tail'), false);
});
