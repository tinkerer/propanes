import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand } from '../src/options';
import { StateRepo } from '../src/state';
import { fixture, mention, threadReply } from './helpers';

for (const command of ['[infra]', '[terminals]', '[sessions]', '[apps]', '[list-infra]', '[list-terminals]', '[list-sessions]', '[list-apps]']) {
  test(`${command} replies without a mention in a sessionless thread after restart`, async () => {
    const first = fixture();
    await first.bridge.handleEvent(mention('[help]'));
    const f = fixture({ store: first.store });
    await f.bridge.handleEvent(threadReply(command));
    assert.ok(f.slack.posts.length > 0);
    assert.ok(f.slack.posts.every(p => p.thread_ts === '100.000'));
    assert.equal(f.world.sessions.size, 0);
    assert.equal(f.world.calls.length, 0);
  });
}

test('[session] parses with agent, mode and selectors but conflicts with terminal/list commands', () => {
  assert.deepEqual(parseCommand('[session codex quiet app:shop] explore another approach'), {
    command: 'prompt', session: true, runtime: 'codex', mode: 'quiet', app: 'shop', text: 'explore another approach',
  });
  assert.ok(parseCommand('[session terminal]').error);
  assert.ok(parseCommand('[session sessions]').error);
  assert.ok(parseCommand('[session help]').error);
});

for (const runtime of ['claude', 'codex'] as const) {
  test(`[session] forks a running ${runtime} conversation and independently routes both threads`, async () => {
    const f = fixture();
    f.steps.push(...Array.from({ length: 20 }, () => () => undefined));
    await f.bridge.handleEvent(mention(`[${runtime}] original task`));
    const event = threadReply('[session quiet] try another approach');
    await Promise.all([f.bridge.handleEvent(event), f.bridge.handleEvent(event)]);
    const repo = new StateRepo(f.store);
    const original = repo.getThread('T1:C1:100.000')!;
    const branch = repo.threads().find(t => t.sessionId !== original.sessionId)!;
    assert.equal(original.sessionId, 'S1');
    assert.equal(original.mode, 'default');
    assert.equal(branch.sessionId, 'S2');
    assert.equal(branch.mode, 'quiet');
    assert.equal(branch.runtime, runtime);
    assert.notEqual(branch.threadTs, original.threadTs);
    assert.equal(f.world.session('S1').status, 'running');
    assert.equal(f.world.calls.filter(c => c.startsWith('fork:')).length, 1);
    assert.ok(f.world.calls.some(c => c.startsWith('fork:S1:try another approach')));
    assert.ok(!f.world.calls.some(c => c.startsWith('kill:') || c.startsWith('resume:')));
    await f.bridge.handleEvent(threadReply('keep the original approach'));
    await f.bridge.handleEvent(threadReply('follow the branch', { threadTs: branch.threadTs! }));
    assert.ok(f.world.calls.some(c => c.startsWith('send-keys:S1:keep the original approach')));
    assert.ok(f.world.calls.some(c => c.startsWith('send-keys:S2:follow the branch')));
    await f.bridge.drain();
  });
}

test('[terminal] from a sessionless thread gets its own input routing and leaves listings in the source', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[help]'));
  await f.bridge.handleEvent(threadReply('[terminal]'));
  const terminal = new StateRepo(f.store).threads()[0];
  assert.equal(terminal.kind, 'terminal');
  assert.notEqual(terminal.threadTs, '100.000');
  await f.bridge.handleEvent(threadReply('pwd', { threadTs: terminal.threadTs! }));
  assert.ok(f.world.calls.includes('send-keys:S1:pwd'));
  const from = f.slack.posts.length;
  await f.bridge.handleEvent(threadReply('[apps]'));
  assert.ok(f.slack.posts.slice(from).every(p => p.thread_ts === '100.000'));
});

test('a failed Slack root never creates an agent or terminal', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[help]'));
  const post = f.slack.postMessage.bind(f.slack);
  f.slack.postMessage = async args => args.thread_ts ? post(args) : { ok: false, ts: '' };
  await f.bridge.handleEvent(threadReply('[session] do work'));
  await f.bridge.handleEvent(threadReply('[terminal]'));
  assert.equal(f.world.sessions.size, 0);
  assert.ok(f.slack.texts().some(t => /no session was started/.test(t)));
});

test('a failed fork and invalid target changes preserve the original thread mapping', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('original'));
  await f.bridge.drain();
  f.world.propanes.fork = async () => { throw new Error('native fork unavailable'); };
  await f.bridge.handleEvent(threadReply('[session] another approach'));
  await f.bridge.handleEvent(threadReply('[session codex] change runtime'));
  const repo = new StateRepo(f.store);
  assert.equal(repo.threads().length, 1);
  assert.equal(repo.getThread('T1:C1:100.000')!.sessionId, 'S1');
  assert.ok(f.slack.texts().some(t => /native fork unavailable/.test(t)));
  assert.ok(f.slack.texts().some(t => /inherits its agent, app and machine/.test(t)));
});

test('all listing commands stay in an active agent thread and do not reach its input', async () => {
  const f = fixture();
  f.steps.push(...Array.from({ length: 20 }, () => () => undefined));
  await f.bridge.handleEvent(mention('original task'));
  const beforeCalls = f.world.calls.slice();
  const from = f.slack.posts.length;
  for (const command of ['[infra]', '[apps]', '[sessions]', '[terminals]']) await f.bridge.handleEvent(threadReply(command));
  assert.deepEqual(f.world.calls, beforeCalls);
  assert.ok(f.slack.posts.slice(from).every(p => p.thread_ts === '100.000'));
  assert.equal(new StateRepo(f.store).getThread('T1:C1:100.000')!.sessionId, 'S1');
  await f.bridge.drain();
});

test('[session] without a task forks an idle conversation without sending an extra model turn', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('original task'));
  await f.bridge.drain();
  await f.bridge.handleEvent(threadReply('[session]'));
  assert.ok(f.world.calls.includes('fork:S1:'));
  const branch = new StateRepo(f.store).threads().find(t => t.sessionId === 'S2')!;
  assert.equal(branch.delivery.turnOpen, false);
  assert.deepEqual(branch.delivery.sentPrompts, []);
  await f.bridge.drain();
});
