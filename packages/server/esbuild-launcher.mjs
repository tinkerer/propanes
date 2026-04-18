import { build } from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

await build({
  entryPoints: ['src/launcher-daemon.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/launcher-bundle.mjs',
  external: ['node-pty', 'ws'],
  banner: {
    js: '// propanes launcher daemon bundle\n// Deploy: scp dist/launcher-bundle.mjs remote:~/ && node launcher-bundle.mjs',
  },
  define: {
    '__LAUNCHER_VERSION__': JSON.stringify(pkg.version),
  },
});

console.log('Built dist/launcher-bundle.mjs');
