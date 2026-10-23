import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockAction } from '@slack/bolt';
import { infraTerminalAction, OPEN_INFRA_TERMINAL_ACTION, type InfraTerminalAction } from '../src/infra-actions';
import { fixture, mention, sessionUrl } from './helpers';
import { StateRepo } from '../src/state';

function payload(channel = 'C1', threadTs?: string): BlockAction {
  return {
    type: 'block_actions', team: { id: 'T1', domain: 'team' },
    user: { id: 'U1', username: 'user' }, channel: { id: channel, name: 'channel' },
    message: { type: 'message', ts: '200.000', thread_ts: threadTs },
    actions: [{ type: 'button', action_id: OPEN_INFRA_TERMINAL_ACTION, block_id: 'infra-1',
      action_ts: '300.000', value: 'laptop-1', text: { type: 'plain_text', text: 'Open terminal' } }],
    token: 'fixture', response_url: 'https://example.test/response', trigger_id: 'trigger', api_app_id: 'app', container: {},
  };
}

const click = (over: Partial<InfraTerminalAction> = {}): InfraTerminalAction => ({
  eventId: 'click-1', teamId: 'T1', channel: 'C1', user: 'U1', threadTs: '100.000', launcherId: 'laptop-1', ...over,
});

test('button payloads preserve thread and user identity and deduplicate retry deliveries', () => {
  const input = payload('C1', '100.000');
  const action = infraTerminalAction(input)!;
  assert.equal(action.threadTs, '100.000');
  assert.equal(action.user, 'U1');
  assert.equal(action.launcherId, 'laptop-1');
  assert.equal(action.eventId, infraTerminalAction(input)!.eventId);
  assert.equal(infraTerminalAction(payload())!.threadTs, '200.000');
  assert.equal(infraTerminalAction(payload('D1'))!.threadTs, null);
  assert.equal(infraTerminalAction({ ...input, message: undefined }), undefined);
  assert.equal(infraTerminalAction({ ...input, actions: [] }), undefined);
});

test('infra list button clicks create the selected terminal and post a session link once', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[infra]'));
  const button = f.slack.posts[0].blocks?.find(b => b.type === 'section' && b.accessory?.type === 'button' && b.accessory.value === 'laptop-1');
  assert.ok(button);
  const body = payload('C1', '100.000');
  const action = infraTerminalAction(body)!;
  await Promise.all([f.bridge.handleInfraTerminalAction(action), f.bridge.handleInfraTerminalAction(action)]);
  assert.equal(f.world.sessions.size, 1);
  assert.deepEqual(JSON.parse(f.world.calls[0].slice('terminal:'.length)), { permissionProfile: 'plain', launcherId: 'laptop-1' });
  assert.ok(f.slack.texts().some(text => text.includes(sessionUrl('S1'))));
  assert.match(f.slack.texts().at(-1)!, /Terminal started:/);
  assert.ok(f.slack.posts.every(post => post.thread_ts === '100.000'));
  assert.equal(f.slack.posts.at(-1)!.thread_ts, '100.000');
});

test('local infra buttons create local terminals and distinct clicks open distinct shells', async () => {
  const f = fixture();
  await f.bridge.handleInfraTerminalAction(click({ launcherId: 'local' }));
  assert.deepEqual(JSON.parse(f.world.calls[0].slice('terminal:'.length)), { permissionProfile: 'plain' });
  await f.bridge.handleInfraTerminalAction(click({ launcherId: 'local', eventId: 'click-2' }));
  assert.equal(f.world.sessions.size, 2);
});

test('stale, offline and unsupported targets never fall back to other infra', async () => {
  for (const launcherId of ['laptop-2', 'db-machine:m-stage', 'h-1']) {
    const f = fixture();
    f.world.infra.targets.push({ launcherId: 'h-1', name: 'Harness', online: true, isHarness: true });
    await f.bridge.handleInfraTerminalAction(click({ launcherId }));
    assert.equal(f.world.sessions.size, 0);
    assert.deepEqual(f.world.calls, []);
    assert.match(f.slack.texts()[0], /target is unavailable/);
  }
});

test('a terminal opened by a button preserves existing agent mapping and reports API failures', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  await f.bridge.handleInfraTerminalAction(click());
  assert.equal(new StateRepo(f.store).getThread('T1:C1:100.000')!.sessionId, 'S1');
  assert.match(f.slack.texts().at(-1)!, /Terminal started:[\s\S]*Replies in this thread continue to reach the agent/);
  assert.ok(f.slack.posts.every(post => post.thread_ts === '100.000'));
  assert.equal(new StateRepo(f.store).threads().length, 1);
  await f.bridge.handleEvent({ ...mention('continue'), threadTs: '100.000', eventId: 'continue-agent' });
  await f.bridge.drain();
  assert.ok(f.world.calls.some(call => call.startsWith('resume:S1:')));
  f.world.propanes.listDispatchTargets = async () => { throw new Error('API unavailable'); };
  await f.bridge.handleInfraTerminalAction(click({ eventId: 'click-2' }));
  assert.match(f.slack.texts().at(-1)!, /Could not open terminal: API unavailable/);
});

test('the Slack SDK adapter preserves interactive blocks and disables link unfurls', async () => {
  const { posterFromClient } = await import('../src/slack');
  const { listInfraMessages } = await import('../src/infra');
  const f = fixture();
  let posted: Record<string, unknown> | undefined;
  const poster = posterFromClient({
    chat: { postMessage: async args => { posted = args; }, getPermalink: async () => ({ permalink: 'https://slack.example.test/thread' }) },
    reactions: { add: async () => undefined }, files: { uploadV2: async () => undefined },
  });
  const message = listInfraMessages(f.world.infra)[0];
  await poster.postMessage({ channel: 'C1', thread_ts: '100.000', ...message });
  assert.deepEqual(posted?.blocks, message.blocks);
  assert.equal(posted?.thread_ts, '100.000');
  assert.equal(posted?.unfurl_links, false);
});

test('terminal buttons in direct messages return a single link without starting a Slack thread', async () => {
  const f = fixture();
  await f.bridge.handleInfraTerminalAction(click({ channel: 'D1', threadTs: null }));
  assert.equal(f.world.sessions.size, 1);
  assert.equal(f.slack.posts.length, 1);
  assert.equal(f.slack.posts[0].channel, 'D1');
  assert.equal(f.slack.posts[0].thread_ts, undefined);
  assert.ok(f.slack.texts()[0].includes(sessionUrl('S1')));
});
