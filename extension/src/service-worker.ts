import { Job, JobCoordinator, NativeResponse } from './job-coordinator';
import { NamingOptions, defaultNaming, NAMING_KEYS } from './types';

const NATIVE_HOST = 'com.tube_vault.helper';
const JOBS_KEY = 'tvJobs';
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

chrome.storage.local.get({
  outputRoot: '',
  autoOpenFolder: false,
  notifyOnDone: true,
  sponsorblock: 'off',
  fasterDownloads: true,
  collectHistory: true,
  historyRetentionDays: 0,
  ...namingStorageDefaults,
}, applySettings);

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

const coordinator = new JobCoordinator({
  storage: {
    getJobs: () => new Promise((resolve) => chrome.storage.local.get({ [JOBS_KEY]: [] }, (values) => resolve(values[JOBS_KEY] as Job[]))),
    setJobs: (jobs) => new Promise((resolve) => chrome.storage.local.set({ [JOBS_KEY]: jobs }, resolve)),
    getValues: (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve)),
    setValues: (values) => new Promise((resolve) => chrome.storage.local.set(values, resolve)),
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
  getSettings: () => settings,
});

void coordinator.initialize();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TUBE_VAULT_PING') {
    void sendNative({ action: 'ping' }).then(async (response) => {
      if (!response?.ok) {
        sendResponse({ ok: false, error: response?.error });
        return;
      }
      const defaultRoot = typeof response.defaultRoot === 'string' ? response.defaultRoot : '';
      await coordinator.seedOutputRoot(defaultRoot);
      sendResponse({ ok: true, version: response.version, platform: response.platform, defaultRoot });
    });
    return true;
  }

  if (message.type === 'TUBE_VAULT_CANCEL') {
    void coordinator.cancelJob(message.jobId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'TUBE_VAULT_CANCEL_BATCH') {
    void coordinator.cancelBatch(message.batchId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'TUBE_VAULT_CLEAR_HISTORY') {
    void coordinator.clearHistory().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'TUBE_VAULT_ENQUEUE') {
    void coordinator.enqueue(message).then(sendResponse);
    return true;
  }
  if (message.type !== 'TUBE_VAULT_REQUEST') return false;

  const payload = { ...message.payload, options: { outputRoot: settings.outputRoot } };
  void sendNative(payload).then((response) => sendResponse(response ?? { ok: false, error: 'Native helper failed' }));
  return true;
});
