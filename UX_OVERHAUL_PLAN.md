# TubeVault UX Overhaul Plan

A consolidated, step-by-step breakdown of the UX/feature requests from the
2026-06 review session. Nothing here is built yet — this is the map we tackle
phase by phase. Each item lists **what was asked**, the **current state** in the
code, the **proposed approach**, concrete **steps**, and any **open questions**.

Check items off as we land them. Don't start an item whose open questions are
unresolved without confirming the decision first.

**Legend:** ☐ todo · ◐ partially exists · ✅ done
**Key files:** `extension/src/components/ArchiveButton.tsx` (page button + batch
modal + single-video confirm), `extension/src/components/ArchiveMenu.tsx`
(options menu), `extension/src/popup.tsx`, `extension/src/options.tsx`,
`extension/src/types.ts`, `extension/src/service-worker.ts` (queue/storage),
`helper/src/downloader.ts` (yt-dlp probing).

---

## Area 1 — Batch selection modal (`showSelection` in ArchiveButton.tsx)

This is the "downloader scroll thing" — the checklist shown when downloading a
playlist or channel. It's injected into the YouTube page (content script) and is
**virtualized** (only visible rows render), which matters for the perf questions
below.

### 1.1 ☐ Per-video expected download size in the list
- **Asked:** "know what each individual file is … their expected download size for a video."
- **Current:** In channel "Everything" / playlist mode every item has `bytes: null`
  (sized lazily at download). Rows show `—`. Popular/Latest modes already carry
  real per-item `bytes`. v0.3.64 added a *plan-average* fallback for the total,
  but individual rows still show `—`.
- **Proposed:** Progressive, on-demand probing of the rows currently in view.
  As rows scroll into the viewport (we already track the visible window in
  `renderWindow`), fire a `probe` for each unsized visible video (throttled,
  small concurrency cap, e.g. 3–4 in flight), cache the result on the item, and
  re-render that row + the live total. Never probe the whole list up front (a
  1,000-video playlist would hammer YouTube and rate-limit).
- **Steps:**
  1. Add a `bytes` cache keyed by video id on the modal's `items`.
  2. In `renderWindow`, collect visible items with `bytes == null && !probing`,
     enqueue them into a bounded probe queue (reuse the `probe` action).
  3. On each probe result, set `item.bytes`, repaint that row if still visible,
     and refresh the live total.
  4. Show a subtle "…" / spinner in the size cell while a row is probing.
- **Open questions:**
  - Probe **only** visible rows, or also pre-probe a small look-ahead buffer?
    (Recommend: visible + the existing 6-row buffer.)
  - Acceptable concurrency vs. rate-limit risk? (Recommend cap = 3.)

### 1.2 ☐ Thumbnails per row + ☐ setting to toggle them
- **Asked:** thumbnail next to each video's text when downloading playlists; make
  it a setting to enable/disable; concern about page-load/scroll impact.
