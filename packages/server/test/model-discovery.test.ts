import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeModels, discoverCodexModels } from '../src/model-discovery.ts';

const fake = (code: string, timeoutMs = 3000) => ({ command: process.execPath, args: ['-e', code], timeoutMs });
const readLines = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);`;

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
    assert.deepEqual(models.find((m) => m.id === 'fable')?.aliases, ['claude-fable-5-1']);
    assert.deepEqual(models.find((m) => m.id === 'opus')?.aliases, ['claude-opus-future']);
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


test('GET /models asks a pinned member\'s own launcher, caches, and names a silent one', async () => {
  const { mkdtempSync: mk } = await import('node:fs');
  process.env.DB_PATH = join(mk(join(tmpdir(), 'propanes-models-')), 'test.db');
  const { runMigrations, sqlite } = await import('../src/db/index.ts');
  const { registerLauncher, resolveLauncherResponse } = await import('../src/launcher-registry.ts');
  const { modelRoutes } = await import('../src/routes/admin/models.ts');
  const { Hono } = await import('hono');
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, role, status, launcher_id, created_at, updated_at)
    VALUES ('m1', 'alice', 'x', 'member', 'active', 'vm-alice', ?, ?), ('m2', 'bob', 'x', 'member', 'active', 'vm-bob', ?, ?)`).run(now, now, now, now);

  const asked: any[] = [];
  const fakeWs = (answer: boolean) => ({
    readyState: 1,
    send: (raw: string) => {
      const msg = JSON.parse(raw);
      asked.push(msg);
      if (answer) setImmediate(() => resolveLauncherResponse({ type: 'discover_models_result', sessionId: msg.sessionId,
        models: [{ provider: 'Anthropic', runtime: 'claude', id: 'opus', label: 'Opus' }] } as any));
    },
    close: () => undefined,
  });
  const launcher = (id: string, answer: boolean) => ({ id, name: id, hostname: 'vm', ws: fakeWs(answer) as any, connectedAt: now,
    lastHeartbeat: now, activeSessions: new Set<string>(), capabilities: { maxSessions: 1, hasTmux: true, hasClaudeCli: true, hasDocker: false } as any });
  registerLauncher(launcher('vm-alice', true));

  const as = (id: string) => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user' as never, { id, role: 'member', orgId: null } as never); await next(); });
    app.route('/', modelRoutes);
    return app;
  };
  const res = await as('m1').request('/models?runtime=claude');
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.launcherId, 'vm-alice');
  assert.deepEqual(body.models.map((m: any) => m.id), ['opus']);
  assert.deepEqual(asked.map((m) => [m.type, m.runtime]), [['discover_models', 'claude']]);
  await as('m1').request('/models?runtime=claude');
  assert.equal(asked.length, 1, 'cached');

  assert.equal((await as('m1').request('/models?runtime=gpt')).status, 400);
  const offline = await as('m2').request('/models?runtime=codex');
  assert.equal(offline.status, 502);
  assert.match((await offline.json() as any).error, /vm-bob not connected/);
  sqlite.close();
});
