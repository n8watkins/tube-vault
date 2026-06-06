import React, { useState, useEffect, useRef } from 'react';
import { FiDownload } from 'react-icons/fi';
import { ArchiveMenu } from './ArchiveMenu';
import {
  MenuState, defaultMenuState, ChannelMode,
  DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT, RECENT_POOL,
} from '../types';

type BtnState = 'idle' | 'loading' | 'done' | 'error';

interface PlanItem {
  url: string;
  title: string;
  bytes: number | null;
  duration?: number | null;  // seconds, filled lazily by the row probe
  views?: number | null;     // filled lazily by the row probe
}
interface ChannelPlan {
  totalVideos: number | null;
  items: PlanItem[];
  estBytes: number | null;
  sampled: boolean;
  mode: ChannelMode;
  playlistTitle?: string;
}

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

// One row in the single-video confirmation breakdown (a selected component).
type ConfirmRow = { label: string; bytes: number | null; title?: string };

function formatBytes(b: number | null | undefined): string {
  if (!b || b <= 0) return 'unknown';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

function fmtDuration(s: number | null | undefined): string {
  if (!s || !Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtViews(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
  return `${n} views`;
}

// Feather "download" glyph as a detached SVG, for the hand-built (non-React) dialogs.
function downloadIconSvg(size = 17): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4');
  const poly = document.createElementNS(ns, 'polyline'); poly.setAttribute('points', '7 10 12 15 17 10');
  const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', '12'); line.setAttribute('y1', '15'); line.setAttribute('x2', '12'); line.setAttribute('y2', '3');
  svg.append(path, poly, line);
  return svg;
}

// Compact "what we're downloading" summary for the batch header.
function componentsSummary(m: MenuState): string {
  const parts: string[] = [];
  if (m.video) parts.push(`Video ${m.videoQuality === 'best' ? 'best' : m.videoQuality + 'p'} ${m.videoFormat}`);
  if (m.audio) parts.push(`Audio ${m.audioFormat}`);
  if (m.subtitles) parts.push('Subtitles');
  if (m.thumbnail) parts.push('Thumbnail');
  if (m.metadata) parts.push('Metadata');
  return parts.join(' · ');
}

// Video id from a watch URL (for duplicate detection).
const idOf = (u: string): string | null => { try { return new URL(u).searchParams.get('v'); } catch { return null; } };

// Video id from any single-video URL form — watch (?v=), /shorts/<id>, /live/<id>,
// or youtu.be/<id> — so the confirm dialog can show a thumbnail for all of them.
const videoIdFor = (u: string): string | null => {
  try {
    const url = new URL(u);
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    if (url.pathname.startsWith('/live/')) return url.pathname.split('/')[2] || null;
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
    return url.searchParams.get('v');
  } catch { return null; }
};

// Map of already-downloaded video id → when (newest finishedAt), read from the job
// history in storage, so the selection modal can flag + pre-uncheck duplicates and
// show when each was last grabbed.
function getDownloadedMap(): Promise<Map<string, number>> {
  return new Promise((res) => {
    try {
      chrome.storage.local.get({ tvJobs: [] }, (s) => {
        const m = new Map<string, number>();
        for (const j of (s.tvJobs as { status: string; videoUrl?: string; finishedAt?: number }[])) {
          if (j.status === 'done' && j.videoUrl) {
            const id = idOf(j.videoUrl);
            if (id) m.set(id, Math.max(m.get(id) ?? 0, j.finishedAt ?? 0));
          }
        }
        res(m);
      });
    } catch { res(new Map()); }  // extension context invalidated (reloaded) — fail soft
  });
}

// Probe one video (title + component-aware size + duration + views) via the worker.
function probeVideo(url: string, components: Record<string, unknown>): Promise<{ title?: string; bytes?: number; duration?: number; views?: number } | null> {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'probe', url, components } },
        (r) => res(chrome.runtime.lastError || !r?.ok ? null : r));
    } catch { res(null); }  // extension context invalidated — fail soft
  });
}

interface Props {
  getUrl: () => string;
  playlist: boolean;
  playlistLabel?: string;
  compact?: boolean;
  dropUp?: boolean;
  channel?: ChannelConfig;
}

