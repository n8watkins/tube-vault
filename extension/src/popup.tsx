import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface Job {
  id: string;
  label: string;
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  folder?: string;
  error?: string;
}

const STATUS_META: Record<JobStatus, { dot: string; text: string; label: string }> = {
  running:   { dot: '#42a5f5', text: '#90caf9', label: 'Downloading' },
  queued:    { dot: '#bbb',    text: '#bbb',    label: 'Queued' },
  done:      { dot: '#4caf50', text: '#81c784', label: 'Done' },
  failed:    { dot: '#ef5350', text: '#ef9a9a', label: 'Failed' },
  cancelled: { dot: '#888',    text: '#999',    label: 'Cancelled' },
};

function App() {
  const version = chrome.runtime.getManifest().version;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [helper, setHelper] = useState<'checking' | 'ok' | 'error'>('checking');
  const [outputRoot, setOutputRoot] = useState(DEFAULT_OUTPUT_ROOT);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    const load = () => chrome.storage.local.get({ tvJobs: [] }, (s) => setJobs(s.tvJobs as Job[]));
    load();
    const onChg = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.tvJobs) load();
      if (area === 'local' && changes.outputRoot) setOutputRoot(changes.outputRoot.newValue || DEFAULT_OUTPUT_ROOT);
    };
    chrome.storage.onChanged.addListener(onChg);
    chrome.storage.local.get({ outputRoot: DEFAULT_OUTPUT_ROOT }, (s) => setOutputRoot(s.outputRoot || DEFAULT_OUTPUT_ROOT));
    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_PING' }, (r) => setHelper(chrome.runtime.lastError || !r?.ok ? 'error' : 'ok'));
    return () => chrome.storage.onChanged.removeListener(onChg);
  }, []);

  const cancel = (id: string) => { chrome.runtime.sendMessage({ type: 'TUBE_VAULT_CANCEL', jobId: id }); setConfirmId(null); };
  const clearHistory = () => chrome.runtime.sendMessage({ type: 'TUBE_VAULT_CLEAR_HISTORY' });

  const active = jobs.filter((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  const history = jobs.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled').reverse();

  const row = (job: Job, cancellable: boolean) => {
    const m = STATUS_META[job.status];
    return (
      <div key={job.id} style={jobRow}>
        <span style={{ ...dot, background: m.dot }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={jobLabel}>{job.label}</div>
          <div style={{ ...jobStatus, color: m.text }}>
            {m.label}{job.status === 'failed' && job.error ? ` · ${job.error.slice(0, 40)}` : ''}
          </div>
        </div>
        {cancellable && (
          confirmId === job.id
            ? <span style={{ display: 'flex', gap: 4 }}>
                <button style={miniBtnRed} onClick={() => cancel(job.id)}>Stop</button>
                <button style={miniBtn} onClick={() => setConfirmId(null)}>No</button>
              </span>
            : <button style={cancelX} title="Cancel" onClick={() => setConfirmId(job.id)}>✕</button>
        )}
      </div>
    );
  };

  return (
    <div style={panel}>
      <div style={header}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>TubeVault</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: helper === 'ok' ? '#4caf50' : helper === 'error' ? '#ef5350' : '#888' }}>
            {helper === 'ok' ? '● helper' : helper === 'error' ? '● offline' : '…'}
          </span>
          <span style={versionPill}>v{version}</span>
        </span>
      </div>

      <div style={body}>
        {active.length === 0 && queued.length === 0 && history.length === 0 && (
          <div style={empty}>No downloads yet.<br />Use the Download button on YouTube.</div>
        )}

        {active.length > 0 && <>
          <div style={sectionLabel}>Downloading</div>
          {active.map((j) => row(j, true))}
        </>}

        {queued.length > 0 && <>
          <div style={sectionLabel}>Up next ({queued.length})</div>
          {queued.map((j) => row(j, true))}
        </>}

        {history.length > 0 && <>
          <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>History</span>
            <button style={clearBtn} onClick={clearHistory}>Clear</button>
          </div>
          {history.map((j) => row(j, false))}
        </>}
      </div>

      <div style={footer}>
        <div style={{ fontSize: 10, color: '#666', wordBreak: 'break-all' }}>{outputRoot}</div>
        <button style={settingsBtn} onClick={() => chrome.runtime.openOptionsPage()}>⚙ Settings</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

// ── Styles ────────────────────────────────────────────────────────────────────
const panel: React.CSSProperties = { width: 320, background: '#181818', color: '#eee', fontFamily: 'Roboto, system-ui, sans-serif' };
const header: React.CSSProperties = { background: '#cc0000', padding: '11px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const versionPill: React.CSSProperties = { fontSize: 11, background: 'rgba(0,0,0,0.3)', borderRadius: 10, padding: '2px 8px' };
const body: React.CSSProperties = { maxHeight: 380, overflowY: 'auto', padding: '6px 0' };
const empty: React.CSSProperties = { padding: '28px 14px', textAlign: 'center', color: '#666', fontSize: 13, lineHeight: 1.6 };
const sectionLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: '#777', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '10px 14px 4px' };
const jobRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' };
const dot: React.CSSProperties = { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 };
const jobLabel: React.CSSProperties = { fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const jobStatus: React.CSSProperties = { fontSize: 11, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const cancelX: React.CSSProperties = { background: 'none', border: 'none', color: '#888', fontSize: 14, cursor: 'pointer', padding: '2px 6px', borderRadius: 6, fontFamily: 'inherit' };
const miniBtn: React.CSSProperties = { background: '#2b2b2b', border: '1px solid #444', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '3px 8px', borderRadius: 6, fontFamily: 'inherit' };
const miniBtnRed: React.CSSProperties = { ...miniBtn, background: '#cc0000', borderColor: '#cc0000' };
const clearBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#777', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'none', letterSpacing: 0 };
const footer: React.CSSProperties = { borderTop: '1px solid #2a2a2a', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 };
const settingsBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#888', fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit', whiteSpace: 'nowrap' };
