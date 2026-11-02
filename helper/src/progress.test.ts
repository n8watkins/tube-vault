import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, PROGRESS_PREFIX, ProgressTracker, parseProgressLine, planArgs, progressArgs, type DownloadProgress, type ProgressEvent } from './progress';

const download = (part: string, status: string, done: string, total: string, estimate: string, speed: string, eta: string) =>
  [PROGRESS_PREFIX, 'download', part, status, done, total, estimate, speed, eta].join('\t');
const postprocess = (name: string, status: string) => [PROGRESS_PREFIX, 'postprocess', name, status].join('\t');
// What yt-dlp prints for planArgs(): a merged format lists its streams as JSON.
const plan = (formatId: string, ids: string, sizes: string, approx: string, size = 'NA', sizeApprox = 'NA') =>
  [PROGRESS_PREFIX, 'plan', formatId, ids, sizes, approx, size, sizeApprox].join('\t');
const event = (line: string): ProgressEvent => parseProgressLine(line)!;
const percents = (emitted: DownloadProgress[]) => emitted.map((progress) => progress.percent);
const tracked = (options: { expectedBytes?: number } = {}) => {
  let clock = 0;
  const emitted: DownloadProgress[] = [];
  const tracker = new ProgressTracker((progress) => emitted.push(progress), { ...options, intervalMs: 0, now: () => (clock += 10) });
  return { tracker, emitted };
};

test('progressArgs asks yt-dlp for line-based download and post-processing ticks', () => {
  const args = progressArgs();
  assert.deepEqual(args.slice(0, 2), ['--progress', '--newline']);
  const templates = args.filter((_arg, index) => args[index - 1] === '--progress-template');
  assert.equal(templates.length, 2);
  assert.ok(templates[0].startsWith(`download:${PROGRESS_PREFIX}\tdownload\t`));
  assert.ok(templates[1].startsWith(`postprocess:${PROGRESS_PREFIX}\tpostprocess\t`));
  const prints = planArgs();
  assert.equal(prints[0], '--print');
  assert.ok(prints[1].startsWith(`video:${PROGRESS_PREFIX}\tplan\t`), 'the plan prints before the download, after format selection');
});

test('parseProgressLine reads the plan of a merged download and of a single format', () => {
  assert.deepEqual(event(plan('137+140', '["137", "140"]', '[null, 4000]', '[90000, 3990]')), {
    kind: 'plan', streams: [{ part: '137', bytes: 90000 }, { part: '140', bytes: 4000 }],
  });
  assert.deepEqual(event(plan('251', '[]', '[]', '[]', 'NA', '2500')), { kind: 'plan', streams: [{ part: '251', bytes: 2500 }] });
  assert.deepEqual(event(plan('18', 'NA', 'NA', 'NA')), { kind: 'plan', streams: [{ part: '18', bytes: null }] });
  assert.equal(parseProgressLine(plan('NA', '[]', '[]', '[]')), null);
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
  // 350 of 1200 is 29%, but 30% was already shown (300 of the first 1000), so it holds.
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 350, totalBytes: 1200, percent: 30, speed: 150, eta: 6 });

  clock += 100;
  tracker.update(0, parseProgressLine(download('137', 'finished', '1000', '1000', 'NA', 'NA', 'NA'))!);
  tracker.update(0, parseProgressLine(download('140', 'downloading', '0', '400', 'NA', '200', '2'))!);
  // Without a plan the new stream grows the total: 65% of it, held at the 87% shown before it began.
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 1050, totalBytes: 1600, percent: 87, speed: 250, eta: 2 });
});

test('ProgressTracker uses the probe estimate as a floor so the percentage does not jump back', () => {
  const emitted: DownloadProgress[] = [];
  const tracker = new ProgressTracker((progress) => emitted.push(progress), { expectedBytes: 1500, intervalMs: 0, now: () => 0 });
  tracker.update(0, parseProgressLine(download('137', 'downloading', '900', '1000', 'NA', '100', '1'))!);
  assert.equal(emitted.at(-1)?.totalBytes, 1500);
  assert.equal(emitted.at(-1)?.eta, 6);
});

test('the percent holds instead of dipping when the real total outgrows the estimate', () => {
  const { tracker, emitted } = tracked({ expectedBytes: 1000 });
  tracker.update(0, event(download('137', 'downloading', '660', 'NA', '700', '100', '1')));
  assert.equal(emitted.at(-1)?.percent, 66);
  // yt-dlp now reports a larger real size: 670 of 1030 bytes is 65%, but the bar holds at 66%...
  tracker.update(0, event(download('137', 'downloading', '670', '1030', 'NA', '100', '3')));
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 670, totalBytes: 1030, percent: 66, speed: 100, eta: 4 });
  // ...while the bytes and the total keep updating, and it moves on once the bytes pass it.
  tracker.update(0, event(download('137', 'downloading', '690', '1030', 'NA', '100', '3')));
  assert.equal(emitted.at(-1)?.percent, 66);
  tracker.update(0, event(download('137', 'downloading', '700', '1030', 'NA', '100', '3')));
  assert.equal(emitted.at(-1)?.percent, 67);
});

