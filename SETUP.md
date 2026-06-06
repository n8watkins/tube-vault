# TubeVault Setup

TubeVault runs in two parts: the Chrome extension (the UI) and a small Node
"native messaging" helper (it shells out to `yt-dlp`/`ffmpeg` to do the work).
Setup differs slightly per platform — pick your case below.

## Prerequisites (all platforms)

- Google Chrome (or another Chromium-family browser).
- Node.js + npm.
- `yt-dlp` and `ffmpeg` available to the helper runtime.

Install the download tools:

```bash
# macOS (Homebrew)
brew install yt-dlp ffmpeg

# Debian/Ubuntu (incl. WSL)
sudo apt update && sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

## Install dependencies & build

From the repo root:

```bash
npm install --prefix extension
npm install --prefix helper
npm run build --prefix helper
npm run build --prefix extension
```

`npm run build --prefix helper` compiles the helper to `helper/dist`.
`npm run build --prefix extension` bundles the extension. (On the WSL+Windows
setup it also copies the build to the Windows Projects path.)

## Load the extension in Chrome

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
   - On the WSL+Windows setup, select the Windows copy
     (`C:\Users\<you>\Projects\Tools\tube-vault\extension`).
3. Copy the extension's **ID** shown on its card — you need it to register the
   helper.
4. After every rebuild, click **Reload** on the card.

## Register the native messaging host

This is the only step that differs by OS. It tells Chrome how to launch the
helper. Run it once (and again whenever the extension ID changes).

### Windows + WSL

The extension runs in Windows Chrome; the helper runs in WSL. Register via the
registry from **PowerShell**:

```powershell
.\scripts\install.ps1 -ExtensionId <your-extension-id>
```

This patches `native-messaging/com.tube_vault.helper.json` (launcher path +
extension ID) and writes the Chrome `NativeMessagingHosts` registry key. The
Windows launcher is `scripts/run-helper.bat`, which bridges into WSL via
`wsl.exe`. No usernames are hardcoded — everything is derived from the repo's
own location.

### macOS / Linux (native Chrome)

```bash
./scripts/install.sh <your-extension-id>
```

This drops `com.tube_vault.helper.json` into the `NativeMessagingHosts`
directory of each Chromium-family browser it finds (Chrome, Chromium, Brave,
Edge), pointing at `scripts/run-helper.sh`, which runs the Node helper directly.

## Default save folder

You don't need to configure a path. On first connect the helper reports an
OS-appropriate default, which the extension fills in:

- **Windows / WSL** → `C:\Users\<you>\Videos\YouTube Downloads`
  (discovered from `%USERPROFILE%` — files land on the Windows side, not the
  Linux rootfs).
- **macOS / Linux** → `~/Videos/YouTube Downloads`.

Override it anytime in **Settings → Download Folder**.

## Check status

Open the extension's options page → **Status**. It verifies helper
connectivity, `yt-dlp`/`ffmpeg` availability, and the resolved output folder.

## Common fixes

- **Helper offline** — rebuild the helper and re-run the install script for your
  OS, then reload the extension.
- **Downloads fail immediately** — confirm `yt-dlp` and `ffmpeg` are on the
  helper's PATH.
- **macOS/Linux: "node not found"** — `run-helper.sh` probes nvm/fnm/Homebrew/
  system locations; if your node is elsewhere, ensure it's on your login PATH.
- **Stale UI** — reload the unpacked extension at `chrome://extensions`.
