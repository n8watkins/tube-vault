import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { main, readProcessIdentity, recoverSyncTransactions, syncArtifacts, targetArgument, validateTarget } from './sync-windows.mjs';

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

  const linkedRoot = `${valid}-link`;
  await symlink(valid, linkedRoot, 'dir');
  await assert.rejects(validateTarget(linkedRoot), /cannot be a symbolic link/);
});

test('rejects symlinked artifact paths before publishing', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-symlink-test-'));
  const source = join(testRoot, 'source');
  const target = join(testRoot, 'target');
  const outside = join(testRoot, 'outside');
  const relativePath = 'extension/dist/content-script.js';
  await mkdir(join(source, 'extension/dist'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(outside, 'content-script.js'), 'preserved\n');
  await symlink(outside, join(target, 'extension/dist'), 'dir');

  await assert.rejects(syncArtifacts(source, target, [relativePath]), /cannot contain a symbolic link/);
  assert.equal(await readFile(join(outside, 'content-script.js'), 'utf8'), 'preserved\n');
});

test('rejects an existing artifact directory without moving or deleting it', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-directory-test-'));
  const source = join(testRoot, 'source');
  const target = join(testRoot, 'target');
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, relativePath), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath, 'preserved.txt'), 'preserved\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath]), /not a regular file/);

  assert.equal(await readFile(join(target, relativePath, 'preserved.txt'), 'utf8'), 'preserved\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('preserves an artifact directory that appears before backup', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-concurrent-directory-test-'));
  const source = join(testRoot, 'source');
  const target = join(testRoot, 'target');
  const relativePath = 'extension/manifest.json';
  const destination = join(target, relativePath);
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(destination, 'old\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeInstall: async () => {
      await rm(destination);
      await mkdir(destination);
      await writeFile(join(destination, 'preserved.txt'), 'preserved\n');
    },
  }));

  assert.equal(await readFile(join(destination, 'preserved.txt'), 'utf8'), 'preserved\n');
});

test('does not follow a staged destination symlink created concurrently', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-staging-symlink-test-'));
  const source = join(testRoot, 'source');
  const target = join(testRoot, 'target');
  const outside = join(testRoot, 'outside.txt');
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(outside, 'preserved\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeStageCopy: async (_relativePath, _index, staged) => {
      await symlink(outside, staged, 'file');
    },
  }), /EEXIST/);

  assert.equal(await readFile(outside, 'utf8'), 'preserved\n');
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
        assert.equal(journal.state, 'pending');
        assert.deepEqual(
          journal.entries.map(({ relativePath, existed }) => ({ relativePath, existed })),
          files.map((relativePath, entryIndex) => ({ relativePath, existed: entryIndex < 2 })),
        );
        for (const entry of journal.entries.slice(0, 2)) {
          assert.equal(typeof entry.identity.dev, 'string');
          assert.equal(typeof entry.identity.ino, 'string');
        }
        assert.equal(journal.entries[2].identity, undefined);
      }
      if (index === 2) throw new Error('simulated installation failure');
    },
  }), /simulated installation failure/);

  assert.equal(await readFile(join(target, files[0]), 'utf8'), `old ${files[0]}\n`);
  assert.equal(await readFile(join(target, files[1]), 'utf8'), `old ${files[1]}\n`);
  await assert.rejects(readFile(join(target, files[2]), 'utf8'), /ENOENT/);
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('preserves an artifact created concurrently after staging', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeInstall: async () => {
      await writeFile(join(target, relativePath), 'concurrent\n');
    },
  }), /appeared concurrently/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'concurrent\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('does not overwrite an artifact created after backing up the original', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'original\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    afterBackup: async () => {
      await writeFile(join(target, relativePath), 'concurrent\n');
    },
  }), /Artifact sync and rollback both failed/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'concurrent\n');
  const transactions = (await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-'));
  assert.equal(transactions.length, 1);
  assert.equal(await readFile(join(target, transactions[0], 'backups', relativePath), 'utf8'), 'original\n');
});

