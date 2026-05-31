const NATIVE_HOST = 'com.tube_vault.helper';

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

  chrome.runtime.sendNativeMessage(NATIVE_HOST, msg.payload, (response) => {
    if (chrome.runtime.lastError) {
      sendResponse({
        ok: false,
        error: chrome.runtime.lastError.message ?? 'Native host connection failed',
      });
      return;
    }
    sendResponse(response);

    if (response?.ok && response?.windowsFolderPath) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'TubeVault',
        message: `Saved to ${response.windowsFolderPath}`,
      });
    }
  });

  return true; // keep message channel open for async response
});
