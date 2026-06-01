import React, { useState, useEffect, useRef } from 'react';
import { FiDownload } from 'react-icons/fi';
import { ArchiveMenu } from './ArchiveMenu';
import {
  MenuState, defaultMenuState, ChannelMode,
  DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT,
} from '../types';

type BtnState = 'idle' | 'loading' | 'done' | 'error';

interface ChannelConfig {
  // Build the channel's /videos URL (handed to the helper for ranking/expansion)
  channelVideosUrl: () => string;
  // Read the channel's total upload count from the page (for the disclaimer)
  getVideoCount: () => number | null;
}

function formatBytes(b: number | null | undefined): string {
  if (!b || b <= 0) return 'unknown';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
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
  const [chanVideoCount, setChanVideoCount] = useState<number | null>(null);

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
      if (channel) setChanVideoCount(channel.getVideoCount());
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

  function handleArchive() {
    setOpen(false);
    setBtnState('loading');

    const components: Record<string, unknown> = {};
    if (menuState.video)
      components['video'] = { quality: menuState.videoQuality, format: menuState.videoFormat };
    if (menuState.audio) components['audio'] = { format: menuState.audioFormat };
    if (menuState.metadata) components['metadata'] = true;
    if (menuState.thumbnail) components['thumbnail'] = true;

    if (channel) {
      runChannelFlow(components);
      return;
    }

    sendRequest({ action: 'custom', url: getUrl(), components, playlist });
  }

  // Channel: ask the helper to plan (rank/list + size estimate), confirm with the
  // user, then download. Keeps all the heavy lifting in the helper (no scraping).
  function runChannelFlow(components: Record<string, unknown>) {
    if (!channel) return;
    showToast(chanMode === 'popular' ? 'Ranking channel by views — this can take a minute…' : 'Checking channel…');

    chrome.runtime.sendMessage(
      {
        type: 'TUBE_VAULT_REQUEST',
        payload: { action: 'channel_plan', urls: [channel.channelVideosUrl()], mode: chanMode, count: chanCount, components },
      },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok || !resp.plan) {
          const err = chrome.runtime.lastError?.message ?? resp?.error ?? 'Unknown error';
          setBtnState('error');
          showToast(`Couldn't analyze channel: ${err}`, true);
          setTimeout(() => setBtnState('idle'), 3000);
          return;
        }

        const plan = resp.plan as { totalVideos: number | null; targets: string[]; estBytes: number | null; sampled: boolean };
        const n = chanMode === 'all' ? (plan.totalVideos ?? '?') : (plan.targets.length || chanCount);
        const what =
          chanMode === 'all' ? 'ALL videos' :
          chanMode === 'latest' ? `the latest ${n}` :
          `the top ${n} most-viewed`;
        const sizeNote = plan.estBytes ? `~${formatBytes(plan.estBytes)}${plan.sampled ? ' (estimated from a sample)' : ''}` : 'unknown';

        const proceed = window.confirm(
          `TubeVault — download ${what} from this channel?\n\n` +
          `Videos: ${n}\n` +
          `Projected size: ${sizeNote}`
        );

        if (!proceed) { setBtnState('idle'); return; }

        if (chanMode === 'all') {
          sendRequest({ action: 'custom', urls: [channel.channelVideosUrl()], expand: true, components });
        } else {
          sendRequest({ action: 'custom', urls: plan.targets, components });
        }
      }
    );
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
            videoCount: chanVideoCount,
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
