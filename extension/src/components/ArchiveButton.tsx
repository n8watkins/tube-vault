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

function formatBytes(b: number | null | undefined): string {
  if (!b || b <= 0) return 'unknown';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

// Video id from a watch URL (for duplicate detection).
const idOf = (u: string): string | null => { try { return new URL(u).searchParams.get('v'); } catch { return null; } };

// Map of already-downloaded video id → when (newest finishedAt), read from the job
// history in storage, so the selection modal can flag + pre-uncheck duplicates and
// show when each was last grabbed.
function getDownloadedMap(): Promise<Map<string, number>> {
  return new Promise((res) => {
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
  });
}

// Probe one video (title + component-aware size) via the background worker.
function probeVideo(url: string, components: Record<string, unknown>): Promise<{ title?: string; bytes?: number } | null> {
  return new Promise((res) =>
    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'probe', url, components } },
      (r) => res(chrome.runtime.lastError || !r?.ok ? null : r)));
}

// Human summary of the selected components (for the single-video confirm).
function componentSummary(m: MenuState): string {
  const parts: string[] = [];
  if (m.video) parts.push(`Video ${m.videoQuality === 'best' ? 'best' : m.videoQuality + 'p'} ${m.videoFormat}`);
  if (m.audio) parts.push(`Audio ${m.audioFormat}`);
  if (m.thumbnail) parts.push('Thumbnail');
  if (m.metadata) parts.push('Metadata');
  return parts.join('  ·  ') || 'Nothing selected';
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

  // Apply the user's saved default download preferences to the menu.
  useEffect(() => {
    chrome.storage.local.get({ menuDefaults: null }, (s) => {
      if (s.menuDefaults && typeof s.menuDefaults === 'object') setMenuState((m) => ({ ...m, ...s.menuDefaults }));
    });
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

    if (channel) {
      runChannelFlow(components);
      return;
    }
    if (playlist) {
      runPlaylistFlow(components);
      return;
    }

    // Single video: probe for title/size, then show a confirmation (with a
    // duplicate warning if we've grabbed it before) before queueing.
    const url = getUrl();
    const pageTitle = document.title.replace(/\s*-\s*YouTube.*$/, '').trim() || 'Video';
    showToast('Checking video…');
    Promise.all([getDownloadedMap(), probeVideo(url, components)]).then(([dl, p]) => {
      const id = idOf(url);
      const dupWhen = (id && dl.get(id)) || 0;
      const title = p?.title || pageTitle;
      const sizeText = p?.bytes ? formatBytes(p.bytes) : 'sized at download';
      showVideoConfirm(title, componentSummary(menuState), sizeText, dupWhen).then((ok) => {
        if (!ok) { setBtnState('idle'); return; }
        enqueue([{ url, title, bytes: p?.bytes ?? null }], components);
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
        dlIds,
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
        dlIds,
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
// Single-video confirmation: title, what you're grabbing, size, and a duplicate
// warning if applicable. Backdrop/Esc = cancel, Enter/Download = confirm.
function showVideoConfirm(title: string, components: string, sizeText: string, dupWhen: number): Promise<boolean> {
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
      boxShadow: '0 16px 48px rgba(0,0,0,0.7)', maxWidth: '440px', width: '90%', color: '#fff', padding: '24px',
    });
    card.onclick = (e) => e.stopPropagation();

    const heading = document.createElement('div');
    heading.textContent = 'Download this video?';
    Object.assign(heading.style, { fontSize: '15px', color: '#aaa', fontWeight: '600', marginBottom: '10px' });

    const t = document.createElement('div');
    t.textContent = title;
    Object.assign(t.style, { fontSize: '18px', fontWeight: '700', marginBottom: '16px', lineHeight: '1.35' });

    const meta = document.createElement('div');
    Object.assign(meta.style, { fontSize: '14px', color: '#ccc', lineHeight: '1.7', marginBottom: '18px' });
    meta.innerHTML = '';
    const cRow = document.createElement('div'); cRow.textContent = components; meta.append(cRow);
    const sRow = document.createElement('div'); sRow.textContent = `Size: ${sizeText}`; sRow.style.color = '#999'; meta.append(sRow);

    if (dupWhen) {
      const warn = document.createElement('div');
      warn.textContent = `⚠ Already downloaded ${new Date(dupWhen).toLocaleDateString()} — this will download it again.`;
      Object.assign(warn.style, { fontSize: '13px', color: '#ffb74d', background: 'rgba(255,167,38,0.1)', border: '1px solid rgba(255,167,38,0.3)', borderRadius: '8px', padding: '8px 12px', marginBottom: '18px', lineHeight: '1.4' });
      meta.after(warn);
    }

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { padding: '10px 18px', borderRadius: '10px', border: '1px solid #444', background: '#2b2b2b', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit' });
    const go = document.createElement('button');
    go.textContent = 'Download';
    Object.assign(go.style, { padding: '10px 18px', borderRadius: '10px', border: 'none', background: '#cc0000', color: '#fff', fontSize: '14px', fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit' });
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

    card.append(heading, t, meta, row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    go.focus();
  });
}

function showSelection(title: string, subtitle: string, items: PlanItem[], downloaded?: Map<string, number>): Promise<PlanItem[] | null> {
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
      boxShadow: '0 16px 48px rgba(0,0,0,0.7)', maxWidth: '520px', width: '92%',
      maxHeight: '80vh', display: 'flex', flexDirection: 'column', color: '#fff', overflow: 'hidden',
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
    Object.assign(list.style, { overflowY: 'auto', flex: '1', padding: '4px 0' });

    const rowEls: HTMLDivElement[] = [];
    // Average size of the videos we already know, used to estimate selected videos
    // that are only sized at download time (playlist/channel "all" mode) — so the
    // total still moves when you check/uncheck an unsized video.
    const knownSizes = items.map((it) => it.bytes || 0).filter((b) => b > 0);
    const avgKnown = knownSizes.length ? knownSizes.reduce((a, b) => a + b, 0) / knownSizes.length : 0;
    const hasUnknown = items.some((it) => !it.bytes);
    const numSelected = () => checked.filter(Boolean).length;
    const selectedSize = () => items.reduce(
      (a, it, i) => (checked[i] ? a + (it.bytes && it.bytes > 0 ? it.bytes : avgKnown) : a), 0,
    );

    const refresh = () => {
      const n = numSelected();
      const size = selectedSize();
      const sizeStr = size > 0
        ? `${hasUnknown ? '~' : ''}${formatBytes(size)}${hasUnknown ? ' (est.)' : ''}`
        : 'sized at download';
      sub.textContent = `${subtitle}${dupNote}  ·  ${sizeStr}`;
      countLbl.textContent = `${n} of ${items.length}`;
      toggleAll.textContent = n === items.length ? 'Deselect all' : 'Select all';
      go.textContent = n ? `Download ${n}` : 'Download';
      go.style.opacity = n ? '1' : '0.5';
      go.style.cursor = n ? 'pointer' : 'default';
      rowEls.forEach((el, i) => { el.style.opacity = checked[i] ? '1' : '0.45'; });
    };

    items.forEach((it, i) => {
      const r = document.createElement('div');
      Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 24px', cursor: 'pointer' });
      const box = document.createElement('div');
      Object.assign(box.style, { width: '18px', height: '18px', borderRadius: '5px', flexShrink: '0', border: '2px solid #cc0000', background: '#cc0000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#fff', fontWeight: '700' });
      const tick = () => { box.textContent = checked[i] ? '✓' : ''; box.style.background = checked[i] ? '#cc0000' : 'transparent'; };
      const tWrap = document.createElement('div');
      Object.assign(tWrap.style, { flex: '1', minWidth: '0' });
      const t = document.createElement('div');
      t.textContent = it.title || it.url;
      Object.assign(t.style, { fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      tWrap.append(t);
      if (dup[i]) {
        const tag = document.createElement('div');
        tag.textContent = when[i] ? `✓ downloaded ${new Date(when[i]).toLocaleDateString()}` : '✓ already downloaded';
        Object.assign(tag.style, { fontSize: '11px', color: '#81c784', marginTop: '2px' });
        tWrap.append(tag);
      }
      const sz = document.createElement('div');
      sz.textContent = it.bytes ? formatBytes(it.bytes) : '—';
      Object.assign(sz.style, { fontSize: '12px', color: '#888', flexShrink: '0', minWidth: '54px', textAlign: 'right' });
      r.append(box, tWrap, sz);
      r.onclick = () => { checked[i] = !checked[i]; tick(); refresh(); };
      tick();
      rowEls.push(r);
      list.append(r);
    });

    toggleAll.onclick = () => {
      const all = numSelected() === items.length;
      checked.fill(!all);
      rowEls.forEach((el) => { const box = el.firstChild as HTMLElement; box.textContent = !all ? '✓' : ''; box.style.background = !all ? '#cc0000' : 'transparent'; });
      refresh();
    };

    // Footer actions
    const foot = document.createElement('div');
    Object.assign(foot.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end', padding: '14px 24px', borderTop: '1px solid #2a2a2a' });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { padding: '10px 18px', borderRadius: '10px', border: '1px solid #444', background: '#2b2b2b', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit' });
    const go = document.createElement('button');
    Object.assign(go.style, { padding: '10px 18px', borderRadius: '10px', border: 'none', background: '#cc0000', color: '#fff', fontSize: '14px', fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit' });
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
