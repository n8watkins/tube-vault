import { cp, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function targetArgument(argv) {
  const index = argv.indexOf('--target');
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new Error('--target requires a repository path');
  return argv[index + 1];
}

async function requireDirectory(path, description) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${description} does not exist: ${path}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const requestedTarget = targetArgument(process.argv.slice(2)) ?? process.env.TUBE_VAULT_WINDOWS_REPO;
if (!requestedTarget) throw new Error('Provide --target <repo-path> or set TUBE_VAULT_WINDOWS_REPO');
if (!isAbsolute(requestedTarget)) throw new Error(`Sync target must be absolute: ${requestedTarget}`);

const target = resolve(requestedTarget);
await requireDirectory(target, 'Sync target');
await requireDirectory(join(target, 'extension'), 'Target extension directory');
await requireDirectory(join(target, 'helper'), 'Target helper directory');

run('npm', ['run', 'build']);

const files = [
  'extension/manifest.json',
  'extension/popup.html',
  'extension/options.html',
  'extension/icons/icon16.png',
  'extension/icons/icon32.png',
  'extension/icons/icon48.png',
  'extension/icons/icon128.png',
  'extension/dist/content-script.js',
  'extension/dist/service-worker.js',
  'extension/dist/popup.js',
  'extension/dist/options.js',
  'helper/dist/downloader.js',
  'helper/dist/index.js',
  'helper/dist/protocol.js',
  'helper/dist/sanitize.js',
  'helper/package.json',
  'helper/package-lock.json',
];

for (const relativePath of files) {
  const destination = join(target, relativePath);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await cp(join(repoRoot, relativePath), destination);
  console.log(`Copied ${relativePath}`);
}