const LABEL: Record<string, Record<BtnState, string>> = {
  video: { idle: 'Download', loading: 'Downloading…', done: 'Saved ✓', error: 'Failed ✗' },
  playlist: { idle: 'Download Playlist', loading: 'Downloading…', done: 'Saved ✓', error: 'Failed ✗' },
  channel: { idle: 'Download', loading: 'Working…', done: 'Saved ✓', error: 'Failed ✗' },
};

const BTN_COLOR: Record<BtnState, string> = {
  idle: '#cc0000',
  loading: '#888',
  done: '#2e7d32',
  error: '#b71c1c',
};

export function ArchiveButton({ getUrl, playlist, playlistLabel, compact, dropUp, channel }: Props) {
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
  const [showThumbs, setShowThumbs] = useState(true);
  const defaultedMode = useRef(false);

  useEffect(() => {
    if (!channel) return;
    try {
      chrome.storage.local.get(
        { channelCounts: DEFAULT_CHANNEL_COUNTS, channelDefaultCount: DEFAULT_CHANNEL_COUNT },
        (s) => {
          const counts: number[] = Array.isArray(s.channelCounts) && s.channelCounts.length ? s.channelCounts : DEFAULT_CHANNEL_COUNTS;
          setChanCounts(counts);
          setChanCount(counts.includes(s.channelDefaultCount) ? s.channelDefaultCount : counts[counts.length - 1]);
        }
      );
    } catch { /* extension context invalidated — keep defaults */ }
  }, [channel]);

  // Apply the user's saved default download preferences to the menu.
  useEffect(() => {
    try {
      chrome.storage.local.get({ menuDefaults: null, showThumbnails: true }, (s) => {
        if (s.menuDefaults && typeof s.menuDefaults === 'object') setMenuState((m) => ({ ...m, ...s.menuDefaults }));
        setShowThumbs(s.showThumbnails !== false);
      });
    } catch { /* extension context invalidated — keep defaults */ }
  }, []);

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

  const playlistNoun = playlistLabel ?? 'Playlist';
  const labelSet = channel ? LABEL.channel : playlist ? { ...LABEL.playlist, idle: `Download ${playlistNoun}` } : LABEL.video;

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

  // Non-blocking: hand one or more per-video jobs to the background queue and
  // return to idle. Progress/cancel live in the toolbar popup, so the page button
  // never locks. A batch (>1 item or a batchLabel) is grouped by the worker.
  function enqueue(items: PlanItem[], components: Record<string, unknown>, batchLabel?: string, category?: string) {
    chrome.runtime.sendMessage(
      { type: 'TUBE_VAULT_ENQUEUE', items, components, batchLabel, category },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          const err = chrome.runtime.lastError?.message ?? response?.error ?? 'Unknown error';
          setBtnState('error');
          showToast(`Couldn't start: ${err}`, true);
        } else {
          setBtnState('done');
          const n = response.count ?? items.length;
          showToast(`Added ${n} ${n === 1 ? 'video' : 'videos'} to downloads — manage from the TubeVault toolbar icon`);
        }
        setTimeout(() => setBtnState('idle'), 2500);
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
    if (menuState.subtitles) components['subtitles'] = true;

    if (channel) {
      runChannelFlow(components);
      return;
    }
    if (playlist) {
      runPlaylistFlow(components);
      return;
    }

    // Single video: probe each selected component for its own size, then show a
    // confirmation with a per-component breakdown + thumbnail (and a duplicate
    // warning if we've grabbed it before) before queueing.
    const url = getUrl();
    const id = videoIdFor(url);
    const thumbUrl = id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
    const pageTitle = document.title.replace(/\s*-\s*YouTube.*$/, '').trim() || 'Video';
    showToast('Checking video…');

    // Video/audio are probed individually so each row shows its own size; the
    // thumbnail/metadata sidecars are tiny fixed sizes (mirrors helper sidecarBytes).
    const THUMB_BYTES = 120_000;
    const META_BYTES = 100_000;
    const SUBS_BYTES = 50_000;
    const rowProbes: Promise<ConfirmRow>[] = [];
    if (menuState.video) {
      const q = menuState.videoQuality === 'best' ? 'best' : `${menuState.videoQuality}p`;
      rowProbes.push(
        probeVideo(url, { video: { quality: menuState.videoQuality, format: menuState.videoFormat } })
          .then((p) => ({ label: `Video · ${q} ${menuState.videoFormat}`, bytes: p?.bytes ?? null, title: p?.title })),
      );
    }
    if (menuState.audio) {
      rowProbes.push(
        probeVideo(url, { audio: { format: menuState.audioFormat } })
          .then((p) => ({ label: `Audio · ${menuState.audioFormat}`, bytes: p?.bytes ?? null, title: p?.title })),
      );
    }
    if (menuState.thumbnail) rowProbes.push(Promise.resolve({ label: 'Thumbnail · jpg', bytes: THUMB_BYTES }));
    if (menuState.metadata) rowProbes.push(Promise.resolve({ label: 'Metadata · info.json + description', bytes: META_BYTES }));
    if (menuState.subtitles) rowProbes.push(Promise.resolve({ label: 'Subtitles · srt (en)', bytes: SUBS_BYTES }));

    Promise.all([getDownloadedMap(), Promise.all(rowProbes)]).then(([dl, rows]) => {
      const dupWhen = (id && dl.get(id)) || 0;
      const title = rows.find((r) => r.title)?.title || pageTitle;
      const total = rows.reduce((a, r) => a + (r.bytes ?? 0), 0);
      showVideoConfirm(title, thumbUrl, rows, total, dupWhen).then((ok) => {
        if (!ok) { setBtnState('idle'); return; }
        enqueue([{ url, title, bytes: total > 0 ? total : null }], components);
      });
    });
  }

  // Playlist: flat-list it, then let the user pick which videos to keep.
  function runPlaylistFlow(components: Record<string, unknown>) {
    const playlistUrl = getUrl();
    showToast(`Reading ${playlistNoun.toLowerCase()}…`);
    Promise.all([
      getDownloadedMap(),
      new Promise<any>((res) => chrome.runtime.sendMessage(
        { type: 'TUBE_VAULT_REQUEST', payload: { action: 'channel_plan', mode: 'all', count: 0, urls: [playlistUrl], components } },
        (resp) => res(resp),
      )),
    ]).then(([dlIds, resp]) => {
      const plan = readPlan(resp, `Couldn’t read ${playlistNoun.toLowerCase()}`);
      if (!plan) return;
      const n = plan.totalVideos ?? plan.items.length;
      // Use the real playlist/mix name (e.g. "Radical Optimism Tour Setlist",
      // "Mix - Dua Lipa") for the title, batch label, and output category.
      const name = (plan.playlistTitle || '').trim();
      showSelection(
        name ? `Download “${name}”?` : `Download this ${playlistNoun.toLowerCase()}?`,
        `${name ? name + ' · ' : ''}${n} video${n === 1 ? '' : 's'}`,
        plan.items,
        {
          downloaded: dlIds, estBytes: plan.estBytes, summary: componentsSummary(menuState), showThumbnails: showThumbs,
          probe: (u) => probeVideo(u, components).then((p) => ({ bytes: p?.bytes ?? null, duration: p?.duration ?? null, views: p?.views ?? null })),
        },
      ).then((picked) => {
        if (!picked || !picked.length) { setBtnState('idle'); return; }
        enqueue(picked, components, name || `${playlistNoun} — ${picked.length} video${picked.length === 1 ? '' : 's'}`, name ? `${playlistNoun}_${name}` : playlistNoun);
      });
    });
  }

  // Channel: ask the helper to plan (rank/list), then let the user pick which
  // videos to download. All-time popular reads YouTube's own Popular-sorted order.
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
      showToast(mode === 'popular_recent' ? 'Ranking recent uploads by views…' : 'Listing channel…');
      planPayload = { action: 'channel_plan', mode, count: chanCount, urls: [channel.channelVideosUrl()], components };
    }

    Promise.all([
      getDownloadedMap(),
      new Promise<any>((res) => chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: planPayload }, (resp) => res(resp))),
    ]).then(([dlIds, resp]) => {
      const plan = readPlan(resp, 'Couldn’t analyze channel');
      if (!plan) return;

      const n = plan.items.length;
      const what =
        mode === 'all' ? 'all videos' :
        mode === 'latest' ? `the latest ${n}` :
        mode === 'popular_alltime' ? `the top ${n} most-viewed (all-time)` :
        `the top ${n} most-viewed (recent ${RECENT_POOL})`;
      const cap = what.charAt(0).toUpperCase() + what.slice(1);
      // Category folder name derived from the resolved mode.
      const category = mode === 'popular_alltime' || mode === 'popular_recent' ? 'Most Popular' : 'Latest';

      showSelection(
        'Download from this channel?',
        cap,
        plan.items,
        {
          downloaded: dlIds, estBytes: plan.estBytes, summary: componentsSummary(menuState), showThumbnails: showThumbs,
          probe: (u) => probeVideo(u, components).then((p) => ({ bytes: p?.bytes ?? null, duration: p?.duration ?? null, views: p?.views ?? null })),
        },
      ).then((picked) => {
        if (!picked || !picked.length) { setBtnState('idle'); return; }
        enqueue(picked, components, cap, category);
      });
    });
  }

  // Validate a channel_plan response; on failure show the error + reset, return null.
  function readPlan(resp: any, errPrefix: string): ChannelPlan | null {
    if (chrome.runtime.lastError || !resp?.ok || !resp.plan || !resp.plan.items?.length) {
      const err = chrome.runtime.lastError?.message ?? resp?.error ?? 'no videos found';
      setBtnState('error');
      showToast(`${errPrefix}: ${err}`, true);
      setTimeout(() => setBtnState('idle'), 3000);
      return null;
    }
    return resp.plan as ChannelPlan;
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
          playlistLabel={playlistNoun}
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

// Batch selection dialog (our own, not window.confirm): a checkbox list of every
// video in the playlist/channel, all checked by default. Uncheck the ones to skip.
// Resolves the picked items, or null on cancel (backdrop click / Esc).
// Single-video confirmation: thumbnail + title, a per-component size breakdown
// with a total, and a duplicate warning if applicable. Backdrop/Esc = cancel,
// Enter/Download = confirm.
function showVideoConfirm(title: string, thumbUrl: string, rows: ConfirmRow[], totalBytes: number, dupWhen: number): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.78)',
      zIndex: '2147483647', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Roboto, system-ui, Arial, sans-serif',
    });
    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#1c1c1c', border: '1px solid #2e2e2e', borderRadius: '16px',
      boxShadow: '0 16px 48px rgba(0,0,0,0.7)', maxWidth: '460px', width: '90%', color: '#fff', padding: '24px',
    });
    card.onclick = (e) => e.stopPropagation();

    const heading = document.createElement('div');
    heading.textContent = 'Download this video?';
    Object.assign(heading.style, { fontSize: '15px', color: '#aaa', fontWeight: '600', marginBottom: '14px' });

    // Thumbnail next to the title.
    const headRow = document.createElement('div');
    Object.assign(headRow.style, { display: 'flex', gap: '14px', alignItems: 'flex-start', marginBottom: '18px' });
    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      Object.assign(img.style, { width: '120px', height: '68px', objectFit: 'cover', borderRadius: '8px', flexShrink: '0', background: '#000' });
      img.onerror = () => { img.style.display = 'none'; };
      headRow.append(img);
    }
    const t = document.createElement('div');
    t.textContent = title;
    Object.assign(t.style, { flex: '1', minWidth: '0', fontSize: '16px', fontWeight: '700', lineHeight: '1.3' });
    headRow.append(t);

    // Per-component breakdown, one row each, plus a total.
    const listEl = document.createElement('div');
    Object.assign(listEl.style, { border: '1px solid #2e2e2e', borderRadius: '10px', overflow: 'hidden', marginBottom: '18px' });
    const anyUnknown = rows.some((r) => r.bytes == null);
    rows.forEach((rowData, i) => {
      const r = document.createElement('div');
      Object.assign(r.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '10px 14px', borderBottom: i < rows.length - 1 ? '1px solid #262626' : 'none' });
      const lbl = document.createElement('div');
      lbl.textContent = rowData.label;
      Object.assign(lbl.style, { fontSize: '13px', color: '#ddd' });
      const sz = document.createElement('div');
      sz.textContent = rowData.bytes != null ? formatBytes(rowData.bytes) : 'sized at download';
      Object.assign(sz.style, { fontSize: '13px', color: '#999', fontWeight: '600', flexShrink: '0' });
      r.append(lbl, sz);
      listEl.append(r);
    });
    const totalRow = document.createElement('div');
    Object.assign(totalRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderTop: '1px solid #2e2e2e' });
    const tl = document.createElement('div'); tl.textContent = 'Total';
    Object.assign(tl.style, { fontSize: '13px', color: '#fff', fontWeight: '700' });
    const tr = document.createElement('div');
    tr.textContent = totalBytes > 0 ? `${anyUnknown ? '~' : ''}${formatBytes(totalBytes)}` : 'sized at download';
    Object.assign(tr.style, { fontSize: '13px', color: '#fff', fontWeight: '700' });
    totalRow.append(tl, tr);
    listEl.append(totalRow);

    let warn: HTMLDivElement | null = null;
    if (dupWhen) {
      warn = document.createElement('div');
      warn.textContent = `⚠ Already downloaded ${new Date(dupWhen).toLocaleDateString()} — this will download it again.`;
      Object.assign(warn.style, { fontSize: '13px', color: '#ffb74d', background: 'rgba(255,167,38,0.1)', border: '1px solid rgba(255,167,38,0.3)', borderRadius: '8px', padding: '8px 12px', marginBottom: '18px', lineHeight: '1.4' });
    }

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'space-between', alignItems: 'center' });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { padding: '11px 20px', borderRadius: '10px', border: '1px solid #444', background: '#2b2b2b', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit' });
    const go = document.createElement('button');
    Object.assign(go.style, { display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 22px', borderRadius: '10px', border: 'none', background: '#cc0000', color: '#fff', fontSize: '14px', fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit' });
    const goLabel = document.createElement('span'); goLabel.textContent = 'Download';
    go.append(downloadIconSvg(17), goLabel);
    row.append(cancel, go);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); cleanup(true); }
    };
    const cleanup = (result: boolean) => { document.removeEventListener('keydown', onKey, true); backdrop.remove(); resolve(result); };
    backdrop.onclick = () => cleanup(false);
    cancel.onclick = () => cleanup(false);
    go.onclick = () => cleanup(true);
    document.addEventListener('keydown', onKey, true);

    card.append(heading, headRow, listEl);
    if (warn) card.append(warn);
    card.append(row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    go.focus();
  });
}

