# Puppeteer Screenshots

TubeVault has a reusable screenshot script for the popup and every Chrome options tab.

```bash
npm run screenshots --prefix extension
```

The command writes:

```text
docs/screenshots/tubevault-popup.png
docs/screenshots/tubevault-options-downloads.png
docs/screenshots/tubevault-options-settings.png
docs/screenshots/tubevault-options-status.png
docs/screenshots/tubevault-options-setup.png
docs/screenshots/tubevault-options-support.png
```

## Script

The script lives at:

```text
scripts/capture-extension-screenshots.mjs
```

It is intentionally a project script instead of a one-off command. It can be rerun whenever the extension UI changes and the README screenshots need to be refreshed.

## How It Works

Chrome extension pages expect the `chrome.*` extension APIs. For screenshots, the most reliable WSL flow is to render the built extension HTML through a small local HTTP server and inject a `window.chrome` shim before the bundled script loads.

That means the screenshots use the real built files:

```text
extension/options.html
extension/popup.html
extension/dist/options.js
extension/dist/popup.js
```

The shim provides deterministic sample data for:

- Download history.
- Active and queued popup jobs.
- Settings defaults.
- Native helper diagnostics.
- Extension manifest version.

## WSL And Windows Chrome

The script runs from WSL, but uses Windows Chrome for Puppeteer screenshots:

1. Starts a temporary WSL HTTP server on `127.0.0.1:9477`.
2. Starts Windows Chrome with a temporary profile and remote debugging port.
3. Ensures `puppeteer-core` exists in:

```text
C:\Users\natha\AppData\Local\Temp\tubevault-puppeteer-core
```

4. Writes a temporary Windows Node controller script in:

```text
C:\Users\natha\AppData\Local\Temp\tubevault-capture-extension-screenshots.cjs
```

5. The Windows controller connects to Chrome with Puppeteer, opens the local render server, clicks each options tab, and saves screenshots into a Windows temp output folder.
6. The WSL script copies those PNG files back into `docs/screenshots`.
7. The temporary Chrome profile is closed.

## Why It Does Not Load The Extension Directly

Loading unpacked Chrome extensions across the WSL/Windows boundary can be unreliable for automation because extension IDs, service worker targets, and `chrome-extension://...` page availability can drift between temp profiles. The shimmed render keeps the screenshots stable while still exercising the built React bundles.

## Notes

- Run `npm run build --prefix extension` first when source files changed, so screenshots use the newest bundle.
- Use `waitUntil: "domcontentloaded"` plus explicit UI text waits. Avoid `networkidle0` for extension UI screenshots.
- Override the Windows username with `TUBEVAULT_WINDOWS_USER` if needed.
- Override the render server port with `TUBEVAULT_SCREENSHOT_SERVER_PORT` if `9477` is busy.
- Override Chrome with `TUBEVAULT_CHROME_PATH` if Chrome is installed somewhere else.
