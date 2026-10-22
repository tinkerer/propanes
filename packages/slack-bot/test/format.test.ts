import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText, coalesce, renderEvent, toMrkdwn } from '../src/format';
import type { ParsedMessage } from '../src/transcript';

const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({ id: 'm', role: 'assistant', timestamp: 0, content: '', ...over });

test('markdown becomes mrkdwn with escaping outside code fences', () => {
  assert.equal(toMrkdwn('**bold** a < b [x](https://e.com)'), '*bold* a &lt; b <https://e.com|x>');
  assert.equal(toMrkdwn('# Title\n- item'), '*Title*\n• item');
  assert.equal(toMrkdwn('```\n<raw>\n```'), '```\n&lt;raw&gt;\n```');
});

test('default mode forwards assistant text only; verbose adds tools, results and system lines', () => {
  const texts = [
    msg({ role: 'assistant', content: 'Looking now' }),
    msg({ role: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolUseId: 't1' }),
    msg({ role: 'tool_result', content: 'file.txt', toolUseResultId: 't1' }),
    msg({ role: 'thinking', content: 'hmm' }),
    msg({ role: 'system', content: 'Session complete | Cost: $0.01' }),
    msg({ role: 'user_input', content: 'the prompt' }),
  ];
  assert.deepEqual(texts.map((t) => renderEvent(t, 'default')), ['Looking now', null, null, null, null, null]);
  const verbose = texts.map((t) => renderEvent(t, 'verbose'));
  assert.equal(verbose[0], 'Looking now');
  assert.match(verbose[1]!, /🔧 \*Bash\*\n```\nls\n```/);
  assert.match(verbose[2]!, /↩︎ result\n```\nfile.txt\n```/);
  assert.match(verbose[3]!, /💭 _hmm_/);
  assert.match(verbose[4]!, /_Session complete/);
  assert.equal(verbose[5], null);
  assert.deepEqual(texts.map((t) => renderEvent(t, 'quiet')), [null, null, null, null, null, null]);
});

test('subagent commentary is hidden in default mode and marked in verbose', () => {
  const sub = msg({ role: 'assistant', content: 'inner', subagentId: 'agent-1' });
  assert.equal(renderEvent(sub, 'default'), null);
  assert.equal(renderEvent(sub, 'verbose'), '↳ inner');
});

test('cos-reply tags are stripped and image payloads replaced in results', () => {
  assert.equal(renderEvent(msg({ content: '<cos-reply>Final</cos-reply>' }), 'default'), 'Final');
  const r = renderEvent(msg({ role: 'tool_result', content: 'data:image/png;base64,AAAA' }), 'verbose')!;
  assert.match(r, /\[image\]/);
  assert.doesNotMatch(r, /base64/);
});

test('long output is chunked on paragraph boundaries with balanced code fences', () => {
  const para = 'x'.repeat(500);
  const text = Array.from({ length: 12 }, () => para).join('\n\n');
  const chunks = chunkText(text, 2000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk ${c.length}`);
  assert.equal(chunks.join('\n\n').replace(/\n+/g, ''), text.replace(/\n+/g, ''));

  const code = '```\n' + Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n```';
  const codeChunks = chunkText(code, 1000);
  for (const c of codeChunks) {
    assert.ok(c.length <= 1000);
    assert.equal((c.match(/```/g) || []).length % 2, 0, 'fences balanced in each chunk');
  }
});

test('coalesce packs consecutive pieces into few posts', () => {
  assert.deepEqual(coalesce(['a', 'b', 'c'], 100), ['a\n\nb\n\nc']);
  assert.equal(coalesce(['a'.repeat(90), 'b'.repeat(90)], 100).length, 2);
});
