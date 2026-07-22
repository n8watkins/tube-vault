import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertMatchingVersions, nextPatchVersion, releasePatch, RELEASE_FILES, restoreVersionFiles, setVersion, VERSION_FILES } from './release-patch.mjs';

function records(version = '1.2.3') {
  return [{ version }, { version }, { version, packages: { '': { version } } }];
}

test('patch releases own all extension version records', () => {
  assert.deepEqual(VERSION_FILES, ['extension/package.json', 'extension/manifest.json', 'extension/package-lock.json']);
  assert.deepEqual(RELEASE_FILES, [...VERSION_FILES, 'CHANGELOG.md']);
  assert.equal(nextPatchVersion('1.2.3'), '1.2.4');
  assert.throws(() => nextPatchVersion('1.2'), /Expected a semantic version/);

  const [extensionPackage, manifest, lockfile] = records();
  assertMatchingVersions(extensionPackage, manifest, lockfile);
  setVersion(extensionPackage, manifest, lockfile, '1.2.4');
  assert.deepEqual(
    [extensionPackage.version, manifest.version, lockfile.version, lockfile.packages[''].version],
    ['1.2.4', '1.2.4', '1.2.4', '1.2.4'],
  );
});

test('rejects stale lockfile metadata', () => {
  const [extensionPackage, manifest, lockfile] = records();
  lockfile.packages[''].version = '1.2.2';
  assert.throws(() => assertMatchingVersions(extensionPackage, manifest, lockfile), /Version mismatch/);
});

test('restores original version files before repairing the index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tube-vault-release-'));
  const paths = ['package.json', 'manifest.json', 'package-lock.json'].map((name) => join(directory, name));
  const originals = ['package original\n', 'manifest original\n', 'lockfile original\n'];
  try {
    await Promise.all(paths.map((file) => writeFile(file, 'changed\n')));
    let stagedContents = [];
    await restoreVersionFiles(paths, originals, () => {
      stagedContents = paths.map((file) => readFile(file, 'utf8'));
    });
    assert.deepEqual(await Promise.all(stagedContents), originals);
    assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, 'utf8'))), originals);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed release build restores version files and the Git index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tube-vault-release-integration-'));
  const extension = join(root, 'extension');
  await mkdir(extension);
  const [extensionPackage, manifest, lockfile] = records('0.3.81');
  const contents = [extensionPackage, manifest, lockfile].map((value) => `${JSON.stringify(value, null, 2)}\n`);
  const paths = VERSION_FILES.map((relativePath) => join(root, relativePath));
  await Promise.all(paths.map((file, index) => writeFile(file, contents[index])));
  const changelogPath = join(root, 'CHANGELOG.md');
  const originalChangelog = '# Changelog\n';
  await writeFile(changelogPath, originalChangelog);
  await writeFile(join(root, 'unrelated.txt'), 'preserve me\n');

  const git = (args, stdio = 'ignore') => {
    const result = spawnSync('git', args, { cwd: root, stdio });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
    return result;
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'TubeVault Test']);
  git(['config', 'user.email', 'tube-vault@example.invalid']);
  git(['add', '--', ...RELEASE_FILES]);
  git(['commit', '--quiet', '-m', 'fixture']);

  await assert.rejects(releasePatch({
    root,
    runCommand: (command, args) => {
      if (command === 'npm' && args[1] === 'check') return;
      if (command === 'npm' && args[1] === 'changelog') {
        writeFileSync(changelogPath, '# Changed changelog\n');
        return;
      }
      if (command === 'npm' && args[1] === 'build') throw new Error('simulated build failure');
      if (command === 'git') git(args);
    },
  }), /simulated build failure/);

  assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, 'utf8'))), contents);
  assert.equal(await readFile(changelogPath, 'utf8'), originalChangelog);
  assert.equal(git(['diff', '--quiet']).status, 0);
  assert.equal(git(['diff', '--cached', '--quiet']).status, 0);
  assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'preserve me\n');
  await rm(root, { recursive: true, force: true });
});
