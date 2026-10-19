import test from 'node:test';
import assert from 'node:assert/strict';
import { adminHealthUrl, probeAdminUrl } from '../src/machine-admin-probe.js';

function fakeFetch(res: Response | Error) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('adminHealthUrl resolves the health route next to the admin path, keeping base paths', () => {
  assert.equal(adminHealthUrl('https://vm.example.com/admin/'), 'https://vm.example.com/api/v1/health');
  assert.equal(adminHealthUrl('http://dl:3010/admin'), 'http://dl:3010/api/v1/health');
  assert.equal(adminHealthUrl('https://pods.example.com/alice/admin/'), 'https://pods.example.com/alice/api/v1/health');
});

test('a 2xx health response is alive and redirects are not followed', async () => {
  const { impl, calls } = fakeFetch(new Response('{"status":"ok"}', { status: 200 }));
  assert.deepEqual(await probeAdminUrl('https://vm.example.com/admin/', impl), { alive: true, status: 200 });
  assert.equal(calls[0].init?.redirect, 'manual');
});

test('a gateway redirect is reported as gated, not alive', async () => {
  const { impl } = fakeFetch(new Response(null, {
    status: 302,
    headers: { location: 'https://sso.example.com/login?return_to=x' },
  }));
  assert.deepEqual(await probeAdminUrl('https://vm.example.com/admin/', impl), {
    alive: false, gated: true, status: 302, reason: 'redirected to sso.example.com',
  });
});

test('error statuses and network failures are dead', async () => {
  assert.deepEqual(await probeAdminUrl('https://vm.example.com/admin/', fakeFetch(new Response('', { status: 502 })).impl), { alive: false, status: 502 });
  assert.deepEqual(await probeAdminUrl('https://vm.example.com/admin/', fakeFetch(new Error('ECONNREFUSED')).impl), { alive: false, reason: 'ECONNREFUSED' });
});
