import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMatchingVersions, nextPatchVersion, setVersion, VERSION_FILES } from './release-patch.mjs';

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
