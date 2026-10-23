import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPortalSession, fetchPortalSession, resolvePortalConfig } from '../src/auth-portal.ts';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-auth-portal-test-'));
const configPath = join(tempDir, 'config.json');
const missingPath = join(tempDir, 'missing.json');
const WS = 'wss://server.example.test/ws/launcher';

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('no token and no CLI config means no portal auth', () => {
  assert.equal(resolvePortalConfig(WS, {}, missingPath), null);
});

test('env token + url target the server host; host and cookie name are overridable', () => {
  assert.deepEqual(
    resolvePortalConfig(WS, { PROPANES_PORTAL_TOKEN: 'tok', PROPANES_PORTAL_URL: 'https://portal.example.test/' }, missingPath),
    { url: 'https://portal.example.test', token: 'tok', host: 'server.example.test' },
  );
  assert.deepEqual(
    resolvePortalConfig(WS, { PROPANES_PORTAL_TOKEN: 'tok', PROPANES_PORTAL_URL: 'https://portal.example.test', PROPANES_PORTAL_HOST: 'alias.example.test', PROPANES_PORTAL_COOKIE: 'sid' }, missingPath),
    { url: 'https://portal.example.test', token: 'tok', host: 'alias.example.test', cookie: 'sid' },
  );
  assert.throws(() => resolvePortalConfig(WS, { PROPANES_PORTAL_TOKEN: 'tok' }, missingPath), /PROPANES_PORTAL_URL/);
});

test('falls back to the portal login the CLI stored for the server origin', () => {
  writeFileSync(configPath, JSON.stringify({
    servers: {
      'https://server.example.test': {
        token: 'jwt',
        portal: { url: 'https://portal.example.test', token: 'cfg-tok', host: 'server.example.test', cookie: 'sid' },
      },
    },
  }));
  assert.deepEqual(
    resolvePortalConfig(WS, {}, configPath),
    { url: 'https://portal.example.test', token: 'cfg-tok', host: 'server.example.test', cookie: 'sid' },
  );
  assert.equal(resolvePortalConfig('ws://localhost:3001/ws/launcher', {}, configPath), null);
});

function fakePortal(opts: { sessionStatus?: number; setCookie?: string[] } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/cli/session')) {
      const status = opts.sessionStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { sso_url: 'https://h/sso/callback?token=t' } : { error: 'invalid_token' }), { status });
    }
    const headers = new Headers();
    for (const c of opts.setCookie ?? ['sid=abc; Path=/; Max-Age=7200; HttpOnly', 'tid=t1; Path=/']) {
      headers.append('set-cookie', c);
    }
    return new Response(null, { status: 302, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const cfg = { url: 'https://portal', token: 'tok', host: 'server.example.test', cookie: 'sid' };

test('exchanges the portal token for the host session cookies', async () => {
  const { impl, calls } = fakePortal();
  const before = Date.now();
  const s = await fetchPortalSession(cfg, impl);
  assert.equal(s.cookie, 'sid=abc; tid=t1');
  assert.ok(s.expiresAt >= before + 3600_000 && s.expiresAt <= Date.now() + 3600_000);
  assert.equal(calls[0].url, 'https://portal/auth/cli/session');
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { host: 'server.example.test' });
  assert.equal(calls[1].init?.redirect, 'manual');
});

test('without a configured cookie name the first cookie is the session', async () => {
  const { impl } = fakePortal({ setCookie: ['anything=1; Max-Age=600', 'tid=t'] });
  const s = await fetchPortalSession({ ...cfg, cookie: undefined }, impl);
  assert.equal(s.cookie, 'anything=1; tid=t');
  assert.ok(s.expiresAt <= Date.now() + 600_000);
});

test('a rejected token surfaces the portal error', async () => {
  const { impl } = fakePortal({ sessionStatus: 401 });
  await assert.rejects(fetchPortalSession(cfg, impl), /401 invalid_token/);
});

test('a callback without the session cookie is an error', async () => {
  const { impl } = fakePortal({ setCookie: ['other=1'] });
  await assert.rejects(fetchPortalSession(cfg, impl), /no sid cookie/);
  const bare = fakePortal({ setCookie: [] });
  await assert.rejects(fetchPortalSession({ ...cfg, cookie: undefined }, bare.impl), /no cookie/);
});

test('session cookie is cached until invalidated', async () => {
  const { impl, calls } = fakePortal();
  const session = createPortalSession(cfg, impl);
  await session.cookie();
  await session.cookie();
  assert.equal(calls.length, 2);
  session.invalidate();
  await session.cookie();
  assert.equal(calls.length, 4);
});
