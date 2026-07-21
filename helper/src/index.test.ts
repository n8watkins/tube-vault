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
