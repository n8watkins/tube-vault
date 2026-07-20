import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagePath = resolve(repoRoot, 'extension/package.json');
const manifestPath = resolve(repoRoot, 'extension/manifest.json');
const lockfilePath = resolve(repoRoot, 'extension/package-lock.json');
export const VERSION_FILES = ['extension/package.json', 'extension/manifest.json', 'extension/package-lock.json'];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
}

function isClean(args) {
  return spawnSync('git', args, { cwd: repoRoot, stdio: 'ignore' }).status === 0;
}

export function assertMatchingVersions(extensionPackage, manifest, lockfile) {
  const versions = [extensionPackage.version, manifest.version, lockfile.version, lockfile.packages?.['']?.version];
  if (versions.some((version) => version !== extensionPackage.version)) {
    throw new Error(`Version mismatch: package.json=${versions[0]}, manifest.json=${versions[1]}, package-lock.json=${versions[2]}, package-lock root=${versions[3]}`);
  }
}

export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected a semantic version, received ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function setVersion(extensionPackage, manifest, lockfile, version) {
  extensionPackage.version = version;
  manifest.version = version;
  lockfile.version = version;
  if (!lockfile.packages?.['']) throw new Error('package-lock.json is missing its root package record');
  lockfile.packages[''].version = version;
}

export async function main() {
  if (!isClean(['diff', '--quiet']) || !isClean(['diff', '--cached', '--quiet'])) {
    throw new Error('Release requires no tracked or staged changes. Untracked files are allowed.');
  }

  const extensionPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'));
  assertMatchingVersions(extensionPackage, manifest, lockfile);
  run('npm', ['run', 'check']);

  const version = nextPatchVersion(extensionPackage.version);
  setVersion(extensionPackage, manifest, lockfile, version);
  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(extensionPackage, null, 2)}\n`),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`),
  ]);

  run('npm', ['run', 'build']);
  run('git', ['add', '--', ...VERSION_FILES]);
  run('git', ['commit', '-m', `build(tube-vault): v${version}`]);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
