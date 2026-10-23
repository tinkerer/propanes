import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackBridge } from '../src/bridge';
import { StateRepo } from '../src/state';
import { fixture, line, mention, sessionUrl, threadReply, agents, APP, PUBLIC } from './helpers';

test('help and status reply in the thread and never dispatch work', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[help]'));
  await f.bridge.handleEvent(mention('[status]', { ts: '101.000' }));
  await f.bridge.drain();
  assert.deepEqual(f.world.calls, []);
  assert.equal(f.world.sessions.size, 0);
  assert.equal(f.slack.reactions.length, 2);
  assert.match(f.slack.texts()[0], /Output modes/);
  assert.match(f.slack.texts()[1], /No session is associated/);
  assert.deepEqual(f.slack.posts.map((p) => p.thread_ts), ['100.000', '101.000']);
});

test('a new request reacts first, creates a session and replies with the public link, agent and mode', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('review PR 2013'));
  await f.bridge.drain();
  assert.equal(f.slack.order[0], 'react:eyes');
  assert.ok(f.world.calls.includes('dispatch:a-yolo:interactive-yolo'), f.world.calls.join());
  assert.ok(f.world.calls.some((c) => c.startsWith('feedback:Slack: review PR 2013')));
  assert.ok(f.world.calls.some((c) => c.startsWith('instructions:[SLACK THREAD]')));
  const first = f.slack.texts()[0];
  assert.ok(first.includes(sessionUrl('S1')), first);
  assert.match(first, /\*agent\* Claude \(yolo\) · \*output\* default · \*images\* off/);
  assert.equal(f.slack.posts[0].thread_ts, '100.000');
});

test('invalid or conflicting options are rejected before anything is created', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[claude, codex] do it'));
  await f.bridge.handleEvent(mention('[loud] do it', { ts: '101.000' }));
  await f.bridge.drain();
  assert.deepEqual(f.world.calls, []);
  assert.equal(f.slack.reactions.length, 0);
  assert.match(f.slack.texts()[0], /not both/);
  assert.match(f.slack.texts()[1], /Unknown option/);
});

test('explicit [codex] overrides and updates the remembered agent; the default applies first', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('first', { ts: '1.0' }));
  await f.bridge.handleEvent(mention('[codex] second', { ts: '2.0' }));
  await f.bridge.handleEvent(mention('third', { ts: '3.0' }));
  await f.bridge.handleEvent(mention('[claude] fourth', { ts: '4.0', user: 'U2' }));
  await f.bridge.drain();
  const dispatches = f.world.calls.filter((c) => c.startsWith('dispatch:'));
  assert.deepEqual(dispatches, ['dispatch:a-yolo:interactive-yolo', 'dispatch:c-yolo:interactive-yolo', 'dispatch:c-yolo:interactive-yolo', 'dispatch:a-yolo:interactive-yolo']);
});

test('the remembered agent survives a listener restart', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[codex] one'));
  await f.bridge.drain();
  const restarted = fixture({ store: f.store });
  restarted.world.sessions = f.world.sessions;
  await restarted.bridge.handleEvent(mention('two', { ts: '500.0' }));
  await restarted.bridge.drain();
  assert.ok(restarted.world.calls.includes('dispatch:c-yolo:interactive-yolo'));
});

test('an unavailable runtime is reported, never substituted', async () => {
  const f = fixture();
  f.world.agents = agents.filter((a) => a.runtime !== 'codex');
  await f.bridge.handleEvent(mention('[codex] go'));
  await f.bridge.drain();
  assert.deepEqual(f.world.calls, []);
  assert.match(f.slack.texts()[0], /No usable Codex agent endpoint.*Not substituting/);
});

test('thread replies reach a running session through send-keys, not kill-and-resume', async () => {
  const f = fixture();
  f.steps.push(() => undefined, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined);
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('and also\ncheck the tests'));
  await f.bridge.drain();
  assert.ok(f.world.calls.includes('send-keys:S1:and also ⏎ check the tests'), f.world.calls.join('|'));
  assert.ok(!f.world.calls.some((c) => c.startsWith('kill') || c.startsWith('resume')));
  assert.equal(f.world.sessions.size, 1);
});

