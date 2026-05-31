import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { wslToWindowsPath } from './sanitize';

const DEFAULT_OUTPUT_ROOT = '/mnt/c/Users/natha/Downloads/YouTube Archive';

export type Action =
  | 'download_best'
  | 'download_audio'
  | 'download_thumbnail'
  | 'download_metadata'
  | 'archive_bundle'
  | 'diagnostics';

export interface DownloadRequest {
  action: Action;
  url: string;
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

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export async function handle(req: DownloadRequest): Promise<DownloadResult> {
  const root = req.options?.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  ensureDir(root);
  const base = folderTemplate(root);

  switch (req.action) {
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

function result(code: number, folderPath: string, stderr: string): DownloadResult {
  if (code !== 0) {
    return { ok: false, status: 'failed', error: stderr.slice(-800) };
  }
  return {
    ok: true,
    status: 'complete',
    folderPath,
    windowsFolderPath: wslToWindowsPath(folderPath),
  };
}
