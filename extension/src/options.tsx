import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiFolder, FiRefreshCw } from 'react-icons/fi';
import { FaGithub, FaMugHot } from 'react-icons/fa';
import { DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT, NamingOptions, defaultNaming, NAMING_KEYS } from './types';

export const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';

// Support links — fill these in when ready.
const SUPPORT_LINKS = {
  githubSponsors: '#',     // e.g. https://github.com/sponsors/<you>
  buyMeACoffee: '#',       // e.g. https://buymeacoffee.com/<you>
};

type Tab = 'downloads' | 'settings' | 'setup' | 'support';

type JobStatus = 'queued' | 'probing' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  batchLabel?: string;
  label: string;
  status: JobStatus;
  estBytes?: number;
  createdAt: number;
  finishedAt?: number;
  folder?: string;
  error?: string;
}

const BADGE: Record<string, { bg: string; fg: string; text: string }> = {
  done:      { bg: 'rgba(76,175,80,0.15)',  fg: '#81c784', text: 'Done' },
  failed:    { bg: 'rgba(239,83,80,0.15)',  fg: '#ef9a9a', text: 'Failed' },
  cancelled: { bg: 'rgba(136,136,136,0.15)', fg: '#aaa',    text: 'Cancelled' },
};

function formatBytes(b?: number): string {
  if (!b || b <= 0) return '';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

// ── App shell with tabs ───────────────────────────────────────────────────────
function App() {
  const [tab, setTab] = useState<Tab>('downloads');
  const version = chrome.runtime.getManifest().version;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'downloads', label: 'Downloads' },
    { id: 'settings', label: 'Settings' },
    { id: 'setup', label: 'Setup & Status' },
    { id: 'support', label: 'Support' },
  ];

  return (
    <div style={page}>
      <div style={shell}>
        <div style={sidebar}>
          <div style={{ ...header }}>
            <span style={logo}>TubeVault</span>
          </div>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{ ...navBtn, ...(tab === t.id ? navBtnActive : {}) }}
            >
              {t.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: '#555', padding: '8px 14px' }}>v{version}</div>
        </div>

        <div style={content}>
          {tab === 'downloads' && <HistorySection />}
          {tab === 'settings' && <SettingsSection />}
          {tab === 'setup' && <SetupSection />}
          {tab === 'support' && <SupportSection />}
        </div>
      </div>
    </div>
  );
}

