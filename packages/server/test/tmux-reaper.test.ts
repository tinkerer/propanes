import test from 'node:test';
import assert from 'node:assert/strict';

const { planTmuxReap, TERMINAL_SESSION_STATUSES } = await import('../src/tmux-reaper.ts');

const NOW = 10_000_000;
const MIN_AGE = 10 * 60_000;

function sess(sessionId: string, ageMs: number, attached = false) {
  return { sessionId, createdAt: NOW - ageMs, attached };
}

function plan(
  tmuxSessions: ReturnType<typeof sess>[],
  statuses: Record<string, string>,
  extra: Partial<{ active: string[]; parked: string[] }> = {},
) {
  const active = new Set(extra.active ?? []);
  const parked = new Set(extra.parked ?? []);
  return planTmuxReap({
    tmuxSessions,
    lookupStatus: (id) => (id in statuses ? statuses[id] : null),
    isActive: (id) => active.has(id),
    isParked: (id) => parked.has(id),
    now: NOW,
    minAgeMs: MIN_AGE,
  });
}

test('reaps unattached old sessions whose row is terminal or missing', () => {
  const out = plan(
    [sess('killed1', 2 * MIN_AGE), sess('done1', 2 * MIN_AGE), sess('failed1', 2 * MIN_AGE), sess('gone1', 2 * MIN_AGE)],
    { killed1: 'killed', done1: 'completed', failed1: 'failed' },
  );
  assert.deepEqual(
    out.map((c) => [c.sessionId, c.reason]),
    [['killed1', 'killed'], ['done1', 'completed'], ['failed1', 'failed'], ['gone1', 'missing-row']],
  );
  assert.equal(out[0].ageMs, 2 * MIN_AGE);
});

test('leaves running, pending and idle rows alone', () => {
  const out = plan(
    [sess('r', 2 * MIN_AGE), sess('p', 2 * MIN_AGE), sess('i', 2 * MIN_AGE)],
    { r: 'running', p: 'pending', i: 'idle' },
  );
  assert.deepEqual(out, []);
  for (const s of ['running', 'pending', 'idle']) assert.equal(TERMINAL_SESSION_STATUSES.has(s), false);
});

test('never touches a session with a client attached', () => {
  // Attached = some session-service (this one or another instance on the
  // same tmux socket) or an operator is driving it, whatever the row says.
  const out = plan([sess('k', 2 * MIN_AGE, true), sess('m', 2 * MIN_AGE, true)], { k: 'killed' });
  assert.deepEqual(out, []);
});

test('never touches a session this process owns or is still recovering', () => {
  const out = plan(
    [sess('owned', 2 * MIN_AGE), sess('parked', 2 * MIN_AGE)],
    { owned: 'killed' },
    { active: ['owned'], parked: ['parked'] },
  );
  assert.deepEqual(out, []);
});

test('waits for the minimum age so a session being created is not raced', () => {
  const out = plan(
    [sess('young', MIN_AGE - 1), sess('exact', MIN_AGE), sess('unknownAge', NOW)],
    {},
  );
  // Only the exact-age and the one whose createdAt is 0 (unparseable) pass;
  // the young one is left for the next sweep.
  assert.deepEqual(out.map((c) => c.sessionId), ['exact', 'unknownAge']);
});

test('planning is read-only: it reports, the caller kills', () => {
  let lookups = 0;
  const out = planTmuxReap({
    tmuxSessions: [sess('a', 2 * MIN_AGE), sess('b', 0)],
    lookupStatus: () => { lookups++; return 'killed'; },
    isActive: () => false,
    isParked: () => false,
    now: NOW,
    minAgeMs: MIN_AGE,
  });
  assert.equal(out.length, 1);
  // The too-young session is rejected before the DB is consulted.
  assert.equal(lookups, 1);
});
