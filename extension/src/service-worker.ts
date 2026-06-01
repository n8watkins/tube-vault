const NATIVE_HOST = 'com.tube_vault.helper';
const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';

// Cache settings at startup so the message handler never has to wait on storage
let cachedSettings = { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: true };

chrome.storage.local.get(
  { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: true },
  (s) => { cachedSettings = s as typeof cachedSettings; }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.outputRoot) cachedSettings.outputRoot = changes.outputRoot.newValue;
  if (changes.autoOpenFolder) cachedSettings.autoOpenFolder = changes.autoOpenFolder.newValue;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TUBE_VAULT_PING') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, version: response?.version });
      }
    });
    return true;
  }

  if (msg.type !== 'TUBE_VAULT_REQUEST') return false;

  const payload = {
    ...msg.payload,
    options: { outputRoot: cachedSettings.outputRoot || DEFAULT_OUTPUT_ROOT },
  };

  chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
    if (chrome.runtime.lastError) {
      sendResponse({
        ok: false,
        error: chrome.runtime.lastError.message ?? 'Native host connection failed',
      });
      return;
    }
    sendResponse(response);

    if (response?.ok && response?.windowsFolderPath) {
      const winPath: string = response.windowsFolderPath;

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'TubeVault',
        message: `Saved to ${winPath}`,
      });

      if (cachedSettings.autoOpenFolder) {
        chrome.runtime.sendNativeMessage(
          NATIVE_HOST,
          { action: 'open_folder', windowsPath: winPath },
          () => { void chrome.runtime.lastError; }
        );
      }

      createReceipt(winPath);
    }
  });

  return true;
});

function createReceipt(winPath: string): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString();
  const content = [
    'TubeVault Download Receipt',
    `Date: ${dateStr} ${timeStr}`,
    '',
    'Saved to:',
    `  ${winPath}`,
    '',
    'Open that folder to find your files.',
  ].join('\n');

  chrome.downloads.download({
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`,
    filename: `TubeVault/${dateStr} - receipt.txt`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
}
