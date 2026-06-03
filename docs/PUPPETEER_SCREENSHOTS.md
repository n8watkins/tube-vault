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
7. The WSL script crops the options screenshots with FFmpeg so the README does not show large blank regions around the UI.
8. The temporary Chrome profile is closed.

## Why It Does Not Load The Extension Directly

Loading unpacked Chrome extensions across the WSL/Windows boundary can be unreliable for automation because extension IDs, service worker targets, and `chrome-extension://...` page availability can drift between temp profiles. The shimmed render keeps the screenshots stable while still exercising the built React bundles.

## Notes

- Run `npm run build --prefix extension` first when source files changed, so screenshots use the newest bundle.
- Use `waitUntil: "domcontentloaded"` plus explicit UI text waits. Avoid `networkidle0` for extension UI screenshots.
- The options screenshots are intentionally cropped with FFmpeg. The original viewport captures include large blank dark regions around the centered options shell, especially below shorter tabs such as Downloads, Status, Setup, and Support.
- The popup is captured with a Puppeteer clip and does not need the FFmpeg options-page crop.
- Override the Windows username with `TUBEVAULT_WINDOWS_USER` if needed.
- Override the render server port with `TUBEVAULT_SCREENSHOT_SERVER_PORT` if `9477` is busy.
- Override Chrome with `TUBEVAULT_CHROME_PATH` if Chrome is installed somewhere else.

## Crop Boxes

The crop boxes are defined in `scripts/capture-extension-screenshots.mjs`.

Current FFmpeg filters:

```text
tubevault-options-downloads.png  crop=880:365:150:20
tubevault-options-settings.png   crop=880:1205:150:20
tubevault-options-status.png     crop=880:400:150:20
tubevault-options-setup.png      crop=880:510:150:20
tubevault-options-support.png    crop=880:420:150:20
```

The shared `x=150` crop removes the empty left margin before the sidebar. The `width=880` crop keeps the sidebar, divider, active tab, and main content card while removing the blank right side. Each tab gets its own height because the useful content differs by tab.

The script applies those filters with FFmpeg after the browser captures finish, then replaces the uncropped PNGs in `docs/screenshots`.
