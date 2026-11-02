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

// Printed once per video, after format selection and before anything downloads:
// every stream yt-dlp is about to fetch (a merged video is a video stream plus an
// audio stream) with its size, so the job total covers streams that have not
// started yet. A single-format download has no requested_formats ("[]").
const PLAN_FIELDS = [
  '%(format_id)s',
  '%(requested_formats.:.format_id)j',
  '%(requested_formats.:.filesize)j',
  '%(requested_formats.:.filesize_approx)j',
  '%(filesize)s',
  '%(filesize_approx)s',
].join('\t');

export function progressArgs(): string[] {
  return [
    '--progress',
    '--newline',
    '--progress-template', `download:${PROGRESS_PREFIX}\tdownload\t${DOWNLOAD_FIELDS}`,
    '--progress-template', `postprocess:${PROGRESS_PREFIX}\tpostprocess\t${POSTPROCESS_FIELDS}`,
  ];
}

// Only for runs that download media: a plain --print would imply --simulate, but
// these runs also print at after_move, a later stage, so yt-dlp still downloads.
export function planArgs(): string[] {
  return ['--print', `video:${PROGRESS_PREFIX}\tplan\t${PLAN_FIELDS}`];
}

export interface PlannedStream {
  part: string;
  bytes: number | null;
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
  | { kind: 'postprocess'; postprocessor: string; status: string }
  | { kind: 'plan'; streams: PlannedStream[] };

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value === '' || value === 'NA' || value === 'None') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function jsonList(value: string | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePlan(fields: string[]): ProgressEvent | null {
  const ids = jsonList(fields[3]);
  const sizes = jsonList(fields[4]);
  const approx = jsonList(fields[5]);
  if (ids.length > 0) {
    return {
      kind: 'plan',
      streams: ids.map((id, index) => ({
        part: typeof id === 'string' && id ? id : String(id ?? 'NA'),
        bytes: num(sizes[index]) ?? num(approx[index]),
      })),
    };
  }
  const part = fields[2];
  if (!part || part === 'NA') return null;
  return { kind: 'plan', streams: [{ part, bytes: num(fields[6]) ?? num(fields[7]) }] };
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
  if (fields[1] === 'plan' && fields.length >= 8) return parsePlan(fields);
  return null;
}

export interface DownloadProgress {
  phase: 'downloading' | 'processing';
  downloadedBytes: number;
  totalBytes: number | null;
  // 0-100 for the whole job, never lower than a percent already sent (it holds
  // while a larger real total catches up), 99 at most until post-processing,
  // null while the total is unknown.
  percent: number | null;
  speed: number | null;
  eta: number | null;
}

interface PartState {
  downloaded: number;
  total: number | null;
  speed: number | null;
  eta: number | null;
  downloading: boolean;
  finished: boolean;
  updatedAt: number;
}

interface RunState {
  // Whether the run prints a plan before each video (it downloads media).
  plans: boolean;
  // One segment per video the run downloads; ticks belong to the newest one.
  segments: { planned: PlannedStream[]; parts: Map<string, PartState> }[];
}

const SPEED_STALE_MS = 3_000;

// The bytes a stream will end up with: the finished size, else the size yt-dlp
// reports while downloading, else the plan's size.
function streamBytes(part: PartState | undefined, planned: number | null): number | null {
  if (part?.finished) return part.downloaded;
  return part?.total ?? planned ?? null;
}

// Folds the ticks of every yt-dlp run of one job into one snapshot, and rate-limits
// how often it is emitted. Video and audio components run as parallel processes, a
// merged video downloads its video and audio streams one after the other, and a
// playlist run downloads one video after another. The total counts every stream of
// every run (streams that have not started yet come from the runs' plans), so a new
// stream adds to the bar instead of restarting it, and the percent never goes back.
export class ProgressTracker {
  private readonly runs: RunState[] = [];
  private lastDownloadAt = 0;
  private lastPostprocessAt = 0;
  private lastEmitAt = 0;
  private lastPhase: DownloadProgress['phase'] | null = null;
  private shownPercent: number | null = null;
  private trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (progress: DownloadProgress) => void,
    private readonly options: { expectedBytes?: number | null; intervalMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  // Registers a yt-dlp process before it starts. With `plans`, its total is only
  // trusted once it has printed a plan.
  addRun(options: { plans: boolean }): number {
    this.runs.push({ plans: options.plans, segments: [] });
    return this.runs.length - 1;
  }

  private run(index: number): RunState {
    while (this.runs.length <= index) this.runs.push({ plans: false, segments: [] });
    return this.runs[index];
  }

  update(runIndex: number, event: ProgressEvent): void {
    const now = this.now();
    const run = this.run(runIndex);
    if (event.kind === 'plan') {
      run.segments.push({ planned: event.streams, parts: new Map() });
      return;
    }
    if (event.kind === 'download') {
      if (!run.segments.length) run.segments.push({ planned: [], parts: new Map() });
      let segment = run.segments[run.segments.length - 1];
      const previous = segment.parts.get(event.part);
      // A finished stream starting over without a plan is the next video of the run.
      if (previous?.finished && event.status === 'downloading') {
        segment = { planned: [], parts: new Map() };
        run.segments.push(segment);
      }
      const prior = segment.parts.get(event.part);
      const downloaded = event.downloadedBytes ?? prior?.downloaded ?? 0;
      const finished = event.status === 'finished';
      segment.parts.set(event.part, {
        downloaded,
        total: finished ? Math.max(downloaded, event.totalBytes ?? 0) : event.totalBytes ?? prior?.total ?? null,
        speed: finished ? null : event.speed,
        eta: finished ? 0 : event.eta,
        downloading: event.status === 'downloading',
        finished,
        updatedAt: now,
      });
      this.lastDownloadAt = now;
    } else if ((event.status === 'started' || event.status === 'processing') && this.downloadsDone()) {
      this.lastPostprocessAt = now;
    } else {
      // Post-processors yt-dlp runs before the media download (SponsorBlock's
      // segment fetch, the thumbnail convert) report "started" too: they are not
      // the job finishing up, so they change nothing.
      return;
    }

    const snapshot = this.snapshot();
    const interval = this.options.intervalMs ?? 500;
    const wait = interval - (now - this.lastEmitAt);
    if (snapshot.phase === this.lastPhase && wait > 0) {
      // Held back by the rate limit: send the newest state once the interval is
      // up, so the last tick before a quiet spell (a stream finishing, the next
      // one opening) still reaches the bar.
      this.trailing ??= setTimeout(() => {
        this.trailing = null;
        this.send(this.snapshot(), this.now());
      }, wait);
      this.trailing.unref?.();
      return;
    }
    this.send(snapshot, now);
  }

  private send(snapshot: DownloadProgress, now: number): void {
    if (this.trailing) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
    this.lastEmitAt = now;
    this.lastPhase = snapshot.phase;
    this.emit(snapshot);
  }

  // No more updates are coming (every run has exited): drop a pending send.
  stop(): void {
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = null;
  }

  // Whether every media run has downloaded every stream it is fetching: it has
  // printed a plan or sent ticks, and each planned stream (or, without a plan,
  // each started one) has finished. Only then is a post-processor the job
  // finishing up. Runs without media (thumbnail, metadata, subtitles only) have
  // nothing to wait for, so their post-processors always count.
  private downloadsDone(): boolean {
    return this.runs.every((run) => {
      if (!run.plans) return true;
      const segment = run.segments.at(-1);
      if (!segment) return false;
      if (segment.planned.length) return segment.planned.every((stream) => segment.parts.get(stream.part)?.finished);
      return segment.parts.size > 0 && [...segment.parts.values()].every((part) => part.finished);
    });
  }

  // The job's total: every planned and every started stream. `complete` when there
  // are media runs, each has printed a plan, and every planned stream's size is known.
  private total(): { bytes: number; complete: boolean; any: boolean } {
    let bytes = 0;
    let complete = this.runs.some((run) => run.plans);
    let any = false;
    for (const run of this.runs) {
      if (run.plans && !run.segments.some((segment) => segment.planned.length)) complete = false;
      for (const segment of run.segments) {
        const plannedParts = new Set<string>();
        for (const stream of segment.planned) {
          plannedParts.add(stream.part);
          const size = streamBytes(segment.parts.get(stream.part), stream.bytes);
          if (size === null) complete = false;
          else { bytes += size; any = true; }
        }
        for (const [part, state] of segment.parts) {
          if (plannedParts.has(part)) continue;
          // Extras (subtitles, or ticks without a plan) count as soon as they start.
          bytes += streamBytes(state, null) ?? state.downloaded;
          if (state.total !== null || state.finished) any = true;
        }
      }
    }
    return { bytes, complete, any };
  }

  snapshot(): DownloadProgress {
    const now = this.now();
    let downloadedBytes = 0;
    let speed = 0;
    let anySpeed = false;
    let maxEta: number | null = null;
    let downloading = false;
    for (const run of this.runs) {
      for (const segment of run.segments) {
        for (const part of segment.parts.values()) {
          downloadedBytes += part.downloaded;
          if (part.downloading && now - part.updatedAt <= SPEED_STALE_MS) {
            downloading = true;
            if (part.speed !== null) { speed += part.speed; anySpeed = true; }
            if (part.eta !== null) maxEta = Math.max(maxEta ?? 0, part.eta);
          }
        }
      }
    }

    // Plans cover every stream, so once every media run has one they are the
    // total. Until then the probe estimate is a floor, so the first stream alone
    // does not look like the whole job.
    const total = this.total();
    const expected = this.options.expectedBytes && this.options.expectedBytes > 0 ? this.options.expectedBytes : null;
    const totalBytes = total.complete && total.any
      ? Math.max(total.bytes, downloadedBytes)
      : expected !== null ? Math.max(expected, total.bytes, downloadedBytes)
        : total.any ? Math.max(total.bytes, downloadedBytes) : null;

    const currentSpeed = anySpeed && speed > 0 ? speed : null;
    const eta = totalBytes !== null && currentSpeed !== null
      ? Math.max(0, Math.round((totalBytes - downloadedBytes) / currentSpeed))
      : maxEta;
    const processing = this.lastPostprocessAt > 0 && this.lastPostprocessAt >= this.lastDownloadAt && !downloading
      && this.downloadsDone();

    // The percent only moves forward: when a stream turns out bigger than its
    // estimate, it holds until the bytes catch up instead of dipping. Processing
    // shows 100 without raising the floor, since a playlist run downloads again
    // after each video's merge.
    const computed = totalBytes ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100)) : null;
    if (computed !== null) this.shownPercent = Math.max(this.shownPercent ?? 0, computed);

    return {
      phase: processing ? 'processing' : 'downloading',
      downloadedBytes,
      totalBytes,
      percent: processing ? 100 : this.shownPercent,
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
