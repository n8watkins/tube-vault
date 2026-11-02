import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { readProcessIdentity } from './downloader';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-vault-index-test-'));
const jobsDirectory = path.join(testRoot, 'jobs');

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function nativeRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const host = spawn(process.execPath, [
    '-r',
    'ts-node/register/transpile-only',
    path.join(__dirname, 'index.ts'),
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', TUBE_VAULT_TEST_JOBS_DIR: jobsDirectory },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  let output = Buffer.alloc(0);
  host.stdout.on('data', (chunk: Buffer) => { output = Buffer.concat([output, chunk]); });
  host.stdin.end(Buffer.concat([header, body]));
  const [code] = await once(host, 'exit');
  assert.equal(code, 0);
  assert.ok(output.length >= 4);
  const length = output.readUInt32LE(0);
  return JSON.parse(output.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
}

function ownerFile(jobId: string): string {
  return path.join(jobsDirectory, `${jobId}.pid`);
}

function cancellationFile(jobId: string): string {
  return path.join(jobsDirectory, `${jobId}.cancel`);
}

test('native cancellation rejects path traversal without touching an outside PID file', async () => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const stem = `tube-vault-traversal-${process.pid}`;
  const outsideFile = path.join(os.tmpdir(), `${stem}.pid`);
  try {
    fs.writeFileSync(outsideFile, String(victim.pid));
    const response = await nativeRequest({ action: 'cancel', jobId: `../${stem}` });
    assert.deepEqual(response, { ok: false, status: 'failed', error: 'Invalid job ID' });
    assert.equal(isAlive(victim.pid as number), true);
    assert.equal(fs.existsSync(outsideFile), true);
  } finally {
    victim.kill('SIGKILL');
    fs.rmSync(outsideFile, { force: true });
  }
});

test('native cancellation durably prevents a job that has not registered yet', async () => {
  const jobId = `not-registered-${process.pid}`;
  const response = await nativeRequest({ action: 'cancel', jobId });

  assert.deepEqual(response, { ok: true, status: 'cancellation_pending' });
  assert.equal(fs.existsSync(cancellationFile(jobId)), true);
  const probe = await nativeRequest({
    action: 'probe',
    jobId,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  });
  assert.deepEqual(probe, { ok: false, status: 'failed', error: 'Job cancelled' });
});

test('native cancellation safely clears a stale owner without signaling a reused PID', async () => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const jobId = `stale-${process.pid}`;
  const file = ownerFile(jobId);
  try {
    fs.mkdirSync(jobsDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(jobsDirectory, 0o700);
    fs.writeFileSync(file, JSON.stringify({ pid: victim.pid, processIdentity: 'wrong-incarnation' }), { mode: 0o600 });
    const response = await nativeRequest({ action: 'cancel', jobId });
    assert.deepEqual(response, { ok: true, status: 'cancelled' });
    assert.equal(isAlive(victim.pid as number), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(cancellationFile(jobId)), true);
  } finally {
    victim.kill('SIGKILL');
    fs.rmSync(file, { force: true });
    fs.rmSync(cancellationFile(jobId), { force: true });
  }
});

test('native cancellation cleanup removes a persisted tombstone idempotently', async () => {
  const jobId = `finalized-${process.pid}`;
  assert.deepEqual(await nativeRequest({ action: 'cancel', jobId }), { ok: true, status: 'cancellation_pending' });
  assert.equal(fs.existsSync(cancellationFile(jobId)), true);

  assert.deepEqual(await nativeRequest({ action: 'cancel_finalize', jobId }), { ok: true, status: 'ok' });
  assert.equal(fs.existsSync(cancellationFile(jobId)), false);
  assert.deepEqual(await nativeRequest({ action: 'cancel_finalize', jobId }), { ok: true, status: 'ok' });
});

test('native cancellation terminates only the matching process incarnation', async (context) => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const jobId = `current-${process.pid}`;
  const file = ownerFile(jobId);
  const identity = readProcessIdentity(victim.pid as number);
  if (!identity) {
    victim.kill('SIGKILL');
    context.skip('process identity is unavailable on this platform');
    return;
  }
  try {
    fs.mkdirSync(jobsDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(jobsDirectory, 0o700);
    fs.writeFileSync(file, JSON.stringify({ pid: victim.pid, processIdentity: identity }), { mode: 0o600 });
    const exited = once(victim, 'exit');
    const response = await nativeRequest({ action: 'cancel', jobId });
    await exited;
    assert.deepEqual(response, { ok: true, status: 'cancelled' });
    assert.equal(isAlive(victim.pid as number), false);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (isAlive(victim.pid as number)) victim.kill('SIGKILL');
    fs.rmSync(file, { force: true });
    fs.rmSync(cancellationFile(jobId), { force: true });
  }
});

test('native cancellation rejects an unsafe registry directory', async () => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const jobId = `unsafe-${process.pid}`;
  const file = ownerFile(jobId);
  const identity = readProcessIdentity(victim.pid as number);
  if (!identity) {
    victim.kill('SIGKILL');
    return;
  }
  try {
    fs.mkdirSync(jobsDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(jobsDirectory, 0o777);
    fs.writeFileSync(file, JSON.stringify({ pid: victim.pid, processIdentity: identity }), { mode: 0o600 });
    const response = await nativeRequest({ action: 'cancel', jobId });
    assert.deepEqual(response, { ok: false, status: 'failed', error: 'Job cancellation failed' });
    assert.equal(isAlive(victim.pid as number), true);
    assert.equal(fs.existsSync(file), true);
  } finally {
    victim.kill('SIGKILL');
    fs.rmSync(jobsDirectory, { recursive: true, force: true });
  }
});

test('native cancellation rejects a symlinked registry directory', async () => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const jobId = `symlink-${process.pid}`;
  const controlledDirectory = path.join(testRoot, 'controlled');
  const file = path.join(controlledDirectory, `${jobId}.pid`);
  const identity = readProcessIdentity(victim.pid as number);
  if (!identity) {
    victim.kill('SIGKILL');
    return;
  }
  try {
    fs.mkdirSync(controlledDirectory, { mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ pid: victim.pid, processIdentity: identity }), { mode: 0o600 });
    fs.symlinkSync(controlledDirectory, jobsDirectory, 'dir');
    const response = await nativeRequest({ action: 'cancel', jobId });
    assert.deepEqual(response, { ok: false, status: 'failed', error: 'Job cancellation failed' });
    assert.equal(isAlive(victim.pid as number), true);
    assert.equal(fs.existsSync(file), true);
  } finally {
    victim.kill('SIGKILL');
    fs.rmSync(jobsDirectory, { force: true });
    fs.rmSync(controlledDirectory, { recursive: true, force: true });
  }
});

