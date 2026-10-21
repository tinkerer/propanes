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
