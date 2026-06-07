import { NamingOptions, defaultNaming, NAMING_KEYS } from './types';

const NATIVE_HOST = 'com.tube_vault.helper';
// Empty = "let the helper pick the OS-appropriate default" (Windows/WSL Videos
// folder, or ~/Videos on macOS/Linux). The real path is seeded into storage on
// the first successful ping — see TUBE_VAULT_PING below. No hardcoded username.
const DEFAULT_OUTPUT_ROOT = '';
const JOBS_KEY = 'tvJobs';
const MAX_HISTORY = 100;  // finished jobs retained for the History page

type JobStatus = 'queued' | 'probing' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  batchId?: string;        // groups videos from one playlist/channel request
  batchLabel?: string;     // e.g. "Playlist: Interviews" / "MKBHD — top 30"
  videoUrl: string;        // single watch URL
  label: string;           // video title (lazily filled) or URL
  components: Record<string, unknown>;
  status: JobStatus;
  estBytes?: number;       // known size; undefined → probe lazily before download
  index?: number;          // 1-based rank within the selected batch (for numbering)
  total?: number;          // size of the selected batch
  category?: string;       // 'Most Popular' | 'Latest' | 'Playlist' (batches only)
  folder?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const isActive = (j: Job) => j.status === 'queued' || j.status === 'probing' || j.status === 'running';

// ── Settings cache ────────────────────────────────────────────────────────────
const namingKeyList = Object.keys(NAMING_KEYS) as (keyof NamingOptions)[];
let cachedSettings = { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: false, notifyOnDone: true, sponsorblock: 'off' as 'off' | 'mark' | 'remove', fasterDownloads: true, naming: { ...defaultNaming }, collectHistory: true, historyRetentionDays: 0 };
const namingStorageDefaults = Object.fromEntries(namingKeyList.map((k) => [NAMING_KEYS[k], defaultNaming[k]]));
chrome.storage.local.get(
  { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: false, notifyOnDone: true, sponsorblock: 'off', fasterDownloads: true, collectHistory: true, historyRetentionDays: 0, ...namingStorageDefaults },
  (s) => {
    cachedSettings.outputRoot = s.outputRoot ?? cachedSettings.outputRoot;
    cachedSettings.autoOpenFolder = !!s.autoOpenFolder;
    cachedSettings.notifyOnDone = s.notifyOnDone !== false;
    cachedSettings.sponsorblock = (s.sponsorblock as 'off' | 'mark' | 'remove') || 'off';
    cachedSettings.fasterDownloads = !!s.fasterDownloads;
    cachedSettings.collectHistory = s.collectHistory !== false;
    cachedSettings.historyRetentionDays = Number(s.historyRetentionDays) || 0;
    for (const k of namingKeyList) cachedSettings.naming[k] = !!s[NAMING_KEYS[k]];
  }
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.outputRoot) cachedSettings.outputRoot = changes.outputRoot.newValue;
  if (changes.autoOpenFolder) cachedSettings.autoOpenFolder = !!changes.autoOpenFolder.newValue;
  if (changes.notifyOnDone) cachedSettings.notifyOnDone = changes.notifyOnDone.newValue !== false;
  if (changes.sponsorblock) cachedSettings.sponsorblock = (changes.sponsorblock.newValue as 'off' | 'mark' | 'remove') || 'off';
  if (changes.fasterDownloads) cachedSettings.fasterDownloads = !!changes.fasterDownloads.newValue;
  if (changes.collectHistory) cachedSettings.collectHistory = changes.collectHistory.newValue !== false;
  if (changes.historyRetentionDays) cachedSettings.historyRetentionDays = Number(changes.historyRetentionDays.newValue) || 0;
  for (const k of namingKeyList) {
    const c = changes[NAMING_KEYS[k]];
    if (c) cachedSettings.naming[k] = !!c.newValue;
  }
});

// ── Native messaging helper (promise) ─────────────────────────────────────────
function sendNative(payload: Record<string, unknown>): Promise<any> {
  return new Promise((res) =>
    chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (r) => res(chrome.runtime.lastError ? null : r))
  );
}

