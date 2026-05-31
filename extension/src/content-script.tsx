// Injected into all youtube.com pages.
// - Watch/Live pages: button in the video action row.
// - Shorts pages:     compact icon button in #right-controls, left of settings.
// - Playlist pages:   "Archive Playlist" button near the Shuffle control.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArchiveButton } from './components/ArchiveButton';

const BUTTON_ID = 'tube-vault-btn';
const PLAYLIST_BTN_ID = 'tube-vault-playlist-btn';

let currentUrl = location.href;
let videoInjected = false;
let playlistInjected = false;

// ── Page detection ────────────────────────────────────────────────────────────

function isWatchPage() {
  return (
    location.pathname === '/watch' ||
    location.pathname.startsWith('/shorts/') ||
    location.pathname.startsWith('/live/')
  );
}

function isPlaylistPage() {
  return location.pathname === '/playlist';
}

function getVideoUrl() {
  return location.href.split('&')[0];
}

function getPlaylistUrl() {
  const listId = new URLSearchParams(location.search).get('list');
  return listId ? `https://www.youtube.com/playlist?list=${listId}` : location.href;
}

// ── Injection helpers ─────────────────────────────────────────────────────────

function makeContainer(id: string): HTMLDivElement {
  const el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, {
    display: 'inline-flex',
    alignItems: 'center',
    position: 'relative',
    flexShrink: '0',
  });
  return el;
}

// ── Video / Shorts injection ──────────────────────────────────────────────────

function injectVideoButton(): void {
  if (document.getElementById(BUTTON_ID)) return;
  if (!isWatchPage()) return;

  const isShorts = location.pathname.startsWith('/shorts/');

  if (isShorts) {
    const rightControls = document.querySelector('#right-controls');
    if (!rightControls) return; // caller will retry

    const container = makeContainer(BUTTON_ID);
    const settingsBtn = rightControls.querySelector('.ytp-settings-button');
    if (settingsBtn) {
      rightControls.insertBefore(container, settingsBtn);
    } else {
      rightControls.appendChild(container);
    }
    createRoot(container).render(
      <ArchiveButton getUrl={getVideoUrl} playlist={false} compact />
    );
  } else {
    // Watch / Live: inject into the action row
    const selectors = [
      '#actions-inner #top-level-buttons-computed',
      'ytd-watch-metadata #actions #top-level-buttons-computed',
      '#above-the-fold #top-level-buttons-computed',
      'ytm-slim-video-action-bar-renderer',
    ];
    let target: Element | null = null;
    for (const sel of selectors) {
      target = document.querySelector(sel);
      if (target) break;
    }

    const container = makeContainer(BUTTON_ID);
    if (target) {
      target.appendChild(container);
    } else {
      Object.assign(container.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '9998',
      });
      document.body.appendChild(container);
    }
    createRoot(container).render(
      <ArchiveButton getUrl={getVideoUrl} playlist={false} />
    );
  }

  videoInjected = true;
}

// ── Playlist injection ────────────────────────────────────────────────────────

function injectPlaylistButton(): void {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  if (!isPlaylistPage()) return;

  const selectors = [
    'ytd-playlist-header-renderer #button-sheet',
    'ytd-playlist-header-renderer #buttons',
    'ytd-playlist-header-renderer .metadata-buttons-wrapper',
    'ytd-playlist-header-renderer yt-button-shape',
  ];
  let target: Element | null = null;
  for (const sel of selectors) {
    target = document.querySelector(sel);
    if (target) break;
  }

  const container = makeContainer(PLAYLIST_BTN_ID);
  if (target) {
    target.appendChild(container);
  } else {
    Object.assign(container.style, {
      position: 'fixed',
      bottom: '24px',
      right: '100px',
      zIndex: '9998',
    });
    document.body.appendChild(container);
  }
  createRoot(container).render(
    <ArchiveButton getUrl={getPlaylistUrl} playlist={true} />
  );
  playlistInjected = true;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function removeVideoButton() {
  document.getElementById(BUTTON_ID)?.remove();
  videoInjected = false;
}

function removePlaylistButton() {
  document.getElementById(PLAYLIST_BTN_ID)?.remove();
  playlistInjected = false;
}

// ── SPA navigation ────────────────────────────────────────────────────────────

function onNavigate() {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  removeVideoButton();
  removePlaylistButton();
  if (isWatchPage()) setTimeout(() => tryInjectVideo(10), 500);
  if (isPlaylistPage()) setTimeout(() => tryInjectPlaylist(10), 500);
}

function tryInjectVideo(attempts: number) {
  if (document.getElementById(BUTTON_ID)) return;
  injectVideoButton();
  if (!videoInjected && attempts > 0) setTimeout(() => tryInjectVideo(attempts - 1), 400);
}

function tryInjectPlaylist(attempts: number) {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  injectPlaylistButton();
  if (!playlistInjected && attempts > 0) setTimeout(() => tryInjectPlaylist(attempts - 1), 400);
}

const _pushState = history.pushState.bind(history);
history.pushState = (...args) => {
  _pushState(...args);
  onNavigate();
};
window.addEventListener('popstate', onNavigate);
new MutationObserver(onNavigate).observe(document.documentElement, {
  childList: true,
  subtree: false,
});

if (isWatchPage()) tryInjectVideo(15);
if (isPlaylistPage()) tryInjectPlaylist(15);
