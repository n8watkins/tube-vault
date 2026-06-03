import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'fs';
import http from 'http';
import { dirname, join, normalize, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const extensionRoot = join(repoRoot, 'extension');
const screenshotDir = join(repoRoot, 'docs', 'screenshots');
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));

const windowsUser = process.env.TUBEVAULT_WINDOWS_USER || 'natha';
const windowsTempRoot = `/mnt/c/Users/${windowsUser}/AppData/Local/Temp`;
const windowsTemp = `C:/Users/${windowsUser}/AppData/Local/Temp`;
const windowsPuppeteerDir = `${windowsTemp}/tubevault-puppeteer-core`;
const wslPuppeteerDir = `${windowsTempRoot}/tubevault-puppeteer-core`;
const windowsOutputDir = `${windowsTemp}/tubevault-screenshot-output`;
const wslOutputDir = `${windowsTempRoot}/tubevault-screenshot-output`;
const windowsController = `${windowsTemp}/tubevault-capture-extension-screenshots.cjs`;
const wslController = `${windowsTempRoot}/tubevault-capture-extension-screenshots.cjs`;
const chromeProfile = `${windowsTemp}/tubevault-screenshot-chrome-${process.pid}`;
const chromeDebugPort = Number(process.env.TUBEVAULT_CHROME_DEBUG_PORT || (9300 + (process.pid % 500)));
const screenshotServerPort = Number(process.env.TUBEVAULT_SCREENSHOT_SERVER_PORT || 9477);
const chromePath = process.env.TUBEVAULT_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sampleJobs = [
  {
    id: 'job-running',
    label: 'Building a Local YouTube Archive',
    status: 'running',
    estBytes: 1460000000,
    createdAt: Date.now() - 90_000,
    folder: 'C:\\Users\\natha\\Videos\\Youtube Downloads\\Building a Local YouTube Archive',
  },
  {
    id: 'job-queued-1',
    batchId: 'batch-research',
    batchLabel: 'Research Playlist',
    category: 'Playlist',
    label: 'How yt-dlp Handles Playlists',
    status: 'queued',
    estBytes: 420000000,
    createdAt: Date.now() - 60_000,
  },
  {
    id: 'job-queued-2',
    batchId: 'batch-research',
    batchLabel: 'Research Playlist',
    category: 'Playlist',
    label: 'Metadata Workflows for Archives',
    status: 'queued',
    estBytes: 310000000,
    createdAt: Date.now() - 50_000,
  },
  {
    id: 'history-done',
    label: 'Local-first downloader walkthrough',
    status: 'done',
    estBytes: 880000000,
    createdAt: Date.now() - 86_000_000,
    finishedAt: Date.now() - 85_000_000,
    folder: 'C:\\Users\\natha\\Videos\\Youtube Downloads\\Local-first downloader walkthrough',
  },
  {
    id: 'history-batch-1',
    batchId: 'batch-channel',
    batchLabel: 'Channel: Archive Techniques',
    category: 'Most Popular',
    label: 'Best archive workflow',
    status: 'done',
    estBytes: 640000000,
    createdAt: Date.now() - 172_000_000,
    finishedAt: Date.now() - 171_000_000,
    folder: 'C:\\Users\\natha\\Videos\\Youtube Downloads\\Archive Techniques\\Most Popular\\001 - Best archive workflow',
  },
  {
    id: 'history-batch-2',
    batchId: 'batch-channel',
    batchLabel: 'Channel: Archive Techniques',
    category: 'Most Popular',
    label: 'Common yt-dlp mistakes',
    status: 'failed',
    estBytes: 530000000,
    createdAt: Date.now() - 172_000_000,
    finishedAt: Date.now() - 170_500_000,
    error: 'Format unavailable',
  },
  {
    id: 'history-cancelled',
    label: 'Old livestream capture',
    status: 'cancelled',
    estBytes: 2200000000,
    createdAt: Date.now() - 240_000_000,
    finishedAt: Date.now() - 239_000_000,
  },
];

const chromeShim = `
<script>
(() => {
  const jobs = ${JSON.stringify(sampleJobs)};
  const settings = {
    outputRoot: 'C:\\\\Users\\\\natha\\\\Videos\\\\Youtube Downloads',
    tvJobs: jobs,
    autoOpenFolder: true,
    collectHistory: true,
    historyRetentionDays: 0,
    channelCounts: [1, 5, 10, 30],
    channelDefaultCount: 5,
    menuDefaults: {
      video: true,
      audio: false,
      thumbnail: true,
      metadata: true,
      videoQuality: '1080',
      videoFormat: 'mp4',
      audioFormat: 'm4a',
    },
    namingTitleFiles: true,
    namingSummaryTxt: true,
    namingCategoryFolders: true,
    namingNumbering: true,
    namingIncludeId: false,
  };
  const onChanged = { addListener() {}, removeListener() {} };
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '${manifest.version}', name: 'TubeVault' }),
      openOptionsPage: () => {},
      sendMessage: (message, callback) => {
        const action = message && message.payload && message.payload.action;
        const response = action === 'diagnostics'
          ? { ok: true, diagnostics: { ytdlp: '2026.06.01', ffmpeg: '7.0', outputRoot: settings.outputRoot } }
          : { ok: true };
        setTimeout(() => callback && callback(response), 20);
      },
    },
    storage: {
      onChanged,
      local: {
        get(defaults, callback) {
          const base = typeof defaults === 'object' && !Array.isArray(defaults) ? defaults : {};
          callback({ ...base, ...settings });
        },
        set(values, callback) {
          Object.assign(settings, values);
          callback && callback();
        },
        remove(_keys, callback) {
          callback && callback();
        },
      },
    },
  };
})();
</script>`;

