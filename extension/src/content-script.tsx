// Injected into all youtube.com pages.
// - Watch/Live pages: button in the video action row (YouTube's own Download
//                     button is hidden with CSS, never removed).
// - Shorts pages:     button in its own container just above YouTube's
//                     reel-action-bar-view-model (a sibling, never inside it).
// - Playlist pages:   "Archive Playlist" button after shuffle button.
//   Works on both standalone /playlist pages and /watch?list= pages (sidebar panel).

import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ArchiveButton } from './components/ArchiveButton';

const BUTTON_ID = 'tube-vault-btn';
const PLAYLIST_BTN_ID = 'tube-vault-playlist-btn';
const CHANNEL_BTN_ID = 'tube-vault-channel-btn';

let currentUrl = location.href;
let playlistInjected = false;
let channelInjected = false;

let videoRoot: Root | null = null;
let playlistRoot: Root | null = null;
let channelRoot: Root | null = null;

let videoTimerId: ReturnType<typeof setTimeout> | null = null;
let playlistTimerId: ReturnType<typeof setTimeout> | null = null;
let channelTimerId: ReturnType<typeof setTimeout> | null = null;

// Tracks which channel the channel-button belongs to, so same-channel SPA nav
// (e.g. Home → Videos, including our own Popular-sort click) doesn't tear it down.
let channelKey: string | null = null;

// Quiet by default. Turn on with `localStorage.tubeVaultDebug = '1'` in the
// YouTube tab's console (content scripts share the page's localStorage), then reload.
const DEBUG = (() => {
  try { return localStorage.getItem('tubeVaultDebug') === '1'; } catch { return false; }
})();
function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[TubeVault]', ...args);
}

// One stylesheet for the rules that let us leave YouTube's own nodes alone.
const STYLE_ID = 'tube-vault-style';
const STYLE_RULES = `
/* Shorts: our container sits just before the action bar inside its flex-row
   wrapper; stack the two so the button lands above the like button. */
div:has(> #${BUTTON_ID}[data-tv-shorts]) {
  flex-direction: column !important;
  align-items: center !important;
  justify-content: flex-end !important;
}
/* Watch: TubeVault takes the place of YouTube's own Download button in the row. */
#${BUTTON_ID} ~ ytd-download-button-renderer { display: none !important; }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_RULES;
  (document.head ?? document.documentElement).appendChild(style);
}

// ── Page detection ────────────────────────────────────────────────────────────

function isShortsPage() {
  return location.pathname.startsWith('/shorts/');
}

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

function isMixContext() {
  const listId = new URLSearchParams(location.search).get('list') ?? '';
  return isWatchPage() && /^RD/.test(listId);
}

function getVideoUrl() {
  // Reconstruct a canonical URL from the ID so param order/extras never matter
  // (e.g. ?app=desktop&v=ID or ?si=...&v=ID would break naive ?-splitting).
  if (location.pathname.startsWith('/shorts/')) {
    return `https://www.youtube.com/shorts/${location.pathname.split('/')[2]}`;
  }
  if (location.pathname.startsWith('/live/')) {
    return `https://www.youtube.com/live/${location.pathname.split('/')[2]}`;
  }
  const v = new URLSearchParams(location.search).get('v');
  return v ? `https://www.youtube.com/watch?v=${v}` : location.href;
}

function getPlaylistUrl() {
  const params = new URLSearchParams(location.search);
  const listId = params.get('list');
  if (!listId) return location.href;
  // Mixes / radios (list=RD…) are "unviewable" as a standalone /playlist page —
  // yt-dlp can only expand them through the watch?v=…&list=… form. Preserve the
  // current watch URL so radio-specific params like start_radio=1 survive.
  if (/^RD/.test(listId)) {
    return location.href;
  }
  return `https://www.youtube.com/playlist?list=${listId}`;
}

// ── Channel detection ─────────────────────────────────────────────────────────

const CHANNEL_RE = /^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)(\/.*)?$/;

