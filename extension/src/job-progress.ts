// Formatting shared by the popup and the Downloads page for a running job's
// live progress (see JobProgress in job-coordinator.ts).
import type { JobProgress } from './job-coordinator';

export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// "12 / 285 MB": both numbers in the total's unit, so the pair reads at a glance.
export function formatBytePair(done: number, total: number): string {
  const [divisor, unit, digits] = total >= 1e9 ? [1e9, 'GB', 1] : total >= 1e6 ? [1e6, 'MB', 0] : [1e3, 'KB', 0];
  const show = (value: number) => (value / divisor).toFixed(digits);
  return `${show(Math.min(done, total))} / ${show(total)} ${unit}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1e3))} KB/s`;
}

export function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s left`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${String(total % 60).padStart(2, '0')} left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

export interface ProgressView {
  percent: number | null; // 0-100, null when the total is unknown
  detail: string;         // e.g. "42% · 120 / 285 MB · 4.2 MB/s · 0:39 left"
}

function totalOf(progress: Pick<JobProgress, 'totalBytes'>, estBytes?: number): number | null {
  if (progress.totalBytes && progress.totalBytes > 0) return progress.totalBytes;
  return estBytes && estBytes > 0 ? estBytes : null;
}

// The percent the bytes alone give (99 at most until the helper finishes), for a
// snapshot that carries no percent of its own.
export function computePercent(progress: Pick<JobProgress, 'downloadedBytes' | 'totalBytes'>, estBytes?: number): number | null {
  const total = totalOf(progress, estBytes);
  return total ? Math.min(99, Math.floor((progress.downloadedBytes / total) * 100)) : null;
}

export function describeProgress(progress: JobProgress | undefined, estBytes?: number): ProgressView | null {
  if (!progress) return null;
  if (progress.phase === 'processing') {
    return { percent: 100, detail: 'Finishing up…' };
  }
  const total = totalOf(progress, estBytes);
  // The stored percent never goes down; the byte counts next to it stay exact,
  // so they can briefly read lower than the percent while it holds.
  const percent = typeof progress.percent === 'number' ? Math.min(99, progress.percent) : computePercent(progress, estBytes);
  const parts: string[] = [];
  if (percent !== null && total) {
    parts.push(`${percent}%`, formatBytePair(progress.downloadedBytes, total));
  } else if (progress.downloadedBytes > 0) {
    parts.push(formatBytes(progress.downloadedBytes));
  }
  if (progress.speed) parts.push(formatSpeed(progress.speed));
  if (progress.eta !== null && progress.speed) parts.push(formatEta(progress.eta));
  return { percent, detail: parts.join(' · ') };
}
