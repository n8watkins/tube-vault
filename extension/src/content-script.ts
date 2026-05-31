// Injected into all youtube.com pages.
// - Watch/Shorts/Live pages: injects an Archive button near the video actions.
// - Playlist pages: injects an "Archive Playlist" button near the shuffle control.

const BUTTON_ID = 'tube-vault-btn';
const PLAYLIST_BTN_ID = 'tube-vault-playlist-btn';
const VIDEO_MENU_ID = 'tube-vault-menu';
const PLAYLIST_MENU_ID = 'tube-vault-playlist-menu';

// ── Types ─────────────────────────────────────────────────────────────────────

type VideoQuality = 'best' | '1080' | '720' | '480' | '360';
type VideoFormat = 'mp4' | 'webm' | 'mkv';
type AudioFormat = 'm4a' | 'mp3' | 'wav' | 'opus';

interface MenuState {
  video: boolean;
  videoQuality: VideoQuality;
  videoFormat: VideoFormat;
  audio: boolean;
  audioFormat: AudioFormat;
  metadata: boolean;
  thumbnail: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentUrl = location.href;
let videoInjected = false;
let playlistInjected = false;

// Shared across both button types so the user's last selection persists.
const menuState: MenuState = {
  video: true,
  videoQuality: 'best',
  videoFormat: 'mp4',
  audio: false,
  audioFormat: 'm4a',
  metadata: false,
  thumbnail: false,
};

// ── Page detection ────────────────────────────────────────────────────────────

function isWatchPage(): boolean {
  return (
    location.pathname === '/watch' ||
    location.pathname.startsWith('/shorts/') ||
    location.pathname.startsWith('/live/')
  );
}

function isPlaylistPage(): boolean {
  return location.pathname === '/playlist';
}

function getVideoUrl(): string {
  return location.href.split('&')[0];
}

function getPlaylistUrl(): string {
  const listId = new URLSearchParams(location.search).get('list');
  return listId
    ? `https://www.youtube.com/playlist?list=${listId}`
    : location.href;
}

// ── Menu state helpers ────────────────────────────────────────────────────────

function isAllSelected(): boolean {
  return menuState.video && menuState.audio && menuState.metadata && menuState.thumbnail;
}

function noneSelected(): boolean {
  return !menuState.video && !menuState.audio && !menuState.metadata && !menuState.thumbnail;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function createSelect(
  options: { value: string; label: string }[],
  current: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = document.createElement('select');
  Object.assign(sel.style, {
    background: '#383838',
    border: '1px solid #555',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '12px',
    padding: '2px 6px',
    cursor: 'pointer',
  });
  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', (e) => onChange((e.target as HTMLSelectElement).value));
  sel.addEventListener('click', (e) => e.stopPropagation());
  return sel;
}

function createSubRow(labelText: string, select: HTMLSelectElement): HTMLElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    margin: '3px 0',
  });
  const lbl = document.createElement('span');
  lbl.textContent = labelText;
  Object.assign(lbl.style, { fontSize: '12px', color: '#bbb' });
  row.appendChild(lbl);
  row.appendChild(select);
  return row;
}

function createCheckRow(
  id: string,
  labelText: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): { row: HTMLLabelElement; checkbox: HTMLInputElement } {
  const row = document.createElement('label');
  row.htmlFor = id;
  Object.assign(row.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '5px 0',
    cursor: 'pointer',
    userSelect: 'none',
  });
  row.addEventListener('click', (e) => e.stopPropagation());

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = id;
  checkbox.checked = checked;
  Object.assign(checkbox.style, {
    width: '14px',
    height: '14px',
    cursor: 'pointer',
    accentColor: '#cc0000',
    flexShrink: '0',
  });
  checkbox.addEventListener('change', () => onChange(checkbox.checked));

  const text = document.createElement('span');
  text.textContent = labelText;
  Object.assign(text.style, { fontSize: '13px', color: '#fff' });

  row.appendChild(checkbox);
  row.appendChild(text);
  return { row, checkbox };
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function closeAllMenus(): void {
  document.querySelectorAll<HTMLElement>('.tv-menu').forEach((m) => {
    m.style.display = 'none';
  });
}

