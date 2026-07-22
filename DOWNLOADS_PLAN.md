# TubeVault Downloads Manager v2 - Shipped Plan

Status: **shipped**.

This document records the architecture delivered by the Downloads Manager v2 work.
It is historical context, not an active implementation plan.
See [README.md](README.md) for current features and backlog.

## Delivered Architecture

- Every selected video becomes an individual job with its own ID, status, expected size, folder, error, and timestamps.
- Playlist and channel jobs share a batch ID, label, category, sequential index, and selected total.
- Jobs with unknown sizes are probed immediately before download, refreshing the title when available.
- Downloads and queue-time probes run through one strictly serial queue, while planning and visible-row probes use bounded concurrency.
- Individual jobs and complete batches enter a cancelling state until the helper acknowledges a durable cancellation request.
- After a service-worker restart, interrupted probing or running jobs become failed with an `Interrupted` error, while interrupted cancellations become cancelled, only after the helper acknowledges cancellation.
- For in-flight work, the durable cancellation marker is cleared only after the terminal job transition is stored, and the job remains protected from history pruning until that cleanup succeeds.
- The popup shows active work, grouped queued batches, recent results, and inline cancellation.
- The options Downloads tab contains status filters, grouped history, folder actions, JSON export, and history clearing.
- History can be disabled, retained for a configured number of days, and is capped at 100 finished jobs.
- A batch overview is requested after its final member settles, with successful writes deduplicated and each write attempted up to three times.
- During the one-time migration of unfinished legacy batches, matching date-named summaries from v0.3.80 are reused so an upgrade does not create a duplicate summary.
- Batch-summary reservation receipts live in user-private helper state and are removed only after the terminal summary outcome is durably stored.
- Finished private-history batch details are removed after summary success or retry exhaustion.
- The helper implements probing, video listing, per-video custom downloads, cancellation, and batch summaries.
- Playlist and channel confirmation dialogs support per-video selection, thumbnails, expected size, duration, views, and duplicate detection.
- The options page contains the four shipped tabs: Downloads, Settings, Status, and Setup.

## Compatibility Contract

Stored jobs remain under the `tvJobs` Chrome local-storage key.
New optional job fields are additive so older stored jobs continue to load.
Existing message names remain stable between the content UI, popup, options page, and service worker.
