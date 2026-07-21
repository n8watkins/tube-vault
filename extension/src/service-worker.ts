import { Job, JobCoordinator, NativeResponse } from './job-coordinator';
import { NamingOptions, defaultNaming, NAMING_KEYS } from './types';

const NATIVE_HOST = 'com.tube_vault.helper';
const JOBS_KEY = 'tvJobs';
const QUEUE_WAKE_ALARM = 'tube-vault-queue-wake';
const namingKeyList = Object.keys(NAMING_KEYS) as (keyof NamingOptions)[];
const namingStorageDefaults = Object.fromEntries(namingKeyList.map((key) => [NAMING_KEYS[key], defaultNaming[key]]));
const settings = {
  outputRoot: '',
  autoOpenFolder: false,
  notifyOnDone: true,
  sponsorblock: 'off' as 'off' | 'mark' | 'remove',
  fasterDownloads: true,
  naming: { ...defaultNaming },
  collectHistory: true,
  historyRetentionDays: 0,
};

function loadSettings(): Promise<void> {
  return getLocalValues({
    outputRoot: '',
    autoOpenFolder: false,
    notifyOnDone: true,
    sponsorblock: 'off',
    fasterDownloads: true,
    collectHistory: true,
    historyRetentionDays: 0,
    ...namingStorageDefaults,
  }).then(applySettings);
}

function applySettings(values: Record<string, unknown>): void {
  if ('outputRoot' in values) settings.outputRoot = typeof values.outputRoot === 'string' ? values.outputRoot : '';
  if ('autoOpenFolder' in values) settings.autoOpenFolder = !!values.autoOpenFolder;
  if ('notifyOnDone' in values) settings.notifyOnDone = values.notifyOnDone !== false;
  if ('sponsorblock' in values) settings.sponsorblock = values.sponsorblock === 'mark' || values.sponsorblock === 'remove' ? values.sponsorblock : 'off';
  if ('fasterDownloads' in values) settings.fasterDownloads = !!values.fasterDownloads;
  if ('collectHistory' in values) settings.collectHistory = values.collectHistory !== false;
  if ('historyRetentionDays' in values) settings.historyRetentionDays = Number(values.historyRetentionDays) || 0;
  for (const key of namingKeyList) {
    if (NAMING_KEYS[key] in values) settings.naming[key] = !!values[NAMING_KEYS[key]];
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  applySettings(Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])));
});

function sendNative(payload: Record<string, unknown>): Promise<NativeResponse | null> {
  return new Promise((resolve) => chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
    resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response as NativeResponse);
  }));
}

function getLocalValues(keys: Record<string, unknown> | string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => chrome.storage.local.get(keys, (values) => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(new Error(error.message || 'Failed to read TubeVault data'));
      return;
    }
    resolve(values);
  }));
}

function setLocalValues(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(new Error(error.message || 'Failed to save TubeVault data'));
      return;
    }
    resolve();
  }));
}

function coordinatorFailure(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : 'TubeVault storage failed',
  };
}

const coordinator = new JobCoordinator({
  storage: {
    getJobs: () => getLocalValues({ [JOBS_KEY]: [] }).then((values) => values[JOBS_KEY] as Job[]),
    setJobs: (jobs) => setLocalValues({ [JOBS_KEY]: jobs }),
    getValues: (keys) => getLocalValues(keys),
    setValues: setLocalValues,
  },
  sendNative,
  now: () => Date.now(),
  generateId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
  notify: (label, folder) => chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'TubeVault - download complete',
    message: folder ? `${label}\nSaved to ${folder}` : label,
  }),
  openFolder: async (folder) => { await sendNative({ action: 'open_folder', windowsPath: folder }); },
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  scheduleQueueWake: (milliseconds) => {
    chrome.alarms.create(QUEUE_WAKE_ALARM, { when: Date.now() + milliseconds });
  },
  getSettings: () => settings,
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_WAKE_ALARM) {
    void ensureCoordinatorReady().then(() => coordinator.wakeQueue()).catch(() => undefined);
  }
});

let coordinatorReady: Promise<void> | null = null;

function ensureCoordinatorReady(): Promise<void> {
  if (coordinatorReady) return coordinatorReady;
  const initializing = loadSettings().then(() => coordinator.initialize());
  const ready = initializing.catch((error) => {
    if (coordinatorReady === ready) coordinatorReady = null;
    throw error;
  });
  coordinatorReady = ready;
  return ready;
}

void ensureCoordinatorReady().catch(() => undefined);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TUBE_VAULT_PING') {
    void ensureCoordinatorReady().then(() => sendNative({ action: 'ping' })).then(async (response) => {
      if (!response?.ok) {
        sendResponse({ ok: false, error: response?.error });
        return;
      }
      const defaultRoot = typeof response.defaultRoot === 'string' ? response.defaultRoot : '';
      await coordinator.seedOutputRoot(defaultRoot);
      sendResponse({ ok: true, version: response.version, platform: response.platform, defaultRoot });
    }).catch((error) => sendResponse(coordinatorFailure(error)));
    return true;
  }

  if (message.type === 'TUBE_VAULT_CANCEL') {
    void ensureCoordinatorReady().then(() => coordinator.cancelJob(message.jobId)).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse(coordinatorFailure(error)),
    );
    return true;
  }
  if (message.type === 'TUBE_VAULT_CANCEL_BATCH') {
    void ensureCoordinatorReady().then(() => coordinator.cancelBatch(message.batchId)).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse(coordinatorFailure(error)),
    );
    return true;
  }
  if (message.type === 'TUBE_VAULT_CLEAR_HISTORY') {
    void ensureCoordinatorReady().then(() => coordinator.clearHistory()).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse(coordinatorFailure(error)),
    );
    return true;
  }
  if (message.type === 'TUBE_VAULT_ENQUEUE') {
    void ensureCoordinatorReady().then(() => coordinator.enqueue(message)).then(sendResponse, (error) => {
      sendResponse(coordinatorFailure(error));
    });
    return true;
  }
  if (message.type !== 'TUBE_VAULT_REQUEST') return false;

  void ensureCoordinatorReady().then(() => {
    const payload = { ...message.payload, options: { outputRoot: settings.outputRoot } };
    return sendNative(payload);
  }).then(
    (response) => sendResponse(response ?? { ok: false, error: 'Native helper failed' }),
    (error) => sendResponse(coordinatorFailure(error)),
  );
  return true;
});
