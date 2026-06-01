import React, { useState, useEffect, useRef } from 'react';
import { FiDownload } from 'react-icons/fi';
import { ArchiveMenu } from './ArchiveMenu';
import {
  MenuState, defaultMenuState, ChannelMode,
  DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT, RECENT_POOL,
} from '../types';

type BtnState = 'idle' | 'loading' | 'done' | 'error';

interface ChannelConfig {
  // Build the channel's /videos URL (handed to the helper for ranking/expansion)
  channelVideosUrl: () => string;
  // Read the channel's total upload count from the page (for the disclaimer)
  getVideoCount: () => number | null;
  // Read (don't drive) the active sort — 'popular' enables all-time mode
  getSortState: () => 'popular' | 'other' | null;
  // Top N watch URLs in the order the grid currently shows them
  readShownUrls: (count: number) => string[];
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
  const [chanMode, setChanMode] = useState<ChannelMode>('popular_recent');
  const [chanCount, setChanCount] = useState<number>(DEFAULT_CHANNEL_COUNT);
  const [chanCounts, setChanCounts] = useState<number[]>(DEFAULT_CHANNEL_COUNTS);
  const [chanVideoCount, setChanVideoCount] = useState<number | null>(null);
  const [chanSortState, setChanSortState] = useState<'popular' | 'other' | null>(null);
  const defaultedMode = useRef(false);

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
      if (channel) {
        setChanVideoCount(channel.getVideoCount());
        const ss = channel.getSortState();
        setChanSortState(ss);
        if (ss === 'popular') {
          // They took the effort to sort by Popular — jump straight to all-time.
          setChanMode('popular_alltime');
        } else if (!defaultedMode.current) {
          setChanMode('popular_recent');
        } else {
          // Popular no longer active — drop all-time back to recent, keep other choices.
          setChanMode((m) => (m === 'popular_alltime' ? 'popular_recent' : m));
        }
        defaultedMode.current = true;
      }
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
  // user, then download. All heavy lifting is in the helper (no scraping) — except
  // all-time popular, where we read YouTube's own Popular-sorted page order.
  function runChannelFlow(components: Record<string, unknown>) {
    if (!channel) return;

    // All-time needs YouTube's Popular sort active; otherwise fall back to recent.
    let mode = chanMode;
    if (mode === 'popular_alltime' && channel.getSortState() !== 'popular') {
      mode = 'popular_recent';
      setChanMode('popular_recent');
      showToast('Not on YouTube’s Popular sort — using recent instead. Open the Videos tab and click “Popular” for all-time.', true);
    }

    let planPayload: Record<string, unknown>;
    if (mode === 'popular_alltime') {
      const urls = channel.readShownUrls(chanCount);
      if (!urls.length) {
        setBtnState('error');
        showToast('Couldn’t read videos from this page', true);
        setTimeout(() => setBtnState('idle'), 3000);
        return;
      }
      showToast('Reading YouTube’s Popular order…');
      planPayload = { action: 'channel_plan', mode, count: chanCount, urls, components };
    } else {
      showToast(mode === 'popular_recent' ? 'Ranking recent uploads by views…' : 'Checking channel…');
      planPayload = { action: 'channel_plan', mode, count: chanCount, urls: [channel.channelVideosUrl()], components };
    }

    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: planPayload }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok || !resp.plan) {
        const err = chrome.runtime.lastError?.message ?? resp?.error ?? 'Unknown error';
        setBtnState('error');
        showToast(`Couldn't analyze channel: ${err}`, true);
        setTimeout(() => setBtnState('idle'), 3000);
        return;
      }

      const plan = resp.plan as { totalVideos: number | null; targets: string[]; estBytes: number | null; sampled: boolean };
      const n = mode === 'all' ? (plan.totalVideos ?? '?') : (plan.targets.length || chanCount);
      const what =
        mode === 'all' ? 'ALL videos' :
        mode === 'latest' ? `the latest ${n}` :
        mode === 'popular_alltime' ? `the top ${n} most-viewed (all-time)` :
        `the top ${n} most-viewed (recent ${RECENT_POOL})`;
      const sizeNote = plan.estBytes ? `~${formatBytes(plan.estBytes)}${plan.sampled ? ' (estimated from a sample)' : ''}` : 'unknown';

      const proceed = window.confirm(
        `TubeVault — download ${what} from this channel?\n\n` +
        `Videos: ${n}\n` +
        `Projected size: ${sizeNote}`
      );

      if (!proceed) { setBtnState('idle'); return; }

      if (mode === 'all') {
        sendRequest({ action: 'custom', urls: [channel.channelVideosUrl()], expand: true, components });
      } else {
        sendRequest({ action: 'custom', urls: plan.targets, components });
      }
    });
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
          gap: compact ? 0 : 8,
          padding: compact ? 0 : '0 16px',
          height: compact ? 48 : 36,
          width: compact ? 48 : undefined,
          borderRadius: compact ? '50%' : 18,
          border: 'none',
          background: BTN_COLOR[btnState],
          color: '#fff',
          fontSize: compact ? 14 : 15,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: btnState === 'loading' ? 'default' : 'pointer',
          flexShrink: 0,
          transition: 'background 0.2s',
          whiteSpace: 'nowrap',
        }}
      >
        <FiDownload size={compact ? 20 : 20} />
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
            sortState: chanSortState,
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

  const dot = document.createElement('span');
  Object.assign(dot.style, {
    width: '9px', height: '9px', borderRadius: '50%', flexShrink: '0',
    background: isError ? '#ff5252' : '#4caf50',
    boxShadow: `0 0 10px ${isError ? '#ff5252' : '#4caf50'}`,
  });
  const text = document.createElement('span');
  text.textContent = msg;
  toast.append(dot, text);

  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '28px',
    right: '28px',
    maxWidth: '380px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    background: '#1c1c1c',
    border: `1px solid ${isError ? 'rgba(255,82,82,0.5)' : 'rgba(76,175,80,0.45)'}`,
    color: '#fff',
    padding: '16px 20px',
    borderRadius: '14px',
    fontSize: '15px',
    fontWeight: '500',
    lineHeight: '1.4',
    fontFamily: 'Roboto, system-ui, Arial, sans-serif',
    zIndex: '2147483647',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    transition: 'opacity 0.3s, transform 0.3s',
    transform: 'translateY(0)',
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 350);
  }, 4500);
}
