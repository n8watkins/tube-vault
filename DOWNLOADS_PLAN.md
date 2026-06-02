# TubeVault — Downloads Manager v2 Plan

Status: **planned** (current shipped code is v0.3.38 = batch-as-one-job).
Goal: per-video job queue, info split between popup (now) and options (history +
setup + support).

## Decisions (locked)

- **One job per video.** A playlist/channel batch expands into individual
  per-video jobs (grouped by a `batchId`), each with its own size + cancel.
- **Popup = "now"**: currently downloading + queue only. Links to options for
  history.
- **History = options page only** (a History section).
- Options page also gets: **Setup/Installation guide**, **Support me** section.

---

## 1. Job model (core change)

Current `Job` (service-worker.ts) is one-per-request. Change to **one per video**:

```ts
interface Job {
  id: string;
  batchId?: string;        // groups videos from one playlist/channel request
  batchLabel?: string;     // e.g. "Playlist: Interviews" / "MKBHD — top 30"
  videoUrl: string;        // single watch URL
  label: string;           // video title (lazily filled) or video id
  components: object;       // what to grab (video/audio/meta/thumb)
  status: 'queued'|'probing'|'running'|'done'|'failed'|'cancelled';
  estBytes?: number;       // filled from plan, or lazily before download
  folder?: string;
  error?: string;
  createdAt: number; finishedAt?: number;
}
```

### Expansion (where batches become per-video jobs)
On a download request the service worker builds the job list:
- **Single video** → 1 job (`videoUrl` = the watch URL).
- **Channel popular / latest** → we already have `plan.targets` (watch URLs) AND
  per-video sizes from `channel_plan`. Enqueue one job per target with `estBytes`
  pre-filled. (Also fetch titles in the plan — add `%(title)s` to fetchVideoMeta.)
- **Channel all / Playlist** → flat-list the URL first (fast, 1 call) to get all
  video URLs, enqueue one job each, `estBytes` unknown → lazy.

### Lazy sizing/titling (avoids rate-limit bursts)
Because the queue is **serial**, fetch each job's size+title **just before it
downloads** if not already known:
- pumpQueue picks next `queued` job → if no `estBytes`/title, set `probing`,
  call helper `probe` (one video) → store title+estBytes → set `running` →
  download. One-at-a-time = no rate-limit burst even for huge channels.

---

## 2. Helper changes (helper/src)

Mostly already done (single-URL custom download + cancel by jobId work). Add:

- **`probe` action**: `{action:'probe', url}` → `{ok, title, bytes, duration}`
  via `yt-dlp --no-warnings --skip-download --print "%(title)s\t%(filesize_approx)s\t%(duration)s" <url>`.
- **`list_videos` action**: `{action:'list_videos', url}` →
  `{ok, videos:[{id,url}]}` (flat-list) for expanding playlist/channel-all.
  (channel_plan already flat-lists — factor `flatListIds` for reuse.)
- channel_plan's `fetchVideoMeta`: also print `%(title)s` so popular/latest jobs
  get titles up front.

Per-video download itself = existing `custom` with a single `url` + `jobId`
(already supports detached spawn + cancel-by-pid). No change.

---

## 3. Service worker (queue) changes

- `enqueueBatch(request)`: expand → push N per-video jobs (shared `batchId`).
  - popular/latest: use targets + sizes (+titles) from the plan already fetched.
  - playlist/all: call `list_videos`, push jobs (sizes lazy).
- `pumpQueue()`: before running a job missing size/title → `probe` → update →
  download. Still strictly one running at a time.
- **Cancel job** (exists). **Cancel batch** = cancel all jobs with that batchId
  (cancel running + drop queued).
- History retention: keep last ~100 finished jobs in `tvJobs`.

---

## 4. Popup (now-focused) — popup.tsx

- **Downloading**: current job — video title, size, Cancel (✕→Stop confirm).
- **Up next**: queued jobs; collapse batches → "Playlist: Interviews — 3/15"
  with expand to see/cancel individual videos; "Cancel batch" option.
- Footer: **"History & settings →"** button → `chrome.runtime.openOptionsPage()`.
- Remove the History section from the popup.

---

## 5. Options page — options.tsx (becomes a multi-section page)

Sections (left-nav tabs or stacked):

1. **Settings** (existing): download folder, auto-open Explorer, channel count
   presets.
2. **History** (new): full finished-jobs list — title, size, folder (button to
   open via `open_folder`), date, status badge; **Clear history**; filter by
   status. Reads `tvJobs` from storage.
3. **Setup & Status** (new):
   - "Check status" using the existing `diagnostics` action → show yt-dlp
     version, ffmpeg version, output root, helper connected ✓/✗.
   - Install guide: what you need (WSL, yt-dlp, ffmpeg, the native-messaging
     host registration, the helper build). Step list + copyable commands.
   - Troubleshooting notes (helper offline, etc.).
4. **Support** (new): "Support me" links (placeholders to fill: GitHub sponsor /
   Buy me a coffee / etc.).
5. (Optional later) **About**: version, links, changelog.

---

## 6. Build order (phased, low-risk first)

- **P1 — per-video jobs**: helper `probe` + `list_videos`; SW expansion + lazy
  sizing; popup shows per-item + batch grouping. (Biggest piece.)
- **P2 — options History**: move history to options; popup links out.
- **P3 — options Setup & Status** (reuse `diagnostics`).
- **P4 — options Support** + polish (batch cancel, actual sizes, reorder).

## Open questions to confirm later
- Actual (vs estimated) size for finished jobs — capture from yt-dlp output or
  stat the folder? (phase 4)
- Batch download still 1 yt-dlp per video (loses playlist single-process
  efficiency) — accepted for per-item visibility/cancel.
- Support links — which platforms?

## Current code references
- `extension/src/service-worker.ts` — queue/jobs (batch-as-one today)
- `extension/src/components/ArchiveButton.tsx` — sendRequest, runChannelFlow,
  runPlaylistFlow, showConfirm
- `extension/src/popup.tsx` — current downloads panel (has history; to be split)
- `extension/src/options.tsx` — settings only today
- `helper/src/index.ts` — actions incl. cancel; `helper/src/downloader.ts` —
  channelPlan/fetchVideoMeta/flatListIds, detached spawn + killActive
