import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktreeIsolate, destroyWorktreeIsolate, branchForIsolatePath } from '../src/isolates.ts';

const repoDir = mkdtempSync(join(tmpdir(), 'propanes-isolate-repo-'));

function git(...args: string[]) {
  execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
}

// A real git repo with one commit so HEAD exists.
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
writeFileSync(join(repoDir, 'file.txt'), 'hello\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

test.after(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

test('non-git dir yields no isolate', () => {
  const plain = mkdtempSync(join(tmpdir(), 'propanes-plain-'));
  try {
    assert.equal(createWorktreeIsolate(plain, 'ABCDEF12'), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('createWorktreeIsolate makes a fresh worktree + branch off HEAD', () => {
  const iso = createWorktreeIsolate(repoDir, 'SESSION-XY1234ZZ');
  assert.ok(iso, 'expected an isolate');
  assert.ok(existsSync(iso!.path), 'worktree dir should exist');
  assert.ok(existsSync(join(iso!.path, 'file.txt')), 'worktree should contain the committed file');
  // Listed as a linked worktree of the repo.
  const list = execFileSync('git', ['worktree', 'list'], { cwd: repoDir }).toString();
  assert.ok(list.includes(iso!.path), 'worktree should be registered');

  // Teardown removes it (deriving the main repo from the worktree itself).
  const removed = destroyWorktreeIsolate({ path: iso!.path, branch: iso!.branch });
  assert.equal(removed, true);
  assert.equal(existsSync(iso!.path), false, 'worktree dir should be gone');
  const listAfter = execFileSync('git', ['worktree', 'list'], { cwd: repoDir }).toString();
  assert.equal(listAfter.includes(iso!.path), false);
});

test('branchForIsolatePath reconstructs the branch from a path token', () => {
  assert.equal(branchForIsolatePath('/tmp/propanes-isolate-xy1234zz'), 'pw-isolate/xy1234zz');
});

test('destroy is idempotent on a missing worktree', () => {
  assert.doesNotThrow(() => destroyWorktreeIsolate({ repoDir, path: '/tmp/does-not-exist-propanes', branch: 'pw-isolate/none' }));
});
