import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiModelProviders, createModelCatalog, type ModelProvider } from '../src/model-discovery';
import { matchModels, modelCatalog, type ModelOption } from '../src/models';
import { fixture, mention, threadReply } from './helpers';
import { SlackBridge } from '../src/bridge';
import { StateRepo } from '../src/state';

const fable: ModelOption = { provider: 'Anthropic', runtime: 'claude', id: 'fable', label: 'Fable 5.1', aliases: ['claude-fable-5-1'] };
const future: ModelOption = { provider: 'OpenAI', runtime: 'codex', id: 'gpt-future', label: 'A future model' };
const fake = (code: string, timeoutMs = 3000) => ({ command: process.execPath, args: ['-e', code], timeoutMs });
const readLines = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);`;
const emit = (message: unknown) => `console.log(JSON.stringify(${JSON.stringify(message)}));`;

test('discovery caches briefly, shares concurrent requests, and refreshes to include newly released models', async () => {
  let now = 0, calls = 0;
  const provider: ModelProvider = { provider: 'Anthropic', runtime: 'claude', discover: async () => { calls++; return calls === 1 ? [fable] : [fable, { ...fable, id: 'new-release', label: 'New release' }]; } };
  const catalog = createModelCatalog({ providers: [provider], now: () => now, ttlMs: 100 });
  await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(calls, 1);
  await catalog.list();
  assert.equal(calls, 1);
  now = 101;
  assert.equal((await catalog.list()).models.length, 2);
  assert.equal(calls, 2);
});

test('provider failures remain visible, preserve last successful results and do not hide healthy providers', async () => {
  let fails = false, now = 0;
  const catalog = createModelCatalog({ now: () => now, ttlMs: 10, providers: [
    { provider: 'Anthropic', runtime: 'claude', discover: async () => { if (fails) throw new Error('secret-token'); return [fable]; } },
    { provider: 'OpenAI', runtime: 'codex', discover: async () => [future] },
  ] });
  assert.equal((await catalog.list()).models.length, 2);
  fails = true; now = 11;
  const stale = await catalog.list();
  assert.equal(stale.models.length, 2);
  assert.match(stale.warnings[0], /Anthropic.*last retrieved/);
  assert.doesNotMatch(stale.warnings.join(), /secret-token/);
  const partial = await createModelCatalog({ providers: [
    { provider: 'Anthropic', runtime: 'claude', discover: async () => { throw new Error(); } },
    { provider: 'OpenAI', runtime: 'codex', discover: async () => [future] },
  ] }).list();
  assert.deepEqual(partial.models, [future]);
  assert.match(partial.warnings[0], /could not be listed/);
});

test('custom options supplement the complete discovered catalog and provider adapters remain extensible', async () => {
  assert.deepEqual(modelCatalog(), []);
  const models = await createModelCatalog({ providers: [{ provider: 'Anthropic', runtime: 'claude', discover: async () => [fable] }], extra: [{ ...fable, id: 'custom', label: 'Custom' }] }).list();
  assert.deepEqual(models.models.map((m) => m.id), ['fable', 'custom']);
  const custom = createModelCatalog({ providers: [{ provider: 'Future provider', runtime: 'codex', discover: async () => [{ ...future, provider: 'Future provider' }] }] });
  assert.equal(custom.providerForRuntime('codex'), 'Future provider');
  assert.equal((await custom.list()).models[0].provider, 'Future provider');
});

function dynamicBridge(models: ModelOption[], warnings: string[] = []) {
  const f = fixture();
  const bridge = new SlackBridge({ propanes: f.world.propanes, slack: f.slack, state: new StateRepo(f.store),
    models: { list: async () => ({ models, warnings }), providerForRuntime: (runtime) => runtime === 'claude' ? 'Anthropic' : 'OpenAI' },
    config: { appId: 'app-1', publicUrl: 'https://example.test', botUserId: 'UBOT', pollMs: 1, idlePollMs: 1, idleStopMs: 1000, transcriptTail: 2000 }, log: () => {},
  });
  return { ...f, bridge };
}

test('Slack lists Fable 5.1, selects it by approximate name and canonical ID, and saves the discovered model ID', async () => {
  const f = dynamicBridge([fable, future]);
  await f.bridge.handleEvent(mention('[models]'));
  assert.match(f.slack.texts()[0], /Fable 5.1/);
  await f.bridge.handleEvent(threadReply('1'));
  assert.equal(new StateRepo(f.store).getModelPref('T1', 'U1', 'Anthropic'), 'fable');
  await f.bridge.handleEvent(threadReply('[models:claude-fable-5-1]'));
  assert.match(f.slack.texts().at(-1)!, /Selected \*Fable 5.1\*/);
  assert.deepEqual(f.world.calls, []);
});

test('large catalogs show every model in bounded Slack messages with stable numeric selection', async () => {
  const models = Array.from({ length: 250 }, (_, i) => ({ ...future, id: `model-${i}`, label: `Discovered model ${i}` }));
  const f = dynamicBridge(models);
  await f.bridge.handleEvent(mention('[models]'));
  assert.ok(f.slack.posts.length > 1);
  assert.ok(f.slack.posts.every((p) => p.text.length <= 3800));
  for (let i = 0; i < models.length; i++) assert.ok(f.slack.texts().join('\n').includes(`${i + 1}. Discovered model ${i} —`));
  await f.bridge.handleEvent(threadReply('250'));
  assert.equal(new StateRepo(f.store).getModelPref('T1', 'U1', 'OpenAI'), 'model-249');
});

test('Slack explains missing and stale providers instead of claiming an incomplete list is complete', async () => {
  const f = dynamicBridge([future], ['Anthropic discovery is unavailable; its models could not be listed.']);
  await f.bridge.handleEvent(mention('[models]'));
  assert.match(f.slack.texts()[0], /Anthropic discovery is unavailable/);
  assert.match(f.slack.texts()[1], /A future model/);
  const empty = dynamicBridge([], ['No provider responded']);
  await empty.bridge.handleEvent(mention('[models]'));
  assert.match(empty.slack.texts().at(-1)!, /No models could be discovered/);
});

test('the API providers ask the server for each runtime with the bridge user\'s client', async () => {
  const asked: string[] = [];
  const catalog = createModelCatalog({ providers: apiModelProviders({
    discoverModels: async (runtime) => { asked.push(runtime); return [runtime === 'claude' ? fable : future]; },
  }) });
  const { models, warnings } = await catalog.list();
  assert.deepEqual(asked.sort(), ['claude', 'codex']);
  assert.deepEqual(models.map((m) => m.id).sort(), ['fable', 'gpt-future']);
  assert.deepEqual(warnings, []);
  assert.equal(catalog.providerForRuntime('codex'), 'OpenAI');
});