- **Current:** Rows are text-only (checkbox · title · size). We already load a
  thumbnail in the single-video confirm from `i.ytimg.com/vi/<id>/mqdefault.jpg`
  (allowed by YouTube's CSP).
- **Proposed:** Add a small (e.g. 64×36) `<img>` (`mqdefault.jpg`, `loading="lazy"`)
  to each row, gated by a new `showThumbnails` setting (default **on**).
  **Perf:** because the list is virtualized, only ~20–30 rows (thus ~30 images)
  exist at once regardless of list length, so the scroll cost is bounded — this
  is the answer to "will it affect page load." Lazy-loading + the virtual window
  keeps it cheap. The toggle is still worth having for slow connections.
- **Steps:**
  1. Add `showThumbnails: boolean` to settings (storage key `showThumbnails`,
     default true) + a checkbox in Options → Settings.
  2. Read it in the content script's cached settings; pass into `showSelection`.
  3. Render the lazy `<img>` per row when enabled; reserve its box even when an
     image 404s (`onerror` → hide, keep layout) so row height stays uniform.
  4. Bump `ROW_H` to fit the thumbnail (≈ 52–56px).
- **Open questions:** thumbnail size/quality (`default` 120×90 vs `mqdefault`
  320×180 scaled)? (Recommend `mqdefault`, rendered ~64×36.)

### 1.3 ☐ Wider modal
- **Asked:** "make the downloader scroll thing wider."
- **Current:** `card maxWidth: 520px`.
- **Proposed:** Widen to ~`680–720px` (and `width: 92%` cap stays for small
  screens). Re-check column layout with thumbnail + extra metadata.
- **Open question:** exact width — 680, 720, or `min(90vw, 760)`?

### 1.4 ☐ Per-video "what we're downloading" breakdown
- **Asked:** "outline what we're downloading for each video" (video + thumbnail +
  metadata, like the single-video flow).
- **Current:** The batch flow applies one component selection to all videos; rows
  don't show which components. The single-video confirm (v0.3.61) shows a
  per-component breakdown with sizes.
- **Proposed:** Two parts:
  - (a) A compact components summary shown once at the top of the modal (e.g.
    "Downloading: Video 1080p mp4 · Thumbnail · Metadata") since the selection is
    uniform across the batch.
  - (b) Optionally a per-row component chip strip / expandable detail. Given the
    selection is identical per video, a per-row repeat is noisy — recommend the
    top-of-modal summary plus making each row's **size** reflect the selected
    components (it already does via the component-aware probe).
- **Open question:** Do you want per-row component icons too, or is a single
  "Downloading: …" summary line at the top enough? (Recommend top summary.)

### 1.5 ☐ Other relevant per-video info
- **Asked:** "other relevant information … when downloading a bunch of stuff."
- **Candidates** (all available from a `yt-dlp` flat-list / probe): duration,
  view count, upload date, channel/uploader (for multi-channel playlists),
  resolution available, live/upcoming flag, age-restriction flag, already-
  downloaded date (already shown as a dup badge).
- **Proposed default:** add **duration** (cheap, comes from the flat-list/probe)
  and keep the existing dup badge; optionally **views** and **upload date** on a
  second line or as muted right-aligned metadata.
- **Open question:** which of {duration, views, upload date, channel} to show,
  and how many fit before the row gets cluttered? (Recommend duration + (date or
  views).)

### 1.6 ☐ Cancel on the left, Download with an icon (modal footer)
- **Asked:** Cancel on the left (not beside Download); a download icon on the
  Download button. Applies here **and** to the single-video confirm.
- **Current:** Footer is `justify-content: flex-end` with `[Cancel][Download]`
  adjacent on the right. Download is text-only.
- **Proposed:** Footer `justify-content: space-between` → Cancel pinned left,
  Download pinned right with a `FiDownload` icon before the label. Apply the same
  to `showVideoConfirm` (Area 2) for consistency.
- **Steps:** restyle the footer rows in `showSelection` and `showVideoConfirm`;
  add the icon (these dialogs are vanilla DOM, so use an inline SVG or a small
  shared `downloadIconSvg()` helper — `react-icons` isn't available in the
  hand-built dialogs).

---

## Area 2 — Single-video confirm (`showVideoConfirm`)

- ✅ Per-component breakdown + thumbnail (done in v0.3.61/0.3.63).
- ☐ **Cancel-left + Download icon** — same treatment as 1.6 for consistency.

---

## Area 3 — Popup (`popup.tsx`)

### 3.1 ◐ Show active downloads
- **Asked:** "I want to know if we're downloading something … displayed in the pop-up."
- **Current:** Already shows a **Downloading** section (active) + **Up next**
  (queued), grouped by batch, with inline cancel. Mostly satisfies this.
- **Proposed:** Verify it reads clearly; ensure the active item shows a progress
  hint (status + size). Possibly add real progress % later (needs helper to emit
  progress — see "Stretch" below). Keep as-is for v1 unless you want %.

### 3.2 ☐ Recent / last-downloaded list in the popup
- **Asked:** "see the last thing we downloaded. The last couple things … at the pop-up."
- **Current:** Popup only shows active+queued; finished jobs live only in Options.
- **Proposed:** Add a **Recent** section showing the last ~3–5 finished jobs
  (done/failed/cancelled), each with status + open-folder button, below the
  active/queued sections. Source from the same `tvJobs` storage.
- **Open question:** how many to show? (Recommend 3.)

### 3.3 ☐ Popup header restructure (settings cog / version / dedicated buttons)
- **Asked (parsed):**
  - A **settings cog** where the version number currently is.
  - The **version number** moved to where the "History & settings" link is
    (the footer).
  - **Dedicated Settings** button and **dedicated History** button (separate, not
    one combined "History & settings" link).
  - A **History** button near the download history area.
- **Current:** Header = `TubeVault` + status pill + `v{version}` pill. Footer =
  output path + a single `History & settings →` link that opens the options page.
- **Proposed layout:**
  - **Header (red bar):** icon + "TubeVault" on the left; on the right a status
    pill, a **⚙ Settings** icon button (opens Options → Settings) and possibly a
    **🕘 History** icon button (opens Options → Downloads). The version pill moves
    out of the header.
  - **Footer:** show `v{version}` (where the combined link used to be) plus the
    output path. Replace the single "History & settings →" link with the two
    dedicated icon buttons above (or keep a small "Open settings"/"Open history"
    pair in the footer — pick one location to avoid duplication).
  - Deep-link: `chrome.runtime.openOptionsPage()` then route to the right tab
    (needs the options page to accept a tab via URL hash, e.g.
    `options.html#status`). Add hash routing in `options.tsx`.
- **Steps:**
  1. Add hash/`?tab=` routing to `options.tsx` `App` so the popup can open a
     specific tab.
  2. Rebuild the popup header/footer per the layout above.
  3. Add ⚙ and 🕘 icon buttons wired to the right tabs.
- **Open question:** Confirm final placement — cog + history both in the header,
  or cog in header and history button down by the (future) recent list? The
  request mentions both "near where it says history and settings" and "a history
  button near our history of downloads." (Recommend: ⚙ + 🕘 in the header,
  version in the footer; the popup's **Recent** section header doubles as a
  "View all history →" link.)

