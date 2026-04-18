import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PromptWidget',
  outfile: 'dist/prompt-widget.js',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'es2022',
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
  },
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Built prompt-widget.js');
}
