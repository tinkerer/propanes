import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODELS, matchModels, modelCatalog } from '../src/models';
import { parseCommand } from '../src/options';
import { StateRepo } from '../src/state';
import { fixture, mention, threadReply } from './helpers';
import { createPropanesClient, createPropanesFetch } from '../src/propanes';

test('model commands parse case-insensitively and reject combined commands and prompts', () => {
  assert.deepEqual(parseCommand('<@UBOT> [MODELS]'), { command: 'models', text: '' });
  assert.equal(parseCommand('[Models: Astra]').modelQuery, 'astra');
  for (const text of ['[models:]','[models,quiet]', '[models] [claude]', '[models:opus] do it', '[models:opus,models:sonnet]']) {
    assert.ok(parseCommand(text).error, text);
  }
});

test('model matching prefers exact names and aliases, supports partial punctuation-insensitive names and keeps ambiguities', () => {
  assert.equal(matchModels(DEFAULT_MODELS, 'OPU')[0].id, 'opus');
  assert.equal(matchModels(DEFAULT_MODELS, 'astra')[0].id, 'gpt-6-astra');
  assert.equal(matchModels(DEFAULT_MODELS, 'gpt 6 astra')[0].id, 'gpt-6-astra');
  assert.equal(matchModels(DEFAULT_MODELS, 'sol').length, 2);
  assert.deepEqual(matchModels(DEFAULT_MODELS, 'unknown'), []);
  assert.deepEqual(matchModels(DEFAULT_MODELS, '!!!'), []);
});

test('catalog accepts additional provider labels and aliases and rejects invalid model configuration', () => {
  const custom = [{ provider: 'Future provider', runtime: 'codex', id: 'new-model', label: 'New model', aliases: ['next'] }];
  assert.deepEqual(modelCatalog(JSON.stringify(custom)), custom);
  assert.equal(matchModels(custom as any, 'next')[0].id, 'new-model');
  for (const value of [[], {}, [{ ...custom[0], id: '--flag' }], [{ ...custom[0], aliases: [1] }], [{ ...custom[0], runtime: 'unsupported' }], [custom[0], { ...custom[0], provider: 'Other' }]]) {
    assert.throws(() => modelCatalog(JSON.stringify(value)));
  }
});

test('numbered menu works without a session, survives restart, and never launches work', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[models]'));
  assert.match(f.slack.texts()[0], /1\. Opus/);
  assert.match(f.slack.texts()[0], /1 to select Opus/);
  const restarted = fixture({ store: f.store });
  await restarted.bridge.handleEvent(threadReply('1'));
  assert.match(restarted.slack.texts()[0], /Selected \*Opus\*/);
  assert.equal(new StateRepo(f.store).getModelPref('T1', 'U1', 'Anthropic'), 'opus');
  assert.deepEqual(f.world.calls, []);
  assert.deepEqual(restarted.world.calls, []);
});

test('provider defaults survive restart independently and reach dispatch and resume', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[models:sonnet]'));
  await f.bridge.handleEvent(threadReply('[models:astra]'));
  const restarted = fixture({ store: f.store });
  const dispatched: any[] = [], resumed: any[] = [];
  const dispatch = restarted.world.propanes.dispatch, resume = restarted.world.propanes.resume;
  restarted.world.propanes.dispatch = async (input) => { dispatched.push(input); return dispatch(input); };
  restarted.world.propanes.resume = async (id, input) => { resumed.push(input); return resume(id, input); };
  await restarted.bridge.handleEvent(mention('use my default', { ts: '300.0' }));
  await restarted.bridge.drain();
  assert.equal(dispatched[0].agentEndpointId, 'c-yolo');
  assert.equal(dispatched[0].model, 'gpt-6-astra');
  await restarted.bridge.handleEvent(threadReply('continue', { threadTs: '300.0' }));
  await restarted.bridge.drain();
  assert.equal(resumed[0].model, 'gpt-6-astra');
  await restarted.bridge.handleEvent(mention('[claude] use Anthropic', { ts: '400.0' }));
  await restarted.bridge.drain();
  assert.equal(dispatched[1].model, 'sonnet');
  await restarted.bridge.handleEvent(mention('[claude] another user', { ts: '500.0', user: 'U2' }));
  await restarted.bridge.drain();
  assert.equal(dispatched[2].model, undefined);
  assert.equal(new StateRepo(f.store).getModelPref('T2', 'U1', 'OpenAI'), undefined);
});