### 3.4 ☐ Use the extension icon / branding
- **Asked:** "use the icon in the pop-up and in the options.js."
- **Current:** Popup shows a text "TubeVault"; options sidebar shows text logo.
- **Proposed:** Render `icons/icon32.png` (or 48) next to the wordmark in both the
  popup header and the options sidebar header.

### 3.5 ☐ Download icon usage
- Reuse the same download icon (Area 1.6) anywhere a "Download" action appears for
  consistency (page button already uses `FiDownload`).

---

## Area 4 — Options page (`options.tsx`)

### 4.1 ☐ Branding icon in the sidebar header
- Same as 3.4 — add the icon beside the "TubeVault" logo in the sidebar.

### 4.2 ☐ Channel download-count presets → numeric inputs
- **Asked:** Not a free-text field where letters are possible; want ~4 numeric
  input fields (digits only); is there a better way?
- **Current:** A single comma-separated text input (`countsText`) parsed by
  `parseCounts`; a Default `<select>`.
- **Proposed:** Replace with **4 `<input type="number" min=1 step=1>`** fields
  (block non-digits on `onKeyDown`/`onBeforeInput`), plus the Default selector
  populated from the four values. Dedupe/sort on save.
  - *Alternative (recommended to consider):* an editable **chip list** — type a
    number, press enter to add a pill, ✕ to remove — which isn't fixed at 4 and
    naturally rejects letters. Slightly more work but nicer.
- **Open question:** Fixed **4 numeric fields** (simple, matches your words) vs.
  the **add/remove chips** approach (flexible count)? (Recommend 4 numeric fields
  for v1; chips later if you like it.)

### 4.3 ☐ Default **preferences** decoupled from pre-selection
- **Asked:** The current "default download preferences" *pre-checks* the
  components, which isn't what you want. You want to set the **default file
  type/quality per category** (e.g. video defaults to Best or 360p; default audio
  format) **without** turning the component on by default. "You should be able to
  do that without pre-selecting the video."
- **Current:** `menuDefaults` is a full `MenuState` (booleans + formats); the menu
  opens pre-checked to it, and the Settings UI only shows the format selectors
  when the component box is checked. So defaults and on/off are tangled.
- **Proposed:** Split into two independent concepts:
  - **Default formats/quality** (always settable): `videoQuality`, `videoFormat`,
    `audioFormat` — these seed a freshly-opened menu's selectors but **do not**
    check any component.
  - **Default selected components** (optional, separate): whether
    video/audio/thumb/metadata start checked. Default = nothing checked (today's
    actual behavior is nothing pre-selected per `defaultMenuState`).
  - In Settings, show the quality/format selectors **always** (not gated behind a
    checkbox), under a "Default quality & formats" group; keep a separate
    optional "Pre-check these components" group.
- **Steps:**
  1. Keep storing `menuDefaults: MenuState` but in the UI render the format
     selectors unconditionally; the checkboxes only control the boolean defaults.
  2. Ensure `ArchiveMenu` seeds selectors from the stored formats even when the
     component is off (it already keeps `videoQuality` etc. in state; just make
     sure they load from `menuDefaults`). The 0.3.62 "click dimmed dropdown to
     enable" change pairs well with this — the dropdown shows your default before
     you enable it.
- **Open question:** Should opening the menu ever pre-check components, or always
  start unchecked with only the formats pre-seeded? (Recommend: formats always
  seeded; components default unchecked, with an optional setting to pre-check.)