// ── Job storage ───────────────────────────────────────────────────────────────
function getJobs(): Promise<Job[]> {
  return new Promise((res) => chrome.storage.local.get({ [JOBS_KEY]: [] }, (s) => res(s[JOBS_KEY] as Job[])));
}
// Keep every active job. Finished jobs are subject to the privacy/retention
// settings: dropped entirely when history collection is off, aged out past the
// retention window, then capped at MAX_HISTORY (oldest finished dropped first).
function trim(jobs: Job[]): Job[] {
  let result = jobs;
  if (!cachedSettings.collectHistory) {
    result = result.filter(isActive);
  } else if (cachedSettings.historyRetentionDays > 0) {
    const cutoff = Date.now() - cachedSettings.historyRetentionDays * 86_400_000;
    result = result.filter((j) => isActive(j) || (j.finishedAt ?? 0) >= cutoff);
  }
  const finishedIdx = result.map((j, i) => ({ j, i })).filter((x) => !isActive(x.j));
  const drop = Math.max(0, finishedIdx.length - MAX_HISTORY);
  if (drop === 0) return result;
  const dropSet = new Set(finishedIdx.slice(0, drop).map((x) => x.i));
  return result.filter((_, i) => !dropSet.has(i));
}
function setJobs(jobs: Job[]): Promise<void> {
  return new Promise((res) => chrome.storage.local.set({ [JOBS_KEY]: trim(jobs) }, () => res()));
}
async function updateJob(id: string, patch: Partial<Job>): Promise<void> {
  const jobs = await getJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i >= 0) { jobs[i] = { ...jobs[i], ...patch }; await setJobs(jobs); }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ── Serial queue: probe + download one job at a time ──────────────────────────
let pumping = false;
async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    // Drain queued jobs one at a time. Holding `pumping` across the await is what
    // makes selection safe: runJob resolves only once the job has left 'queued'
    // (now 'probing'/'running'/'cancelled' in storage), so a concurrent pumpQueue
    // can never re-select the same job and start it twice.
    while (true) {
      const jobs = await getJobs();
      if (jobs.some((j) => j.status === 'running' || j.status === 'probing')) break;  // one at a time
      const next = jobs.find((j) => j.status === 'queued');
      if (!next) break;
      await runJob(next);
    }
  } finally {
    pumping = false;
  }
}

async function isCancelled(id: string): Promise<boolean> {
  return (await getJobs()).find((j) => j.id === id)?.status === 'cancelled';
}

async function runJob(job: Job): Promise<void> {
  // Lazily fetch size + title just before downloading (serial = no rate-limit burst).
  if (job.estBytes === undefined) {
    await updateJob(job.id, { status: 'probing' });
    const probe = await sendNative({ action: 'probe', url: job.videoUrl, components: job.components });
    if (await isCancelled(job.id)) { pumpQueue(); return; }
    const patch: Partial<Job> = { status: 'running', estBytes: probe?.ok && typeof probe.bytes === 'number' ? probe.bytes : 0 };
    if (probe?.ok && probe.title) patch.label = probe.title;
    await updateJob(job.id, patch);
    job = { ...job, ...patch };
  } else {
    await updateJob(job.id, { status: 'running' });
  }

  const payload = {
    action: 'custom',
    url: job.videoUrl,
    components: job.components,
    jobId: job.id,
    index: job.index,
    total: job.total,
    category: job.category,
    options: { outputRoot: cachedSettings.outputRoot || DEFAULT_OUTPUT_ROOT, naming: cachedSettings.naming, sponsorblock: cachedSettings.sponsorblock, fasterDownloads: cachedSettings.fasterDownloads },
  };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, async (response) => {
    if (await isCancelled(job.id)) { await maybeWriteBatchSummary(job.batchId); pumpQueue(); return; }

    if (chrome.runtime.lastError || !response?.ok) {
      const err = chrome.runtime.lastError?.message ?? response?.error ?? 'Download failed';
      await updateJob(job.id, { status: 'failed', error: err, finishedAt: Date.now() });
    } else {
      const folder: string = response.windowsFolderPath ?? response.folderPath ?? '';
      const actual = typeof response.bytes === 'number' && response.bytes > 0 ? { estBytes: response.bytes } : {};
      await updateJob(job.id, { status: 'done', folder, finishedAt: Date.now(), ...actual });
      if (cachedSettings.notifyOnDone) notifyDone(job.label, folder);
      // Auto-open only for single videos so a batch doesn't spawn N Explorer windows.
      if (cachedSettings.autoOpenFolder && folder && !job.batchId) {
        chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'open_folder', windowsPath: folder }, () => { void chrome.runtime.lastError; });
      }
    }
    await maybeWriteBatchSummary(job.batchId);
    pumpQueue();
  });
}

// When the last job of a batch finishes, write the overview .txt for the whole
// playlist/channel download (title, type, every video + where it landed).
async function maybeWriteBatchSummary(batchId?: string): Promise<void> {
  if (!batchId) return;
  const jobs = await getJobs();
  const members = jobs.filter((j) => j.batchId === batchId);
  if (members.length === 0 || members.some(isActive)) return;  // still in progress
  const first = members[0];
  const items = members.map((j) => ({ title: j.label, folder: j.folder, status: j.status }));
  chrome.runtime.sendNativeMessage(
    NATIVE_HOST,
    {
      action: 'batch_summary',
      batchLabel: first.batchLabel,
      category: first.category,
      items,
      options: { outputRoot: cachedSettings.outputRoot || DEFAULT_OUTPUT_ROOT },
    },
    () => { void chrome.runtime.lastError; },
  );
}

