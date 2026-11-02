// Live download progress for the queue's `custom` downloads.
//
// yt-dlp prints one machine-readable line per progress tick when it is given the
// templates below (download ticks go to stdout, post-processing ticks to stderr
// because `--print` makes yt-dlp quiet). The helper strips those lines from the
// captured output, folds them into one job-level snapshot and streams that
// snapshot to the extension over the native messaging port.

export const PROGRESS_PREFIX = '[tube-vault-progress]';

const DOWNLOAD_FIELDS = [
  '%(info.format_id)s',
  '%(progress.status)s',
  '%(progress.downloaded_bytes)s',
  '%(progress.total_bytes)s',
  '%(progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
].join('\t');

const POSTPROCESS_FIELDS = ['%(progress.postprocessor)s', '%(progress.status)s'].join('\t');

export function progressArgs(): string[] {
  return [
    '--progress',
    '--newline',
    '--progress-template', `download:${PROGRESS_PREFIX}\tdownload\t${DOWNLOAD_FIELDS}`,
    '--progress-template', `postprocess:${PROGRESS_PREFIX}\tpostprocess\t${POSTPROCESS_FIELDS}`,
  ];
}

export type ProgressEvent =
  | {
    kind: 'download';
    part: string;
    status: string;
    downloadedBytes: number | null;
    totalBytes: number | null;
    speed: number | null;
    eta: number | null;
  }
  | { kind: 'postprocess'; postprocessor: string; status: string };

function num(value: string | undefined): number | null {
  if (value === undefined || value === '' || value === 'NA' || value === 'None') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function isProgressLine(line: string): boolean {
  return line.startsWith(PROGRESS_PREFIX);
}

export function parseProgressLine(line: string): ProgressEvent | null {
  if (!isProgressLine(line)) return null;
  const fields = line.replace(/\r$/, '').split('\t');
  if (fields[1] === 'download' && fields.length >= 9) {
    return {
      kind: 'download',
      part: fields[2] || 'NA',
      status: fields[3],
      downloadedBytes: num(fields[4]),
      totalBytes: num(fields[5]) ?? num(fields[6]),
      speed: num(fields[7]),
      eta: num(fields[8]),
    };
  }
  if (fields[1] === 'postprocess' && fields.length >= 4) {
    return { kind: 'postprocess', postprocessor: fields[2], status: fields[3] };
  }
  return null;
}

export interface DownloadProgress {
  phase: 'downloading' | 'processing';
  downloadedBytes: number;
  totalBytes: number | null;
  speed: number | null;
  eta: number | null;
}

interface PartState {
  downloaded: number;
  total: number | null;
  speed: number | null;
  eta: number | null;
  downloading: boolean;
  updatedAt: number;
}

const SPEED_STALE_MS = 3_000;

// Folds the ticks of every yt-dlp run of one job (video and audio run in parallel,
// and a merged video downloads its video and audio streams one after the other)
// into one snapshot, and rate-limits how often it is emitted.
export class ProgressTracker {
  private readonly parts = new Map<string, PartState>();
  private lastDownloadAt = 0;
  private lastPostprocessAt = 0;
  private lastEmitAt = 0;
  private lastPhase: DownloadProgress['phase'] | null = null;

  constructor(
    private readonly emit: (progress: DownloadProgress) => void,
    private readonly options: { expectedBytes?: number | null; intervalMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  // `run` separates parallel yt-dlp processes whose format IDs could collide.
  update(run: number, event: ProgressEvent): void {
    const now = this.now();
    if (event.kind === 'download') {
      const key = `${run}:${event.part}`;
      const previous = this.parts.get(key);
      const downloaded = event.downloadedBytes ?? previous?.downloaded ?? 0;
      const finished = event.status === 'finished';
      this.parts.set(key, {
        downloaded,
        total: finished ? Math.max(downloaded, event.totalBytes ?? 0) : event.totalBytes ?? previous?.total ?? null,
        speed: finished ? null : event.speed,
        eta: finished ? 0 : event.eta,
        downloading: event.status === 'downloading',
        updatedAt: now,
      });
      this.lastDownloadAt = now;
    } else if (event.status === 'started' || event.status === 'processing') {
      this.lastPostprocessAt = now;
    } else {
      return;
    }

    const snapshot = this.snapshot();
    const phaseChanged = snapshot.phase !== this.lastPhase;
    if (!phaseChanged && now - this.lastEmitAt < (this.options.intervalMs ?? 500)) return;
    this.lastEmitAt = now;
    this.lastPhase = snapshot.phase;
    this.emit(snapshot);
  }

  snapshot(): DownloadProgress {
    const now = this.now();
    let downloadedBytes = 0;
    let knownTotal = 0;
    let anyTotal = false;
    let speed = 0;
    let anySpeed = false;
    let maxEta: number | null = null;
    let downloading = false;
    for (const part of this.parts.values()) {
      downloadedBytes += part.downloaded;
      knownTotal += part.total ?? part.downloaded;
      if (part.total !== null) anyTotal = true;
      if (part.downloading && now - part.updatedAt <= SPEED_STALE_MS) {
        downloading = true;
        if (part.speed !== null) { speed += part.speed; anySpeed = true; }
        if (part.eta !== null) maxEta = Math.max(maxEta ?? 0, part.eta);
      }
    }

    const expected = this.options.expectedBytes && this.options.expectedBytes > 0 ? this.options.expectedBytes : null;
    const totalBytes = expected !== null ? Math.max(expected, knownTotal) : anyTotal ? knownTotal : null;
    const currentSpeed = anySpeed && speed > 0 ? speed : null;
    const eta = totalBytes !== null && currentSpeed !== null
      ? Math.max(0, Math.round((totalBytes - downloadedBytes) / currentSpeed))
      : maxEta;
    const processing = this.lastPostprocessAt > 0 && this.lastPostprocessAt >= this.lastDownloadAt && !downloading;
    return {
      phase: processing ? 'processing' : 'downloading',
      downloadedBytes,
      totalBytes,
      speed: processing ? null : currentSpeed,
      eta: processing ? null : eta,
    };
  }
}

// Splits a stream into lines, handing complete progress lines to `onProgress`
// and everything else to `onOther`, so progress ticks never pile up in the
// captured output that capture parsing and error messages read.
export class LineSplitter {
  private pending = '';

  constructor(
    private readonly onProgress: (line: string) => void,
    private readonly onOther: (text: string) => void,
  ) {}

  push(chunk: string): void {
    const text = this.pending + chunk;
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) {
      this.pending = text;
      return;
    }
    this.pending = text.slice(lastNewline + 1);
    let other = '';
    for (const line of text.slice(0, lastNewline + 1).split(/(?<=\n)/)) {
      if (isProgressLine(line)) this.onProgress(line.replace(/\r?\n$/, ''));
      else other += line;
    }
    if (other) this.onOther(other);
  }

  end(): void {
    if (!this.pending) return;
    if (isProgressLine(this.pending)) this.onProgress(this.pending);
    else this.onOther(this.pending);
    this.pending = '';
  }
}