### 4.4 ☐ Move "Export history" into the History section
- **Asked:** Export history from the **history** section.
- **Current:** `exportHistory()` exists but lives in **Settings**.
- **Proposed:** Move the Export button to the Downloads/History toolbar (next to
  the filter chips / Clear). Keep the JSON export; consider also CSV.
- **Open question:** JSON only, or JSON + CSV?

### 4.5 ☐ Clear-history confirmation (on-brand)
- **Asked:** Clearing history must confirm first, in the same on-brand dialog
  style. (Stated twice.)
- **Current:** "Clear history" fires immediately.
- **Proposed:** Reusable confirm dialog matching the dark card style used on the
  page (and the content-script dialogs). Build a small `<ConfirmDialog>` for the
  options page (React) — also reused by other destructive actions.

### 4.6 ☐ Larger History/Downloads UI (pills, buttons, text)
- **Asked:** Filter pills and buttons need to be larger / easier to read; make the
  whole downloads text structure larger.
- **Current:** `filterChip` 12px, small paddings; `histTitle` 14px; `histMeta`
  12px; small icon buttons.
- **Proposed:** Bump filter chips to ~14px with larger padding/height; increase
  row title to ~15–16px and meta to ~13px; enlarge the open-folder/icon buttons
  and the badges. Keep it consistent with a slightly larger vertical rhythm.
- **Open question:** A general "comfortable" sizing pass on just the Downloads
  tab, or app-wide? (Recommend Downloads tab first.)

### 4.7 ☐ Status tab behavior
- **Asked:** Understand how status works; it should check "realistically" /
  often; if already connected, don't show a jarring "Checking…" loading state
  every visit; surface real breakage outside the manual check.
- **Current (how it works):** `StatusSection` calls `diagnostics` (native message →
  helper runs `yt-dlp --version` + `ffmpeg -version`) on mount and on "Re-check".
  It shows "Checking…" each time from `idle`. There's no background/periodic
  check and no caching between visits, so every visit to the tab flashes the
  loading state even when nothing changed.
- **Proposed:**
  1. **Cache the last good result** in storage (e.g. `lastDiag` + timestamp).
     On entering the tab, show the cached state immediately (no flash), then
     refresh in the background and update if changed.
  2. **Periodic/background check:** have the popup or a service-worker alarm ping
     the helper on an interval (e.g. every few minutes / on popup open) and store
     the result, so the connection state is fresh without the user clicking.
  3. **Show staleness:** "Last checked 2m ago" + manual Re-check still available.
  4. Only show the big "Checking…" state on the very first run with no cache.
- **Open questions:**
  - Interval for background checks? (Recommend: on popup open + a 5-min
    `chrome.alarms` while the SW is alive; cheap.)
  - Should a disconnected state raise a badge on the toolbar icon? (Nice-to-have.)

### 4.8 ☐ Larger Setup + GitHub reference
- **Asked:** Setup section larger; be able to reference the GitHub for first-time
  setup and more tips.
- **Current:** Compact ordered list; no GitHub link.
- **Proposed:** Increase type sizes/spacing; add a prominent "Full setup guide on
  GitHub →" button linking to the repo's `SETUP.md` / README, and a "More tips"
  link. Keep the inline checklist as the quick version.

### 4.9 ☐ Remove the Support tab → relocate to a "bounce action"
- **Asked:** Remove the Support section; "we can have it in a bounce action."
- **Current:** Full Support tab (About + Sponsors/Coffee links).
- **Interpretation:** "Bounce action" is ambiguous — likely a small secondary/
  out-of-the-way action (a footer link, an overflow "•••" menu, or a one-line
  "Support this project ♥" link in the sidebar footer) rather than a full tab.
  The About/privacy blurb can move to README or a tiny footer note.
