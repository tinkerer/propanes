import { execFileSync } from 'node:child_process';
import { resolveCodexResumeId } from './jsonl-utils.js';
import { resolveCodexCommand } from './codex-bin.js';

/** Copy a saved Codex conversation without starting a model turn. Run on the
 * machine holding the transcript, then resume the returned independent UUID. */
export function forkCodexSession(parentId: string, cwd: string, startedAt?: string): string {
  if (startedAt) {
    const resolved = resolveCodexResumeId(cwd, parentId || null, startedAt);
    if (!resolved) throw new Error('The parent Codex transcript is unavailable on this machine');
    parentId = resolved;
  }
  if (!parentId) throw new Error('The parent Codex conversation ID is unavailable');
  let output: string;
  try {
    output = execFileSync(resolveCodexCommand(), ['exec', 'fork', '--json', '--skip-git-repo-check', parentId], {
      cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Native Codex fork failed; check CLI support and access to the parent transcript');
  }
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string'
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event.thread_id)
      && event.thread_id !== parentId) return event.thread_id;
  }
  throw new Error('Codex fork did not return an independent conversation ID');
}

export function claudeForkArgs(parentId: string, newId: string | undefined): string[] {
  if (!newId || newId === parentId) throw new Error('Claude fork requires an independent conversation ID');
  return ['--resume', parentId, '--fork-session', '--session-id', newId];
}
