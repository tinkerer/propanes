// Behavior tests for CodexOutputParser — pins the classification behavior of
// the module extracted from output-parser.ts (agent-portal #1179–#1188 lift).
// Covers both on-the-wire formats: rollout JSONL and `codex exec --json`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexOutputParser } from '../src/lib/codex-output-parser.ts';
import type { ParsedMessage } from '../src/lib/output-parser.ts';

const TS = '2026-04-22T20:16:36.490Z';

function feed(lines: object[]): ParsedMessage[] {
  return new CodexOutputParser().feed(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function rollout(payloadType: string, payload: object) {
  return { timestamp: TS, type: payloadType, payload };
}

// --- Rollout format ---

test('session_meta emits a system line with id, cwd, and version', () => {
  const msgs = feed([
    rollout('session_meta', { id: '019db6d6-580b-7f71-b66e-8b029d2963b2', cwd: '/tmp', cli_version: '0.122.0' }),
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'Codex session | ID: 019db6d6 | cwd: /tmp | v0.122.0');
  assert.equal(msgs[0].timestamp, Date.parse(TS));
});

test('turn_context emits model/sandbox/approvals as a system line', () => {
  const msgs = feed([
    rollout('turn_context', { model: 'gpt-5.1-codex', sandbox_policy: { type: 'danger-full-access' }, approval_policy: 'never' }),
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'Model: gpt-5.1-codex | Sandbox: danger-full-access | Approvals: never');
  assert.equal(msgs[0].model, 'gpt-5.1-codex');
});

test('user message is deduped between event_msg and response_item variants', () => {
  const msgs = feed([
    rollout('event_msg', { type: 'user_message', message: 'fix the bug' }),
    rollout('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] }),
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user_input');
  assert.equal(msgs[0].content, 'fix the bug');
});

test('developer and system response_item messages are skipped', () => {
  const msgs = feed([
    rollout('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] }),
    rollout('response_item', { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'internal' }] }),
  ]);
  assert.equal(msgs.length, 0);
});

test('agent_message emits assistant; task_complete with the same text is deduped', () => {
  const msgs = feed([
    rollout('event_msg', { type: 'agent_message', message: 'All done.' }),
    rollout('event_msg', { type: 'task_complete', last_agent_message: 'All done.' }),
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, 'All done.');
});

test('exec_command function_call maps to Bash with joined argv', () => {
  const msgs = feed([
    rollout('response_item', {
      type: 'function_call', name: 'exec_command', call_id: 'call_1',
      arguments: JSON.stringify({ cmd: ['ls', '-la'], workdir: '/tmp' }),
    }),
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'tool_use');
  assert.equal(msgs[0].toolName, 'Bash');
  assert.deepEqual(msgs[0].toolInput, { command: 'ls -la', cwd: '/tmp' });
  assert.equal(msgs[0].toolUseId, 'call_1');
});

test('function_call_output strips the chunk header and flags non-zero exit', () => {
  const wrap = (code: number, out: string) =>
    `Chunk ID: abc\nWall time: 0.001 s\nProcess exited with code ${code}\nOriginal token count: 30\nOutput:\n${out}`;
  const ok = feed([rollout('response_item', { type: 'function_call_output', call_id: 'c1', output: wrap(0, 'file1\nfile2') })]);
  assert.equal(ok[0].role, 'tool_result');
  assert.equal(ok[0].content, 'file1\nfile2');
  assert.ok(!ok[0].isError);
  assert.equal(ok[0].toolUseResultId, 'c1');

  const bad = feed([rollout('response_item', { type: 'function_call_output', call_id: 'c2', output: wrap(1, 'boom') })]);
  assert.equal(bad[0].content, 'boom');
  assert.ok(bad[0].isError);
});

test('apply_patch custom tool call and its JSON-wrapped output', () => {
  const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch';
  const msgs = feed([
    rollout('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c3', input: patch }),
    rollout('response_item', {
      type: 'custom_tool_call_output', call_id: 'c3',
      output: JSON.stringify({ output: 'Success. Updated a.ts', metadata: { exit_code: 0, duration_seconds: 0.01 } }),
    }),
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['tool_use', 'tool_result']);
  assert.equal(msgs[0].toolName, 'apply_patch');
  assert.deepEqual(msgs[0].toolInput, { patch });
  assert.equal(msgs[1].content, 'Success. Updated a.ts');
  assert.ok(!msgs[1].isError);
});

test('reasoning with a readable summary emits thinking', () => {
  const msgs = feed([
    rollout('response_item', { type: 'reasoning', summary: [{ text: 'I should check the tests first.' }] }),
    rollout('response_item', { type: 'reasoning', summary: [] }), // encrypted/empty → skipped
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'thinking');
  assert.equal(msgs[0].content, 'I should check the tests first.');
});

// --- exec --json format ---

test('exec stream: started command attaches its result on completion', () => {
  const msgs = feed([
    { type: 'thread.started', thread_id: 'th_12345678abc' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls -la' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls -la', aggregated_output: 'file1\nfile2', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'tool_use', 'tool_result', 'assistant', 'system']);
  assert.equal(msgs[1].toolName, 'Bash');
  assert.equal(msgs[1].toolUseId, 'i1');
  assert.equal(msgs[2].toolUseResultId, 'i1');
  assert.ok(!msgs[2].isError);
  assert.equal(msgs[4].usage?.input_tokens, 100);
});

test('exec stream: completion without a started event synthesizes the tool_use', () => {
  const msgs = feed([
    { type: 'item.completed', item: { id: 'i9', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1 } },
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['tool_use', 'tool_result']);
  assert.equal(msgs[0].toolUseId, 'i9');
  assert.ok(msgs[1].isError);
});

test('exec stream: error events emit failed tool_results', () => {
  const msgs = feed([
    { type: 'error', message: 'boom' },
    { type: 'turn.failed', error: { message: 'usage limit reached' } },
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['tool_result', 'tool_result']);
  assert.ok(msgs.every((m) => m.isError));
  assert.equal(msgs[0].content, 'boom');
  assert.equal(msgs[1].content, 'usage limit reached');
});

test('exec stream: file_change renders as an apply_patch summary', () => {
  const msgs = feed([
    { type: 'item.completed', item: { id: 'i5', type: 'file_change', changes: [{ kind: 'update', path: 'src/a.ts' }, { kind: 'add', path: 'src/b.ts' }] } },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'tool_use');
  assert.equal(msgs[0].toolName, 'apply_patch');
  assert.equal(msgs[0].content, 'update src/a.ts\nadd src/b.ts');
});

test('partial lines buffer across feed() calls', () => {
  const parser = new CodexOutputParser();
  const line = JSON.stringify(rollout('event_msg', { type: 'user_message', message: 'split feed' }));
  const first = parser.feed(line.slice(0, 20));
  assert.equal(first.length, 0);
  const rest = parser.feed(line.slice(20) + '\n');
  assert.equal(rest.length, 1);
  assert.equal(rest[0].role, 'user_input');
  assert.equal(rest[0].content, 'split feed');
});
