import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function targetArgument(argv) {
  const index = argv.indexOf('--target');
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new Error('--target requires a repository path');
  return argv[index + 1];
}

async function requireDirectory(path, description) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${description} does not exist: ${path}`);
}

async function readJson(path, description) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${description} is missing or invalid: ${path}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
  return result;
}

export async function validateTarget(requestedTarget) {
  if (!requestedTarget) throw new Error('Provide --target <repo-path> or set TUBE_VAULT_WINDOWS_REPO');
  if (!isAbsolute(requestedTarget)) throw new Error(`Sync target must be absolute: ${requestedTarget}`);

  const target = resolve(requestedTarget);
  await requireDirectory(target, 'Sync target');
  await requireDirectory(join(target, 'extension'), 'Target extension directory');
  await requireDirectory(join(target, 'helper'), 'Target helper directory');

  const gitRootResult = spawnSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const gitRoot = gitRootResult.status === 0 ? resolve(gitRootResult.stdout.trim()) : '';
  if (gitRoot !== target) throw new Error(`Sync target must be the root of a Git repository: ${target}`);

  const extensionPackage = await readJson(join(target, 'extension/package.json'), 'Target extension package');
  const manifest = await readJson(join(target, 'extension/manifest.json'), 'Target extension manifest');
  const helperPackage = await readJson(join(target, 'helper/package.json'), 'Target helper package');
  if (extensionPackage.name !== 'tube-vault-extension' || manifest.name !== 'TubeVault' || helperPackage.name !== 'tube-vault-helper') {
    throw new Error(`Sync target is not a TubeVault repository: ${target}`);
  }
  return target;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const target = await validateTarget(targetArgument(argv) ?? environment.TUBE_VAULT_WINDOWS_REPO);
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
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
