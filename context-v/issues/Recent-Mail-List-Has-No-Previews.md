---
title: "The Recent Mail List Has No Previews"
lede: "Asking for the latest mail returns senders and subjects with an empty preview. Previews only appear when there's a keyword to search for."
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
site_uuid: 437aeb8e-1ed8-4406-9159-9c118010830b
hex_code: sot3rw
summary: >-
  search_mail with no query lists recent mail with snippet hard-coded to an
  empty string, because the preview comes from FTS5's snippet(), which only
  exists for a MATCH. So "what came in today" can't be skimmed without opening
  each message. A short preview from the start of the body fixes it.
tags:
  - Issue
  - Connector
  - Search
type: Issues
---

# The Recent Mail List Has No Previews

## What we saw

Claude noted that listing the latest mail shows no preview text; previews only
appear when searching with keywords. To know what a recent message says, it has
to call `read_message` on each one.

## Why

In `connector/src/tools.ts`, `search_mail` has two queries. With a keyword, the
preview is FTS5's `snippet(...)`, which only works inside a `MATCH`. Without
one, the query selects `'' AS snippet`, an empty string by design. The same is
true of `kaymail.py`'s `search` on the laptop.

## Fix

Without a query, return the first ~160 characters of the body as the preview:
`substr(m.body, 1, 160)`, with whitespace collapsed and quoted reply text
(lines starting `>`, and "On … wrote:" blocks) stripped where that's cheap.
Keep it inside the same untrusted-data markers as other mail content, since
it's text a stranger wrote.

If reading `body` for 25–200 rows is slow on D1, store a short `preview`
column at index time instead.

## How we'll know

`search_mail` with no query returns a non-empty preview for every message with
a text body.
