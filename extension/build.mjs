import esbuild from 'esbuild';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const WIN_EXT = '/mnt/c/Users/natha/Projects/Tools/tube-vault/extension';

const watchMode = process.argv.includes('--watch');

function bumpPatch() {
  const pkgPath = join(__dirname, 'package.json');
  const mfPath  = join(__dirname, 'manifest.json');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const parts = pkg.version.split('.').map(Number);
  parts[2]++;
  const version = parts.join('.');

  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  mf.version = version;
  writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');

  return version;
}

const shared = { bundle: true, target: 'chrome120', logLevel: 'info' };

if (watchMode) {
  // Watch mode: no version bump, no commit, no Windows sync
  const ctx = await esbuild.context({
    ...shared,
    entryPoints: ['src/content-script.tsx'],
    outfile: 'dist/content-script.js',
    format: 'iife',
    jsx: 'automatic',
    sourcemap: 'inline',
  });
  await ctx.watch();
  console.log('Watching for changes…');
} else {
  const version = bumpPatch();
  console.log(`\nBuilding TubeVault v${version}…`);

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
    esbuild.build({
      ...shared,
      entryPoints: ['src/popup.tsx'],
      outfile: 'dist/popup.js',
      format: 'iife',
      jsx: 'automatic',
      minify: true,
    }),
    esbuild.build({
      ...shared,
      entryPoints: ['src/options.tsx'],
      outfile: 'dist/options.js',
      format: 'iife',
      jsx: 'automatic',
      minify: true,
    }),
  ]);

  // Sync built files to Windows (Chrome loads from there)
  execSync(
    `cp manifest.json popup.html options.html ${WIN_EXT}/ && ` +
    `cp dist/content-script.js dist/service-worker.js dist/popup.js dist/options.js ${WIN_EXT}/dist/ && ` +
    `mkdir -p ${WIN_EXT}/icons && cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png ${WIN_EXT}/icons/`,
    { cwd: __dirname },
  );
  console.log('Synced to Windows.');

  // Commit everything in extensions/tube-vault/extension/
  try {
    execSync('git add extensions/tube-vault/extension/', { cwd: repoRoot });
    execSync(`git commit -m "build(tube-vault): v${version}"`, { cwd: repoRoot });
    console.log(`Committed v${version}.`);
  } catch (err) {
    console.warn(`Warning: git commit failed — ${err.message?.split('\n')[0]}`);
  }
}
