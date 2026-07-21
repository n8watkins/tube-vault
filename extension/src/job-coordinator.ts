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
  summaryReceiptCleaned?: boolean;
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
  scheduleQueueWake(milliseconds: number): void;
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
const SUMMARY_SCHEMA_VERSION_KEY = 'tvBatchSummarySchemaVersion';
const SUMMARY_SCHEMA_VERSION = 1;
const MAX_SUMMARY_ATTEMPTS = 3;
const MAX_QUEUE_PUMP_RETRIES = 3;
const QUEUE_WRITE_RETRY_DELAY_MS = 100;
const MAX_QUEUE_WRITE_RETRY_DELAY_MS = 1_000;
const INITIAL_QUEUE_WAKE_DELAY_MS = 1_000;
const MAX_QUEUE_WAKE_DELAY_MS = 60_000;
const MAX_SUMMARY_BACKGROUND_RETRIES = 3;
const isActive = (job: Job) => job.status === 'queued' || job.status === 'probing' || job.status === 'running';

interface BatchSummaryRetry {
  attempts: number;
  outputRoot?: string;
  receiptCleanupPending?: 'written' | 'exhausted';
  clearHistoryPending?: boolean;
}

export class JobCoordinator {
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;
  private pumpWakeVersion = 0;
  private queueWakeDelayMs = INITIAL_QUEUE_WAKE_DELAY_MS;
  private readonly summaryPromises = new Map<string, Promise<void>>();
  private readonly summaryRetryCounts = new Map<string, number>();
  private jobsTail = Promise.resolve();
  private summaryTail = Promise.resolve();
  private summaryStateTail = Promise.resolve();

  constructor(private readonly effects: CoordinatorEffects) {}

  async initialize(): Promise<void> {
    await this.migrateLegacyTerminalBatches();
    const jobs = await this.withJobsLock(async () => {
      const currentJobs = await this.effects.storage.getJobs();
      const interruptedJobs = currentJobs.filter((job) => job.status === 'running' || job.status === 'probing');
      const cancellations = await Promise.all(interruptedJobs.map((job) => (
        this.effects.sendNative({ action: 'cancel', jobId: job.id })
      )));
      if (cancellations.some((response) => !response?.ok)) throw new Error('Could not cancel interrupted native jobs');
      let changed = false;
      for (const job of currentJobs) {
        if (job.status === 'running' || job.status === 'probing') {
          job.status = 'failed';
          job.error = 'Interrupted';
          job.finishedAt = this.effects.now();
          changed = true;
        }
      }
      if (changed) await this.setJobsLocked(currentJobs, true);
      return currentJobs;
    });
    const terminalBatchIds = new Set(jobs
      .filter((job) => job.batchId && !isActive(job))
      .map((job) => job.batchId as string));
    const retryState = await this.withSummaryStateLock(() => this.readSummaryAttemptState());
    for (const [batchId, retry] of Object.entries(retryState)) {
      if (retry.receiptCleanupPending) terminalBatchIds.add(batchId);
    }
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
    try {
      if (cancelled.wasInFlight) await this.effects.sendNative({ action: 'cancel', jobId: id });
      await this.maybeWriteBatchSummary(cancelled.batchId).catch(() => undefined);
    } finally {
      void this.pumpQueue();
    }
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
    try {
      await Promise.all(inFlight.map((jobId) => this.effects.sendNative({ action: 'cancel', jobId })));
      await this.maybeWriteBatchSummary(batchId).catch(() => undefined);
    } finally {
      void this.pumpQueue();
    }
  }

