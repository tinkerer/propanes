import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlertInvestigator, alertSignature, parseAlertWatches, type AlertMessage, type AlertWatch } from '../src/alert-investigations';
import { StateRepo, threadKey } from '../src/state';
import { APP, fixture, sessionUrl } from './helpers';

const CHANNEL = 'CALERTS';
const HOUR = 60 * 60_000;
const BOT = 'B1';
const FAILED = 'Workbench recovery backup check failed: workbench-backup.service';

const WATCH: AlertWatch = { channel: CHANNEL, match: /^Workbench recovery backup (check failed|alert):/, app: 'Admin Console', task: 'Follow the runbook.', cooldownMs: 24 * HOUR, maxPerDay: 2 };

function setup(watch: AlertWatch = WATCH) {
  const f = fixture();
  const log: string[] = [];
  const channel: AlertMessage[] = [];
  const clock = { now: 1_000_000 * 1000 };
  let historyError: Error | undefined;
  const investigator = new AlertInvestigator({
    watches: [watch],
    history: async (_channel, oldest) => {
      if (historyError) throw historyError;
      return channel.filter((m) => parseFloat(m.ts) > parseFloat(oldest)).reverse();
    },
    bridge: f.bridge,
    propanes: f.world.propanes,
    state: f.state,
    post: (args) => f.slack.postMessage(args),
    permalink: (c, ts) => f.slack.permalink(c, ts),
    sessionUrl: (id) => f.bridge.sessionUrl(id),
    botId: BOT,
    teamId: 'T1',
    log: (message) => log.push(message),
    now: () => clock.now,
  });
  let seq = 0;
  const alert = (text: string, over: Partial<AlertMessage> = {}) => {
    const message: AlertMessage = { ts: `${(clock.now / 1000 + ++seq).toFixed(6)}`, text, bot_id: BOT, ...over };
    channel.push(message);
    return message;
  };
  const failHistory = (err?: Error) => { historyError = err; };
  return { ...f, investigator, clock, alert, log, failHistory };
}

async function armed(watch?: AlertWatch) {
  const s = setup(watch);
  await s.investigator.pollOnce();
  return s;
}

test('an alert becomes a ticket and session rooted on the alert', async () => {
  const s = await armed();
  const tickets: Array<{ title: string; description: string; appId: string; tags?: string[] }> = [];
  const createFeedback = s.world.propanes.createFeedback;
  s.world.propanes.createFeedback = (input) => { tickets.push(input); return createFeedback(input); };
  const message = s.alert(FAILED);
  await s.investigator.pollOnce();

  assert.equal(s.world.sessions.size, 1);
  assert.equal(tickets.length, 1);
  assert.match(tickets[0].title, /workbench-backup\.service/);
  assert.match(tickets[0].description, /Follow the runbook\./);
  assert.equal(tickets[0].appId, APP);
  assert.deepEqual(tickets[0].tags, ['slack', 'amirobot', 'backup-alert']);

  const reply = s.slack.posts.find((p) => p.text.includes(sessionUrl('S1')));
  assert.ok(reply, 'the thread links the session');
  assert.equal(reply.thread_ts, message.ts);
  assert.deepEqual(s.slack.reactions.map((r) => r.timestamp), [message.ts]);
  assert.ok(s.state.getThread(threadKey('T1', CHANNEL, message.ts)));
});

test('alerts from before the first run are not investigated', async () => {
  const s = setup();
  s.clock.now -= HOUR;
  s.alert(FAILED);
  s.clock.now += HOUR;
  await s.investigator.pollOnce();
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 0);
  assert.equal(s.slack.posts.length, 0);
});

test('only top-level matching posts by this bot under its own name are alerts', async () => {
  const s = await armed();
  s.alert(FAILED, { bot_id: 'B-other' });
  s.alert(FAILED, { bot_id: undefined });
  s.alert(FAILED, { username: 'someone' });
  s.alert(FAILED, { subtype: 'thread_broadcast' });
  s.alert(`[TEST] ${FAILED}`);
  s.alert('Looks like Workbench recovery backup check failed: x');
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 0);
  assert.equal(s.slack.posts.length, 0);
});

