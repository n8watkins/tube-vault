import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildBase, parseCapture, videoFormatFlag, mediaFormatFlag, sizeForComponents,
  createBatchSummary, removeBatchSummaryReceipt, resolveBatchSummaryRoot, writeBatchSummary,
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