  async clearHistory(): Promise<void> {
    await this.withJobsLock(async () => {
      const jobs = await this.effects.storage.getJobs();
      const pendingTerminalBatches = new Set(jobs.flatMap((job) => (
        job.batchId && !isActive(job) && !job.summaryWritten && !job.summaryExhausted
          ? [job.batchId]
          : []
      )));
      await this.markSummaryHistoryClearPending(pendingTerminalBatches);
      await this.setJobsLocked(jobs, { clearHistory: true });
    });
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

  wakeQueue(): void {
    void this.pumpQueue();
  }

  private pumpQueue(): Promise<void> {
    const wakeVersion = ++this.pumpWakeVersion;
    this.pumpRequested = true;
    if (this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = this.drainRequestedQueue(wakeVersion);
    return this.pumpPromise;
  }

  private async drainRequestedQueue(initialWakeVersion: number): Promise<void> {
    let retries = 0;
    let handledWakeVersion = initialWakeVersion;
    let restartRequested = false;
    try {
      do {
        this.pumpRequested = false;
        const attemptWakeVersion = this.pumpWakeVersion;
        try {
          await this.drainQueue();
          this.queueWakeDelayMs = INITIAL_QUEUE_WAKE_DELAY_MS;
          handledWakeVersion = attemptWakeVersion;
        } catch {
          if (retries >= MAX_QUEUE_PUMP_RETRIES) {
            restartRequested = this.pumpWakeVersion > handledWakeVersion;
            if (!restartRequested) {
              this.effects.scheduleQueueWake(this.queueWakeDelayMs);
              this.queueWakeDelayMs = Math.min(this.queueWakeDelayMs * 2, MAX_QUEUE_WAKE_DELAY_MS);
            }
            return;
          }
          retries += 1;
          await this.effects.delay(100 * retries);
          this.pumpRequested = true;
        }
      } while (this.pumpRequested);
    } finally {
      this.pumpPromise = null;
      if (restartRequested) void this.pumpQueue();
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
      const probe = await this.safeNative({
        action: 'probe',
        url: job.videoUrl,
        components: job.components,
        jobId: job.id,
      });
      const patch: Partial<Job> = {
        status: 'running',
        estBytes: probe?.ok && typeof probe.bytes === 'number' ? probe.bytes : 0,
      };
      if (probe?.ok && typeof probe.title === 'string' && probe.title) patch.label = probe.title;
      if (!(await this.persistCompletedTransition(job.id, patch))) return;
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
    const terminalPatch: Partial<Job> = !response?.ok ? {
      status: 'failed',
      error: typeof response?.error === 'string' ? response.error : 'Download failed',
      finishedAt: this.effects.now(),
    } : {
      status: 'done',
      folder: typeof response.windowsFolderPath === 'string'
        ? response.windowsFolderPath
        : typeof response.folderPath === 'string' ? response.folderPath : '',
      finishedAt: this.effects.now(),
      ...(typeof response.bytes === 'number' && response.bytes > 0 ? { estBytes: response.bytes } : {}),
    };
    const completed = await this.persistCompletedTransition(job.id, terminalPatch);
    if (!completed) {
      await this.maybeWriteBatchSummary(job.batchId).catch(() => undefined);
      return;
    }

    if (response?.ok) {
      const folder = terminalPatch.folder as string;
      if (settings.notifyOnDone) this.effects.notify(job.label, folder);
      if (settings.autoOpenFolder && folder && !job.batchId) await this.effects.openFolder(folder);
    }
    await this.maybeWriteBatchSummary(job.batchId).catch(() => undefined);
  }

  private async safeNative(payload: Record<string, unknown>): Promise<NativeResponse | null> {
    try {
      return await this.effects.sendNative(payload);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Native helper failed' };
    }
  }

  private async persistCompletedTransition(id: string, patch: Partial<Job>): Promise<boolean> {
    let failures = 0;
    while (true) {
      try {
        return await this.updateJob(id, patch, true);
      } catch {
        failures += 1;
        await this.effects.delay(Math.min(QUEUE_WRITE_RETRY_DELAY_MS * failures, MAX_QUEUE_WRITE_RETRY_DELAY_MS));
      }
    }
  }

  private async updateJob(id: string, patch: Partial<Job>, persistUntilStored = false): Promise<boolean> {
    return this.mutateJobs((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0 || jobs[index].status === 'cancelled') return { changed: false, value: false };
      jobs[index] = { ...jobs[index], ...patch };
      return { changed: true, value: true, options: !!jobs[index].batchId, persistUntilStored };
    });
  }

  private trim(
    jobs: Job[],
    options: { clearHistory?: boolean; finalizedBatchId?: string; discardBatchId?: string } = {},
  ): Job[] {
    const settings = this.effects.getSettings();
    const protectedBatchIds = new Set(jobs.flatMap((job) => (
      job.batchId && job.batchId !== options.finalizedBatchId
        && (isActive(job) || (!job.summaryWritten && !job.summaryExhausted))
        ? [job.batchId]
        : []
    )));
    const isProtected = (job: Job) => !!job.batchId && protectedBatchIds.has(job.batchId);
    let result = jobs;
    if (options.discardBatchId) {
      result = result.filter((job) => job.batchId !== options.discardBatchId || isActive(job));
    }
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
    options: boolean | { clearHistory?: boolean; finalizedBatchId?: string; discardBatchId?: string } = false,
    persistUntilStored = false,
  ): Promise<void> {
    const preserveAllFinished = options === true;
    const retainedJobs = preserveAllFinished ? jobs : this.trim(jobs, typeof options === 'object' ? options : {});
    let failures = 0;
    while (true) {
      try {
        await this.effects.storage.setJobs(retainedJobs);
        break;
      } catch (error) {
        if (!persistUntilStored && failures >= MAX_QUEUE_PUMP_RETRIES) throw error;
        failures += 1;
        await this.effects.delay(Math.min(QUEUE_WRITE_RETRY_DELAY_MS * failures, MAX_QUEUE_WRITE_RETRY_DELAY_MS));
      }
    }
    if (!preserveAllFinished) await this.reconcileSummaryAttempts(retainedJobs).catch(() => undefined);
  }

  private async mutateJobs<T>(
    mutation: (jobs: Job[]) => {
      changed: boolean;
      value: T;
      options?: boolean | { clearHistory?: boolean; finalizedBatchId?: string; discardBatchId?: string };
      persistUntilStored?: boolean;
    },
    options: boolean | { clearHistory?: boolean; finalizedBatchId?: string; discardBatchId?: string } = false,
  ): Promise<T> {
    return this.withJobsLock(async () => {
      const jobs = await this.effects.storage.getJobs();
      const result = mutation(jobs);
      if (result.changed) await this.setJobsLocked(jobs, result.options ?? options, result.persistUntilStored);
      const { value } = result;
      return value;
    });
  }

  private async maybeWriteBatchSummary(batchId?: string): Promise<void> {
    if (!batchId) return;
    const inFlight = this.summaryPromises.get(batchId);
    if (inFlight) return inFlight;

    let failed = false;
    const operation = this.summaryTail.then(() => this.finalizeBatchSummary(batchId)).then(() => {
      this.summaryRetryCounts.delete(batchId);
    }).catch((error) => {
      failed = true;
      throw error;
    }).finally(() => {
      this.summaryPromises.delete(batchId);
      if (failed) this.scheduleBatchSummaryRetry(batchId);
    });
    this.summaryTail = operation.catch(() => undefined);
    this.summaryPromises.set(batchId, operation);
    return operation;
  }

  private scheduleBatchSummaryRetry(batchId: string): void {
    const retryCount = (this.summaryRetryCounts.get(batchId) ?? 0) + 1;
    if (retryCount > MAX_SUMMARY_BACKGROUND_RETRIES) return;
    this.summaryRetryCounts.set(batchId, retryCount);
    void this.effects.delay(QUEUE_WRITE_RETRY_DELAY_MS * retryCount).then(() => {
      void this.maybeWriteBatchSummary(batchId).catch(() => undefined);
    });
  }

  private async finalizeBatchSummary(batchId: string): Promise<void> {
    const retry = await this.getSummaryRetry(batchId);
    if (retry.receiptCleanupPending) {
      await this.finalizeBatchJobs(batchId, retry.receiptCleanupPending);
      if (await this.cleanupBatchSummaryReceipt(batchId)) await this.clearSummaryAttempts(batchId);
      return;
    }
    const jobs = await this.effects.storage.getJobs();
    const members = jobs.filter((job) => job.batchId === batchId);
    if (members.length === 0 || members.some(isActive)) return;
    if (members.some((job) => job.summaryWritten)) {
      if (members.some((job) => job.summaryReceiptCleaned !== true)) {
        await this.setSummaryRetry(batchId, { attempts: retry.attempts, receiptCleanupPending: 'written' });
        await this.finalizeBatchJobs(batchId, 'written');
        if (await this.cleanupBatchSummaryReceipt(batchId)) await this.clearSummaryAttempts(batchId);
        return;
      }
      await this.clearSummaryAttempts(batchId);
      return;
    }
    if (members.some((job) => job.summaryExhausted)) {
      if (members.some((job) => job.summaryReceiptCleaned !== true)) {
        await this.setSummaryRetry(batchId, { attempts: retry.attempts, receiptCleanupPending: 'exhausted' });
        await this.finalizeBatchJobs(batchId, 'exhausted');
        if (await this.cleanupBatchSummaryReceipt(batchId)) await this.clearSummaryAttempts(batchId);
        return;
      }
      await this.clearSummaryAttempts(batchId);
      return;
    }
    const first = members[0];
    const outputRoot = retry.outputRoot ?? this.effects.getSettings().outputRoot;
    const payload = {
      action: 'batch_summary',
      batchId,
      batchLabel: first.batchLabel,
      category: first.category,
      items: members.map((job) => ({ title: job.label, folder: job.folder, status: job.status })),
      options: { outputRoot },
    };

    let attempts = retry.attempts;
    while (attempts < MAX_SUMMARY_ATTEMPTS) {
      attempts += 1;
      await this.setSummaryRetry(batchId, { attempts, outputRoot });
      const response = await this.safeNative(payload);
      if (response?.ok) {
        await this.setSummaryRetry(batchId, { attempts, receiptCleanupPending: 'written' });
        await this.finalizeBatchJobs(batchId, 'written');
        if (await this.cleanupBatchSummaryReceipt(batchId)) await this.clearSummaryAttempts(batchId);
        return;
      }
      if (attempts < MAX_SUMMARY_ATTEMPTS) await this.effects.delay(100 * attempts);
    }

    await this.setSummaryRetry(batchId, { attempts, receiptCleanupPending: 'exhausted' });
    await this.finalizeBatchJobs(batchId, 'exhausted');
    if (await this.cleanupBatchSummaryReceipt(batchId)) await this.clearSummaryAttempts(batchId);
  }

  private async finalizeBatchJobs(batchId: string, outcome: 'written' | 'exhausted'): Promise<void> {
    await this.withJobsLock(async () => {
      const retry = await this.getSummaryRetry(batchId);
      const jobs = await this.effects.storage.getJobs();
      let changed = false;
      for (const job of jobs) {
        if (job.batchId !== batchId) continue;
        if (outcome === 'written') job.summaryWritten = true;
        else job.summaryExhausted = true;
        job.summaryReceiptCleaned = false;
        changed = true;
      }
      if (changed) {
        await this.setJobsLocked(jobs, {
          finalizedBatchId: batchId,
          ...(retry.clearHistoryPending ? { discardBatchId: batchId } : {}),
        });
      }
    });
  }

  private async cleanupBatchSummaryReceipt(batchId: string): Promise<boolean> {
    const response = await this.safeNative({ action: 'batch_summary_finalize', batchId });
    if (!response?.ok) throw new Error('Could not finalize batch summary receipt');
    await this.mutateJobs((jobs) => {
      let changed = false;
      for (const job of jobs) {
        if (job.batchId !== batchId || job.summaryReceiptCleaned === true) continue;
        job.summaryReceiptCleaned = true;
        changed = true;
      }
      return { changed, value: undefined, options: { finalizedBatchId: batchId } };
    });
    return true;
  }

  private async readSummaryAttemptState(): Promise<Record<string, BatchSummaryRetry>> {
    const value = (await this.effects.storage.getValues([SUMMARY_ATTEMPTS_KEY]))[SUMMARY_ATTEMPTS_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const state: Record<string, BatchSummaryRetry> = {};
    for (const [batchId, entry] of Object.entries(value)) {
      if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0) {
        state[batchId] = { attempts: entry };
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const attempts = (entry as { attempts?: unknown }).attempts;
      const outputRoot = (entry as { outputRoot?: unknown }).outputRoot;
      const receiptCleanupPending = (entry as { receiptCleanupPending?: unknown }).receiptCleanupPending;
      const clearHistoryPending = (entry as { clearHistoryPending?: unknown }).clearHistoryPending;
      if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) continue;
      if (outputRoot !== undefined && typeof outputRoot !== 'string') continue;
      if (receiptCleanupPending !== undefined
        && receiptCleanupPending !== 'written' && receiptCleanupPending !== 'exhausted') continue;
      if (clearHistoryPending !== undefined && clearHistoryPending !== true) continue;
      state[batchId] = {
        attempts,
        ...(typeof outputRoot === 'string' ? { outputRoot } : {}),
        ...(receiptCleanupPending ? { receiptCleanupPending } : {}),
        ...(clearHistoryPending ? { clearHistoryPending: true } : {}),
      };
    }
    return state;
  }

  private async migrateLegacyTerminalBatches(): Promise<void> {
    const values = await this.effects.storage.getValues([SUMMARY_SCHEMA_VERSION_KEY]);
    if (values[SUMMARY_SCHEMA_VERSION_KEY] === SUMMARY_SCHEMA_VERSION) return;
    await this.effects.storage.setValues({ [SUMMARY_SCHEMA_VERSION_KEY]: SUMMARY_SCHEMA_VERSION });
  }

  private async getSummaryRetry(batchId: string): Promise<BatchSummaryRetry> {
    return this.withSummaryStateLock(async () => (
      (await this.readSummaryAttemptState())[batchId] ?? { attempts: 0 }
    ));
  }

  private async setSummaryRetry(batchId: string, retry: BatchSummaryRetry): Promise<void> {
    await this.withSummaryStateLock(async () => {
      const state = await this.readSummaryAttemptState();
      state[batchId] = {
        ...retry,
        ...((retry.clearHistoryPending || state[batchId]?.clearHistoryPending)
          ? { clearHistoryPending: true }
          : {}),
      };
      await this.effects.storage.setValues({ [SUMMARY_ATTEMPTS_KEY]: state });
    });
  }

  private async markSummaryHistoryClearPending(batchIds: Set<string>): Promise<void> {
    if (batchIds.size === 0) return;
    await this.withSummaryStateLock(async () => {
      const state = await this.readSummaryAttemptState();
      for (const batchId of batchIds) {
        state[batchId] = { ...(state[batchId] ?? { attempts: 0 }), clearHistoryPending: true };
      }
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
        Object.entries(state).filter(([batchId, retry]) => (
          retainedBatchIds.has(batchId) || !!retry.receiptCleanupPending
        )),
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
