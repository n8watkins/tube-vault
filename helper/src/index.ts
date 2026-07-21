import { readMessages, writeMessage } from './protocol';
import { handle, killActive, probeVideo, listVideos, createBatchSummary, removeBatchSummaryReceipt, defaultOutputRoot, readProcessIdentity, type DownloadRequest, type Action, type DownloadComponents, type BatchSummaryItem } from './downloader';
import { isValidJobId, isValidYouTubeUrl, wslToWindowsPath, IS_WSL } from './sanitize';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Reported back to the popup on `ping`. Read from package.json (dist/ sits one
// level below it at runtime) so it never drifts from the published helper version.
const HELPER_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const ALLOWED_ACTIONS: Action[] = [
  'custom',
  'channel_plan',
  'download_best',
  'download_audio',
  'download_thumbnail',
  'download_metadata',
  'archive_bundle',
  'diagnostics',
];

// A cancellable probe or download records its owner here by jobId so a separate
// `cancel` invocation can durably request cancellation and signal the right process.
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
const defaultJobsDirectory = path.join(os.tmpdir(), `tube-vault-jobs-${uid ?? os.userInfo().username}`);
const JOBS_DIR = process.env.NODE_ENV === 'test' && process.env.TUBE_VAULT_TEST_JOBS_DIR
  ? process.env.TUBE_VAULT_TEST_JOBS_DIR
  : defaultJobsDirectory;
const pidFile = (jobId: string) => path.join(JOBS_DIR, `${jobId}.pid`);
const cancellationFile = (jobId: string) => path.join(JOBS_DIR, `${jobId}.cancel`);
interface JobOwner { pid: number; processIdentity: string; }

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function assertPrivatePath(target: string, kind: 'directory' | 'file'): void {
  const stats = fs.lstatSync(target);
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) throw new Error(`Unsafe job ${kind}`);
  if (uid !== undefined && stats.uid !== uid) throw new Error(`Unsafe job ${kind} owner`);
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) throw new Error(`Unsafe job ${kind} permissions`);
}

