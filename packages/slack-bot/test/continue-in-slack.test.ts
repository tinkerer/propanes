import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StateRepo } from '../src/state';
import { APP, fixture, line, mention, sessionUrl, threadReply } from './helpers';

/** A session started in ProPanes (not by the bot), with some history. */
function outsideSession(f: ReturnType<typeof fixture>, runtime = 'claude') {
  const s = f.world.newSession('F9', runtime);
  s.appId = APP;
  s.title = 'Refactor the poller';
  s.permissionProfile = 'interactive-require';
  s.lines.push(line.user('refactor it'), line.assistant('Old progress note'), line.assistant('Done: <cos-reply>refactored</cos-reply>'));
  return s;
}

test('[sessions] then a number moves that session into its own thread without re-posting history', async () => {
  const f = fixture();
  const other = f.world.newSession('F1', 'codex');
  other.appId = 'app-atlas';
  const s = outsideSession(f);
  await f.bridge.handleEvent(mention('[sessions]'));
  const listing = f.slack.texts().join('\n');
  assert.match(listing, /Reply with the number to continue the session in Slack/);
  // Grouped by app: Atlas first (S1), then Admin Console (S2).
  assert.ok(listing.indexOf(`1. <${sessionUrl(other.id)}|`) >= 0);
  assert.ok(listing.indexOf(`2. <${sessionUrl(s.id)}|`) >= 0);

  await f.bridge.handleEvent(threadReply('2'));
  const repo = new StateRepo(f.store);
  const moved = repo.threads().find(t => t.sessionId === s.id)!;
  assert.ok(moved, 'thread bound to the chosen session');
  assert.notEqual(moved.threadTs, '100.000');
  assert.equal(moved.appId, APP);
  assert.equal(moved.permissionProfile, 'interactive-require');
  const intro = f.slack.posts.find(p => p.thread_ts === moved.threadTs)!.text;
  assert.match(intro, /Continuing <.*\|`S2`> in Slack/);
  assert.match(intro, /Latest reply\*\nDone: refactored/);
  assert.ok(f.slack.texts().some(t => t.startsWith('New thread: <https://slack.example.test/')));
  // Nothing was dispatched, resumed or forked.
  assert.equal(f.world.calls.length, 0);

  // Replies in the new thread reach the live session; history is never re-posted.
  await f.bridge.handleEvent(threadReply('now add tests', { threadTs: moved.threadTs! }));
  assert.ok(f.world.calls.includes('send-keys:S2:now add tests'));
  await f.bridge.drain();
  assert.ok(!f.slack.texts().some(t => t.includes('Old progress note')));

  // The number menu was consumed: a second "2" in the source is an ordinary prompt.
  await f.bridge.handleEvent(threadReply('2'));
  assert.equal(new StateRepo(f.store).threads().filter(t => t.sessionId === s.id).length, 1);
  await f.bridge.drain();
});

test('out-of-range and expired numbers explain themselves; a stopped session resumes with its own profile', async () => {
  const f = fixture();
  const s = outsideSession(f, 'codex');
  await f.bridge.handleEvent(mention('[sessions]'));
  await f.bridge.handleEvent(threadReply('7'));
  assert.match(f.slack.texts().at(-1)!, /Choose a number from 1 to 1/);
  f.clock.now += 11 * 60_000;
  await f.bridge.handleEvent(threadReply('1'));
  assert.match(f.slack.texts().at(-1)!, /session list expired/);

  await f.bridge.handleEvent(threadReply('[sessions]'));
  s.status = 'completed';
  await f.bridge.handleEvent(threadReply('1'));
  const moved = new StateRepo(f.store).threads().find(t => t.sessionId === s.id)!;
  assert.equal(moved.runtime, 'codex');
  assert.equal(moved.watching, false);
  await f.bridge.handleEvent(threadReply('continue please', { threadTs: moved.threadTs! }));
  assert.ok(f.world.calls.includes('resume-profile:S1:interactive-require'));
  await f.bridge.drain();
});

test('a session already in a Slack thread points there instead of opening another', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('original task'));
  await f.bridge.handleEvent(mention('[sessions]', { ts: '300.000' }));
  await f.bridge.handleEvent(threadReply('1', { threadTs: '300.000' }));
  assert.match(f.slack.texts().at(-1)!, /already continues in <https:\/\/slack\.example\.test\/archives\/C1\/p100000\|this thread>/);
  assert.equal(new StateRepo(f.store).threads().length, 1);
  await f.bridge.drain();
});

test('admin handoffs open a thread in the configured channel and report the permalink', async () => {
  const f = fixture({ config: { handoffChannel: 'D-AMIR' } });
  const s = outsideSession(f);
  await f.bridge.handleHandoff({ id: 'H1', sessionId: s.id, requestedBy: 'env-admin' });
  const moved = new StateRepo(f.store).threads()[0];
  assert.equal(moved.channel, 'D-AMIR');
  assert.equal(f.world.handoffResults.length, 1);
  assert.equal(f.world.handoffResults[0].ok, true);
  assert.match(f.world.handoffResults[0].permalink!, /archives\/D-AMIR\//);

  await f.bridge.handleHandoff({ id: 'H2', sessionId: 'missing', requestedBy: 'env-admin' });
  assert.equal(f.world.handoffResults[1].ok, false);
  await f.bridge.drain();
});

test('a handoff with no configured channel and no prior conversation fails with guidance', async () => {
  const f = fixture();
  const s = outsideSession(f);
  await f.bridge.handleHandoff({ id: 'H1', sessionId: s.id, requestedBy: 'env-admin' });
  assert.equal(f.world.handoffResults[0].ok, false);
  assert.match(f.world.handoffResults[0].message, /AMIROBOT_HANDOFF_CHANNEL/);
  assert.equal(f.slack.posts.length, 0);
});
