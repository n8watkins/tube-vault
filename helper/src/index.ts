import { readMessages, writeMessage } from './protocol';
import { handle, type DownloadRequest, type Action } from './downloader';
import { isValidYouTubeUrl } from './sanitize';

const ALLOWED_ACTIONS: Action[] = [
  'custom',
  'download_best',
  'download_audio',
  'download_thumbnail',
  'download_metadata',
  'archive_bundle',
  'diagnostics',
];

readMessages(async (raw) => {
  const req = raw as Record<string, unknown>;

  if (req.action === 'diagnostics') {
    const res = await handle({ action: 'diagnostics', url: '' });
    writeMessage(res);
    return;
  }

  const action = req.action as Action;
  const url = req.url as string;

  if (!ALLOWED_ACTIONS.includes(action)) {
    writeMessage({ ok: false, status: 'failed', error: `Unknown action: ${action}` });
    return;
  }

  if (!isValidYouTubeUrl(url)) {
    writeMessage({ ok: false, status: 'failed', error: 'Invalid or unsupported YouTube URL' });
    return;
  }

  const res = await handle(req as unknown as DownloadRequest);
  writeMessage(res);
});
