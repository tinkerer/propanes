import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptAccumulator } from '../src/lib/transcript-accumulator.ts';

function line(value: object): string {
  return JSON.stringify(value);
}

test('incremental transcript parsing continues after a Claude compaction', () => {
  const stream = new TranscriptAccumulator();
  const key = 'session.jsonl';
  const before = stream.apply('claude', [key], [{
    key,
    lines: line({ type: 'assistant', message: { content: [{ type: 'text', text: 'before' }] } }),
  }], true);
  assert.equal(before.at(-1)?.content, 'before');

  const compacted = stream.apply('claude', [key], [{
    key,
    lines: [
      line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 155000 } }),
      line({ type: 'user', isCompactSummary: true, message: { content: 'Earlier work summary' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'after' }] } }),
    ].join('\n'),
  }], false);

  assert.deepEqual(compacted.map((message) => message.role), ['assistant', 'system', 'system', 'assistant']);
  assert.equal(compacted.at(-1)?.content, 'after');
});

test('merged files keep unique stable message ids across incremental updates', () => {
  const stream = new TranscriptAccumulator();
  const initial = stream.apply('claude', ['main.jsonl', 'sub.jsonl'], [
    { key: 'main.jsonl', lines: line({ type: 'assistant', message: { content: [{ type: 'text', text: 'main' }] } }) },
    { key: 'sub.jsonl', lines: line({ type: 'assistant', message: { content: [{ type: 'text', text: 'sub' }] } }) },
  ], true);
  assert.equal(new Set(initial.map((message) => message.id)).size, initial.length);

  const updated = stream.apply('claude', ['main.jsonl', 'sub.jsonl'], [
    { key: 'main.jsonl', lines: line({ type: 'assistant', message: { content: [{ type: 'text', text: 'latest' }] } }) },
  ], false);
  assert.deepEqual(updated.map((message) => message.content), ['main', 'latest', 'sub']);
  assert.equal(updated[0].id, initial[0].id);
  assert.equal(updated.at(-1)?.id, initial.at(-1)?.id);
});

test('prepended history pages render above the loaded tail with unique ids', () => {
  const stream = new TranscriptAccumulator();
  const text = (t: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
  stream.apply('claude', ['main.jsonl'], [{ key: 'main.jsonl', lines: text('latest') }], true);
  stream.prepend('claude', ['main.jsonl'], [{ key: 'main.jsonl', lines: text('older') }]);
  const merged = stream.prepend('claude', ['main.jsonl'], [{ key: 'main.jsonl', lines: text('oldest') }]);
  assert.deepEqual(merged.map((m) => m.content), ['oldest', 'older', 'latest']);
  assert.equal(new Set(merged.map((m) => m.id)).size, merged.length);

  // Appends keep history in place; a reset drops it.
  const appended = stream.apply('claude', ['main.jsonl'], [{ key: 'main.jsonl', lines: text('newest') }], false);
  assert.deepEqual(appended.map((m) => m.content), ['oldest', 'older', 'latest', 'newest']);
  assert.deepEqual(appended.slice(0, 3).map((m) => m.id), merged.map((m) => m.id));
  const reset = stream.apply('claude', ['main.jsonl'], [{ key: 'main.jsonl', lines: text('fresh') }], true);
  assert.deepEqual(reset.map((m) => m.content), ['fresh']);
});
