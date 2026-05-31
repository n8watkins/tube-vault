# TubeVault

Chrome extension + WSL native helper for archiving YouTube videos locally via yt-dlp.

## Architecture

- `extension/` — Chrome MV3 extension (React + TypeScript, bundled with esbuild)
- `helper/` — Node.js native messaging host that runs in WSL and shells out to yt-dlp

Chrome loads the extension from the **Windows** path:
`C:\Users\natha\Projects\Tools\tube-vault\extension\`

Development happens in WSL (`/home/natkins/personal/tools/tube-vault/`).

## Build workflow

**Always build from `extension/`:**

```
cd extension
npm run build
```

This single command:
1. Bumps the patch version in `package.json` and `manifest.json`
2. Bundles with esbuild (React, minified)
3. Copies `manifest.json` + `dist/*.js` to the Windows path
4. Commits everything in `tube-vault/extension/` with message `build(tube-vault): vX.Y.Z`

After building, **reload the extension in Chrome** (chrome://extensions → reload button).

Watch mode (no bump, no commit, no sync):
```
npm run watch
```

## Helper build

```
cd helper
npm run build
```

The helper runs in WSL — its dist files do not need to be copied to Windows.

## Key files

- `extension/src/content-script.tsx` — injection logic + SPA navigation watcher
- `extension/src/components/ArchiveButton.tsx` — trigger button + menu state
- `extension/src/components/ArchiveMenu.tsx` — checkbox panel UI (React)
- `extension/src/types.ts` — shared types (MenuState, VideoQuality, etc.)
- `helper/src/downloader.ts` — yt-dlp command builder; handles `custom` action
- `helper/src/index.ts` — native messaging entry point

## Injection points

| Page type | Target | Style |
|-----------|--------|-------|
| Watch / Live | `#top-level-buttons-computed` action row | Full text button |
| Shorts | `#right-controls`, before `.ytp-settings-button` | Compact icon-only |
| Playlist | `ytd-playlist-header-renderer #button-sheet` (near Shuffle) | Full text button |
