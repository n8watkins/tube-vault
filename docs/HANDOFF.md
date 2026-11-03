# TubeVault Handoff

## Current state and open work (2026-11-02): start here

### What this is

TubeVault is a local-first Manifest V3 Chrome extension plus a WSL native-messaging helper that archives YouTube videos, playlists, channels, thumbnails and metadata to the owner's machine through `yt-dlp`.
Repo: `n8watkins/tube-vault`, default branch `review/tube-vault-v0.3.81` (since 2026-11-02; see below).
It is not published to the Chrome Web Store.
"Live" means the unpacked extension Chrome loads from the Windows folder `C:\Users\natha\Projects\Tools\tube-vault\extension` (WSL: `/mnt/c/Users/natha/Projects/Tools/tube-vault`), synced from the default branch with `npm run sync:windows`.
The code is MIT licensed as of 2026-10-27 (PR #3, [`LICENSE`](../LICENSE)).
Architecture, build commands and injection points are in [`../CLAUDE.md`](../CLAUDE.md), [`../README.md`](../README.md) and [`../SETUP.md`](../SETUP.md).

### Status as of today

- The working line is `review/tube-vault-v0.3.81`, now the default branch; it is at 0.3.109 and is what Chrome runs.
- `master` is frozen at 0.3.80 plus four small commits (PRs #2, #3, #5, #14) whose content is all on the default branch too: the esbuild 0.28 upgrade, the license, this handoff and `OWNER-TODO.md`.
  It is kept, protected, for its history; nothing new lands there.
- PR #1 (the review branch into `master`, 151 commits, with conflicts) was closed as superseded: making its head branch the default branch landed everything it carried without rewriting history.
- release-kit owns `CHANGELOG.md` and the version files (PR #9); `npm run release` cuts releases from the default branch.
- CI (`.github/workflows/ci.yml`) runs lint, types and build, unit tests per package and the Playwright browser tests as parallel lanes on GitHub-hosted runners; `CI result` and the Commit messages check (`check / check`) are required on the working branch and `master` (README, Continuous Integration).
- `npm run build` is pure: it builds `extension/dist` and `helper/dist` with no version bump, commit or sync.

### Open problems

1. **YouTube Shorts comments stop updating when scrolling between Shorts (HIGH, user-facing).**
   Seen with both TubeVault and TL;DW installed; it is not yet known which extension causes it, or whether it needs both.
   Reproduce: load both extensions in Chrome, open any `https://www.youtube.com/shorts/...` page, open the comments panel, scroll to the next Short, and check whether the comments still show the previous Short.
   Likely places in TubeVault (read, not yet confirmed; the code is the same on `master` and the review branch):
   - `extension/src/content-script.tsx` `mountShortsButton()` inserts a React root as the first child of YouTube's `reel-action-bar-view-model`, the action bar that also holds the comments button.
     YouTube recycles reel renderers as you scroll, so a foreign node inside that bar may break how it rebinds to the next Short.
   - `startShortsObservers()` in the same file keeps an `IntersectionObserver` plus a document-wide `MutationObserver` alive across Shorts and remounts the button on every scroll.
   - `onNavigate()` / `syncForCurrentPage()` run from another document-wide `MutationObserver` (`navObserver`), `yt-navigate-finish`, `yt-page-data-updated`, `popstate`, and a 1.5 s heartbeat that also writes `data-tv-beat` on `<html>`.
   In TL;DW the candidates are its 500 ms `onNavigate()` poll in `src/content/youtube.ts`, which treats Shorts as video pages, and its transcript-panel clicks (see TL;DW's `docs/HANDOFF.md`).
   Plan: isolate by loading one extension at a time (TubeVault only, TL;DW only, both), then fix the culprit and add a Playwright regression test that scrolls between Shorts and asserts the comments panel follows the active Short.
   The review branch already has a Playwright smoke setup (`playwright.config.ts`, `tests/`) that such a test could join.

Fixed since the last handoff: the Shorts button no longer sits inside YouTube's action bar and the content script dropped its page-wide observer and heartbeat (PR #6), which addresses the likely TubeVault causes above; whether the comments bug is gone still needs a manual check in Chrome with TL;DW loaded too.
The commit-msg hook now exists on the default branch, and the stale paths and version in `README.md` and `CLAUDE.md` are gone.

### Blocked on the owner

Nothing blocking; the optional decisions are in [../OWNER-TODO.md](../OWNER-TODO.md); keep that file current instead of listing them here.

### Next steps, in order

1. Confirm the Shorts comments bug is gone (open problem 1); if not, isolate it and fix it with a Playwright regression test.
