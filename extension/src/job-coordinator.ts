import { NamingOptions } from './types';

export type JobStatus = 'queued' | 'probing' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  batchId?: string;
  batchLabel?: string;
  videoUrl: string;
  label: string;
  components: Record<string, unknown>;
  status: JobStatus;
  estBytes?: number;
  index?: number;
  total?: number;
  category?: string;
  folder?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  summaryWritten?: boolean;
  summaryExhausted?: boolean;
}

export interface CoordinatorSettings {
  outputRoot: string;
  autoOpenFolder: boolean;
  notifyOnDone: boolean;
  sponsorblock: 'off' | 'mark' | 'remove';
  fasterDownloads: boolean;
  naming: NamingOptions;
  collectHistory: boolean;
  historyRetentionDays: number;
}

export interface JobStorage {
  getJobs(): Promise<Job[]>;
  setJobs(jobs: Job[]): Promise<void>;
  getValues(keys: string[]): Promise<Record<string, unknown>>;
  setValues(values: Record<string, unknown>): Promise<void>;
}

export interface NativeResponse {
  ok?: boolean;
  bytes?: number;
  title?: string;
  error?: string;
  folderPath?: string;
  windowsFolderPath?: string;
  [key: string]: unknown;
}

export interface CoordinatorEffects {
  storage: JobStorage;
  sendNative(payload: Record<string, unknown>): Promise<NativeResponse | null>;
  now(): number;
  generateId(): string;
  notify(label: string, folder: string): void;
  openFolder(folder: string): Promise<void>;
  delay(milliseconds: number): Promise<void>;
  getSettings(): CoordinatorSettings;
}

export interface EnqueueRequest {
  items: { url: string; title?: string; bytes?: number | null }[];
  components?: Record<string, unknown>;
  batchLabel?: string;
  category?: string;
}

const MAX_HISTORY = 100;
const SUMMARY_ATTEMPTS_KEY = 'tvBatchSummaryAttempts';
const MAX_SUMMARY_ATTEMPTS = 3;
const isActive = (job: Job) => job.status === 'queued' || job.status === 'probing' || job.status === 'running';

export class JobCoordinator {
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;
  private readonly summaryPromises = new Map<string, Promise<void>>();
  private jobsTail = Promise.resolve();
  private summaryTail = Promise.resolve();
  private summaryStateTail = Promise.resolve();

  constructor(private readonly effects: CoordinatorEffects) {}

  async initialize(): Promise<void> {
    const jobs = await this.mutateJobs((currentJobs) => {
      let changed = false;
      for (const job of currentJobs) {
        if (job.status === 'running' || job.status === 'probing') {
          job.status = 'failed';
          job.error = 'Interrupted';
          job.finishedAt = this.effects.now();
          changed = true;
        }
      }
      return { changed, value: currentJobs };
    }, true);
    const terminalBatchIds = new Set(jobs
      .filter((job) => job.batchId && !isActive(job))
      .map((job) => job.batchId as string));
    void this.pumpQueue();
    for (const batchId of terminalBatchIds) {
      void this.maybeWriteBatchSummary(batchId).catch(() => undefined);
    }
  }

  async enqueue(request: EnqueueRequest): Promise<{ ok: boolean; batchId?: string; count?: number; error?: string }> {
    const valid = (request.items ?? []).filter((item) => item && typeof item.url === 'string');
    if (valid.length === 0) return { ok: false, error: 'No videos to enqueue' };

    const isBatch = valid.length > 1 || !!request.batchLabel;
    const batchId = isBatch ? this.effects.generateId() : undefined;
    await this.mutateJobs((jobs) => {
      valid.forEach((item, index) => jobs.push({
        id: this.effects.generateId(),
        batchId,
        batchLabel: request.batchLabel,
        videoUrl: item.url,
        label: item.title || item.url,
        components: request.components ?? {},
        status: 'queued',
        estBytes: typeof item.bytes === 'number' && item.bytes > 0 ? item.bytes : undefined,
        index: isBatch ? index + 1 : undefined,
        total: isBatch ? valid.length : undefined,
        category: isBatch ? request.category : undefined,
        createdAt: this.effects.now(),
      }));
      return { changed: true, value: undefined };
    });
    void this.pumpQueue();
    return { ok: true, batchId, count: valid.length };
  }

