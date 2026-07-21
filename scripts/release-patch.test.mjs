import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertMatchingVersions, nextPatchVersion, restoreVersionFiles, setVersion, VERSION_FILES } from './release-patch.mjs';

function records(version = '1.2.3') {
  return [{ version }, { version }, { version, packages: { '': { version } } }];
}

test('patch releases own all extension version records', () => {
  assert.deepEqual(VERSION_FILES, ['extension/package.json', 'extension/manifest.json', 'extension/package-lock.json']);
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
