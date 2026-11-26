---
title: "Database Setup for Email — Raw Files, One SQLite Index, and a Copy in R2"
lede: "The kay-os mail archive has no database server. It's a folder of original emails, one SQLite file that makes them searchable, and a copy of both in Cloudflare R2."
date_created: 2026-11-24
date_modified: 2026-11-24
date_authored_initial_draft: 2026-11-24
date_authored_current_draft: 2026-11-24
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
site_uuid: fef9e2a4-4b17-4ae3-808e-8624efafa92f
hex_code: wozmjo
summary: >-
  A mirror of how kay-os stores mail as of 2026-11-24. Original .eml files,
  named by SHA-256, are the source of truth and already hold every attachment.
  A single SQLite file (WAL mode, Python's built-in sqlite3) indexes them: a
  messages table plus an FTS5 full-text table, read by search, show and the MCP
  server. Cloudflare R2 holds a copy of the raw files and index snapshots, plus
  per-message JSON from the Worker. The planned attachments table goes into the
  same SQLite file. The open question is how the phone and the Worker can query
  the archive, since SQLite only works where the file is.
tags:
  - Mirror
  - Mail
  - SQLite
  - Cloudflare-R2
  - Attachments
type: Mirrors
---

# Database Setup for Email

kay-os keeps a copy of every email in every connected mailbox so agents can
search and read it without touching Gmail. It doesn't run a database server.
The archive is three layers: the original emails as files, one SQLite file that
makes them searchable, and a copy of both in Cloudflare R2. This page records
how those layers are set up today.

## The three layers

| Layer | What it is | Where |
|---|---|---|
| **Raw mail** | Each original `.eml`, named by its SHA-256 hash and never rewritten. This is the source of truth, and the attachments are inside these files. | `~/.local/share/kay-os/mail/raw/<account>/<sha[:2]>/<sha>.eml` (73 GB) |
| **Index** | One SQLite file (3 GB) opened in WAL mode through Python's built-in `sqlite3`. It has a `messages` table (headers, labels, thread id, body text, the attachment filenames as one string) and an FTS5 full-text table over it. Search, `show`, and the MCP server all read from it. | `~/.local/share/kay-os/mail/index.sqlite` |
| **Cloud copy** | Cloudflare R2. `mail/r2.sh` pushes the raw files and a snapshot of `index.sqlite`. The Worker adds new mail as raw files plus small per-message JSON files under `meta/`. R2 is file storage, not a database. | bucket `kay-os-mail` |

As of 2026-11-24 the laptop archive holds 439,135 messages across two accounts
(210,843 in `michael@learnstart.vc`, 228,292 in `mpstaton@gmail.com`), each with
its `.eml` on disk.

## Where attachments fit

Sync fetches `BODY.PEEK[]`, the whole MIME message, so every attachment has
already been downloaded inside its `.eml`. About 40,000 messages have named
attachments. Today the index keeps only their filenames, joined into a single
string. There is no way to look up an attachment's type, size, or bytes.

The planned fix is an `attachments` table in the same `index.sqlite`, next to
`messages`, with one row per MIME part. Questions like "attachments for message
1234" or "every PDF from acme" then become ordinary SQL joins. Search inside
attachment text, if we add it, would be another FTS5 table in the same file.

## The limit: SQLite only works where the file is

The phone and the Cloudflare Worker can't query `index.sqlite`. That's why the
[[2026-11-22_01|2026-11-22 changelog]] says a version reachable from the phone
waits on making the R2 copy searchable. The explorations mention Cloudflare-side
options (D1, which is hosted SQLite, and the Artifacts idea in
[[Using-Cloudflare-Artifacts-as-Knowledge-Graph]]). Nothing has been chosen,
and the attachments work doesn't depend on that choice.

## See also

- [[Mail-Archive-in-Cloudflare-R2]]: bucket layout, the Worker, and setting up another computer
- [[Email-Repository-and-Agent-Harness]]: where the archive is headed
- `mail/kaymail.py`: the schema (`SCHEMA`) and how messages are parsed and stored