/**
 * Creates the checkbox archive panel.
 * @param menuId  unique DOM id for this menu instance
 * @param getUrl  returns the URL to archive when the user confirms
 * @param playlist  whether this is a playlist archive (omits --no-playlist in the helper)
 */
function createMenu(menuId: string, getUrl: () => string, playlist: boolean): HTMLElement {
  const panel = document.createElement('div');
  panel.id = menuId;
  panel.className = 'tv-menu';
  Object.assign(panel.style, {
    position: 'absolute',
    top: '100%',
    left: '0',
    marginTop: '6px',
    background: '#212121',
    borderRadius: '10px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
    padding: '12px 14px 10px',
    zIndex: '9999',
    minWidth: '230px',
    color: '#fff',
    fontFamily: 'inherit',
    fontSize: '13px',
  });

  // Header
  const header = document.createElement('div');
  header.textContent = playlist ? 'Archive Playlist' : 'Archive Options';
  Object.assign(header.style, {
    fontSize: '11px',
    fontWeight: '700',
    color: '#aaa',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: '8px',
  });
  panel.appendChild(header);

  // Full Bundle badge
  const bundleBadge = document.createElement('div');
  bundleBadge.textContent = '★ Full Bundle';
  Object.assign(bundleBadge.style, {
    fontSize: '11px',
    color: '#4caf50',
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: '6px',
    display: isAllSelected() ? 'block' : 'none',
  });
  panel.appendChild(bundleBadge);

  // Archive button (forward-declared; referenced in updateUI)
  const archiveBtn = document.createElement('button');

  function updateUI(): void {
    bundleBadge.style.display = isAllSelected() ? 'block' : 'none';
    archiveBtn.disabled = noneSelected();
    archiveBtn.style.opacity = noneSelected() ? '0.4' : '1';
    archiveBtn.style.cursor = noneSelected() ? 'default' : 'pointer';
  }

  // ── Video ──────────────────────────────────────────────────────
  const { row: videoRow } = createCheckRow(`${menuId}-video`, 'Video', menuState.video, (checked) => {
    menuState.video = checked;
    videoOpts.style.display = checked ? 'block' : 'none';
    updateUI();
  });
  panel.appendChild(videoRow);

  const videoOpts = document.createElement('div');
  Object.assign(videoOpts.style, {
    marginLeft: '22px',
    marginBottom: '2px',
    display: menuState.video ? 'block' : 'none',
  });

  const qualitySel = createSelect(
    [
      { value: 'best', label: 'Best' },
      { value: '1080', label: '1080p' },
      { value: '720', label: '720p' },
      { value: '480', label: '480p' },
      { value: '360', label: '360p' },
    ],
    menuState.videoQuality,
    (v) => { menuState.videoQuality = v as VideoQuality; },
  );
  videoOpts.appendChild(createSubRow('Quality', qualitySel));

  const vFormatSel = createSelect(
    [
      { value: 'mp4', label: 'MP4' },
      { value: 'webm', label: 'WebM' },
      { value: 'mkv', label: 'MKV' },
    ],
    menuState.videoFormat,
    (v) => { menuState.videoFormat = v as VideoFormat; },
  );
  videoOpts.appendChild(createSubRow('Format', vFormatSel));
  panel.appendChild(videoOpts);

  // ── Audio ──────────────────────────────────────────────────────
  const { row: audioRow } = createCheckRow(`${menuId}-audio`, 'Audio', menuState.audio, (checked) => {
    menuState.audio = checked;
    audioOpts.style.display = checked ? 'block' : 'none';
    updateUI();
  });
  panel.appendChild(audioRow);

  const audioOpts = document.createElement('div');
  Object.assign(audioOpts.style, {
    marginLeft: '22px',
    marginBottom: '2px',
    display: menuState.audio ? 'block' : 'none',
  });

  const aFormatSel = createSelect(
    [
      { value: 'm4a', label: 'M4A' },
      { value: 'mp3', label: 'MP3' },
      { value: 'wav', label: 'WAV' },
      { value: 'opus', label: 'Opus' },
    ],
    menuState.audioFormat,
    (v) => { menuState.audioFormat = v as AudioFormat; },
  );
  audioOpts.appendChild(createSubRow('Format', aFormatSel));
  panel.appendChild(audioOpts);

  // ── Divider ────────────────────────────────────────────────────
  const divider = document.createElement('div');
  Object.assign(divider.style, { height: '1px', background: '#333', margin: '6px 0' });
  panel.appendChild(divider);

  // ── Metadata ───────────────────────────────────────────────────
  const { row: metaRow } = createCheckRow(`${menuId}-metadata`, 'Metadata', menuState.metadata, (checked) => {
    menuState.metadata = checked;
    updateUI();
  });
  panel.appendChild(metaRow);

  // ── Thumbnail ──────────────────────────────────────────────────
  const { row: thumbRow } = createCheckRow(`${menuId}-thumbnail`, 'Thumbnail', menuState.thumbnail, (checked) => {
    menuState.thumbnail = checked;
    updateUI();
  });
  panel.appendChild(thumbRow);

  // ── Archive confirm button ─────────────────────────────────────
  Object.assign(archiveBtn.style, {
    display: 'block',
    width: '100%',
    marginTop: '10px',
    padding: '8px',
    background: '#cc0000',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '13px',
    fontWeight: '600',
    fontFamily: 'inherit',
    cursor: noneSelected() ? 'default' : 'pointer',
    opacity: noneSelected() ? '0.4' : '1',
  });
  archiveBtn.textContent = playlist ? 'Archive Playlist' : 'Archive';
  archiveBtn.disabled = noneSelected();
  archiveBtn.addEventListener('mouseenter', () => {
    if (!archiveBtn.disabled) archiveBtn.style.background = '#e60000';
  });
  archiveBtn.addEventListener('mouseleave', () => { archiveBtn.style.background = '#cc0000'; });
  archiveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    startRequest(getUrl(), playlist);
  });
  panel.appendChild(archiveBtn);

  panel.addEventListener('click', (e) => e.stopPropagation());
  return panel;
}

