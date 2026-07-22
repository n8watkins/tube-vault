# TubeVault

Chrome MV3 extension plus a local native messaging helper for archiving YouTube content through `yt-dlp`.

## Architecture

- `extension/` contains the React and TypeScript Chrome extension bundled with esbuild.
- `helper/` contains the Node.js native messaging host that launches `yt-dlp` and `ffmpeg`.
- `scripts/` contains explicit deployment, release, registration, and launcher scripts.
- `tests/e2e/` contains Playwright smoke tests for the unpacked extension.

This directory is its own Git repository.
Do not create or use a parent repository.

## Dependency Setup

Install each lockfile from the repository root:

```bash
npm ci
npm ci --prefix extension
npm ci --prefix helper
```

## Build and Verification

Use the root commands:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run changelog:check
npm run check
```

The default `npm run build` is pure.
It builds `extension/dist` and `helper/dist` without bumping versions, syncing files, staging changes, committing, or pushing.

The extension watch command watches all four entry points and has no release side effects:

```bash
npm run watch --prefix extension
```

Install Chromium once before running the browser smoke tests:

```bash
npx playwright install chromium
npm run test:e2e
```

## Windows Deployment

Chrome can load an explicit Windows checkout after a build and sync:

```bash
npm run sync:windows -- --target /mnt/c/Users/<you>/Projects/tube-vault
```

`TUBE_VAULT_WINDOWS_REPO` is also supported, and `--target` takes precedence.
The target must be the absolute root of an existing Git repository with TubeVault extension and helper package identities.
See [README.md](README.md) for the sync publication and allowlist guarantees.
Reload the unpacked extension at `chrome://extensions` after syncing.

## Patch Release

Create a checked local patch release with:

```bash
npm run release:patch
```

See [README.md](README.md) for the release validation, rollback, commit, and publication contract.
The release command regenerates and stages `CHANGELOG.md`; never edit that generated file manually.

## Key Files

- `extension/src/content-script.tsx` contains page detection, injection, and SPA navigation recovery.
- `extension/src/components/ArchiveButton.tsx` contains download flows and confirmation dialogs.
- `extension/src/components/ArchiveMenu.tsx` contains component and format selection.
- `extension/src/job-coordinator.ts` contains Chrome-independent queue behavior.
- `extension/src/service-worker.ts` adapts Chrome APIs to the queue coordinator.
- `extension/src/types.ts` contains shared extension types and defaults.
- `helper/src/downloader.ts` builds and runs `yt-dlp` commands.
- `helper/src/index.ts` handles native messaging protocol actions.

## Injection Points

| Page type | Target | Style |
| --- | --- | --- |
| Watch or Live | `#top-level-buttons-computed` action row | Full text button |
| Shorts | Visible `reel-action-bar-view-model` | Compact icon button |
| Playlist or Mix | Playlist panel or header actions | Full text button |
| Channel | Flexible header actions or subscribe area | Full text button |
