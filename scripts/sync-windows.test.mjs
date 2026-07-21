import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { readProcessIdentity, syncArtifacts, targetArgument, validateTarget } from './sync-windows.mjs';

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

test('rolls back every artifact when installation fails partway through', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const files = ['extension/manifest.json', 'helper/dist/index.js', 'helper/dist/protocol.js'];
  for (const relativePath of files) {
    await mkdir(join(source, relativePath, '..'), { recursive: true });
    await writeFile(join(source, relativePath), `new ${relativePath}\n`);
  }
  for (const relativePath of files.slice(0, 2)) {
    await mkdir(join(target, relativePath, '..'), { recursive: true });
    await writeFile(join(target, relativePath), `old ${relativePath}\n`);
  }

  await assert.rejects(syncArtifacts(source, target, files, {
    beforeInstall: async (_relativePath, index) => {
      if (index === 0) {
        const transactions = (await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-'));
        assert.equal(transactions.length, 1);
        const transactionEntries = await readdir(join(target, transactions[0]));
        assert.equal(transactionEntries.includes('journal.json'), true);
        assert.equal(transactionEntries.some((name) => name.startsWith('journal.json.')), false);
        const journal = JSON.parse(await readFile(join(target, transactions[0], 'journal.json'), 'utf8'));
        assert.deepEqual(journal.entries, files.map((relativePath, entryIndex) => ({ relativePath, existed: entryIndex < 2 })));
      }
      if (index === 2) throw new Error('simulated installation failure');
    },
  }), /simulated installation failure/);

  assert.equal(await readFile(join(target, files[0]), 'utf8'), `old ${files[0]}\n`);
  assert.equal(await readFile(join(target, files[1]), 'utf8'), `old ${files[1]}\n`);
  await assert.rejects(readFile(join(target, files[2]), 'utf8'), /ENOENT/);
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('recovers an interrupted transaction before starting the next sync', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const transaction = join(target, '.tube-vault-sync-interrupted');
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(join(transaction, 'backups', 'extension'), { recursive: true });
  await mkdir(join(transaction, 'files', 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'next\n');
  await writeFile(join(target, relativePath), 'partially installed\n');
  await writeFile(join(transaction, 'backups', relativePath), 'original\n');
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({ entries: [{ relativePath, existed: true }] }));

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeInstall: () => { throw new Error('stop after recovery'); },
  }), /stop after recovery/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'original\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('rejects transaction journal paths outside the artifact allowlist', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-test-'));
  const target = join(testRoot, 'target');
  const transaction = join(target, '.tube-vault-sync-crafted');
  const outside = join(testRoot, 'outside.txt');
  await mkdir(transaction, { recursive: true });
  await writeFile(outside, 'preserved\n');
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({ entries: [{ relativePath: '../outside.txt', existed: false }] }));

  await assert.rejects(syncArtifacts(target, target, []), /Invalid sync artifact path/);
  assert.equal(await readFile(outside, 'utf8'), 'preserved\n');
  assert.equal((await readdir(target)).includes('.tube-vault-sync-crafted'), true);
  await rm(outside);
});

test('preserves transaction backups when rollback fails', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const files = ['extension/manifest.json', 'helper/dist/index.js'];
  for (const relativePath of files) {
    await mkdir(join(source, relativePath, '..'), { recursive: true });
    await mkdir(join(target, relativePath, '..'), { recursive: true });
    await writeFile(join(source, relativePath), 'new\n');
    await writeFile(join(target, relativePath), 'old\n');
  }

  await assert.rejects(syncArtifacts(source, target, files, {
    beforeInstall: async (_relativePath, index) => {
      if (index !== 1) return;
      await rm(join(target, files[0]));
      await mkdir(join(target, files[0], 'child'), { recursive: true });
      throw new Error('simulated installation failure');
    },
  }), /Artifact sync and rollback both failed/);

  const transactions = (await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-'));
  assert.equal(transactions.length, 1);
  assert.equal(await readFile(join(target, transactions[0], 'backups', files[0]), 'utf8'), 'old\n');
});

test('prevents concurrent sync and recovers a dead owner lock', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');

  let continueFirstSync;
  const firstSyncPaused = new Promise((resolvePaused) => {
    continueFirstSync = resolvePaused;
  });
  let markFirstSyncStarted;
  const firstSyncStarted = new Promise((resolveStarted) => {
    markFirstSyncStarted = resolveStarted;
  });
  const firstSync = syncArtifacts(source, target, [relativePath], {
    beforeInstall: async () => {
      markFirstSyncStarted();
      await firstSyncPaused;
    },
  });
  await firstSyncStarted;
  const currentIdentity = await readProcessIdentity(process.pid);
  if (currentIdentity) {
    const liveOwner = JSON.parse(await readFile(join(target, '.tube-vault-sync.lock'), 'utf8'));
    assert.equal(liveOwner.processIdentity, currentIdentity);
  }
  await assert.rejects(syncArtifacts(source, target, [relativePath]), /Another sync is already running/);
  continueFirstSync();
  await firstSync;

  await writeFile(join(target, '.tube-vault-sync.lock'), JSON.stringify({
    pid: 2_147_483_647,
    hostname: hostname(),
    token: 'dead-owner',
  }));
  await syncArtifacts(source, target, [relativePath]);
  assert.equal((await readdir(target)).includes('.tube-vault-sync.lock'), false);

  if (currentIdentity) {
    await writeFile(join(target, '.tube-vault-sync.lock'), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token: 'reused-owner',
      processIdentity: 'different-incarnation',
    }));
    await syncArtifacts(source, target, [relativePath]);
    assert.equal((await readdir(target)).includes('.tube-vault-sync.lock'), false);
  }
});
