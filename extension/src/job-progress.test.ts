import { describe, expect, it } from 'vitest';
import { computePercent, describeProgress, formatBytePair, formatEta, formatSpeed } from './job-progress';

const base = { phase: 'downloading' as const, percent: null, updatedAt: 1 };

describe('job progress formatting', () => {
  it('shows percent, sizes in one unit, speed and time left', () => {
    expect(describeProgress({ ...base, downloadedBytes: 120e6, totalBytes: 285e6, speed: 4.2e6, eta: 39 })).toEqual({
      percent: 42,
      detail: '42% · 120 / 285 MB · 4.2 MB/s · 39s left',
    });
  });

  it('never claims 100% before the helper finishes', () => {
    expect(describeProgress({ ...base, downloadedBytes: 999, totalBytes: 1000, speed: null, eta: null })?.percent).toBe(99);
  });

  it('falls back to the queued size estimate, then to bytes so far', () => {
    expect(describeProgress({ ...base, downloadedBytes: 5e6, totalBytes: null, speed: null, eta: null }, 10e6)).toEqual({
      percent: 50,
      detail: '50% · 5 / 10 MB',
    });
    expect(describeProgress({ ...base, downloadedBytes: 5e6, totalBytes: null, speed: 2e5, eta: null })).toEqual({
      percent: null,
      detail: '5 MB · 200 KB/s',
    });
  });

  it('shows the held percent next to the exact byte counts', () => {
    // 67 of 103 MB is 65%, but 66% was already shown: the percent holds, the bytes stay exact.
    expect(describeProgress({ ...base, percent: 66, downloadedBytes: 67e6, totalBytes: 103e6, speed: null, eta: null })).toEqual({
      percent: 66,
      detail: '66% · 67 / 103 MB',
    });
    expect(describeProgress({ ...base, percent: 100, downloadedBytes: 1, totalBytes: 1, speed: null, eta: null })?.percent).toBe(99);
    expect(computePercent({ downloadedBytes: 1, totalBytes: null })).toBeNull();
    expect(computePercent({ downloadedBytes: 1, totalBytes: null }, 4)).toBe(25);
  });

  it('reports post-processing as finishing up', () => {
    expect(describeProgress({ ...base, phase: 'processing', downloadedBytes: 1, totalBytes: 1, speed: null, eta: null })).toEqual({
      percent: 100,
      detail: 'Finishing up…',
    });
    expect(describeProgress(undefined)).toBeNull();
  });

  it('formats the pieces compactly', () => {
    expect(formatBytePair(1.5e9, 2.25e9)).toBe('1.5 / 2.3 GB');
    expect(formatBytePair(300e3, 900e3)).toBe('300 / 900 KB');
    expect(formatSpeed(850e3)).toBe('850 KB/s');
    expect(formatEta(125)).toBe('2:05 left');
    expect(formatEta(3 * 3600 + 7 * 60)).toBe('3h 7m left');
  });
});
