---
title: "Plan C1 — A D1 Index With the Laptop's Tables"
lede: "Give the sync Worker a database: the same messages and attachments tables the laptop has, in Cloudflare D1, ready for the Worker to fill."
date_created: 2026-11-26
date_modified: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Ready
site_uuid: 4e522200-8f3f-4e39-a94f-89d7f673cb65
hex_code: khygio
summary: >-
  Step C1 of the cloud index in Attachments-as-First-Class-Mail. Write D1
  migration 0001 with the laptop's messages, messages_fts, attachments,
  message_attachments, and attachment_scans tables (two documented
  differences), bind the database to the sync Worker as INDEX, add a small Db
  interface with a node:sqlite adapter for tests, and a Python test that keeps
  the two schemas in step. The parent session creates the database and
  applies the migration on Cloudflare; the builder works locally only.
publish: true
type: Plans
---

# Plan C1 — A D1 Index With the Laptop's Tables

Spec: [[Attachments-as-First-Class-Mail]], section *Cloud: the same index on
Cloudflare*, step C1. Next: [[Plan-C2-Worker-Indexes-New-Mail]].

## Goal

The sync Worker (`sync-worker/`) gets a D1 database bound as `INDEX`, with the
same tables as the laptop's `index.sqlite`, created by a migration file. Nothing
writes to it yet; that's C2.

## Before handing off (parent session)

1. Create the database and check that D1 runs FTS5:

   ```bash
   cd sync-worker
   ./cf.sh d1 create kay-os-mail-index        # note the database_id it prints
   ./cf.sh d1 execute kay-os-mail-index --remote \
     --command "CREATE VIRTUAL TABLE fts_probe USING fts5(x); DROP TABLE fts_probe;"
   ```

2. Give the builder the `database_id`. If the FTS5 probe fails, stop: the spec
   needs a different keyword-search plan before C1 goes ahead.

## Read first

- `mail/kaymail.py`: `SCHEMA` (the source of truth for table shapes).
- `sync-worker/wrangler.jsonc`, `src/index.ts`, `src/sync.ts`,
  `test/sync.test.ts` (the `memoryBucket` pattern: small interfaces, in-memory
  fakes, no Cloudflare in tests).
- `sync-worker/src/cloudflare-workers.d.ts` (hand-written runtime types; extend
  it rather than adding `@cloudflare/workers-types`).

## Build

1. **`sync-worker/migrations/0001_index.sql`.** The five tables and their
   indexes, copied from `kaymail.SCHEMA`, with exactly two differences, each
   commented in the file:
   - `messages.uidvalidity`, `messages.uid` and `messages.mailbox` may be NULL.
     Mail the laptop fetched has no Gmail UID in R2, and C3 indexes it from
     headers alone. Uniqueness for those rows comes from `(account, sha256)`,
     checked by the code.
   - A comment that `messages.body` holds at most 20,000 characters (enforced
     by the writer in C2, not by SQL).
2. **`wrangler.jsonc`.** Add `"d1_databases": [{ "binding": "INDEX",
   "database_name": "kay-os-mail-index", "database_id": "<from parent>",
   "migrations_dir": "migrations" }]`. Add `INDEX` to `Env` in `src/index.ts`,
   unused for now.
3. **`src/db.ts`.** A minimal `Db` interface matching the D1 calls C2 and C3
   need (`prepare(sql).bind(...).run()/first()/all()` and `batch([...])`), plus
   the D1 type declarations in `cloudflare-workers.d.ts`.
4. **`test/sqlite-db.ts`.** A `Db` built on `node:sqlite` (Node 24 has it), that
   applies every file in `migrations/` in order. C2 and C3 tests use it.
5. **`test/db.test.ts`.** Applies the migrations to an in-memory database;
   inserts a message, an FTS row, an attachment, and a link; runs an FTS5
   `MATCH`; runs a `batch` and checks it's atomic (a failing statement rolls back
   the others).
6. **Schema parity test, in Python** (`mail/test_kaymail.py`): load
   `sync-worker/migrations/*.sql` into an in-memory SQLite and compare
   `PRAGMA table_info` for the five tables against a database built from
   `kaymail.SCHEMA`. Columns and types must match; only the documented nullable
   columns may differ. This is what stops the two indexes drifting.

## Rules for whoever builds this

- Work on a branch `cloud-c1-d1-index` off `development` in `ai-labs/kay-os`.
  Commit with the repo's conventions (see `git log`), ending with the
  `Co-Authored-By` line. Don't push, don't merge.
- **Never touch Cloudflare**: no `cf.sh deploy`, no `--remote`, no `d1 create`.
  The parent session does every remote step.
- Never read, print, or copy secrets (`.env`, Doppler, `accounts.toml`).
- No new npm dependencies in this step.
- `kaymail.py` behaviour must not change. If the schema parity test exposes a
  real mismatch, report it instead of editing `SCHEMA`.

## Done when

- `cd sync-worker && pnpm test` passes, including `db.test.ts`.
- `npx -y -p typescript@5.9.3 tsc --noEmit` passes in `sync-worker/`.
- `python3 -m unittest mail/test_kaymail.py mail/test_kaymcp.py` passes,
  including the parity test.
- `./cf.sh d1 migrations apply kay-os-mail-index --local` works (local only).

## Hand back

The branch name and commit, the test output summary, and anything in
`kaymail.SCHEMA` that didn't translate cleanly. Then the parent session applies
the migration remotely (`./cf.sh d1 migrations apply kay-os-mail-index
--remote`), checks `SELECT name FROM sqlite_master`, and merges.