function ensureJobsDirectory(): void {
  try {
    fs.mkdirSync(JOBS_DIR, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivatePath(JOBS_DIR, 'directory');
}

function writePid(jobId: string): string {
  const processIdentity = readProcessIdentity(process.pid);
  if (!processIdentity) throw new Error('Process identity is unavailable');
  const contents = JSON.stringify({ pid: process.pid, processIdentity });
  const temporaryFile = path.join(JOBS_DIR, `.${jobId}.${randomUUID()}.tmp`);
  try {
    ensureJobsDirectory();
    fs.writeFileSync(temporaryFile, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryFile, pidFile(jobId));
    return contents;
  } catch (error) {
    try { fs.unlinkSync(temporaryFile); } catch { /* ignore */ }
    throw error;
  }
}
function recordCancellation(jobId: string): void {
  ensureJobsDirectory();
  try {
    fs.writeFileSync(cancellationFile(jobId), JSON.stringify({ cancelledAt: Date.now() }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    assertPrivatePath(cancellationFile(jobId), 'file');
  }
}
function cancellationRequested(jobId: string): boolean {
  try {
    assertPrivatePath(cancellationFile(jobId), 'file');
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
function clearCancellation(jobId: string): void {
  ensureJobsDirectory();
  try {
    assertPrivatePath(cancellationFile(jobId), 'file');
    fs.unlinkSync(cancellationFile(jobId));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}
function clearPid(jobId: string, expectedContents: string): void {
  try {
    ensureJobsDirectory();
    assertPrivatePath(pidFile(jobId), 'file');
    if (fs.readFileSync(pidFile(jobId), 'utf8') === expectedContents) fs.unlinkSync(pidFile(jobId));
  } catch { /* ignore */ }
}
function readJobOwner(jobId: string): { owner: JobOwner; contents: string } {
  ensureJobsDirectory();
  assertPrivatePath(pidFile(jobId), 'file');
  const contents = fs.readFileSync(pidFile(jobId), 'utf8');
  const owner = JSON.parse(contents) as Partial<JobOwner>;
  if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.processIdentity !== 'string') {
    throw new Error('Invalid job owner');
  }
  return { owner: owner as JobOwner, contents };
}

async function withJobOwner<T>(jobId: string | undefined, operation: () => Promise<T>): Promise<T> {
  if (!jobId) return operation();
  ensureJobsDirectory();
  if (cancellationRequested(jobId)) throw new Error('Job cancelled');
  const ownerContents = writePid(jobId);
  try {
    if (cancellationRequested(jobId)) throw new Error('Job cancelled');
    return await operation();
  } finally {
    clearPid(jobId, ownerContents);
  }
}

async function waitForOwnerExit(owner: JobOwner): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readProcessIdentity(owner.pid) !== owner.processIdentity) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readProcessIdentity(owner.pid) !== owner.processIdentity;
}

// When cancelled, kill our yt-dlp children and exit. The separate cancel invocation
// waits for this process to exit before acknowledging cancellation.
process.on('SIGTERM', () => { killActive(); process.exit(0); });

// Open a folder in the OS file manager. Under WSL we hand a Windows path to Explorer
// via its ABSOLUTE path — the native-messaging host is launched with a stripped PATH
// that often lacks the Windows interop dirs, so a bare `explorer.exe` silently fails
// (that was the "folder button does nothing" bug). macOS uses `open`, Linux `xdg-open`.
function openInFileManager(target: string): void {
  try {
    if (IS_WSL) {
      const winPath = /^[A-Za-z]:/.test(target) ? target : wslToWindowsPath(target);
      const exe = fs.existsSync('/mnt/c/Windows/explorer.exe') ? '/mnt/c/Windows/explorer.exe' : 'explorer.exe';
      spawn(exe, [winPath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* best-effort — never crash the host over an open request */ }
}

readMessages(async (raw) => {
  const req = raw as Record<string, unknown>;

  if (req.action === 'ping') {
    // Report the OS-resolved default save folder so the extension can seed it on
    // first run instead of shipping a hardcoded Windows username/path.
    const platform = IS_WSL ? 'wsl' : process.platform;
    writeMessage({ ok: true, status: 'ok', version: HELPER_VERSION, platform, defaultRoot: defaultOutputRoot() });
    return;
  }

  if (req.action === 'cancel') {
    if (!isValidJobId(req.jobId)) {
      writeMessage({ ok: false, status: 'failed', error: 'Invalid job ID' });
      return;
    }
    const jobId = req.jobId;
    try {
      recordCancellation(jobId);
      const { owner, contents } = readJobOwner(jobId);
      if (readProcessIdentity(owner.pid) !== owner.processIdentity) {
        clearPid(jobId, contents);
        writeMessage({ ok: true, status: 'cancelled' });
        return;
      }
      process.kill(owner.pid, 'SIGTERM');
      if (!(await waitForOwnerExit(owner))) throw new Error('Job owner did not exit');
      clearPid(jobId, contents);
      writeMessage({ ok: true, status: 'cancelled' });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        writeMessage({ ok: true, status: 'cancellation_pending' });
      } else {
        writeMessage({ ok: false, status: 'failed', error: 'Job cancellation failed' });
      }
    }
    return;
  }

  if (req.action === 'cancel_finalize') {
    if (!isValidJobId(req.jobId)) {
      writeMessage({ ok: false, status: 'failed', error: 'Invalid job ID' });
      return;
    }
    try {
      clearCancellation(req.jobId);
      writeMessage({ ok: true, status: 'ok' });
    } catch {
      writeMessage({ ok: false, status: 'failed', error: 'Cancellation cleanup failed' });
    }
    return;
  }

  if (req.action === 'open_folder') {
    const target = (req.windowsPath ?? req.path) as string;
    if (typeof target === 'string' && target) openInFileManager(target);
    writeMessage({ ok: true, status: 'ok' });
    return;
  }

  if (req.action === 'diagnostics') {
    const res = await handle({ action: 'diagnostics', url: '' });
    writeMessage(res);
    return;
  }

  // Lazy per-video sizing/titling for the serial queue (size respects components).
  if (req.action === 'probe') {
    const url = req.url as string;
    if (!isValidYouTubeUrl(url)) { writeMessage({ ok: false, status: 'failed', error: 'Invalid URL' }); return; }
    if (req.jobId !== undefined && !isValidJobId(req.jobId)) {
      writeMessage({ ok: false, status: 'failed', error: 'Invalid job ID' });
      return;
    }
    try {
      const p = await withJobOwner(req.jobId, () => probeVideo(url, req.components as DownloadComponents | undefined));
      writeMessage({ ok: true, status: 'ok', title: p.title, bytes: p.bytes, duration: p.duration, views: p.views });
    } catch (error) {
      writeMessage({ ok: false, status: 'failed', error: error instanceof Error ? error.message : 'Probe failed' });
    }
    return;
  }

  // Write the per-batch overview .txt once a playlist/channel batch finishes.
  if (req.action === 'batch_summary') {
    const rawRoot = (req.options as { outputRoot?: string } | undefined)?.outputRoot;
    const items = (req.items as BatchSummaryItem[]) ?? [];
    writeMessage(createBatchSummary(
      rawRoot,
      req.batchId as string,
      req.batchLabel as string,
      req.category as string | undefined,
      items,
      undefined,
      undefined,
      req.allowDateNamedLegacySummary === true,
    ));
    return;
  }

  if (req.action === 'batch_summary_finalize') {
    writeMessage(removeBatchSummaryReceipt(req.batchId as string));
    return;
  }

  // Flat-list a playlist/channel URL into per-video items (for batch expansion).
  if (req.action === 'list_videos') {
    const url = req.url as string;
    if (!isValidYouTubeUrl(url)) { writeMessage({ ok: false, status: 'failed', error: 'Invalid URL' }); return; }
    const videos = await listVideos(url);
    writeMessage({ ok: true, status: 'ok', videos });
    return;
  }

  const action = req.action as Action;

  if (!ALLOWED_ACTIONS.includes(action)) {
    writeMessage({ ok: false, status: 'failed', error: `Unknown action: ${action}` });
    return;
  }

  // Validate every target (single url, or a list of scraped/channel urls)
  const targets = Array.isArray(req.urls) && req.urls.length
    ? (req.urls as string[])
    : [req.url as string];

  if (targets.length === 0 || !targets.every(isValidYouTubeUrl)) {
    writeMessage({ ok: false, status: 'failed', error: 'Invalid or unsupported YouTube URL' });
    return;
  }

  if (req.jobId !== undefined && !isValidJobId(req.jobId)) {
    writeMessage({ ok: false, status: 'failed', error: 'Invalid job ID' });
    return;
  }
  const jobId = req.jobId;
  try {
    const res = await withJobOwner(jobId, () => handle(req as unknown as DownloadRequest));
    writeMessage(res);
  } catch (error) {
    writeMessage({ ok: false, status: 'failed', error: error instanceof Error ? error.message : 'Download failed' });
  }
});
