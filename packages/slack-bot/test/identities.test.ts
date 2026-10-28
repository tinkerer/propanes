import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityDirectory } from '../src/identities';
import { createPropanesFetch } from '../src/propanes';

function server(opts: { status?: number } = {}) {
  const calls: string[] = [];
  const clock = { now: 1_000_000 };
  let identities = [{ userId: 'u-alice', username: 'alice', role: 'member', slackUserId: 'UALICE', persona: null }];
  let minted = 0;
  const api = createPropanesFetch('http://propanes.test', 'operator-token', async (url, init) => {
    const path = String(url).replace('http://propanes.test', '');
    calls.push(`${init?.method ?? 'GET'} ${path} ${new Headers(init?.headers).get('Authorization')}`);
    if (opts.status) return new Response('{}', { status: opts.status });
    if (path === '/api/v1/admin/slack-identities') return Response.json({ identities });
    const m = path.match(/slack-identities\/([^/]+)\/token$/);
    if (m) {
      minted++;
      return Response.json({ token: `tok-${m[1]}-${minted}`, expiresAt: new Date(clock.now + 48 * 3600_000).toISOString() });
    }
    return new Response('{}', { status: 404 });
  });
  const dir = new IdentityDirectory(api, { now: () => clock.now, minRefreshGapMs: 15_000 });
  return { dir, calls, clock, setIdentities: (rows: typeof identities) => { identities = rows; } };
}

test('lookup re-reads the list for unknown members, at most once per gap', async () => {
  const s = server();
  await s.dir.refresh();
  assert.equal((await s.dir.lookup('UALICE'))?.username, 'alice');
  assert.equal(await s.dir.lookup('UBOB'), undefined);
  assert.equal(s.calls.length, 1, 'the refresh just happened; no second read');
  s.setIdentities([{ userId: 'u-bob', username: 'bob', role: 'member', slackUserId: 'UBOB', persona: null }]);
  s.clock.now += 20_000;
  assert.equal((await s.dir.lookup('UBOB'))?.username, 'bob');
  assert.equal(await s.dir.lookup(undefined), undefined);
});

test('tokens are minted once, shared by concurrent callers and renewed near expiry', async () => {
  const s = server();
  await s.dir.refresh();
  const [a, b] = await Promise.all([s.dir.token('u-alice'), s.dir.token('u-alice')]);
  assert.equal(a, 'tok-u-alice-1');
  assert.equal(b, a);
  s.clock.now += 30 * 3600_000; // 18 h left: still fresh
  assert.equal(await s.dir.token('u-alice'), a);
  s.clock.now += 8 * 3600_000; // 10 h left: renew
  assert.equal(await s.dir.token('u-alice'), 'tok-u-alice-2');
  assert.ok(s.calls.every((c) => c.endsWith('Bearer operator-token')), 'minting uses the operator credential');
});

test('a member client authenticates with the minted token', async () => {
  const s = server();
  const seen: string[] = [];
  const member = createPropanesFetch('http://propanes.test', () => s.dir.token('u-alice'), async (_u, init) => {
    seen.push(new Headers(init?.headers).get('Authorization') ?? '');
    return Response.json({ ok: true });
  });
  await member('/api/v1/admin/applications');
  assert.deepEqual(seen, ['Bearer tok-u-alice-1']);
});

test('a non-operator token disables links instead of failing', async () => {
  const s = server({ status: 403 });
  await s.dir.refresh();
  assert.equal(s.dir.enabled, false);
  assert.equal(await s.dir.lookup('UALICE'), undefined);
  assert.equal(s.calls.length, 1);
});
