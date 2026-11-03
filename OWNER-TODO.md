# Owner to-do

Things only the owner can do for TubeVault: decisions and tests on the owner's own machine.
Agents keep this list current; tick an item by changing `[ ]` to `[x]` and adding the date.
No secrets go in this file.
The cross-project list of keys to rotate is `SECURITY-TODO.md` in the private [secret-handling-review](https://github.com/n8watkins/secret-handling-review/blob/main/SECURITY-TODO.md) repo.

Last checked: 2026-11-02.
Context: the default branch is `review/tube-vault-v0.3.81`, the line Chrome runs; `master` is frozen at 0.3.80; see [docs/HANDOFF.md](docs/HANDOFF.md).

## Open

### 1. Optional: rename the working branch to `main`

- [ ] Decision given to Claude.

**What.**
The default branch has a review-era name, `review/tube-vault-v0.3.81`.

**Steps.**
Tell Claude "rename it to main", or "keep the name".

**Why.**
A plain name is easier to type and matches the other build repos, and it would let release-kit's release train work here (the train only runs on `main` or `master`).
GitHub's rename keeps all history, retargets open pull requests and redirects old links, but each local checkout (WSL and the Windows folder Chrome loads) then needs `git branch -m` and a new upstream, and `.release.json`, the Commit messages workflow and the docs need the new name.

**Unblocks.**
Nothing urgent; the current name works.

### 2. Optional: retire the self-hosted runner

- [ ] Done.

**What.**
CI now runs only on GitHub-hosted runners (free for a public repo), so the `n8desktop-tube-vault` runner on this PC gets no more jobs.

**Steps.**
Stop and remove the `github-actions-tube-vault.service` user service and the runner folder `/home/natkins/actions-runners/tube-vault`, or ask Claude to do it.

**Why.**
It frees a background service on the PC.

### 3. Check the Shorts comments bug in Chrome

- [ ] Done.

**What.**
Comments used to stop following the active Short when scrolling between Shorts with TubeVault and TL;DW both loaded.
PR #6 moved TubeVault's Shorts button out of YouTube's action bar, which was the likely cause, but nobody has checked it in real Chrome since.

**Steps.**
With both extensions loaded, open a Short, open its comments, scroll to the next Short and see whether the comments change with it.
Tell Claude what you see.

**Why.**
It needs a signed-in, real YouTube session, which CI never touches.

## Done

- [x] 2026-11-02: Who owns `CHANGELOG.md`: release-kit (PR #9 replaced the repo's own changelog generator).
- [x] 2026-11-02: How PR #1 lands: it doesn't need to.
  The review branch it came from is now the default branch, with its full history; PR #1 was closed as superseded, and the few files only `master` had (the license, this list and the handoff) were brought over.