test('replies to a finished session resume it explicitly and the thread follows the continuation', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  assert.equal(f.world.session('S1').status, 'completed');
  await f.bridge.handleEvent(threadReply('one more thing'));
  await f.bridge.drain();
  assert.ok(f.world.calls.includes('resume:S1:inherit:one more thing'), f.world.calls.join('|'));
  const note = f.slack.texts().find((t) => t.includes('had finished'))!;
  assert.ok(note.includes(sessionUrl('S2')) && note.includes(sessionUrl('S1')), note);
  await f.bridge.handleEvent(threadReply('[status]'));
  await f.bridge.drain();
  const status = f.slack.texts().at(-1)!;
  assert.ok(status.includes(sessionUrl('S2')) && /history/.test(status) && status.includes(sessionUrl('S1')), status);
});

test('a runtime switch inside a thread stops the live run and continues as a child session with history kept', async () => {
  const f = fixture();
  f.steps.push(() => undefined, () => undefined, () => undefined, () => undefined);
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('[codex] try the other approach'));
  await f.bridge.drain();
  assert.ok(f.world.calls.includes('kill:S1'));
  assert.ok(f.world.calls.includes('resume:S1:codex:try the other approach'), f.world.calls.join('|'));
  assert.ok(f.world.calls.includes('child:S1->S2'));
  const note = f.slack.texts().find((t) => t.includes('Switching this thread from Claude to Codex'))!;
  assert.ok(note.includes(sessionUrl('S2')) && note.includes(sessionUrl('S1')), note);
  const repo = new StateRepo(f.store);
  const rec = repo.getThread('T1:C1:100.000')!;
  assert.equal(rec.runtime, 'codex');
  assert.deepEqual(rec.history.map((h) => h.sessionId), ['S1', 'S2']);
  assert.equal(repo.getRuntimePref('T1', 'U1'), 'codex');
});

test('a runtime switch to an unavailable agent changes nothing', async () => {
  const f = fixture();
  f.world.agents = agents.filter((a) => a.runtime !== 'codex');
  f.steps.push(() => undefined, () => undefined);
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('[codex] switch'));
  await f.bridge.drain();
  assert.ok(!f.world.calls.some((c) => c.startsWith('kill') || c.startsWith('resume')));
  assert.ok(f.slack.texts().some((t) => /Staying on Claude/.test(t)), f.slack.texts().join('|'));
});

test('stop kills the running session; nothing to stop is reported honestly', async () => {
  const f = fixture();
  f.steps.push(() => undefined, () => undefined, () => undefined);
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('stop'));
  await f.bridge.drain();
  assert.ok(f.world.calls.includes('kill:S1'));
  assert.match(f.slack.texts().find((t) => t.startsWith('🛑'))!, /Stopped session/);
  await f.bridge.handleEvent(threadReply('stop'));
  await f.bridge.drain();
  assert.match(f.slack.texts().at(-1)!, /not running \(killed\)/);
});

function transcript() {
  return [
    line.user('start'),
    line.assistant('Looking at the PR now.'),
    line.toolUse('Bash', { command: 'git log -1' }, 't1'),
    line.toolResult('t1', 'abc123 last commit'),
    line.assistant('Two findings.\n\n<cos-reply>Summary: looks good.</cos-reply>'),
  ];
}

test('default mode forwards assistant text only, in order, without tool noise', async () => {
  const f = fixture();
  f.steps.push(() => { f.world.session('S1').lines.push(...transcript()); }, () => { f.world.session('S1').status = 'completed'; });
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  const texts = f.slack.texts().slice(1);
  assert.deepEqual(texts, ['Looking at the PR now.\n\nTwo findings.\n\nSummary: looks good.', `✅ Session <${sessionUrl('S1')}|\`S1\`> completed.`]);
});