function toggleMenu(btn: HTMLElement, menuId: string, getUrl: () => string, playlist: boolean): void {
  let menu = btn.querySelector<HTMLElement>(`#${menuId}`);
  if (!menu) {
    menu = createMenu(menuId, getUrl, playlist);
    btn.style.position = 'relative';
    btn.appendChild(menu);
    menu.style.display = 'block';
    return;
  }
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// ── Buttons ───────────────────────────────────────────────────────────────────

function createArchiveButton(id: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = id;
  btn.textContent = label;
  btn.setAttribute('aria-label', `TubeVault: ${label}`);
  Object.assign(btn.style, {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 16px',
    height: '36px',
    borderRadius: '18px',
    border: 'none',
    background: '#cc0000',
    color: '#fff',
    fontSize: '14px',
    fontWeight: '500',
    fontFamily: 'inherit',
    cursor: 'pointer',
    zIndex: '1000',
    flexShrink: '0',
  });
  return btn;
}

function setBtnState(btnId: string, state: 'idle' | 'loading' | 'done' | 'error', idleLabel: string): void {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return;
  const labels = { idle: idleLabel, loading: 'Archiving…', done: 'Saved ✓', error: 'Failed ✗' };
  const colors = { idle: '#cc0000', loading: '#888', done: '#2e7d32', error: '#b71c1c' };
  btn.textContent = labels[state];
  btn.style.background = colors[state];
  btn.disabled = state === 'loading';
  if (state === 'done' || state === 'error') {
    setTimeout(() => setBtnState(btnId, 'idle', idleLabel), 3000);
  }
}

function showToast(msg: string, isError = false): void {
  const toast = document.createElement('div');
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '80px',
    right: '24px',
    background: isError ? '#b71c1c' : '#2e7d32',
    color: '#fff',
    padding: '10px 18px',
    borderRadius: '8px',
    fontSize: '13px',
    zIndex: '99999',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    transition: 'opacity 0.3s',
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 4000);
}

