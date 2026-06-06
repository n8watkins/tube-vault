import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { wslToWindowsPath, windowsToWslPath, sanitizeFilename } from './sanitize';

const DEFAULT_OUTPUT_ROOT = '/mnt/c/Users/natha/Videos/Youtube Downloads';

export type VideoQuality = 'best' | '1080' | '720' | '480' | '360';
export type VideoFormat = 'mp4' | 'webm' | 'mkv';
export type AudioFormat = 'm4a' | 'mp3' | 'wav' | 'opus';

export interface DownloadComponents {
  video?: { quality: VideoQuality; format: VideoFormat };
  audio?: { format: AudioFormat };
  metadata?: boolean;
  thumbnail?: boolean;
  subtitles?: boolean;
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

// Curated file-naming / folder-layout toggles (mirrors the extension type).
export interface NamingOptions {
  titleFiles: boolean;      // <Title>.<ext> vs generic video/audio/thumbnail
  summaryTxt: boolean;      // write <Title>.txt summary beside the files
  categoryFolders: boolean; // insert Most Popular / Latest / Playlist level
  numbering: boolean;       // "001 - " rank prefix on batch folders
  includeId: boolean;       // keep " [videoId]" suffix on folder name
}

const DEFAULT_NAMING: NamingOptions = {
  titleFiles: true, summaryTxt: true, categoryFolders: true, numbering: true, includeId: true,
};

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
  index?: number;         // 1-based rank within the selected batch (for numbering)
  total?: number;         // size of the selected batch (numbering pad width)
  category?: string;      // 'Most Popular' | 'Latest' | 'Playlist' (batches only)
  options?: {
    outputRoot?: string;
    naming?: NamingOptions;
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
  playlistTitle?: string;     // playlist/mix name (mode "all"), for label + folder
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

// Folder-per-video directory template for the `custom` (queue) path, composed from
// the user's naming toggles:
//   root / %(uploader)s / [<Category>/] / [<NNN> - ]%(title)s[ [%(id)s]]
// The rank prefix is computed in JS (one URL per call → no %(playlist_index)s).
export function buildBase(root: string, req: DownloadRequest, naming: NamingOptions): string {
  const parts = [root, '%(uploader)s'];
  if (naming.categoryFolders && req.category) parts.push(sanitizeFilename(req.category));

  let leaf = '';
  if (naming.numbering && req.index) {
    const width = Math.max(3, String(req.total ?? 0).length);
    leaf += `${String(req.index).padStart(width, '0')} - `;
  }
  leaf += '%(title)s';
  if (naming.includeId) leaf += ' [%(id)s]';
  parts.push(leaf);
  return path.join(...parts);
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

export function videoFormatFlag(quality: VideoQuality): string {
  if (quality === 'best') return 'bv*+ba/b';
  return `bv*[height<=${quality}]+ba/b[height<=${quality}]`;
}

// ── Component-aware size estimation ───────────────────────────────────────────
// The download size depends on WHAT you grab. Pick the yt-dlp format selector for
// the heaviest selected media so filesize_approx reflects reality (audio-only is
// far smaller than video; thumbnail/metadata-only is negligible).
export function mediaFormatFlag(c?: DownloadComponents): string | null {
  if (c?.video) return videoFormatFlag(c.video.quality);
  if (c?.audio) return 'ba/b';
  return null; // only thumbnail/metadata → no media stream
}
// Rough size of the sidecar files (so a thumbnail/metadata-only job isn't "0").
function sidecarBytes(c?: DownloadComponents): number {
  let b = 0;
  if (c?.thumbnail) b += 120_000;  // ~120 KB jpg
  if (c?.metadata) b += 100_000;   // info.json + description
  if (c?.subtitles) b += 50_000;   // ~50 KB srt
  return b;
}
// Total approx size for one video given the selected components. `approx` is the
// filesize_approx yt-dlp reported for the chosen format (0 if none/unknown).
export function sizeForComponents(approx: number, c?: DownloadComponents): number {
  if (!c) return approx;                    // legacy callers: full approx
  if (mediaFormatFlag(c)) return approx + sidecarBytes(c);
  return sidecarBytes(c);                    // thumbnail/metadata only
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
  args.push('--', channelUrl);
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

// One extraction per video → view count + approximate size + title. The size is
// computed for the SELECTED components (video format / audio-only / sidecars),
// not always the full video — so the confirmation estimate matches what you grab.
async function fetchVideoMeta(id: string, components?: DownloadComponents): Promise<{ views: number; bytes: number; title: string }> {
  const fmt = components ? mediaFormatFlag(components) : null;
  const args = ['--no-warnings', '--skip-download'];
  if (fmt) args.push('-f', fmt);
  args.push('--print', '%(view_count)s\t%(filesize_approx)s\t%(title)s', '--', `https://www.youtube.com/watch?v=${id}`);
  const { out, code } = await run('yt-dlp', args);
  if (code !== 0) return { views: -1, bytes: 0, title: '' };
  const parts = out.trim().split('\t');
  const views = parseInt(parts[0], 10);
  const approx = parseInt(parts[1], 10);
  const title = parts.slice(2).join('\t');
  const bytes = sizeForComponents(Number.isFinite(approx) ? approx : 0, components);
  return { views: Number.isFinite(views) ? views : -1, bytes, title: title || '' };
}

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// "popular_recent" only ranks this many of the newest uploads — bounds the
// per-video fetches so we never hit YouTube's rate limit.
const RECENT_POOL = 100;

function videoIdOf(u: string): string | null {
  try { return new URL(u).searchParams.get('v'); } catch { return null; }
}

// The playlist/mix name (e.g. "Radical Optimism Tour Setlist", "Mix - Dua Lipa").
// One fast call (first entry only). Empty string if not a named playlist.
async function fetchPlaylistTitle(url: string): Promise<string> {
  const { out, code } = await run('yt-dlp', ['--no-warnings', '--flat-playlist', '--playlist-end', '1', '--print', '%(playlist_title)s', '--', url]);
  if (code !== 0) return '';
  const t = out.split('\n').map((s) => s.trim()).find((s) => s && s !== 'NA');
  return t ?? '';
}

async function channelPlan(req: DownloadRequest): Promise<ChannelPlan> {
  const mode: ChannelMode = req.mode ?? 'popular_recent';
  const count = req.count && req.count > 0 ? req.count : 10;
  const channelUrl = (req.urls && req.urls[0]) || req.url;
  const comp = req.components;  // size estimate respects what the user selected
  const meta = (id: string) => fetchVideoMeta(id, comp);

  // All-time popular: the extension already read the URLs off YouTube's
  // Popular-sorted page (YouTube did the ranking). We only size + title them.
  if (mode === 'popular_alltime') {
    const ids = (req.urls ?? []).map(videoIdOf).filter((x): x is string => !!x).slice(0, count);
    const metas = await mapLimit(ids, 4, meta);
    const items: PlanItem[] = ids.map((id, i) => ({
      url: watchUrl(id), title: metas[i].title, bytes: metas[i].bytes > 0 ? metas[i].bytes : null,
    }));
    return { totalVideos: null, items, estBytes: sumBytes(items) || null, sampled: false, mode };
  }

  if (mode === 'all') {
    // Flat-list everything (titles free), but size lazily per-video at download
    // time. Show an extrapolated total from a small sample so the modal isn't blank.
    const [vids, playlistTitle] = await Promise.all([flatList(channelUrl), fetchPlaylistTitle(channelUrl)]);
    const metas = await mapLimit(vids.slice(0, 8).map((v) => v.id), 4, meta);
    const sizes = metas.map((m) => m.bytes).filter((b) => b > 0);
    const avg = sizes.length ? sum(sizes) / sizes.length : 0;
    const items: PlanItem[] = vids.map((v) => ({ url: watchUrl(v.id), title: v.title, bytes: null }));
    return { totalVideos: vids.length, items, estBytes: avg ? Math.round(avg * vids.length) : null, sampled: true, mode, playlistTitle };
  }

  if (mode === 'latest') {
    const vids = (await flatList(channelUrl, count)).slice(0, count);
    const metas = await mapLimit(vids.map((v) => v.id), 4, meta);
    const items: PlanItem[] = vids.map((v, i) => ({
      url: watchUrl(v.id), title: v.title || metas[i].title, bytes: metas[i].bytes > 0 ? metas[i].bytes : null,
    }));
    return { totalVideos: null, items, estBytes: sumBytes(items) || null, sampled: false, mode };
  }

  // popular_recent: rank only the newest RECENT_POOL uploads by view count.
  const vids = await flatList(channelUrl, RECENT_POOL);
  const metas = await mapLimit(vids.map((v) => v.id), 4, meta);
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
// Size respects the selected components (matches the confirmation estimate).
export async function probeVideo(url: string, components?: DownloadComponents): Promise<{ title: string; bytes: number | null; duration: number | null }> {
  const fmt = components ? mediaFormatFlag(components) : null;
  const args = ['--no-warnings', '--skip-download'];
  if (fmt) args.push('-f', fmt);
  args.push('--print', '%(title)s\t%(filesize_approx)s\t%(duration)s', '--', url);
  const { out, code } = await run('yt-dlp', args);
  if (code !== 0) return { title: '', bytes: null, duration: null };
  const parts = out.trim().split('\t');
  const title = parts[0] || '';
  const approx = parseInt(parts[1], 10);
  const duration = parseInt(parts[2], 10);
  const bytes = sizeForComponents(Number.isFinite(approx) ? approx : 0, components);
  return {
    title,
    bytes: bytes > 0 ? bytes : null,
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
      const hasSubs = !!comp.subtitles;

      if (!hasVideo && !hasAudio && !hasMeta && !hasThumb && !hasSubs) {
        return { ok: false, status: 'failed', error: 'No components selected' };
      }

      const naming = req.options?.naming ?? DEFAULT_NAMING;
      const customBase = buildBase(root, req, naming);
      // File basename per component: by title (distinct extensions avoid collisions)
      // or the legacy generic name.
      const fileName = (generic: string) => (naming.titleFiles ? '%(title)s' : generic);
      // One tab-separated capture line per run: filepath first (paths don't contain
      // tabs), then the metadata we need for the summary. after_move waits until the
      // file is on disk so filepath is exact; the plain variant covers skip-download.
      const CAPTURE = '%(filepath)s\t%(title)s\t%(uploader)s\t%(upload_date)s\t%(view_count)s\t%(duration)s\t%(id)s';

      const jobs: Promise<{ out: string; err: string; code: number }>[] = [];

      // Video download run (also carries thumbnail/metadata/subtitle flags when applicable)
      if (hasVideo || hasMeta || hasThumb || hasSubs) {
        const args: string[] = [];

        if (hasVideo) {
          args.push('-f', videoFormatFlag(comp.video!.quality));
          args.push('--merge-output-format', comp.video!.format);
          args.push('-o', `${customBase}/${fileName('video')}.%(ext)s`);
          args.push('--print', `after_move:${CAPTURE}`);
        } else {
          // metadata or thumbnail only — skip the media but still write the sidecars.
          // CRITICAL: a plain --print implies --simulate (writes nothing) AND --quiet
          // (hides the "Writing … to:" paths we use to find the folder). Force both off.
          args.push('--skip-download', '--no-simulate', '--no-quiet');
          args.push('-o', `${customBase}/${naming.titleFiles ? '%(title)s' : '%(title)s [%(id)s]'}.%(ext)s`);
          args.push('--print', CAPTURE);
        }

        if (hasThumb) {
          args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
          // Always add the type-specific override so thumbnail lands at a predictable path
          args.push('-o', `thumbnail:${customBase}/${fileName('thumbnail')}.%(ext)s`);
        }

        if (hasMeta) {
          args.push('--write-info-json', '--write-description');
          if (hasVideo) {
            args.push('-o', `description:${customBase}/${fileName('description')}.%(ext)s`);
            args.push('-o', `infojson:${customBase}/${fileName('metadata')}.%(ext)s`);
          }
        }

        if (hasSubs) {
          // English subtitles (uploaded + auto-generated), converted to .srt.
          args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en.*', '--convert-subs', 'srt');
          args.push('-o', `subtitle:${customBase}/${fileName('subtitles')}.%(ext)s`);
        }

        args.push(...limitFlag, ...noPlaylistFlag, '--', ...targets);
        jobs.push(run('yt-dlp', args));
      }

      // Separate audio extraction run (format conversion requires its own pass)
      if (hasAudio) {
        const args: string[] = [
          '-f', 'ba/b',
          '-x', '--audio-format', comp.audio!.format,
          '-o', `${customBase}/${fileName('audio')}.%(ext)s`,
          '--print', `after_move:${CAPTURE}`,
          ...limitFlag, ...noPlaylistFlag, '--', ...targets,
        ];
        jobs.push(run('yt-dlp', args));
      }

      const results = await Promise.all(jobs);
      const failures = results.filter(r => r.code !== 0);

      if (failures.length === results.length) {
        // Everything failed
        return { ok: false, status: 'failed', error: failures[0].err.slice(-800) };
      }

      // Recover the REAL per-video folder (+ metadata) from the capture lines. Prefer
      // a line whose file actually exists on disk (a downloaded media file).
      const cap = parseCapture(results);
      const folder = cap.folder || resolvedFolder(customBase);

      // Write the per-video summary whenever we recovered the real folder (works for
      // thumbnail/metadata-only, where no media file survives to name it after).
      if (naming.summaryTxt && cap.folder) {
        writeSummary(cap.folder, cap.mediaPath, req, cap.meta);
      }

      return {
        ok: true,
        status: 'complete',
        folderPath: folder,
        windowsFolderPath: wslToWindowsPath(folder),
        bytes: folderSize(folder) || null,  // real on-disk size for History
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
        '--', req.url,
      ]);
      return result(code, base, err);
    }

    case 'download_audio': {
      const { err, code } = await run('yt-dlp', [
        '-f', 'ba/b',
        '-x', '--audio-format', 'm4a',
        '-o', `${base}/audio.%(ext)s`,
        '--no-playlist',
        '--', req.url,
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
        '--', req.url,
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
        '--', req.url,
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
        '--', req.url,
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

export interface CaptureMeta { title: string; uploader: string; uploadDate: string; views: string; duration: string; id: string; }

// Pull the per-video folder + metadata out of the download runs' output.
// Capture line (`--print`): `filepath\ttitle\tuploader\tupload_date\tviews\tduration\tid`.
// On a media download `filepath` is real; on thumbnail/metadata-only (--skip-download)
// it's `NA`, so we still take the metadata from that line and recover the folder from
// yt-dlp's own "Writing … to:" / "Destination:" lines (which name the sidecar files).
export function parseCapture(results: { out: string; err: string }[]): { folder: string; mediaPath: string; meta: CaptureMeta } {
  let folder = '';
  let mediaPath = '';
  let meta: CaptureMeta = { title: '', uploader: '', uploadDate: '', views: '', duration: '', id: '' };

  // 1) Tab-separated --print lines: always carry metadata; filepath only when media ran.
  for (const r of results) {
    for (const raw of r.out.split('\n')) {
      const line = raw.trim();
      if (!line || !line.includes('\t')) continue;
      const f = line.split('\t');
      if (f.length >= 7 && !meta.id) {
        meta = { title: f[1], uploader: f[2], uploadDate: f[3], views: f[4], duration: f[5], id: f[6] };
      }
      const fp = f[0];
      if (fp && fp.includes('/') && fp !== 'NA') {
        if (!folder) folder = path.dirname(fp);
        if (fs.existsSync(fp)) { mediaPath = fp; folder = path.dirname(fp); }
      }
    }
  }

  // 2) Fallback (skip-download): recover the folder from yt-dlp's "Writing … to:" /
  //    "Destination:" lines. Use the DIRECTORY (exists even when the thumbnail's
  //    original .webp was converted to .jpg and deleted); only set mediaPath when
  //    the named file itself survives (for the per-video summary's name).
  if (!folder || !mediaPath) {
    for (const r of results) {
      for (const raw of (r.out + '\n' + r.err).split('\n')) {
        const m = raw.match(/(?:Destination:|\bto:)\s+(.+?)\s*$/);
        if (!m) continue;
        const p = m[1].trim();
        if (!p.includes('/')) continue;
        const dir = path.dirname(p);
        if (!folder && fs.existsSync(dir)) folder = dir;
        if (!mediaPath && fs.existsSync(p)) mediaPath = p;
      }
    }
  }
  return { folder, mediaPath, meta };
}

// Sum of file sizes directly in a folder — the real on-disk size of one download.
function folderSize(dir: string): number {
  try {
    return fs.readdirSync(dir).reduce((s, f) => {
      try { const st = fs.statSync(path.join(dir, f)); return s + (st.isFile() ? st.size : 0); } catch { return s; }
    }, 0);
  } catch { return 0; }
}

function fmtDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d && d !== 'NA' ? d : '—');
}
function fmtViews(v: string): string {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n.toLocaleString() : '—';
}
function fmtDuration(d: string): string {
  const s = parseInt(d, 10);
  if (!Number.isFinite(s)) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Write the human-readable <Title>.txt summary beside the saved files. Best-effort.
function writeSummary(folder: string, mediaPath: string, req: DownloadRequest, meta: CaptureMeta): void {
  try {
    let saved: string[] = [];
    try { saved = fs.readdirSync(folder); } catch { /* ignore */ }
    // Name the .txt after the media file if one survived; otherwise after any saved
    // file (e.g. the thumbnail .jpg), then the title, then a generic fallback.
    const firstFile = saved.find((f) => !f.endsWith('.txt'));
    const base = mediaPath
      ? path.basename(mediaPath, path.extname(mediaPath))
      : (firstFile ? path.basename(firstFile, path.extname(firstFile)) : (sanitizeFilename(meta.title) || 'download'));
    const txtName = `${base}.txt`;
    saved = saved.filter((f) => f !== txtName);
    const collection = req.category
      ? `${req.category}${req.index && req.total ? ` — #${req.index} of ${req.total}` : ''}`
      : 'Single video';
    const url = meta.id && meta.id !== 'NA' ? `https://www.youtube.com/watch?v=${meta.id}` : req.url;
    const lines = [
      meta.title && meta.title !== 'NA' ? meta.title : base,
      '─'.repeat(44),
      `Channel:     ${meta.uploader && meta.uploader !== 'NA' ? meta.uploader : '—'}`,
      `Published:   ${fmtDate(meta.uploadDate)}`,
      `Views:       ${fmtViews(meta.views)}`,
      `Duration:    ${fmtDuration(meta.duration)}`,
      `URL:         ${url}`,
      `Collection:  ${collection}`,
      `Downloaded:  ${new Date().toLocaleString()}`,
      '',
      'Files:',
      ...saved.map((f) => `  • ${f}`),
      '',
      `Folder: ${wslToWindowsPath(folder)}`,
    ];
    fs.writeFileSync(path.join(folder, txtName), lines.join('\n') + '\n', 'utf8');
  } catch { /* best-effort — never fail the download over the summary */ }
}

export interface BatchSummaryItem { title: string; folder?: string; status: string; }

// One overview .txt per playlist/channel download, listing every video + where it
// landed. Written under <root>/TubeVault Summaries/. Returns the Windows path.
export function writeBatchSummary(
  root: string,
  batchLabel: string,
  category: string | undefined,
  items: BatchSummaryItem[],
): string {
  const dir = path.join(root, 'TubeVault Summaries');
  ensureDir(dir);
  const stamp = new Date();
  const dateSlug = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`;
  const fileBase = sanitizeFilename(batchLabel || 'Download') || 'Download';
  const file = path.join(dir, `${fileBase} - ${dateSlug}.txt`);

  const done = items.filter((i) => i.status === 'done').length;
  const lines = [
    batchLabel || 'TubeVault download',
    '═'.repeat(48),
    `Type:        ${category || 'Batch'}`,
    `Downloaded:  ${stamp.toLocaleString()}`,
    `Videos:      ${done} of ${items.length} completed`,
    '',
    'Items:',
  ];
  items.forEach((it, i) => {
    const n = String(i + 1).padStart(Math.max(3, String(items.length).length), '0');
    const mark = it.status === 'done' ? '✓' : it.status === 'failed' ? '✗' : it.status === 'cancelled' ? '⊘' : '·';
    lines.push(`  ${n} ${mark} ${it.title}`);
    if (it.folder) lines.push(`        → ${it.folder}`);
  });
  lines.push('');
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch { /* best-effort */ }
  return wslToWindowsPath(file);
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
