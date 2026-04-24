import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-resume-test-'));
const dbPath = join(tempDir, 'test.db');
process.env.DB_PATH = dbPath;

const { db, schema, runMigrations, sqlite } = await import('../src/db/index.ts');
const { resumeAgentSession } = await import('../src/dispatch.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedParentSession(permissionProfile: 'headless' | 'yolo') {
  const now = new Date().toISOString();
  db.insert(schema.feedbackItems).values({
    id: 'fb-1',
    type: 'manual',
    status: 'dispatched',
    title: 'Feedback',
    description: 'desc',
    appId: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  db.insert(schema.agentEndpoints).values({
    id: 'agent-1',
    name: 'Agent',
    url: '',
    mode: 'interactive',
    runtime: 'claude',
    permissionProfile: permissionProfile,
    isDefault: 0,
    createdAt: now,
    updatedAt: now,
  }).run();

  db.insert(schema.agentSessions).values({
    id: 'parent-1',
    feedbackId: 'fb-1',
    agentEndpointId: 'agent-1',
    runtime: 'claude',
    permissionProfile,
    status: 'killed',
    outputBytes: 0,
    claudeSessionId: 'claude-session-1',
    cwd: process.cwd(),
    createdAt: now,
  }).run();
}

test('resume inherits headless permission profile when no override is provided', async () => {
  seedParentSession('headless');

  const { sessionId } = await resumeAgentSession('parent-1');
  const resumed = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get();

  assert.ok(resumed);
  assert.equal(resumed.parentSessionId, 'parent-1');
  assert.equal(resumed.permissionProfile, 'headless');
});

test('explicit interactive override still downgrades permissions when requested', async () => {
  sqlite.exec(`
    DELETE FROM agent_sessions;
    DELETE FROM agent_endpoints;
    DELETE FROM feedback_items;
  `);
  seedParentSession('yolo');

  const { sessionId } = await resumeAgentSession('parent-1', null, 'interactive');
  const resumed = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get();

  assert.ok(resumed);
  assert.equal(resumed.parentSessionId, 'parent-1');
  assert.equal(resumed.permissionProfile, 'interactive');
});
