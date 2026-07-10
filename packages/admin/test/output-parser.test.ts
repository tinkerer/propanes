// Behavior tests for JsonOutputParser — Claude `--output-format stream-json`
// and transcript JSONL classification. Pins the semantics ported from
// agent-portal #1233 (classify tool results before human source) and #1204
// (compaction as typed system messages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonOutputParser, type ParsedMessage } from '../src/lib/output-parser.ts';

function feed(lines: object[]): ParsedMessage[] {
  return new JsonOutputParser().feed(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function roles(msgs: ParsedMessage[]): string[] {
  return msgs.map((m) => m.role);
}

// --- #1233: classify tool results before human source ---

test('user envelope with only tool_result blocks emits tool_result, never user_input', () => {
  const msgs = feed([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] } },
  ]);
  assert.deepEqual(roles(msgs), ['tool_result']);
  assert.equal(msgs[0].content, 'file contents');
});

test('text blocks riding along in a tool_result envelope are system, not "You"', () => {
  // The harness injects system-reminders as text blocks inside the user
  // envelope that returns tool results. The operator never typed them.
  const msgs = feed([
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: '<system-reminder>injected context</system-reminder>' },
        ],
      },
    },
  ]);
  const textMsg = msgs.find((m) => String(m.content).includes('system-reminder'));
  assert.ok(textMsg, 'text block should be emitted');
  assert.equal(textMsg!.role, 'system');
  assert.ok(msgs.some((m) => m.role === 'tool_result'));
  assert.ok(!msgs.some((m) => m.role === 'user_input'));
});

test('plain user text still classifies as user_input', () => {
  const msgs = feed([
    { type: 'user', message: { content: [{ type: 'text', text: 'hello there' }] } },
  ]);
  assert.deepEqual(roles(msgs), ['user_input']);
  assert.equal(msgs[0].content, 'hello there');
});

// --- #1204: compaction as typed system messages ---

test('compacting status renders as a system line', () => {
  const msgs = feed([{ type: 'system', status: 'compacting' }]);
  assert.deepEqual(roles(msgs), ['system']);
  assert.match(String(msgs[0].content), /compacting/i);
});

test('compact_boundary renders trigger and pre-token count', () => {
  const msgs = feed([
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 155000 } },
  ]);
  assert.deepEqual(roles(msgs), ['system']);
  assert.match(String(msgs[0].content), /Context compacted/);
  assert.match(String(msgs[0].content), /auto/);
  assert.match(String(msgs[0].content), /155,000/);
});

test('isCompactSummary user message renders as system, not operator input', () => {
  const msgs = feed([
    { type: 'user', isCompactSummary: true, message: { content: 'The conversation so far…' } },
  ]);
  assert.deepEqual(roles(msgs), ['system']);
  assert.match(String(msgs[0].content), /The conversation so far/);
});

// --- Baseline stream-json behavior guarded by the refactors ---

test('assistant message with text and tool_use emits both roles in order', () => {
  const msgs = feed([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  ]);
  assert.deepEqual(roles(msgs), ['assistant', 'tool_use']);
  assert.equal(msgs[1].toolName, 'Bash');
  assert.deepEqual(msgs[1].toolInput, { command: 'ls' });
});

test('result event with cost/duration emits a system summary', () => {
  const msgs = feed([
    { type: 'result', subtype: 'success', duration_ms: 1234, total_cost_usd: 0.05, result: 'done' },
  ]);
  assert.ok(msgs.length >= 1);
  assert.ok(msgs.every((m) => m.role === 'system' || m.role === 'assistant'));
});
