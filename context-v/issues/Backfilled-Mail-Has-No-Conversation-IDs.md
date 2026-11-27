---
title: "Backfilled Mail Has No Conversation IDs"
lede: "Only 221 of about 42,700 indexed messages carry a conversation ID: the ones the Worker synced itself. The backfill indexed everything else before reading the metadata that holds the ID, and never goes back."
date_created: 2026-11-27
date_modified: 2026-11-27
date_authored_initial_draft: 2026-11-27
date_authored_current_draft: 2026-11-27
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Open
site_uuid: 526f026b-662f-4c2d-8d64-ad124acc0d7e
hex_code: rytw4u
summary: >-
  Claude, using the connector for the first time, reported that the
  humain.vc and mandatory.ventures accounts had no conversation IDs, so
  read_message returned no thread. Checking D1 showed it is nearly every
  account: 220 of 41,249 Gmail messages, 1 of 714 humain.vc, 0 of 714
  mandatory.ventures. Every message the Worker synced live has one. Every
  message the C3 backfill indexed from R2 before its meta file was read has
  none, and INSERT-or-skip means it is never revisited.
tags:
  - Issue
  - Threading
  - Backfill
  - D1
  - Connector
type: Issues
---

# Backfilled Mail Has No Conversation IDs

Related: [[Backfill-Runs-Ended-Before-Writing-Status]], [[Plan-C3-Backfill-Index-From-R2]].

## What we saw

Claude, in its first session with the connector (2026-11-27), said messages on
the work accounts had no conversation ID, and `read_message` came back with an
empty `thread`, so a back-and-forth can't be followed. It saw IDs only on
Gmail.

The index says the problem is wider than that. Primary messages in D1:

| Account | Messages | With `thread_id` | Synced live by the Worker | Live with `thread_id` |
|---|---|---|---|---|
| Gmail | 41,249 | 220 | 221 | 221 |
| humain.vc | 714 | 1 | 1 | 1 |
| mandatory.ventures | 714 | 0 | 0 | 0 |

So it isn't about Workspace against Gmail. **Mail the Worker synced itself always
has a conversation ID; mail the backfill indexed from R2 almost never does.**

## Why

- The live path asks for `X-GM-THRID` whenever the server advertises
  `X-GM-EXT-1` (`sync-worker/src/imap.ts`, `isGmail`), which Workspace accounts
  do, and stores it on the row.
- The backfill (`sync-worker/src/backfill.ts`) takes `thread_id` from the
  account's `r2_meta` row for that message. `r2_meta` is filled by reading the
  `meta/` files a page at a time (`metaBudget`), so a large account's metadata
  arrives over many runs.
- Indexing doesn't wait for it. A message indexed before its meta row exists
  gets `threadId: null`. Later runs find the message already indexed
  (`outcome.status === "exists"`) and skip it, so the ID that arrives later is
  never written.

`r2_meta` agrees: the 1,218 Gmail rows read so far all have a `thread_id`. The
data exists; it just landed after the messages were indexed.

## Fix

1. **Backfill the column once.** Write `thread_id` onto existing rows from
   `r2_meta` where the row has none (matched by account and sha256). One UPDATE
   per account, run after the meta read finishes.
2. **Stop it recurring.** Either hold indexing for an account until its meta
   read is done, or have the meta read update `messages.thread_id` for rows that
   already exist. The second is simpler and survives any ordering.
3. **Check the meta files exist for the work accounts.** humain.vc has 1 meta
   row and mandatory.ventures has none. If the laptop never wrote meta files
   for them, step 1 can't help, and those accounts need either a one-off
   `X-GM-THRID` fetch by UID or the fallback below.
4. **Fallback threading for mail without an ID.** Group by `References` and
   `In-Reply-To` (both already in the stored message), with normalized-subject
   matching as a last resort. This also covers any future non-Google account.

## How we'll know

- The D1 table above shows `thread_id` on nearly every row for every account.
- `read_message` on a work-account reply lists the rest of its conversation.
