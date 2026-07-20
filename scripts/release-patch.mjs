import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagePath = resolve(repoRoot, 'extension/package.json');
const manifestPath = resolve(repoRoot, 'extension/manifest.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function isClean(args) {
  return spawnSync('git', args, { cwd: repoRoot, stdio: 'ignore' }).status === 0;
}

if (!isClean(['diff', '--quiet']) || !isClean(['diff', '--cached', '--quiet'])) {
  throw new Error('Release requires no tracked or staged changes. Untracked files are allowed.');
}

const extensionPackage = JSON.parse(await readFile(packagePath, 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (extensionPackage.version !== manifest.version) {
  throw new Error(`Version mismatch: package.json is ${extensionPackage.version}, manifest.json is ${manifest.version}`);
}

run('npm', ['run', 'check']);

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(extensionPackage.version);
if (!match) throw new Error(`Expected a semantic version, received ${extensionPackage.version}`);
const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
extensionPackage.version = version;
manifest.version = version;
await writeFile(packagePath, `${JSON.stringify(extensionPackage, null, 2)}\n`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

run('npm', ['run', 'build']);
run('git', ['add', '--', 'extension/package.json', 'extension/manifest.json']);
run('git', ['commit', '-m', `build(tube-vault): v${version}`]);