test('an alert during a running investigation joins it instead of starting another', async () => {
  const s = await armed();
  s.alert(FAILED);
  await s.investigator.pollOnce();
  s.world.session('S1').status = 'running';
  const second = s.alert('Workbench recovery backup alert: core:stale-dataset:x. Recovery region: West US 2.');
  await s.investigator.pollOnce();

  assert.equal(s.world.sessions.size, 1);
  assert.ok(s.world.calls.some((c) => c.startsWith('send-keys:S1:') && c.includes('core:stale-dataset:x')), 'the session received it');
  const note = s.slack.posts.find((p) => p.thread_ts === second.ts)!;
  assert.match(note.text, /Added to the running investigation/);
  assert.ok(note.text.includes(sessionUrl('S1')));
});

test('a repeat after the investigation ended waits out the cooldown, then runs again', async () => {
  const s = await armed();
  s.alert(FAILED);
  await s.investigator.pollOnce();
  await s.bridge.drain();
  s.world.session('S1').status = 'completed';

  s.clock.now += 6 * HOUR;
  const repeat = s.alert(FAILED);
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 1);
  const note = s.slack.posts.find((p) => p.thread_ts === repeat.ts)!;
  assert.match(note.text, /Same failure/);
  assert.match(note.text, /still not fixed/);

  s.clock.now += 19 * HOUR;
  s.alert(FAILED);
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 2);
});

test('an investigation whose session is gone does not block a new failure', async () => {
  const s = await armed();
  s.alert(FAILED);
  await s.investigator.pollOnce();
  await s.bridge.drain();
  s.world.sessions.delete('S1');
  s.alert('Workbench recovery backup check failed: other.service');
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 1);
  assert.equal(s.world.latest().id, 'S2');
});

test('a different failure after the last one ended gets its own ticket until the daily limit', async () => {
  const s = await armed();
  for (const unit of ['a', 'b']) {
    s.alert(`Workbench recovery backup check failed: ${unit}.service`);
    await s.investigator.pollOnce();
    await s.bridge.drain();
    s.world.latest().status = 'completed';
  }
  assert.equal(s.world.sessions.size, 2);

  const capped = s.alert('Workbench recovery backup check failed: c.service');
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 2);
  assert.match(s.slack.posts.find((p) => p.thread_ts === capped.ts)!.text, /limit of 2 per day/);

  s.clock.now += 25 * HOUR;
  s.alert('Workbench recovery backup check failed: d.service');
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 3);
});

test('a restart neither repeats a handled alert nor forgets the cooldown', async () => {
  const s = await armed();
  const first = s.alert(FAILED);
  await s.investigator.pollOnce();
  await s.bridge.drain();
  s.world.session('S1').status = 'completed';
  const repeat = s.alert(FAILED);

  const seen: string[] = [];
  const restarted = new AlertInvestigator({
    watches: [WATCH],
    history: async (_channel, oldest) => {
      seen.push(oldest);
      return [repeat];
    },
    bridge: s.bridge,
    propanes: s.world.propanes,
    state: new StateRepo(s.store),
    post: (args) => s.slack.postMessage(args),
    permalink: (c, ts) => s.slack.permalink(c, ts),
    sessionUrl: (id) => s.bridge.sessionUrl(id),
    botId: BOT,
    teamId: 'T1',
    log: () => undefined,
    now: () => s.clock.now,
  });
  await restarted.pollOnce();
  assert.deepEqual(seen, [first.ts]);
  assert.equal(s.world.sessions.size, 1);
  assert.match(s.slack.posts.find((p) => p.thread_ts === repeat.ts)!.text, /Same failure/);
});