- **Proposed:** Drop the `support` tab; add a subtle "♥ Support" link in the
  sidebar footer (near the version) opening a small popover/menu with the
  Sponsors + Coffee links. Move the "no server / local-first" About text to the
  README (it's already in there).
- **Open question:** Confirm what "bounce action" means to you — sidebar footer
  link + popover? a toolbar overflow menu? (Recommend sidebar-footer link +
  small popover.)

### 4.10 ☐ Additional settings worth adding (proposals)
Answering "any other settings you think would be useful":
- **Subtitles component** — the helper's `archive_bundle` already supports
  `--write-subs`/`--sub-langs`, but the component menu has no Subtitles toggle.
  Adding "Subtitles (en)" as a selectable component is high-value and low-effort.
- **SponsorBlock** — `yt-dlp --sponsorblock-remove`/`--sponsorblock-mark` to skip
  sponsor segments; toggle + category selection.
- **Notifications toggle** — on/off for the "download complete" notification
  (currently always fires).
- **Auto-open folder on completion** — there's a dormant `autoOpenFolder` setting
  in the service worker with no UI; either wire it up or remove it.
- **Concurrent downloads** — currently strictly serial (one at a time). An option
  for N parallel could speed batches (with rate-limit caveats).
- **`yt-dlp` concurrent fragments (`-N`)** — faster single-file downloads.
- **Cookies from browser** — `--cookies-from-browser` to grab age-restricted /
  members-only / private-playlist content.
- **Filename template** — advanced users could set a custom `-o` template
  (the naming toggles are a friendly subset of this).
- **Default to skip duplicates** — auto-uncheck already-downloaded (already the
  default in the selection modal) and/or hide them.
- **Open question:** Which of these to include in this pass vs. backlog?
  (Recommend this pass: **Subtitles component** + **Notifications toggle** +
  wire/remove **Auto-open folder**. Backlog: SponsorBlock, concurrency, cookies,
  custom template.)

---

## Area 5 — Shared building blocks (do these first; they unblock the rest)

1. ☐ **`ConfirmDialog`** (React, options page) + keep the content-script vanilla
   confirm — used by Clear History (4.5) and any destructive action.
2. ☐ **Download icon helper** for the vanilla dialogs (inline SVG) — used by 1.6 / 2.
3. ☐ **Options tab deep-linking** (hash/`?tab=`) — unblocks popup buttons (3.3).
4. ☐ **Settings additions to `types.ts` + storage**: `showThumbnails`,
   decoupled default formats, plus any new toggles (4.10). Centralize the
   defaults so the content script, popup, and options stay in sync.
5. ☐ **Branding icon** usage in popup + options (3.4 / 4.1).

---

## Suggested phasing (execution order)

**Phase 0 — Foundations (Area 5):** shared confirm dialog, download-icon helper,
options tab deep-linking, settings/storage additions, branding icon. Small,
unblock everything else.

**Phase 1 — Batch modal polish (Area 1):** wider modal (1.3), cancel-left +
download icon (1.6), top-of-modal "Downloading: …" summary (1.4), thumbnails +
setting (1.2). These are visible wins and mostly self-contained.

**Phase 2 — Batch data (Area 1):** progressive per-video size probing (1.1) and
extra per-video info (1.5). More involved (probing/perf); do after the layout is
settled.

**Phase 3 — Popup (Area 3):** recent-downloads section (3.2), header restructure
with cog/history/version (3.3), branding (3.4), download-icon consistency (3.5).

**Phase 4 — Options (Area 4):** numeric count presets (4.2), decoupled default
prefs (4.3), move export to history (4.4), clear-history confirm (4.5), larger
Downloads UI (4.6), Setup enlargement + GitHub link (4.8), remove Support →
bounce action (4.9).

**Phase 5 — Status + new settings (Area 4):** status caching/periodic check
(4.7), and the chosen additions from 4.10 (Subtitles, Notifications toggle,
Auto-open folder).

Each phase ships as its own version bump(s) and is independently testable
(reload + verify on YouTube). We commit per logical change as usual.

---

## Open questions to resolve before/while building

1. **1.1** Probe concurrency cap and look-ahead for per-video sizing? (Default: cap 3, visible+buffer.)
2. **1.2** Thumbnail size + default on/off? (Default: `mqdefault` ~64×36, on.)
3. **1.3** Modal width? (Default: ~700px.)
4. **1.4** Per-row component icons, or one top summary line? (Default: top summary.)
5. **1.5** Which extra per-video fields? (Default: duration + date/views.)
6. **3.2** How many recent downloads in the popup? (Default: 3.)
7. **3.3** Final popup header/footer layout (cog + history placement). (Default: ⚙+🕘 in header, version in footer.)
8. **4.2** Fixed 4 numeric inputs vs. add/remove chips? (Default: 4 numeric inputs.)
9. **4.3** Ever pre-check components by default, or only seed formats? (Default: seed formats, components off.)
10. **4.4** Export JSON only or JSON+CSV? (Default: JSON, maybe add CSV.)
11. **4.6** Sizing pass scope — Downloads tab only or app-wide? (Default: Downloads first.)
12. **4.7** Background status-check interval + toolbar badge on disconnect? (Default: popup-open + 5-min alarm, no badge yet.)
13. **4.9** What exactly is a "bounce action" for Support? (Default: sidebar-footer link + popover.)
14. **4.10** Which extra settings this pass? (Default: Subtitles, Notifications toggle, Auto-open folder.)