// ── Download ──────────────────────────────────────────────────────────────────

function startRequest(url: string, playlist: boolean): void {
  const btnId = playlist ? PLAYLIST_BTN_ID : BUTTON_ID;
  const idleLabel = playlist ? 'Archive Playlist' : 'Archive';
  setBtnState(btnId, 'loading', idleLabel);

  const components: Record<string, unknown> = {};
  if (menuState.video) components['video'] = { quality: menuState.videoQuality, format: menuState.videoFormat };
  if (menuState.audio) components['audio'] = { format: menuState.audioFormat };
  if (menuState.metadata) components['metadata'] = true;
  if (menuState.thumbnail) components['thumbnail'] = true;

  chrome.runtime.sendMessage(
    {
      type: 'TUBE_VAULT_REQUEST',
      payload: { action: 'custom', url, components, playlist },
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        const err = chrome.runtime.lastError?.message ?? response?.error ?? 'Unknown error';
        setBtnState(btnId, 'error', idleLabel);
        showToast(`Archive failed: ${err}`, true);
        return;
      }
      setBtnState(btnId, 'done', idleLabel);
      const folder = response.windowsFolderPath ?? response.folderPath ?? '';
      showToast(folder ? `Saved to ${folder}` : 'Archived successfully');
    }
  );
}

// ── Video page injection ──────────────────────────────────────────────────────

function injectVideoButton(): void {
  if (document.getElementById(BUTTON_ID)) return;
  if (!isWatchPage()) return;

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

  const btn = createArchiveButton(BUTTON_ID, 'Archive');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(btn, VIDEO_MENU_ID, getVideoUrl, false);
  });

  if (target) {
    target.appendChild(btn);
  } else {
    Object.assign(btn.style, { position: 'fixed', bottom: '24px', right: '24px', zIndex: '9998' });
    document.body.appendChild(btn);
  }
  videoInjected = true;
}

function removeVideoButton(): void {
  document.getElementById(BUTTON_ID)?.remove();
  videoInjected = false;
}

// ── Playlist page injection ───────────────────────────────────────────────────

function injectPlaylistButton(): void {
  if (document.getElementById(PLAYLIST_BTN_ID)) return;
  if (!isPlaylistPage()) return;

  // Try to find the playlist action bar where Shuffle lives.
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

  const btn = createArchiveButton(PLAYLIST_BTN_ID, 'Archive Playlist');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(btn, PLAYLIST_MENU_ID, getPlaylistUrl, true);
  });

  if (target) {
    target.appendChild(btn);
  } else {
    Object.assign(btn.style, { position: 'fixed', bottom: '24px', right: '100px', zIndex: '9998' });
    document.body.appendChild(btn);
  }
  playlistInjected = true;
}

function removePlaylistButton(): void {
  document.getElementById(PLAYLIST_BTN_ID)?.remove();
  playlistInjected = false;
}

// ── SPA Navigation Watcher ────────────────────────────────────────────────────

function onNavigate(): void {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  removeVideoButton();
  removePlaylistButton();

  if (isWatchPage()) setTimeout(() => tryInjectVideo(10), 500);
  if (isPlaylistPage()) setTimeout(() => tryInjectPlaylist(10), 500);
}

function tryInjectVideo(attempts: number): void {
  if (document.getElementById(BUTTON_ID)) return;
  injectVideoButton();
  if (!videoInjected && attempts > 0) setTimeout(() => tryInjectVideo(attempts - 1), 400);
}

function tryInjectPlaylist(attempts: number): void {
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

document.addEventListener('click', () => closeAllMenus());

// Initial injection
if (isWatchPage()) tryInjectVideo(15);
if (isPlaylistPage()) tryInjectPlaylist(15);
