import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildBase, parseCapture, videoFormatFlag, mediaFormatFlag, sizeForComponents,
  createBatchSummary, readProcessIdentity, removeBatchSummaryReceipt, resolveBatchSummaryRoot, writeBatchSummary,
  type DownloadRequest, type NamingOptions,
} from './downloader';

const allOn: NamingOptions = {
  titleFiles: true, summaryTxt: true, categoryFolders: true, numbering: true, includeId: true,
};
const req = (extra: Partial<DownloadRequest> = {}): DownloadRequest =>
  ({ action: 'custom', url: 'https://www.youtube.com/watch?v=abc', ...extra });

// ── buildBase ─────────────────────────────────────────────────────────────────

test('buildBase composes uploader / category / numbered title with id', () => {
  const out = buildBase('/root', req({ category: 'Most Popular', index: 3, total: 10 }), allOn);
  assert.equal(out, path.join('/root', '%(uploader)s', 'Most Popular', '003 - %(title)s [%(id)s]'));
});

test('buildBase pads the rank to the width of the batch total', () => {
  const out = buildBase('/root', req({ index: 5, total: 1000 }), { ...allOn, categoryFolders: false });
  assert.equal(out, path.join('/root', '%(uploader)s', '0005 - %(title)s [%(id)s]'));
});

test('buildBase omits numbering for a single (un-indexed) video', () => {
  const out = buildBase('/root', req({ category: 'Latest' }), allOn);
  assert.equal(out, path.join('/root', '%(uploader)s', 'Latest', '%(title)s [%(id)s]'));
});

test('buildBase respects categoryFolders / includeId / numbering toggles', () => {
  const out = buildBase('/root', req({ category: 'Most Popular', index: 2, total: 5 }), {
    ...allOn, categoryFolders: false, includeId: false, numbering: false,
  });
  assert.equal(out, path.join('/root', '%(uploader)s', '%(title)s'));
});

test('buildBase sanitizes the category folder name', () => {
  // sanitizeFilename drops '/' and '?' and then collapses the doubled space.
  const out = buildBase('/root', req({ category: 'Mix / Radio?' }), { ...allOn, numbering: false });
  assert.equal(out, path.join('/root', '%(uploader)s', 'Mix Radio', '%(title)s [%(id)s]'));
});

// ── format / size helpers ───────────────────────────────────────────────────────

test('videoFormatFlag selects best vs height-capped streams', () => {
  assert.equal(videoFormatFlag('best'), 'bv*+ba/b');
  assert.equal(videoFormatFlag('720'), 'bv*[height<=720]+ba/b[height<=720]');
});

test('mediaFormatFlag picks the heaviest selected stream', () => {
  assert.equal(mediaFormatFlag({ video: { quality: '1080', format: 'mp4' } }), 'bv*[height<=1080]+ba/b[height<=1080]');
  assert.equal(mediaFormatFlag({ audio: { format: 'm4a' } }), 'ba/b');
  assert.equal(mediaFormatFlag({ thumbnail: true, metadata: true }), null); // sidecars only
  assert.equal(mediaFormatFlag(undefined), null);
});

test('sizeForComponents adds sidecar bytes only for what was selected', () => {
  assert.equal(sizeForComponents(1000, undefined), 1000);                                  // legacy: raw approx
  assert.equal(sizeForComponents(1000, { video: { quality: 'best', format: 'mp4' } }), 1000);
  assert.equal(sizeForComponents(1000, { video: { quality: 'best', format: 'mp4' }, thumbnail: true, metadata: true }), 1000 + 120_000 + 100_000);
  assert.equal(sizeForComponents(1000, { thumbnail: true }), 120_000);                     // media approx ignored
  assert.equal(sizeForComponents(1000, { metadata: true }), 100_000);
});

test('resolveBatchSummaryRoot uses the helper fallback when settings are blank', () => {
  assert.equal(resolveBatchSummaryRoot('', '/default/videos'), '/default/videos');
  assert.equal(resolveBatchSummaryRoot(undefined, '/default/videos'), '/default/videos');
  assert.equal(resolveBatchSummaryRoot('/chosen/videos', '/default/videos'), '/chosen/videos');
});

