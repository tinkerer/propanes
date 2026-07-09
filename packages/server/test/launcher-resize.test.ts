import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { registerLauncher, unregisterLauncher } from '../src/launcher-registry.js';
import { attachAdmin, detachAdmin, forwardToService } from '../src/agent-sessions.js';

// A duck-typed stand-in for a `ws` WebSocket: records everything sent to it and
// reports OPEN (readyState 1).
function fakeSocket() {
  const sent: any[] = [];
  return {
    readyState: 1,
    sent,
    send(data: string) { sent.push(JSON.parse(data)); },
    close() {},
    on() {},
  } as any;
}

// Latest resize_session cols/rows the launcher received, or null.
function lastResize(launcherWs: any): { cols: number; rows: number } | null {
  for (let i = launcherWs.sent.length - 1; i >= 0; i--) {
    const m = launcherWs.sent[i];
    if (m.type === 'resize_session') return { cols: m.cols, rows: m.rows };
  }
  return null;
}

const seqResize = (seq: number, cols: number, rows: number) =>
  JSON.stringify({ type: 'sequenced_input', seq, content: { kind: 'resize', cols, rows } });

test('launcher PTY sizes to largest attached viewer, not last writer', () => {
  const launcherId = 'test-launcher-resize';
  const sessionId = 'test-session-resize-1';
  const launcherWs = fakeSocket();

  registerLauncher({
    id: launcherId,
    name: 'test',
    hostname: 'test',
    ws: launcherWs,
    connectedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    activeSessions: new Set([sessionId]),
    capabilities: {} as any,
    isLocal: true,
  });

  db.insert(schema.agentSessions).values({
    id: sessionId,
    status: 'running',
    runtime: 'claude',
    permissionProfile: 'interactive-yolo',
    launcherId,
    cwd: '/tmp',
    createdAt: new Date().toISOString(),
  } as any).run();

  try {
    const a = fakeSocket(); // tall viewer
    const b = fakeSocket(); // short viewer
    assert.ok(attachAdmin(sessionId, a), 'admin A attaches');
    assert.ok(attachAdmin(sessionId, b), 'admin B attaches');

    // A requests a tall/wide size.
    forwardToService(a, seqResize(1, 150, 55));
    assert.deepEqual(lastResize(launcherWs), { cols: 150, rows: 55 }, 'A sets the PTY size');

    // B requests a smaller size while A is still attached — must NOT shrink it.
    forwardToService(b, seqResize(1, 100, 30));
    assert.deepEqual(lastResize(launcherWs), { cols: 150, rows: 55 }, 'short viewer B cannot shrink the shared PTY');

    // B insists — still the max.
    forwardToService(b, seqResize(2, 100, 30));
    assert.deepEqual(lastResize(launcherWs), { cols: 150, rows: 55 }, 'repeated small resize still capped to max');

    // A detaches — PTY shrinks to the only remaining viewer (B).
    detachAdmin(sessionId, a);
    assert.deepEqual(lastResize(launcherWs), { cols: 100, rows: 30 }, 'closing the large pane shrinks PTY to remaining viewer');

    // Per-axis max: a wide-but-short viewer and a narrow-but-tall viewer combine.
    const c = fakeSocket();
    assert.ok(attachAdmin(sessionId, c));
    forwardToService(b, seqResize(3, 200, 20)); // wide, short
    forwardToService(c, seqResize(1, 80, 60));  // narrow, tall
    assert.deepEqual(lastResize(launcherWs), { cols: 200, rows: 60 }, 'per-axis max across viewers');

    detachAdmin(sessionId, b);
    detachAdmin(sessionId, c);
  } finally {
    db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).run();
    unregisterLauncher(launcherId);
  }
});
