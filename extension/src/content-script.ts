// Injected into all youtube.com pages.
// Watches for navigation to watch/shorts pages and injects the Archive button.

const BUTTON_ID = 'tube-vault-btn';
const MENU_ID = 'tube-vault-menu';

const ACTIONS = [
  { label: 'Full Bundle', action: 'archive_bundle' },
  { label: 'Best Video', action: 'download_best' },
  { label: 'Audio Only', action: 'download_audio' },
  { label: 'Thumbnail Only', action: 'download_thumbnail' },
  { label: 'Metadata Only', action: 'download_metadata' },
] as const;

type Action = typeof ACTIONS[number]['action'];

// ── State ────────────────────────────────────────────────────────────────────

let currentUrl = location.href;
let injected = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isWatchPage(): boolean {
  return (
    location.pathname === '/watch' ||
    location.pathname.startsWith('/shorts/')
  );
}

function getVideoUrl(): string {
  return location.href.split('&')[0]; // strip playlist params
}

// ── UI ───────────────────────────────────────────────────────────────────────

function createButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.textContent = 'Archive';
  btn.setAttribute('aria-label', 'TubeVault archive options');
  Object.assign(btn.style, {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
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
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(btn);
  });
  return btn;
}

function createMenu(): HTMLElement {
  const menu = document.createElement('div');
  menu.id = MENU_ID;
  Object.assign(menu.style, {
    position: 'absolute',
    top: '100%',
    left: '0',
    marginTop: '4px',
    background: '#212121',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    padding: '4px 0',
    zIndex: '9999',
    minWidth: '160px',
    display: 'none',
  });

  for (const { label, action } of ACTIONS) {
    const item = document.createElement('button');
    item.textContent = label;
    item.dataset.action = action;
    Object.assign(item.style, {
      display: 'block',
      width: '100%',
      padding: '8px 16px',
      background: 'none',
      border: 'none',
      color: '#fff',
      fontSize: '13px',
      textAlign: 'left',
      cursor: 'pointer',
      fontFamily: 'inherit',
    });
    item.addEventListener('mouseenter', () => (item.style.background = '#383838'));
    item.addEventListener('mouseleave', () => (item.style.background = 'none'));
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      startDownload(action);
    });
    menu.appendChild(item);
  }

  return menu;
}

function toggleMenu(btn: HTMLElement): void {
  let menu = document.getElementById(MENU_ID);
  if (!menu) {
    menu = createMenu();
    btn.style.position = 'relative';
    btn.appendChild(menu);
  }
  const visible = menu.style.display !== 'none';
  menu.style.display = visible ? 'none' : 'block';
}

function closeMenu(): void {
  const menu = document.getElementById(MENU_ID);
  if (menu) menu.style.display = 'none';
}

function setBtnState(state: 'idle' | 'loading' | 'done' | 'error'): void {
  const btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (!btn) return;
  const labels = { idle: 'Archive', loading: 'Archiving…', done: 'Saved ✓', error: 'Failed ✗' };
  const colors = { idle: '#cc0000', loading: '#888', done: '#2e7d32', error: '#b71c1c' };
  btn.textContent = labels[state];
  btn.style.background = colors[state];
  btn.disabled = state === 'loading';
  if (state === 'done' || state === 'error') {
    setTimeout(() => setBtnState('idle'), 3000);
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

// ── Download ─────────────────────────────────────────────────────────────────

function startDownload(action: Action): void {
  setBtnState('loading');

  chrome.runtime.sendMessage(
    {
      type: 'TUBE_VAULT_REQUEST',
      payload: { action, url: getVideoUrl() },
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        const err = chrome.runtime.lastError?.message ?? response?.error ?? 'Unknown error';
        setBtnState('error');
        showToast(`Archive failed: ${err}`, true);
        return;
      }
      setBtnState('done');
      const folder = response.windowsFolderPath ?? response.folderPath ?? '';
      showToast(folder ? `Saved to ${folder}` : 'Archived successfully');
    }
  );
}

// ── Injection ─────────────────────────────────────────────────────────────────

function inject(): void {
  if (document.getElementById(BUTTON_ID)) return; // already present
  if (!isWatchPage()) return;

  // Try to find YouTube's action row (like/share/etc.)
  const selectors = [
    '#actions-inner #top-level-buttons-computed',     // desktop watch
    'ytd-watch-metadata #actions #top-level-buttons-computed',
    '#above-the-fold #top-level-buttons-computed',
    'ytm-slim-video-action-bar-renderer',             // mobile/shorts
  ];

  let target: Element | null = null;
  for (const sel of selectors) {
    target = document.querySelector(sel);
    if (target) break;
  }

  if (!target) {
    // Fallback: float button over video
    injectFloating();
    return;
  }

  const btn = createButton();
  target.appendChild(btn);
  injected = true;
}

function injectFloating(): void {
  const btn = createButton();
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '9998',
  });
  document.body.appendChild(btn);
  injected = true;
}

function removeButton(): void {
  document.getElementById(BUTTON_ID)?.remove();
  injected = false;
}

// ── SPA Navigation Watcher ────────────────────────────────────────────────────

function onNavigate(): void {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  removeButton();

  if (isWatchPage()) {
    // YouTube's SPA renders content after navigation; wait briefly
    setTimeout(() => tryInject(10), 500);
  }
}

function tryInject(attempts: number): void {
  if (document.getElementById(BUTTON_ID)) return;
  inject();
  if (!injected && attempts > 0) {
    setTimeout(() => tryInject(attempts - 1), 400);
  }
}

// Intercept pushState/replaceState for SPA navigation detection
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

// Close menu on outside click
document.addEventListener('click', () => closeMenu());

// Initial injection
if (isWatchPage()) {
  tryInject(15);
}