function isChannelPage() {
  return CHANNEL_RE.test(location.pathname);
}

function channelBasePath(): string | null {
  const m = location.pathname.match(CHANNEL_RE);
  return m ? `/${m[1]}` : null;
}

function channelVideosUrl(): string {
  const base = channelBasePath();
  return base ? `https://www.youtube.com${base}/videos` : location.href;
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

function isVisibleElement(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisiblePlaylistPanel(): Element | null {
  const panels = document.querySelectorAll('ytd-playlist-panel-renderer');
  for (const panel of panels) {
    if (isVisibleElement(panel)) return panel;
  }
  return null;
}

function getWatchActionRow(): Element | null {
  const selectors = [
    'ytd-watch-metadata #top-level-buttons-computed',
    'ytd-watch-metadata ytd-menu-renderer #top-level-buttons-computed',
    'ytd-watch-metadata #actions-inner #top-level-buttons-computed',
    'ytd-watch-metadata #actions ytd-menu-renderer #top-level-buttons-computed',
    '#top-level-buttons-computed',
    'ytd-watch-metadata #actions-inner ytd-menu-renderer',
    'ytd-watch-metadata #actions ytd-menu-renderer',
    'ytd-watch-metadata #actions-inner',
    'ytd-watch-metadata #actions',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return el;
  }

  return null;
}

// ── Shorts ────────────────────────────────────────────────────────────────────
// YouTube keeps one reel renderer (and one action bar) and swaps its data as you
// scroll between Shorts. Our button lives in its own container placed just
// before that bar, is created once, and stays mounted from Short to Short; it
// reads the current URL only when clicked. If YouTube ever swaps in a new bar,
// the same container (and React root) is moved next to it.

// Kept even while YouTube has it detached, so a re-placement reuses the mounted root.
let shortsContainer: HTMLElement | null = null;

function shortsButtonPlaced(): boolean {
  if (!shortsContainer?.isConnected) return false;
  const bar = shortsContainer.nextElementSibling;
  return !!bar && bar.tagName.toLowerCase() === 'reel-action-bar-view-model' && isVisibleElement(bar);
}

function placeShortsButton(): boolean {
  if (shortsButtonPlaced()) return true;
  const actionBar = getVisibleReelActionBar();
  if (!actionBar?.parentElement) return false;

  if (!shortsContainer) {
    removeVideoButton();
    shortsContainer = makeContainer(BUTTON_ID);
    shortsContainer.dataset.tvShorts = '';
    shortsContainer.style.marginBottom = '16px';
    videoRoot = createRoot(shortsContainer);
    videoRoot.render(<ArchiveButton getUrl={getVideoUrl} playlist={false} compact />);
  }
  ensureStyle();
  actionBar.parentElement.insertBefore(shortsContainer, actionBar);
  debug('shorts: button placed', location.pathname);
  return true;
}

// ── Video / Shorts injection ──────────────────────────────────────────────────

function injectVideoButton(): void {
  if (!isWatchPage()) return;

  if (isShortsPage()) {
    placeShortsButton(); // no-op while the button already sits by the visible bar
    return;
  }
  if (document.getElementById(BUTTON_ID)) return;
  // Watch / Live: anchor to the actions row itself (#top-level-buttons-computed,
  // inside ytd-menu-renderer). The like button is now a deeply-nested
  // segmented-like-dislike-button-view-model, so anchoring to *it* buries our
  // button inside the like/dislike pill where it's invisible. Insert as a direct
  // child of the row, right after the like/dislike segment.
  const actionRow = getWatchActionRow();
  if (!actionRow) return; // caller will retry while YouTube finishes mounting

  const container = makeContainer(BUTTON_ID);
  const downloadBtn = actionRow.querySelector('ytd-download-button-renderer');
  const segmented = actionRow.querySelector('segmented-like-dislike-button-view-model');

  ensureStyle();
  if (downloadBtn?.parentElement) {
    // Take the Download button's slot; the stylesheet hides it while we're there.
    downloadBtn.parentElement.insertBefore(container, downloadBtn);
  } else if (segmented) {
    segmented.insertAdjacentElement('afterend', container);
  } else {
    actionRow.appendChild(container);
  }

  container.style.margin = '0 8px';
  videoRoot = createRoot(container);
  videoRoot.render(<ArchiveButton getUrl={getVideoUrl} playlist={false} dropUp />);
  debug('watch: button injected', location.pathname);
}

// ── Playlist injection ────────────────────────────────────────────────────────

function injectPlaylistButton(): void {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  if (!isPlaylistContext()) return;

  const playlistPanel = getVisiblePlaylistPanel();

  // Find the shuffle button — scoped first to the playlist panel (watch+playlist),
  // then to the standalone playlist header (/playlist page).
  const shuffleEl =
    playlistPanel?.querySelector('button[aria-label*="Shuffle"]') ??
    playlistPanel?.querySelector('[aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-header-renderer button[aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-header-renderer [aria-label*="Shuffle"]') ??
    document.querySelector('ytd-playlist-shuffle-button-renderer');

  const shuffleAnchor =
    shuffleEl?.closest('ytd-toggle-button-renderer') ??
    shuffleEl?.closest('yt-button-shape') ??
    shuffleEl?.closest('ytd-playlist-shuffle-button-renderer') ??
    shuffleEl;

  const container = makeContainer(PLAYLIST_BTN_ID);
  const isMix = isMixContext();

  const playlistActions = playlistPanel?.querySelector('#playlist-actions');
  if (isMix) {
    if (!playlistActions) return; // caller will retry while the visible Mix panel mounts
    Object.assign(container.style, {
      marginRight: '8px',
      marginLeft: '0',
    });
    playlistActions.insertBefore(container, playlistActions.firstChild);
  } else if (shuffleAnchor) {
    shuffleAnchor.insertAdjacentElement('afterend', container);
  } else {
    // Fallback: append to the buttons container
    const fallback =
      playlistPanel?.querySelector('#top-level-buttons-computed') ??
      document.querySelector('ytd-playlist-header-renderer #button-sheet') ??
      document.querySelector('ytd-playlist-header-renderer #buttons');

    if (!fallback) return; // caller will retry
    fallback.appendChild(container);
  }

  playlistRoot = createRoot(container);
  playlistRoot.render(<ArchiveButton getUrl={getPlaylistUrl} playlist={true} playlistLabel={isMix ? 'Mix' : 'Playlist'} />);
  playlistInjected = true;
}

// ── Channel: read the upload count for the disclaimer ─────────────────────────

// The header metadata shows e.g. "@handle • 1.09K subscribers • 288 videos".
function getChannelVideoCount(): number | null {
  const meta =
    document.querySelector('yt-content-metadata-view-model')?.textContent ??
    document.querySelector('.page-header-view-model-wiz__page-header-content-metadata')?.textContent ??
    '';
  const m = meta.match(/([\d.,]+)\s*([KMB]?)\s*videos/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const mult = /k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : /b/i.test(m[2]) ? 1e9 : 1;
  return Math.round(num * mult);
}

// Read (don't drive) the current sort of the Videos tab. 'popular' enables
// all-time mode. The sort chips render as role="tab" buttons carrying
// aria-label (e.g. "Popular") + aria-selected; new layout also marks the active
// chip's inner div with class ytChipShapeActive.
function getSortState(): 'popular' | 'other' | null {
  const chips = document.querySelectorAll(
    'chip-bar-view-model button[role="tab"], chip-view-model button[role="tab"], ' +
    '#chips button[role="tab"], yt-chip-cloud-chip-renderer'
  );
  // Only the sort chips (Latest/Popular/Oldest) count — ignore selected filter
  // chips like "Members only" / "Public".
  let sawOtherSort = false;
  for (const c of Array.from(chips)) {
    const selected =
      c.getAttribute('aria-selected') === 'true' ||
      !!c.querySelector('.ytChipShapeActive, [aria-selected="true"]') ||
      c.classList.contains('iron-selected') ||
      !!c.querySelector('.iron-selected');
    if (!selected) continue;
    const label = (c.getAttribute('aria-label') ?? c.textContent ?? '').trim().toLowerCase();
    if (label.includes('popular')) return 'popular';
    if (/\b(latest|newest|oldest)\b/.test(label)) sawOtherSort = true;
  }
  if (sawOtherSort) return 'other';
  // Older dropdown layout: the trigger's visible text is the current sort.
  const trig = document.querySelector('yt-sort-filter-sub-menu-renderer, ytd-channel-sub-menu-renderer');
  if (trig) {
    const t = (trig.textContent ?? '').toLowerCase();
    if (t.includes('popular')) return 'popular';
    if (t.includes('latest') || t.includes('newest') || t.includes('oldest')) return 'other';
  }
  return null;
}

// Top `count` watch URLs in the order the grid currently shows them.
function readShownUrls(count: number): string[] {
  const scope =
    document.querySelector('ytd-rich-grid-renderer') ??
    document.querySelector('#contents') ??
    document.body;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const a of Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href*="watch?v="]'))) {
    let id: string | null = null;
    try { id = new URL(a.href, location.origin).searchParams.get('v'); } catch { /* skip */ }
    if (id && !seen.has(id)) {
      seen.add(id);
      urls.push(`https://www.youtube.com/watch?v=${id}`);
      if (urls.length >= count) break;
    }
  }
  return urls;
}

// ── Channel injection ─────────────────────────────────────────────────────────

function injectChannelButton(): void {
  if (document.getElementById(CHANNEL_BTN_ID)) return;
  if (!isChannelPage()) return;

  const container = makeContainer(CHANNEL_BTN_ID);

  // New layout (yt-page-header-view-model): the action buttons live inside
  // yt-flexible-actions-view-model, which collapses overflow into a "⋯" menu —
  // so insert as the FIRST child to stay visible. Fall back to the old layout.
  const flexActions = document.querySelector('yt-flexible-actions-view-model');
  if (flexActions) {
    container.style.marginRight = '8px';
    flexActions.insertBefore(container, flexActions.firstChild);
  } else {
    const subscribe =
      document.querySelector('#subscribe-button ytd-subscribe-button-renderer') ??
      document.querySelector('ytd-subscribe-button-renderer') ??
      document.querySelector('yt-subscribe-button-view-model') ??
      document.querySelector('#subscribe-button');
    if (!subscribe?.parentElement) return; // caller will retry
    container.style.marginLeft = '8px';
    subscribe.parentElement.insertBefore(container, subscribe.nextSibling);
  }

  channelRoot = createRoot(container);
  channelRoot.render(
    <ArchiveButton
      getUrl={() => location.href}
      playlist={false}
      channel={{ channelVideosUrl, getVideoCount: getChannelVideoCount, getSortState, readShownUrls }}
    />
  );
  channelKey = channelBasePath();
  channelInjected = true;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function removeChannelButton() {
  channelRoot?.unmount();
  channelRoot = null;
  document.getElementById(CHANNEL_BTN_ID)?.remove();
  channelInjected = false;
}

function removeVideoButton() {
  videoRoot?.unmount();
  videoRoot = null;
  shortsContainer?.remove();
  shortsContainer = null;
  document.getElementById(BUTTON_ID)?.remove();
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
  const wasShorts = new URL(currentUrl).pathname.startsWith('/shorts/');
  currentUrl = location.href;

  if (videoTimerId !== null) { clearTimeout(videoTimerId); videoTimerId = null; }
  if (playlistTimerId !== null) { clearTimeout(playlistTimerId); playlistTimerId = null; }
  if (channelTimerId !== null) { clearTimeout(channelTimerId); channelTimerId = null; }

  // Scrolling from one Short to the next keeps the Shorts button mounted where
  // it is; every other move tears the page's buttons down and re-injects them.
  if (!(wasShorts && isShortsPage())) removeVideoButton();
  removePlaylistButton();
  // Only drop the channel button when we actually leave the channel — keep it
  // mounted (and in its loading state) during same-channel nav like our own
  // Home → Videos → Popular click.
  const newChannelKey = channelBasePath();
  if (newChannelKey !== channelKey) {
    removeChannelButton();
    channelKey = newChannelKey;
  }
  settleUntil = Date.now() + SETTLE_MS;
  stopMountWatch(); // the caller restarts it, with a fresh time limit for this page
  debug('navigate', location.pathname);
  if (isWatchPage()) videoTimerId = setTimeout(() => tryInjectVideo(10), 500);
  if (isPlaylistContext()) playlistTimerId = setTimeout(() => tryInjectPlaylist(10), 500);
  // Re-inject on every channel nav. The guard inside tryInjectChannel makes this a
  // no-op when the button persisted (same-channel nav), and a real retry when it
  // was torn down (moving to a different channel).
  if (isChannelPage()) channelTimerId = setTimeout(() => tryInjectChannel(15), 300);
}

function tryInjectVideo(attempts: number) {
  if (videoButtonReady()) return;
  injectVideoButton();
  if (!videoButtonReady() && attempts > 0) {
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

// Channel headers (yt-flexible-actions-view-model) mount noticeably later than
// the watch/playlist anchors, so — like those — channel needs its own retry chain.
function tryInjectChannel(attempts: number) {
  if (document.getElementById(CHANNEL_BTN_ID)) return;
  injectChannelButton();
  if (!channelInjected && attempts > 0) {
    channelTimerId = setTimeout(() => tryInjectChannel(attempts - 1), 400);
  }
}

function videoButtonReady(): boolean {
  return isShortsPage() ? shortsButtonPlaced() : !!document.getElementById(BUTTON_ID);
}

// True once every button the current page should have is in place.
function buttonsReady(): boolean {
  if (isWatchPage() && !videoButtonReady()) return false;
  if (isPlaylistContext() && !document.getElementById(PLAYLIST_BTN_ID)) return false;
  if (isChannelPage() && !document.getElementById(CHANNEL_BTN_ID)) return false;
  return true;
}

// Inject any button that's missing for the current page. Idempotent.
function ensureButtons() {
  if (isWatchPage() && !videoButtonReady()) injectVideoButton();
  if (isPlaylistContext() && !document.getElementById(PLAYLIST_BTN_ID)) injectPlaylistButton();
  if (isChannelPage() && !document.getElementById(CHANNEL_BTN_ID)) injectChannelButton();
}

function syncForCurrentPage() {
  if (!extAlive()) { teardown(); return; }  // extension reloaded — stop touching dead chrome.* APIs
  if (location.href !== currentUrl) onNavigate(); // URL changed → tear down old page's buttons
  ensureButtons();
  const settling = Date.now() < settleUntil;
  if (buttonsReady() && !settling) stopMountWatch();
  else startMountWatch();
  if (settling) scheduleSettleCheck();
}

// ── Mount watch ───────────────────────────────────────────────────────────────
// While a button is still missing (YouTube is building the page), watch the DOM
// so it lands as soon as its anchor exists. The observer disconnects as soon as
// every button for the current URL is in place, or after MOUNT_WATCH_MAX_MS for
// pages that never grow an anchor; it is not left running on a settled page.
const MOUNT_WATCH_MAX_MS = 20_000;
// YouTube often fires the URL change before it re-renders the page, so a button
// injected straight away can land in the outgoing action row and be thrown out
// with it. Keep watching for this long after each navigation (and the first
// load) even once the buttons exist.
const SETTLE_MS = 6_000;
let settleUntil = Date.now() + SETTLE_MS;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let mountObserver: MutationObserver | null = null;
let mountWatchTimer: ReturnType<typeof setTimeout> | null = null;
let mountSyncQueued = false;

function scheduleSettleCheck(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settleTimer = null; syncForCurrentPage(); }, Math.max(0, settleUntil - Date.now()) + 50);
}

function startMountWatch(): void {
  if (mountObserver || tornDown) return;
  mountObserver = new MutationObserver(() => {
    if (mountSyncQueued) return;
    mountSyncQueued = true;
    setTimeout(() => { mountSyncQueued = false; syncForCurrentPage(); }, 200);
  });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });
  mountWatchTimer = setTimeout(stopMountWatch, MOUNT_WATCH_MAX_MS);
  debug('mount watch: started', location.pathname);
}

