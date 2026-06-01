// Injected into all youtube.com pages.
// - Watch/Live pages: button in the video action row (replaces download button).
// - Shorts pages:     button at top of reel-action-bar-view-model, above like button.
// - Playlist pages:   "Archive Playlist" button after shuffle button.
//   Works on both standalone /playlist pages and /watch?list= pages (sidebar panel).

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ArchiveButton } from './components/ArchiveButton';

const BUTTON_ID = 'tube-vault-btn';
const PLAYLIST_BTN_ID = 'tube-vault-playlist-btn';

let currentUrl = location.href;
let videoInjected = false;
let playlistInjected = false;

let videoRoot: Root | null = null;
let playlistRoot: Root | null = null;

let videoTimerId: ReturnType<typeof setTimeout> | null = null;
let playlistTimerId: ReturnType<typeof setTimeout> | null = null;

// Shorts-specific observers — kept alive across scroll navigation
let shortsIo: IntersectionObserver | null = null;
let shortsMo: MutationObserver | null = null;

// ── Page detection ────────────────────────────────────────────────────────────

function isWatchPage() {
  return (
    location.pathname === '/watch' ||
    location.pathname.startsWith('/shorts/') ||
    location.pathname.startsWith('/live/')
  );
}

function isPlaylistContext() {
  if (location.pathname === '/playlist') return true;
  // Watch page with a playlist in the sidebar
  if (isWatchPage() && new URLSearchParams(location.search).has('list')) return true;
  return false;
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

function getVisibleReelActionBar(): Element | null {
  const bars = document.querySelectorAll('reel-action-bar-view-model');
  for (const bar of bars) {
    const r = bar.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return bar;
  }
  return null;
}

// ── Shorts observer (handles re-injection on every scroll) ────────────────────

function mountShortsButton(actionBar: Element): void {
  if (actionBar.querySelector(`#${BUTTON_ID}`)) return;

  document.getElementById(BUTTON_ID)?.remove();
  videoRoot?.unmount();
  videoRoot = null;

  const container = makeContainer(BUTTON_ID);
  container.style.marginBottom = '16px';

  if (actionBar.firstElementChild) {
    actionBar.insertBefore(container, actionBar.firstElementChild);
  } else {
    actionBar.appendChild(container);
  }
  videoRoot = createRoot(container);
  videoRoot.render(<ArchiveButton getUrl={getVideoUrl} playlist={false} compact />);
  videoInjected = true;
}

function startShortsObservers(): void {
  if (shortsIo) return;

  shortsIo = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) mountShortsButton(entry.target);
    }
  }, { threshold: 0.5 });

  document.querySelectorAll('reel-action-bar-view-model').forEach(el => shortsIo!.observe(el));

  shortsMo = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.tagName.toLowerCase() === 'reel-action-bar-view-model') {
          shortsIo!.observe(node);
        }
        node.querySelectorAll('reel-action-bar-view-model').forEach(el => shortsIo!.observe(el));
      }
    }
  });
  shortsMo.observe(document.body, { childList: true, subtree: true });
}

function stopShortsObservers(): void {
  shortsIo?.disconnect();
  shortsIo = null;
  shortsMo?.disconnect();
  shortsMo = null;
}

// ── Video / Shorts injection ──────────────────────────────────────────────────

function injectVideoButton(): void {
  if (document.getElementById(BUTTON_ID)) return;
  if (!isWatchPage()) return;

  const isShorts = location.pathname.startsWith('/shorts/');

  if (isShorts) {
    startShortsObservers();
    const actionBar = getVisibleReelActionBar();
    if (!actionBar) return; // caller will retry
    mountShortsButton(actionBar);
  } else {
    // Watch / Live: anchor to the like button — always present and in light DOM.
    // Replace YouTube's download button if it exists, otherwise insert before like.
    const likeBtn =
      document.querySelector('#top-level-buttons-computed ytd-like-button-renderer') ??
      document.querySelector('ytd-watch-metadata ytd-like-button-renderer') ??
      document.querySelector('ytd-like-button-renderer') ??
      document.querySelector('like-button-view-model');

    if (!likeBtn) return; // caller will retry

    const container = makeContainer(BUTTON_ID);
    const downloadBtn = document.querySelector('ytd-download-button-renderer');

    if (downloadBtn) {
      downloadBtn.parentElement!.insertBefore(container, downloadBtn);
      downloadBtn.remove();
    } else {
      likeBtn.parentElement!.insertBefore(container, likeBtn);
    }

    container.style.marginLeft = '8px';
    videoRoot = createRoot(container);
    videoRoot.render(<ArchiveButton getUrl={getVideoUrl} playlist={false} dropUp />);
    videoInjected = true;
  }
}

// ── Playlist injection ────────────────────────────────────────────────────────

function injectPlaylistButton(): void {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  if (!isPlaylistContext()) return;

  // Find the shuffle button — scoped first to the playlist panel (watch+playlist),
  // then to the standalone playlist header (/playlist page).
  const shuffleEl =
    document.querySelector('ytd-playlist-panel-renderer button[aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-panel-renderer [aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-header-renderer button[aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-header-renderer [aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-shuffle-button-renderer');

  const shuffleAnchor =
    shuffleEl?.closest('ytd-toggle-button-renderer') ??
    shuffleEl?.closest('yt-button-shape') ??
    shuffleEl?.closest('ytd-playlist-shuffle-button-renderer') ??
    shuffleEl;

  const container = makeContainer(PLAYLIST_BTN_ID);

  if (shuffleAnchor) {
    shuffleAnchor.insertAdjacentElement('afterend', container);
  } else {
    // Fallback: append to the buttons container
    const fallback =
      document.querySelector('ytd-playlist-panel-renderer #top-level-buttons-computed') ??
      document.querySelector('ytd-playlist-header-renderer #button-sheet') ??
      document.querySelector('ytd-playlist-header-renderer #buttons');

    if (!fallback) return; // caller will retry
    fallback.appendChild(container);
  }

  playlistRoot = createRoot(container);
  playlistRoot.render(<ArchiveButton getUrl={getPlaylistUrl} playlist={true} />);
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
  const wasShorts = currentUrl.includes('/shorts/');
  currentUrl = location.href;
  const isNowShorts = location.pathname.startsWith('/shorts/');

  if (videoTimerId !== null) { clearTimeout(videoTimerId); videoTimerId = null; }
  if (playlistTimerId !== null) { clearTimeout(playlistTimerId); playlistTimerId = null; }

  if (wasShorts && !isNowShorts) stopShortsObservers();

  removeVideoButton();
  removePlaylistButton();
  if (isWatchPage()) videoTimerId = setTimeout(() => tryInjectVideo(10), 500);
  if (isPlaylistContext()) playlistTimerId = setTimeout(() => tryInjectPlaylist(10), 500);
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
history.pushState = (...args) => { _pushState(...args); onNavigate(); };

// Shorts scroll uses replaceState, not pushState
const _replaceState = history.replaceState.bind(history);
history.replaceState = (...args) => { _replaceState(...args); onNavigate(); };

window.addEventListener('popstate', onNavigate);

if (isWatchPage()) tryInjectVideo(15);
if (isPlaylistContext()) tryInjectPlaylist(15);
