import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

const temp = mkdtempSync(join(tmpdir(), 'propanes-session-model-'));
process.env.DB_PATH = join(temp, 'test.db');
process.env.NODE_ENV = 'test';
const requests: Record<string, any>[] = [];
const service = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
});
service.listen(0, '127.0.0.1');
await once(service, 'listening');
process.env.SESSION_SERVICE_URL = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
const { db, schema, sqlite, runMigrations } = await import('../src/db/index.ts');
const { dispatchFeedbackToAgent, resumeAgentSession } = await import('../src/dispatch.ts');
const { registerLauncher, unregisterLauncher } = await import('../src/launcher-registry.ts');
const { dispatchSchema } = await import('@propanes/shared');
runMigrations();
const now = new Date().toISOString();
db.insert(schema.feedbackItems).values({ id: 'feedback', type: 'manual', status: 'new', title: 'Model test', description: 'Test', createdAt: now, updatedAt: now }).run();
for (const runtime of ['claude', 'codex']) {
  db.insert(schema.agentEndpoints).values({ id: runtime, name: runtime, url: '', mode: 'interactive', runtime, permissionProfile: 'interactive-yolo', createdAt: now, updatedAt: now }).run();
}
test.after(() => { service.close(); service.closeAllConnections(); sqlite.close(); rmSync(temp, { recursive: true, force: true }); });

async function waitForSpawn(sessionId: string) {
  const deadline = Date.now() + 5000;
  while (!requests.some((r) => r.sessionId === sessionId)) {
    if (Date.now() > deadline) assert.fail(`No spawn received for ${sessionId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return requests.find((r) => r.sessionId === sessionId)!;
}

test('explicit model reaches the local session service for both providers', async () => {
  for (const [runtime, model] of [['claude', 'sonnet'], ['codex', 'gpt-6-astra']]) {
    const result = await dispatchFeedbackToAgent({ feedbackId: 'feedback', agentEndpointId: runtime, model });
    assert.ok(result.sessionId);
    const spawn = await waitForSpawn(result.sessionId);
    assert.equal(spawn.model, model);
    assert.equal(spawn.runtime, runtime);
    sqlite.prepare("UPDATE agent_sessions SET status = 'completed' WHERE id = ?").run(result.sessionId);
  }
});

test('native Claude resumes pass the newly selected model to the local service', async () => {
  db.insert(schema.agentSessions).values({ id: 'parent', feedbackId: 'feedback', agentEndpointId: 'claude', runtime: 'claude', permissionProfile: 'interactive-yolo', status: 'completed', claudeSessionId: 'native-id', cwd: temp, outputBytes: 0, createdAt: now }).run();
  const { sessionId } = await resumeAgentSession('parent', null, undefined, 'Continue', undefined, 'opus');
  const spawn = await waitForSpawn(sessionId);
  assert.equal(spawn.model, 'opus');
  assert.equal(spawn.resumeSessionId, 'native-id');
});

test('remote dispatch and native resumes retain the selected model in launcher messages', async () => {
  sqlite.exec("UPDATE agent_sessions SET status = 'completed'");
  const messages: any[] = [];
  registerLauncher({ id: 'remote', name: 'Remote', hostname: 'remote', ws: { readyState: 1, send: (m: string) => messages.push(JSON.parse(m)) } as any,
    capabilities: { maxSessions: 5, hasClaudeCli: true }, activeSessions: new Set(), connectedAt: now, lastHeartbeat: now });
  try {
    await dispatchFeedbackToAgent({ feedbackId: 'feedback', agentEndpointId: 'codex', launcherId: 'remote', model: 'gpt-6-astra' });
    assert.equal(messages.at(-1).model, 'gpt-6-astra');
    db.insert(schema.agentSessions).values({ id: 'remote-parent', runtime: 'claude', permissionProfile: 'interactive-yolo', status: 'completed', claudeSessionId: 'remote-native-id', launcherId: 'remote', cwd: temp, outputBytes: 0, createdAt: now }).run();
    await resumeAgentSession('remote-parent', undefined, undefined, 'Continue', undefined, 'sonnet');
    assert.equal(messages.at(-1).model, 'sonnet');
    assert.equal(messages.at(-1).resumeSessionId, 'remote-native-id');
  } finally { unregisterLauncher('remote'); }
});

test('dispatch validation accepts model IDs and rejects flags, whitespace and non-string values', () => {
  const input = { feedbackId: 'feedback', agentEndpointId: 'claude' };
  assert.ok(dispatchSchema.safeParse({ ...input, model: 'gpt-6-astra' }).success);
  for (const model of ['', '--flag', 'model name', 'opus\n--flag', 1]) {
    assert.equal(dispatchSchema.safeParse({ ...input, model }).success, false);
  }
});

test('Codex model arguments target the actual subcommand for new, headless and resumed sessions', async () => {
  const { buildCodexArgs } = await import('../src/codex-bin.ts');
  for (const pipe of [false, true]) {
    for (const resumeSessionId of [undefined, 'native-id']) {
      const args = buildCodexArgs({ pipe, resumeSessionId, skip: true, prompt: 'task', model: 'gpt-6-astra' });
      const prefix = [...(pipe ? ['exec'] : []), ...(resumeSessionId ? ['resume'] : [])];
      assert.deepEqual(args.slice(0, prefix.length + 2), [...prefix, '--model', 'gpt-6-astra']);
      assert.equal(args.at(-1), 'task');
      if (resumeSessionId) assert.equal(args.at(-2), resumeSessionId);
    }
  }
});
