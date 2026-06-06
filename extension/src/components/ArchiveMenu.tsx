import React from 'react';
import { createPortal } from 'react-dom';
import { FiVideo, FiHeadphones, FiFileText, FiImage, FiCheckSquare, FiSquare } from 'react-icons/fi';
import { MenuState, VideoQuality, VideoFormat, AudioFormat, ChannelMode, RECENT_POOL } from '../types';

interface ChannelControls {
  mode: ChannelMode;
  count: number;
  counts: number[];
  videoCount: number | null;
  sortState: 'popular' | 'other' | null;
  onMode: (m: ChannelMode) => void;
  onCount: (n: number) => void;
}

interface Props {
  menuRef: React.RefObject<HTMLDivElement>;
  anchorRect: DOMRect;
  dropUp?: boolean;
  state: MenuState;
  onChange: (updates: Partial<MenuState>) => void;
  playlist: boolean;
  playlistLabel?: string;
  channel?: ChannelControls;
  onArchive: () => void;
}

type TopLevel = 'popular' | 'latest' | 'all';

export function ArchiveMenu({ menuRef, anchorRect, dropUp, state, onChange, playlist, playlistLabel = 'Playlist', channel, onArchive }: Props) {
  const noneSelected = !state.video && !state.audio && !state.metadata && !state.thumbnail;
  const allSelected = state.video && state.audio && state.metadata && state.thumbnail;

  const toggleAll = () => {
    const v = !allSelected;
    onChange({ video: v, audio: v, metadata: v, thumbnail: v });
  };

  const posStyle = dropUp
    ? { bottom: window.innerHeight - anchorRect.top + 8, left: anchorRect.left }
    : { top: anchorRect.bottom + 8, left: anchorRect.left };

  const headerText = channel ? 'Download Channel' : playlist ? `Download ${playlistLabel}` : 'Download Options';

  // ── Channel mode is stored as one of four values; the UI presents it as a
  //    top-level choice plus a Popular sub-choice. ──────────────────────────────
  const topLevel: TopLevel =
    !channel ? 'latest'
      : channel.mode === 'latest' ? 'latest'
      : channel.mode === 'all' ? 'all'
      : 'popular';
  const popularSub: 'alltime' | 'recent' = channel?.mode === 'popular_alltime' ? 'alltime' : 'recent';
  const popularActive = channel?.sortState === 'popular';

  const pickTop = (t: TopLevel) => {
    if (!channel) return;
    if (t === 'latest') channel.onMode('latest');
    else if (t === 'all') channel.onMode('all');
    else channel.onMode(popularActive ? 'popular_alltime' : 'popular_recent');
  };
  const pickSub = (s: 'alltime' | 'recent') => {
    if (!channel) return;
    if (s === 'alltime') { if (popularActive) channel.onMode('popular_alltime'); }
    else channel.onMode('popular_recent');
  };

  const archiveLabel = channel
    ? (topLevel === 'all' ? 'Download Everything' : `Download Top ${channel.count}`)
    : playlist ? `Download ${playlistLabel}` : 'Download';

  const content = (
    <div ref={menuRef} style={{ ...panel, ...posStyle }} onClick={(e) => e.stopPropagation()}>
      <div style={headerStyle}>{headerText}</div>

      {channel && (
        <>
          {/* Top-level: Most Popular / Latest / Everything */}
          <div style={pillRow}>
            {([['popular', 'Most Popular'], ['latest', 'Latest'], ['all', 'Everything']] as [TopLevel, string][]).map(([k, lbl]) => (
              <button key={k} onClick={(e) => { e.stopPropagation(); pickTop(k); }}
                style={{ ...pill, ...(topLevel === k ? pillOn : {}) }}>
                {lbl}
              </button>
            ))}
          </div>

          {/* Popular sub-choice only appears under Most Popular */}
          {topLevel === 'popular' && (
            <>
              <div style={subPillRow}>
                <button
                  onClick={(e) => { e.stopPropagation(); pickSub('alltime'); }}
                  disabled={!popularActive}
                  style={{ ...subPill, ...(popularSub === 'alltime' && popularActive ? subPillOn : {}), ...(!popularActive ? subPillDisabled : {}) }}
                >
                  All-time{popularActive ? ' ✓' : ''}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); pickSub('recent'); }}
                  style={{ ...subPill, ...(popularSub === 'recent' ? subPillOn : {}) }}
                >
                  Recent {RECENT_POOL}
                </button>
              </div>
              {!popularActive && (
                <div style={hintSub}>
                  Sort the channel’s <b>Videos</b> tab by <b>“Popular”</b> to unlock all-time most-viewed.
                </div>
              )}
              {popularSub === 'recent' && popularActive && (
                <div style={hintQuiet}>Ranks the {RECENT_POOL} newest uploads by views.</div>
              )}
            </>
          )}

          {topLevel !== 'all' && (
            <div style={countRow}>
              <span style={countLabel}>How many</span>
              <select value={channel.count} onChange={(e) => channel.onCount(Number(e.target.value))}
                style={bigSelect} onClick={(e) => e.stopPropagation()}>
                {channel.counts.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          <div style={divider} />
        </>
      )}

      {/* Component toggles */}
      <Card on={state.video} onToggle={() => onChange({ video: !state.video })} icon={<FiVideo size={17} />} label="Video">
        <div style={selGroup} onClick={(e) => e.stopPropagation()}>
          <select value={state.videoQuality}
            title={state.video ? undefined : 'Click to enable Video'}
            onMouseDown={state.video ? undefined : (e) => { e.preventDefault(); e.stopPropagation(); onChange({ video: true }); }}
            onChange={(e) => onChange({ videoQuality: e.target.value as VideoQuality })} style={inlineSelect(state.video)}>
            <option value="best">Best</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>
          <select value={state.videoFormat}
            title={state.video ? undefined : 'Click to enable Video'}
            onMouseDown={state.video ? undefined : (e) => { e.preventDefault(); e.stopPropagation(); onChange({ video: true }); }}
            onChange={(e) => onChange({ videoFormat: e.target.value as VideoFormat })} style={inlineSelect(state.video)}>
            <option value="mp4">MP4</option>
            <option value="webm">WebM</option>
            <option value="mkv">MKV</option>
          </select>
        </div>
      </Card>

      <Card on={state.audio} onToggle={() => onChange({ audio: !state.audio })} icon={<FiHeadphones size={17} />} label="Audio">
        <div style={selGroup} onClick={(e) => e.stopPropagation()}>
          <select value={state.audioFormat}
            title={state.audio ? undefined : 'Click to enable Audio'}
            onMouseDown={state.audio ? undefined : (e) => { e.preventDefault(); e.stopPropagation(); onChange({ audio: true }); }}
            onChange={(e) => onChange({ audioFormat: e.target.value as AudioFormat })} style={inlineSelect(state.audio)}>
            <option value="m4a">M4A</option>
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
            <option value="opus">Opus</option>
          </select>
        </div>
      </Card>

      <Card on={state.metadata} onToggle={() => onChange({ metadata: !state.metadata })} icon={<FiFileText size={17} />} label="Metadata" />
      <Card on={state.thumbnail} onToggle={() => onChange({ thumbnail: !state.thumbnail })} icon={<FiImage size={17} />} label="Thumbnail" />

      <div style={divider} />

      <button onClick={(e) => { e.stopPropagation(); toggleAll(); }} style={bundleBtn}>
        {allSelected
          ? <><FiSquare size={15} style={{ marginRight: 7 }} />Deselect All</>
          : <><FiCheckSquare size={15} style={{ marginRight: 7 }} />Select All</>}
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); if (!noneSelected) onArchive(); }}
        style={{ ...archiveBtnBase, ...(noneSelected ? archiveBtnDisabled : {}) }}
      >
        {archiveLabel}
      </button>
    </div>
  );

  return createPortal(content, document.body);
}

