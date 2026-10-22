import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMention, type MentionEvent } from '../src/mentions';

const mention: MentionEvent = { channel: 'CDEV', ts: '123.456', text: '<@UBOT> check backups' };

function fixture(failure?: unknown) {
  const calls: unknown[] = [];
  const client = {
    reactions: { add: async (args: unknown) => { calls.push(['reaction', args]); if (failure) throw failure; } },
  };
  const dispatch = async (_client: unknown, key: string, channel: string, ts: string, text: string) => {
    calls.push(['reply', { key, channel, thread_ts: ts, text }]);
  };
  const warnings: string[] = [];
  return { calls, client, dispatch, warnings, warn: (s: string) => warnings.push(s) };
}

test('eyes acknowledgement precedes the reply in a new thread', async () => {
  const f = fixture();
  await handleMention(mention, f.client, f.dispatch, f.warn);
  assert.deepEqual(f.calls, [
    ['reaction', { channel: 'CDEV', timestamp: '123.456', name: 'eyes' }],
    ['reply', { key: '123.456', channel: 'CDEV', thread_ts: '123.456', text: 'check backups' }],
  ]);
});

test('reacts on the mention and replies under the existing thread root', async () => {
  const f = fixture();
  await handleMention({ ...mention, thread_ts: '100.000' }, f.client, f.dispatch, f.warn);
  assert.deepEqual(f.calls, [
    ['reaction', { channel: 'CDEV', timestamp: '123.456', name: 'eyes' }],
    ['reply', { key: '100.000', channel: 'CDEV', thread_ts: '100.000', text: 'check backups' }],
  ]);
});

test('reaction failure still dispatches and never logs SDK credentials', async () => {
  const f = fixture({ data: { error: 'missing_scope' }, token: 'private-fixture-value' });
  await handleMention(mention, f.client, f.dispatch, f.warn);
  assert.equal(f.calls.length, 2);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings.join(), /private-fixture-value/);
});

test('an existing eyes reaction is harmless', async () => {
  const f = fixture({ data: { error: 'already_reacted' } });
  await handleMention(mention, f.client, f.dispatch, f.warn);
  assert.equal(f.calls.length, 2);
  assert.equal(f.warnings.length, 0);
});

test('ignores bot echoes and empty mentions', async () => {
  const f = fixture();
  for (const event of [{ ...mention, bot_id: 'BBOT' }, { ...mention, subtype: 'bot_message' }, { ...mention, text: '<@UBOT> ' }]) {
    await handleMention(event, f.client, f.dispatch, f.warn);
  }
  assert.equal(f.calls.length, 0);
});
