import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelCatalog, discoverClaudeModels, discoverCodexModels, type ModelProvider } from '../src/model-discovery';
import { matchModels, modelCatalog, type ModelOption } from '../src/models';
import { fixture, mention, threadReply } from './helpers';
import { SlackBridge } from '../src/bridge';
import { StateRepo } from '../src/state';

const fable: ModelOption = { provider: 'Anthropic', runtime: 'claude', id: 'fable', label: 'Fable 5.1', aliases: ['claude-fable-5-1'] };
const future: ModelOption = { provider: 'OpenAI', runtime: 'codex', id: 'gpt-future', label: 'A future model' };
const fake = (code: string, timeoutMs = 3000) => ({ command: process.execPath, args: ['-e', code], timeoutMs });
const readLines = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);`;
const emit = (message: unknown) => `console.log(JSON.stringify(${JSON.stringify(message)}));`;

test('Claude discovery reads every picker entry, aliases and versions without submitting a user turn', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'models-protocol-'));
  try {
    const log = join(temp, 'requests.jsonl');
    const models = await discoverClaudeModels(fake(readLines + `require('node:fs').appendFileSync(${JSON.stringify(log)},line+'\\n');` +
      `if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(1);` +
      `console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[
        {value:'default',displayName:'Default',resolvedModel:'claude-opus-future'},
        {value:'opus',displayName:'Opus future',resolvedModel:'claude-opus-future'},
        {value:'fable',displayName:'Fable 5.1',resolvedModel:'claude-fable-5-1'},
        {value:'claude-fable-5',displayName:'Fable 5'}]}}}));});`));
    assert.deepEqual(models.map((m) => m.id), ['default', 'opus', 'fable', 'claude-fable-5']);
    assert.equal(matchModels(models, 'fable 5.1')[0].id, 'fable');
    assert.equal(matchModels(models, 'claude-fable-5-1')[0].id, 'fable');
    assert.equal(matchModels(models, 'claude-opus-future').length, 1);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    assert.deepEqual(requests, [{ type: 'control_request', request_id: 'model-init', request: { subtype: 'initialize' } }]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('Codex discovery initializes, follows every page and uses wire model IDs', async () => {
  const models = await discoverCodexModels(fake(readLines + `
    if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{serverInfo:'test'}}));
    else if(m.method==='initialized'){}
    else if(m.method==='model/list'){
      if(m.params.includeHidden!==false||m.params.limit!==100)process.exit(1);
      const result=m.params.cursor ? {data:[{id:'picker-id',model:'gpt-future',displayName:'New version'}],nextCursor:null}
        : {data:[{model:'gpt-first',displayName:'First'},{model:'internal',displayName:'Internal',hidden:true}],nextCursor:'next'};
      console.log(JSON.stringify({id:m.id,result}));
    }else process.exit(1);
  });`));
  assert.deepEqual(models.map((m) => m.id), ['gpt-first', 'gpt-future']);
});

test('CLI errors, invalid metadata, repeated cursors and timeouts fail without leaking raw diagnostics', async () => {
  await assert.rejects(discoverClaudeModels(fake(`console.error('secret-token');process.exit(2);`)), /exited before replying/);
  await assert.rejects(discoverClaudeModels(fake('setInterval(()=>{},1000)', 50)), /timed out/);
  await assert.rejects(discoverClaudeModels(fake(readLines + `console.log(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'secret-token'}}));});`)), /invalid response/);
  await assert.rejects(discoverClaudeModels(fake(readLines + `console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'--flag',displayName:'Bad'}]}}}));});`)), /invalid model metadata/);
  await assert.rejects(discoverCodexModels(fake(readLines + `console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{model:'valid',displayName:'Valid'}],nextCursor:'repeat'}}));});`)), /repeated a cursor/);
  await assert.rejects(discoverCodexModels(fake(readLines + `console.log(JSON.stringify({id:m.id,error:{message:'secret-token'}}));});`)), /initialization failed/);
});

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
