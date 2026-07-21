# TubeVault Setup

TubeVault has two runtime parts: a Chrome extension and a local Node.js native messaging helper.
The helper launches `yt-dlp` and `ffmpeg` on Windows through WSL or directly on macOS and Linux.

## Prerequisites

- Google Chrome or another Chromium-family browser.
- Node.js 20 or newer with npm.
- `yt-dlp` and `ffmpeg` available to the helper runtime.

Install the download tools with the package manager appropriate for the helper environment.

```bash
# macOS with Homebrew
brew install yt-dlp ffmpeg

# Debian, Ubuntu, or WSL
sudo apt update
sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

## Install Dependencies and Build

Run these commands from the repository root:

```bash
npm ci
npm ci --prefix extension
npm ci --prefix helper
npm run build
```

The build writes the extension bundles to `extension/dist` and helper JavaScript to `helper/dist`.
It does not version, commit, copy, or deploy files.

## Load the Extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the built `extension/` directory.
3. Copy the extension ID shown on its card.
4. Reload the extension card after every build or sync.

For Windows Chrome with development inside WSL, first copy the runtime files into an existing Windows checkout:

```bash
npm run sync:windows -- --target /mnt/c/Users/<you>/Projects/tube-vault
```

Select that checkout's `extension` directory in Chrome.
The target can also be supplied through `TUBE_VAULT_WINDOWS_REPO`.
See [README.md](README.md#explicit-windows-sync) for the sync publication and allowlist guarantees.

## Register the Native Messaging Host

Registration tells Chrome how to launch the local helper.
Run it once and repeat it if the extension ID or repository location changes.

### Windows with WSL

Run this command from Windows PowerShell:

```powershell
.\scripts\install.ps1 -ExtensionId <your-extension-id>
```

The installer creates a user-specific host manifest under `%LOCALAPPDATA%\TubeVault` and registers it in the current user's Chrome native messaging registry key.
The tracked manifest template stays unchanged.
The generated launcher path is derived from the repository location and contains no hardcoded username.

### macOS or Linux

```bash
./scripts/install.sh <your-extension-id>
```

The installer registers `com.tube_vault.helper.json` for the supported Chromium-family browsers it finds.
The host points to `scripts/run-helper.sh`, which launches the local Node.js helper.

## Default Save Folder

The helper reports an operating-system-specific default on the first successful connection.
The extension seeds that path only when no saved choice exists and never overwrites a user setting.

- Windows with WSL defaults to `C:\Users\<you>\Videos\YouTube Downloads`.
- macOS and Linux default to `~/Videos/YouTube Downloads`.

Change the path at any time under **Settings > Download folder**.

## Verify the Installation

Open the extension options and select **Status**.
The page checks native helper connectivity, `yt-dlp`, `ffmpeg`, and the resolved output folder.

Run the repository checks during development:

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

## Troubleshooting

- If the helper is offline, rebuild it, rerun the platform installer, and reload the extension.
- If downloads fail immediately, confirm that `yt-dlp` and `ffmpeg` are on the helper process PATH.
- If macOS or Linux reports that Node.js is missing, ensure Node is available from the login environment used by `scripts/run-helper.sh`.
- If the UI is stale, reload the unpacked extension at `chrome://extensions` and refresh the YouTube tab.
- If Chromium smoke tests cannot start on Linux, run `npx playwright install --with-deps chromium`.
