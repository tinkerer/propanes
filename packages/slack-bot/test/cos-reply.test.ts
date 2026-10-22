import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosReplyBlocks, extractFinalCosReply, hasOpenCosReply, stripCosReplyTags } from '../src/cos-reply';

test('the last complete block wins over an early acknowledgement', () => {
  const texts = ['<cos-reply>Understood, looking now.</cos-reply>', 'working…', '<cos-reply>Done: 3 files changed.</cos-reply>'];
  assert.equal(extractFinalCosReply(texts), 'Done: 3 files changed.');
});

test('a partial (unclosed) block is never treated as the answer', () => {
  assert.equal(extractFinalCosReply(['<cos-reply>still typing']), null);
  assert.equal(hasOpenCosReply('<cos-reply>still typing'), true);
  assert.equal(hasOpenCosReply('<cos-reply>a</cos-reply>'), false);
  assert.equal(extractFinalCosReply(['no tags at all']), null);
});

test('blocks spanning assistant messages are joined before parsing', () => {
  assert.equal(extractFinalCosReply(['<cos-reply>part one', 'part two</cos-reply>']), 'part one\npart two');
  assert.deepEqual(cosReplyBlocks('<cos-reply></cos-reply><cos-reply> x </cos-reply>'), ['x']);
});

test('tags are stripped from forwarded text without leaking fragments', () => {
  assert.equal(stripCosReplyTags('Hi <cos-reply>answer</cos-reply> bye'), 'Hi answer bye');
  assert.equal(stripCosReplyTags('trailing <cos-rep'), 'trailing');
});
