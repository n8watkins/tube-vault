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
const CHANNEL_BTN_ID = 'tube-vault-channel-btn';

let currentUrl = location.href;
let videoInjected = false;
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

    if (downloadBtn) {
      downloadBtn.parentElement!.insertBefore(container, downloadBtn);
      downloadBtn.remove();
    } else if (segmented) {
      segmented.insertAdjacentElement('afterend', container);
    } else {
      actionRow.appendChild(container);
    }

    container.style.margin = '0 8px';
    videoRoot = createRoot(container);
    videoRoot.render(<ArchiveButton getUrl={getVideoUrl} playlist={false} dropUp />);
    videoInjected = true;
    console.log('[TubeVault] watch: button injected ✓', location.pathname);
  }
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
  if (channelTimerId !== null) { clearTimeout(channelTimerId); channelTimerId = null; }

  if (wasShorts && !isNowShorts) stopShortsObservers();

  removeVideoButton();
  removePlaylistButton();
  // Only drop the channel button when we actually leave the channel — keep it
  // mounted (and in its loading state) during same-channel nav like our own
  // Home → Videos → Popular click.
  const newChannelKey = channelBasePath();
  if (newChannelKey !== channelKey) {
    removeChannelButton();
    channelKey = newChannelKey;
  }
  if (isWatchPage()) videoTimerId = setTimeout(() => tryInjectVideo(10), 500);
  if (isPlaylistContext()) playlistTimerId = setTimeout(() => tryInjectPlaylist(10), 500);
  // Re-inject on every channel nav. The guard inside tryInjectChannel makes this a
  // no-op when the button persisted (same-channel nav), and a real retry when it
  // was torn down (moving to a different channel).
  if (isChannelPage()) channelTimerId = setTimeout(() => tryInjectChannel(15), 300);
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

// Channel headers (yt-flexible-actions-view-model) mount noticeably later than
// the watch/playlist anchors, so — like those — channel needs its own retry chain
// rather than waiting on the 1.5s heartbeat. Without this, a freshly-loaded
// channel's button only appears on a later heartbeat tick (or not at all if the
// anchor settled between ticks); the persisted button on same-channel back-nav
// masked the gap.
function tryInjectChannel(attempts: number) {
  if (document.getElementById(CHANNEL_BTN_ID)) return;
  injectChannelButton();
  if (!channelInjected && attempts > 0) {
    channelTimerId = setTimeout(() => tryInjectChannel(attempts - 1), 400);
  }
}

// Re-inject any button that's missing for the current page. The observer below
// calls this repeatedly as YouTube builds the new page, so injection lands as
// soon as the anchor element exists — no fixed retry budget needed.
function ensureButtons() {
  if (isWatchPage() && !document.getElementById(BUTTON_ID)) {
    console.log('[TubeVault] ensure: watch page, button missing → injecting', location.pathname);
    injectVideoButton();
  }
  if (isPlaylistContext() && !document.getElementById(PLAYLIST_BTN_ID)) injectPlaylistButton();
  if (isChannelPage() && !document.getElementById(CHANNEL_BTN_ID)) {
    console.log('[TubeVault] ensure: channel page, button missing → injecting', location.pathname);
    injectChannelButton();
  }
}

function syncForCurrentPage() {
  if (location.href !== currentUrl) onNavigate(); // URL changed → tear down old page's buttons
  ensureButtons();
}

// YouTube is an SPA, but a content script runs in an ISOLATED world: it cannot
// intercept the page's history.pushState (a different world's object), and the
// page's yt-navigate-* events don't reliably cross the world boundary. The one
// thing both worlds share is the DOM — which YouTube rebuilds on every nav — so
// we watch that directly. Throttled so steady-state mutations stay cheap.
let syncQueued = false;
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  setTimeout(() => { syncQueued = false; syncForCurrentPage(); }, 200);
}

const navObserver = new MutationObserver(queueSync);
navObserver.observe(document.documentElement, { childList: true, subtree: true });

// Belt-and-suspenders nav signals — ensureButtons is idempotent, so firing from
// several sources is harmless and just makes injection land sooner.
window.addEventListener('popstate', syncForCurrentPage);
// YouTube's own SPA nav events DO reach content-script listeners on document/
// window (DOM events cross the isolated world even though page JS variables don't).
const onYtNav = () => syncForCurrentPage();
window.addEventListener('yt-navigate-finish', onYtNav);
document.addEventListener('yt-navigate-finish', onYtNav);
document.addEventListener('yt-page-data-updated', onYtNav);

// Diagnostic markers readable from the PAGE console (shared DOM): confirms which
// content-script version is live and that its timer is actually ticking.
//   document.documentElement.dataset.tvVersion  → loaded version
//   document.documentElement.dataset.tvBeat      → updates every 1.5s if alive
let tvVersion = '?';
try { tvVersion = chrome.runtime.getManifest().version; document.documentElement.dataset.tvVersion = tvVersion; } catch { /* ignore */ }
console.log(`[TubeVault] content script loaded v${tvVersion} — watching for navigation`);

// Guaranteed safety net: a cheap periodic check re-injects any missing button
// even if every signal above is somehow missed. When buttons are already present
// this is just a few getElementById checks.
let tvBeat = 0;
setInterval(() => {
  tvBeat++;
  document.documentElement.dataset.tvBeat = String(tvBeat);
  if (tvBeat % 4 === 0) console.log(`[TubeVault] alive (beat ${tvBeat}) — path ${location.pathname}`);
  syncForCurrentPage();
}, 1500);

// Initial injection on first load. A fresh channel URL doesn't pass through
// onNavigate, so kick its retry chain here too.
syncForCurrentPage();
if (isChannelPage()) channelTimerId = setTimeout(() => tryInjectChannel(15), 300);