test('verbose mode forwards tool calls and results in original order', async () => {
  const f = fixture();
  f.steps.push(() => { f.world.session('S1').lines.push(...transcript()); }, () => { f.world.session('S1').status = 'completed'; });
  await f.bridge.handleEvent(mention('[verbose] start'));
  await f.bridge.drain();
  const body = f.slack.texts()[1];
  const idx = ['Looking at the PR now.', '🔧 *Bash*', 'git log -1', '↩︎ result', 'abc123 last commit', 'Two findings.'].map((s) => body.indexOf(s));
  assert.ok(idx.every((i, n) => i >= 0 && (n === 0 || i > idx[n - 1])), body);
  assert.doesNotMatch(body, /<cos-reply>/);
});

test('quiet mode posts nothing until the turn ends, then only the final cos-reply', async () => {
  const f = fixture();
  f.steps.push(
    () => { f.world.session('S1').lines.push(line.assistant('<cos-reply>Understood, on it.</cos-reply>'), line.assistant('<cos-reply>partial')); },
    () => { f.world.session('S1').lines.push(line.assistant('still working</cos-reply> done <cos-reply>Final: 2 files changed.</cos-reply>')); f.world.session('S1').inputState = 'idle'; },
    () => undefined, () => undefined,
    () => { f.world.session('S1').status = 'completed'; },
  );
  await f.bridge.handleEvent(mention('[quiet] start'));
  await f.bridge.drain();
  const texts = f.slack.texts();
  assert.match(texts[0], /Quiet mode/);
  assert.equal(texts[1], `Final: 2 files changed.\n\n_Session: <${sessionUrl('S1')}|\`S1\`>_`);
  assert.equal(texts.length, 2, texts.join('\n---\n'));
  assert.ok(f.world.calls.some((c) => c.startsWith('instructions:') && c.includes('LAST complete <cos-reply>')));
});

test('quiet mode reports a missing final block, failures and cancellations instead of staying silent', async () => {
  const f = fixture();
  f.steps.push(() => { f.world.session('S1').lines.push(line.assistant('I did things but forgot the tag.')); f.world.session('S1').status = 'failed'; });
  await f.bridge.handleEvent(mention('[quiet] start'));
  await f.bridge.drain();
  assert.equal(f.slack.texts().length, 2);
  assert.match(f.slack.texts()[1], /⚠️ Session .*S1.* failed without a final `<cos-reply>` answer/);

  const g = fixture();
  g.steps.push(() => { g.world.session('S1').inputState = 'idle'; g.world.session('S1').lines.push(line.assistant('no tags')); }, () => undefined, () => undefined, () => { g.world.session('S1').status = 'completed'; });
  await g.bridge.handleEvent(mention('[quiet] start'));
  await g.bridge.drain();
  assert.match(g.slack.texts()[1], /finished its turn without a final/);
  assert.equal(g.slack.texts().length, 2);
});

