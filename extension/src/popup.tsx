import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiSettings, FiClock, FiFolder } from 'react-icons/fi';

// Empty = let the helper resolve the OS-appropriate default; the real path comes
// back on ping (helperDefault). No hardcoded username — works on any platform.
const DEFAULT_OUTPUT_ROOT = '';

// Open the options page on a specific tab (popup → options deep-link via storage).
function openOptions(tab: 'downloads' | 'settings' | 'status' | 'setup') {
  chrome.storage.local.set({ tvOpenTab: tab }, () => chrome.runtime.openOptionsPage());
}

type JobStatus = 'queued' | 'probing' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  batchId?: string;
  batchLabel?: string;
  label: string;
  status: JobStatus;
  estBytes?: number;
  createdAt: number;
  finishedAt?: number;
  folder?: string;
  error?: string;
}

const STATUS_META: Record<JobStatus, { dot: string; text: string; label: string }> = {
  running:   { dot: '#42a5f5', text: '#90caf9', label: 'Downloading' },
  probing:   { dot: '#42a5f5', text: '#90caf9', label: 'Checking size…' },
  queued:    { dot: '#bbb',    text: '#bbb',    label: 'Queued' },
  done:      { dot: '#4caf50', text: '#81c784', label: 'Done' },
  failed:    { dot: '#ef5350', text: '#ef9a9a', label: 'Failed' },
  cancelled: { dot: '#888',    text: '#999',    label: 'Cancelled' },
};

function formatBytes(b?: number): string {
  if (!b || b <= 0) return '';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}

