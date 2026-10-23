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

test('target discovery and terminal creation use authenticated admin routes and preserve resolved IDs', async () => {
  const { createPropanesClient } = await import('../src/propanes');
  const requests: Array<{ path: string; body: unknown }> = [];
  const api = createPropanesFetch('https://propanes.example.test', 'fixture-token', async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const response = path.endsWith('/applications') ? [{ id: 'app-2', name: 'Storefront' }]
      : path.endsWith('/launchers') ? { launchers: [{ id: 'mac-1', name: 'MacBook', online: true }] }
      : { sessionId: 'S1' };
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const client = createPropanesClient(api);
  assert.equal((await client.listApplications())[0].id, 'app-2');
  assert.equal((await client.listInfra())[0].id, 'mac-1');
  assert.deepEqual(await client.createTerminal({ appId: 'app-2', launcherId: 'mac-1', permissionProfile: 'plain' }), { sessionId: 'S1' });
  await client.dispatch({ feedbackId: 'F1', agentEndpointId: 'A1', instructions: 'go', permissionProfile: 'interactive-yolo', launcherId: 'mac-1' });
  assert.deepEqual(requests.map(r => r.path), ['/api/v1/admin/applications', '/api/v1/admin/launchers', '/api/v1/admin/terminal', '/api/v1/admin/dispatch']);
  assert.deepEqual(requests[2].body, { appId: 'app-2', launcherId: 'mac-1', permissionProfile: 'plain' });
  assert.equal((requests[3].body as { launcherId: string }).launcherId, 'mac-1');
});

test('terminal API responses without a session ID are rejected', async () => {
  const { createPropanesClient } = await import('../src/propanes');
  const client = createPropanesClient(createPropanesFetch('https://propanes.example.test', 'fixture-token', async () => new Response('{}')));
  await assert.rejects(client.createTerminal({ permissionProfile: 'plain' }), /did not return a session id/);
});
