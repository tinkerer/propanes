import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSlackText, isStopKeyword, parseCommand, stripMentions } from '../src/options';

test('plain request has no options and keeps the text', () => {
  assert.deepEqual(parseCommand('<@UBOT> review PR 2013'), { command: 'prompt', text: 'review PR 2013' });
});

test('bracket options are case-insensitive and comma separated', () => {
  const c = parseCommand('<@UBOT> [Claude, VERBOSE, images] review PR 2013');
  assert.deepEqual(c, { command: 'prompt', runtime: 'claude', mode: 'verbose', images: true, text: 'review PR 2013' });
  assert.equal(parseCommand('[codex] [quiet] go').mode, 'quiet');
  assert.equal(parseCommand('[codex] [quiet] go').runtime, 'codex');
});

test('help and status never carry a prompt and reject combinations', () => {
  assert.equal(parseCommand('<@UBOT> [help]').command, 'help');
  assert.equal(parseCommand('[Status]').command, 'status');
  assert.match(parseCommand('[help, verbose]').error!, /cannot be combined/);
  assert.match(parseCommand('[help, status]').error!, /cannot be combined/);
});

test('unknown and conflicting options produce a helpful error', () => {
  assert.match(parseCommand('[claude, loud] do it').error!, /Unknown option: `loud`/);
  assert.match(parseCommand('[claude, codex] do it').error!, /not both/);
  assert.match(parseCommand('[verbose, quiet] do it').error!, /mutually exclusive/);
  assert.match(parseCommand('[quiet, default] do it').error!, /mutually exclusive/);
});

test('options alone (mode change inside a thread) leave the text empty', () => {
  assert.deepEqual(parseCommand('[verbose]'), { command: 'prompt', mode: 'verbose', text: '' });
  assert.deepEqual(parseCommand('[default]'), { command: 'prompt', mode: 'default', text: '' });
});

test('only the bot mention is stripped when its id is known', () => {
  assert.equal(stripMentions('<@UBOT> ask <@UALICE> about it', 'UBOT'), 'ask <@UALICE> about it');
  assert.equal(stripMentions('<@UBOT|amirobot> hi'), 'hi');
});

test('stop keywords', () => {
  for (const t of ['stop', 'Stop.', ' cancel ', 'KILL!', 'halt']) assert.equal(isStopKeyword(t), true, t);
  for (const t of ['stop the build', 'please stop', '']) assert.equal(isStopKeyword(t), false, t);
});

test('Slack link and entity markup is decoded before the text reaches the agent', () => {
  assert.equal(decodeSlackText('<mailto:zack@example.test|zack@example.test> could not log in to <https://app.example.test/login|the app> &amp; <https://x.test> in <#C1|ops> <!here>'),
    'zack@example.test could not log in to the app (https://app.example.test/login) & https://x.test in #ops @here');
  assert.equal(parseCommand('<@UBOT> [claude] check <https://a.test/b|a.test/b>', 'UBOT').text, 'check a.test/b (https://a.test/b)');
  assert.equal(decodeSlackText('1 &lt; 2 <@UALICE>'), '1 < 2 <@UALICE>');
});

test('[app:<name>] selects an application and [list-apps] is a standalone command', () => {
  assert.deepEqual(parseCommand('<@UBOT> [claude, app:storefront] add a toggle'), { command: 'prompt', runtime: 'claude', app: 'storefront', text: 'add a toggle' });
  assert.equal(parseCommand('[App: Reports Staging] go').app, 'reports staging');
  assert.equal(parseCommand('[app=atlas] go').app, 'atlas');
  assert.equal(parseCommand('[list-apps]').command, 'list-apps');
  assert.equal(parseCommand('[apps]').command, 'list-apps');
  assert.match(parseCommand('[list-apps, claude]').error!, /cannot be combined/);
  assert.match(parseCommand('[help, app:x]').error!, /cannot be combined/);
  assert.match(parseCommand('[app:a, app:b] go').error!, /Choose one application/);
  assert.match(parseCommand('[app:] go').error!, /needs a name, e.g. `\[app:my-app\]`/);
});

test('[infra:<name>] selects a target and [list-infra] is standalone', () => {
  assert.deepEqual(parseCommand('<@UBOT> [codex, app:propanes, infra:laptop] build it'), { command: 'prompt', runtime: 'codex', app: 'propanes', infra: 'laptop', text: 'build it' });
  assert.equal(parseCommand('[Infra = dev-laptop.local] go').infra, 'dev-laptop.local');
  assert.equal(parseCommand('[list-infra]').command, 'list-infra');
  assert.equal(parseCommand('[infra]').command, 'list-infra');
  assert.equal(parseCommand('[machines]').command, 'list-infra');
  assert.match(parseCommand('[list-infra, infra:x]').error!, /cannot be combined/);
  assert.match(parseCommand('[infra:a, infra:b] go').error!, /Choose one infrastructure target/);
  assert.match(parseCommand('[infra:] go').error!, /needs a name/);
});


test('terminal selectors accept whitespace, commas and separate groups', () => {
  assert.deepEqual(parseCommand('[terminal]'), { command: 'prompt', terminal: true, text: '' });
  assert.deepEqual(parseCommand('[infra:macbook terminal]'), { command: 'prompt', infra: 'macbook', terminal: true, text: '' });
  assert.deepEqual(parseCommand('[terminal app:Propanes Admin infra:MacBook]'), {
    command: 'prompt', app: 'propanes admin', infra: 'macbook', terminal: true, text: '',
  });
  assert.deepEqual(parseCommand('[APP=Propanes Admin] [Infra=MacBook, codex] fix it'), {
    command: 'prompt', app: 'propanes admin', infra: 'macbook', runtime: 'codex', text: 'fix it',
  });
});

test('terminal rejects agent/output options, prompt text and standalone commands', () => {
  for (const input of ['[terminal codex]', '[terminal quiet]', '[terminal images]', '[terminal] run ls', '[terminal help]', '[terminal list-infra]']) {
    assert.ok(parseCommand(input).error, input);
  }
});
