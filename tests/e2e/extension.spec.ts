import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';

const extensionPath = resolve(process.cwd(), 'extension');

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({ browserName }, use) => {
    if (browserName !== 'chromium') throw new Error('TubeVault smoke tests require Chromium');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        '--mute-audio',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});

test('injects one watch-page control across navigation and mutations', async ({ context }) => {
  const page = await context.newPage();
  await page.route('https://www.youtube.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html>
        <body>
          <ytd-watch-metadata>
            <div id="actions" style="width:800px;height:80px">
              <div id="top-level-buttons-computed" style="display:flex;width:700px;height:48px">
                <segmented-like-dislike-button-view-model style="display:block;width:120px;height:40px"></segmented-like-dislike-button-view-model>
              </div>
            </div>
          </ytd-watch-metadata>
        </body>
      </html>`,
  }));
  await page.goto('https://www.youtube.com/watch?v=fixture-one');
  await page.locator('#tube-vault-btn').waitFor();
  await page.getByRole('button', { name: 'Download' }).waitFor();

  await page.evaluate(() => {
    history.pushState({}, '', '/watch?v=fixture-two');
    document.body.append(document.createElement('div'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
    document.dispatchEvent(new Event('yt-page-data-updated'));
    for (let index = 0; index < 5; index += 1) document.body.append(document.createElement('span'));
  });
  await page.waitForTimeout(800);
  await page.locator('#tube-vault-btn').waitFor();
  await test.expect(page.locator('#tube-vault-btn')).toHaveCount(1);
});

test('popup handles a missing native helper gracefully', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await test.expect(popup.getByText('Disconnected')).toBeVisible();
  await test.expect(popup.getByText('Nothing downloading.')).toBeVisible();
});

test('options exposes and switches among all current tabs', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  for (const name of ['Downloads', 'Settings', 'Status', 'Setup']) {
    await test.expect(options.getByRole('button', { name })).toBeVisible();
  }

  await options.getByRole('button', { name: 'Settings' }).click();
  await test.expect(options.getByText('Download folder')).toBeVisible();
  await options.getByRole('button', { name: 'Status' }).click();
  await test.expect(options.getByText('Details', { exact: true })).toBeVisible();
  await options.getByRole('button', { name: 'Setup' }).click();
  await test.expect(options.getByText('Installation guide', { exact: true })).toBeVisible();
  await options.getByRole('button', { name: 'Downloads' }).click();
  await test.expect(options.getByText('Download history')).toBeVisible();
});

test('keeps one Shorts button beside the action bar across Shorts', async ({ context }) => {
  const page = await context.newPage();
  await page.route('https://www.youtube.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html>
        <body>
          <ytd-reel-video-renderer>
            <div id="actions-container" style="display:flex;flex-direction:row;align-items:flex-end;height:600px;width:72px">
              <reel-action-bar-view-model style="display:flex;flex-direction:column;width:48px;height:300px">
                <like-button-view-model style="display:block;width:48px;height:48px"></like-button-view-model>
                <button aria-label="View comments" style="width:48px;height:48px">c</button>
              </reel-action-bar-view-model>
            </div>
          </ytd-reel-video-renderer>
        </body>
      </html>`,
  }));
  await page.goto('https://www.youtube.com/shorts/short-one');
  const button = page.locator('#tube-vault-btn');
  await button.waitFor();

  const placement = () => page.evaluate(() => {
    const container = document.getElementById('tube-vault-btn')!;
    const bar = document.querySelector('reel-action-bar-view-model')!;
    const containerBox = container.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    return {
      insideBar: bar.contains(container),
      nextIsBar: container.nextElementSibling === bar,
      barChildren: [...bar.children].map((child) => child.tagName.toLowerCase()),
      above: containerBox.bottom <= barBox.top,
      centered: Math.abs((containerBox.left + containerBox.right) / 2 - (barBox.left + barBox.right) / 2) < 1,
      marker: container.getAttribute('data-test-marker'),
    };
  });
  test.expect(await placement()).toMatchObject({ insideBar: false, nextIsBar: true, barChildren: ['like-button-view-model', 'button'], above: true, centered: true });

  // Scroll to the next Short: YouTube keeps the same bar and swaps the URL.
  await page.evaluate(() => {
    document.getElementById('tube-vault-btn')!.setAttribute('data-test-marker', 'first-mount');
    history.pushState({}, '', '/shorts/short-two');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.waitForTimeout(1200);
  await test.expect(button).toHaveCount(1);
  test.expect(await placement()).toMatchObject({ insideBar: false, nextIsBar: true, marker: 'first-mount' });

  // If YouTube swaps in a new reel (dropping our container with the old one),
  // the same mounted container moves next to the new action bar.
  await page.evaluate(() => {
    const oldWrapper = document.getElementById('actions-container')!;
    const freshWrapper = oldWrapper.cloneNode(true) as Element;
    freshWrapper.querySelector('#tube-vault-btn')?.remove();
    oldWrapper.replaceWith(freshWrapper);
    history.pushState({}, '', '/shorts/short-three');
  });
  await test.expect(button).toHaveCount(1);
  await test.expect.poll(placement, { timeout: 8000 }).toMatchObject({ insideBar: false, nextIsBar: true, marker: 'first-mount' });
});

