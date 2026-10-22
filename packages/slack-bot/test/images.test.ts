import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractImageRefs, filenameFor } from '../src/images';
import type { ParsedMessage } from '../src/transcript';

const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const toolUses = new Map<string, ParsedMessage>([
  ['t1', { id: 'u', role: 'tool_use', timestamp: 0, content: '', toolName: 'Read', toolInput: { file_path: '/tmp/pw_screen.png' }, toolUseId: 't1' }],
]);

test('images come only from tool_result image blocks, labelled by the tool call', () => {
  const inline: ParsedMessage = { id: 'r', role: 'tool_result', timestamp: 0, content: `data:image/png;base64,${png}`, toolUseResultId: 't1' };
  const [ref] = extractImageRefs(inline, toolUses);
  assert.equal(ref.source.kind, 'data');
  assert.equal(ref.label, 'Read /tmp/pw_screen.png');
  assert.match(ref.id, /^sha1:/);

  const elided: ParsedMessage = { id: 'r2', role: 'tool_result', timestamp: 0, content: '/api/v1/admin/agent-sessions/S1/jsonl-image/abc-123/0', toolUseResultId: 't1' };
  const [url] = extractImageRefs(elided, toolUses);
  assert.deepEqual(url.source, { kind: 'url', path: '/api/v1/admin/agent-sessions/S1/jsonl-image/abc-123/0' });
});

test('file paths in text and non-result messages never become uploads', () => {
  const chatty: ParsedMessage = { id: 'a', role: 'assistant', timestamp: 0, content: 'see /tmp/pw_screen.png and data:image/png;base64,AAAA' };
  assert.deepEqual(extractImageRefs(chatty, toolUses), []);
  const textResult: ParsedMessage = { id: 'r', role: 'tool_result', timestamp: 0, content: 'wrote /tmp/out.png (12 KB)' };
  assert.deepEqual(extractImageRefs(textResult, toolUses), []);
});

test('filenames are derived from the label and mime', () => {
  assert.equal(filenameFor('Read /tmp/pw_screen.png', 'image/png', 2), 'pw_screen-2.png');
  assert.equal(filenameFor('image viewed by the agent', 'image/jpeg', 1), 'agent-1.jpg');
});
