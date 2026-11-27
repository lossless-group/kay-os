---
title: "Backfill Runs Ended Before Writing Their Status"
lede: "The first cloud backfill runs did their work but never said so: status.json stayed stale while the index quietly filled. The fix splits the backfill into short alarm-driven chunks that record themselves as they go."
date_created: 2026-11-27
date_modified: 2026-11-27
date_authored_initial_draft: 2026-11-27
date_authored_current_draft: 2026-11-27
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Resolved
site_uuid: 6e0864a9-8597-47cc-a20d-49c20e49f0e5
hex_code: 1soq9f
summary: >-
  After C3 (backfill from R2) shipped on 2026-11-27, the sync Worker's
  scheduled runs did the sync, read Gmail's metadata, and indexed up to 500
  older messages per account in one invocation. The first heavy runs ended
  before their last step, so status.json kept showing the previous run while
  D1 kept growing. Diagnosis took a wrong turn (a mid-run count looked like a
  finished backfill missing 275 messages). The fix moves the backfill into
  Durable Object alarms of 100 messages each, writes status after every
  chunk, defers the repeated-logo scan to the end, and raises the CPU limit.
tags:
  - Issue
  - Cloudflare-Workers
  - Durable-Objects
  - D1
  - Backfill
type: Issues
---

# Backfill Runs Ended Before Writing Their Status

Spec: [[Attachments-as-First-Class-Mail]], Cloud step C3. Plan:
[[Plan-C3-Backfill-Index-From-R2]].

## What we saw

C3 was deployed at about 01:35 UTC on 2026-11-27. To see it work without
waiting for 7am, a temporary every-15-minutes schedule was added on top of
the usual four runs a day.

- The 01:45 and 02:00 runs left `state/<account>/status.json` untouched for
  both accounts. It still showed the 01:05 run, from before the backfill
  existed.
- D1 was filling anyway. At about 02:05: 438 humain messages, 225 Gmail,
  1,219 Gmail meta rows, 663 scans, all `ok`, 0 errors.
- Every run saves its place page by page, so nothing was lost or duplicated.

## A wrong turn worth remembering

The 02:30 run's log said humain was `backfilled 0, done`, while the last count
seen was 438 of 713. That looked like a bug that marks the walk finished
early. It wasn't: the 438 had been read while a run was still writing. A
fresh count showed **714** (the laptop's 713 plus one message the Worker
fetched itself), exactly what R2 holds. **Count again before concluding a
backfill skipped messages;** a long run's numbers move under you.

## Cause

Each scheduled run did everything in one invocation, chained from the cron
handler to the account's Durable Object:

1. sync new mail over IMAP;
2. for Gmail, read up to 5,000 `meta/` files (about 1,570 existed), one R2 get each;
3. index up to 500 `.eml` files: an R2 get, a parse, and a D1 batch each;
4. only then write `status.json`.

Steps 2 and 3 make a few thousand calls to R2 and D1 in one go. The first
runs, which had the most to do (Gmail's whole meta read plus a full batch),
ended before step 4. Later runs, with less left, completed: the 02:30 run
wrote status for both accounts (humain in 3.7 s; Gmail with 500 indexed).

**Which limit ended them wasn't captured.** The logs for those runs weren't
being tailed, and Cloudflare's docs are ambiguous: they list 15 minutes of
wall-clock time for cron triggers, while third-party sources tie a 30-second
CPU default to schedules that fire more often than hourly, as the
every-15-minutes test schedule did. Either way the shape was the problem: one
long invocation whose record of itself came last.

## Fix

`sync-worker/src/index.ts` and the new `src/backfill-loop.ts`:

- **The scheduled run only syncs.** It saves the account address, syncs new
  mail (which indexes new messages as before), writes `status.json`, and, if
  the backfill isn't done, sets a Durable Object alarm one second out.
- **The backfill runs in alarms of 100 messages** (`CHUNK`: 100 messages, at
  most 300 meta files, R2 pages of 1,000). Each alarm is its own invocation,
  saves its place, adds to running totals, writes `status.json`, and re-arms
  two seconds later until the walk is done.
- **Failures back off**: a chunk that makes no progress waits 1, 2, 4…
  minutes (capped at an hour) and stops after 8 in a row, marked `stopped`;
  the next scheduled run starts it again.
- **The repeated-logo scan runs once, at the end** of an account's
  backfill, not after every chunk. It reads every attachment link, which gets
  expensive at Gmail's size. Live sync still runs it after each pass with new
  mail.
- **CPU headroom**: `"limits": { "cpu_ms": 300000 }` in `wrangler.jsonc`
  (Workers Paid allows up to five minutes).

`status.json` now carries `backfill: { indexed, errors, chunks, done,
failures, stopped, lastChunkAt, nextChunkAt, lastError }`. Totals count from
when the loop started; the messages indexed by the earlier runs aren't in
them.

Tests: `test/backfill-loop.test.ts` covers progress, finishing, back-off and
the stop, and recovery after a failure. Worker suite: 39 pass; typecheck
clean.

## Verification

Checked 2026-11-27, 02:45–03:05 UTC, with the temporary schedule still on:

- [x] `status.json` gained a `backfill` block; Gmail's `chunks` rose 1 → 5 in
      about three minutes, `nextChunkAt` a few seconds ahead each time, no
      failures.
- [x] humain: `done: true`, D1 at 714, matching R2.
- [x] Gmail: chunks kept coming without a cron (28 by 03:04, 2,800 indexed by
      the loop, 4,441 Gmail rows in D1 in total). At roughly one chunk of 100
      every 40 seconds, its ~230,000 laptop-era messages take about a day.
- [x] A new account, michael@mandatory.ventures, added the same night: its
      714 messages backfilled in 8 chunks within about four minutes of its
      first scheduled run, `done: true`.
- [x] 5,869 scans, all `ok`, 0 errors.
- [x] Temporary every-15-minutes schedule removed; back to 7am, 11am, 3pm and
      7pm Central.

## Related

- [[Mail-Archive-in-Cloudflare-R2]]: the Worker, the bucket, and the schedule.
- Cloudflare: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
