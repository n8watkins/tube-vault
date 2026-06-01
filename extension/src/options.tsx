import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT } from './types';

export const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';

// Parse "1, 5, 10, 30" → [1,5,10,30] (positive ints, deduped, ascending).
function parseCounts(text: string): number[] {
  const nums = text
    .split(',')
    .map((t) => parseInt(t.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b);
}

function App() {
  const [outputRoot, setOutputRoot] = useState('');
  const [autoOpen, setAutoOpen] = useState(true);
  const [countsText, setCountsText] = useState(DEFAULT_CHANNEL_COUNTS.join(', '));
  const [defaultCount, setDefaultCount] = useState(DEFAULT_CHANNEL_COUNT);
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    chrome.storage.local.get(
      {
        outputRoot: DEFAULT_OUTPUT_ROOT,
        autoOpenFolder: true,
        channelCounts: DEFAULT_CHANNEL_COUNTS,
        channelDefaultCount: DEFAULT_CHANNEL_COUNT,
      },
      (s) => {
        setOutputRoot(s.outputRoot);
        setAutoOpen(s.autoOpenFolder);
        setCountsText((s.channelCounts as number[]).join(', '));
        setDefaultCount(s.channelDefaultCount);
      }
    );
  }, []);

  const parsedCounts = parseCounts(countsText);

  function save() {
    const root = outputRoot.trim() || DEFAULT_OUTPUT_ROOT;
    const counts = parsedCounts.length ? parsedCounts : DEFAULT_CHANNEL_COUNTS;
    const def = counts.includes(defaultCount) ? defaultCount : counts[counts.length - 1];
    chrome.storage.local.set(
      { outputRoot: root, autoOpenFolder: autoOpen, channelCounts: counts, channelDefaultCount: def },
      () => {
        setOutputRoot(root);
        setCountsText(counts.join(', '));
        setDefaultCount(def);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 2000);
      }
    );
  }

  return (
    <div style={page}>
      <div style={header}>
        <span style={logo}>TubeVault</span>
        <span style={subtitle}>Settings</span>
      </div>

      <div style={card}>
        <Section label="Download Folder">
          <p style={hint}>Windows path where videos will be saved.</p>
          <input
            style={input}
            value={outputRoot}
            onChange={(e) => setOutputRoot(e.target.value)}
            placeholder={DEFAULT_OUTPUT_ROOT}
            spellCheck={false}
          />
          <p style={muted}>Default: {DEFAULT_OUTPUT_ROOT}</p>
        </Section>

        <div style={divider} />

        <Section label="After Download">
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={autoOpen}
              onChange={(e) => setAutoOpen(e.target.checked)}
              style={{ accentColor: '#cc0000', width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
            />
            <span>Open folder in Windows Explorer after download</span>
          </label>
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={true}
              disabled
              style={{ width: 15, height: 15, flexShrink: 0 }}
            />
            <span style={{ color: '#666' }}>Save receipt to Chrome downloads (always on)</span>
          </label>
        </Section>

        <div style={divider} />

        <Section label="Channel Download Counts">
          <p style={hint}>Preset amounts offered when downloading a channel's popular/latest videos.</p>
          <input
            style={input}
            value={countsText}
            onChange={(e) => setCountsText(e.target.value)}
            placeholder="1, 5, 10, 30"
            spellCheck={false}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 13, color: '#aaa' }}>Default:</span>
            <select
              value={parsedCounts.includes(defaultCount) ? defaultCount : ''}
              onChange={(e) => setDefaultCount(Number(e.target.value))}
              style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit' }}
            >
              {parsedCounts.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <p style={muted}>Preview: {parsedCounts.length ? parsedCounts.join(' · ') : '(none — will fall back to 1 · 5 · 10 · 30)'}</p>
        </Section>

        <div style={divider} />

        <button onClick={save} style={{ ...btn, ...(status === 'saved' ? btnSaved : {}) }}>
          {status === 'saved' ? '✓ Saved' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={sectionLabel}>{label}</div>
      {children}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

// ── Styles ────────────────────────────────────────────────────────────────────

const page: React.CSSProperties = {
  minHeight: '100vh',
  background: '#111',
  color: '#eee',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 14,
  padding: '40px 24px',
  boxSizing: 'border-box',
};

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  marginBottom: 28,
};

const logo: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: '#cc0000',
};

const subtitle: React.CSSProperties = {
  fontSize: 16,
  color: '#888',
};

const card: React.CSSProperties = {
  background: '#1e1e1e',
  borderRadius: 10,
  padding: '24px',
  maxWidth: 560,
  border: '1px solid #2a2a2a',
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  marginBottom: 10,
};

const hint: React.CSSProperties = {
  margin: '0 0 8px',
  color: '#aaa',
  fontSize: 13,
};

const input: React.CSSProperties = {
  width: '100%',
  background: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: 6,
  color: '#eee',
  fontSize: 13,
  padding: '8px 10px',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'monospace',
};

const muted: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  color: '#555',
};

const divider: React.CSSProperties = {
  height: 1,
  background: '#2a2a2a',
  margin: '20px 0',
};

const checkRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  cursor: 'pointer',
  marginBottom: 10,
  userSelect: 'none',
};

const btn: React.CSSProperties = {
  background: '#cc0000',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  padding: '9px 20px',
  cursor: 'pointer',
  transition: 'background 0.2s',
  fontFamily: 'inherit',
};

const btnSaved: React.CSSProperties = {
  background: '#2e7d32',
};