// A stand-in yt-dlp: writes the media file named by the first `-o` template,
// prints the capture line, and (only when asked for progress templates) prints a
// plan of a merged download's two streams, downloads the video stream and then the
// audio stream, and reports the merge on stderr like the real one. Like the real
// one, it reports the post-processors that run before the download: SponsorBlock
// before the plan and the thumbnail convert after it.
function writeFakeYtDlp(directory: string): void {
  const script = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1].replace('%(title)s', 'Fake title').replace('%(ext)s', 'mp4');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, 'x'.repeat(1000));
const tick = (part, done, total, status) => '[tube-vault-progress]\\tdownload\\t' + part + '\\t' + status + '\\t' + done + '\\t' + total + '\\tNA\\t500\\t1\\n';
// Post-processing ticks go to stderr and the rest to stdout, two pipes the helper
// reads independently; the real yt-dlp spends time between them (fetching,
// downloading, running ffmpeg), so the stand-in pauses at each switch too.
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
const postprocess = (name, status) => { pause(); process.stderr.write('[tube-vault-progress]\\tpostprocess\\t' + name + '\\t' + status + '\\n'); pause(); };
if (args.includes('--progress-template')) {
  if (args.includes('--sponsorblock-mark')) { postprocess('SponsorBlock', 'started'); postprocess('SponsorBlock', 'finished'); }
  if (args.some((arg) => arg.startsWith('video:[tube-vault-progress]'))) {
    process.stdout.write('[tube-vault-progress]\\tplan\\t137+140\\t["137", "140"]\\t[600, 400]\\t[600, 400]\\tNA\\t1000\\n');
  }
  if (args.includes('--convert-thumbnails')) { postprocess('ThumbnailsConvertor', 'started'); postprocess('ThumbnailsConvertor', 'finished'); }
  process.stdout.write(tick(137, 300, 600, 'downloading'));
  process.stdout.write(tick(137, 600, 600, 'finished'));
  process.stdout.write(tick(140, 200, 400, 'downloading'));
  process.stdout.write(tick(140, 400, 400, 'finished'));
  postprocess('Merger', 'started');
}
process.stdout.write(output + '\\tFake title\\tUploader\\t20200101\\t1\\t19\\tfakeid\\n');
`;
  fs.writeFileSync(path.join(directory, 'yt-dlp'), script, { mode: 0o755 });
}

async function nativeConversation(payload: Record<string, unknown>, binDirectory: string): Promise<Record<string, unknown>[]> {
  const host = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', path.join(__dirname, 'index.ts')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', TUBE_VAULT_TEST_JOBS_DIR: jobsDirectory, PATH: `${binDirectory}:${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  let output = Buffer.alloc(0);
  host.stdout.on('data', (chunk: Buffer) => { output = Buffer.concat([output, chunk]); });
  host.stdin.end(Buffer.concat([header, body]));
  const [code] = await once(host, 'exit');
  assert.equal(code, 0);
  const messages: Record<string, unknown>[] = [];
  while (output.length >= 4) {
    const length = output.readUInt32LE(0);
    messages.push(JSON.parse(output.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>);
    output = output.subarray(4 + length);
  }
  return messages;
}

test('custom downloads stream progress before the result only when the caller asks', async () => {
  const binDirectory = fs.mkdtempSync(path.join(testRoot, 'bin-'));
  const outputRoot = fs.mkdtempSync(path.join(testRoot, 'out-'));
  writeFakeYtDlp(binDirectory);
  const request = {
    action: 'custom',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    components: { video: { quality: 'best', format: 'mp4' } },
    jobId: `progress-${process.pid}`,
    expectedBytes: 2000,
    options: { outputRoot, naming: { titleFiles: true, summaryTxt: false, categoryFolders: false, numbering: false, includeId: true } },
  };

  const streamed = await nativeConversation({ ...request, progress: true }, binDirectory);
  const progress = streamed.filter((message) => message.type === 'progress');
  assert.ok(progress.length >= 2, `expected progress ticks, got ${JSON.stringify(streamed)}`);
  assert.deepEqual(progress[0], {
    type: 'progress',
    jobId: request.jobId,
    // The plan's two streams are the total, not the probe's larger estimate.
    progress: { phase: 'downloading', downloadedBytes: 300, totalBytes: 1000, percent: 30, speed: 500, eta: 1 },
  });
  assert.deepEqual(progress.at(-1)?.progress, { phase: 'processing', downloadedBytes: 1000, totalBytes: 1000, percent: 100, speed: null, eta: null });
  const result = streamed.at(-1)!;
  assert.equal(result.type, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'complete');

  const oneShot = await nativeConversation({ ...request, jobId: `oneshot-${process.pid}` }, binDirectory);
  assert.equal(oneShot.length, 1);
  assert.equal(oneShot[0].ok, true);
});

test('a download with SponsorBlock and a thumbnail starts at downloading, not at finishing up', async () => {
  const binDirectory = fs.mkdtempSync(path.join(testRoot, 'bin-'));
  const outputRoot = fs.mkdtempSync(path.join(testRoot, 'out-'));
  writeFakeYtDlp(binDirectory);
  const streamed = await nativeConversation({
    action: 'custom',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    components: { video: { quality: 'best', format: 'mp4' }, thumbnail: true },
    jobId: `preprocess-${process.pid}`,
    expectedBytes: 2000,
    progress: true,
    options: {
      outputRoot,
      sponsorblock: 'mark',
      naming: { titleFiles: true, summaryTxt: false, categoryFolders: false, numbering: false, includeId: true },
    },
  }, binDirectory);
  const progress = streamed
    .filter((message) => message.type === 'progress')
    .map((message) => message.progress as { phase: string; percent: number | null });
  assert.ok(progress.length >= 2, `expected progress ticks, got ${JSON.stringify(streamed)}`);
  assert.equal(progress[0].phase, 'downloading', `the first tick is the download, got ${JSON.stringify(progress)}`);
  const firstProcessing = progress.findIndex((tick) => tick.phase === 'processing');
  assert.equal(firstProcessing, progress.length - 1, `finishing up comes last and once, got ${JSON.stringify(progress)}`);
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok((progress[index].percent ?? 0) >= (progress[index - 1].percent ?? 0), `the percent never goes back: ${JSON.stringify(progress)}`);
  }
  assert.equal(streamed.at(-1)?.ok, true);
});
