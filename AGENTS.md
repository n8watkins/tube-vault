# TubeVault

Chrome MV3 extension plus a local native messaging helper for archiving YouTube content through `yt-dlp`.

## Architecture

- `extension/` contains the React and TypeScript Chrome extension bundled with esbuild.
- `helper/` contains the Node.js native messaging host that launches `yt-dlp` and `ffmpeg`.
- `scripts/` contains the Windows sync, registration, launcher, and screenshot scripts.
- `tests/e2e/` contains Playwright smoke tests for the unpacked extension.

This directory is its own Git repository.
Do not create or use a parent repository.

## Dependency Setup

Install each lockfile from the repository root:

```bash
npm run install:all
```

## Build and Verification

Use the root commands:

```bash
npm run build
npm run typecheck
npm run lint
npm test
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

## Releases

TubeVault releases with release-kit; see the Releases section of [README.md](README.md) and [RELEASING.md](RELEASING.md).

```bash
npm run release -- --dry-run
npm run release -- patch --push
npm run sync:windows -- --target /mnt/c/Users/natha/Projects/Tools/tube-vault
```

Releases are cut from `review/tube-vault-v0.3.81` (the branch Chrome runs) or `master`.
`npm run release` bumps every version file, prepends the `CHANGELOG.md` section, commits `chore(release): vX.Y.Z` and tags it; never edit `CHANGELOG.md` or a version by hand.
Squash-merge pull requests with the PR title as the subject; the `(#N)` GitHub adds is expected and links to the PR in the notes.

## Key Files

- `extension/src/content-script.tsx` contains page detection, injection, and SPA navigation recovery.
- `extension/src/components/ArchiveButton.tsx` contains download flows and confirmation dialogs.
- `extension/src/components/ArchiveMenu.tsx` contains component and format selection.
- `extension/src/job-coordinator.ts` contains Chrome-independent queue behavior.
- `extension/src/service-worker.ts` adapts Chrome APIs to the queue coordinator.
- `extension/src/types.ts` contains shared extension types and defaults.
- `helper/src/downloader.ts` builds and runs `yt-dlp` commands.
- `helper/src/index.ts` handles native messaging protocol actions.
- `helper/src/progress.ts` turns `yt-dlp` progress lines into the live progress the helper streams to the extension.

Queue downloads run over a long-lived native messaging port (`connectNative`).
The helper sends `{ type: 'progress' }` messages before the final response, and the coordinator stores them on the running job for the popup and Downloads page.
Before each video, yt-dlp prints a plan of every stream it will fetch (`planArgs()`), so the job total covers the audio stream of a merged video before it starts.
The percent only moves forward: the helper and the coordinator both hold the highest percent shown, so the bar pauses, rather than dipping, when a stream turns out larger than its estimate, while the byte, speed and time-left text stays exact.
The phase only moves forward too: "Finishing up" starts once every planned stream has downloaded, because yt-dlp also reports post-processors that run before the download (SponsorBlock, the thumbnail convert), and once shown it stays.

The content script is quiet by default.
Set `localStorage.tubeVaultDebug = '1'` in a YouTube tab's console and reload to see its injection and navigation logs.

## Injection Points

| Page type | Target | Style |
| --- | --- | --- |
| Watch or Live | `#top-level-buttons-computed` action row (YouTube's Download button is hidden with CSS, not removed) | Full text button |
| Shorts | Own container placed just before the visible `reel-action-bar-view-model` (never inside it), kept mounted across Shorts | Compact icon button |
| Playlist or Mix | Playlist panel or header actions | Full text button |
| Channel | Flexible header actions or subscribe area | Full text button |

<!-- release-kit -->
## Commits and releases

- Write every commit message as a Conventional Commit: `type(scope): subject`, with type one of feat, fix, perf, security, refactor, docs, test, build, ci, chore, style, revert. A hook and a CI check reject anything else; see RELEASING.md.
- Use `feat` and `fix` only for changes a user would notice: they become the release notes and the public build log.
- Write those subjects as patch notes, for users: what they can now do or what works better, not the file, library or test you touched. When the subject must stay technical, add a `Release-note: <plain sentence>` line to the body, or `Release-note: skip` for a change no user would notice.
- Don't bump versions, edit CHANGELOG.md or create tags by hand: `npm run release` does all three.
- Land changes through pull requests: a pre-push hook blocks pushing straight to main or a release branch, force pushes and moving release tags. Don't get around it with `--no-verify` or `RELEASE_KIT_ALLOW_DIRECT_PUSH=1` (that is for emergencies the owner asks for, and a Direct push alarm reports it either way).
<!-- /release-kit -->
