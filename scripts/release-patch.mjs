import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const VERSION_FILES = ['extension/package.json', 'extension/manifest.json', 'extension/package-lock.json'];
export const RELEASE_FILES = [...VERSION_FILES, 'CHANGELOG.md'];

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
}

function isClean(args, cwd = repoRoot) {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
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

export async function restoreVersionFiles(paths, contents, stageFiles) {
  await Promise.all(paths.map((file, index) => writeFile(file, contents[index])));
  stageFiles();
}

export async function releasePatch({
  root = repoRoot,
  runCommand = (command, args) => run(command, args, root),
  cleanCheck = (args) => isClean(args, root),
} = {}) {
  const packagePath = resolve(root, 'extension/package.json');
  const manifestPath = resolve(root, 'extension/manifest.json');
  const lockfilePath = resolve(root, 'extension/package-lock.json');
  const changelogPath = resolve(root, 'CHANGELOG.md');
  if (!cleanCheck(['diff', '--quiet']) || !cleanCheck(['diff', '--cached', '--quiet'])) {
    throw new Error('Release requires no tracked or staged changes. Untracked files are allowed.');
  }

  const releasePaths = [packagePath, manifestPath, lockfilePath, changelogPath];
  const originalContents = await Promise.all(releasePaths.map((file) => readFile(file, 'utf8')));
  const extensionPackage = JSON.parse(originalContents[0]);
  const manifest = JSON.parse(originalContents[1]);
  const lockfile = JSON.parse(originalContents[2]);
  assertMatchingVersions(extensionPackage, manifest, lockfile);
  runCommand('npm', ['run', 'check']);

  const version = nextPatchVersion(extensionPackage.version);
  setVersion(extensionPackage, manifest, lockfile, version);
  let releaseFilesChanged = false;
  try {
    releaseFilesChanged = true;
    await Promise.all([
      writeFile(packagePath, `${JSON.stringify(extensionPackage, null, 2)}\n`),
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
      writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`),
    ]);

    runCommand('npm', ['run', 'changelog', '--', '--version', version]);
    runCommand('npm', ['run', 'build']);
    runCommand('git', ['add', '--', ...RELEASE_FILES]);
    runCommand('git', ['commit', '-m', `build(tube-vault): v${version}`]);
  } catch (error) {
    if (releaseFilesChanged) {
      await restoreVersionFiles(
        releasePaths,
        originalContents,
        () => runCommand('git', ['add', '--', ...RELEASE_FILES]),
      );
    }
    throw error;
  }
}

export async function main() {
  await releasePatch();
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
