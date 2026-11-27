---
title: "Plan C3 — The Worker Backfills the Index From R2"
lede: "Mail already in R2, from the laptop or from earlier Worker runs, gets indexed by the Worker itself, a batch at a time, with no laptop involved."
date_created: 2026-11-26
date_modified: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Ready
site_uuid: 3b7ea758-970c-4d8d-9889-76209f81bfe3
hex_code: j2ogy1
summary: >-
  Step C3 of the cloud index. After each sync pass, each account's Durable
  Object indexes up to a batch of .eml files under raw/<account>/ that D1
  doesn't have yet, reusing C2's indexMessage, keeping its place in Durable
  Object storage, and taking Gmail metadata from meta/ JSON when the Worker
  fetched the message and from headers alone when the laptop did. humain's
  714 messages should finish in one run. Needs C1 and C2 merged.
publish: true
type: Plans
---

# Plan C3 — The Worker Backfills the Index From R2

Spec: [[Attachments-as-First-Class-Mail]], *Cloud*, step C3. Needs
[[Plan-C1-D1-Cloud-Index]] and [[Plan-C2-Worker-Indexes-New-Mail]] merged.

## Goal

Everything already in R2 gets into D1 without the laptop:
- humain's 714 messages, pushed from the laptop on 2026-11-26;
- the ~1,570 Gmail messages the Worker fetched before C2 existed;
- later, the two large archives.

## Read first

- C2's `src/indexer.ts` and its tests.
- `src/sync.ts` (`store()` shows the R2 layout: `raw/<account>/<sha[:2]>/<sha>.eml`
  and `meta/<account>/<encodeURIComponent(mailbox)>/<uidvalidity>/<uid>.json`,
  whose JSON includes `sha256`, `uid`, `gmailLabels`, `gmailThreadId`,
  `internalDate`, `flags`).
- `src/index.ts` (`MailboxSync`, Durable Object storage).
- The R2 blueprint `context-v/blueprints/Mail-Archive-in-Cloudflare-R2.md`
  (bucket layout table).

## Build

1. **Extend the `Bucket` interface** with `list({ prefix, cursor, limit })`
   returning keys and a continuation cursor (R2's `list()` shape), and
   `get(key)` returning bytes (`arrayBuffer()`), not only text. Update the
   in-memory test bucket.
2. **`src/backfill.ts`: `backfillIndex(account, bucket, db, state, budget)`.**
   - `state` is `{ cursor?: string, done?: boolean, metaIndexed?: boolean }`,
     kept in Durable Object storage under `backfill`.
   - First, once per account: list `meta/<account>/`. For each JSON with a
     `sha256`, keep `sha → {mailbox, uidvalidity, uid, labels, threadId,
     internalDate, flags}` in D1, in a small table added by a new migration
     `0002_backfill_meta.sql` (`r2_meta (account, sha256, ...)`, primary key
     `(account, sha256)`). Then set `metaIndexed`. (Listing every meta file
     each run would be slow for Gmail.)
   - Then walk `raw/<account>/` from `cursor`. For each key: skip if D1 has a
     `messages` row for `(account, sha256)`. Otherwise get the bytes and call
     `indexMessage` with metadata from `r2_meta` when present, else nulls
     (mailbox, uid and uidvalidity stay NULL, as C1 allows).
   - Stop after `budget` messages indexed (default 500) or when the listing
     ends (`done: true`). Save the cursor after every page, so a killed run
     resumes cleanly.
   - Run `refresh_noise`'s equivalent once at the end.
3. **Wire it in.** In `MailboxSync.#run`, after `syncAccount`, if `INDEX` is
   bound and the backfill isn't done, run `backfillIndex`. Add `backfill:
   {indexed, done, lastError}` to `status.json`. A backfill error never fails
   the sync.
4. **CPU and time.** Measure with a test over the fixture set how long
   parsing takes per message. If 500 messages could exceed a Durable Object's
   default CPU limit, add `"limits": { "cpu_ms": 300000 }` to `wrangler.jsonc`
   (paid plan) and say so, or lower the default budget. Report the numbers
   either way.
5. **Tests** (`test/backfill.test.ts`, node:sqlite Db, in-memory bucket):
   - 30 fixture messages in `raw/`, 10 with `meta/` JSON. One call with budget
     12 indexes 12, a second continues, a third finishes, with no duplicates.
     The 10 with meta have uid, labels and thread id; the rest have NULLs.
   - A message already indexed by C2's live path is skipped.
   - A corrupt `.eml` is recorded as `error` and the walk continues.
   - A thrown error mid-page leaves a cursor that resumes without gaps.

## Rules for whoever builds this

- Branch `cloud-c3-backfill` off `development` (after C2 is merged). Commit
  with the repo's conventions, ending with the `Co-Authored-By` line. Don't
  push, don't merge.
- **Never touch Cloudflare**: no deploy, no `--remote`. Tests run locally.
- Never read, print, or copy secrets. Never log subjects, bodies or filenames.
- Don't write to `raw/`. The backfill only reads R2 and writes D1 and Durable
  Object storage.
- No new dependencies.

## Done when

- `pnpm test` and the pinned `tsc --noEmit` pass in `sync-worker/`; the Python
  suite still passes.
- A local dry run: copy humain's 714 `.eml` files into a temp folder, point
  the in-memory bucket at it, run `backfillIndex` with budget 1000 against a
  node:sqlite D1 stand-in, and compare the counts by kind with
  `python3 mail/kaymail.py attachments --backfill --account michael@humain.vc`'s
  report. Report the time it took.

## Hand back

Branch and commits, test summary, the dry-run comparison and timing, and
whether `cpu_ms` needs raising. The parent session applies migration 0002
remotely, deploys, and after the next scheduled run checks `status.json` and
D1 counts for humain against the laptop (714 plus new arrivals).
