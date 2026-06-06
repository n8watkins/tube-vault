import { readMessages, writeMessage } from './protocol';
import { handle, killActive, probeVideo, listVideos, writeBatchSummary, type DownloadRequest, type Action, type DownloadComponents, type BatchSummaryItem } from './downloader';
import { isValidYouTubeUrl, windowsToWslPath, wslToWindowsPath } from './sanitize';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

// A running download writes its node pid here keyed by jobId, so a separate
// `cancel` invocation can signal it. Lives in the shared WSL tmp dir.
const JOBS_DIR = path.join(os.tmpdir(), 'tube-vault-jobs');
const pidFile = (jobId: string) => path.join(JOBS_DIR, `${jobId}.pid`);

function writePid(jobId: string): void {
  try { fs.mkdirSync(JOBS_DIR, { recursive: true }); fs.writeFileSync(pidFile(jobId), String(process.pid)); } catch { /* ignore */ }
}
function clearPid(jobId: string): void {
  try { fs.unlinkSync(pidFile(jobId)); } catch { /* ignore */ }
}

// When cancelled, kill our yt-dlp children and exit. The pending sendNativeMessage
// in the service worker then resolves with a closed port → treated as cancelled.
process.on('SIGTERM', () => { killActive(); process.exit(0); });

// Running under WSL? (Windows kernel string + the distro env var Chrome's launcher keeps.)
const IS_WSL = os.release().toLowerCase().includes('microsoft') || !!process.env.WSL_DISTRO_NAME;

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
    writeMessage({ ok: true, status: 'ok', version: HELPER_VERSION });
    return;
  }

  if (req.action === 'cancel') {
    const jobId = req.jobId as string;
    try {
      const pid = parseInt(fs.readFileSync(pidFile(jobId), 'utf8'), 10);
      if (Number.isFinite(pid)) process.kill(pid, 'SIGTERM');
      clearPid(jobId);
      writeMessage({ ok: true, status: 'cancelled' });
    } catch {
      writeMessage({ ok: false, status: 'failed', error: 'Job not found or already finished' });
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
    const p = await probeVideo(url, req.components as DownloadComponents | undefined);
    writeMessage({ ok: true, status: 'ok', title: p.title, bytes: p.bytes, duration: p.duration, views: p.views });
    return;
  }

  // Write the per-batch overview .txt once a playlist/channel batch finishes.
  if (req.action === 'batch_summary') {
    const rawRoot = (req.options as { outputRoot?: string } | undefined)?.outputRoot ?? '';
    const root = /^[A-Za-z]:/.test(rawRoot) ? windowsToWslPath(rawRoot) : rawRoot;
    const items = (req.items as BatchSummaryItem[]) ?? [];
    const winPath = root ? writeBatchSummary(root, req.batchLabel as string, req.category as string | undefined, items) : '';
    writeMessage({ ok: true, status: 'ok', summaryPath: winPath });
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

  const jobId = typeof req.jobId === 'string' ? req.jobId : undefined;
  if (jobId) writePid(jobId);
  try {
    const res = await handle(req as unknown as DownloadRequest);
    writeMessage(res);
  } finally {
    if (jobId) clearPid(jobId);
  }
});
