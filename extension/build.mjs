import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context({
    ...shared,
    entryPoints: ['src/content-script.tsx'],
    outfile: 'dist/content-script.js',
    format: 'iife',
    jsx: 'automatic',
    sourcemap: 'inline',
  });
  await ctx.watch();
  console.log('Watching…');
} else {
  await Promise.all([
    esbuild.build({
      ...shared,
      entryPoints: ['src/content-script.tsx'],
      outfile: 'dist/content-script.js',
      format: 'iife',
      jsx: 'automatic',
      minify: true,
    }),
    esbuild.build({
      ...shared,
      entryPoints: ['src/service-worker.ts'],
      outfile: 'dist/service-worker.js',
      format: 'iife',
    }),
  ]);
}
