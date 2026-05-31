const ALLOWED_HOSTS = ['www.youtube.com', 'youtube.com', 'youtu.be'];

export function isValidYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) return false;
    const isWatch = parsed.pathname === '/watch' && parsed.searchParams.has('v');
    const isShorts = /^\/shorts\/[A-Za-z0-9_-]+$/.test(parsed.pathname);
    return isWatch || isShorts;
  } catch {
    return false;
  }
}

// Strip characters unsafe in Windows/Linux file paths
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// /mnt/c/Users/... → C:\Users\...
export function wslToWindowsPath(p: string): string {
  const m = p.match(/^\/mnt\/([a-z])(\/.*)?$/);
  if (!m) return p;
  return `${m[1].toUpperCase()}:${(m[2] ?? '').replace(/\//g, '\\')}`;
}
