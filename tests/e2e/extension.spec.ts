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