// ── Selectable component card (replaces the old checkbox row) ──────────────────
function Card({ on, onToggle, icon, label, children }: {
  on: boolean; onToggle: () => void; icon: React.ReactNode; label: string; children?: React.ReactNode;
}) {
  return (
    <div style={{ ...card, ...(on ? cardOn : {}) }} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <span style={{ ...iconWrap, color: on ? '#ff5252' : '#777' }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600, color: on ? '#fff' : '#aaa' }}>{label}</span>
      {children}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  position: 'fixed',
  background: '#1c1c1c',
  borderRadius: 14,
  boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
  border: '1px solid #2e2e2e',
  padding: '14px 16px 12px',
  zIndex: 2147483647,
  minWidth: 340,
  color: '#fff',
  fontFamily: 'Roboto, system-ui, Arial, sans-serif',
  fontSize: 14,
};

const headerStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 12,
};

const pillRow: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 8 };

const pill: React.CSSProperties = {
  flex: 1,
  padding: '10px 0',
  background: '#262626',
  border: '1px solid #333',
  borderRadius: 22,
  color: '#bbb',
  fontSize: 13.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'all 0.15s',
};

const pillOn: React.CSSProperties = {
  background: '#cc0000',
  borderColor: '#cc0000',
  color: '#fff',
};