test('[quiet, images] suppresses text but uploads every image the agent viewed, once each', async () => {
  const f = fixture();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  f.world.images.set('/api/v1/admin/agent-sessions/S1/jsonl-image/u-img/0', { bytes: png, mime: 'image/png' });
  f.steps.push(() => {
    f.world.session('S1').lines.push(
      line.assistant('Taking a screenshot.'),
      line.toolUse('Read', { file_path: '/tmp/pw_screen.png' }, 'r1'),
      line.toolResult('r1', [{ type: 'image', source: { type: 'base64', data: '', media_type: 'image/png' }, _redacted: { originalSize: 9, url: '/api/v1/admin/agent-sessions/S1/jsonl-image/u-img/0' } }]),
      line.toolUse('Read', { file_path: '/tmp/small.png' }, 'r2'),
      line.toolResult('r2', [{ type: 'image', source: { type: 'base64', data: png.toString('base64'), media_type: 'image/png' } }]),
      line.toolUse('Read', { file_path: '/tmp/pw_screen.png' }, 'r3'),
      line.toolResult('r3', [{ type: 'image', source: { type: 'base64', data: '', media_type: 'image/png' }, _redacted: { originalSize: 9, url: '/api/v1/admin/agent-sessions/S1/jsonl-image/u-img/0' } }]),
      line.toolUse('Read', { file_path: '/tmp/gone.png' }, 'r4'),
      line.toolResult('r4', [{ type: 'image', source: { type: 'base64', data: '', media_type: 'image/png' }, _redacted: { originalSize: 9, url: '/api/v1/admin/agent-sessions/S1/jsonl-image/u-gone/0' } }]),
      line.assistant('<cos-reply>Captured.</cos-reply>'),
    );
    f.world.session('S1').status = 'completed';
  });
  await f.bridge.handleEvent(mention('[quiet, images] screenshot it'));
  await f.bridge.drain();
  assert.deepEqual(f.slack.uploads.map((u) => [u.filename, u.title, u.thread_ts]), [
    ['pw_screen-1.png', 'Read /tmp/pw_screen.png', '100.000'],
    ['small-2.png', 'Read /tmp/small.png', '100.000'],
  ]);
  assert.equal(f.slack.uploads[0].bytes.equals(png), true);
  const texts = f.slack.texts();
  assert.ok(!texts.some((t) => t.includes('Taking a screenshot')), 'intermediate text stays suppressed');
  assert.match(texts.find((t) => t.includes('Could not fetch'))!, /gone\.png/);
  assert.equal(texts.at(-1), `Captured.\n\n_Session: <${sessionUrl('S1')}|\`S1\`>_`);
});

test('a missing files:write scope is explained once and does not break text delivery', async () => {
  const f = fixture();
  f.slack.uploadError = { data: { error: 'missing_scope' }, token: 'private-fixture-value' };
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  f.steps.push(() => {
    f.world.session('S1').lines.push(
      line.toolUse('Read', { file_path: '/a.png' }, 'r1'), line.toolResult('r1', [{ type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } }]),
      line.toolUse('Read', { file_path: '/b.png' }, 'r2'), line.toolResult('r2', [{ type: 'image', source: { type: 'base64', data: png + 'AA==', media_type: 'image/png' } }]),
      line.assistant('done'),
    );
    f.world.session('S1').status = 'completed';
  });
  await f.bridge.handleEvent(mention('[images] go'));
  await f.bridge.drain();
  const warnings = f.slack.texts().filter((t) => t.includes('files:write'));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(f.slack.texts().join(), /private-fixture-value/);
  assert.ok(f.slack.texts().includes('done'));
});

test('duplicate deliveries, bot echoes, edits and unrelated chatter are ignored', async () => {
  const f = fixture();
  const ev = mention('start', { eventId: 'Ev-same' });
  await f.bridge.handleEvent(ev);
  await f.bridge.handleEvent({ ...ev });
  await f.bridge.handleEvent(mention('bot', { ts: '300.0', botId: 'B1' }));
  await f.bridge.handleEvent(mention('edit', { ts: '301.0', subtype: 'message_changed' }));
  await f.bridge.handleEvent(threadReply('chatter in another thread', { threadTs: '999.000' }));
  await f.bridge.drain();
  assert.equal(f.world.calls.filter((c) => c.startsWith('dispatch')).length, 1);
  assert.equal(f.world.sessions.size, 1);
});

test('concurrent replies in a new thread create one session and queue the second as a prompt', async () => {
  const f = fixture();
  f.steps.push(() => undefined, () => undefined, () => undefined, () => undefined);
  await Promise.all([
    f.bridge.handleEvent(mention('first')),
    f.bridge.handleEvent(threadReply('second')),
  ]);
  await f.bridge.drain();
  assert.equal(f.world.calls.filter((c) => c.startsWith('dispatch')).length, 1);
  assert.ok(f.world.calls.includes('send-keys:S1:second'), f.world.calls.join('|'));
});

