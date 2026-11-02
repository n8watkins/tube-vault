import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, PROGRESS_PREFIX, ProgressTracker, parseProgressLine, progressArgs, type DownloadProgress } from './progress';

const download = (part: string, status: string, done: string, total: string, estimate: string, speed: string, eta: string) =>
  [PROGRESS_PREFIX, 'download', part, status, done, total, estimate, speed, eta].join('\t');
const postprocess = (name: string, status: string) => [PROGRESS_PREFIX, 'postprocess', name, status].join('\t');

test('progressArgs asks yt-dlp for line-based download and post-processing ticks', () => {
  const args = progressArgs();
  assert.deepEqual(args.slice(0, 2), ['--progress', '--newline']);
  const templates = args.filter((_arg, index) => args[index - 1] === '--progress-template');
  assert.equal(templates.length, 2);
  assert.ok(templates[0].startsWith(`download:${PROGRESS_PREFIX}\tdownload\t`));
  assert.ok(templates[1].startsWith(`postprocess:${PROGRESS_PREFIX}\tpostprocess\t`));
});

test('parseProgressLine reads download ticks, falling back to the size estimate', () => {
  assert.deepEqual(parseProgressLine(download('137', 'downloading', '1024', '4096', 'NA', '2048.5', '1')), {
    kind: 'download', part: '137', status: 'downloading', downloadedBytes: 1024, totalBytes: 4096, speed: 2048.5, eta: 1,
  });
  assert.deepEqual(parseProgressLine(download('251', 'downloading', '10', 'NA', '900.7', 'NA', 'NA')), {
    kind: 'download', part: '251', status: 'downloading', downloadedBytes: 10, totalBytes: 900.7, speed: null, eta: null,
  });
  assert.deepEqual(parseProgressLine(postprocess('Merger', 'started')), { kind: 'postprocess', postprocessor: 'Merger', status: 'started' });
  assert.equal(parseProgressLine('[download]  42.0% of 10MiB'), null);
  assert.equal(parseProgressLine(`${PROGRESS_PREFIX}\tdownload\ttoo-short`), null);
});

test('ProgressTracker sums parallel runs and sequential streams into one job total', () => {
  let clock = 0;
  const emitted: DownloadProgress[] = [];
  const tracker = new ProgressTracker((progress) => emitted.push(progress), { intervalMs: 0, now: () => clock });

  tracker.update(0, parseProgressLine(download('137', 'downloading', '300', '1000', 'NA', '100', '7'))!);
  tracker.update(1, parseProgressLine(download('251', 'downloading', '50', '200', 'NA', '50', '3'))!);
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 350, totalBytes: 1200, speed: 150, eta: 6 });

  clock += 100;
  tracker.update(0, parseProgressLine(download('137', 'finished', '1000', '1000', 'NA', 'NA', 'NA'))!);
  tracker.update(0, parseProgressLine(download('140', 'downloading', '0', '400', 'NA', '200', '2'))!);
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 1050, totalBytes: 1600, speed: 250, eta: 2 });
});

test('ProgressTracker uses the probe estimate as a floor so the percentage does not jump back', () => {
  const emitted: DownloadProgress[] = [];
  const tracker = new ProgressTracker((progress) => emitted.push(progress), { expectedBytes: 1500, intervalMs: 0, now: () => 0 });
  tracker.update(0, parseProgressLine(download('137', 'downloading', '900', '1000', 'NA', '100', '1'))!);
  assert.equal(emitted.at(-1)?.totalBytes, 1500);
  assert.equal(emitted.at(-1)?.eta, 6);
});

test('ProgressTracker reports post-processing and rate-limits steady ticks', () => {
  let clock = 0;
  const emitted: DownloadProgress[] = [];
  const tracker = new ProgressTracker((progress) => emitted.push(progress), { intervalMs: 500, now: () => clock });

  tracker.update(0, parseProgressLine(download('18', 'downloading', '1', '100', 'NA', '10', '9'))!);
  clock = 100;
  tracker.update(0, parseProgressLine(download('18', 'downloading', '2', '100', 'NA', '10', '9'))!);
  assert.equal(emitted.length, 1, 'a tick inside the interval is held back');
  clock = 600;
  tracker.update(0, parseProgressLine(download('18', 'downloading', '50', '100', 'NA', '10', '5'))!);
  assert.equal(emitted.length, 2);

  clock = 700;
  tracker.update(0, parseProgressLine(download('18', 'finished', '100', '100', 'NA', 'NA', 'NA'))!);
  clock = 750;
  tracker.update(0, parseProgressLine(postprocess('Merger', 'started'))!);
  assert.deepEqual(emitted.at(-1), { phase: 'processing', downloadedBytes: 100, totalBytes: 100, speed: null, eta: null });
});

test('LineSplitter separates progress lines from other output across chunk boundaries', () => {
  const progress: string[] = [];
  let other = '';
  const splitter = new LineSplitter((line) => progress.push(line), (text) => (other += text));
  const tick = download('18', 'downloading', '1', '2', 'NA', '3', '4');
  splitter.push(`/tmp/a.mp4\tTitle\n${tick.slice(0, 12)}`);
  splitter.push(`${tick.slice(12)}\r\nWARNING: x\n`);
  splitter.push('tail without newline');
  splitter.end();
  assert.deepEqual(progress, [tick]);
  assert.equal(other, '/tmp/a.mp4\tTitle\nWARNING: x\ntail without newline');
});
