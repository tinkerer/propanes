import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRecentProjectJsonl } from '../src/jsonl-scan.ts';

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jsonl-scan-'));
}

async function seedJsonl(dir: string, name: string, mtime: Date): Promise<string> {
  const full = join(dir, name);
  await writeFile(full, '{"type":"system","subtype":"init"}\n');
  await utimes(full, mtime, mtime);
  return full;
}

test('excludes caller\'s own jsonl from the recent scan', async () => {
  const dir = await makeDir();
  try {
    const now = new Date();
    const selfId = 'f6715424-990f-4f67-9772-bc7b9727d06b';
    const otherId = 'a1b2c3d4-5555-4444-3333-222211110000';

    await seedJsonl(dir, `${selfId}.jsonl`, now);
    const otherPath = await seedJsonl(dir, `${otherId}.jsonl`, now);

    const paths = await findRecentProjectJsonl(dir, 0, selfId);

    assert.equal(paths.length, 1, 'self jsonl should be filtered out');
    assert.equal(paths[0], otherPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('honors CLAUDE_SESSION_ID env var when selfClaudeSessionId is omitted', async () => {
  const dir = await makeDir();
  const originalEnv = process.env.CLAUDE_SESSION_ID;
  try {
    const now = new Date();
    const selfId = 'env-self-session-id';
    const otherId = 'env-other-session-id';

    await seedJsonl(dir, `${selfId}.jsonl`, now);
    const otherPath = await seedJsonl(dir, `${otherId}.jsonl`, now);

    process.env.CLAUDE_SESSION_ID = selfId;
    const paths = await findRecentProjectJsonl(dir, 0);

    assert.deepEqual(paths, [otherPath]);
  } finally {
    if (originalEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit selfClaudeSessionId wins over CLAUDE_SESSION_ID env', async () => {
  const dir = await makeDir();
  const originalEnv = process.env.CLAUDE_SESSION_ID;
  try {
    const now = new Date();
    const envId = 'env-id-should-be-ignored';
    const argId = 'arg-id-wins';

    const envPath = await seedJsonl(dir, `${envId}.jsonl`, now);
    await seedJsonl(dir, `${argId}.jsonl`, now);

    process.env.CLAUDE_SESSION_ID = envId;
    const paths = await findRecentProjectJsonl(dir, 0, argId);

    assert.deepEqual(paths, [envPath], 'arg id is excluded, env id is kept');
  } finally {
    if (originalEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = originalEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test('respects sinceMs threshold', async () => {
  const dir = await makeDir();
  try {
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();

    await seedJsonl(dir, 'old.jsonl', old);
    const freshPath = await seedJsonl(dir, 'fresh.jsonl', fresh);

    const paths = await findRecentProjectJsonl(dir, Date.now() - 30_000, null);
    assert.deepEqual(paths, [freshPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extraExcludeIds filter additional sibling scans', async () => {
  const dir = await makeDir();
  try {
    const now = new Date();
    const siblingId = 'sibling-in-flight';
    const keepId = 'keep-me';

    await seedJsonl(dir, `${siblingId}.jsonl`, now);
    const keepPath = await seedJsonl(dir, `${keepId}.jsonl`, now);

    const paths = await findRecentProjectJsonl(dir, 0, null, [siblingId]);
    assert.deepEqual(paths, [keepPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns empty list when directory does not exist', async () => {
  const paths = await findRecentProjectJsonl('/nonexistent/path/should/not/exist', 0, 'x');
  assert.deepEqual(paths, []);
});
