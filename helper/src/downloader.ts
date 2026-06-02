import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { wslToWindowsPath, windowsToWslPath } from './sanitize';

const DEFAULT_OUTPUT_ROOT = '/mnt/c/Users/natha/Videos/Youtube Downloads';

export type VideoQuality = 'best' | '1080' | '720' | '480' | '360';
export type VideoFormat = 'mp4' | 'webm' | 'mkv';
export type AudioFormat = 'm4a' | 'mp3' | 'wav' | 'opus';

export interface DownloadComponents {
  video?: { quality: VideoQuality; format: VideoFormat };
  audio?: { format: AudioFormat };
  metadata?: boolean;
  thumbnail?: boolean;
}

export type Action =
  | 'custom'
  | 'channel_plan'
  | 'download_best'
  | 'download_audio'
  | 'download_thumbnail'
  | 'download_metadata'
  | 'archive_bundle'
  | 'diagnostics';

export type ChannelMode = 'popular_alltime' | 'popular_recent' | 'latest' | 'all';

export interface DownloadRequest {
  action: Action;
  url: string;
  urls?: string[];        // multiple targets (e.g. ranked "most popular" videos)
  components?: DownloadComponents;
  playlist?: boolean;
  expand?: boolean;       // let yt-dlp expand a channel/playlist URL (no --no-playlist)
  playlistEnd?: number;   // cap expansion to the first N entries (e.g. "latest 10")
  mode?: ChannelMode;     // channel_plan: how to choose videos
  count?: number;         // channel_plan: how many videos
  options?: {
    outputRoot?: string;
  };
}

// One video in a channel_plan — drives the per-video selection modal + jobs.
export interface PlanItem {
  url: string;                // watch URL
  title: string;              // video title ('' if unknown)
  bytes: number | null;       // approx size, or null when sized lazily (mode "all")
}

// Result of a channel_plan: what would be downloaded and roughly how big.
export interface ChannelPlan {
  totalVideos: number | null; // total uploads on the channel (null when not counted)
  items: PlanItem[];          // per-video list (url + title + size) for selection
  estBytes: number | null;    // projected total download size, or null if unknown
  sampled: boolean;           // true when estBytes was extrapolated from a sample (mode "all")
  mode: ChannelMode;
}

export interface DownloadResult {
  ok: boolean;
  status: string;
  folderPath?: string;
  windowsFolderPath?: string;
  error?: string;
  warnings?: string[];
  diagnostics?: Record<string, string | null>;
  plan?: ChannelPlan;
  // probe
  title?: string;
  bytes?: number | null;
  duration?: number | null;
  // list_videos
  videos?: PlanItem[];
}

// Track running yt-dlp children so a cancel request can kill the whole tree.
const activeChildren = new Set<ReturnType<typeof spawn>>();

export function killActive(): void {
  for (const proc of activeChildren) {
    try {
      // Children are spawned detached (own process group); -pid kills the group
      // so yt-dlp AND any ffmpeg it spawned die together.
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  activeChildren.clear();
}

function run(cmd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    activeChildren.add(proc);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code) => { activeChildren.delete(proc); resolve({ out, err, code: code ?? 1 }); });
    proc.on('error', () => { activeChildren.delete(proc); resolve({ out, err: 'spawn failed', code: 1 }); });
  });
}

function folderTemplate(root: string): string {
  return path.join(root, '%(uploader)s', '%(upload_date>%Y-%m-%d)s - %(title)s [%(id)s]');
}