function stopMountWatch(): void {
  if (!mountObserver) return;
  mountObserver.disconnect();
  mountObserver = null;
  if (mountWatchTimer !== null) { clearTimeout(mountWatchTimer); mountWatchTimer = null; }
  debug('mount watch: stopped', location.pathname);
}

// When the extension is reloaded/updated, this content script keeps running on the
// already-open page but its chrome.* APIs are invalidated — every storage/runtime
// call then throws "Cannot read properties of undefined (reading 'local')". Detect
// that and go quiet (stop the watchdog + observers) until the page is reloaded.
function extAlive(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}
let tornDown = false;
function teardown(): void {
  if (tornDown) return;
  tornDown = true;
  try { clearInterval(watchdogTimer); } catch { /* ignore */ }
  if (settleTimer !== null) clearTimeout(settleTimer);
  stopMountWatch();
  window.removeEventListener('popstate', syncForCurrentPage);
  window.removeEventListener('yt-navigate-finish', syncForCurrentPage);
  document.removeEventListener('yt-navigate-finish', syncForCurrentPage);
  document.removeEventListener('yt-page-data-updated', syncForCurrentPage);
  navigationApi()?.removeEventListener('currententrychange', syncForCurrentPage);
  debug('extension context invalidated — content script stopped; reload the page');
}

