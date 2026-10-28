# TubeVault Handoff

## Current state and open work (2026-10-27): start here

### What this is

TubeVault is a local-first Manifest V3 Chrome extension plus a WSL native-messaging helper that archives YouTube videos, playlists, channels, thumbnails and metadata to the owner's machine through `yt-dlp`.
Repo: `n8watkins/tube-vault`, default branch `master`.
It is not published to the Chrome Web Store.
"Live" means the unpacked extension Chrome loads from the Windows folder `C:\Users\natha\Projects\Tools\tube-vault\extension` (WSL: `/mnt/c/Users/natha/Projects/Tools/tube-vault`), which currently reports version 0.3.106.
The code is MIT licensed as of 2026-10-27 (PR #3, [`LICENSE`](../LICENSE)).
Architecture, build commands and injection points are in [`../CLAUDE.md`](../CLAUDE.md), [`../README.md`](../README.md) and [`../SETUP.md`](../SETUP.md).

### Status as of today

- `master` is at extension version 0.3.80, plus the esbuild 0.28 upgrade (PR #2) and the MIT license (PR #3).
- The review branch `review/tube-vault-v0.3.81` is 140 commits ahead of `master` and is at 0.3.106; that is the build Chrome is running from the Windows folder.
  So the version in use is not on `master`.
- release-kit (2.0.0, PR #4) exists only on `review/tube-vault-v0.3.81`; `master` has no release-kit, no root `package.json` and no CI workflow.
- The owner has not decided who owns `CHANGELOG.md` (release-kit's generator or the repo's own `npm run changelog` / build flow).
  Do not merge the review branch, hand-edit the changelog, or pick an owner until the owner decides.
- Never run `npm run build` in `extension/` for a test: it bumps the version, commits, and syncs to the Windows extension folder.
  For a throwaway test build, call esbuild directly (see `extension/build.mjs` for the entry points and options).

### Open PR

PR #1 "fix: harden download recovery and Windows publication" (`review/tube-vault-v0.3.81` into `master`, opened 2026-07-22) is open and not mergeable as it stands:

- 46 files, +11,156 / -1,580, covering durable queue recovery, native cancellation, transactional Windows sync, release scripts, unit and Playwright tests, and a self-hosted CI runner for trusted pushes.
- GitHub reports merge conflicts with `master` (PRs #2 and #3 landed on `master` after the branch was cut).
- Its latest CI run (`test`, run 40566835877 on the push of PR #4's merge) fails at the changelog check: `CHANGELOG.md is stale. Run npm run changelog.`
  The lint, typecheck, unit and build steps before it passed, and GitGuardian passes.
  That failure is a direct consequence of the undecided changelog owner, so it should be resolved together with that decision, not by hand-editing the file.
- There is no review decision on it.

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
2. **Local git hooks point at a folder `master` does not have.**
   The checkout's local `core.hooksPath` is `.githooks` (set by release-kit), but `.githooks/commit-msg` exists only on the remote review branch, so on `master` and on the local review branch (one commit behind `origin`) no commit-msg hook runs.
   This sorts itself out when release-kit lands on `master`.
3. **Stale paths in the docs.**
   `README.md` and `CLAUDE.md` still give the development path as `/home/natkins/personal/tools/extensions/tube-vault`; the checkout is now `~/projects/extensions/tube-vault`.
   `README.md` also says "Current Chrome extension version: v0.3.51".

### Blocked on the owner

- Decide who owns `CHANGELOG.md` (release-kit or the existing build flow); this gates PR #1, the review branch's CI, and release-kit on `master`.
- Decide whether and how PR #1 should land (rebase onto `master` and merge, or split).

### Next steps, in order

1. Isolate and fix the Shorts comments bug (open problem 1), with a regression test, on top of whichever branch the owner wants it on.
2. After the changelog decision, regenerate the changelog with the chosen tool, resolve PR #1's conflicts with `master`, get its CI green, and land it so `master` matches the build Chrome runs.
3. Fix the stale paths and version in `README.md` and `CLAUDE.md`.
