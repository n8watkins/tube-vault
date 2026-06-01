import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const DEFAULT_OUTPUT_ROOT = 'C:\\Users\\natha\\Videos\\Youtube Downloads';

type PageType = 'video' | 'shorts' | 'playlist' | 'youtube' | 'other';
type HelperStatus = 'checking' | 'ok' | 'error';

function parseYouTubePage(url: string): { type: PageType; id?: string } {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.youtube.com' && u.hostname !== 'youtube.com') {
      return { type: 'other' };
    }
    if (u.pathname === '/watch') {
      return { type: 'video', id: u.searchParams.get('v') ?? undefined };
    }
    if (u.pathname.startsWith('/shorts/')) {
      return { type: 'shorts', id: u.pathname.split('/')[2] };
    }
    if (u.pathname === '/playlist') {
      return { type: 'playlist', id: u.searchParams.get('list') ?? undefined };
    }
    return { type: 'youtube' };
  } catch {
    return { type: 'other' };
  }
}

const PAGE_LABEL: Record<PageType, string> = {
  video: 'Video',
  shorts: 'Shorts',
  playlist: 'Playlist',
  youtube: 'YouTube (other)',
  other: 'Not on YouTube',
};

function App() {
  const version = chrome.runtime.getManifest().version;
  const [page, setPage] = useState<{ type: PageType; id?: string } | null>(null);
  const [helper, setHelper] = useState<HelperStatus>('checking');
  const [outputRoot, setOutputRoot] = useState(DEFAULT_OUTPUT_ROOT);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      setPage(parseYouTubePage(tabs[0]?.url ?? ''));
    });

    chrome.runtime.sendMessage({ type: 'TUBE_VAULT_PING' }, (response) => {
      setHelper(chrome.runtime.lastError || !response?.ok ? 'error' : 'ok');
    });

    chrome.storage.sync.get({ outputRoot: DEFAULT_OUTPUT_ROOT }, (s) => {
      setOutputRoot(s.outputRoot || DEFAULT_OUTPUT_ROOT);
    });
  }, []);

  const row = (label: string, content: React.ReactNode) => (
    <div style={{ padding: '9px 14px', borderBottom: '1px solid #2a2a2a' }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
        {label}
      </div>
      {content}
    </div>
  );

  return (
    <div style={{ width: 260, fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: 13, color: '#eee', background: '#181818', borderRadius: 0 }}>
      {/* Header */}
      <div style={{ background: '#cc0000', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em' }}>TubeVault</span>
        <span style={{ fontSize: 11, background: 'rgba(0,0,0,0.3)', borderRadius: 10, padding: '2px 8px', color: '#fff' }}>
          v{version}
        </span>
      </div>

      {/* Current page */}
      {row('Current Page',
        page == null
          ? <span style={{ color: '#555' }}>…</span>
          : <>
              <div style={{ fontWeight: 600 }}>{PAGE_LABEL[page.type]}</div>
              {page.id && (
                <div style={{ fontSize: 11, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {page.id}
                </div>
              )}
            </>
      )}

      {/* Helper status */}
      {row('Helper',
        helper === 'checking'
          ? <span style={{ color: '#666' }}>Checking…</span>
          : helper === 'ok'
          ? <span style={{ color: '#4caf50', fontWeight: 600 }}>✓ Connected</span>
          : <span style={{ color: '#ef5350', fontWeight: 600 }}>✗ Not reachable</span>
      )}

      {/* Download folder */}
      {row('Download Folder',
        <div style={{ fontSize: 11, color: '#aaa', wordBreak: 'break-all', lineHeight: 1.4 }}>
          {outputRoot}
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: '8px 14px', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          style={{
            background: 'none',
            border: 'none',
            color: '#666',
            fontSize: 11,
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#aaa')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#666')}
        >
          ⚙ Settings
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
