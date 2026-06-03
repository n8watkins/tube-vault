# TubeVault Setup

This guide matches the current TubeVault WSL + Windows Chrome setup.

## Prerequisites

- Windows with Chrome.
- WSL available from Windows.
- Node.js and npm in WSL.
- `yt-dlp` available to the helper runtime.
- `ffmpeg` available to the helper runtime for media conversions.

Install the download tools in WSL if they are missing:

```bash
sudo apt update && sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

## Install Dependencies

From the TubeVault repo:

```bash
cd /home/natkins/personal/tools/extensions/tube-vault
npm install --prefix extension
npm install --prefix helper
```

## Build Helper

```bash
npm run build --prefix helper
```

This writes helper build files to:

```text
C:\Users\natha\Projects\Tools\tube-vault\helper\dist
```

## Register Native Messaging Host

Run the install script from Windows PowerShell when native messaging needs to be registered or refreshed:

```powershell
C:\Users\natha\Projects\Tools\tube-vault\scripts\install.ps1
```

The native messaging manifest is:

```text
native-messaging/com.tube_vault.helper.json
```

The Windows launcher is:

```text
scripts/run-helper.bat
```

## Build Extension

```bash
npm run build --prefix extension
```

This command:

1. Bumps the extension patch version.
2. Bundles content script, service worker, popup, and options page.
3. Copies extension files to:

```text
C:\Users\natha\Projects\Tools\tube-vault\extension
```

4. Commits the extension build output in the TubeVault repo.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select:

```text
C:\Users\natha\Projects\Tools\tube-vault\extension
```

5. After each build, click Reload on the TubeVault extension card.

## Check Status

Open the TubeVault options page and use the Status section. It checks:

- Native helper connectivity.
- `yt-dlp` availability/version.
- `ffmpeg` availability/version.
- Output folder configuration.

## Common Fixes

- If the helper is offline, rebuild the helper and rerun `scripts/install.ps1`.
- If downloads fail immediately, check `yt-dlp` and `ffmpeg` availability from WSL.
- If Chrome still shows old UI, reload the unpacked extension at `chrome://extensions`.
- If paths are wrong, confirm Chrome is loading the Windows folder and not the WSL source folder.
