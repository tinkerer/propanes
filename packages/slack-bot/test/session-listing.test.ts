import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listedSessions, sessionListing } from '../src/session-listing';
import { SLACK_CHUNK } from '../src/format';
import type { SessionInfo } from '../src/propanes';

const url = (id: string) => `https://propanes.example.test/admin/#/session/${id}`;
const sessions: SessionInfo[] = [
  { id: 'agent-running', title: 'Fix bug', runtime: 'codex', appId: 'app-1', status: 'running', permissionProfile: 'interactive-yolo' },
  { id: 'agent-pending', feedbackTitle: 'Queued task', appId: 'app-2', status: 'pending', permissionProfile: 'headless-yolo' },
  { id: 'agent-dispatching', appId: 'app-1', status: 'dispatching', permissionProfile: 'interactive-require' },
  { id: 'terminal-running', status: 'running', permissionProfile: 'plain', launcherName: 'MacBook' },
  { id: 'completed', status: 'completed', permissionProfile: 'interactive-yolo' },
  { id: 'killed-shell', status: 'killed', permissionProfile: 'plain' },
];

test('listings separate live agents from plain terminals and filter by resolved app ID', () => {
  const all = sessionListing(sessions, false, url).join('\n');
  assert.match(all, /Active sessions\* \(3\)/);
  assert.ok(all.includes(`<${url('agent-running')}|Fix bug>`));
  assert.ok(all.includes(`<${url('agent-pending')}|Queued task>`));
  assert.doesNotMatch(all, /terminal-running|completed|killed-shell/);
  const filtered = sessionListing(sessions, false, url, { id: 'app-1', name: 'Propanes' }).join('\n');
  assert.match(filtered, /Active sessions for Propanes\* \(2\)/);
  assert.doesNotMatch(filtered, /agent-pending/);
  const terminals = sessionListing(sessions, true, url).join('\n');
  assert.ok(terminals.includes(`<${url('terminal-running')}|terminal-running>`));
  assert.match(terminals, /MacBook/);
  assert.doesNotMatch(terminals, /agent-running|killed-shell/);
});

test('empty lists explain scope and waiting/idle sessions stay active', () => {
  assert.deepEqual(sessionListing([], true, url), ['No active terminals.']);
  assert.deepEqual(sessionListing([], false, url, { id: 'x', name: 'Propanes' }), ['No active sessions for Propanes.']);
  const result = sessionListing([
    { id: 'waiting', status: 'running', inputState: 'waiting' },
    { id: 'idle', status: 'running', inputState: 'idle' },
  ], false, url).join('\n');
  assert.match(result, /waiting for input/);
  assert.match(result, /running, idle/);
});

test('listing titles cannot inject Slack links or mentions', () => {
  const result = sessionListing([{ id: 'one', status: 'running', title: 'Hello | <@EVERYONE>\n<https://evil.test|click>' }], false, url).join('\n');
  assert.match(result, /Hello ¦ &lt;@EVERYONE&gt;/);
  assert.doesNotMatch(result, /<https:\/\/evil|<@EVERYONE>/);
});

test('large listings include every active session in bounded messages with intact links', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `s-${i}`, status: 'running', title: 'Session '.repeat(40) }));
  const result = sessionListing(rows, false, url);
  assert.ok(result.length > 1);
  assert.ok(result.every(text => text.length <= SLACK_CHUNK));
  for (const row of rows) assert.equal(result.filter(text => text.includes(`<${url(row.id)}|`)).length, 1);
});

test('sessions from interleaved apps appear together beneath their app names', () => {
  const result = sessionListing(sessions, false, url, undefined, [
    { id: 'app-1', name: 'Storefront' },
    { id: 'app-2', name: 'ProPanes' },
  ]).join('\n');
  const first = result.indexOf('*Storefront*');
  const second = result.indexOf('*ProPanes*');
  assert.ok(first >= 0 && second > first);
  for (const id of ['agent-running', 'agent-dispatching']) {
    assert.ok(result.indexOf(url(id)) > first && result.indexOf(url(id)) < second);
  }
  assert.ok(result.indexOf(url('agent-pending')) > second);
  assert.equal(result.split('*Storefront*').length, 2);
});

test('app headings escape Slack syntax and distinguish unknown and unassigned apps', () => {
  const result = sessionListing([
    { id: 'known', appId: 'known-app', status: 'running' },
    { id: 'unknown', appId: 'deleted-app', status: 'running' },
    { id: 'unassigned', status: 'running' },
  ], false, url, undefined, [{ id: 'known-app', name: 'R&D <@EVERYONE>\nSuite' }]).join('\n');
  assert.ok(result.includes('*R&amp;D &lt;@EVERYONE&gt; Suite*\n1. '));
  assert.ok(result.includes('*Unknown app (deleted-app)*\n2. '));
  assert.ok(result.includes('*No app*\n3. '));
});

test('agent sessions are numbered across app groups in listedSessions order', () => {
  const result = sessionListing(sessions, false, url).join('\n');
  const order = listedSessions(sessions, false).flat().map(s => s.id);
  assert.deepEqual(order, ['agent-running', 'agent-dispatching', 'agent-pending']);
  order.forEach((id, i) => assert.ok(result.includes(`${i + 1}. <${url(id)}|`)));
  assert.match(result, /_Reply with the number to continue the session in Slack\._$/);
});
