import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { targetArgument, validateTarget } from './sync-windows.mjs';

async function makeTarget({ git = true, validIdentity = true } = {}) {
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-test-'));
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(join(target, 'helper'), { recursive: true });
  if (git) execFileSync('git', ['init', '--quiet', target]);
  await writeFile(join(target, 'extension/package.json'), JSON.stringify({ name: validIdentity ? 'tube-vault-extension' : 'other-extension' }));
  await writeFile(join(target, 'extension/manifest.json'), JSON.stringify({ name: 'TubeVault' }));
  await writeFile(join(target, 'helper/package.json'), JSON.stringify({ name: 'tube-vault-helper' }));
  return target;
}

test('CLI target takes precedence when parsed', () => {
  assert.equal(targetArgument(['--target', '/cli']), '/cli');
  assert.equal(targetArgument([]), undefined);
  assert.throws(() => targetArgument(['--target']), /requires a repository path/);
});

test('accepts only an exact TubeVault Git repository root', async () => {
  const valid = await makeTarget();
  assert.equal(await validateTarget(valid), valid);
  await assert.rejects(validateTarget(join(valid, 'extension')), /Target extension directory does not exist|root of a Git repository/);

  const noGit = await makeTarget({ git: false });
  await assert.rejects(validateTarget(noGit), /root of a Git repository/);

  const wrongProject = await makeTarget({ validIdentity: false });
  await assert.rejects(validateTarget(wrongProject), /not a TubeVault repository/);
});