test('a dispatch failure is retried on the next poll', async () => {
  const s = await armed();
  const dispatch = s.world.propanes.dispatch;
  let failures = 0;
  s.world.propanes.dispatch = async () => { failures++; throw new Error('server down'); };
  const message = s.alert(FAILED);

  await s.investigator.pollOnce();
  await s.investigator.pollOnce();
  assert.equal(failures, 2);
  assert.equal(s.slack.posts.filter((p) => p.thread_ts === message.ts).length, 0);

  s.world.propanes.dispatch = dispatch;
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 1, 'the retry succeeds once the server is back');
  assert.ok(s.state.getThread(threadKey('T1', CHANNEL, message.ts)));
});

test('an alert that keeps failing stops blocking the channel', async () => {
  const s = await armed();
  s.world.propanes.dispatch = async () => { throw new Error('server down'); };
  const message = s.alert(FAILED);
  for (let i = 0; i < 3; i++) await s.investigator.pollOnce();
  assert.match(s.slack.posts.find((p) => p.thread_ts === message.ts)!.text, /needs a person/);
  assert.ok(s.log.some((l) => l.includes(message.ts)));
  const saved = s.state.getAlertWatch(CHANNEL)!;
  assert.equal(saved.cursor, message.ts);
});

test('a history failure is logged once per streak and keeps the cursor', async () => {
  const s = await armed();
  const before = s.state.getAlertWatch(CHANNEL)!.cursor;
  s.failHistory(new Error('ratelimited'));
  await s.investigator.pollOnce();
  await s.investigator.pollOnce();
  assert.equal(s.log.filter((l) => l.includes('failed')).length, 1);
  assert.equal(s.state.getAlertWatch(CHANNEL)!.cursor, before);
  s.failHistory();
  await s.investigator.pollOnce();
  assert.ok(s.log.some((l) => l.includes('recovered')));
});

test('an unknown application is reported in the thread and starts nothing', async () => {
  const s = await armed({ ...WATCH, app: 'no-such-app-at-all' });
  const message = s.alert(FAILED);
  await s.investigator.pollOnce();
  assert.equal(s.world.sessions.size, 0);
  assert.ok(s.slack.posts.some((p) => p.thread_ts === message.ts));
  assert.equal(s.state.getAlertWatch(CHANNEL)!.cursor, message.ts);
});

test('the signature ignores order, case and spacing but not content', () => {
  assert.equal(alertSignature('Alert: a, b'), alertSignature('alert:  a,b'));
  assert.equal(alertSignature('x, y'), alertSignature('y, x'));
  assert.notEqual(alertSignature('Alert: a'), alertSignature('Alert: b'));
});

test('watch parsing rejects anything it cannot apply narrowly', () => {
  const log: string[] = [];
  const parse = (raw: string | undefined) => parseAlertWatches(raw, (m) => log.push(m));
  assert.deepEqual(parse(undefined), []);
  assert.deepEqual(parse('not json'), []);
  assert.deepEqual(parse('{}'), []);
  assert.deepEqual(parse(JSON.stringify([{ channel: 'C1', match: 'unanchored', task: 't' }])), []);
  assert.deepEqual(parse(JSON.stringify([{ channel: 'nope', match: '^x', task: 't' }])), []);
  assert.deepEqual(parse(JSON.stringify([{ channel: 'C1', match: '^(', task: 't' }])), []);
  assert.deepEqual(parse(JSON.stringify([{ channel: 'C1', match: '^x', task: ' ' }])), []);
  assert.equal(log.length, 6);

  const [watch] = parse(JSON.stringify([{ channel: 'C1', match: '^x', task: ' t ', app: 'A', cooldownHours: 2, maxPerDay: 3 }]));
  assert.equal(watch.task, 't');
  assert.equal(watch.app, 'A');
  assert.equal(watch.cooldownMs, 2 * HOUR);
  assert.equal(watch.maxPerDay, 3);
  const [defaults] = parse(JSON.stringify([{ channel: 'C1', match: '^x', task: 't' }]));
  assert.equal(defaults.cooldownMs, 24 * HOUR);
  assert.equal(defaults.maxPerDay, 6);
});