async function cancelJob(id: string): Promise<void> {
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job || !isActive(job)) return;
  const wasRunning = job.status === 'running' || job.status === 'probing';
  await updateJob(id, { status: 'cancelled', finishedAt: Date.now() });
  if (wasRunning) {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'cancel', jobId: id }, () => { void chrome.runtime.lastError; });
  }
  pumpQueue();
}

async function cancelBatch(batchId: string): Promise<void> {
  const jobs = await getJobs();
  let activeId: string | undefined;
  for (const j of jobs) {
    if (j.batchId !== batchId || !isActive(j)) continue;
    if (j.status === 'running' || j.status === 'probing') activeId = j.id;  // cancel via native below
    else { j.status = 'cancelled'; j.finishedAt = Date.now(); }
  }
  await setJobs(jobs);
  if (activeId) await cancelJob(activeId); else pumpQueue();
}

// On (re)start, any job left 'running'/'probing' is stale — its native message died
// with the previous worker. Mark interrupted, then resume the queue.
(async () => {
  const jobs = await getJobs();
  let changed = false;
  for (const j of jobs) {
    if (j.status === 'running' || j.status === 'probing') {
      j.status = 'failed'; j.error = 'Interrupted'; j.finishedAt = Date.now(); changed = true;
    }
  }
  if (changed) await setJobs(jobs);
  pumpQueue();
})();

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TUBE_VAULT_PING') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message });
        return;
      }
      const finish = () => sendResponse({ ok: true, version: response.version, platform: response.platform, defaultRoot: response.defaultRoot });
      if (!response.defaultRoot) { finish(); return; }
      // Seed the OS-resolved save folder exactly once, the first time we ever reach
      // the helper, so a fresh install shows a real default instead of a blank. Gate
      // on storage (authoritative — the in-memory cache may not be loaded yet on a
      // cold start, which could otherwise clobber a saved path) plus a one-time flag
      // so we never re-fill a folder the user has intentionally left blank.
      chrome.storage.local.get(['outputRoot', 'outputRootSeeded'], (s) => {
        if (!s.outputRoot && !s.outputRootSeeded) {
          cachedSettings.outputRoot = response.defaultRoot;
          chrome.storage.local.set({ outputRoot: response.defaultRoot, outputRootSeeded: true });
        }
        finish();
      });
    });
    return true;
  }

  if (msg.type === 'TUBE_VAULT_CANCEL') {
    cancelJob(msg.jobId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'TUBE_VAULT_CANCEL_BATCH') {
    cancelBatch(msg.batchId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'TUBE_VAULT_CLEAR_HISTORY') {
    getJobs().then((jobs) => setJobs(jobs.filter(isActive)).then(() => sendResponse({ ok: true })));
    return true;
  }

  // Enqueue one or more per-video jobs (single video = one job; batch = many,
  // grouped by batchId). items: { url, title?, bytes? }[].
  if (msg.type === 'TUBE_VAULT_ENQUEUE') {
    (async () => {
      const items: { url: string; title?: string; bytes?: number | null }[] = msg.items ?? [];
      const components = msg.components ?? {};
      const batchLabel: string | undefined = msg.batchLabel;
      const category: string | undefined = msg.category;
      const valid = items.filter((it) => it && typeof it.url === 'string');
      if (valid.length === 0) { sendResponse({ ok: false, error: 'No videos to enqueue' }); return; }
      const isBatch = valid.length > 1 || !!batchLabel;
      const batchId = isBatch ? uid() : undefined;
      const total = valid.length;
      const jobs = await getJobs();
      valid.forEach((it, i) => {
        jobs.push({
          id: uid(),
          batchId, batchLabel,
          videoUrl: it.url,
          label: it.title || it.url,
          components,
          status: 'queued',
          estBytes: typeof it.bytes === 'number' && it.bytes > 0 ? it.bytes : undefined,
          // Numbering is sequential over the selected set (001 = top of the chosen sort).
          index: isBatch ? i + 1 : undefined,
          total: isBatch ? total : undefined,
          category: isBatch ? category : undefined,
          createdAt: Date.now(),
        });
      });
      await setJobs(jobs);
      sendResponse({ ok: true, batchId, count: valid.length });
      pumpQueue();
    })();
    return true;
  }

  if (msg.type !== 'TUBE_VAULT_REQUEST') return false;

  // Synchronous passthroughs: channel_plan, diagnostics, probe, list_videos.
  const payload = { ...msg.payload, options: { outputRoot: cachedSettings.outputRoot || DEFAULT_OUTPUT_ROOT } };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
    sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response);
  });
  return true;
});

// ── Completion side-effects ───────────────────────────────────────────────────
function notifyDone(label: string, folder: string): void {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'TubeVault — download complete',
    message: folder ? `${label}\nSaved to ${folder}` : label,
  });
}
