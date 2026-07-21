import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { readProcessIdentity } from './downloader';

const jobsDirectory = path.join(os.tmpdir(), 'tube-vault-jobs');

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
  ], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'inherit'] });
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

test('native cancellation rejects a reused PID and preserves its owner record', async () => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const jobId = `stale-${process.pid}`;
  const file = ownerFile(jobId);
  try {
    fs.mkdirSync(jobsDirectory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: victim.pid, processIdentity: 'wrong-incarnation' }));
    const response = await nativeRequest({ action: 'cancel', jobId });
    assert.deepEqual(response, { ok: false, status: 'failed', error: 'Job not found or already finished' });
    assert.equal(isAlive(victim.pid as number), true);
    assert.equal(fs.existsSync(file), true);
  } finally {
    victim.kill('SIGKILL');
    fs.rmSync(file, { force: true });
  }
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
    fs.mkdirSync(jobsDirectory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: victim.pid, processIdentity: identity }));
    const exited = once(victim, 'exit');
    const response = await nativeRequest({ action: 'cancel', jobId });
    await exited;
    assert.deepEqual(response, { ok: true, status: 'cancelled' });
    assert.equal(isAlive(victim.pid as number), false);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (isAlive(victim.pid as number)) victim.kill('SIGKILL');
    fs.rmSync(file, { force: true });
  }
});
