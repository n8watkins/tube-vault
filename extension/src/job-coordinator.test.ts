import { describe, expect, it, vi } from 'vitest';
import { CoordinatorEffects, CoordinatorSettings, Job, JobCoordinator, NativeResponse } from './job-coordinator';
import { defaultNaming } from './types';

const baseSettings: CoordinatorSettings = {
  outputRoot: '/videos',
  autoOpenFolder: false,
  notifyOnDone: true,
  sponsorblock: 'off',
  fasterDownloads: true,
  naming: { ...defaultNaming },
  collectHistory: true,
  historyRetentionDays: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function job(id: string, status: Job['status'], extra: Partial<Job> = {}): Job {
  return {
    id,
    videoUrl: `https://youtube.test/${id}`,
    label: id,
    components: {},
    status,
    createdAt: 1,
    ...extra,
  };
}

function harness(options: {
  jobs?: Job[];
  settings?: Partial<CoordinatorSettings>;
  native?: (payload: Record<string, unknown>) => Promise<NativeResponse | null>;
  values?: Record<string, unknown>;
} = {}) {
  let jobs = structuredClone(options.jobs ?? []);
  const values = { ...(options.values ?? {}) };
  const settings = { ...baseSettings, ...options.settings };
  let id = 0;
  let now = 1_000_000;
  const calls: Record<string, unknown>[] = [];
  const notifications: [string, string][] = [];
  const opened: string[] = [];
  const delays: number[] = [];
  const effects: CoordinatorEffects = {
    storage: {
      getJobs: async () => structuredClone(jobs),
      setJobs: async (next) => { jobs = structuredClone(next); },
      getValues: async (keys) => Object.fromEntries(keys.map((key) => [key, values[key]])),
      setValues: async (next) => { Object.assign(values, next); },
    },
    sendNative: async (payload) => {
      calls.push(payload);
      if (options.native) return options.native(payload);
      if (payload.action === 'probe') return { ok: true, bytes: 25, title: 'Probed title' };
      return { ok: true, folderPath: '/videos/item' };
    },
    now: () => now,
    generateId: () => `id-${++id}`,
    notify: (label, folder) => notifications.push([label, folder]),
    openFolder: async (folder) => { opened.push(folder); },
    delay: async (milliseconds) => { delays.push(milliseconds); },
    getSettings: () => settings,
  };
  const coordinator = new JobCoordinator(effects);
  return {
    coordinator,
    calls,
    notifications,
    opened,
    delays,
    values,
    settings,
    get jobs() { return structuredClone(jobs); },
    setNow(value: number) { now = value; },
  };
}

describe('JobCoordinator', () => {
  it('enqueues a single job with a stable label and no batch numbering', async () => {
    const download = deferred<NativeResponse>();
    const test = harness({ native: async (payload) => payload.action === 'custom' ? download.promise : { ok: true, bytes: 10 } });
    const result = await test.coordinator.enqueue({ items: [{ url: 'https://youtube.test/watch?v=1', title: 'One', bytes: 10 }], components: { video: true } });
    expect(result).toEqual({ ok: true, batchId: undefined, count: 1 });
    await vi.waitFor(() => expect(test.jobs[0].status).toBe('running'));
    expect(test.jobs[0]).toMatchObject({ id: 'id-1', label: 'One', index: undefined, total: undefined, status: 'running' });
    download.resolve({ ok: true });
    await test.coordinator.whenIdle();
  });

  it('enqueues batches with one batch ID and sequential numbering', async () => {
    const test = harness();
    const result = await test.coordinator.enqueue({
      items: [{ url: 'one', title: 'One', bytes: 1 }, { url: 'two', bytes: 2 }],
      batchLabel: 'Playlist: Tests',
      category: 'Playlist',
    });
    await test.coordinator.whenIdle();
    expect(result).toEqual({ ok: true, batchId: 'id-1', count: 2 });
    expect(test.jobs.map(({ batchId, index, total, label }) => ({ batchId, index, total, label }))).toEqual([
      { batchId: 'id-1', index: 1, total: 2, label: 'One' },
      { batchId: 'id-1', index: 2, total: 2, label: 'two' },
    ]);
  });

  it('probes and downloads strictly serially while applying probe metadata', async () => {
    const firstDownload = deferred<NativeResponse>();
    const test = harness({ native: async (payload) => {
      if (payload.action === 'probe') return { ok: true, bytes: 42, title: `Title ${payload.url}` };
      if (payload.action === 'custom' && payload.url === 'one') return firstDownload.promise;
      return { ok: true };
    } });
    await test.coordinator.enqueue({ items: [{ url: 'one' }, { url: 'two' }] });
    await vi.waitFor(() => expect(test.calls.map((call) => call.action)).toEqual(['probe', 'custom']));
    expect(test.jobs[0]).toMatchObject({ status: 'running', estBytes: 42, label: 'Title one' });
    expect(test.jobs[1].status).toBe('queued');
    firstDownload.resolve({ ok: true });
    await test.coordinator.whenIdle();
    expect(test.calls.map((call) => call.action)).toEqual(['probe', 'custom', 'probe', 'custom', 'batch_summary']);
  });

  it('records native download failures and continues with the queue', async () => {
    const test = harness({ native: async (payload) => {
      if (payload.action === 'custom' && payload.url === 'one') throw new Error('host disconnected');
      return { ok: true };
    } });
    await test.coordinator.enqueue({ items: [{ url: 'one', bytes: 1 }, { url: 'two', bytes: 1 }] });
    await test.coordinator.whenIdle();
    expect(test.jobs.map(({ status, error }) => ({ status, error }))).toEqual([
      { status: 'failed', error: 'host disconnected' },
      { status: 'done', error: undefined },
    ]);
  });

  it('cancels queued jobs without calling the native helper', async () => {
    const test = harness({ jobs: [job('queued', 'queued')] });
    await test.coordinator.cancelJob('queued');
    expect(test.jobs[0].status).toBe('cancelled');
    expect(test.calls).toEqual([]);
  });

  it.each(['probing', 'running'] as const)('cancels an in-flight %s job through the native helper', async (status) => {
    const test = harness({ jobs: [job('active', status)] });
    await test.coordinator.cancelJob('active');
    expect(test.jobs[0].status).toBe('cancelled');
    expect(test.calls).toContainEqual({ action: 'cancel', jobId: 'active' });
  });

  it('cancels every active member of a batch', async () => {
    const test = harness({ jobs: [
      job('one', 'running', { batchId: 'batch' }),
      job('two', 'queued', { batchId: 'batch' }),
      job('other', 'queued'),
    ] });
    await test.coordinator.cancelBatch('batch');
    expect(test.jobs.slice(0, 2).map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(test.jobs[2].status).toBe('queued');
    expect(test.calls).toContainEqual({ action: 'cancel', jobId: 'one' });
    await test.coordinator.whenIdle();
    expect(test.jobs[2].status).toBe('done');
  });

  it('resumes the queue after a cancelled probe settles', async () => {
    const probe = deferred<NativeResponse>();
    const test = harness({ native: async (payload) => payload.action === 'probe' && payload.url === 'one' ? probe.promise : { ok: true } });
    await test.coordinator.enqueue({ items: [{ url: 'one' }, { url: 'two', bytes: 1 }] });
    await vi.waitFor(() => expect(test.jobs[0].status).toBe('probing'));
    await test.coordinator.cancelJob(test.jobs[0].id);
    probe.resolve({ ok: true });
    await test.coordinator.whenIdle();
    expect(test.jobs.map((item) => item.status)).toEqual(['cancelled', 'done']);
  });

  it('drops finished jobs when history is disabled', async () => {
    const download = deferred<NativeResponse>();
    const test = harness({ jobs: [job('old', 'done')], settings: { collectHistory: false }, native: async () => download.promise });
    await test.coordinator.enqueue({ items: [{ url: 'new', bytes: 1 }] });
    expect(test.jobs.map((item) => item.id)).not.toContain('old');
    download.resolve({ ok: true });
    await test.coordinator.whenIdle();
    expect(test.jobs).toEqual([]);
  });

  it('applies age retention and the 100-item finished history cap', async () => {
    const day = 86_400_000;
    const old = job('expired', 'done', { finishedAt: 1 });
    const recent = Array.from({ length: 101 }, (_, index) => job(`recent-${index}`, 'done', { finishedAt: 20 * day + index }));
    const download = deferred<NativeResponse>();
    const test = harness({ jobs: [old, ...recent], settings: { historyRetentionDays: 10 }, native: async () => download.promise });
    test.setNow(25 * day);
    await test.coordinator.enqueue({ items: [{ url: 'active', bytes: 1 }] });
    expect(test.jobs).toHaveLength(101);
    expect(test.jobs.some((item) => item.id === 'expired')).toBe(false);
    expect(test.jobs.some((item) => item.id === 'recent-0')).toBe(false);
    download.resolve({ ok: true });
    await test.coordinator.whenIdle();
  });

  it('recovers interrupted work and continues queued jobs after restart', async () => {
    const test = harness({ jobs: [job('stale', 'running'), job('next', 'queued', { estBytes: 1 })] });
    await test.coordinator.initialize();
    await test.coordinator.whenIdle();
    expect(test.jobs[0]).toMatchObject({ status: 'failed', error: 'Interrupted' });
    expect(test.jobs[1].status).toBe('done');
  });

  it('retains an interrupted batch member until queued siblings and summary finish', async () => {
    const test = harness({
      jobs: [
        job('stale', 'running', { batchId: 'batch', batchLabel: 'Mixed batch' }),
        job('next', 'queued', { batchId: 'batch', batchLabel: 'Mixed batch', estBytes: 1 }),
      ],
      settings: { collectHistory: false },
    });
    await test.coordinator.initialize();
    await test.coordinator.whenIdle();
    const summary = test.calls.find((call) => call.action === 'batch_summary');
    expect(summary?.items).toEqual([
      { title: 'stale', folder: undefined, status: 'failed' },
      { title: 'next', folder: '/videos/item', status: 'done' },
    ]);
    expect(test.jobs).toEqual([]);
  });

  it('resumes a fully terminal batch summary during initialization', async () => {
    const test = harness({
      jobs: [
        job('one', 'done', { batchId: 'batch', batchLabel: 'Restarted batch' }),
        job('two', 'failed', { batchId: 'batch', batchLabel: 'Restarted batch' }),
      ],
      values: { tvBatchSummaryAttempts: { batch: 1 } },
    });
    await test.coordinator.initialize();
    expect(test.calls.filter((call) => call.action === 'batch_summary')).toEqual([
      expect.objectContaining({ batchId: 'batch' }),
    ]);
    expect(test.jobs.every((item) => item.summaryWritten)).toBe(true);
    expect(test.values.tvBatchSummaryAttempts).toEqual({});
  });

  it('reuses the stable batch ID after helper success precedes coordinator marking', async () => {
    const terminalJobs = [job('one', 'done', { batchId: 'batch', batchLabel: 'Restarted batch' })];
    const beforeCrash = harness({ jobs: terminalJobs });
    await beforeCrash.coordinator.initialize();

    const afterRestart = harness({ jobs: terminalJobs, values: { tvBatchSummaryAttempts: { batch: 1 } } });
    await afterRestart.coordinator.initialize();

    expect(beforeCrash.calls.filter((call) => call.action === 'batch_summary')).toEqual([
      expect.objectContaining({ batchId: 'batch' }),
    ]);
    expect(afterRestart.calls.filter((call) => call.action === 'batch_summary')).toEqual([
      expect.objectContaining({ batchId: 'batch' }),
    ]);
    expect(afterRestart.jobs.every((item) => item.summaryWritten)).toBe(true);
  });

  it('does not exceed the persisted summary attempt bound after restart', async () => {
    const test = harness({
      jobs: [job('one', 'done', { batchId: 'batch' })],
      values: { tvBatchSummaryAttempts: { batch: 3 } },
    });
    await test.coordinator.initialize();
    expect(test.calls).toEqual([]);
    expect(test.values.tvBatchSummaryAttempts).toEqual({ batch: 3 });
  });

  it('requests a batch summary exactly once after the final member settles', async () => {
    const test = harness();
    await test.coordinator.enqueue({ items: [{ url: 'one', bytes: 1 }, { url: 'two', bytes: 1 }], batchLabel: 'Batch' });
    await test.coordinator.whenIdle();
    await test.coordinator.cancelBatch('id-1');
    expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(1);
    expect(test.jobs.every((item) => item.summaryWritten)).toBe(true);
  });

  it('deduplicates concurrent successful batch summary requests', async () => {
    const summary = deferred<NativeResponse>();
    const test = harness({
      jobs: [job('one', 'done', { batchId: 'batch' }), job('two', 'done', { batchId: 'batch' })],
      native: async (payload) => payload.action === 'batch_summary' ? summary.promise : { ok: true },
    });
    const first = test.coordinator.cancelBatch('batch');
    const second = test.coordinator.cancelBatch('batch');
    await vi.waitFor(() => expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(1));
    summary.resolve({ ok: true });
    await Promise.all([first, second]);
    expect(test.jobs.every((item) => item.summaryWritten)).toBe(true);
  });

  it('allows only one batch summary request in flight across batches', async () => {
    const firstSummary = deferred<NativeResponse>();
    const test = harness({
      jobs: [
        job('one', 'done', { batchId: 'first' }),
        job('two', 'done', { batchId: 'second' }),
      ],
      native: async (payload) => payload.action === 'batch_summary' && payload.items instanceof Array
        && (payload.items[0] as { title?: string }).title === 'one'
        ? firstSummary.promise
        : { ok: true },
    });
    const first = test.coordinator.cancelBatch('first');
    const second = test.coordinator.cancelBatch('second');
    await vi.waitFor(() => expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(1));
    firstSummary.resolve({ ok: true });
    await Promise.all([first, second]);
    expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(2);
  });

  it('retries a failed batch summary up to three times before success', async () => {
    let attempts = 0;
    const test = harness({ native: async (payload) => {
      if (payload.action !== 'batch_summary') return { ok: true };
      attempts += 1;
      return { ok: attempts === 3 };
    } });
    await test.coordinator.enqueue({ items: [{ url: 'one', bytes: 1 }, { url: 'two', bytes: 1 }], batchLabel: 'Retry batch' });
    await test.coordinator.whenIdle();
    expect(attempts).toBe(3);
    expect(test.delays).toEqual([100, 200]);
    expect(test.jobs.every((item) => item.summaryWritten)).toBe(true);
  });

  it('bounds exhausted batch summary retries for the coordinator lifetime', async () => {
    const test = harness({ native: async (payload) => ({ ok: payload.action !== 'batch_summary' }) });
    await test.coordinator.enqueue({ items: [{ url: 'one', bytes: 1 }, { url: 'two', bytes: 1 }], batchLabel: 'Failed summary' });
    await test.coordinator.whenIdle();
    await test.coordinator.cancelBatch('id-1');
    expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(3);
    expect(test.jobs.every((item) => !item.summaryWritten)).toBe(true);
  });

  it('writes the final batch summary before discarding disabled history', async () => {
    const test = harness({ settings: { collectHistory: false } });
    await test.coordinator.enqueue({ items: [{ url: 'one', bytes: 1 }, { url: 'two', bytes: 1 }], batchLabel: 'Private batch' });
    await test.coordinator.whenIdle();
    expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(1);
    expect(test.jobs).toEqual([]);
  });

  it('discards disabled history after batch summary retries are exhausted', async () => {
    const test = harness({
      settings: { collectHistory: false },
      native: async (payload) => ({ ok: payload.action !== 'batch_summary' }),
    });
    await test.coordinator.enqueue({ items: [{ url: 'one', bytes: 1 }, { url: 'two', bytes: 1 }], batchLabel: 'Private failed batch' });
    await test.coordinator.whenIdle();
    expect(test.calls.filter((call) => call.action === 'batch_summary')).toHaveLength(3);
    expect(test.jobs).toEqual([]);
    expect(test.values.tvBatchSummaryAttempts).toEqual({});
  });

  it('seeds the first helper output root exactly once', async () => {
    const fresh = harness();
    await fresh.coordinator.seedOutputRoot('/helper-default');
    expect(fresh.values).toEqual({ outputRoot: '/helper-default', outputRootSeeded: true });

    const saved = harness({ values: { outputRoot: '/saved' } });
    await saved.coordinator.seedOutputRoot('/helper-default');
    expect(saved.values).toEqual({ outputRoot: '/saved' });

    const intentionallyBlank = harness({ values: { outputRoot: '', outputRootSeeded: true } });
    await intentionallyBlank.coordinator.seedOutputRoot('/helper-default');
    expect(intentionallyBlank.values).toEqual({ outputRoot: '', outputRootSeeded: true });
  });
});
