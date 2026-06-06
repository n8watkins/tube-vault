import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiFolder, FiRefreshCw, FiGithub } from 'react-icons/fi';
import { DEFAULT_CHANNEL_COUNTS, DEFAULT_CHANNEL_COUNT, NamingOptions, defaultNaming, NAMING_KEYS, MenuState, defaultMenuState, VideoQuality, VideoFormat, AudioFormat } from './types';

export const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';

type Tab = 'downloads' | 'settings' | 'status' | 'setup';

type JobStatus = 'queued' | 'probing' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  batchId?: string;
  batchLabel?: string;
  category?: string;
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

function agoText(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── App shell with tabs ───────────────────────────────────────────────────────
const TAB_IDS: Tab[] = ['downloads', 'settings', 'status', 'setup'];

function App() {
  const [tab, setTab] = useState<Tab>('downloads');
  const version = chrome.runtime.getManifest().version;

  // Deep-link from the popup: it writes `tvOpenTab` before opening this page, so
  // honour it on mount and whenever it changes (page may already be open).
  useEffect(() => {
    const apply = (t?: unknown) => {
      if (typeof t === 'string' && TAB_IDS.includes(t as Tab)) {
        setTab(t as Tab);
        chrome.storage.local.remove('tvOpenTab');
      }
    };
    chrome.storage.local.get({ tvOpenTab: null }, (s) => apply(s.tvOpenTab));
    const onChg = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && c.tvOpenTab) apply(c.tvOpenTab.newValue);
    };
    chrome.storage.onChanged.addListener(onChg);
    return () => chrome.storage.onChanged.removeListener(onChg);
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'downloads', label: 'Downloads' },
    { id: 'settings', label: 'Settings' },
    { id: 'status', label: 'Status' },
    { id: 'setup', label: 'Setup' },
  ];

  return (
    <div style={page}>
      <div style={shell}>
        <div style={sidebar}>
          <div style={{ ...header, display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="icons/icon32.png" width={26} height={26} style={{ borderRadius: 6, flexShrink: 0 }} alt="" />
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
          {tab === 'status' && <StatusSection />}
          {tab === 'setup' && <SetupSection />}
        </div>
      </div>
    </div>
  );
}

// ── Downloads / History ───────────────────────────────────────────────────────
// Parent of a Windows path: C:\a\b\c → C:\a\b
const winDirname = (p: string) => p.slice(0, p.replace(/[\\/]+$/, '').lastIndexOf('\\'));

function HistorySection() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filter, setFilter] = useState<'all' | 'done' | 'failed' | 'cancelled'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);

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
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const exportHistory = () => {
    const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `tubevault-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  // Group consecutive batch members into one accordion row; singles stand alone.
  type Row = { kind: 'single'; job: Job } | { kind: 'batch'; batchId: string; members: Job[] };
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const j of shown) {
    if (!j.batchId) { rows.push({ kind: 'single', job: j }); continue; }
    if (seen.has(j.batchId)) continue;
    seen.add(j.batchId);
    rows.push({ kind: 'batch', batchId: j.batchId, members: shown.filter((x) => x.batchId === j.batchId) });
  }

  const videoRow = (j: Job, indent: boolean, top: boolean) => {
    const badge = BADGE[j.status] ?? BADGE.done;
    const size = formatBytes(j.estBytes);
    const when = j.finishedAt ? new Date(j.finishedAt).toLocaleString() : '';
    return (
      <div key={j.id} style={{ ...histRow, paddingLeft: indent ? 40 : 18, borderTop: top ? 'none' : '1px solid #262626', background: indent ? '#161616' : undefined }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={histTitle}>{j.label}</div>
          <div style={histMeta}>
            {!indent && j.batchLabel ? `${j.batchLabel} · ` : ''}{when}{size ? ` · ${size}` : ''}
            {j.status === 'failed' && j.error ? ` · ${j.error.slice(0, 60)}` : ''}
          </div>
        </div>
        <span style={{ ...badgeStyle, background: badge.bg, color: badge.fg }}>{badge.text}</span>
        {j.status === 'done' && j.folder && (
          <button style={iconBtn} title="Open folder" onClick={() => openFolder(j.folder)}><FiFolder size={15} /></button>
        )}
      </div>
    );
  };

  return (
    <div>
      <SectionHeader title="Download history" subtitle={`${finished.length} finished`} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['all', 'done', 'failed', 'cancelled'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...filterChip, ...(filter === f ? filterChipActive : {}) }}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {finished.length > 0 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={exportHistory} style={miniBtn}>Export JSON</button>
            <button onClick={() => setConfirmClear(true)} style={textBtn}>Clear history</button>
          </div>
        )}
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="Clear download history?"
          message="This removes every finished entry from this list. Your downloaded files on disk are not touched."
          confirmLabel="Clear history"
          danger
          onConfirm={() => { clear(); setConfirmClear(false); }}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {rows.length === 0 ? (
        <div style={emptyBox}>No downloads yet.</div>
      ) : (
        <div style={card}>
          {rows.map((r, i) => {
            if (r.kind === 'single') return videoRow(r.job, false, i === 0);

            const m = r.members;
            const first = m[0];
            const doneN = m.filter((x) => x.status === 'done').length;
            const failN = m.filter((x) => x.status === 'failed').length;
            const total = m.reduce((a, x) => a + (x.estBytes || 0), 0);
            const when = first.finishedAt ? new Date(first.finishedAt).toLocaleString() : '';
            const isOpen = expanded.has(r.batchId);
            const parent = m.find((x) => x.folder)?.folder;  // category/uploader folder
            return (
              <div key={r.batchId}>
                <div style={{ ...histRow, borderTop: i === 0 ? 'none' : '1px solid #262626', cursor: 'pointer' }} onClick={() => toggle(r.batchId)}>
                  <span style={chevron}>{isOpen ? '▾' : '▸'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={histTitle}>{first.batchLabel || first.category || 'Batch'}</div>
                    <div style={histMeta}>
                      {first.category && first.category !== first.batchLabel ? `${first.category} · ` : ''}{m.length} videos · {doneN} done{failN ? ` · ${failN} failed` : ''}{total ? ` · ${formatBytes(total)}` : ''} · {when}
                    </div>
                  </div>
                  {parent && (
                    <button style={iconBtn} title="Open folder" onClick={(e) => { e.stopPropagation(); openFolder(winDirname(parent)); }}><FiFolder size={15} /></button>
                  )}
                </div>
                {isOpen && m.map((j) => videoRow(j, true, false))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
function SettingsSection() {
  const [outputRoot, setOutputRoot] = useState('');
  const [counts, setCounts] = useState<number[]>(DEFAULT_CHANNEL_COUNTS);
  const [countDraft, setCountDraft] = useState('');
  const [defaultCount, setDefaultCount] = useState(DEFAULT_CHANNEL_COUNT);
  const [naming, setNaming] = useState<NamingOptions>(defaultNaming);
  const [prefs, setPrefs] = useState<MenuState>(defaultMenuState);
  const [collectHistory, setCollectHistory] = useState(true);
  const [retention, setRetention] = useState(0);
  const [notifyOnDone, setNotifyOnDone] = useState(true);
  const [autoOpenFolder, setAutoOpenFolder] = useState(false);
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    const namingDefaults = Object.fromEntries(
      (Object.keys(NAMING_KEYS) as (keyof NamingOptions)[]).map((k) => [NAMING_KEYS[k], defaultNaming[k]])
    );
    chrome.storage.local.get(
      { outputRoot: DEFAULT_OUTPUT_ROOT, channelCounts: DEFAULT_CHANNEL_COUNTS, channelDefaultCount: DEFAULT_CHANNEL_COUNT, menuDefaults: defaultMenuState, collectHistory: true, historyRetentionDays: 0, notifyOnDone: true, autoOpenFolder: false, showThumbnails: true, ...namingDefaults },
      (s) => {
        setOutputRoot(s.outputRoot); setCounts(s.channelCounts as number[]); setDefaultCount(s.channelDefaultCount);
        setPrefs({ ...defaultMenuState, ...(s.menuDefaults || {}) });
        setCollectHistory(s.collectHistory !== false);
        setRetention(Number(s.historyRetentionDays) || 0);
        setNotifyOnDone(s.notifyOnDone !== false);
        setAutoOpenFolder(!!s.autoOpenFolder);
        setShowThumbnails(s.showThumbnails !== false);
        setNaming(Object.fromEntries(
          (Object.keys(NAMING_KEYS) as (keyof NamingOptions)[]).map((k) => [k, !!s[NAMING_KEYS[k]]])
        ) as unknown as NamingOptions);
      }
    );
  }, []);

  const setNameFlag = (k: keyof NamingOptions, v: boolean) => setNaming((n) => ({ ...n, [k]: v }));
  const setPref = (patch: Partial<MenuState>) => setPrefs((p) => ({ ...p, ...patch }));
  const addCount = () => {
    const n = parseInt(countDraft, 10);
    setCountDraft('');
    if (!Number.isFinite(n) || n <= 0) return;
    setCounts((c) => [...new Set([...c, n])].sort((a, b) => a - b));
  };
  const removeCount = (n: number) => setCounts((c) => c.filter((x) => x !== n));

  function save() {
    const root = outputRoot.trim() || DEFAULT_OUTPUT_ROOT;
    const finalCounts = counts.length ? counts : DEFAULT_CHANNEL_COUNTS;
    const def = finalCounts.includes(defaultCount) ? defaultCount : finalCounts[finalCounts.length - 1];
    const namingFlat = Object.fromEntries(
      (Object.keys(NAMING_KEYS) as (keyof NamingOptions)[]).map((k) => [NAMING_KEYS[k], naming[k]])
    );
    chrome.storage.local.set({ outputRoot: root, channelCounts: finalCounts, channelDefaultCount: def, menuDefaults: prefs, collectHistory, historyRetentionDays: retention, notifyOnDone, autoOpenFolder, showThumbnails, ...namingFlat }, () => {
      setOutputRoot(root); setCounts(finalCounts); setDefaultCount(def);
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
            <p style={hint}>Preset amounts offered when downloading a channel's popular/latest videos. Add or remove presets:</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {counts.map((n) => (
                <span key={n} style={countChip}>
                  {n}
                  <button onClick={() => removeCount(n)} style={chipX} title={`Remove ${n}`}>✕</button>
                </span>
              ))}
              <input
                type="number" min={1} step={1} inputMode="numeric" value={countDraft}
                onChange={(e) => setCountDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCount(); } }}
                onBlur={addCount}
                placeholder="+ add"
                style={{ ...input, width: 72, padding: '7px 9px', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <span style={{ fontSize: 13, color: '#aaa' }}>Default:</span>
              <select value={counts.includes(defaultCount) ? defaultCount : ''} onChange={(e) => setDefaultCount(Number(e.target.value))} style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit' }}>
                {counts.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <p style={muted}>{counts.length ? counts.join(' · ') : '(none — will fall back to 1 · 5 · 10 · 30)'}</p>
          </Field>

          <div style={divider} />

          <Field label="Default quality & formats">
            <p style={hint}>What each component defaults to when you turn it on. These only seed the dropdowns — they don't pre-select anything.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22 }}>
              <div>
                <div style={prefSubLabel}>Video</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={prefs.videoQuality} onChange={(e) => setPref({ videoQuality: e.target.value as VideoQuality })} style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit' }}>
                    {(['best', '1080', '720', '480', '360'] as VideoQuality[]).map((q) => <option key={q} value={q}>{q === 'best' ? 'Best' : q + 'p'}</option>)}
                  </select>
                  <select value={prefs.videoFormat} onChange={(e) => setPref({ videoFormat: e.target.value as VideoFormat })} style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit' }}>
                    {(['mp4', 'webm', 'mkv'] as VideoFormat[]).map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <div style={prefSubLabel}>Audio</div>
                <select value={prefs.audioFormat} onChange={(e) => setPref({ audioFormat: e.target.value as AudioFormat })} style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit' }}>
                  {(['m4a', 'mp3', 'wav', 'opus'] as AudioFormat[]).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
          </Field>

          <div style={divider} />

          <Field label="Pre-select components">
            <p style={hint}>Which components start checked when you open the download menu (optional — default is none).</p>
            <label style={checkRow}>
              <input type="checkbox" checked={prefs.video} onChange={(e) => setPref({ video: e.target.checked })} style={cbx} />
              <span>Video</span>
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={prefs.audio} onChange={(e) => setPref({ audio: e.target.checked })} style={cbx} />
              <span>Audio</span>
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={prefs.subtitles} onChange={(e) => setPref({ subtitles: e.target.checked })} style={cbx} />
              <span>Subtitles</span>
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={prefs.thumbnail} onChange={(e) => setPref({ thumbnail: e.target.checked })} style={cbx} />
              <span>Thumbnail</span>
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={prefs.metadata} onChange={(e) => setPref({ metadata: e.target.checked })} style={cbx} />
              <span>Metadata</span>
            </label>
          </Field>

          <div style={divider} />

          <Field label="Notifications & folders">
            <label style={checkRow}>
              <input type="checkbox" checked={notifyOnDone} onChange={(e) => setNotifyOnDone(e.target.checked)} style={cbx} />
              <span>Show a notification when a download finishes</span>
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={autoOpenFolder} onChange={(e) => setAutoOpenFolder(e.target.checked)} style={cbx} />
              <span>Open the folder automatically when a single video finishes</span>
            </label>
            <label style={checkRow}>
              <input type="checkbox" checked={showThumbnails} onChange={(e) => setShowThumbnails(e.target.checked)} style={cbx} />
              <span>Show video thumbnails in the playlist/channel download list</span>
            </label>
            <p style={muted}>Each download also writes a <code style={inlineCode}>.txt</code> summary (title, channel, URL, files, path) into its folder — toggle that under “File naming &amp; folders”.</p>
          </Field>

          <div style={divider} />

          <Field label="History & privacy">
            <label style={checkRow}>
              <input type="checkbox" checked={collectHistory} onChange={(e) => setCollectHistory(e.target.checked)} style={cbx} />
              <span>Keep download history</span>
            </label>
            <p style={muted}>When off, nothing is recorded — duplicate protection won’t work.</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 0' }}>
              <span style={{ fontSize: 13, color: '#aaa' }}>Auto-delete history older than:</span>
              <select value={retention} onChange={(e) => setRetention(Number(e.target.value))} disabled={!collectHistory} style={{ ...input, width: 'auto', padding: '6px 8px', fontFamily: 'inherit', opacity: collectHistory ? 1 : 0.5 }}>
                <option value={0}>Never</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
              </select>
            </div>
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
function StatusSection() {
  const [diag, setDiag] = useState<{ ytdlp: string | null; ffmpeg: string | null; outputRoot: string | null } | null>(null);
  const [helper, setHelper] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [lastChecked, setLastChecked] = useState(0);

  // Only show the "Checking…" state when there's no cached result yet; otherwise
  // refresh silently in the background so returning to this tab doesn't flash a
  // loading state when the helper is already connected.
  const runCheck = (silent: boolean) => {
    if (!silent) setHelper('checking');
    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'diagnostics' } }, (resp) => {
      const ok = !(chrome.runtime.lastError || !resp?.ok);
      const d = ok ? (resp.diagnostics ?? null) : null;
      setHelper(ok ? 'ok' : 'error');
      setDiag(d);
      const at = Date.now();
      setLastChecked(at);
      chrome.storage.local.set({ tvDiag: { ok, diag: d, at } });
    });
  };
  const check = () => runCheck(false);

  useEffect(() => {
    chrome.storage.local.get({ tvDiag: null }, (s) => {
      const cached = s.tvDiag as { ok: boolean; diag: typeof diag; at: number } | null;
      if (cached) {
        setHelper(cached.ok ? 'ok' : 'error'); setDiag(cached.diag); setLastChecked(cached.at);
        runCheck(true);   // refresh quietly
      } else {
        runCheck(false);  // first run — show the spinner
      }
    });
  }, []);

  const connected = helper === 'ok' && !!diag?.ytdlp && !!diag?.ffmpeg;
  return (
    <div>
      <SectionHeader title="Status" subtitle={helper === 'checking' ? 'Checking…' : connected ? 'Everything’s working.' : helper === 'ok' ? 'Helper connected, but a tool is missing.' : 'Helper not reachable — see Setup.'} />
      <div style={{ ...bigStatus, background: connected ? 'rgba(76,175,80,0.12)' : helper === 'checking' ? '#1a1a1a' : 'rgba(239,83,80,0.1)', borderColor: connected ? 'rgba(76,175,80,0.4)' : helper === 'error' ? 'rgba(239,83,80,0.4)' : '#2a2a2a' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: connected ? '#4caf50' : helper === 'checking' ? '#888' : '#ef5350' }} />
        <span style={{ fontSize: 17, fontWeight: 700 }}>{helper === 'checking' ? 'Checking…' : connected ? 'Connected' : 'Not connected'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastChecked > 0 && <span style={{ fontSize: 12, color: '#777' }}>Checked {agoText(lastChecked)}</span>}
          <button onClick={check} style={textBtn}><FiRefreshCw size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Re-check</button>
        </span>
      </div>
      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ padding: 20 }}>
          <div style={sectionLabel}>Details</div>
          <StatusLine label="Native helper" value={helper === 'checking' ? 'Checking…' : helper === 'ok' ? 'Connected' : helper === 'error' ? 'Not reachable' : '—'} ok={helper === 'ok'} bad={helper === 'error'} />
          <StatusLine label="yt-dlp" value={diag?.ytdlp ?? '—'} ok={!!diag?.ytdlp} bad={helper === 'ok' && !diag?.ytdlp} />
          <StatusLine label="ffmpeg" value={diag?.ffmpeg ?? '—'} ok={!!diag?.ffmpeg} bad={helper === 'ok' && !diag?.ffmpeg} />
          <StatusLine label="Output folder" value={diag?.outputRoot ?? '—'} />
        </div>
      </div>
    </div>
  );
}

function SetupSection() {
  return (
    <div>
      <SectionHeader title="Setup" subtitle="One-time installation for the local download helper." />
      <a href="https://github.com/n8watkins/tube-vault#readme" target="_blank" rel="noreferrer" style={githubLink}>
        <FiGithub size={18} /> Full setup guide &amp; tips on GitHub →
      </a>
      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ padding: 24 }}>
          <div style={sectionLabel}>Installation guide</div>
          <p style={{ ...hint, fontSize: 14.5 }}>TubeVault runs downloads through a small helper in WSL. One-time setup:</p>
          <ol style={guideList}>
            <li><b>Install WSL</b> (Ubuntu) from the Microsoft Store, then open it once to finish setup.</li>
            <li><b>Install yt-dlp &amp; ffmpeg</b> inside WSL:
              <pre style={code}>sudo apt update &amp;&amp; sudo apt install -y ffmpeg{'\n'}sudo curl -L \{'\n'}  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \{'\n'}  -o /usr/local/bin/yt-dlp{'\n'}sudo chmod a+rx /usr/local/bin/yt-dlp</pre>
            </li>
            <li><b>Register the native messaging host</b> so Chrome can talk to the helper (run the project's install script once).</li>
            <li><b>Build the helper</b> (<code style={inlineCode}>cd helper &amp;&amp; npm install &amp;&amp; npm run build</code>).</li>
            <li>Reload this extension, then check the <b>Status</b> tab — it should read Connected.</li>
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

// On-brand confirmation modal for destructive actions (Cancel left, action right).
function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); else if (e.key === 'Enter') onConfirm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);
  return (
    <div style={confirmBackdrop} onClick={onCancel}>
      <div style={confirmCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{title}</div>
        <p style={{ fontSize: 14, color: '#bbb', lineHeight: 1.55, margin: '0 0 22px' }}>{message}</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <button onClick={onCancel} style={confirmCancelBtn}>Cancel</button>
          <button onClick={onConfirm} style={{ ...confirmGoBtn, ...(danger ? { background: '#cc0000' } : {}) }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
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
const cbx: React.CSSProperties = { accentColor: '#cc0000', width: 15, height: 15, cursor: 'pointer', flexShrink: 0 };
const prefSubLabel: React.CSSProperties = { fontSize: 13, color: '#ccc', fontWeight: 600, marginBottom: 7 };
const miniBtn: React.CSSProperties = { background: '#2a2a2a', border: '1px solid #3a3a3a', color: '#ddd', borderRadius: 7, fontSize: 13, fontWeight: 600, padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit' };
const bigStatus: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderRadius: 10, border: '1px solid #2a2a2a' };
const btn: React.CSSProperties = { background: '#cc0000', border: 'none', borderRadius: 6, color: '#fff', fontSize: 13, fontWeight: 600, padding: '9px 20px', cursor: 'pointer', transition: 'background 0.2s', fontFamily: 'inherit' };
const btnSaved: React.CSSProperties = { background: '#2e7d32' };
const emptyBox: React.CSSProperties = { padding: '40px', textAlign: 'center', color: '#666', fontSize: 14, background: '#1a1a1a', borderRadius: 10, border: '1px solid #262626' };
const histRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '15px 20px' };
const chevron: React.CSSProperties = { color: '#999', fontSize: 13, width: 12, flexShrink: 0 };
const histTitle: React.CSSProperties = { fontSize: 15.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const histMeta: React.CSSProperties = { fontSize: 13, color: '#888', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const badgeStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, padding: '4px 11px', borderRadius: 20, flexShrink: 0 };
const iconBtn: React.CSSProperties = { background: '#2a2a2a', border: '1px solid #3a3a3a', color: '#bbb', cursor: 'pointer', borderRadius: 8, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const countChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#2a2a2a', border: '1px solid #3a3a3a', borderRadius: 18, padding: '6px 7px 6px 13px', fontSize: 14, fontWeight: 600, color: '#eee' };
const chipX: React.CSSProperties = { background: '#3a3a3a', border: 'none', color: '#ccc', cursor: 'pointer', borderRadius: '50%', width: 18, height: 18, fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', lineHeight: 1, padding: 0 };
const filterChip: React.CSSProperties = { background: 'none', border: '1px solid #333', color: '#bbb', fontSize: 13.5, fontWeight: 500, padding: '7px 15px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit' };
const filterChipActive: React.CSSProperties = { background: '#cc0000', borderColor: '#cc0000', color: '#fff' };
const confirmBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const confirmCard: React.CSSProperties = { background: '#1c1c1c', border: '1px solid #2e2e2e', borderRadius: 14, padding: 24, maxWidth: 420, width: '90%', boxShadow: '0 16px 48px rgba(0,0,0,0.7)' };
const confirmCancelBtn: React.CSSProperties = { padding: '10px 18px', borderRadius: 9, border: '1px solid #444', background: '#2b2b2b', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const confirmGoBtn: React.CSSProperties = { padding: '10px 18px', borderRadius: 9, border: 'none', background: '#cc0000', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const textBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#888', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' };
const guideList: React.CSSProperties = { margin: '12px 0 0', paddingLeft: 22, fontSize: 15, color: '#ccc', lineHeight: 1.85 };
const githubLink: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 9, padding: '12px 18px', background: '#1e1e1e', border: '1px solid #333', borderRadius: 10, color: '#eee', textDecoration: 'none', fontSize: 14.5, fontWeight: 600 };
const code: React.CSSProperties = { background: '#0d0d0d', border: '1px solid #262626', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: '#ddd', overflowX: 'auto', margin: '8px 0', whiteSpace: 'pre' };
const inlineCode: React.CSSProperties = { background: '#0d0d0d', border: '1px solid #262626', borderRadius: 4, padding: '1px 5px', fontSize: 12 };
