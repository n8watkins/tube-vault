# Owner to-do

Things only the owner can do for TubeVault: decisions and tests on the owner's own machine.
Agents keep this list current; tick an item by changing `[ ]` to `[x]` and adding the date.
No secrets go in this file.
The cross-project list of keys to rotate is `SECURITY-TODO.md` in the private [secret-handling-review](https://github.com/n8watkins/secret-handling-review/blob/main/SECURITY-TODO.md) repo.

Last checked: 2026-11-02.
Context: `master` is at 0.3.80, while Chrome runs 0.3.106 from the review branch `review/tube-vault-v0.3.81` (PR #1); see [docs/HANDOFF.md](docs/HANDOFF.md).

## 1. Decide who owns CHANGELOG.md

- [ ] Decision given to Claude.

**What.**
Pick the one tool that writes `CHANGELOG.md`.

**Steps.**
Tell Claude one of:

1. release-kit (the same as every other build repo: notes come from Conventional Commits when a release is cut).
2. The repo's own `npm run changelog` and build flow (as on the review branch today).

**Why.**
The review branch's CI fails at "CHANGELOG.md is stale" because both tools claim the file, and agents must not hand-edit it.

**Unblocks.**
Green CI on PR #1, release-kit on `master`, and the commit-msg hook on `master`.

## 2. Decide how PR #1 lands

- [ ] Decision given to Claude.

**What.**
PR #1 ("fix: harden download recovery and Windows publication", 46 files, about 11,000 added lines) has conflicts with `master` and no review.

**Steps.**
Tell Claude one of:

1. Rebase it onto `master` and merge it as one squash, once CI is green.
2. Split it into smaller PRs (queue recovery, native cancellation, Windows sync, release scripts, tests and CI) and merge them in order.

**Why.**
It is the version you use every day, so how much review it gets is your call.

**Unblocks.**
`master` matching the build Chrome runs, and the Shorts comments fix landing on the right branch.