// ── Navigation signals ────────────────────────────────────────────────────────
// The content script runs in an isolated world, so it can't hook the page's
// history.pushState. It can still hear about every URL change: the Navigation
// API's currententrychange fires for pushState/replaceState from any world
// (Shorts scrolling included), and YouTube's own yt-navigate-finish /
// yt-page-data-updated DOM events cross the world boundary. ensureButtons is
// idempotent, so overlapping signals are harmless.
interface NavigationLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
function navigationApi(): NavigationLike | null {
  return (window as unknown as { navigation?: NavigationLike }).navigation ?? null;
}

navigationApi()?.addEventListener('currententrychange', syncForCurrentPage);
window.addEventListener('popstate', syncForCurrentPage);
window.addEventListener('yt-navigate-finish', syncForCurrentPage);
document.addEventListener('yt-navigate-finish', syncForCurrentPage);
document.addEventListener('yt-page-data-updated', syncForCurrentPage);

// Loaded version, readable from the page console: document.documentElement.dataset.tvVersion
let tvVersion = '?';
try { tvVersion = chrome.runtime.getManifest().version; document.documentElement.dataset.tvVersion = tvVersion; } catch { /* ignore */ }
debug(`content script loaded v${tvVersion}`);

// Slow safety net for anything the signals above miss (for example YouTube
// re-rendering an action row in place): a few cheap lookups, skipped while the
// tab is hidden, that re-arm the mount watch only when a button is missing.
const WATCHDOG_MS = 5_000;
const watchdogTimer = setInterval(() => {
  if (!extAlive()) { teardown(); return; }
  if (document.hidden) return;
  if (location.href !== currentUrl || !buttonsReady()) syncForCurrentPage();
}, WATCHDOG_MS);

// Initial injection on first load. A fresh channel URL doesn't pass through
// onNavigate, so kick its retry chain here too.
syncForCurrentPage();
if (isChannelPage()) channelTimerId = setTimeout(() => tryInjectChannel(15), 300);
