import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mention, threadReply, line } from './helpers.js';

test('[verbose, images] sent as a thread reply changes delivery for the rest of the thread', async () => {
  const f = fixture();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  f.steps.push(
    () => { f.world.session('S1').lines.push(line.toolUse('Bash', { command: 'ls' }, 't1'), line.toolResult('t1', 'a'), line.assistant('first')); },
    () => { void f.bridge.handleEvent(threadReply('[verbose, images]')); },
    () => undefined,
    () => undefined,
    () => {
      f.world.session('S1').lines.push(
        line.toolUse('Read', { file_path: '/tmp/shot.png' }, 'r1'),
        line.toolResult('r1', [{ type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } }]),
        line.assistant('second'),
      );
    },
    () => { f.world.session('S1').status = 'completed'; },
  );
  await f.bridge.handleEvent(mention('start'));
  await f.bridge.drain();
  const texts = f.slack.texts();
  const firstAt = texts.indexOf('first');
  assert.ok(firstAt > 0, texts.join('|'));
  assert.ok(!texts.slice(0, firstAt).some((t) => /Bash/.test(t)), 'default mode hides the first tool call: ' + texts.join('|'));
  const noteAt = texts.findIndex((t) => /Updated this thread: \*output\* verbose · \*images\* on/.test(t));
  assert.ok(noteAt > firstAt, texts.join('|'));
  assert.ok(texts.slice(noteAt).some((t) => /Read/.test(t) && /shot\.png/.test(t)), 'verbose mode shows the later tool call: ' + texts.join('|'));
  assert.ok(texts.includes('second'));
  assert.deepEqual(f.slack.uploads.map((u) => u.title), ['Read /tmp/shot.png']);
});