test('hides YouTube\'s own Download button instead of removing it', async ({ context }) => {
  const page = await context.newPage();
  await page.route('https://www.youtube.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html>
      <html>
        <body>
          <ytd-watch-metadata>
            <div id="top-level-buttons-computed" style="display:flex;width:700px;height:48px">
              <segmented-like-dislike-button-view-model style="display:block;width:120px;height:40px"></segmented-like-dislike-button-view-model>
              <ytd-download-button-renderer style="display:block;width:100px;height:40px">YouTube download</ytd-download-button-renderer>
            </div>
          </ytd-watch-metadata>
        </body>
      </html>`,
  }));
  await page.goto('https://www.youtube.com/watch?v=fixture-download');
  await page.locator('#tube-vault-btn').waitFor();
  const youtubeDownload = page.locator('ytd-download-button-renderer');
  await test.expect(youtubeDownload).toHaveCount(1);
  await test.expect(youtubeDownload).toBeHidden();
  test.expect(await page.evaluate(() => document.getElementById('tube-vault-btn')!.nextElementSibling?.tagName.toLowerCase()))
    .toBe('ytd-download-button-renderer');
});

test('popup and Downloads page show live progress for a running download', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const job = {
    id: 'running-job',
    videoUrl: 'https://www.youtube.com/watch?v=x',
    label: 'A running download',
    components: {},
    status: 'running',
    estBytes: 285e6,
    createdAt: Date.now(),
    progress: { phase: 'downloading', downloadedBytes: 120e6, totalBytes: 285e6, speed: 4.2e6, eta: 39, updatedAt: Date.now() },
  };
  await options.evaluate((jobs) => chrome.storage.local.set({ tvJobs: jobs }), [job]);
  await test.expect(options.getByText('In progress')).toBeVisible();
  await test.expect(options.getByText('42% · 120 / 285 MB · 4.2 MB/s · 39s left')).toBeVisible();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await test.expect(popup.getByText('42% · 120 / 285 MB · 4.2 MB/s · 39s left')).toBeVisible();
  await test.expect(popup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');

  await options.evaluate((jobs) => chrome.storage.local.set({ tvJobs: jobs }), [{
    ...job,
    progress: { ...job.progress, phase: 'processing', downloadedBytes: 285e6, speed: null, eta: null },
  }]);
  await test.expect(popup.getByText('Finishing up…')).toBeVisible();
  await test.expect(options.getByText('Finishing up…')).toBeVisible();
});
