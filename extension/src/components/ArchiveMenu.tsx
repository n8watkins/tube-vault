import React from 'react';
import { createPortal } from 'react-dom';
import { FiVideo, FiHeadphones, FiFileText, FiImage, FiPackage } from 'react-icons/fi';
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

const CHANNEL_MODES: { key: ChannelMode; label: string }[] = [
  { key: 'popular_alltime', label: 'Most popular · all-time' },
  { key: 'popular_recent', label: `Most popular · recent ${RECENT_POOL}` },
  { key: 'latest', label: 'Latest uploads' },
  { key: 'all', label: 'Everything' },
];

// Rough: ~0.25s per video to fetch view counts (parallelized).
function estimateRankSecs(videoCount: number): string {
  const secs = Math.max(5, Math.round((videoCount * 0.25) / 5) * 5);
  return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`;
}

interface Props {
  menuRef: React.RefObject<HTMLDivElement>;
  anchorRect: DOMRect;
  dropUp?: boolean;
  state: MenuState;
  onChange: (updates: Partial<MenuState>) => void;
  playlist: boolean;
  channel?: ChannelControls;
  onArchive: () => void;
}

export function ArchiveMenu({ menuRef, anchorRect, dropUp, state, onChange, playlist, channel, onArchive }: Props) {
  const noneSelected = !state.video && !state.audio && !state.metadata && !state.thumbnail;

  const bundleAll = () =>
    onChange({ video: true, audio: true, metadata: true, thumbnail: true });

  const posStyle = dropUp
    ? { bottom: window.innerHeight - anchorRect.top + 6, left: anchorRect.left }
    : { top: anchorRect.bottom + 6, left: anchorRect.left };

  const headerText = channel ? 'Download Channel' : playlist ? 'Download Playlist' : 'Download Options';
  const archiveLabel = channel
    ? (channel.mode === 'all' ? 'Download All'
        : channel.mode === 'latest' ? `Download Latest ${channel.count}`
        : `Download Top ${channel.count}`)
    : playlist ? 'Download Playlist' : 'Download';

  const content = (
    <div
      ref={menuRef}
      style={{ ...panel, ...posStyle }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={headerStyle}>{headerText}</div>

      {channel && (
        <>
          {/* Mode: radio list of the four ways to pick channel videos */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 8 }}>
            {CHANNEL_MODES.map(({ key, label }) => {
              const active = channel.mode === key;
              const popularActive = channel.sortState === 'popular';
              return (
                <div key={key}>
                  <label style={radioRow} onClick={(e) => { e.stopPropagation(); channel.onMode(key); }}>
                    <span style={{ ...radioDot, ...(active ? radioDotOn : {}) }} />
                    <span style={{ flex: 1 }}>{label}</span>
                    {key === 'popular_alltime' && popularActive && <span style={badgeOk}>✓ active</span>}
                  </label>
                  {key === 'popular_alltime' && active && !popularActive && (
                    <div style={hintSub}>
                      ⤷ Open the channel’s Videos tab and click “Popular” for all-time.
                      Otherwise we’ll grab the recent-{RECENT_POOL} most-viewed.
                    </div>
                  )}
                  {key === 'popular_recent' && active && (
                    <div style={hintQuiet}>
                      Ranks the {RECENT_POOL} newest uploads by views (~{estimateRankSecs(RECENT_POOL)}).
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Count — irrelevant for "all" */}
          <div style={{ ...optRow, opacity: channel.mode === 'all' ? 0.35 : 1 }}>
            <span style={{ fontSize: 12, color: '#ccc' }}>How many</span>
            <select
              disabled={channel.mode === 'all'}
              value={channel.count}
              onChange={(e) => channel.onCount(Number(e.target.value))}
              style={selStyle(channel.mode !== 'all')}
              onClick={(e) => e.stopPropagation()}
            >
              {channel.counts.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div style={divider} />
        </>
      )}

      {/* Video */}
      <div style={optRow}>
        <label style={checkLabel} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={state.video}
            onChange={(e) => onChange({ video: e.target.checked })}
            style={cbStyle}
          />
          <FiVideo size={13} />
          <span>Video</span>
        </label>
        <div style={selGroup}>
          <select
            disabled={!state.video}
            value={state.videoQuality}
            onChange={(e) => onChange({ videoQuality: e.target.value as VideoQuality })}
            style={selStyle(state.video)}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="best">Best</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>
          <select
            disabled={!state.video}
            value={state.videoFormat}
            onChange={(e) => onChange({ videoFormat: e.target.value as VideoFormat })}
            style={selStyle(state.video)}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="mp4">MP4</option>
            <option value="webm">WebM</option>
            <option value="mkv">MKV</option>
          </select>
        </div>
      </div>

      {/* Audio */}
      <div style={optRow}>
        <label style={checkLabel} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={state.audio}
            onChange={(e) => onChange({ audio: e.target.checked })}
            style={cbStyle}
          />
          <FiHeadphones size={13} />
          <span>Audio</span>
        </label>
        <div style={selGroup}>
          <select
            disabled={!state.audio}
            value={state.audioFormat}
            onChange={(e) => onChange({ audioFormat: e.target.value as AudioFormat })}
            style={selStyle(state.audio)}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="m4a">M4A</option>
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
            <option value="opus">Opus</option>
          </select>
        </div>
      </div>

      <div style={divider} />

      <div style={simpleRow}>
        <label style={checkLabel} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={state.metadata}
            onChange={(e) => onChange({ metadata: e.target.checked })}
            style={cbStyle}
          />
          <FiFileText size={13} />
          <span>Metadata</span>
        </label>
      </div>

      <div style={simpleRow}>
        <label style={checkLabel} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={state.thumbnail}
            onChange={(e) => onChange({ thumbnail: e.target.checked })}
            style={cbStyle}
          />
          <FiImage size={13} />
          <span>Thumbnail</span>
        </label>
      </div>

      <div style={divider} />

      <button onClick={(e) => { e.stopPropagation(); bundleAll(); }} style={bundleBtn}>
        <FiPackage size={13} style={{ marginRight: 6 }} />
        Bundle All
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

// ── Styles ────────────────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  position: 'fixed',
  marginTop: 0,
  background: '#212121',
  borderRadius: 10,
  boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
  padding: '12px 14px 10px',
  zIndex: 2147483647,
  minWidth: 310,
  color: '#fff',
  fontFamily: 'Roboto, Arial, sans-serif',
  fontSize: 13,
};

const headerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#aaa',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 10,
};

const radioRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  cursor: 'pointer',
  userSelect: 'none',
  padding: '5px 2px',
};

const radioDot: React.CSSProperties = {
  width: 13,
  height: 13,
  borderRadius: '50%',
  border: '2px solid #777',
  flexShrink: 0,
  boxSizing: 'border-box',
};

const radioDotOn: React.CSSProperties = {
  borderColor: '#cc0000',
  background: 'radial-gradient(circle, #cc0000 0 4px, transparent 5px)',
};

const badgeOk: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#4caf50',
  background: 'rgba(76,175,80,0.12)',
  borderRadius: 8,
  padding: '1px 6px',
};

const hintSub: React.CSSProperties = {
  margin: '0 0 4px 22px',
  fontSize: 11,
  lineHeight: 1.4,
  color: '#ffca28',
};

const hintQuiet: React.CSSProperties = {
  margin: '0 0 4px 22px',
  fontSize: 11,
  lineHeight: 1.4,
  color: '#888',
};

const optRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 30,
  margin: '3px 0',
};

const simpleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: 28,
  margin: '3px 0',
};

const checkLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
  userSelect: 'none',
  minWidth: 100,
};

const cbStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  cursor: 'pointer',
  accentColor: '#cc0000',
  flexShrink: 0,
  margin: 0,
};

const selGroup: React.CSSProperties = {
  display: 'flex',
  gap: 4,
};

const selStyle = (enabled: boolean): React.CSSProperties => ({
  background: '#383838',
  border: '1px solid #555',
  borderRadius: 4,
  color: '#fff',
  fontSize: 11,
  padding: '2px 4px',
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.35,
  transition: 'opacity 0.15s',
});

const divider: React.CSSProperties = {
  height: 1,
  background: '#333',
  margin: '8px 0',
};

const bundleBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  padding: '7px',
  marginBottom: 6,
  background: '#383838',
  border: '1px solid #555',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const archiveBtnBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px',
  background: '#cc0000',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const archiveBtnDisabled: React.CSSProperties = {
  opacity: 0.4,
  cursor: 'not-allowed',
};