function showSelection(title: string, subtitle: string, items: PlanItem[], opts: {
  downloaded?: Map<string, number>;
  estBytes?: number | null;
  summary?: string;
  showThumbnails?: boolean;
  probe?: (url: string) => Promise<{ bytes: number | null; duration: number | null; views: number | null }>;
} = {}): Promise<PlanItem[] | null> {
  const { downloaded, estBytes, summary, showThumbnails, probe } = opts;
  return new Promise((resolve) => {
    // Duplicate protection: videos already in download history are pre-unchecked
    // (overridable). `when` is the date we last downloaded each (0 = unknown date).
    const dup = items.map((it) => { const id = idOf(it.url); return !!(id && downloaded?.has(id)); });
    const when = items.map((it) => { const id = idOf(it.url); return (id && downloaded?.get(id)) || 0; });
    const dupCount = dup.filter(Boolean).length;
    const checked = items.map((_, i) => !dup[i]);

    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.78)',
      zIndex: '2147483647', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Roboto, system-ui, Arial, sans-serif',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#1c1c1c', border: '1px solid #2e2e2e', borderRadius: '16px',
      boxShadow: '0 16px 48px rgba(0,0,0,0.7)', maxWidth: '700px', width: '94%',
      maxHeight: '82vh', display: 'flex', flexDirection: 'column', color: '#fff', overflow: 'hidden',
    });
    card.onclick = (e) => e.stopPropagation();

    // Header
    const head = document.createElement('div');
    Object.assign(head.style, { padding: '22px 24px 12px' });
    const h = document.createElement('div');
    h.textContent = title;
    Object.assign(h.style, { fontSize: '18px', fontWeight: '700', marginBottom: '6px' });
    const sub = document.createElement('div');
    const dupNote = dupCount ? `  ·  ${dupCount} already downloaded (unchecked)` : '';
    Object.assign(sub.style, { fontSize: '13px', color: '#aaa', lineHeight: '1.5' });
    head.append(h, sub);  // text set live in refresh()
    if (summary) {
      const sumEl = document.createElement('div');
      sumEl.textContent = `Downloading per video:  ${summary}`;
      Object.assign(sumEl.style, { fontSize: '12px', color: '#ff8a80', marginTop: '7px', fontWeight: '600' });
      head.append(sumEl);
    }

    // Select-all / deselect-all toggle row
    const toolRow = document.createElement('div');
    Object.assign(toolRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 24px', borderBottom: '1px solid #2a2a2a' });
    const toggleAll = document.createElement('button');
    Object.assign(toggleAll.style, { background: 'none', border: 'none', color: '#ff5252', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', padding: '0' });
    const countLbl = document.createElement('div');
    Object.assign(countLbl.style, { fontSize: '13px', color: '#bbb', fontWeight: '600' });
    toolRow.append(toggleAll, countLbl);

    // Scrollable video list
    const list = document.createElement('div');
    Object.assign(list.style, { overflowY: 'auto', flex: '1', padding: '0' });

    // Average size of the videos we already know, used to estimate selected videos
    // that are only sized at download time (playlist/channel "all" mode) — so the
    // total still moves when you check/uncheck an unsized video.
    // Average known size — recomputed as row probes fill sizes in — used to
    // estimate not-yet-sized selected videos so the total keeps refining. Falls
    // back to the plan's sampled average before anything is probed.
    const planAvg = estBytes && items.length ? estBytes / items.length : 0;
    const currentAvg = () => {
      const known = items.map((it) => it.bytes || 0).filter((b) => b > 0);
      return known.length ? known.reduce((a, b) => a + b, 0) / known.length : planAvg;
    };
    const numSelected = () => checked.filter(Boolean).length;
    const selectedSize = () => { const avg = currentAvg(); return items.reduce(
      (a, it, i) => (checked[i] ? a + (it.bytes && it.bytes > 0 ? it.bytes : avg) : a), 0,
    ); };

    // ── Virtualized list ──────────────────────────────────────────────────────
    // A channel/playlist "all" download can be thousands of videos; one DOM node
    // per row janks the whole page. Render only the rows in (and just around) the
    // viewport, backed by a fixed-height spacer that drives the scrollbar.
    const ROW_H = showThumbnails ? 58 : 48;
    const sizer = document.createElement('div');
    Object.assign(sizer.style, { position: 'relative', height: `${items.length * ROW_H}px` });
    list.append(sizer);

    function buildRow(i: number): HTMLDivElement {
      const it = items[i];
      const r = document.createElement('div');
      Object.assign(r.style, {
        position: 'absolute', top: `${i * ROW_H}px`, left: '0', right: '0', height: `${ROW_H}px`,
        boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '12px',
        padding: '0 22px', cursor: 'pointer', opacity: checked[i] ? '1' : '0.45',
      });
      const box = document.createElement('div');
      Object.assign(box.style, { width: '18px', height: '18px', borderRadius: '5px', flexShrink: '0', border: '2px solid #cc0000', background: checked[i] ? '#cc0000' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#fff', fontWeight: '700' });
      box.textContent = checked[i] ? '✓' : '';
      r.append(box);

      if (showThumbnails) {
        const id = idOf(it.url);
        const thumb = document.createElement('img');
        if (id) thumb.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
        thumb.loading = 'lazy';
        Object.assign(thumb.style, { width: '72px', height: '40px', objectFit: 'cover', borderRadius: '5px', flexShrink: '0', background: '#000' });
        thumb.onerror = () => { thumb.style.visibility = 'hidden'; };
        r.append(thumb);
      }

      const tWrap = document.createElement('div');
      Object.assign(tWrap.style, { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px' });
      const t = document.createElement('div');
      t.textContent = it.title || it.url;
      Object.assign(t.style, { fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      const meta = document.createElement('div');
      Object.assign(meta.style, { fontSize: '11.5px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      const metaParts = [fmtDuration(it.duration), fmtViews(it.views)].filter(Boolean);
      if (dup[i]) metaParts.push(when[i] ? `✓ downloaded ${new Date(when[i]).toLocaleDateString()}` : '✓ downloaded');
      meta.textContent = metaParts.join('  ·  ');
      if (dup[i]) meta.style.color = '#81c784';
      tWrap.append(t, meta);

      const sz = document.createElement('div');
      sz.textContent = it.bytes ? formatBytes(it.bytes) : (probingSet.has(i) ? '…' : '—');
      Object.assign(sz.style, { fontSize: '12px', color: '#999', flexShrink: '0', minWidth: '58px', textAlign: 'right', fontWeight: '600' });
      r.append(tWrap, sz);
      r.onclick = () => { checked[i] = !checked[i]; refresh(); };
      return r;
    }

    // ── Progressive sizing/info: probe rows as they enter the viewport ─────────
    // Bounded concurrency so a long playlist never floods YouTube. Each probe
    // fills the row's size/duration/views, then a coalesced refresh repaints.
    const probedSet = new Set<number>();
    const probingSet = new Set<number>();
    const probeQueue: number[] = [];
    let activeProbes = 0;
    const CONCURRENCY = 3;
    function pumpProbes(): void {
      while (probe && activeProbes < CONCURRENCY && probeQueue.length) {
        const i = probeQueue.shift()!;
        if (probedSet.has(i) || probingSet.has(i)) continue;
        probingSet.add(i);
        activeProbes++;
        probe(items[i].url).then((res) => {
          if (res) {
            if (res.bytes != null) items[i].bytes = res.bytes;
            if (res.duration != null) items[i].duration = res.duration;
            if (res.views != null) items[i].views = res.views;
          }
        }).catch(() => { /* leave as unsized */ }).finally(() => {
          probedSet.add(i); probingSet.delete(i); activeProbes--;
          scheduleRefresh(); pumpProbes();
        });
      }
    }
    function enqueueVisibleProbes(): void {
      if (!probe) return;
      for (let i = winStart; i < winEnd; i++) {
        if (!probedSet.has(i) && !probingSet.has(i)) probeQueue.push(i);
      }
      pumpProbes();
    }
    let refreshScheduled = false;
    function scheduleRefresh(): void {
      if (refreshScheduled) return;
      refreshScheduled = true;
      requestAnimationFrame(() => { refreshScheduled = false; refresh(); });
    }

    let winStart = -1;
    let winEnd = -1;
    function renderWindow(force = false): void {
      const viewH = list.clientHeight || 400;
      const buffer = 6;
      const start = Math.max(0, Math.floor(list.scrollTop / ROW_H) - buffer);
      const end = Math.min(items.length, Math.ceil((list.scrollTop + viewH) / ROW_H) + buffer);
      if (!force && start === winStart && end === winEnd) return;
      winStart = start; winEnd = end;
      sizer.replaceChildren();
      for (let i = start; i < end; i++) sizer.append(buildRow(i));
      enqueueVisibleProbes();
    }

    let rafQueued = false;
    list.addEventListener('scroll', () => {
      if (rafQueued) return;
      rafQueued = true;
      requestAnimationFrame(() => { rafQueued = false; renderWindow(); });
    });

    const refresh = () => {
      const n = numSelected();
      const size = selectedSize();
      const stillUnknown = items.some((it) => !it.bytes);
      const sizeStr = size > 0
        ? `${stillUnknown ? '~' : ''}${formatBytes(size)}${stillUnknown ? ' (est.)' : ''}`
        : 'sized at download';
      sub.textContent = `${subtitle}${dupNote}  ·  ${sizeStr}`;
      countLbl.textContent = `${n} of ${items.length}`;
      toggleAll.textContent = n === items.length ? 'Deselect all' : 'Select all';
      goText.textContent = n ? `Download ${n}` : 'Download';
      go.style.opacity = n ? '1' : '0.5';
      go.style.cursor = n ? 'pointer' : 'default';
      renderWindow(true);  // repaint visible rows to reflect the new checked state
    };

    toggleAll.onclick = () => {
      const all = numSelected() === items.length;
      checked.fill(!all);
      refresh();
    };

    // Footer actions
    const foot = document.createElement('div');
    Object.assign(foot.style, { display: 'flex', gap: '10px', justifyContent: 'space-between', alignItems: 'center', padding: '14px 22px', borderTop: '1px solid #2a2a2a' });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { padding: '11px 20px', borderRadius: '10px', border: '1px solid #444', background: '#2b2b2b', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit' });
    const go = document.createElement('button');
    Object.assign(go.style, { display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 22px', borderRadius: '10px', border: 'none', background: '#cc0000', color: '#fff', fontSize: '14px', fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit' });
    const goText = document.createElement('span');
    go.append(downloadIconSvg(17), goText);
    foot.append(cancel, go);

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(null); } };
    const cleanup = (result: PlanItem[] | null) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };

    backdrop.onclick = () => cleanup(null);
    cancel.onclick = () => cleanup(null);
    go.onclick = () => { if (numSelected()) cleanup(items.filter((_, i) => checked[i])); };
    document.addEventListener('keydown', onKey, true);

    card.append(head, toolRow, list, foot);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    refresh();
  });
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
