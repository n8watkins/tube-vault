const NATIVE_HOST = 'com.tube_vault.helper';
const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';
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
  folder?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const isActive = (j: Job) => j.status === 'queued' || j.status === 'probing' || j.status === 'running';

// ── Settings cache ────────────────────────────────────────────────────────────
let cachedSettings = { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: true };
chrome.storage.local.get(
  { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: true },
  (s) => { cachedSettings = { ...cachedSettings, ...(s as typeof cachedSettings) }; }
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.outputRoot) cachedSettings.outputRoot = changes.outputRoot.newValue;
  if (changes.autoOpenFolder) cachedSettings.autoOpenFolder = changes.autoOpenFolder.newValue;
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
// Keep every active job; cap finished history at MAX_HISTORY (drop oldest finished).
function trim(jobs: Job[]): Job[] {
  const finishedIdx = jobs.map((j, i) => ({ j, i })).filter((x) => !isActive(x.j));
  const drop = Math.max(0, finishedIdx.length - MAX_HISTORY);
  if (drop === 0) return jobs;
  const dropSet = new Set(finishedIdx.slice(0, drop).map((x) => x.i));
  return jobs.filter((_, i) => !dropSet.has(i));
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
    const jobs = await getJobs();
    if (jobs.some((j) => j.status === 'running' || j.status === 'probing')) return;  // one at a time
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) return;
    runJob(next);
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
    const probe = await sendNative({ action: 'probe', url: job.videoUrl });
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
    options: { outputRoot: cachedSettings.outputRoot || DEFAULT_OUTPUT_ROOT },
  };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, async (response) => {
    if (await isCancelled(job.id)) { pumpQueue(); return; }

    if (chrome.runtime.lastError || !response?.ok) {
      const err = chrome.runtime.lastError?.message ?? response?.error ?? 'Download failed';
      await updateJob(job.id, { status: 'failed', error: err, finishedAt: Date.now() });
    } else {
      const folder: string = response.windowsFolderPath ?? response.folderPath ?? '';
      await updateJob(job.id, { status: 'done', folder, finishedAt: Date.now() });
      notifyDone(job.label, folder);
      if (cachedSettings.autoOpenFolder && folder) {
        chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'open_folder', windowsPath: folder }, () => { void chrome.runtime.lastError; });
      }
      if (folder) createReceipt(folder);
    }
    pumpQueue();
  });
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
      sendResponse(chrome.runtime.lastError || !response?.ok ? { ok: false, error: chrome.runtime.lastError?.message } : { ok: true, version: response.version });
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
      const valid = items.filter((it) => it && typeof it.url === 'string');
      if (valid.length === 0) { sendResponse({ ok: false, error: 'No videos to enqueue' }); return; }
      const batchId = valid.length > 1 || batchLabel ? uid() : undefined;
      const jobs = await getJobs();
      for (const it of valid) {
        jobs.push({
          id: uid(),
          batchId, batchLabel,
          videoUrl: it.url,
          label: it.title || it.url,
          components,
          status: 'queued',
          estBytes: typeof it.bytes === 'number' && it.bytes > 0 ? it.bytes : undefined,
          createdAt: Date.now(),
        });
      }
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

function createReceipt(winPath: string): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const content = [
    'TubeVault Download Receipt',
    `Date: ${dateStr} ${now.toLocaleTimeString()}`,
    '',
    'Saved to:',
    `  ${winPath}`,
  ].join('\n');
  chrome.downloads.download({
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`,
    filename: `TubeVault/${dateStr} - receipt.txt`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
}
