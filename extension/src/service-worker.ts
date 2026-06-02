const NATIVE_HOST = 'com.tube_vault.helper';
const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';
const JOBS_KEY = 'tvJobs';
const MAX_JOBS = 50;

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  label: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  folder?: string;
  error?: string;
}

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

// ── Job storage ───────────────────────────────────────────────────────────────
function getJobs(): Promise<Job[]> {
  return new Promise((res) => chrome.storage.local.get({ [JOBS_KEY]: [] }, (s) => res(s[JOBS_KEY] as Job[])));
}
function setJobs(jobs: Job[]): Promise<void> {
  return new Promise((res) => chrome.storage.local.set({ [JOBS_KEY]: jobs.slice(-MAX_JOBS) }, () => res()));
}
async function updateJob(id: string, patch: Partial<Job>): Promise<void> {
  const jobs = await getJobs();
  const i = jobs.findIndex((j) => j.id === id);
  if (i >= 0) { jobs[i] = { ...jobs[i], ...patch }; await setJobs(jobs); }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ── Serial queue: run one download at a time ──────────────────────────────────
let pumping = false;
async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const jobs = await getJobs();
    if (jobs.some((j) => j.status === 'running')) return;  // one at a time
    const next = jobs.find((j) => j.status === 'queued');
    if (!next) return;
    await updateJob(next.id, { status: 'running' });
    runJob({ ...next, status: 'running' });
  } finally {
    pumping = false;
  }
}

function runJob(job: Job): void {
  const payload = {
    ...job.payload,
    jobId: job.id,
    options: { outputRoot: cachedSettings.outputRoot || DEFAULT_OUTPUT_ROOT },
  };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, async (response) => {
    // If the user cancelled while it ran, keep it cancelled.
    const cur = (await getJobs()).find((j) => j.id === job.id);
    if (cur?.status === 'cancelled') { pumpQueue(); return; }

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
  if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return;
  await updateJob(id, { status: 'cancelled', finishedAt: Date.now() });
  if (job.status === 'running') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'cancel', jobId: id }, () => { void chrome.runtime.lastError; });
  }
  pumpQueue();
}

// On (re)start, any job still marked 'running' is stale — its native message died
// with the previous worker. Mark interrupted, then resume the queue.
(async () => {
  const jobs = await getJobs();
  let changed = false;
  for (const j of jobs) {
    if (j.status === 'running') { j.status = 'failed'; j.error = 'Interrupted'; j.finishedAt = Date.now(); changed = true; }
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

  if (msg.type === 'TUBE_VAULT_CLEAR_HISTORY') {
    getJobs().then((jobs) => setJobs(jobs.filter((j) => j.status === 'queued' || j.status === 'running')).then(() => sendResponse({ ok: true })));
    return true;
  }

  if (msg.type !== 'TUBE_VAULT_REQUEST') return false;

  // A 'custom' download becomes a queued job (non-blocking). Everything else
  // (channel_plan, diagnostics) is a synchronous passthrough.
  if (msg.payload?.action === 'custom') {
    (async () => {
      const jobs = await getJobs();
      const job: Job = { id: uid(), label: msg.label ?? 'Download', payload: msg.payload, status: 'queued', createdAt: Date.now() };
      jobs.push(job);
      await setJobs(jobs);
      sendResponse({ ok: true, jobId: job.id, queued: true });
      pumpQueue();
    })();
    return true;
  }

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