test('a restarted listener resumes delivery from its checkpoint without re-posting', async () => {
  const f = fixture();
  f.steps.push(
    () => { f.world.session('S1').lines.push(line.assistant('first part')); },
    () => { f.bridge.stop(); throw new Error('listener crashed'); },
  );
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  assert.deepEqual(f.slack.texts().slice(1), ['first part']);

  const r = fixture({ store: f.store });
  r.world.sessions = f.world.sessions;
  r.steps.push(() => { r.world.session('S1').lines.push(line.assistant('second part')); }, () => { r.world.session('S1').status = 'completed'; });
  assert.equal(r.bridge.recover(), 1);
  await r.bridge.drain();
  assert.deepEqual(r.slack.texts(), ['second part', `✅ Session <${sessionUrl('S1')}|\`S1\`> completed.`]);
});

test('a waiting session is announced once with the pending tool, in the thread', async () => {
  const f = fixture();
  f.steps.push(
    () => { f.world.session('S1').lines.push(line.toolUse('Bash', { command: 'rm -rf build' }, 't1')); f.world.session('S1').inputState = 'waiting'; },
    () => undefined, () => undefined,
    () => { f.world.session('S1').status = 'completed'; },
  );
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  const waits = f.slack.texts().filter((t) => t.startsWith('⏸️'));
  assert.equal(waits.length, 1);
  assert.match(waits[0], /waiting for your input: Bash rm -rf build/);
});

test('mode changes inside a thread are remembered for later replies', async () => {
  const f = fixture();
  f.steps.push(() => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
    () => { f.world.session('S1').lines.push(line.toolUse('Bash', { command: 'ls' }, 't1'), line.toolResult('t1', 'a'), line.assistant('ok')); },
    () => { f.world.session('S1').status = 'completed'; });
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('[verbose]'));
  await f.bridge.handleEvent(threadReply('[quiet] now be quiet'));
  await f.bridge.drain();
  assert.match(f.slack.texts()[1], /Updated this thread: \*output\* verbose/);
  assert.ok(f.world.calls.some((c) => c.startsWith('send-keys:S1:now be quiet (Reply via Slack')), f.world.calls.join('|'));
  assert.equal(new StateRepo(f.store).getThread('T1:C1:100.000')!.mode, 'quiet');
});

test('DMs work without a mention and replies stay flat', async () => {
  const f = fixture();
  await f.bridge.handleEvent({ eventId: 'E1', teamId: 'T1', channel: 'D1', channelType: 'im', user: 'U1', ts: '5.0', text: 'hello there', mentionsBot: false });
  await f.bridge.drain();
  assert.equal(f.world.sessions.size, 1);
  assert.equal(f.slack.posts[0].thread_ts, undefined);
  assert.equal(new StateRepo(f.store).getThread('T1:D1:dm')?.sessionId, 'S1');
});

test('the bridge is constructed with the public URL from config', () => {
  const f = fixture();
  assert.equal((f.bridge as SlackBridge).sessionUrl('X'), `${PUBLIC}/admin/#/session/X`);
  assert.equal(APP, 'app-1');
});

test('approximate app and infra names route feedback and dispatch to resolved IDs', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[app:storfront infra:macbok] fix it'));
  await f.bridge.drain();
  assert.deepEqual(f.world.agentAppIds, ['app-2']);
  assert.equal(f.world.feedbackInputs[0].appId, 'app-2');
  assert.equal(f.world.dispatchInputs[0].launcherId, 'mac-1');
  assert.match(f.slack.texts()[0], /Storefront.*Amir MacBook/);
  const rec = new StateRepo(f.store).getThread('T1:C1:100.000')!;
  assert.equal(rec.appId, 'app-2');
  await f.bridge.handleEvent(threadReply('[codex] try again'));
  await f.bridge.drain();
  assert.equal(f.world.agentAppIds.at(-1), 'app-2');
});

