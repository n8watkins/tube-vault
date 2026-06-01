import React, { useState, useEffect, useRef } from 'react';
import { FiDownload } from 'react-icons/fi';
import { ArchiveMenu } from './ArchiveMenu';
import {
  MenuState, defaultMenuState, ChannelMode,
  DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT,
} from '../types';

type BtnState = 'idle' | 'loading' | 'done' | 'error';

interface ChannelConfig {
  // Build the channel's /videos URL (for "latest"/"all" — yt-dlp expands it server-side)
  channelVideosUrl: () => string;
  // Drive YouTube's UI to the Popular sort and scrape the top `count` watch URLs
  scrapePopular: (count: number) => Promise<string[]>;
}

interface Props {
  getUrl: () => string;
  playlist: boolean;
  compact?: boolean;
  dropUp?: boolean;
  channel?: ChannelConfig;
}

const LABEL: Record<string, Record<BtnState, string>> = {
  video: { idle: 'Download', loading: 'Downloading…', done: 'Saved ✓', error: 'Failed ✗' },
  playlist: { idle: 'Download Playlist', loading: 'Downloading…', done: 'Saved ✓', error: 'Failed ✗' },
  channel: { idle: 'Download Videos', loading: 'Working…', done: 'Saved ✓', error: 'Failed ✗' },
};

const BTN_COLOR: Record<BtnState, string> = {
  idle: '#cc0000',
  loading: '#888',
  done: '#2e7d32',
  error: '#b71c1c',
};

export function ArchiveButton({ getUrl, playlist, compact, dropUp, channel }: Props) {
  const [open, setOpen] = useState(false);
  const [btnState, setBtnState] = useState<BtnState>('idle');
  const [menuState, setMenuState] = useState<MenuState>(defaultMenuState);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Channel-only state (mode + count, with editable presets from options)
  const [chanMode, setChanMode] = useState<ChannelMode>('popular');
  const [chanCount, setChanCount] = useState<number>(DEFAULT_CHANNEL_COUNT);
  const [chanCounts, setChanCounts] = useState<number[]>(DEFAULT_CHANNEL_COUNTS);

  useEffect(() => {
    if (!channel) return;
    chrome.storage.local.get(
      { channelCounts: DEFAULT_CHANNEL_COUNTS, channelDefaultCount: DEFAULT_CHANNEL_COUNT },
      (s) => {
        const counts: number[] = Array.isArray(s.channelCounts) && s.channelCounts.length ? s.channelCounts : DEFAULT_CHANNEL_COUNTS;
        setChanCounts(counts);
        setChanCount(counts.includes(s.channelDefaultCount) ? s.channelDefaultCount : counts[counts.length - 1]);
      }
    );
  }, [channel]);

  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('click', onClickOutside, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('click', onClickOutside, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const labelSet = channel ? LABEL.channel : playlist ? LABEL.playlist : LABEL.video;

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (btnState === 'loading') return;
    if (!open && btnRef.current) {
      setAnchorRect(btnRef.current.getBoundingClientRect());
    }
    setOpen(o => !o);
  }

  function sendRequest(payload: Record<string, unknown>) {
    chrome.runtime.sendMessage(
      { type: 'TUBE_VAULT_REQUEST', payload },
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

  async function handleArchive() {
    setOpen(false);
    setBtnState('loading');

    const components: Record<string, unknown> = {};
    if (menuState.video)
      components['video'] = { quality: menuState.videoQuality, format: menuState.videoFormat };
    if (menuState.audio) components['audio'] = { format: menuState.audioFormat };
    if (menuState.metadata) components['metadata'] = true;
    if (menuState.thumbnail) components['thumbnail'] = true;

    if (channel) {
      if (chanMode === 'popular') {
        showToast(`Finding top ${chanCount} popular videos…`);
        let urls: string[] = [];
        try { urls = await channel.scrapePopular(chanCount); } catch { /* handled below */ }
        if (!urls.length) {
          setBtnState('error');
          showToast('Could not read popular videos from this page', true);
          setTimeout(() => setBtnState('idle'), 3000);
          return;
        }
        showToast(`Downloading ${urls.length} videos…`);
        sendRequest({ action: 'custom', urls, components });
      } else if (chanMode === 'latest') {
        showToast(`Downloading latest ${chanCount} videos…`);
        sendRequest({ action: 'custom', urls: [channel.channelVideosUrl()], expand: true, playlistEnd: chanCount, components });
      } else {
        showToast('Downloading all channel videos…');
        sendRequest({ action: 'custom', urls: [channel.channelVideosUrl()], expand: true, components });
      }
      return;
    }

    sendRequest({ action: 'custom', url: getUrl(), components, playlist });
  }

  return (
    <div
      ref={rootRef}
      style={{ display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        ref={btnRef}
        onClick={handleToggle}
        title={labelSet.idle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: compact ? 0 : 6,
          padding: compact ? 0 : '0 12px',
          height: compact ? 48 : 32,
          width: compact ? 48 : undefined,
          borderRadius: compact ? '50%' : 16,
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
        <FiDownload size={compact ? 20 : 14} />
        {!compact && <span>{labelSet[btnState]}</span>}
      </button>

      {open && anchorRect && (
        <ArchiveMenu
          menuRef={menuRef}
          anchorRect={anchorRect}
          dropUp={dropUp}
          state={menuState}
          onChange={(updates) => setMenuState((s) => ({ ...s, ...updates }))}
          playlist={playlist}
          channel={channel ? {
            mode: chanMode,
            count: chanCount,
            counts: chanCounts,
            onMode: setChanMode,
            onCount: setChanCount,
          } : undefined}
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
