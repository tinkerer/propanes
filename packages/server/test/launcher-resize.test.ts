import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-launcher-resize-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
const { db, schema, sqlite, runMigrations } = await import('../src/db/index.js');
const { registerLauncher, unregisterLauncher } = await import('../src/launcher-registry.js');
const { attachAdmin, detachAdmin, forwardToService } = await import('../src/agent-sessions.js');
runMigrations();
test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

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

// Latest pty_size notice a viewer socket received, or null.
function lastPtySize(viewer: any): { cols: number; rows: number } | null {
  for (let i = viewer.sent.length - 1; i >= 0; i--) {
    const m = viewer.sent[i];
    if (m.type === 'pty_size') return { cols: m.cols, rows: m.rows };
  }
  return null;
}

test('launcher PTY follows the most recent viewer request and tells every viewer', () => {
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

    forwardToService(a, seqResize(1, 150, 55));
    assert.deepEqual(lastResize(launcherWs), { cols: 150, rows: 55 }, 'A sets the PTY size');
    assert.deepEqual(lastPtySize(b), { cols: 150, rows: 55 }, 'B is told the grid to mirror');

    // B (focused now) asks for a smaller size — the PTY follows the newest
    // request; a smaller pane must never be left emulating a larger grid.
    forwardToService(b, seqResize(1, 100, 30));
    assert.deepEqual(lastResize(launcherWs), { cols: 100, rows: 30 }, 'most recent viewer wins');
    assert.deepEqual(lastPtySize(a), { cols: 100, rows: 30 }, 'A is told to mirror the smaller grid');

    const noticesBefore = a.sent.filter((m: any) => m.type === 'pty_size').length;
    forwardToService(b, seqResize(2, 100, 30));
    assert.equal(a.sent.filter((m: any) => m.type === 'pty_size').length, noticesBefore, 'unchanged size sends no notice');

    // The viewer that owns the current size detaches — fall back to the next
    // most recent viewer, not to nothing.
    detachAdmin(sessionId, b);
    assert.deepEqual(lastResize(launcherWs), { cols: 150, rows: 55 }, 'closing the current viewer hands the PTY to the previous one');

    const c = fakeSocket();
    assert.ok(attachAdmin(sessionId, c));
    forwardToService(a, seqResize(3, 200, 20));
    forwardToService(c, seqResize(1, 80, 60));
    assert.deepEqual(lastResize(launcherWs), { cols: 80, rows: 60 }, 'latest request, not per-axis max');
    detachAdmin(sessionId, c);
    assert.deepEqual(lastResize(launcherWs), { cols: 200, rows: 20 }, 'detach falls back to the remaining viewer');

    detachAdmin(sessionId, a);
  } finally {
    db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).run();
    unregisterLauncher(launcherId);
  }
});
