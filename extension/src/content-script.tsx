// Injected into all youtube.com pages.
// - Watch/Live pages: button in the video action row.
// - Shorts pages:     compact icon button in #right-controls, left of settings.
// - Playlist pages:   "Archive Playlist" button near the Shuffle control.

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ArchiveButton } from './components/ArchiveButton';

const BUTTON_ID = 'tube-vault-btn';
const PLAYLIST_BTN_ID = 'tube-vault-playlist-btn';

let currentUrl = location.href;
let videoInjected = false;
let playlistInjected = false;

// Stored so we can unmount (not just remove the DOM node) on navigation.
let videoRoot: Root | null = null;
let playlistRoot: Root | null = null;

// Stored so rapid navigation can cancel in-flight retry timers.
let videoTimerId: ReturnType<typeof setTimeout> | null = null;
let playlistTimerId: ReturnType<typeof setTimeout> | null = null;

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
    // Insert above the like button in the vertical actions column
    const actionsContainer = document.querySelector('.ytReelPlayerOverlayViewModelActionsContainer');
    if (!actionsContainer) return; // caller will retry

    const container = makeContainer(BUTTON_ID);
    if (actionsContainer.firstElementChild) {
      actionsContainer.insertBefore(container, actionsContainer.firstElementChild);
    } else {
      actionsContainer.appendChild(container);
    }
    videoRoot = createRoot(container);
    videoRoot.render(
      <ArchiveButton getUrl={getVideoUrl} playlist={false} compact />
    );
  } else {
    // Watch / Live: replace YouTube's native download button
    const actionRowSelectors = [
      '#actions-inner #top-level-buttons-computed',
      'ytd-watch-metadata #actions #top-level-buttons-computed',
      '#above-the-fold #top-level-buttons-computed',
      'ytm-slim-video-action-bar-renderer',
    ];
    let target: Element | null = null;
    for (const sel of actionRowSelectors) {
      target = document.querySelector(sel);
      if (target) break;
    }

    const container = makeContainer(BUTTON_ID);
    const downloadBtn = (target ?? document).querySelector('ytd-download-button-renderer');
    if (downloadBtn) {
      downloadBtn.parentElement!.insertBefore(container, downloadBtn);
      downloadBtn.remove();
    } else if (target) {
      target.prepend(container);
    } else {
      Object.assign(container.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '9998',
      });
      document.body.appendChild(container);
    }
    videoRoot = createRoot(container);
    videoRoot.render(
      <ArchiveButton getUrl={getVideoUrl} playlist={false} />
    );
  }

  videoInjected = true;
}

// ── Playlist injection ────────────────────────────────────────────────────────

function injectPlaylistButton(): void {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  if (!isPlaylistPage()) return;

  const container = makeContainer(PLAYLIST_BTN_ID);

  // Prefer inserting directly after the shuffle button
  const shuffleBtn = document.querySelector('ytd-playlist-shuffle-button-renderer')
    ?? document.querySelector('yt-button-shape[aria-label*="Shuffle"]');

  if (shuffleBtn) {
    shuffleBtn.insertAdjacentElement('afterend', container);
  } else {
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
  }
  playlistRoot = createRoot(container);
  playlistRoot.render(
    <ArchiveButton getUrl={getPlaylistUrl} playlist={true} />
  );
  playlistInjected = true;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function removeVideoButton() {
  videoRoot?.unmount();
  videoRoot = null;
  document.getElementById(BUTTON_ID)?.remove();
  videoInjected = false;
}

function removePlaylistButton() {
  playlistRoot?.unmount();
  playlistRoot = null;
  document.getElementById(PLAYLIST_BTN_ID)?.remove();
  playlistInjected = false;
}

// ── SPA navigation ────────────────────────────────────────────────────────────

function onNavigate() {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  // Cancel any in-flight retry chains before tearing down buttons
  if (videoTimerId !== null) { clearTimeout(videoTimerId); videoTimerId = null; }
  if (playlistTimerId !== null) { clearTimeout(playlistTimerId); playlistTimerId = null; }
  removeVideoButton();
  removePlaylistButton();
  if (isWatchPage()) videoTimerId = setTimeout(() => tryInjectVideo(10), 500);
  if (isPlaylistPage()) playlistTimerId = setTimeout(() => tryInjectPlaylist(10), 500);
}

function tryInjectVideo(attempts: number) {
  if (document.getElementById(BUTTON_ID)) return;
  injectVideoButton();
  if (!videoInjected && attempts > 0) {
    videoTimerId = setTimeout(() => tryInjectVideo(attempts - 1), 400);
  }
}

function tryInjectPlaylist(attempts: number) {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  injectPlaylistButton();
  if (!playlistInjected && attempts > 0) {
    playlistTimerId = setTimeout(() => tryInjectPlaylist(attempts - 1), 400);
  }
}

const _pushState = history.pushState.bind(history);
history.pushState = (...args) => {
  _pushState(...args);
  onNavigate();
};
window.addEventListener('popstate', onNavigate);

if (isWatchPage()) tryInjectVideo(15);
if (isPlaylistPage()) tryInjectPlaylist(15);
