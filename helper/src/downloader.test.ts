import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildBase, parseCapture, videoFormatFlag, mediaFormatFlag, sizeForComponents,
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
