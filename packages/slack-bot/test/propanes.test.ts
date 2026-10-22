import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPropanesFetch } from '../src/propanes';

test('requires a ProPanes credential before making any request', () => {
  assert.throws(() => createPropanesFetch('http://localhost:3001', undefined), /PROPANES_TOKEN/);
});

test('authenticates API requests without dropping caller headers or JSON body', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, 'http://localhost:3001/api/v1/admin/dispatch');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer fixture-token');
    assert.equal(headers.get('X-Request-ID'), 'fixture');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{"feedbackId":"fixture"}');
    assert.ok(init?.signal);
    return new Response('{"sessionId":"session"}', { status: 200 });
  };
  const request = createPropanesFetch('http://localhost:3001', 'fixture-token', fakeFetch);
  assert.deepEqual(await request('/api/v1/admin/dispatch', {
    method: 'POST', headers: { 'X-Request-ID': 'fixture' }, body: '{"feedbackId":"fixture"}',
  }), { sessionId: 'session' });
});

test('API errors contain status, not credentials or response bodies', async () => {
  const request = createPropanesFetch('http://localhost:3001', 'fixture-token', async () =>
    new Response('private response body', { status: 401 }));
  await assert.rejects(request('/api/v1/admin/agents'), error => {
    assert.match(String(error), /401/);
    assert.doesNotMatch(String(error), /fixture-token|private response body/);
    return true;
  });
});
