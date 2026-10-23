import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionAliveNow, LAUNCHER_REPORT_GRACE_MS, type LivenessContext } from '../src/agent-sessions.ts';
import { registerLauncher, unregisterLauncher } from '../src/launcher-registry.ts';

const ctx: LivenessContext = { activeSvcSessions: new Set(), serviceTmuxSessions: new Set(), tmuxAvailable: true, launcherSessions: new Set() };

function fakeLauncher(id: string, connectedAgoMs: number, readyState = 1) {
  registerLauncher({
    id, name: id, hostname: `${id}.example.test`,
    ws: { readyState } as any,
    connectedAt: new Date(Date.now() - connectedAgoMs).toISOString(),
    lastHeartbeat: new Date().toISOString(),
    activeSessions: new Set(),
    capabilities: { maxSessions: 5 } as any,
  });
}

test('a remote session is never declared dead while its launcher is disconnected or just reconnected', () => {
  assert.equal(isSessionAliveNow('S1', 'nowhere', ctx), null, 'unknown launcher');
  fakeLauncher('fresh', 5_000);
  assert.equal(isSessionAliveNow('S1', 'fresh', ctx), null, 'reconnected, no heartbeat yet');
  fakeLauncher('closed', LAUNCHER_REPORT_GRACE_MS * 2, 3);
  assert.equal(isSessionAliveNow('S1', 'closed', ctx), null, 'socket closing');
  unregisterLauncher('fresh'); unregisterLauncher('closed');
});

test('a remote session is dead once a settled, connected launcher stops listing it', () => {
  fakeLauncher('settled', LAUNCHER_REPORT_GRACE_MS * 2);
  assert.equal(isSessionAliveNow('S1', 'settled', ctx), false);
  assert.equal(isSessionAliveNow('S1', 'settled', { ...ctx, launcherSessions: new Set(['S1']) }), true);
  unregisterLauncher('settled');
});

test('local sessions keep the session-service rules', () => {
  assert.equal(isSessionAliveNow('L1', null, ctx), false);
  assert.equal(isSessionAliveNow('L1', null, { ...ctx, activeSvcSessions: null }), null);
  assert.equal(isSessionAliveNow('L1', null, { ...ctx, serviceTmuxSessions: new Set(['L1']) }), true);
});
