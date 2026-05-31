import React, { useState, useEffect, useRef } from 'react';
import { FiArchive } from 'react-icons/fi';
import { ArchiveMenu } from './ArchiveMenu';
import { MenuState, defaultMenuState } from '../types';

type BtnState = 'idle' | 'loading' | 'done' | 'error';

interface Props {
  getUrl: () => string;
  playlist: boolean;
  compact?: boolean; // icon-only, for #right-controls
}

const LABEL: Record<string, Record<BtnState, string>> = {
  video: { idle: 'Archive', loading: 'Archiving…', done: 'Saved ✓', error: 'Failed ✗' },
  playlist: { idle: 'Archive Playlist', loading: 'Archiving…', done: 'Saved ✓', error: 'Failed ✗' },
};

const BTN_COLOR: Record<BtnState, string> = {
  idle: '#cc0000',
  loading: '#888',
  done: '#2e7d32',
  error: '#b71c1c',
};

export function ArchiveButton({ getUrl, playlist, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [btnState, setBtnState] = useState<BtnState>('idle');
  // State lifted here so selections survive menu close/reopen
  const [menuState, setMenuState] = useState<MenuState>(defaultMenuState);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const labelSet = playlist ? LABEL.playlist : LABEL.video;

  function handleArchive() {
    setOpen(false);
    setBtnState('loading');

    const components: Record<string, unknown> = {};
    if (menuState.video)
      components['video'] = { quality: menuState.videoQuality, format: menuState.videoFormat };
    if (menuState.audio) components['audio'] = { format: menuState.audioFormat };
    if (menuState.metadata) components['metadata'] = true;
    if (menuState.thumbnail) components['thumbnail'] = true;

    chrome.runtime.sendMessage(
      {
        type: 'TUBE_VAULT_REQUEST',
        payload: { action: 'custom', url: getUrl(), components, playlist },
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          const err =
            chrome.runtime.lastError?.message ?? response?.error ?? 'Unknown error';
          setBtnState('error');
          showToast(`Archive failed: ${err}`, true);
        } else {
          setBtnState('done');
          const folder = response.windowsFolderPath ?? response.folderPath ?? '';
          showToast(folder ? `Saved to ${folder}` : 'Archived successfully');
          if (response.warnings?.length) {
            showToast(`Partial failure: ${response.warnings[0]}`, true);
          }
        }
        setTimeout(() => setBtnState('idle'), 3000);
      }
    );
  }

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (btnState !== 'loading') setOpen((o) => !o);
        }}
        title={labelSet.idle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: compact ? 0 : 6,
          padding: compact ? '0 10px' : '0 16px',
          height: 36,
          borderRadius: 18,
          border: 'none',
          background: BTN_COLOR[btnState],
          color: '#fff',
          fontSize: 14,
          fontWeight: 500,
          fontFamily: 'inherit',
          cursor: btnState === 'loading' ? 'default' : 'pointer',
          flexShrink: 0,
          transition: 'background 0.2s',
          whiteSpace: 'nowrap',
        }}
      >
        <FiArchive size={14} />
        {!compact && <span>{labelSet[btnState]}</span>}
      </button>

      {open && (
        <ArchiveMenu
          state={menuState}
          onChange={(updates) => setMenuState((s) => ({ ...s, ...updates }))}
          playlist={playlist}
          onArchive={handleArchive}
        />
      )}
    </div>
  );
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