  async cancelJob(id: string): Promise<void> {
    const cancelled = await this.mutateJobs((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || !isActive(job)) return { changed: false, value: undefined };
      const result = {
        batchId: job.batchId,
        wasInFlight: job.status === 'running' || job.status === 'probing',
      };
      job.status = 'cancelled';
      job.finishedAt = this.effects.now();
      return { changed: true, value: result, options: !!job.batchId };
    });
    if (!cancelled) return;
    if (cancelled.wasInFlight) await this.effects.sendNative({ action: 'cancel', jobId: id });
    await this.maybeWriteBatchSummary(cancelled.batchId);
    void this.pumpQueue();
  }

  async cancelBatch(batchId: string): Promise<void> {
    const inFlight = await this.mutateJobs((jobs) => {
      const ids: string[] = [];
      let changed = false;
      for (const job of jobs) {
        if (job.batchId !== batchId || !isActive(job)) continue;
        if (job.status === 'running' || job.status === 'probing') ids.push(job.id);
        job.status = 'cancelled';
        job.finishedAt = this.effects.now();
        changed = true;
      }
      return { changed, value: ids };
    }, true);
    await Promise.all(inFlight.map((jobId) => this.effects.sendNative({ action: 'cancel', jobId })));
    await this.maybeWriteBatchSummary(batchId);
    void this.pumpQueue();
  }

  async clearHistory(): Promise<void> {
    await this.mutateJobs((jobs) => ({ changed: true, value: undefined }), { clearHistory: true });
  }

  async seedOutputRoot(defaultRoot: string): Promise<void> {
    if (!defaultRoot) return;
    const values = await this.effects.storage.getValues(['outputRoot', 'outputRootSeeded']);
    if (!values.outputRoot && !values.outputRootSeeded) {
      await this.effects.storage.setValues({ outputRoot: defaultRoot, outputRootSeeded: true });
    }
  }

  async whenIdle(): Promise<void> {
    await this.pumpPromise;
  }

  private pumpQueue(): Promise<void> {
    this.pumpRequested = true;
    if (this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = this.drainRequestedQueue();
    return this.pumpPromise;
  }

  private async drainRequestedQueue(): Promise<void> {
    try {
      do {
        this.pumpRequested = false;
        await this.drainQueue();
      } while (this.pumpRequested);
    } finally {
      this.pumpPromise = null;
    }
  }

  private async drainQueue(): Promise<void> {
    while (true) {
      const jobs = await this.effects.storage.getJobs();
      if (jobs.some((job) => job.status === 'running' || job.status === 'probing')) return;
      const next = jobs.find((job) => job.status === 'queued');
      if (!next) return;
      await this.runJob(next);
    }
  }

  private async runJob(originalJob: Job): Promise<void> {
    let job = originalJob;
    if (job.estBytes === undefined) {
      if (!(await this.updateJob(job.id, { status: 'probing' }))) return;
      const probe = await this.safeNative({ action: 'probe', url: job.videoUrl, components: job.components });
      if (await this.isCancelled(job.id)) return;
      const patch: Partial<Job> = {
        status: 'running',
        estBytes: probe?.ok && typeof probe.bytes === 'number' ? probe.bytes : 0,
      };
      if (probe?.ok && typeof probe.title === 'string' && probe.title) patch.label = probe.title;
      if (!(await this.updateJob(job.id, patch))) return;
      job = { ...job, ...patch };
    } else {
      if (!(await this.updateJob(job.id, { status: 'running' }))) return;
    }

    const settings = this.effects.getSettings();
    const response = await this.safeNative({
      action: 'custom',
      url: job.videoUrl,
      components: job.components,
      jobId: job.id,
      index: job.index,
      total: job.total,
      category: job.category,
      options: {
        outputRoot: settings.outputRoot,
        naming: settings.naming,
        sponsorblock: settings.sponsorblock,
        fasterDownloads: settings.fasterDownloads,
      },
    });
    if (await this.isCancelled(job.id)) {
      await this.maybeWriteBatchSummary(job.batchId);
      return;
    }

    if (!response?.ok) {
      await this.updateJob(job.id, {
        status: 'failed',
        error: typeof response?.error === 'string' ? response.error : 'Download failed',
        finishedAt: this.effects.now(),
      });
    } else {
      const folder = typeof response.windowsFolderPath === 'string'
        ? response.windowsFolderPath
        : typeof response.folderPath === 'string' ? response.folderPath : '';
      const completed = await this.updateJob(job.id, {
        status: 'done',
        folder,
        finishedAt: this.effects.now(),
        ...(typeof response.bytes === 'number' && response.bytes > 0 ? { estBytes: response.bytes } : {}),
      });
      if (!completed) return;
      if (settings.notifyOnDone) this.effects.notify(job.label, folder);
      if (settings.autoOpenFolder && folder && !job.batchId) await this.effects.openFolder(folder);
    }
    await this.maybeWriteBatchSummary(job.batchId);
  }

  private async safeNative(payload: Record<string, unknown>): Promise<NativeResponse | null> {
    try {
      return await this.effects.sendNative(payload);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Native helper failed' };
    }
  }

  private async isCancelled(id: string): Promise<boolean> {
    return this.withJobsLock(async () => (
      (await this.effects.storage.getJobs()).find((job) => job.id === id)?.status === 'cancelled'
    ));
  }

  private async updateJob(id: string, patch: Partial<Job>): Promise<boolean> {
    return this.mutateJobs((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0 || jobs[index].status === 'cancelled') return { changed: false, value: false };
      jobs[index] = { ...jobs[index], ...patch };
      return { changed: true, value: true, options: !!jobs[index].batchId };
    });
  }

  private trim(jobs: Job[], options: { clearHistory?: boolean; finalizedBatchId?: string } = {}): Job[] {
    const settings = this.effects.getSettings();
    const protectedBatchIds = new Set(jobs.flatMap((job) => (
      job.batchId && job.batchId !== options.finalizedBatchId
        && (isActive(job) || (!job.summaryWritten && !job.summaryExhausted))
        ? [job.batchId]
        : []
    )));
    const isProtected = (job: Job) => !!job.batchId && protectedBatchIds.has(job.batchId);
    let result = jobs;
    if (options.clearHistory || !settings.collectHistory) {
      result = result.filter((job) => isActive(job) || isProtected(job));
    } else if (settings.historyRetentionDays > 0) {
      const cutoff = this.effects.now() - settings.historyRetentionDays * 86_400_000;
      result = result.filter((job) => isActive(job) || isProtected(job) || (job.finishedAt ?? 0) >= cutoff);
    }
    const finishedIndexes = result
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => !isActive(job) && !isProtected(job));
    const dropCount = Math.max(0, finishedIndexes.length - MAX_HISTORY);
    if (dropCount === 0) return result;
    const dropped = new Set(finishedIndexes.slice(0, dropCount).map(({ index }) => index));
    return result.filter((_job, index) => !dropped.has(index));
  }

  private async setJobsLocked(
    jobs: Job[],
    options: boolean | { clearHistory?: boolean; finalizedBatchId?: string } = false,
  ): Promise<void> {
    const preserveAllFinished = options === true;
    const retainedJobs = preserveAllFinished ? jobs : this.trim(jobs, typeof options === 'object' ? options : {});
    await this.effects.storage.setJobs(retainedJobs);
    if (!preserveAllFinished) await this.reconcileSummaryAttempts(retainedJobs);
  }

  private async mutateJobs<T>(
    mutation: (jobs: Job[]) => {
      changed: boolean;
      value: T;
      options?: boolean | { clearHistory?: boolean; finalizedBatchId?: string };
    },
    options: boolean | { clearHistory?: boolean; finalizedBatchId?: string } = false,
  ): Promise<T> {
    return this.withJobsLock(async () => {
      const jobs = await this.effects.storage.getJobs();
      const result = mutation(jobs);
      if (result.changed) await this.setJobsLocked(jobs, result.options ?? options);
      const { value } = result;
      return value;
    });
  }

  private async maybeWriteBatchSummary(batchId?: string): Promise<void> {
    if (!batchId) return;
    const inFlight = this.summaryPromises.get(batchId);
    if (inFlight) return inFlight;

    const operation = this.summaryTail.then(() => this.finalizeBatchSummary(batchId)).finally(() => {
      this.summaryPromises.delete(batchId);
    });
    this.summaryTail = operation.catch(() => undefined);
    this.summaryPromises.set(batchId, operation);
    return operation;
  }

  private async finalizeBatchSummary(batchId: string): Promise<void> {
    const jobs = await this.effects.storage.getJobs();
    const members = jobs.filter((job) => job.batchId === batchId);
    if (members.length === 0 || members.some(isActive)) return;
    if (members.some((job) => job.summaryWritten)) {
      await this.clearSummaryAttempts(batchId);
      return;
    }
    const first = members[0];
    const payload = {
      action: 'batch_summary',
      batchId,
      batchLabel: first.batchLabel,
      category: first.category,
      items: members.map((job) => ({ title: job.label, folder: job.folder, status: job.status })),
      options: { outputRoot: this.effects.getSettings().outputRoot },
    };

    let attempts = await this.getSummaryAttempts(batchId);
    while (attempts < MAX_SUMMARY_ATTEMPTS) {
      attempts += 1;
      await this.setSummaryAttempts(batchId, attempts);
      const response = await this.safeNative(payload);
      if (response?.ok) {
        await this.mutateJobs((latestJobs) => {
          let changed = false;
          for (const job of latestJobs) {
            if (job.batchId !== batchId) continue;
            job.summaryWritten = true;
            changed = true;
          }
          return { changed, value: undefined };
        });
        await this.clearSummaryAttempts(batchId);
        return;
      }
      if (attempts < MAX_SUMMARY_ATTEMPTS) await this.effects.delay(100 * attempts);
    }

    await this.mutateJobs((exhaustedJobs) => {
      let changed = false;
      for (const job of exhaustedJobs) {
        if (job.batchId !== batchId) continue;
        job.summaryExhausted = true;
        changed = true;
      }
      return { changed, value: undefined };
    }, { finalizedBatchId: batchId });
    if (!(await this.effects.storage.getJobs()).some((job) => job.batchId === batchId)) {
      await this.clearSummaryAttempts(batchId);
    }
  }

  private async readSummaryAttemptState(): Promise<Record<string, number>> {
    const value = (await this.effects.storage.getValues([SUMMARY_ATTEMPTS_KEY]))[SUMMARY_ATTEMPTS_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => (
      typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0
    )));
  }

  private async getSummaryAttempts(batchId: string): Promise<number> {
    return this.withSummaryStateLock(async () => (await this.readSummaryAttemptState())[batchId] ?? 0);
  }

  private async setSummaryAttempts(batchId: string, attempts: number): Promise<void> {
    await this.withSummaryStateLock(async () => {
      const state = await this.readSummaryAttemptState();
      state[batchId] = attempts;
      await this.effects.storage.setValues({ [SUMMARY_ATTEMPTS_KEY]: state });
    });
  }

  private async clearSummaryAttempts(batchId: string): Promise<void> {
    await this.withSummaryStateLock(async () => {
      const state = await this.readSummaryAttemptState();
      if (!(batchId in state)) return;
      delete state[batchId];
      await this.effects.storage.setValues({ [SUMMARY_ATTEMPTS_KEY]: state });
    });
  }

  private async reconcileSummaryAttempts(jobs: Job[]): Promise<void> {
    await this.withSummaryStateLock(async () => {
      const retainedBatchIds = new Set(jobs.flatMap((job) => job.batchId ? [job.batchId] : []));
      const state = await this.readSummaryAttemptState();
      const retainedState = Object.fromEntries(
        Object.entries(state).filter(([batchId]) => retainedBatchIds.has(batchId)),
      );
      if (Object.keys(retainedState).length === Object.keys(state).length) return;
      await this.effects.storage.setValues({ [SUMMARY_ATTEMPTS_KEY]: retainedState });
    });
  }

  private async withSummaryStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.summaryStateTail.then(operation, operation);
    this.summaryStateTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withJobsLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.jobsTail.then(operation, operation);
    this.jobsTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
