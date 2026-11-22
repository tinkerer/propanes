import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerAgents, resolvePickerAgentId, formatPickerOption } from '../src/lib/agent-matrix.js';

const ep = (id: string, runtime: string, permissionProfile: string, extra: Record<string, unknown> = {}) =>
  ({ id, runtime, permissionProfile, mode: 'interactive', name: id, appId: null as string | null, ...extra });

// Every app carries its own copy of each endpoint, plus the global set.
const perApp = (appId: string) => [
  ep(`${appId}-cy`, 'claude', 'interactive-yolo', { appId }),
  ep(`${appId}-ci`, 'claude', 'interactive-require', { appId, isDefault: true }),
  ep(`${appId}-xy`, 'codex', 'interactive-yolo', { appId }),
  ep(`${appId}-xi`, 'codex', 'interactive-require', { appId }),
];
const globals = [
  ep('g-ci', 'claude', 'interactive-require', { isDefault: true }),
  ep('g-cy', 'claude', 'interactive-yolo'),
  ep('g-ch', 'claude', 'headless-yolo'),
  ep('g-xi', 'codex', 'interactive-require'),
  ep('g-xy', 'codex', 'interactive-yolo'),
];
const all = [...perApp('a1'), ...perApp('a2'), ...perApp('a3'), ...globals];

test('the picker collapses per-app copies into four options, YOLO first', () => {
  const options = pickerAgents(all, '');
  assert.deepEqual(options.map(formatPickerOption), [
    '⚡ Claude YOLO',
    '⚡ Codex YOLO',
    '\u{1F441} Claude Interactive',
    '\u{1F441} Codex Interactive',
  ]);
  // Without an app in scope the global endpoints represent each slot.
  assert.deepEqual(options.map(o => o.id), ['g-cy', 'g-xy', 'g-ci', 'g-xi']);
});

test('an app in scope prefers its own endpoints over global ones', () => {
  const options = pickerAgents([...perApp('a2'), ...globals], 'a2');
  assert.deepEqual(options.map(o => o.id), ['a2-cy', 'a2-xy', 'a2-ci', 'a2-xi']);
  const partial = pickerAgents([ep('a2-xy', 'codex', 'interactive-yolo', { appId: 'a2' }), ...globals], 'a2');
  assert.deepEqual(partial.map(o => o.id), ['g-cy', 'a2-xy', 'g-ci', 'g-xi']);
});

test('defaults win within a slot and unusable webhooks are skipped', () => {
  const options = pickerAgents([
    ep('a', 'claude', 'interactive-yolo'),
    ep('b', 'claude', 'interactive-yolo', { isDefault: true }),
    ep('hook', 'codex', 'interactive-yolo', { mode: 'webhook', url: '' }),
  ]);
  assert.deepEqual(options.map(o => o.id), ['b']);
});

test('a setup with none of the four profiles still offers its endpoints', () => {
  const options = pickerAgents([ep('h1', 'claude', 'headless-yolo'), ep('h2', 'claude', 'headless-yolo')]);
  assert.deepEqual(options.map(o => o.id), ['h1']);
});

test('a saved selection snaps to the option with the same runtime and profile', () => {
  const options = pickerAgents(all, '');
  assert.equal(resolvePickerAgentId(options, all, 'g-xy'), 'g-xy');
  assert.equal(resolvePickerAgentId(options, all, 'a3-xy'), 'g-xy');
  assert.equal(resolvePickerAgentId(options, all, 'g-ch'), '');
  assert.equal(resolvePickerAgentId(options, all, 'gone'), '');
  assert.equal(resolvePickerAgentId(options, all, ''), '');
});
