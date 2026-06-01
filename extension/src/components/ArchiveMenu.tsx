import React from 'react';
import { createPortal } from 'react-dom';
import { FiVideo, FiHeadphones, FiFileText, FiImage, FiPackage } from 'react-icons/fi';
import { MenuState, VideoQuality, VideoFormat, AudioFormat, ChannelMode } from '../types';

interface ChannelControls {
  mode: ChannelMode;
  count: number;
  counts: number[];
  videoCount: number | null;
  onMode: (m: ChannelMode) => void;
  onCount: (n: number) => void;
}

// Above this many uploads, ranking by views (popular) starts to take a while.
const POPULAR_WARN_THRESHOLD = 150;

// Rough: ~0.25s per video to fetch view counts (parallelized).
function estimateRankMinutes(videoCount: number): string {
  const secs = videoCount * 0.25;
  if (secs < 90) return `${Math.max(5, Math.round(secs / 5) * 5)}s`;
  return `${Math.round(secs / 60)} min`;
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
    ? (channel.mode === 'all' ? 'Download All' : channel.mode === 'latest' ? `Download Latest ${channel.count}` : `Download Top ${channel.count}`)
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
          {/* Mode: Popular / Latest / All */}
          <div style={segGroup}>
            {(['popular', 'latest', 'all'] as ChannelMode[]).map((m) => (
              <button
                key={m}
                onClick={(e) => { e.stopPropagation(); channel.onMode(m); }}
                style={{ ...segBtn, ...(channel.mode === m ? segBtnActive : {}) }}
              >
                {m === 'popular' ? 'Popular' : m === 'latest' ? 'Latest' : 'All'}
              </button>
            ))}
          </div>

          {/* Count — irrelevant for "all" */}
          <div style={{ ...optRow, opacity: channel.mode === 'all' ? 0.35 : 1 }}>
            <span style={{ fontSize: 12, color: '#ccc' }}>
              {channel.mode === 'latest' ? 'How many (newest)' : 'How many (most viewed)'}
            </span>
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

          {channel.mode === 'popular' && channel.videoCount != null && channel.videoCount > POPULAR_WARN_THRESHOLD && (
            <div style={warnBox}>
              ⚠ This channel has {channel.videoCount.toLocaleString()} videos. Ranking by views
              checks every upload, so it may take ~{estimateRankMinutes(channel.videoCount)} before
              downloads start.
            </div>
          )}

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

const segGroup: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  marginBottom: 10,
};

const segBtn: React.CSSProperties = {
  flex: 1,
  padding: '6px 0',
  background: '#383838',
  border: '1px solid #555',
  borderRadius: 6,
  color: '#ccc',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const segBtnActive: React.CSSProperties = {
  background: '#cc0000',
  borderColor: '#cc0000',
  color: '#fff',
};

const warnBox: React.CSSProperties = {
  background: 'rgba(255,193,7,0.12)',
  border: '1px solid rgba(255,193,7,0.4)',
  borderRadius: 6,
  padding: '7px 9px',
  marginTop: 8,
  fontSize: 11,
  lineHeight: 1.4,
  color: '#ffca28',
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
