import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'propanes-policy-'));
process.env.PROPANES_ACCESS_POLICY_FILE = join(dir, 'policy.json');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

process.env.PROPANES_ALLOWED_IPS = '203.0.113.10';
process.env.PROPANES_TRUSTED_PROXIES = '127.0.0.1/32,::1/128,172.18.0.0/16';
const { enforceIpAllowlist } = await import('../src/access-control.ts');
const app = new Hono();
app.use('*', enforceIpAllowlist);
app.get('/api/test', (c) => c.json({ error: 'Unauthorized' }, 401));

async function status(peer: string, forwarded?: string) {
  const headers: Record<string, string> = {};
  if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded;
  const res = await app.fetch(new Request('http://localhost/api/test', { headers }), {
    incoming: { socket: { remoteAddress: peer } },
  });
  return res.status;
}

test('direct local agents reach bearer authentication over IPv4 and IPv6', async () => {
  for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    assert.equal(await status(peer), 401);
  }
});

test('loopback reverse proxy does not exempt a denied forwarded client', async () => {
  assert.equal(await status('127.0.0.1', '198.51.100.20'), 403);
  assert.equal(await status('::1', '198.51.100.20, 127.0.0.1'), 403);
  assert.equal(await status('127.0.0.1', '127.0.0.1'), 403);
});

test('allowed public clients still reach bearer authentication', async () => {
  assert.equal(await status('203.0.113.10'), 401);
  assert.equal(await status('172.18.0.3', '203.0.113.10, 127.0.0.1'), 401);
});

test('remote callers cannot claim to be local using forwarded headers', async () => {
  assert.equal(await status('198.51.100.20', '127.0.0.1'), 403);
  assert.equal(await status('172.18.0.3', '127.0.0.1'), 403);
  assert.equal(await status('198.51.100.20'), 403);
});


test('runtime policy pauses the IP check, keeps auth, expires, and updates without restart', async () => {
  const file = process.env.PROPANES_ACCESS_POLICY_FILE!;
  const policy = { version: 1, allowed_ips: ['198.51.100.30'], disabled_until: Date.now() / 1000 + 60 };
  try {
    writeFileSync(file, JSON.stringify(policy));
    assert.equal(await status('198.51.100.20'), 401);
    policy.disabled_until = Date.now() / 1000 - 1;
    writeFileSync(file, JSON.stringify(policy));
    assert.equal(await status('198.51.100.20'), 403);
    assert.equal(await status('198.51.100.30'), 401);
    assert.equal(await status('203.0.113.10'), 403);
    policy.allowed_ips = ['203.0.113.10'];
    writeFileSync(file, JSON.stringify(policy));
    assert.equal(await status('203.0.113.10'), 401);
  } finally { rmSync(file, { force: true }); }
});

test('corrupt, invalid and empty policies fail closed even during a pause', async () => {
  const file = process.env.PROPANES_ACCESS_POLICY_FILE!;
  try {
    for (const raw of ['{', 'null', JSON.stringify({ version: 1, allowed_ips: [], disabled_until: Date.now() / 1000 + 60 }),
        JSON.stringify({ version: 1, allowed_ips: ['1.2.3.4/32/junk'], disabled_until: 0 })]) {
      writeFileSync(file, raw);
      assert.equal(await status('203.0.113.10'), 403);
    }
  } finally { rmSync(file, { force: true }); }
});