// ── Downloads / History ───────────────────────────────────────────────────────
function HistorySection() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filter, setFilter] = useState<'all' | 'done' | 'failed' | 'cancelled'>('all');

  useEffect(() => {
    const load = () => chrome.storage.local.get({ tvJobs: [] }, (s) => setJobs(s.tvJobs as Job[]));
    load();
    const onChg = (c: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && c.tvJobs) load(); };
    chrome.storage.onChanged.addListener(onChg);
    return () => chrome.storage.onChanged.removeListener(onChg);
  }, []);

  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled').reverse();
  const shown = filter === 'all' ? finished : finished.filter((j) => j.status === filter);

  const openFolder = (folder?: string) => {
    if (folder) chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'open_folder', windowsPath: folder } });
  };
  const clear = () => chrome.runtime.sendMessage({ type: 'TUBE_VAULT_CLEAR_HISTORY' });

  return (
    <div>
      <SectionHeader title="Download history" subtitle={`${finished.length} finished`} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'done', 'failed', 'cancelled'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...filterChip, ...(filter === f ? filterChipActive : {}) }}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {finished.length > 0 && <button onClick={clear} style={textBtn}>Clear history</button>}
      </div>

      {shown.length === 0 ? (
        <div style={emptyBox}>No downloads yet.</div>
      ) : (
        <div style={card}>
          {shown.map((j, i) => {
            const badge = BADGE[j.status] ?? BADGE.done;
            const size = formatBytes(j.estBytes);
            const when = j.finishedAt ? new Date(j.finishedAt).toLocaleString() : '';
            return (
              <div key={j.id} style={{ ...histRow, borderTop: i === 0 ? 'none' : '1px solid #262626' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={histTitle}>{j.label}</div>
                  <div style={histMeta}>
                    {j.batchLabel ? `${j.batchLabel} · ` : ''}{when}{size ? ` · ${size}` : ''}
                    {j.status === 'failed' && j.error ? ` · ${j.error.slice(0, 60)}` : ''}
                  </div>
                </div>
                <span style={{ ...badgeStyle, background: badge.bg, color: badge.fg }}>{badge.text}</span>
                {j.status === 'done' && j.folder && (
                  <button style={iconBtn} title="Open folder" onClick={() => openFolder(j.folder)}><FiFolder size={15} /></button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
function parseCounts(text: string): number[] {
  const nums = text.split(',').map((t) => parseInt(t.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b);
}

function SettingsSection() {
  const [outputRoot, setOutputRoot] = useState('');
  const [autoOpen, setAutoOpen] = useState(true);
  const [countsText, setCountsText] = useState(DEFAULT_CHANNEL_COUNTS.join(', '));
  const [defaultCount, setDefaultCount] = useState(DEFAULT_CHANNEL_COUNT);
  const [naming, setNaming] = useState<NamingOptions>(defaultNaming);
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    const namingDefaults = Object.fromEntries(
      (Object.keys(NAMING_KEYS) as (keyof NamingOptions)[]).map((k) => [NAMING_KEYS[k], defaultNaming[k]])
    );
    chrome.storage.local.get(
      { outputRoot: DEFAULT_OUTPUT_ROOT, autoOpenFolder: true, channelCounts: DEFAULT_CHANNEL_COUNTS, channelDefaultCount: DEFAULT_CHANNEL_COUNT, ...namingDefaults },
      (s) => {
        setOutputRoot(s.outputRoot); setAutoOpen(s.autoOpenFolder); setCountsText((s.channelCounts as number[]).join(', ')); setDefaultCount(s.channelDefaultCount);
        setNaming(Object.fromEntries(
          (Object.keys(NAMING_KEYS) as (keyof NamingOptions)[]).map((k) => [k, !!s[NAMING_KEYS[k]]])
        ) as unknown as NamingOptions);
      }
    );
  }, []);

  const parsedCounts = parseCounts(countsText);
  const setNameFlag = (k: keyof NamingOptions, v: boolean) => setNaming((n) => ({ ...n, [k]: v }));

  function save() {
    const root = outputRoot.trim() || DEFAULT_OUTPUT_ROOT;
    const counts = parsedCounts.length ? parsedCounts : DEFAULT_CHANNEL_COUNTS;
    const def = counts.includes(defaultCount) ? defaultCount : counts[counts.length - 1];
    const namingFlat = Object.fromEntries(
      (Object.keys(NAMING_KEYS) as (keyof NamingOptions)[]).map((k) => [NAMING_KEYS[k], naming[k]])
    );
    chrome.storage.local.set({ outputRoot: root, autoOpenFolder: autoOpen, channelCounts: counts, channelDefaultCount: def, ...namingFlat }, () => {
      setOutputRoot(root); setCountsText(counts.join(', ')); setDefaultCount(def);
      setStatus('saved'); setTimeout(() => setStatus('idle'), 2000);
    });
  }

  // Live preview of the save path, dropping segments as toggles turn off.
  const previewPath = [
    'MrBeast',
    naming.categoryFolders ? 'Most Popular' : null,
    `${naming.numbering ? '001 - ' : ''}I Spent 50 Hours${naming.includeId ? ' [abc123]' : ''}`,
    `${naming.titleFiles ? 'I Spent 50 Hours' : 'video'}.mp4`,
  ].filter(Boolean).join(' / ');

  return (
    <div>
      <SectionHeader title="Settings" />
      <div style={card}>
        <div style={{ padding: 20 }}>
          <Field label="Download Folder">
            <p style={hint}>Windows path where videos will be saved.</p>
            <input style={input} value={outputRoot} onChange={(e) => setOutputRoot(e.target.value)} placeholder={DEFAULT_OUTPUT_ROOT} spellCheck={false} />
            <p style={muted}>Default: {DEFAULT_OUTPUT_ROOT}</p>
          </Field>

          <div style={divider} />

          <Field label="After Download">
            <label style={checkRow}>
              <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} style={{ accentColor: '#cc0000', width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }} />
              <span>Open folder in Windows Explorer after download</span>
            </label>
          </Field>

          <div style={divider} />

          <Field label="File naming & folders">
            {([
              ['titleFiles', 'Name files by title (else generic video / audio / thumbnail)'],
              ['summaryTxt', 'Write a .txt summary in each folder'],
              ['categoryFolders', 'Group batches into Most Popular / Latest / Playlist folders'],
              ['numbering', 'Number batch folders (001, 002…)'],
              ['includeId', 'Keep the [videoId] suffix on folder names'],
            ] as [keyof NamingOptions, string][]).map(([key, label]) => (
              <label key={key} style={checkRow}>
                <input type="checkbox" checked={naming[key]} onChange={(e) => setNameFlag(key, e.target.checked)} style={{ accentColor: '#cc0000', width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }} />
                <span>{label}</span>
              </label>
            ))}
            <p style={muted}>Preview: {previewPath}</p>
          </Field>

          <div style={divider} />

          <Field label="Channel Download Counts">
            <p style={hint}>Preset amounts offered when downloading a channel's popular/latest videos.</p>
            <input style={input} value={countsText} onChange={(e) => setCountsText(e.target.value)} placeholder="1, 5, 10, 30" spellCheck={false} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <span style={{ fontSize: 13, color: '#aaa' }}>Default:</span>
              <select value={parsedCounts.includes(defaultCount) ? defaultCount : ''} onChange={(e) => setDefaultCount(Number(e.target.value))} style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit' }}>
                {parsedCounts.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <p style={muted}>Preview: {parsedCounts.length ? parsedCounts.join(' · ') : '(none — will fall back to 1 · 5 · 10 · 30)'}</p>
          </Field>

          <div style={divider} />

          <button onClick={save} style={{ ...btn, ...(status === 'saved' ? btnSaved : {}) }}>
            {status === 'saved' ? '✓ Saved' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Setup & Status ────────────────────────────────────────────────────────────
function SetupSection() {
  const [diag, setDiag] = useState<{ ytdlp: string | null; ffmpeg: string | null; outputRoot: string | null } | null>(null);
  const [helper, setHelper] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');

  const check = () => {
    setHelper('checking');
    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'diagnostics' } }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) { setHelper('error'); setDiag(null); return; }
      setHelper('ok');
      setDiag(resp.diagnostics ?? null);
    });
  };
  useEffect(check, []);

  return (
    <div>
      <SectionHeader title="Setup & Status" />

      <div style={card}>
        <div style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={sectionLabel}>Status</div>
            <button onClick={check} style={textBtn}><FiRefreshCw size={12} style={{ verticalAlign: -1, marginRight: 5 }} />Re-check</button>
          </div>
          <StatusLine label="Native helper" value={helper === 'checking' ? 'Checking…' : helper === 'ok' ? 'Connected' : helper === 'error' ? 'Not reachable' : '—'} ok={helper === 'ok'} bad={helper === 'error'} />
          <StatusLine label="yt-dlp" value={diag?.ytdlp ?? '—'} ok={!!diag?.ytdlp} bad={helper === 'ok' && !diag?.ytdlp} />
          <StatusLine label="ffmpeg" value={diag?.ffmpeg ?? '—'} ok={!!diag?.ffmpeg} bad={helper === 'ok' && !diag?.ffmpeg} />
          <StatusLine label="Output folder" value={diag?.outputRoot ?? '—'} />
        </div>
      </div>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ padding: 20 }}>
          <div style={sectionLabel}>Installation guide</div>
          <p style={hint}>TubeVault runs downloads through a small helper in WSL. One-time setup:</p>
          <ol style={guideList}>
            <li><b>Install WSL</b> (Ubuntu) from the Microsoft Store, then open it once to finish setup.</li>
            <li><b>Install yt-dlp &amp; ffmpeg</b> inside WSL:
              <pre style={code}>sudo apt update &amp;&amp; sudo apt install -y ffmpeg{'\n'}sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp{'\n'}sudo chmod a+rx /usr/local/bin/yt-dlp</pre>
            </li>
            <li><b>Register the native messaging host</b> so Chrome can talk to the helper (run the project's install script once).</li>
            <li><b>Build the helper</b> (<code style={inlineCode}>cd helper &amp;&amp; npm install &amp;&amp; npm run build</code>).</li>
            <li>Reload this extension, then hit <b>Re-check</b> above — all three should read green.</li>
          </ol>
          <p style={muted}>If the helper shows “Not reachable”, the native-messaging host registration or the helper build is the usual culprit.</p>
        </div>
      </div>
    </div>
  );
}

function StatusLine({ label, value, ok, bad }: { label: string; value: string; ok?: boolean; bad?: boolean }) {
  const color = ok ? '#81c784' : bad ? '#ef9a9a' : '#aaa';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #232323' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: ok ? '#4caf50' : bad ? '#ef5350' : '#666', flexShrink: 0 }} />
      <span style={{ width: 110, color: '#999', fontSize: 13 }}>{label}</span>
      <span style={{ flex: 1, color, fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

// ── Support ───────────────────────────────────────────────────────────────────
function SupportSection() {
  return (
    <div>
      <SectionHeader title="Support" subtitle="TubeVault is free & open. If it saved you time, consider chipping in." />
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <a href={SUPPORT_LINKS.githubSponsors} target="_blank" rel="noreferrer" style={{ ...supportBtn, background: '#24292e' }}>
          <FaGithub size={22} /> <span>GitHub Sponsors</span>
        </a>
        <a href={SUPPORT_LINKS.buyMeACoffee} target="_blank" rel="noreferrer" style={{ ...supportBtn, background: '#ffdd00', color: '#222' }}>
          <FaMugHot size={20} /> <span>Buy Me a Coffee</span>
        </a>
      </div>
      <p style={{ ...muted, marginTop: 18 }}>Thank you for using TubeVault. ♥</p>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────
function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>{subtitle}</div>}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 4 }}><div style={sectionLabel}>{label}</div>{children}</div>;
}

createRoot(document.getElementById('root')!).render(<App />);

// ── Styles ────────────────────────────────────────────────────────────────────
const page: React.CSSProperties = { minHeight: '100vh', background: '#111', color: '#eee', fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 14 };
const shell: React.CSSProperties = { display: 'flex', minHeight: '100vh', maxWidth: 900, margin: '0 auto' };
const sidebar: React.CSSProperties = { width: 200, borderRight: '1px solid #222', display: 'flex', flexDirection: 'column', padding: '24px 12px', boxSizing: 'border-box' };
const header: React.CSSProperties = { padding: '0 14px 20px' };
const logo: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: '#cc0000' };
const navBtn: React.CSSProperties = { textAlign: 'left', background: 'none', border: 'none', color: '#aaa', fontSize: 14, fontWeight: 500, padding: '10px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 2 };
const navBtnActive: React.CSSProperties = { background: '#1e1e1e', color: '#fff' };
const content: React.CSSProperties = { flex: 1, padding: '40px 36px', boxSizing: 'border-box', minWidth: 0 };
const card: React.CSSProperties = { background: '#1a1a1a', borderRadius: 10, border: '1px solid #262626', overflow: 'hidden' };
const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 };
const hint: React.CSSProperties = { margin: '0 0 8px', color: '#aaa', fontSize: 13 };
const input: React.CSSProperties = { width: '100%', background: '#2a2a2a', border: '1px solid #444', borderRadius: 6, color: '#eee', fontSize: 13, padding: '8px 10px', boxSizing: 'border-box', outline: 'none', fontFamily: 'monospace' };
const muted: React.CSSProperties = { margin: '6px 0 0', fontSize: 11, color: '#555' };
const divider: React.CSSProperties = { height: 1, background: '#262626', margin: '20px 0' };
const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', marginBottom: 10, userSelect: 'none' };
const btn: React.CSSProperties = { background: '#cc0000', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 600, padding: '9px 20px', cursor: 'pointer', transition: 'background 0.2s', fontFamily: 'inherit' };
const btnSaved: React.CSSProperties = { background: '#2e7d32' };
const emptyBox: React.CSSProperties = { padding: '40px', textAlign: 'center', color: '#666', fontSize: 14, background: '#1a1a1a', borderRadius: 10, border: '1px solid #262626' };
const histRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px' };
const histTitle: React.CSSProperties = { fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const histMeta: React.CSSProperties = { fontSize: 12, color: '#888', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const badgeStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, flexShrink: 0 };
const iconBtn: React.CSSProperties = { background: '#2a2a2a', border: '1px solid #3a3a3a', color: '#bbb', cursor: 'pointer', borderRadius: 7, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const filterChip: React.CSSProperties = { background: 'none', border: '1px solid #333', color: '#999', fontSize: 12, padding: '4px 11px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit' };
const filterChipActive: React.CSSProperties = { background: '#cc0000', borderColor: '#cc0000', color: '#fff' };
const textBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#888', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' };
const guideList: React.CSSProperties = { margin: '10px 0 0', paddingLeft: 20, fontSize: 13, color: '#ccc', lineHeight: 1.7 };
const code: React.CSSProperties = { background: '#0d0d0d', border: '1px solid #262626', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: '#ddd', overflowX: 'auto', margin: '8px 0', whiteSpace: 'pre' };
const inlineCode: React.CSSProperties = { background: '#0d0d0d', border: '1px solid #262626', borderRadius: 4, padding: '1px 5px', fontSize: 12 };
const supportBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 10, padding: '14px 22px', borderRadius: 10, color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600 };
