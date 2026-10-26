import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

const TARGET_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

function findOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The npm `codex` command is a node shim (bin/codex.js) that re-spawns the
 * native binary with the same argv. Dispatch passes the whole prompt as an
 * argument, and endpoint-security agents (SentinelOne, observed on macOS)
 * SIGKILL a node process that carries a ~1KB+ argument and then spawns a
 * child — so every dispatched codex session with a real prompt died within
 * milliseconds. Launch the native binary directly to skip the node hop.
 * Falls back to plain `codex` when the install doesn't look like the npm
 * layout. CODEX_BIN always wins.
 */
export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  if (env.CODEX_BIN) return env.CODEX_BIN;

  const triple = TARGET_TRIPLES[`${platform}-${arch}`];
  const shim = findOnPath('codex', env.PATH || '');
  if (!triple || !shim) return 'codex';

  let shimPath: string;
  try {
    shimPath = realpathSync(shim);
  } catch {
    return 'codex';
  }
  if (!shimPath.endsWith(join('bin', 'codex.js'))) return 'codex';

  const packageRoot = dirname(dirname(shimPath));
  const vendorDirs: string[] = [];
  try {
    const req = createRequire(join(packageRoot, 'package.json'));
    vendorDirs.push(join(dirname(req.resolve(`@openai/codex-${platform}-${arch}/package.json`)), 'vendor'));
  } catch {}
  vendorDirs.push(join(packageRoot, 'vendor'));

  for (const vendor of vendorDirs) {
    const native = join(vendor, triple, 'bin', 'codex');
    if (existsSync(native)) return native;
  }
  return 'codex';
}

export interface CodexArgsInput {
  /** `exec` (one-shot, pipe profiles) instead of the interactive TUI. */
  pipe: boolean;
  model?: string;
  /** Pass --dangerously-bypass-approvals-and-sandbox (the *-yolo profiles). */
  skip: boolean;
  prompt?: string | null;
  /** Codex thread (rollout) UUID to continue natively with `codex resume`. */
  resumeSessionId?: string | null;
}

/**
 * Argument list for a codex session. A resume continues the recorded thread
 * with codex's own `resume` subcommand (`codex resume <id> [prompt]` for the
 * TUI, `codex exec resume <id> [prompt]` for pipe profiles) so the agent gets
 * its full prior context back instead of a re-typed task summary.
 */
export function buildCodexArgs({ pipe, skip, prompt, resumeSessionId, model }: CodexArgsInput): string[] {
  const args: string[] = [];
  if (pipe) args.push('exec');
  if (resumeSessionId) args.push('resume');
  if (model) args.push('--model', model);
  if (!pipe) {
    // The codex TUI runs tool calls in a shared, long-lived app-server
    // daemon, so shell commands inherit the daemon's environment instead of
    // this session's — PROPANES_TOKEN / PROPANES_API_URL (per-session) never
    // reach them and the agent gets 401s. Keep the TUI in-process.
    // `exec` already runs in-process and doesn't accept the flag.
    args.push('--no-daemon');
  }
  if (skip) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (resumeSessionId) args.push(resumeSessionId);
  if (prompt) args.push(prompt);
  return args;
}
