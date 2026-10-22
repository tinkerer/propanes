import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEdgeSession, DEFAULT_WB_EDGE, fetchEdgeSession, resolveEdgeConfig } from '../src/workbench-edge.ts';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-wb-edge-test-'));
const configPath = join(tempDir, 'config.json');
const missingPath = join(tempDir, 'missing.json');

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('no token and no CLI config means no edge auth', () => {
  assert.equal(resolveEdgeConfig('wss://propanes-vm.myworkbench.ai/ws/launcher', {}, missingPath), null);
});

test('WORKBENCH_CLI_TOKEN env targets the server host on the default edge', () => {
  assert.deepEqual(
    resolveEdgeConfig('wss://propanes-vm.myworkbench.ai/ws/launcher', { WORKBENCH_CLI_TOKEN: 'wbcli_x' }, missingPath),
    { token: 'wbcli_x', edge: DEFAULT_WB_EDGE, host: 'propanes-vm.myworkbench.ai' },
  );
});

test('falls back to the token stored by `propanes login --workbench`', () => {
  writeFileSync(configPath, JSON.stringify({
    servers: {
      'https://propanes-vm.myworkbench.ai': {
        token: 'jwt',
        workbench: { edge: 'https://edge.example', token: 'wbcli_cfg', host: 'propanes-vm.myworkbench.ai' },
      },
    },
  }));
  assert.deepEqual(
    resolveEdgeConfig('wss://propanes-vm.myworkbench.ai/ws/launcher', {}, configPath),
    { token: 'wbcli_cfg', edge: 'https://edge.example', host: 'propanes-vm.myworkbench.ai' },
  );
  assert.equal(resolveEdgeConfig('ws://localhost:3001/ws/launcher', {}, configPath), null);
});

function fakeEdge(opts: { sessionStatus?: number; setCookie?: string[] } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/auth/cli/session')) {
      const status = opts.sessionStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { sso_url: 'https://h/sso/callback?token=t' } : { error: 'invalid_token' }), { status });
    }
    const headers = new Headers();
    for (const c of opts.setCookie ?? ['wb_session=abc; Path=/; Max-Age=7200; HttpOnly', 'workbench_tid=t1; Path=/']) {
      headers.append('set-cookie', c);
    }
    return new Response(null, { status: 302, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const cfg = { token: 'wbcli_x', edge: 'https://edge', host: 'propanes-vm.myworkbench.ai' };

test('exchanges the CLI token for the host session cookies', async () => {
  const { impl, calls } = fakeEdge();
  const before = Date.now();
  const s = await fetchEdgeSession(cfg, impl);
  assert.equal(s.cookie, 'wb_session=abc; workbench_tid=t1');
  assert.ok(s.expiresAt >= before + 3600_000 && s.expiresAt <= Date.now() + 3600_000);
  assert.equal(calls[0].url, 'https://edge/auth/cli/session');
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer wbcli_x');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { host: 'propanes-vm.myworkbench.ai' });
  assert.equal(calls[1].init?.redirect, 'manual');
});

test('a rejected token surfaces the edge error', async () => {
  const { impl } = fakeEdge({ sessionStatus: 401 });
  await assert.rejects(fetchEdgeSession(cfg, impl), /401 invalid_token/);
});

test('a callback without wb_session is an error', async () => {
  const { impl } = fakeEdge({ setCookie: ['other=1'] });
  await assert.rejects(fetchEdgeSession(cfg, impl), /no wb_session/);
});

test('session cookie is cached until invalidated', async () => {
  const { impl, calls } = fakeEdge();
  const session = createEdgeSession(cfg, impl);
  await session.cookie();
  await session.cookie();
  assert.equal(calls.length, 2);
  session.invalidate();
  await session.cookie();
  assert.equal(calls.length, 4);
});