test('ambiguous or unknown app and infra selectors create no feedback or session', async () => {
  for (const [input, pattern] of [
    ['[app:store] fix', /Ambiguous app.*app-2.*app-3/],
    ['[infra:mac] fix', /Ambiguous infra.*mac-1.*mac-2/],
    ['[app:missing] fix', /No app matches/],
    ['[infra:missing terminal]', /No infra matches/],
  ] as const) {
    const f = fixture();
    f.world.apps.push({ id: 'app-3', name: 'Storefront Dev' });
    f.world.infra.push({ id: 'mac-2', name: 'Mac Mini', hostname: 'mini.local', online: true });
    await f.bridge.handleEvent(mention(input));
    await f.bridge.drain();
    assert.match(f.slack.texts()[0], pattern);
    assert.deepEqual(f.world.calls, []);
  }
});

test('offline infra is explained without dispatching or silently using local infra', async () => {
  const f = fixture();
  f.world.infra[0].online = false;
  await f.bridge.handleEvent(mention('[infra:macbook terminal]'));
  assert.deepEqual(f.world.calls, []);
  assert.match(f.slack.texts()[0], /offline/);
});

test('[terminal] and [infra:macbook terminal] return plain shell session links', async () => {
  for (const input of ['[terminal]', '[infra:macbook terminal]', '[app:storefront infra:macbook terminal]']) {
    const f = fixture();
    await f.bridge.handleEvent(mention(input));
    await f.bridge.drain();
    assert.equal(f.world.sessions.size, 1);
    assert.match(f.slack.texts()[0], /Terminal started/);
    assert.ok(f.slack.texts()[0].includes(sessionUrl('S1')));
    const data = JSON.parse(f.world.calls[0].slice('terminal:'.length));
    assert.equal(data.permissionProfile, 'plain');
    assert.equal(data.launcherId, input.includes('infra:') ? 'mac-1' : undefined);
    assert.equal(data.appId, input.includes('app:') ? 'app-2' : undefined);
    if (input === '[infra:macbook terminal]') assert.equal(data.cwd, '~');
    assert.equal(f.world.calls.length, 1);
    const record = new StateRepo(f.store).getThread('T1:C1:100.000')!;
    assert.equal(record.kind, 'terminal');
    assert.equal(record.watching, false);
    await f.bridge.handleEvent(threadReply('[status]'));
    assert.match(f.slack.texts().at(-1)!, /\*terminal\*.*S1.*running/);
    await f.bridge.handleEvent(threadReply('pwd'));
    assert.ok(f.world.calls.includes('send-keys:S1:pwd'));
    await f.bridge.handleEvent(threadReply('stop'));
    assert.ok(f.world.calls.includes('kill:S1'));
    await f.bridge.handleEvent(threadReply('pwd'));
    assert.match(f.slack.texts().at(-1)!, /has ended/);
    assert.ok(!f.world.calls.some(c => c.startsWith('resume:')));
  }
});

test('a separate terminal preserves an existing agent thread and rejects target changes', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  await f.bridge.handleEvent(threadReply('[infra:macbook terminal]'));
  assert.match(f.slack.texts().at(-1)!, /Replies in this thread continue to reach the agent/);
  assert.equal(new StateRepo(f.store).getThread('T1:C1:100.000')!.sessionId, 'S1');
  const before = f.world.calls.length;
  await f.bridge.handleEvent(threadReply('[app:storefront] change target'));
  assert.equal(f.world.calls.length, before);
  assert.match(f.slack.texts().at(-1)!, /Start a new Slack thread/);
});

test('terminal creation failures and duplicate deliveries do not create extra sessions', async () => {
  const f = fixture();
  const event = mention('[terminal]');
  await Promise.all([f.bridge.handleEvent(event), f.bridge.handleEvent(event)]);
  assert.equal(f.world.sessions.size, 1);
  const failed = fixture();
  failed.world.propanes.createTerminal = async () => { throw new Error('launcher unavailable'); };
  await failed.bridge.handleEvent(mention('[terminal]'));
  assert.match(failed.slack.texts()[0], /launcher unavailable/);
  assert.equal(new StateRepo(failed.store).threads().length, 0);
});