test('ambiguous and unknown queries and invalid numbers preserve defaults without launching tasks', async () => {
  const f = fixture();
  await f.bridge.handleEvent(mention('[models:sol]'));
  assert.match(f.slack.texts()[0], /Several models match/);
  await f.bridge.handleEvent(threadReply('999'));
  assert.match(f.slack.texts()[1], /Choose a number from 1 to 2/);
  assert.equal(new StateRepo(f.store).getModelPref('T1', 'U1', 'OpenAI'), undefined);
  await f.bridge.handleEvent(threadReply('2'));
  assert.equal(new StateRepo(f.store).getModelPref('T1', 'U1', 'OpenAI'), 'gpt-6-sol');
  await f.bridge.handleEvent(threadReply('[models:missing]'));
  assert.match(f.slack.texts().at(-1)!, /No model matches/);
  assert.deepEqual(f.world.calls, []);
});

test('model selection and expired menus never send numeric choices to a running session', async () => {
  const f = fixture();
  f.steps.push(...Array.from({ length: 20 }, () => () => undefined));
  await f.bridge.handleEvent(mention('start'));
  const before = f.world.calls.slice();
  await f.bridge.handleEvent(threadReply('[models]'));
  await f.bridge.handleEvent(threadReply('1'));
  await f.bridge.handleEvent(threadReply('[models]'));
  f.clock.now += 11 * 60_000;
  await f.bridge.handleEvent(threadReply('2'));
  assert.match(f.slack.texts().at(-1)!, /expired/);
  assert.deepEqual(f.world.calls, before);
  f.bridge.stop();
  await f.bridge.drain();
});

test('numeric replies from another user or after a normal reply keep reaching the running agent', async () => {
  const f = fixture();
  f.steps.push(...Array.from({ length: 20 }, () => () => undefined));
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('[models]'));
  await f.bridge.handleEvent(threadReply('2', { user: 'U2' }));
  assert.ok(f.world.calls.includes('send-keys:S1:2'));
  await f.bridge.handleEvent(threadReply('continue the task'));
  await f.bridge.handleEvent(threadReply('1'));
  assert.ok(f.world.calls.includes('send-keys:S1:1'));
  assert.equal(new StateRepo(f.store).getModelPref('T1', 'U1', 'Anthropic'), undefined);
  f.bridge.stop();
  await f.bridge.drain();
});

test('flat DM model menus allow numeric replies', async () => {
  const f = fixture();
  const dm = { channelType: 'im' as const, channel: 'D1', mentionsBot: false };
  await f.bridge.handleEvent(mention('[models]', dm));
  await f.bridge.handleEvent(mention('1', { ...dm, ts: '200.0' }));
  assert.match(f.slack.texts().at(-1)!, /Selected \*Opus\*/);
  assert.deepEqual(f.world.calls, []);
});

test('model IDs are preserved in authenticated dispatch and resume API bodies', async () => {
  const bodies: any[] = [];
  const client = createPropanesClient(createPropanesFetch('https://example.test', 'fixture', async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{"sessionId":"S1"}');
  }));
  await client.dispatch({ feedbackId: 'F1', agentEndpointId: 'A1', model: 'sonnet', instructions: '', permissionProfile: 'interactive-yolo' });
  await client.resume('S1', { additionalPrompt: 'continue', model: 'gpt-6-astra', runtime: 'codex' });
  assert.deepEqual(bodies.map((b) => b.model), ['sonnet', 'gpt-6-astra']);
});

test('the next task in a live thread resumes with a newly selected model and subsequent tasks use send-keys', async () => {
  const f = fixture();
  f.steps.push(...Array.from({ length: 30 }, () => () => undefined));
  const resumes: any[] = [];
  const resume = f.world.propanes.resume;
  f.world.propanes.resume = async (id, input) => { resumes.push(input); return resume(id, input); };
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.handleEvent(threadReply('[models:sonnet]'));
  assert.ok(!f.world.calls.some((c) => c.startsWith('kill:')));
  await f.bridge.handleEvent(threadReply('try the new model'));
  assert.equal(resumes[0].model, 'sonnet');
  assert.equal(resumes[0].additionalPrompt, 'try the new model');
  assert.ok(f.world.calls.includes('kill:S1'));
  await f.bridge.handleEvent(threadReply('one more task'));
  assert.ok(f.world.calls.includes('send-keys:S2:one more task'));
  assert.equal(resumes.length, 1);
  f.bridge.stop();
  await f.bridge.drain();
});
