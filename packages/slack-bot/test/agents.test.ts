import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentUnavailableError, configuredDefaultRuntime, resolveAgentEndpoint, type AgentEndpointInfo } from '../src/agents';

const APP = 'app-1';
const agents: AgentEndpointInfo[] = [
  { id: 'a-default-require', name: 'Claude Code (headless)', runtime: 'claude', permissionProfile: 'interactive-require', mode: 'headless', isDefault: true, appId: APP },
  { id: 'a-headless-yolo', name: 'Claude full auto', runtime: 'claude', permissionProfile: 'headless-yolo', mode: 'headless', appId: APP },
  { id: 'a-yolo', name: 'yolo', runtime: 'claude', permissionProfile: 'interactive-yolo', mode: 'interactive' },
  { id: 'c-yolo', name: 'codex-yolo', runtime: 'codex', permissionProfile: 'interactive-yolo', mode: 'interactive' },
  { id: 'c-require', name: 'codex', runtime: 'codex', permissionProfile: 'interactive-require', mode: 'interactive' },
  { id: 'w', name: 'webhook', runtime: 'claude', permissionProfile: 'interactive-yolo', mode: 'webhook', url: null },
];

test('the configured ProPanes default decides the runtime when nothing is remembered', () => {
  assert.equal(configuredDefaultRuntime(agents, APP), 'claude');
  assert.equal(configuredDefaultRuntime([{ id: 'x', runtime: 'codex', isDefault: true }], APP), 'codex');
  assert.equal(configuredDefaultRuntime([], APP), 'claude');
});

test('prefers an interactive skip-permissions endpoint of the requested runtime', () => {
  assert.equal(resolveAgentEndpoint(agents, 'claude', APP).id, 'a-yolo');
  assert.equal(resolveAgentEndpoint(agents, 'codex', APP).id, 'c-yolo');
});

test('never substitutes another runtime when the requested one is unavailable', () => {
  const claudeOnly = agents.filter((a) => a.runtime !== 'codex');
  assert.throws(() => resolveAgentEndpoint(claudeOnly, 'codex', APP), AgentUnavailableError);
  const requireOnly = agents.filter((a) => a.id === 'c-require');
  assert.throws(() => resolveAgentEndpoint(requireOnly, 'codex', APP), /skip-permissions/);
  assert.throws(() => resolveAgentEndpoint([agents[5]], 'claude', APP), /no endpoint/);
});

test('an explicit endpoint override must match the requested runtime', () => {
  assert.equal(resolveAgentEndpoint(agents, 'claude', APP, 'a-headless-yolo').id, 'a-headless-yolo');
  assert.throws(() => resolveAgentEndpoint(agents, 'codex', APP, 'a-headless-yolo'), /Claude endpoint/);
  assert.throws(() => resolveAgentEndpoint(agents, 'claude', APP, 'nope'), /not registered/);
});
