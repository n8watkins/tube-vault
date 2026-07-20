# Puppeteer Screenshots

TubeVault includes a reusable screenshot script for the popup and all four Chrome options tabs.

```bash
npm run build --prefix extension
npm run screenshots --prefix extension
```

The command writes these files:

```text
docs/screenshots/tubevault-popup.png
docs/screenshots/tubevault-options-downloads.png
docs/screenshots/tubevault-options-settings.png
docs/screenshots/tubevault-options-status.png
docs/screenshots/tubevault-options-setup.png
```

## How It Works

The script serves the built extension HTML through a temporary local HTTP server and injects a deterministic `chrome.*` API shim.
This renders the real popup and options bundles while avoiding native-helper calls and nondeterministic local history.

The script starts Windows Chrome from WSL, connects with Puppeteer, captures every current tab, and copies the images back into `docs/screenshots`.
Options images are cropped with FFmpeg to remove unused viewport space.
The popup uses a direct Puppeteer clip.

Temporary Puppeteer packages, the browser profile, the controller script, and raw output live under the current Windows user's `%TEMP%` directory.
The script discovers the Windows username through `cmd.exe` unless `TUBEVAULT_WINDOWS_USER` is set.

## Configuration

- Set `TUBEVAULT_WINDOWS_USER` to override Windows user discovery.
- Set `TUBEVAULT_SCREENSHOT_SERVER_PORT` if the default local port is busy.
- Set `TUBEVAULT_CHROME_DEBUG_PORT` to choose the Chrome debugging port.
- Set `TUBEVAULT_CHROME_PATH` when Chrome is installed outside its standard location.

## Capture Notes

- Build the extension first so the screenshots use current bundles.
- Use explicit text waits after `domcontentloaded` because extension UI rendering is asynchronous.
- Do not wait for network idle because the UI and browser can keep background activity alive.
- The crop definitions live in `scripts/capture-extension-screenshots.mjs`.