test('writeBatchSummary confirms a written file and propagates write failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-receipts-'));
  try {
    const response = createBatchSummary('', 'batch-1', 'Test batch', 'Playlist', [
      { title: 'One', folder: '/videos/one', status: 'done' },
    ], dir, receipts);
    assert.equal(response.ok, true);
    assert.equal(typeof response.summaryPath, 'string');
    assert.equal(fs.existsSync(response.summaryPath as string), true);
    assert.match(path.basename(response.summaryPath as string), /^Test batch - [a-f0-9]{16}\.txt$/);

    const blockingFile = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blockingFile, 'x');
    assert.throws(() => writeBatchSummary(blockingFile, 'batch-2', 'Failed batch', undefined, []));
    const failure = createBatchSummary(blockingFile, 'batch-2', 'Failed batch', undefined, [], undefined, receipts);
    assert.equal(failure.ok, false);
    assert.equal(failure.status, 'failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('createBatchSummary reuses the confirmed file for a repeated batch ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-idempotent-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-receipts-'));
  try {
    const first = createBatchSummary(dir, 'stable-batch', 'Test batch', 'Playlist', [
      { title: 'One', folder: '/videos/one', status: 'done' },
    ], undefined, receipts);
    assert.equal(first.ok, true);
    assert.equal(typeof first.summaryPath, 'string');
    const original = fs.readFileSync(first.summaryPath as string, 'utf8');

    const repeated = createBatchSummary(dir, 'stable-batch', 'Changed label', 'Channel', [
      { title: 'Different item', status: 'failed' },
    ], undefined, receipts);
    assert.deepEqual(repeated, first);
    assert.equal(fs.readFileSync(first.summaryPath as string, 'utf8'), original);
    assert.equal(fs.readdirSync(path.join(dir, 'TubeVault Summaries')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('createBatchSummary sanitizes the readable label without changing its stable identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-safe-name-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-receipts-'));
  try {
    const first = createBatchSummary(dir, 'safe-batch', '../Unsafe: Playlist? / Name. ', undefined, [], undefined, receipts);
    const repeated = createBatchSummary(dir, 'safe-batch', 'A different label', undefined, [], undefined, receipts);

    assert.equal(first.ok, true);
    assert.deepEqual(repeated, first);
    assert.match(path.basename(first.summaryPath as string), /^\.\.Unsafe Playlist Name - [a-f0-9]{16}\.txt$/);
    assert.equal(path.dirname(first.summaryPath as string), path.join(dir, 'TubeVault Summaries'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('createBatchSummary limits Unicode summary names by UTF-8 bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-unicode-name-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-receipts-'));
  try {
    const created = createBatchSummary(dir, 'unicode-batch', '🎬'.repeat(200), undefined, [], undefined, receipts);

    assert.equal(created.ok, true);
    const summaryName = path.basename(created.summaryPath as string);
    assert.ok(Buffer.byteLength(summaryName, 'utf8') <= 255);
    assert.match(summaryName, /^🎬+ - [a-f0-9]{16}\.txt$/u);
    assert.equal(summaryName.includes('�'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('createBatchSummary prefixes Windows reserved device stems with extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-reserved-name-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-reserved-receipts-'));
  try {
    for (const [index, label] of ['CON.txt', 'LPT1.backup'].entries()) {
      const created = createBatchSummary(dir, `reserved-${index}`, label, undefined, [], undefined, receipts);
      assert.equal(created.ok, true);
      assert.match(path.basename(created.summaryPath as string), new RegExp(`^_${label.replace('.', '\\.')} - [a-f0-9]{16}\\.txt$`, 'i'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('writeBatchSummary falls back when hard links are unavailable and remains replay-idempotent', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-portable-'));
  try {
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    const first = writeBatchSummary(dir, 'portable-batch', 'Portable batch', 'Playlist', [
      { title: 'One', status: 'done' },
    ]);
    const original = fs.readFileSync(first, 'utf8');
    const replay = writeBatchSummary(dir, 'portable-batch', 'Changed batch', 'Channel', [
      { title: 'Two', status: 'failed' },
    ]);

    assert.equal(replay, first);
    assert.equal(fs.readFileSync(replay, 'utf8'), original);
    assert.match(original, /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary heartbeats throughout a slow fallback publication', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-heartbeat-'));
  try {
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });
    const futimesSync = fs.futimesSync.bind(fs);
    let heartbeats = 0;
    context.mock.method(fs, 'futimesSync', ((...args: Parameters<typeof fs.futimesSync>) => {
      heartbeats += 1;
      return futimesSync(...args);
    }) as typeof fs.futimesSync);

    const created = writeBatchSummary(dir, 'slow-fallback', 'Slow fallback', undefined, [
      { title: 'x'.repeat(200_000), status: 'done' },
    ]);

    assert.ok(heartbeats >= 6);
    assert.match(fs.readFileSync(created, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
    assert.equal(fs.readdirSync(path.dirname(created)).some((entry) => entry.startsWith('.heartbeat-')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary cleans an interrupted fallback before retrying', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-partial-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'partial-batch';
    const created = writeBatchSummary(dir, batchId, 'Partial batch', undefined, []);
    const summaryName = path.basename(created);
    fs.unlinkSync(created);
    const stableId = summaryName.match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockFile = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.writeFileSync(lockFile, '');
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Partial batch', undefined, []);

    assert.equal(recovered, created);
    assert.notEqual(fs.readFileSync(recovered, 'utf8'), 'incomplete');
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary repairs an unlocked partial file under exclusive ownership', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-unlocked-partial-'));
  try {
    const batchId = 'unlocked-partial-batch';
    const created = writeBatchSummary(dir, batchId, 'Unlocked partial', undefined, []);
    fs.writeFileSync(created, 'incomplete');
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Destination exists') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Unlocked partial', undefined, []);

    assert.equal(recovered, created);
    assert.match(fs.readFileSync(recovered, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary immediately recovers a fresh lock owned by a dead process', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-dead-owner-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'dead-owner-batch';
    const created = writeBatchSummary(dir, batchId, 'Dead owner', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockFile = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockFile);
    fs.writeFileSync(path.join(lockFile, 'owner.json'), JSON.stringify({ pid: 2_147_483_647 }));
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Dead owner', undefined, []);

    assert.equal(recovered, created);
    assert.match(fs.readFileSync(recovered, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary recovers an abandoned recovery marker', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-stale-recovery-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'stale-recovery-batch';
    const created = writeBatchSummary(dir, batchId, 'Stale recovery', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    for (const ownerPath of [lockPath, `${lockPath}.recovery`]) {
      fs.mkdirSync(ownerPath);
      fs.writeFileSync(path.join(ownerPath, 'owner.json'), JSON.stringify({
        token: `dead-${path.basename(ownerPath)}`,
        pid: 2_147_483_647,
      }));
    }
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Stale recovery', undefined, []);

    assert.equal(recovered, created);
    assert.match(fs.readFileSync(recovered, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary cleans an abandoned owner temporary during takeover', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-owner-temp-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'owner-temp-batch';
    const created = writeBatchSummary(dir, batchId, 'Owner temporary', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      token: 'dead-owner',
      pid: 2_147_483_647,
    }));
    fs.writeFileSync(path.join(lockPath, '.owner-12345678-abcd.tmp'), 'abandoned');
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Owner temporary', undefined, []);

    assert.equal(recovered, created);
    assert.match(fs.readFileSync(recovered, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary does not displace a live fallback publisher', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-live-owner-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'live-owner-batch';
    const created = writeBatchSummary(dir, batchId, 'Live owner', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    assert.throws(
      () => writeBatchSummary(dir, batchId, 'Live owner', undefined, []),
      /publication is already in progress/,
    );
    assert.equal(fs.readFileSync(created, 'utf8'), 'incomplete');
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary detects a reused current PID by process incarnation', { skip: process.platform !== 'linux' }, (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-reused-pid-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'reused-pid-batch';
    const created = writeBatchSummary(dir, batchId, 'Reused PID', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      processIdentity: 'different-incarnation',
    }));
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Reused PID', undefined, []);

    assert.equal(recovered, created);
    assert.match(fs.readFileSync(recovered, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readProcessIdentity obtains stable macOS process start metadata', () => {
  const calls: unknown[][] = [];
  const execute = ((...args: unknown[]) => {
    calls.push(args);
    return 'Mon Jul 20 10:11:12 2026\n';
  }) as unknown as typeof import('child_process').execFileSync;

  assert.equal(readProcessIdentity(42, 'darwin', execute), 'darwin:Mon Jul 20 10:11:12 2026');
  assert.deepEqual(calls[0]?.slice(0, 2), ['/bin/ps', ['-p', '42', '-o', 'lstart=']]);
});

test('writeBatchSummary recovers an unverifiable owner after its heartbeat becomes stale', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-process-lease-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'process-lease-batch';
    const created = writeBatchSummary(dir, batchId, 'Process lease', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockPath);
    const token = 'expired-owner';
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      token,
      pid: 1,
      leaseExpiresAt: Date.now() - 1,
    }));
    const heartbeat = path.join(lockPath, `.heartbeat-${createHash('sha256').update(token).digest('hex')}`);
    fs.writeFileSync(heartbeat, '');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(heartbeat, stale, stale);
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    const recovered = writeBatchSummary(dir, batchId, 'Process lease', undefined, []);

    assert.equal(recovered, created);
    assert.match(fs.readFileSync(recovered, 'utf8'), /\nIntegrity: SHA-256 [a-f0-9]{64}\n$/);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary does not take over an owner that heartbeats after stale observation', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-heartbeat-race-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'heartbeat-race-batch';
    const created = writeBatchSummary(dir, batchId, 'Heartbeat race', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    const ownerFile = path.join(lockPath, 'owner.json');
    const token = 'heartbeat-owner';
    const heartbeat = path.join(lockPath, `.heartbeat-${createHash('sha256').update(token).digest('hex')}`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerFile, JSON.stringify({ token, pid: 1, leaseExpiresAt: Date.now() - 1 }));
    fs.writeFileSync(heartbeat, '');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(heartbeat, stale, stale);
    const readFileSync = fs.readFileSync.bind(fs);
    let ownerReads = 0;
    context.mock.method(fs, 'readFileSync', ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (target === ownerFile && ++ownerReads === 2) {
        const refreshed = new Date();
        fs.utimesSync(heartbeat, refreshed, refreshed);
      }
      return (readFileSync as (...parameters: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readFileSync);
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    assert.throws(
      () => writeBatchSummary(dir, batchId, 'Heartbeat race', undefined, []),
      /ownership changed concurrently/,
    );
    assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).token, token);
    assert.equal(fs.readFileSync(created, 'utf8'), 'incomplete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary rejects a replacement owner before taking over recovery', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-concurrent-recovery-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'concurrent-recovery-batch';
    const created = writeBatchSummary(dir, batchId, 'Concurrent recovery', undefined, []);
    const stableId = path.basename(created).match(/[a-f0-9]{16}(?=\.txt$)/)?.[0] as string;
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    fs.writeFileSync(created, 'incomplete');
    fs.mkdirSync(lockPath);
    const ownerFile = path.join(lockPath, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647 }));
    const readFileSync = fs.readFileSync.bind(fs);
    let ownerReads = 0;
    context.mock.method(fs, 'readFileSync', ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (target === ownerFile && ++ownerReads === 2) {
        fs.writeFileSync(ownerFile, JSON.stringify({ token: 'replacement-owner', pid: process.pid }));
      }
      return (readFileSync as (...parameters: unknown[]) => unknown)(target, ...args);
    }) as typeof fs.readFileSync);
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });

    assert.throws(
      () => writeBatchSummary(dir, batchId, 'Concurrent recovery', undefined, []),
      /ownership changed concurrently/,
    );
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).token, 'replacement-owner');
    assert.equal(fs.readFileSync(created, 'utf8'), 'incomplete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBatchSummary stops publishing and preserves a successor after losing its token', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-cleanup-owner-'));
  const summaries = path.join(dir, 'TubeVault Summaries');
  try {
    const batchId = 'cleanup-owner-batch';
    const stableId = createHash('sha256').update(batchId).digest('hex').slice(0, 16);
    const lockPath = path.join(summaries, `.tv-${stableId}.lock`);
    context.mock.method(fs, 'linkSync', () => {
      const error = new Error('Hard links unavailable') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });
    const writeSync = fs.writeSync.bind(fs);
    let replaced = false;
    context.mock.method(fs, 'writeSync', ((...args: Parameters<typeof fs.writeSync>) => {
      const result = writeSync(...args);
      if (!replaced && fs.existsSync(path.join(lockPath, 'owner.json'))) {
        replaced = true;
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
          token: 'successor-token',
          pid: process.pid,
          leaseExpiresAt: Date.now() + 30_000,
        }));
      }
      return result;
    }) as typeof fs.writeSync);

    assert.throws(
      () => writeBatchSummary(dir, batchId, 'Cleanup owner', undefined, []),
      /ownership changed concurrently/,
    );

    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'successor-token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createBatchSummary reuses an existing opaque summary during receipt recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-legacy-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-receipts-'));
  try {
    const first = createBatchSummary(dir, 'legacy-batch', 'Readable label', undefined, [], undefined, receipts);
    assert.equal(first.ok, true);

    const readableFile = first.summaryPath as string;
    const digest = path.basename(fs.readdirSync(receipts)[0], '.json');
    const opaqueFile = path.join(dir, 'TubeVault Summaries', `TubeVault batch - ${digest}.txt`);
    fs.renameSync(readableFile, opaqueFile);

    const recovered = createBatchSummary(dir, 'legacy-batch', 'Readable label', undefined, [], undefined, receipts);
    assert.equal(recovered.summaryPath, opaqueFile);
    assert.equal(fs.readdirSync(path.dirname(opaqueFile)).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('createBatchSummary reuses the reserved root when a blank-root fallback changes', () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-first-root-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-second-root-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-receipts-'));
  try {
    const first = createBatchSummary('', 'stable-blank-batch', 'Test batch', 'Playlist', [
      { title: 'One', status: 'done' },
    ], firstRoot, receipts);
    const repeated = createBatchSummary('', 'stable-blank-batch', 'Changed batch', 'Channel', [
      { title: 'Two', status: 'failed' },
    ], secondRoot, receipts);

    assert.deepEqual(repeated, first);
    assert.equal(fs.readdirSync(path.join(firstRoot, 'TubeVault Summaries')).length, 1);
    assert.equal(fs.existsSync(path.join(secondRoot, 'TubeVault Summaries')), false);
  } finally {
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

test('removeBatchSummaryReceipt deletes a receipt idempotently after finalization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-cleanup-root-'));
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-summary-cleanup-receipts-'));
  try {
    const created = createBatchSummary(root, 'cleanup-batch', 'Cleanup batch', undefined, [], undefined, receipts);
    assert.equal(created.ok, true);
    assert.equal(fs.readdirSync(receipts).length, 1);

    assert.deepEqual(removeBatchSummaryReceipt('cleanup-batch', receipts), { ok: true, status: 'ok' });
    assert.deepEqual(removeBatchSummaryReceipt('cleanup-batch', receipts), { ok: true, status: 'ok' });
    assert.deepEqual(fs.readdirSync(receipts), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(receipts, { recursive: true, force: true });
  }
});

// ── parseCapture ────────────────────────────────────────────────────────────────

test('parseCapture recovers folder, media path, and metadata from a media run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cap-'));
  const file = path.join(dir, 'My Title [vidId].mp4');
  fs.writeFileSync(file, 'x');
  try {
    const line = `${file}\tMy Title\tUploader Name\t20240115\t1234\t300\tvidId`;
    const { folder, mediaPath, meta } = parseCapture([{ out: line + '\n', err: '' }]);
    assert.equal(folder, dir);
    assert.equal(mediaPath, file);
    assert.deepEqual(meta, {
      title: 'My Title', uploader: 'Uploader Name', uploadDate: '20240115',
      views: '1234', duration: '300', id: 'vidId',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCapture recovers the folder from a skip-download (NA filepath) run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cap-'));
  const thumb = path.join(dir, 'Thumb.jpg');
  fs.writeFileSync(thumb, 'x');
  try {
    const printLine = `NA\tThumb Title\tUp2\t20240101\t10\t60\tvid2`;   // --print, no media file
    const writeLine = `[info] Writing video thumbnail to: ${thumb}`;     // yt-dlp's own log line
    const { folder, mediaPath, meta } = parseCapture([{ out: printLine + '\n', err: writeLine + '\n' }]);
    assert.equal(folder, dir);
    assert.equal(mediaPath, thumb);
    assert.equal(meta.title, 'Thumb Title');
    assert.equal(meta.id, 'vid2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