function playlistTemplate(root: string): string {
  return path.join(root, '%(uploader)s', 'Playlists', '%(playlist_title)s', '%(playlist_index)02d - %(title)s [%(id)s]');
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

// Strip yt-dlp template variables so we return a real path to the user.
// e.g. /mnt/c/.../%(uploader)s/... → /mnt/c/...
function resolvedFolder(templatePath: string): string {
  const idx = templatePath.indexOf('%(');
  const real = idx === -1 ? templatePath : templatePath.slice(0, idx);
  return real.replace(/[/\\]+$/, '');
}

function videoFormatFlag(quality: VideoQuality): string {
  if (quality === 'best') return 'bv*+ba/b';
  return `bv*[height<=${quality}]+ba/b[height<=${quality}]`;
}

// ── Channel ranking (for the "popular/latest/all" channel button) ─────────────

// Run `fn` over `items` with at most `limit` in flight (keeps us under YouTube's
// rate limit while still being much faster than serial extraction).
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      res[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return res;
}

// Fast: list every video on a channel/playlist (id + title, no size). Optional cap.
// One yt-dlp call total — titles come free from the flat listing.
async function flatList(channelUrl: string, limit?: number): Promise<{ id: string; title: string }[]> {
  const args = ['--flat-playlist', '--print', '%(id)s\t%(title)s'];
  if (limit && limit > 0) args.push('--playlist-end', String(limit));
  args.push(channelUrl);
  const { out, code } = await run('yt-dlp', args);
  if (code !== 0) return [];
  return out.split('\n')
    .map((line) => {
      const tab = line.indexOf('\t');
      const id = (tab === -1 ? line : line.slice(0, tab)).trim();
      const title = tab === -1 ? '' : line.slice(tab + 1).trim();
      return { id, title };
    })
    .filter((x) => /^[\w-]{8,}$/.test(x.id));
}

// One extraction per video → view count + approximate size + title (best format).
async function fetchVideoMeta(id: string): Promise<{ views: number; bytes: number; title: string }> {
  const { out, code } = await run('yt-dlp', [
    '--no-warnings', '--skip-download',
    '--print', '%(view_count)s\t%(filesize_approx)s\t%(title)s',
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  if (code !== 0) return { views: -1, bytes: 0, title: '' };
  const parts = out.trim().split('\t');
  const views = parseInt(parts[0], 10);
  const bytes = parseInt(parts[1], 10);
  const title = parts.slice(2).join('\t');
  return { views: Number.isFinite(views) ? views : -1, bytes: Number.isFinite(bytes) ? bytes : 0, title: title || '' };
}

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// "popular_recent" only ranks this many of the newest uploads — bounds the
// per-video fetches so we never hit YouTube's rate limit.
const RECENT_POOL = 100;

function videoIdOf(u: string): string | null {
  try { return new URL(u).searchParams.get('v'); } catch { return null; }
}

async function channelPlan(req: DownloadRequest): Promise<ChannelPlan> {
  const mode: ChannelMode = req.mode ?? 'popular_recent';
  const count = req.count && req.count > 0 ? req.count : 10;
  const channelUrl = (req.urls && req.urls[0]) || req.url;

  // All-time popular: the extension already read the URLs off YouTube's
  // Popular-sorted page (YouTube did the ranking). We only size + title them.
  if (mode === 'popular_alltime') {
    const ids = (req.urls ?? []).map(videoIdOf).filter((x): x is string => !!x).slice(0, count);
    const metas = await mapLimit(ids, 4, fetchVideoMeta);
    const items: PlanItem[] = ids.map((id, i) => ({
      url: watchUrl(id), title: metas[i].title, bytes: metas[i].bytes > 0 ? metas[i].bytes : null,
    }));
    return { totalVideos: null, items, estBytes: sumBytes(items) || null, sampled: false, mode };
  }

  if (mode === 'all') {
    // Flat-list everything (titles free), but size lazily per-video at download
    // time. Show an extrapolated total from a small sample so the modal isn't blank.
    const vids = await flatList(channelUrl);
    const metas = await mapLimit(vids.slice(0, 8).map((v) => v.id), 4, fetchVideoMeta);
    const sizes = metas.map((m) => m.bytes).filter((b) => b > 0);
    const avg = sizes.length ? sum(sizes) / sizes.length : 0;
    const items: PlanItem[] = vids.map((v) => ({ url: watchUrl(v.id), title: v.title, bytes: null }));
    return { totalVideos: vids.length, items, estBytes: avg ? Math.round(avg * vids.length) : null, sampled: true, mode };
  }

  if (mode === 'latest') {
    const vids = (await flatList(channelUrl, count)).slice(0, count);
    const metas = await mapLimit(vids.map((v) => v.id), 4, fetchVideoMeta);
    const items: PlanItem[] = vids.map((v, i) => ({
      url: watchUrl(v.id), title: v.title || metas[i].title, bytes: metas[i].bytes > 0 ? metas[i].bytes : null,
    }));
    return { totalVideos: null, items, estBytes: sumBytes(items) || null, sampled: false, mode };
  }

  // popular_recent: rank only the newest RECENT_POOL uploads by view count.
  const vids = await flatList(channelUrl, RECENT_POOL);
  const metas = await mapLimit(vids.map((v) => v.id), 4, fetchVideoMeta);
  const ranked = vids
    .map((v, i) => ({ ...v, ...metas[i] }))
    .filter((x) => x.views >= 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, count);
  const items: PlanItem[] = ranked.map((x) => ({
    url: watchUrl(x.id), title: x.title, bytes: x.bytes > 0 ? x.bytes : null,
  }));
  return { totalVideos: vids.length, items, estBytes: sumBytes(items) || null, sampled: false, mode };
}

const sumBytes = (items: PlanItem[]) => sum(items.map((i) => i.bytes ?? 0));

// Single-video probe: title + approx size + duration, for lazy sizing in the queue.
export async function probeVideo(url: string): Promise<{ title: string; bytes: number | null; duration: number | null }> {
  const { out, code } = await run('yt-dlp', [
    '--no-warnings', '--skip-download',
    '--print', '%(title)s\t%(filesize_approx)s\t%(duration)s',
    url,
  ]);
  if (code !== 0) return { title: '', bytes: null, duration: null };
  const parts = out.trim().split('\t');
  const title = parts[0] || '';
  const bytes = parseInt(parts[1], 10);
  const duration = parseInt(parts[2], 10);
  return {
    title,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
    duration: Number.isFinite(duration) ? duration : null,
  };
}

// Flat list a playlist/channel URL into per-video items (id+title, size lazy).
export async function listVideos(url: string): Promise<PlanItem[]> {
  const vids = await flatList(url);
  return vids.map((v) => ({ url: watchUrl(v.id), title: v.title, bytes: null }));
}

export async function handle(req: DownloadRequest): Promise<DownloadResult> {
  const rawRoot = req.options?.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  // Accept Windows paths (C:\...) from extension storage; convert to WSL paths for yt-dlp
  const root = /^[A-Za-z]:/.test(rawRoot) ? windowsToWslPath(rawRoot) : rawRoot;
  ensureDir(root);

  const isPlaylist = !!req.playlist;
  const base = isPlaylist ? playlistTemplate(root) : folderTemplate(root);
  // Expand channel/playlist URLs when asked (or for the playlist button); otherwise
  // pin each URL to its own single video. Optionally cap expansion to the first N.
  const expand = isPlaylist || !!req.expand;
  const noPlaylistFlag = expand ? [] : ['--no-playlist'];
  const limitFlag = req.playlistEnd && req.playlistEnd > 0 ? ['--playlist-end', String(req.playlistEnd)] : [];
  // One or more targets: a single video, a list of scraped "popular" videos, or a channel URL.
  const targets = Array.isArray(req.urls) && req.urls.length ? req.urls : [req.url];

  switch (req.action) {
    case 'custom': {
      const comp = req.components ?? {};
      const hasVideo = !!comp.video;
      const hasAudio = !!comp.audio;
      const hasMeta = !!comp.metadata;
      const hasThumb = !!comp.thumbnail;

      if (!hasVideo && !hasAudio && !hasMeta && !hasThumb) {
        return { ok: false, status: 'failed', error: 'No components selected' };
      }

      const jobs: Promise<{ out: string; err: string; code: number }>[] = [];

      // Video download run (also carries thumbnail/metadata flags when applicable)
      if (hasVideo || hasMeta || hasThumb) {
        const args: string[] = [];

        if (hasVideo) {
          args.push('-f', videoFormatFlag(comp.video!.quality));
          args.push('--merge-output-format', comp.video!.format);
          args.push('-o', `${base}/video.%(ext)s`);
        } else {
          // metadata or thumbnail only — skip the actual video download
          args.push('--skip-download');
          args.push('-o', `${base}/%(title)s [%(id)s].%(ext)s`);
        }

        if (hasThumb) {
          args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
          // Always add the type-specific override so thumbnail lands at a predictable path
          args.push('-o', `thumbnail:${base}/thumbnail.%(ext)s`);
        }

        if (hasMeta) {
          args.push('--write-info-json', '--write-description');
          if (hasVideo) {
            args.push('-o', `description:${base}/description.%(ext)s`);
            args.push('-o', `infojson:${base}/metadata.%(ext)s`);
          }
        }

        args.push(...limitFlag, ...noPlaylistFlag, ...targets);
        jobs.push(run('yt-dlp', args));
      }

      // Separate audio extraction run (format conversion requires its own pass)
      if (hasAudio) {
        const args: string[] = [
          '-f', 'ba/b',
          '-x', '--audio-format', comp.audio!.format,
          '-o', `${base}/audio.%(ext)s`,
          ...limitFlag, ...noPlaylistFlag, ...targets,
        ];
        jobs.push(run('yt-dlp', args));
      }

      const results = await Promise.all(jobs);
      const failures = results.filter(r => r.code !== 0);

      if (failures.length === results.length) {
        // Everything failed
        return { ok: false, status: 'failed', error: failures[0].err.slice(-800) };
      }

      const folder = resolvedFolder(base);
      return {
        ok: true,
        status: 'complete',
        folderPath: folder,
        windowsFolderPath: wslToWindowsPath(folder),
        ...(failures.length > 0 && {
          warnings: failures.map(r => r.err.slice(-200)),
        }),
      };
    }

    case 'channel_plan': {
      const plan = await channelPlan(req);
      if (plan.items.length === 0) {
        return { ok: false, status: 'failed', error: 'Could not prepare videos (no data / rate-limited)' };
      }
      return { ok: true, status: 'ok', plan };
    }

    case 'download_best': {
      const { err, code } = await run('yt-dlp', [
        '-f', 'bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', `${base}/video.%(ext)s`,
        '--no-playlist',
        req.url,
      ]);
      return result(code, base, err);
    }

    case 'download_audio': {
      const { err, code } = await run('yt-dlp', [
        '-f', 'ba/b',
        '-x', '--audio-format', 'm4a',
        '-o', `${base}/audio.%(ext)s`,
        '--no-playlist',
        req.url,
      ]);
      return result(code, base, err);
    }

    case 'download_thumbnail': {
      const thumbRoot = path.join(root, '%(uploader)s', 'thumbnails');
      const { err, code } = await run('yt-dlp', [
        '--write-thumbnail',
        '--skip-download',
        '--convert-thumbnails', 'jpg',
        '-o', `${thumbRoot}/%(upload_date>%Y-%m-%d)s - %(title)s [%(id)s].%(ext)s`,
        '--no-playlist',
        req.url,
      ]);
      return result(code, thumbRoot, err);
    }

    case 'download_metadata': {
      const metaRoot = path.join(root, '%(uploader)s', 'metadata');
      const { err, code } = await run('yt-dlp', [
        '--write-info-json',
        '--write-description',
        '--skip-download',
        '-o', `${metaRoot}/%(upload_date>%Y-%m-%d)s - %(title)s [%(id)s].%(ext)s`,
        '--no-playlist',
        req.url,
      ]);
      return result(code, metaRoot, err);
    }

    case 'archive_bundle': {
      const { err, code } = await run('yt-dlp', [
        '-f', 'bv*+ba/b',
        '--merge-output-format', 'mp4',
        '--write-thumbnail', '--convert-thumbnails', 'jpg',
        '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*',
        '--write-info-json',
        '--write-description',
        '--write-url-link',
        '-o', `${base}/video.%(ext)s`,
        '-o', `thumbnail:${base}/thumbnail.%(ext)s`,
        '-o', `subtitle:${base}/subtitles/%(lang)s.%(ext)s`,
        '-o', `description:${base}/description.%(ext)s`,
        '-o', `infojson:${base}/metadata.%(ext)s`,
        '-o', `link:${base}/source.%(ext)s`,
        '--no-playlist',
        req.url,
      ]);
      return result(code, base, err);
    }

    case 'diagnostics': {
      const [ytdlp, ffmpeg] = await Promise.all([
        run('yt-dlp', ['--version']),
        run('ffmpeg', ['-version']),
      ]);
      return {
        ok: true,
        status: 'ok',
        diagnostics: {
          ytdlp: ytdlp.code === 0 ? ytdlp.out.trim() : null,
          ffmpeg: ffmpeg.code === 0 ? ffmpeg.out.split('\n')[0].trim() : null,
          outputRoot: root,
        },
      };
    }

    default:
      return { ok: false, status: 'failed', error: 'Unknown action' };
  }
}

function result(code: number, templatePath: string, stderr: string): DownloadResult {
  if (code !== 0) {
    return { ok: false, status: 'failed', error: stderr.slice(-800) };
  }
  const folder = resolvedFolder(templatePath);
  return {
    ok: true,
    status: 'complete',
    folderPath: folder,
    windowsFolderPath: wslToWindowsPath(folder),
  };
}