function App() {
  const version = chrome.runtime.getManifest().version;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [helper, setHelper] = useState<'checking' | 'ok' | 'error'>('checking');
  const [outputRoot, setOutputRoot] = useState(DEFAULT_OUTPUT_ROOT);
  const [helperDefault, setHelperDefault] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);  // job id or "batch:<id>"
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = () => chrome.storage.local.get({ tvJobs: [] }, (s) => setJobs(s.tvJobs as Job[]));
    load();
    const onChg = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.tvJobs) load();
      if (area === 'local' && changes.outputRoot) setOutputRoot(changes.outputRoot.newValue || DEFAULT_OUTPUT_ROOT);
    };
    chrome.storage.onChanged.addListener(onChg);
    chrome.storage.local.get({ outputRoot: DEFAULT_OUTPUT_ROOT }, (s) => setOutputRoot(s.outputRoot || DEFAULT_OUTPUT_ROOT));
    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_PING' }, (r) => {
      setHelper(chrome.runtime.lastError || !r?.ok ? 'error' : 'ok');
      if (!chrome.runtime.lastError && r?.ok && r.defaultRoot) setHelperDefault(r.defaultRoot);
    });
    return () => chrome.storage.onChanged.removeListener(onChg);
  }, []);

  const cancel = (id: string) => { chrome.runtime.sendMessage({ type: 'TUBE_VAULT_CANCEL', jobId: id }); setConfirmId(null); };
  const cancelBatch = (batchId: string) => { chrome.runtime.sendMessage({ type: 'TUBE_VAULT_CANCEL_BATCH', batchId }); setConfirmId(null); };
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openFolder = (folder?: string) => { if (folder) chrome.runtime.sendMessage({ type: 'TUBE_VAULT_REQUEST', payload: { action: 'open_folder', windowsPath: folder } }); };

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'probing');
  const queued = jobs.filter((j) => j.status === 'queued');
  const recent = jobs
    .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 3);

  // Cancel button: 2-step inline confirm shared by jobs and batches.
  const cancelBtn = (key: string, onStop: () => void) =>
    confirmId === key
      ? <span style={{ display: 'flex', gap: 4 }}>
          <button style={miniBtnRed} onClick={onStop}>Stop</button>
          <button style={miniBtn} onClick={() => setConfirmId(null)}>No</button>
        </span>
      : <button style={cancelX} title="Cancel" onClick={() => setConfirmId(key)}>✕</button>;

  const jobRowEl = (job: Job, cancellable: boolean, indent = false) => {
    const m = STATUS_META[job.status];
    const size = formatBytes(job.estBytes);
    return (
      <div key={job.id} style={{ ...jobRow, paddingLeft: indent ? 34 : 14 }}>
        <span style={{ ...dot, background: m.dot }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={jobLabel}>{job.label}</div>
          <div style={{ ...jobStatus, color: m.text }}>
            {m.label}{size ? ` · ${size}` : ''}{job.status === 'failed' && job.error ? ` · ${job.error.slice(0, 36)}` : ''}
          </div>
        </div>
        {cancellable && cancelBtn(job.id, () => cancel(job.id))}
      </div>
    );
  };

  // Group queued jobs: batched ones collapse under one header, singles stand alone.
  const renderQueued = () => {
    const out: React.ReactNode[] = [];
    const seen = new Set<string>();
    for (const j of queued) {
      if (!j.batchId) { out.push(jobRowEl(j, true)); continue; }
      if (seen.has(j.batchId)) continue;
      seen.add(j.batchId);
      const members = queued.filter((q) => q.batchId === j.batchId);
      const totalBytes = members.reduce((a, q) => a + (q.estBytes || 0), 0);
      const isOpen = expanded.has(j.batchId);
      out.push(
        <div key={j.batchId}>
          <div style={jobRow}>
            <button style={chevron} onClick={() => toggle(j.batchId!)}>{isOpen ? '▾' : '▸'}</button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={jobLabel}>{j.batchLabel || 'Batch'}</div>
              <div style={{ ...jobStatus, color: '#bbb' }}>
                {members.length} queued{totalBytes ? ` · ${formatBytes(totalBytes)}` : ''}
              </div>
            </div>
            {cancelBtn('batch:' + j.batchId, () => cancelBatch(j.batchId!))}
          </div>
          {isOpen && members.map((q) => jobRowEl(q, true, true))}
        </div>
      );
    }
    return out;
  };

  return (
    <div style={panel}>
      <div style={header}>
        <span style={brandPill}>
          <img src="icons/icon32.png" width={22} height={22} style={{ borderRadius: 5 }} alt="" />
          <span style={{ fontWeight: 700, fontSize: 16 }}>TubeVault</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={statusPill}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: helper === 'ok' ? '#5dde6e' : helper === 'error' ? '#ff6b6b' : '#ccc' }} />
            {helper === 'ok' ? 'Connected' : helper === 'error' ? 'Disconnected' : 'Checking…'}
          </span>
          <button style={hdrIconBtn} title="History" onClick={() => openOptions('downloads')}><FiClock size={18} /></button>
          <button style={hdrIconBtn} title="Settings" onClick={() => openOptions('settings')}><FiSettings size={18} /></button>
        </span>
      </div>

      <div style={body}>
        {active.length === 0 && queued.length === 0 && recent.length === 0 && (
          <div style={empty}>Nothing downloading.<br />Use the Download button on YouTube.</div>
        )}

        {active.length > 0 && <>
          <div style={sectionLabel}>Downloading</div>
          {active.map((j) => jobRowEl(j, true))}
        </>}

        {queued.length > 0 && <>
          <div style={sectionLabel}>Up next ({queued.length})</div>
          {renderQueued()}
        </>}

        {recent.length > 0 && <>
          <div style={sectionLabel}>Recent</div>
          {recent.map((j) => {
            const m = STATUS_META[j.status];
            return (
              <div key={j.id} style={jobRow}>
                <span style={{ ...dot, background: m.dot }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={jobLabel}>{j.label}</div>
                  <div style={{ ...jobStatus, color: m.text }}>
                    {m.label}{j.finishedAt ? ` · ${new Date(j.finishedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
                  </div>
                </div>
                {j.status === 'done' && j.folder && (
                  <button style={cancelX} title="Open folder" onClick={() => openFolder(j.folder)}><FiFolder size={16} /></button>
                )}
              </div>
            );
          })}
          <button style={{ ...settingsBtn, padding: '6px 16px 2px' }} onClick={() => openOptions('downloads')}>View all history →</button>
        </>}
      </div>

      <div style={footer}>
        <div style={{ fontSize: 10, color: '#666', wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{outputRoot || helperDefault}</div>
        <span style={versionPill}>v{version}</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

// ── Styles ────────────────────────────────────────────────────────────────────
// Shared height so the brand pill, status pill, and icon buttons line up exactly.
const CTRL_H = 32;
const pillBase: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', height: CTRL_H, background: 'rgba(0,0,0,0.26)', borderRadius: CTRL_H / 2, boxSizing: 'border-box' };

const panel: React.CSSProperties = { width: 400, background: '#181818', color: '#eee', fontFamily: 'Roboto, system-ui, sans-serif' };
const header: React.CSSProperties = { background: '#cc0000', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 };
const brandPill: React.CSSProperties = { ...pillBase, gap: 9, padding: '0 14px 0 11px' };
const statusPill: React.CSSProperties = { ...pillBase, gap: 7, padding: '0 14px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' };
const hdrIconBtn: React.CSSProperties = { ...pillBase, justifyContent: 'center', width: CTRL_H, padding: 0, border: 'none', color: '#fff', cursor: 'pointer' };
const versionPill: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: '#888', background: '#222', border: '1px solid #2e2e2e', borderRadius: 10, padding: '4px 10px', flexShrink: 0 };
const body: React.CSSProperties = { maxHeight: 460, overflowY: 'auto', padding: '8px 0' };
const empty: React.CSSProperties = { padding: '44px 20px', textAlign: 'center', color: '#888', fontSize: 15, lineHeight: 1.7 };
const sectionLabel: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#8a8a8a', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '14px 18px 7px' };
const jobRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px' };
const dot: React.CSSProperties = { width: 11, height: 11, borderRadius: '50%', flexShrink: 0 };
const chevron: React.CSSProperties = { background: 'none', border: 'none', color: '#aaa', fontSize: 15, cursor: 'pointer', padding: 0, width: 13, flexShrink: 0, fontFamily: 'inherit' };
const jobLabel: React.CSSProperties = { fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const jobStatus: React.CSSProperties = { fontSize: 13, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const cancelX: React.CSSProperties = { background: 'none', border: 'none', color: '#999', fontSize: 16, cursor: 'pointer', padding: '4px 8px', borderRadius: 7, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center' };
const miniBtn: React.CSSProperties = { background: '#2b2b2b', border: '1px solid #444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '5px 11px', borderRadius: 7, fontFamily: 'inherit' };
const miniBtnRed: React.CSSProperties = { ...miniBtn, background: '#cc0000', borderColor: '#cc0000' };
const footer: React.CSSProperties = { borderTop: '1px solid #2a2a2a', padding: '11px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 };
const settingsBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#aaa', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit', whiteSpace: 'nowrap' };