const subPillRow: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 6 };

const subPill: React.CSSProperties = {
  flex: 1,
  padding: '7px 0',
  background: '#222',
  border: '1px solid #333',
  borderRadius: 18,
  color: '#bbb',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const subPillOn: React.CSSProperties = {
  background: 'rgba(204,0,0,0.18)',
  borderColor: '#cc0000',
  color: '#fff',
};

const subPillDisabled: React.CSSProperties = {
  opacity: 0.4,
  cursor: 'not-allowed',
};

const hintSub: React.CSSProperties = {
  margin: '2px 2px 4px',
  fontSize: 12,
  lineHeight: 1.45,
  color: '#ffca28',
};

const hintQuiet: React.CSSProperties = {
  margin: '2px 2px 4px',
  fontSize: 12,
  lineHeight: 1.45,
  color: '#888',
};

const countRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 8,
};

const countLabel: React.CSSProperties = { fontSize: 14, color: '#ccc', fontWeight: 500 };

const bigSelect: React.CSSProperties = {
  background: '#2b2b2b',
  border: '1px solid #444',
  borderRadius: 8,
  color: '#fff',
  fontSize: 14,
  fontWeight: 600,
  padding: '6px 10px',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const divider: React.CSSProperties = { height: 1, background: '#2e2e2e', margin: '12px 0' };

const card: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  padding: '11px 12px',
  marginBottom: 7,
  background: '#232323',
  border: '1px solid transparent',
  borderRadius: 10,
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'all 0.15s',
};

const cardOn: React.CSSProperties = {
  background: 'rgba(204,0,0,0.12)',
  border: '1px solid rgba(204,0,0,0.6)',
};

const iconWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', flexShrink: 0 };

const selGroup: React.CSSProperties = { display: 'flex', gap: 6 };

const inlineSelect = (enabled: boolean): React.CSSProperties => ({
  background: '#2b2b2b',
  border: '1px solid #4a4a4a',
  borderRadius: 7,
  color: '#fff',
  fontSize: 12.5,
  fontWeight: 500,
  padding: '4px 7px',
  // Off but still clickable — a click enables the component (handled in onMouseDown).
  cursor: 'pointer',
  opacity: enabled ? 1 : 0.5,
  transition: 'opacity 0.15s',
});

const bundleBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  padding: '9px',
  marginBottom: 7,
  background: '#2b2b2b',
  border: '1px solid #444',
  borderRadius: 9,
  color: '#fff',
  fontSize: 13.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const archiveBtnBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '12px',
  background: '#cc0000',
  border: 'none',
  borderRadius: 10,
  color: '#fff',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const archiveBtnDisabled: React.CSSProperties = { opacity: 0.4, cursor: 'not-allowed' };