test('does not back up an existing artifact replaced after staging', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const displaced = join(target, 'original-manifest.json');
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'original\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeInstall: async () => {
      await rename(join(target, relativePath), displaced);
      await writeFile(join(target, relativePath), 'concurrent\n');
    },
  }), /changed concurrently before backup/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'concurrent\n');
  assert.equal(await readFile(displaced, 'utf8'), 'original\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('recovers an install interrupted before staged-link cleanup', async () => {
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const transaction = join(target, '.tube-vault-sync-interrupted-link');
  const staged = join(transaction, 'files', relativePath);
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(join(transaction, 'files', 'extension'), { recursive: true });
  await writeFile(staged, 'partially installed\n');
  await link(staged, join(target, relativePath));
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({
    state: 'pending',
    entries: [{ relativePath, existed: false }],
  }));

  await recoverSyncTransactions(target);

  await assert.rejects(readFile(join(target, relativePath), 'utf8'), /ENOENT/);
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('preserves a recovery destination when staged ownership evidence is missing', async () => {
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const transaction = join(target, '.tube-vault-sync-missing-staged');
  const backup = join(transaction, 'backups', relativePath);
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(join(transaction, 'backups', 'extension'), { recursive: true });
  await writeFile(join(target, relativePath), 'concurrent\n');
  await writeFile(backup, 'original\n');
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({
    state: 'pending',
    entries: [{ relativePath, existed: true }],
  }));

  await assert.rejects(recoverSyncTransactions(target), /changed concurrently during rollback/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'concurrent\n');
  assert.equal(await readFile(backup, 'utf8'), 'original\n');
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
  await writeFile(join(transaction, 'files', relativePath), 'partially installed\n');
  await link(join(transaction, 'files', relativePath), join(target, relativePath));
  await writeFile(join(transaction, 'backups', relativePath), 'original\n');
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({ entries: [{ relativePath, existed: true }] }));

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeInstall: () => { throw new Error('stop after recovery'); },
  }), /stop after recovery/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'original\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.tube-vault-sync-')), []);
});

test('preserves installed artifacts when committed transaction cleanup was interrupted', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const transaction = join(target, '.tube-vault-sync-committed');
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(join(transaction, 'backups', 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'next\n');
  await writeFile(join(target, relativePath), 'committed\n');
  await writeFile(join(transaction, 'backups', relativePath), 'original\n');
  await writeFile(join(transaction, 'journal.json'), JSON.stringify({
    state: 'committed',
    entries: [{ relativePath, existed: true }],
  }));

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeInstall: () => { throw new Error('stop after recovery'); },
  }), /stop after recovery/);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'committed\n');
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

test('rejects symlinks in recovered transaction artifact trees', async (context) => {
  for (const tree of ['files', 'backups']) {
    await context.test(tree, async () => {
      const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-transaction-symlink-test-'));
      const target = join(testRoot, 'target');
      const transaction = join(target, '.tube-vault-sync-crafted');
      const outside = join(testRoot, 'outside');
      const relativePath = 'extension/manifest.json';
      await mkdir(join(target, 'extension'), { recursive: true });
      await mkdir(join(transaction, tree), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(target, relativePath), 'partially installed\n');
      await writeFile(join(outside, 'manifest.json'), 'preserved\n');
      await symlink(outside, join(transaction, tree, 'extension'), 'dir');
      await writeFile(join(transaction, 'journal.json'), JSON.stringify({
        entries: [{ relativePath, existed: tree === 'backups' }],
      }));

      await assert.rejects(syncArtifacts(target, target, []), /Sync transaction path cannot contain a symbolic link/);
      assert.equal(await readFile(join(outside, 'manifest.json'), 'utf8'), 'preserved\n');
      assert.equal((await readdir(target)).includes('.tube-vault-sync-crafted'), true);
    });
  }
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

test('elects one winner when lock intents are published concurrently', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');

  let publishedIntents = 0;
  let releaseIntentBarrier;
  const intentBarrier = new Promise((resolve) => {
    releaseIntentBarrier = resolve;
  });
  let releaseWinner;
  const winnerPaused = new Promise((resolve) => {
    releaseWinner = resolve;
  });
  let markRejected;
  const contenderRejected = new Promise((resolve) => {
    markRejected = resolve;
  });
  const hooks = {
    afterLockIntent: async () => {
      publishedIntents += 1;
      if (publishedIntents === 2) releaseIntentBarrier();
      await intentBarrier;
    },
    beforeInstall: () => winnerPaused,
  };
  const attempts = [0, 1].map(async () => {
    try {
      await syncArtifacts(source, target, [relativePath], hooks);
      return 'acquired';
    } catch (error) {
      markRejected();
      return error;
    }
  });

  await contenderRejected;
  releaseWinner();
  const results = await Promise.all(attempts);
  assert.equal(results.filter((result) => result === 'acquired').length, 1);
  assert.equal(results.filter((result) => result instanceof Error && /Another sync is already running/.test(result.message)).length, 1);
  assert.deepEqual((await readdir(target)).filter((name) => name.includes('.intent-')), []);
});

test('revalidates lower lock intents published after election', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const lowerIntent = join(target, '.tube-vault-sync.lock.intent-lower');
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    afterLockElection: async () => {
      await writeFile(lowerIntent, JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        token: '00000000-0000-0000-0000-000000000000',
        processIdentity: await readProcessIdentity(process.pid),
      }));
    },
  }), /Another sync is already running/);

  assert.equal((await readdir(target)).includes('.tube-vault-sync.lock'), false);
  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'old\n');
  await rm(lowerIntent);
});

