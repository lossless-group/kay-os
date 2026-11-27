---
title: "Plan C2 — The Worker Indexes Each Message as It Stores It"
lede: "Every email the sync Worker saves to R2 also lands in the D1 index, with its attachments sorted the same way the laptop sorts them."
date_created: 2026-11-26
date_modified: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Ready
site_uuid: 7dce0242-360e-4530-bd03-66242450efde
hex_code: bye74s
summary: >-
  Step C2 of the cloud index. Add postal-mime (pinned), write
  sync-worker/src/indexer.ts to turn one stored .eml into a messages row, an
  FTS row, and attachment rows in a single D1 batch, port Phase 1's sniffing,
  kind, and noise rules from kaymail.py, and share their test cases with the
  Python suite through one JSON file. Wire it into the sync so an indexing
  failure is recorded and never stops a sync. Needs C1 merged.
publish: true
type: Plans
---

# Plan C2 — The Worker Indexes Each Message as It Stores It

Spec: [[Attachments-as-First-Class-Mail]], *Cloud*, step C2. Needs
[[Plan-C1-D1-Cloud-Index]] merged. Next: [[Plan-C3-Backfill-Index-From-R2]].

## Goal

When `syncAccount` stores a message in R2, it also writes to D1: the
`messages` row, the `messages_fts` row, and the message's attachments
(`attachments`, `message_attachments`, `attachment_scans`). The result for a
given email matches what `kaymail.py` writes on the laptop, apart from the
documented differences.

## Read first

- `mail/kaymail.py`: `parse_message`, `record_message`, and the attachment
  functions (`sniff_type`, `attachment_kind`, `attachment_parts`,
  `record_attachments`, `refresh_noise`) and their constants (`MAGIC`, `KINDS`,
  `NOISE_*`). This is the behaviour to match.
- `mail/test_kaymail.py`: `deck_message()` and the attachment tests.
- `sync-worker/src/sync.ts` (`store`, `syncAccount`), `src/imap.ts`
  (`FetchedMessage`), `src/db.ts` and `test/sqlite-db.ts` from C1.
- The spec's *Phase 1* and *Cloud* sections.

## Build

1. **Dependency.** `pnpm add -E postal-mime@<latest 2.x>` in `sync-worker/`.
   Check its licence (MIT expected) and that it needs no Node built-ins.
   Nothing else.
2. **Shared rule cases: `mail/testdata/attachment_rules.json`.** A list of cases:
   `{first_bytes_hex, declared_type, filename, size, disposition, content_id}`
   → `{content_type, kind, is_noise}`. Cover each `MAGIC` signature, a
   docx/xlsx declared over a zip signature, `application/octet-stream` with
   and without a known extension, calendar by type and by `.ics`, a small
   image, an inline 30 KB image, an inline 300 KB screenshot, and an attached
   1 MB photo. Generate the expected values **by running the Python
   functions**, and add a Python test that checks them. The TypeScript test
   must then pass the same file unchanged.
3. **`src/rules.ts`.** `sniffType`, `attachmentKind`, `isNoise`, the constants,
   ported line for line from Python, with a comment pointing at the Python
   original.
4. **`src/indexer.ts`.** `indexMessage(db, input)`, where `input` has
   `account, mailbox, uidvalidity, uid, sha256, raw, internalDate, flags,
   labels, threadId` (the last six may be null):
   - Parse with `PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" })`.
   - `messages` row: headers as on the laptop (`to_addr` is To and Cc joined),
     body as plain text (HTML turned to text when there's no plain part), cut
     to 20,000 characters. `is_primary` is 1 unless a row with the same
     `(account, sha256)` exists. Date from `internalDate`, else the `Date`
     header, in UTC ISO 8601 like `to_utc`.
   - FTS row only for primary messages, as on the laptop.
   - Attachments: `postal-mime`'s list, plus any calendar part it exposes
     separately. `part_index` is the position in that list, documented in a
     comment: it only has to be stable for the same bytes and the same parser
     version. Hash the decoded bytes (SHA-256), upsert `attachments` with the
     same `ON CONFLICT` rule as Python (noise is sticky, `first_seen` takes the
     earliest), and link it.
   - Everything for one message goes in **one `db.batch()`**. Afterwards, the
     repeated-image noise rule (`refresh_noise`) runs once per sync pass, not
     per message.
   - On any failure: write `attachment_scans (message_id, 'error')` if the
     message row exists, log one line with the account and sha (never a
     subject or body), and return. Never throw to the caller.
5. **Wire it in.** `syncAccount(account, transport, bucket, prior, limit,
   index?)`: when `index` is given, call `indexMessage` after the R2 put in
   `store()`. Messages whose `raw` is null (over 48 MB) get no index row, as
   now. `src/index.ts` passes `this.env.INDEX`.
6. **Tests** (`test/indexer.test.ts`, with C1's `node:sqlite` Db and the
   existing `fakeGmail`):
   - The deck message (port `deck_message()` to a fixture `.eml` under
     `test/fixtures/`, generated once by the Python helper) yields 4
     attachment parts, document and calendar listed, logo noise.
   - The same bytes twice: one primary message, one attachment row.
   - A malformed message: the sync still completes, R2 has the `.eml`, and
     `attachment_scans` says `error`.
   - Rule cases from the shared JSON all pass.

## Rules for whoever builds this

- Branch `cloud-c2-indexer` off `development` (after C1 is merged). Commit with
  the repo's conventions, ending with the `Co-Authored-By` line. Don't push,
  don't merge.
- **Never touch Cloudflare**: no deploy, no `--remote`. Tests run locally.
- Never read, print, or copy secrets.
- Email content is untrusted: never log subjects, bodies, or filenames.
- Sync stays read-only. Don't change `imap.ts` except to fix a bug you can
  show with a test, and report it.
- One dependency (`postal-mime`). If you think you need another, stop and say
  why.

## Done when

- `pnpm test` and the pinned `tsc --noEmit` pass in `sync-worker/`.
- The Python suite passes, including the shared-rules test.
- Hand-check: index `test/fixtures/deck.eml` both ways (Python `record_attachments`
  into a temp `index.sqlite`, TypeScript into a temp D1 stand-in) and compare
  the `(sha256, kind, is_noise, filename)` sets. Report any difference and why.

## Hand back

Branch and commits, test summary, the `postal-mime` version and licence, and
the hand-check comparison. The parent session deploys and watches the next
scheduled run (`./cf.sh tail`), then checks D1:
`SELECT count(*) FROM messages WHERE account='michael@humain.vc'`.
