import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlackIdentity } from '../src/identities';
import { SlackRouter } from '../src/router';
import { personaPoster, type PostArgs, type SlackPoster } from '../src/slack';
import { fixture, mention, threadReply } from './helpers';

const ALICE: SlackIdentity = { userId: 'u-alice', username: 'alice', role: 'member', slackUserId: 'UALICE', persona: 'alicebot' };

function setup(opts: { requireLink?: boolean; linked?: SlackIdentity[] } = {}) {
  const operator = fixture();
  const member = fixture({ config: { handoffChannel: 'UALICE', teamId: 'T1' } });
  const linked = opts.linked ?? [ALICE];
  const created: string[] = [];
  const router = new SlackRouter({
    operator: operator.bridge,
    operatorUserId: 'env-admin',
    directory: {
      lookup: async (id) => linked.find((i) => i.slackUserId === id),
      all: () => linked,
    },
    createBridge: (identity) => { created.push(identity.userId); return member.bridge; },
    slack: operator.slack,
    requireLink: opts.requireLink ?? false,
  });
  return { operator, member, router, created };
}

test('a linked member starts work in their own bridge; unlinked members act as the operator', async () => {
  const { operator, member, router } = setup();
  await router.handleEvent(mention('fix the login bug', { user: 'UALICE' }));
  await router.handleEvent(mention('review the deploy', { user: 'USOMEONE', ts: '300.000' }));
  await router.drain();
  assert.equal(member.world.sessions.size, 1, 'alice dispatched with her own client');
  assert.ok(member.world.calls.some((c) => c.startsWith('dispatch:')));
  assert.equal(operator.world.sessions.size, 1);
  assert.ok(operator.slack.texts().every((t) => !/not linked/.test(t)));
});

test('thread replies go to the thread owner; others get one notice and are not forwarded', async () => {
  const { operator, member, router } = setup();
  await router.handleEvent(mention('fix the login bug', { user: 'UALICE' }));
  await router.drain();
  const sends = () => member.world.calls.filter((c) => c.startsWith('send-keys') || c.startsWith('resume:')).length;
  const before = sends();

  await router.handleEvent(threadReply('also check the logout path', { user: 'UALICE' }));
  await router.drain();
  assert.equal(sends(), before + 1, "the owner's reply reaches her session");

  await router.handleEvent(threadReply('nice, thanks', { user: 'UBOB' }));
  await router.handleEvent(threadReply('<@UBOT> stop', { user: 'UBOB', mentionsBot: true }));
  await router.handleEvent(threadReply('<@UBOT> stop now', { user: 'UBOB', mentionsBot: true }));
  await router.drain();
  assert.equal(sends(), before + 1, 'nobody else drives her agent');
  assert.ok(!member.world.calls.some((c) => c.startsWith('kill:')));
  const notices = operator.slack.texts().filter((t) => /runs as \*alice\*/.test(t));
  assert.equal(notices.length, 1, 'chatter is ignored and the mention is explained once');
});

test('with SLACK_REQUIRE_LINK unlinked members are refused once per conversation', async () => {
  const { operator, router } = setup({ requireLink: true });
  await router.handleEvent(mention('do something', { user: 'USTRANGER' }));
  await router.handleEvent(threadReply('<@UBOT> please', { user: 'USTRANGER', mentionsBot: true }));
  await router.drain();
  assert.equal(operator.world.sessions.size, 0);
  assert.deepEqual(operator.slack.texts().filter((t) => /not linked/.test(t)).length, 1);
});

test('linking the operator account maps to the operator bridge', async () => {
  const { operator, member, router, created } = setup({ linked: [{ ...ALICE, userId: 'env-admin', slackUserId: 'UOPS' }] });
  await router.handleEvent(mention('hello there', { user: 'UOPS' }));
  await router.drain();
  assert.equal(operator.world.sessions.size, 1);
  assert.equal(member.world.sessions.size, 0);
  assert.deepEqual(created.filter((id) => id !== 'env-admin'), []);
});

test('start() builds a bridge for each linked user so their threads survive restarts', async () => {
  const first = setup();
  await first.router.handleEvent(mention('long task', { user: 'UALICE' }));
  await first.router.drain();
  const { created, router } = setup();
  router.start();
  assert.deepEqual(created, ['u-alice']);
});

test('personaPoster names messages and falls back without chat:write.customize', async () => {
  const posts: PostArgs[] = [];
  let rejectNamed = false;
  const inner: SlackPoster = {
    postMessage: async (args) => {
      if (rejectNamed && args.username) throw Object.assign(new Error('x'), { data: { error: 'missing_scope' } });
      posts.push(args);
      return { ok: true };
    },
    permalink: async () => '',
    addReaction: async () => undefined,
    uploadFile: async () => undefined,
  };
  const logs: string[] = [];
  await personaPoster(inner, 'alicebot', (m) => logs.push(m)).postMessage({ channel: 'C', text: 'a' });
  assert.equal(posts[0].username, 'alicebot');
  rejectNamed = true;
  const p = personaPoster(inner, 'alicebot', (m) => logs.push(m));
  await p.postMessage({ channel: 'C', text: 'b' });
  await p.postMessage({ channel: 'C', text: 'c' });
  assert.deepEqual(posts.slice(1).map((x) => [x.text, x.username]), [['b', undefined], ['c', undefined]]);
  assert.equal(logs.length, 1);
  assert.equal(personaPoster(inner, null, () => undefined), inner);
});

test('a DM follows the sender even if the operator bridge talked to them before linking', async () => {
  const { operator, member, router } = setup();
  const dm = { channel: 'D1', channelType: 'im' as const, threadTs: undefined, mentionsBot: false };
  await operator.bridge.handleEvent(mention('before linking', { ...dm, user: 'UALICE', text: 'before linking' }));
  await operator.bridge.drain();
  assert.equal(operator.world.sessions.size, 1);
  await router.handleEvent(mention('after linking', { ...dm, user: 'UALICE', ts: '500.000', text: 'after linking' }));
  await router.drain();
  assert.equal(member.world.sessions.size, 1);
  assert.ok(!operator.slack.texts().some((t) => /runs as/.test(t)));
});

test("a member's Continue in Slack opens in their DM through their own bridge", async () => {
  const { operator, member, router } = setup();
  const session = member.world.newSession('F1', 'claude');
  session.status = 'completed';
  await router.handleHandoff({ id: 'h1', sessionId: session.id, requestedBy: 'u-alice' });
  await router.drain();
  assert.deepEqual(member.world.handoffResults.map((r) => r.ok), [true], 'reported with her client');
  assert.equal(operator.world.handoffResults.length, 0);
  assert.equal(member.slack.posts[0].channel, 'UALICE');
  assert.match(member.slack.posts[0].text, /Moving a session here/);
  const root = member.slack.posts[1];
  assert.equal(root.channel, 'DUALICE', 'the thread lives in the DM channel Slack returned');

  // Her reply in that DM thread resumes the session in her bridge.
  await router.handleEvent(threadReply('carry on', { channel: 'DUALICE', channelType: 'im', user: 'UALICE', threadTs: '900.2' }));
  await router.drain();
  assert.ok(member.world.calls.some((c) => c.startsWith(`resume:${session.id}`)));
});

test("the operator's own requests keep using the operator bridge", async () => {
  const { operator, router } = setup();
  await router.handleHandoff({ id: 'h2', sessionId: 'nope', requestedBy: 'env-admin' });
  assert.equal(operator.world.handoffResults.length, 1);
});