test('anchors mutations when the target path is replaced concurrently', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-anchor-test-'));
  const source = join(testRoot, 'source');
  const target = join(testRoot, 'target');
  const displacedTarget = join(testRoot, 'displaced-target');
  const outside = join(testRoot, 'outside');
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');
  await writeFile(join(outside, 'marker.txt'), 'preserved\n');

  try {
    await assert.rejects(syncArtifacts(source, target, [relativePath], {
      afterLockIntent: async () => {
        await rename(target, displacedTarget);
        await symlink(outside, target, 'dir');
      },
    }), /changed concurrently|symbolic link/);
    assert.deepEqual(await readdir(outside), ['marker.txt']);
    assert.equal(await readFile(join(outside, 'marker.txt'), 'utf8'), 'preserved\n');
  } finally {
    await unlink(target).catch(() => undefined);
    await rename(displacedTarget, target).catch(() => undefined);
  }
});

test('keeps the validated target identity anchored across the build', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'tube-vault-sync-build-anchor-test-'));
  const target = await makeTarget();
  const displacedTarget = join(testRoot, 'displaced-target');
  const replacementTarget = await makeTarget();

  try {
    await assert.rejects(main(['--target', target], {}, {
      build: async () => {
        await rename(target, displacedTarget);
        await rename(replacementTarget, target);
      },
    }), /changed concurrently/);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rename(displacedTarget, target).catch(() => undefined);
  }
});

test('recovers an incomplete abandoned lock intent', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');
  await writeFile(join(target, '.tube-vault-sync.lock.intent-incomplete'), '');

  await syncArtifacts(source, target, [relativePath]);

  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'new\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.includes('.intent-')), []);
});

test('does not reclaim a replacement lock from a new owner', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const lockPath = join(target, '.tube-vault-sync.lock');
  const replacementOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: 'replacement-owner',
    processIdentity: await readProcessIdentity(process.pid),
  };
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');
  await writeFile(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    hostname: hostname(),
    token: 'dead-owner',
  }));

  await assert.rejects(syncArtifacts(source, target, [relativePath], {
    beforeReclaim: async () => {
      await rm(lockPath);
      await writeFile(lockPath, JSON.stringify(replacementOwner));
    },
  }), /Another sync is already running/);

  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), replacementOwner);
  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'old\n');
});

test('blocks a third sync while restoring a claimed replacement lock', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tube-vault-sync-source-'));
  const target = await mkdtemp(join(tmpdir(), 'tube-vault-sync-target-'));
  const relativePath = 'extension/manifest.json';
  const lockPath = join(target, '.tube-vault-sync.lock');
  const replacementOwner = {
    pid: process.pid,
    hostname: hostname(),
    token: 'replacement-owner',
    processIdentity: await readProcessIdentity(process.pid),
  };
  await mkdir(join(source, 'extension'), { recursive: true });
  await mkdir(join(target, 'extension'), { recursive: true });
  await writeFile(join(source, relativePath), 'new\n');
  await writeFile(join(target, relativePath), 'old\n');
  await writeFile(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    hostname: hostname(),
    token: 'dead-owner',
  }));

  let continueReclaim;
  const reclaimPaused = new Promise((resolve) => {
    continueReclaim = resolve;
  });
  let markClaimed;
  const lockClaimed = new Promise((resolve) => {
    markClaimed = resolve;
  });
  const reclaimingSync = syncArtifacts(source, target, [relativePath], {
    beforeReclaim: async () => {
      await rm(lockPath);
      await writeFile(lockPath, JSON.stringify(replacementOwner));
    },
    afterReclaimClaim: async () => {
      markClaimed();
      await reclaimPaused;
    },
  });
  await lockClaimed;

  await assert.rejects(syncArtifacts(source, target, [relativePath]), /Another sync is already running/);
  continueReclaim();
  await assert.rejects(reclaimingSync, /Another sync is already running/);

  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), replacementOwner);
  assert.equal(await readFile(join(target, relativePath), 'utf8'), 'old\n');
  assert.deepEqual((await readdir(target)).filter((name) => name.includes('.intent-')), []);
});