function ensureDirs() {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(wslOutputDir, { recursive: true });
}

function ensureWindowsPuppeteer() {
  const installed = existsSync(join(wslPuppeteerDir, 'node_modules', 'puppeteer-core'));
  if (installed) return;

  console.log('Installing puppeteer-core into Windows temp...');
  execFileSync(
    'cmd.exe',
    ['/c', `npm install --prefix "${windowsPuppeteerDir}" puppeteer-core`],
    { stdio: 'inherit' },
  );
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'options.html');
    const filePath = normalize(join(extensionRoot, urlPath));

    if (!filePath.startsWith(extensionRoot) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let body = readFileSync(filePath);
    if (filePath.endsWith('.html')) {
      body = Buffer.from(
        body.toString('utf8').replace('<div id="root"></div>', `<div id="root"></div>\n${chromeShim}`),
        'utf8',
      );
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(body);
  });
}

function startChrome() {
  const ps = `
$chrome = "${chromePath}";
$profile = "${chromeProfile}";
$args = @(
  "--remote-debugging-port=${chromeDebugPort}",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1200,900"
);
Start-Process -FilePath $chrome -ArgumentList $args;
`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

function waitForChrome() {
  const probe = `try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${chromeDebugPort}/json/version | Out-Null; exit 0 } catch { exit 1 }`;
  const started = Date.now();

  while (Date.now() - started < 20_000) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', probe], { stdio: 'ignore' });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }

  throw new Error(`Chrome did not open remote debugging port ${chromeDebugPort}`);
}

function stopChrome() {
  const profilePattern = chromeProfile.replaceAll('\\', '\\\\');
  const ps = `
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*${profilePattern}*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } catch {
    // The screenshots are already written; do not fail the run on cleanup.
  }
}

function writeWindowsController(baseUrl) {
  const controller = `
const puppeteer = require('${windowsPuppeteerDir}/node_modules/puppeteer-core');
const outputDir = '${windowsOutputDir}';
const baseUrl = '${baseUrl}';
const browserUrl = 'http://127.0.0.1:${chromeDebugPort}';

const optionTabs = [
  { id: 'downloads', label: 'Downloads', waitFor: 'Download history' },
  { id: 'settings', label: 'Settings', waitFor: 'Default download preferences' },
  { id: 'status', label: 'Status', waitFor: 'Native helper' },
  { id: 'setup', label: 'Setup', waitFor: 'Installation guide' },
  { id: 'support', label: 'Support', waitFor: 'About TubeVault' },
];

async function clickTab(page, label) {
  await page.evaluate((tabLabel) => {
    const tab = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent && button.textContent.trim() === tabLabel);
    if (!tab) throw new Error('Missing options tab: ' + tabLabel);
    tab.click();
  }, label);
}

async function openUiPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8_000 });
  } catch (error) {
    if (!String(error.message || error).includes('Navigation timeout')) {
      throw error;
    }
  }
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: browserUrl });

  try {
    for (const tab of optionTabs) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
      await openUiPage(page, baseUrl + '/options.html');
      await page.waitForFunction(() => document.body.textContent.includes('TubeVault'), { timeout: 5_000 });
      await clickTab(page, tab.label);
      await page.waitForFunction((text) => document.body.textContent.includes(text), { timeout: 5_000 }, tab.waitFor);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.screenshot({ path: outputDir + '/tubevault-options-' + tab.id + '.png', fullPage: true });
      await page.close();
    }

    const popup = await browser.newPage();
    await popup.setViewport({ width: 420, height: 640, deviceScaleFactor: 1 });
    await openUiPage(popup, baseUrl + '/popup.html');
    await popup.waitForFunction(() => document.body.textContent.includes('TubeVault'), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await popup.screenshot({
      path: outputDir + '/tubevault-popup.png',
      clip: { x: 0, y: 0, width: 380, height: 287 },
    });
    await popup.close();
  } finally {
    await browser.disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  writeFileSync(wslController, controller);
}

function runWindowsController() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('/mnt/c/Program Files/nodejs/node.exe', [windowsController], { stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`Windows screenshot controller exited with code ${code}`));
    });
  });
}

function copyScreenshots() {
  const names = [
    'tubevault-options-downloads.png',
    'tubevault-options-settings.png',
    'tubevault-options-status.png',
    'tubevault-options-setup.png',
    'tubevault-options-support.png',
    'tubevault-popup.png',
  ];

  for (const name of names) {
    const from = join(wslOutputDir, name);
    const to = join(screenshotDir, name);
    copyFileSync(from, to);
    chmodSync(to, 0o644);
  }
}

async function main() {
  ensureDirs();
  ensureWindowsPuppeteer();

  const server = createServer();
  await new Promise((resolveServer) => server.listen(screenshotServerPort, '0.0.0.0', resolveServer));
  const baseUrl = `http://127.0.0.1:${screenshotServerPort}`;

  console.log(`Serving extension render harness at ${baseUrl}`);
  console.log(`Starting Chrome remote debugging on port ${chromeDebugPort}`);

  try {
    startChrome();
    waitForChrome();
    writeWindowsController(baseUrl);
    await runWindowsController();
    copyScreenshots();
    console.log('Screenshots written to docs/screenshots');
  } finally {
    server.close();
    stopChrome();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
