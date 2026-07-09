// Phase 5 — per-session ephemeral isolates (git-worktree substrate).
//
// When an agent type declares isolation='per_session', the control plane gives
// the session its own throwaway working tree instead of running it in the
// shared checkout. The first (cheapest) substrate is a git worktree under the
// repo the session would have run in: a fresh branch + working directory that
// is discarded when the session ends, so nothing the session writes leaks back
// into the shared tree or into another isolate. Stronger substrates
// (ephemeral container, sprite/pod) can plug in behind the same interface.
//
// Credentials: the worktree runs as the same OS user, so the launcher's
// Claude/Codex login is already present — the isolation here is of the *source
// tree*. (A container/pod substrate is where a writable credential *copy* gets
// injected; see the design doc §05.)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface Isolate {
  id: string;
  path: string;
  branch: string;
  repoDir: string;
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Create a worktree isolate rooted at `repoDir`. Returns null when the target
// isn't a git repo (isolation not applicable — the session runs in place).
export function createWorktreeIsolate(repoDir: string, sessionId: string): Isolate | null {
  if (!repoDir || !isGitRepo(repoDir)) return null;
  const short = sessionId.slice(-8).toLowerCase();
  const branch = `pw-isolate/${short}`;
  const path = join(tmpdir(), `propanes-isolate-${short}`);
  try {
    // -b <branch> HEAD: a fresh branch off the current HEAD in a new dir.
    execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { id: path, path, branch, repoDir };
  } catch (err) {
    console.warn(`[isolate] Failed to create worktree for ${sessionId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Resolve the main working tree that owns a linked worktree, so teardown can
// run `git worktree remove` from the parent repo (git refuses to remove the
// "current" worktree, so we can't run it from inside the isolate itself).
function mainRepoForWorktree(worktreePath: string, fallbackRepoDir?: string): string | null {
  if (fallbackRepoDir) return fallbackRepoDir;
  try {
    const commonDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      stdio: 'pipe',
    })
      .toString()
      .trim();
    // commonDir is <mainRepo>/.git — the owning working tree is its parent.
    return commonDir.replace(/\/\.git\/?$/, '') || null;
  } catch {
    return null;
  }
}

// Remove a worktree isolate. Idempotent — a missing worktree is a no-op, so
// this is safe to call from a reconcile sweep that may retry. `repoDir` is
// optional: when absent it's derived from the worktree itself.
export function destroyWorktreeIsolate(isolate: { repoDir?: string; path: string; branch?: string }): boolean {
  const repoDir = mainRepoForWorktree(isolate.path, isolate.repoDir);
  if (!repoDir) return false;
  let removed = false;
  try {
    if (existsSync(isolate.path)) {
      execFileSync('git', ['worktree', 'remove', '--force', isolate.path], {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      removed = true;
    }
    // Prune stale administrative entries even when the dir is already gone.
    execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, stdio: 'pipe' });
    const branch = isolate.branch || branchForIsolatePath(isolate.path);
    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: repoDir, stdio: 'pipe' });
    } catch {
      /* branch may not exist */
    }
  } catch (err) {
    console.warn(`[isolate] Failed to remove worktree ${isolate.path}:`, err instanceof Error ? err.message : err);
  }
  return removed;
}

// Reconstruct the branch name from an isolate path token so a sweep can tear
// down worktrees recorded only by their path (agent_sessions.isolate_id).
export function branchForIsolatePath(path: string): string {
  const short = path.split('propanes-isolate-')[1] || '';
  return `pw-isolate/${short}`;
}
