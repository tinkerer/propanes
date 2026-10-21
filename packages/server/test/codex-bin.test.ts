import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodexCommand } from '../src/codex-bin.ts';

const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'propanes-codex-bin-test-')));

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function touch(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  chmodSync(path, 0o755);
}

function npmInstall(root: string, layout: 'nested' | 'hoisted' | 'vendored'): { binDir: string; native: string } {
  const pkg = join(root, 'lib', 'node_modules', '@openai', 'codex');
  touch(join(pkg, 'bin', 'codex.js'));
  writeFileSync(join(pkg, 'package.json'), '{"name":"@openai/codex"}');
  const platformPkg = layout === 'nested'
    ? join(pkg, 'node_modules', '@openai', 'codex-darwin-arm64')
    : join(root, 'lib', 'node_modules', '@openai', 'codex-darwin-arm64');
  const vendor = layout === 'vendored' ? join(pkg, 'vendor') : join(platformPkg, 'vendor');
  if (layout !== 'vendored') {
    mkdirSync(platformPkg, { recursive: true });
    writeFileSync(join(platformPkg, 'package.json'), '{"name":"@openai/codex-darwin-arm64"}');
  }
  const native = join(vendor, 'aarch64-apple-darwin', 'bin', 'codex');
  touch(native);
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(pkg, 'bin', 'codex.js'), join(binDir, 'codex'));
  return { binDir, native };
}

for (const layout of ['nested', 'hoisted', 'vendored'] as const) {
  test(`resolves the native binary behind the npm shim (${layout})`, () => {
    const { binDir, native } = npmInstall(join(tempDir, layout), layout);
    assert.equal(resolveCodexCommand({ PATH: `/nonexistent:${binDir}` }, 'darwin', 'arm64'), native);
  });
}

test('CODEX_BIN overrides resolution', () => {
  const { binDir } = npmInstall(join(tempDir, 'override'), 'nested');
  assert.equal(resolveCodexCommand({ PATH: binDir, CODEX_BIN: '/opt/codex' }, 'darwin', 'arm64'), '/opt/codex');
});

test('falls back to plain codex for non-npm installs', () => {
  const binDir = join(tempDir, 'native-install', 'bin');
  touch(join(binDir, 'codex'));
  assert.equal(resolveCodexCommand({ PATH: binDir }, 'darwin', 'arm64'), 'codex');
});

test('falls back to plain codex when the native binary is missing', () => {
  const root = join(tempDir, 'broken');
  const { native, binDir } = npmInstall(root, 'nested');
  rmSync(native);
  assert.equal(resolveCodexCommand({ PATH: binDir }, 'darwin', 'arm64'), 'codex');
});

test('falls back to plain codex when codex is not on PATH', () => {
  assert.equal(resolveCodexCommand({ PATH: join(tempDir, 'empty') }, 'darwin', 'arm64'), 'codex');
});
