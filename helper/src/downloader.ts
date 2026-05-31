import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { wslToWindowsPath } from './sanitize';

const DEFAULT_OUTPUT_ROOT = '/mnt/c/Users/natha/Downloads/YouTube Archive';

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
  | 'download_best'
  | 'download_audio'
  | 'download_thumbnail'
  | 'download_metadata'
  | 'archive_bundle'
  | 'diagnostics';

export interface DownloadRequest {
  action: Action;
  url: string;
  components?: DownloadComponents;
  playlist?: boolean;
  options?: {
    outputRoot?: string;
  };
}

export interface DownloadResult {
  ok: boolean;
  status: string;
  folderPath?: string;
  windowsFolderPath?: string;
  error?: string;
  warnings?: string[];
  diagnostics?: Record<string, string | null>;
}

function run(cmd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code) => resolve({ out, err, code: code ?? 1 }));
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

export async function handle(req: DownloadRequest): Promise<DownloadResult> {
  const root = req.options?.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  ensureDir(root);

  const isPlaylist = !!req.playlist;
  const base = isPlaylist ? playlistTemplate(root) : folderTemplate(root);
  const noPlaylistFlag = isPlaylist ? [] : ['--no-playlist'];

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

        args.push(...noPlaylistFlag, req.url);
        jobs.push(run('yt-dlp', args));
      }

      // Separate audio extraction run (format conversion requires its own pass)
      if (hasAudio) {
        const args: string[] = [
          '-f', 'ba/b',
          '-x', '--audio-format', comp.audio!.format,
          '-o', `${base}/audio.%(ext)s`,
          ...noPlaylistFlag, req.url,
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
