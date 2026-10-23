import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStopKeyword, parseCommand, stripMentions } from '../src/options';

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

test('terminal and target selectors accept whitespace, commas and separate groups', () => {
  assert.deepEqual(parseCommand('[terminal]'), { command: 'prompt', terminal: true, text: '' });
  assert.deepEqual(parseCommand('[infra:macbook terminal]'), { command: 'prompt', infra: 'macbook', terminal: true, text: '' });
  assert.deepEqual(parseCommand('[APP:Propanes Admin] [Infra:MacBook, codex] fix it'), {
    command: 'prompt', app: 'Propanes Admin', infra: 'MacBook', runtime: 'codex', text: 'fix it',
  });
  assert.deepEqual(parseCommand('[terminal app:Propanes Admin infra:MacBook]'), {
    command: 'prompt', app: 'Propanes Admin', infra: 'MacBook', terminal: true, text: '',
  });
});

test('empty, duplicate and conflicting target/terminal options cannot dispatch', () => {
  for (const input of ['[app:]', '[infra:]', '[app:a app:b]', '[infra:a] [infra:b]', '[help app:foo]', '[status infra:foo]', '[terminal codex]', '[terminal quiet]', '[terminal images]', '[terminal] run ls']) {
    assert.ok(parseCommand(input).error, input);
  }
  assert.equal(parseCommand('[HELP]').error, undefined);
});
