import esbuild from 'esbuild';

const watchMode = process.argv.includes('--watch');
const shared = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
};

const builds = [
  { entryPoints: ['src/content-script.tsx'], outfile: 'dist/content-script.js', format: 'iife', jsx: 'automatic', minify: !watchMode },
  { entryPoints: ['src/service-worker.ts'], outfile: 'dist/service-worker.js', format: 'iife' },
  { entryPoints: ['src/popup.tsx'], outfile: 'dist/popup.js', format: 'iife', jsx: 'automatic', minify: !watchMode },
  { entryPoints: ['src/options.tsx'], outfile: 'dist/options.js', format: 'iife', jsx: 'automatic', minify: !watchMode },
];

if (watchMode) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context({
    ...shared,
    ...options,
    sourcemap: 'inline',
  })));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching all extension entry points for changes.');
} else {
  await Promise.all(builds.map((options) => esbuild.build({ ...shared, ...options })));
}
