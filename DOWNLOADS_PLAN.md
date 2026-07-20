# TubeVault Downloads Manager v2 - Shipped Plan

Status: **shipped**.

This document records the architecture delivered by the Downloads Manager v2 work.
It is historical context, not an active implementation plan.

## Delivered Architecture

- Every selected video becomes an individual job with its own ID, status, expected size, folder, error, and timestamps.
- Playlist and channel jobs share a batch ID, label, category, sequential index, and selected total.
- Unknown titles and sizes are probed immediately before each download.
- Probes and downloads run through one strictly serial queue.
- Individual jobs and complete batches can be cancelled.
- Interrupted probing or running jobs become failed with an `Interrupted` error after a service-worker restart.
- The popup shows active work, grouped queued batches, recent results, and inline cancellation.
- The options Downloads tab contains status filters, grouped history, folder actions, JSON export, and history clearing.
- History can be disabled, retained for a configured number of days, and is capped at 100 finished jobs.
- A batch overview is requested exactly once after its final member settles.
- The helper implements probing, video listing, per-video custom downloads, cancellation, and batch summaries.
- Playlist and channel confirmation dialogs support per-video selection, thumbnails, expected size, duration, views, and duplicate detection.
- The options page contains the four shipped tabs: Downloads, Settings, Status, and Setup.

## Compatibility Contract

Stored jobs remain under the `tvJobs` Chrome local-storage key.
New optional job fields are additive so older stored jobs continue to load.
Existing message names remain stable between the content UI, popup, options page, and service worker.

## Backlog

- Browser-cookie integration remains unimplemented.
It needs explicit privacy messaging and reliable handling of browser cookie database locking.
- Multi-video parallelism remains unimplemented.
The serial queue is intentional because it reduces YouTube rate-limit pressure.
Per-file concurrent fragments are already available through the Faster downloads setting.