test('a merged download counts both streams from the start, so the switch to audio neither dips nor resets', () => {
  const { tracker, emitted } = tracked({ expectedBytes: 800 });
  tracker.addRun({ plans: true });
  tracker.update(0, event(plan('137+140', '["137", "140"]', '[800, 200]', '[800, 200]')));
  tracker.update(0, event(download('137', 'downloading', '400', '800', 'NA', '100', '4')));
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 400, totalBytes: 1000, percent: 40, speed: 100, eta: 6 });
  tracker.update(0, event(download('137', 'finished', '800', '800', 'NA', 'NA', 'NA')));
  tracker.update(0, event(download('140', 'downloading', '0', '200', 'NA', '100', '2')));
  tracker.update(0, event(download('140', 'downloading', '100', '200', 'NA', '100', '1')));
  tracker.update(0, event(download('140', 'finished', '200', '200', 'NA', 'NA', 'NA')));
  assert.deepEqual(percents(emitted), [40, 80, 80, 90, 99]);
  assert.equal(emitted.at(-1)?.totalBytes, 1000);
});

test('without a plan, the audio stream showing up pauses the bar instead of pulling it back', () => {
  const { tracker, emitted } = tracked();
  tracker.update(0, event(download('137', 'downloading', '700', '800', 'NA', '100', '1')));
  tracker.update(0, event(download('137', 'finished', '800', '800', 'NA', 'NA', 'NA')));
  tracker.update(0, event(download('140', 'downloading', '10', '200', 'NA', '100', '2')));
  tracker.update(0, event(download('140', 'downloading', '195', '200', 'NA', '100', '0')));
  assert.deepEqual(percents(emitted), [87, 99, 99, 99]);
  assert.deepEqual(emitted.map((progress) => progress.downloadedBytes), [700, 800, 810, 995], 'the bytes keep moving while the percent holds');
});

test('video and audio runs in parallel share one total once both plans are in', () => {
  const { tracker, emitted } = tracked({ expectedBytes: 1000 });
  const video = tracker.addRun({ plans: true });
  const audio = tracker.addRun({ plans: true });
  tracker.update(video, event(plan('137+140', '["137", "140"]', '[900, 100]', '[900, 100]')));
  tracker.update(video, event(download('137', 'downloading', '300', '900', 'NA', '100', '6')));
  assert.equal(emitted.at(-1)?.totalBytes, 1000, 'the probe estimate is the floor until the audio run plans');
  tracker.update(audio, event(plan('251', '[]', '[]', '[]', '150', 'NA')));
  tracker.update(audio, event(download('251', 'downloading', '50', '150', 'NA', '50', '2')));
  assert.equal(emitted.at(-1)?.totalBytes, 1150);
  assert.equal(emitted.at(-1)?.percent, 30);
});

test('post-processing shows 100%, and a second video in the same run adds to the job instead of replacing the first', () => {
  const { tracker, emitted } = tracked();
  tracker.addRun({ plans: true });
  tracker.update(0, event(plan('18', '[]', '[]', '[]', '500')));
  tracker.update(0, event(download('18', 'finished', '500', '500', 'NA', 'NA', 'NA')));
  tracker.update(0, event(postprocess('Merger', 'started')));
  assert.deepEqual(emitted.at(-1), { phase: 'processing', downloadedBytes: 500, totalBytes: 500, percent: 100, speed: null, eta: null });
  // The next video of the playlist (same format ID) adds to the job instead of replacing the first one.
  tracker.update(0, event(plan('18', '[]', '[]', '[]', '500')));
  tracker.update(0, event(download('18', 'downloading', '100', '500', 'NA', '100', '4')));
  // 600 of 1000 bytes; the bar holds at the 99% it already showed rather than dropping to 60%.
  assert.deepEqual(emitted.at(-1), { phase: 'downloading', downloadedBytes: 600, totalBytes: 1000, percent: 99, speed: 100, eta: 4 });
  tracker.update(0, event(download('18', 'finished', '500', '500', 'NA', 'NA', 'NA')));
  tracker.update(0, event(postprocess('Merger', 'started')));
  assert.equal(emitted.at(-1)?.percent, 100);
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
  assert.deepEqual(emitted.at(-1), { phase: 'processing', downloadedBytes: 100, totalBytes: 100, percent: 100, speed: null, eta: null });
});

test('ProgressTracker sends the last held-back tick once the interval is up', async () => {
  let clock = 0;
  const emitted: DownloadProgress[] = [];
  const tracker = new ProgressTracker((progress) => emitted.push(progress), { intervalMs: 40, now: () => clock });
  tracker.update(0, event(download('137', 'downloading', '10', '100', 'NA', '10', '9')));
  clock = 10;
  tracker.update(0, event(download('137', 'finished', '100', '100', 'NA', 'NA', 'NA')));
  assert.equal(emitted.length, 1);
  clock = 50;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(emitted.length, 2, 'the finished stream is not lost while the next one opens');
  assert.equal(emitted.at(-1)?.downloadedBytes, 100);

  clock = 60;
  tracker.update(0, event(download('140', 'downloading', '1', '100', 'NA', '10', '9')));
  tracker.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(emitted.length, 2, 'nothing is sent after stop()');
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
