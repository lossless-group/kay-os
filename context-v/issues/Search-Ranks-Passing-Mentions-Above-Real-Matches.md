---
title: "Search Ranks Passing Mentions Above Real Matches"
lede: "A two-word search returned one email about the subject and three that mentioned it in passing. Search does require every word; it sorts newest first and shows one excerpt, so the real match was buried and the others looked wrong."
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
site_uuid: b921a379-1ce9-4911-b9d2-cfa012d24bb4
hex_code: iiqai6
summary: >-
  Claude reported that multi-word searches match any of the words rather than
  all of them. They don't: FTS5 treats space-separated terms as AND, and all
  four results contained both words (checked in D1). The real problems are
  that search_mail sorts by date unless relevance is asked for, and its snippet
  shows one excerpt from the body, so a result that mentions the second word
  far down looks like it only matched the first.
tags:
  - Issue
  - Search
  - FTS5
  - Connector
type: Issues
---

# Search Ranks Passing Mentions Above Real Matches

## What we saw

Claude searched a deal name plus a vehicle type (two words). Only the first
result was about the deal; the other three seemed to mention only the vehicle
type. Claude concluded that search matches **any** of the words and suggested
quoting the phrase or adding `AND`.

## What's actually happening

The conclusion is wrong; the complaint is right.

- **Search already requires every word.** In SQLite FTS5, space-separated terms
  are an implicit AND. For the newest four results, D1 shows both words present
  in each: the deal name in the subject and body of the first, and in the body
  of the other three.
- **It sorts newest first.** `search_mail` orders by `m.date DESC` unless the
  caller passes `relevance: true` (`connector/src/tools.ts`). The one email
  *about* the deal, with the name in its subject, ranks no higher than three
  that mention it once in a long body.
- **The excerpt hides the match.** `snippet(messages_fts, 3, …)` returns one
  window from the body. When the second word is far from the first, or in the
  subject, the excerpt shows only one of them, and the result looks like a
  false match.

## Fix

1. **Default to relevance for keyword searches,** with date as the tie-breaker.
   Keep newest-first when there's no query, and as an explicit option.
2. **Weight the fields.** `bm25(messages_fts, 10.0, 3.0, 1.0, 1.0, 2.0)` (subject,
   from, to, body, attachments) so a word in the subject outranks the same word
   in a quoted reply.
3. **Show why it matched.** Return which fields matched, or a subject snippet
   alongside the body one, so a reader (or Claude) can see the second word.
4. **Say how queries work in the tool description:** words are ANDed, `OR` and
   quotes are available. Claude reached for workarounds because the description
   didn't say.

## How we'll know

The same two-word search puts the email about the deal first, and every
result's excerpt shows both words or names the field the other one is in.

## Resolved (2026-11-27)

- **Relevance by default** for keyword searches: `ORDER BY bm25(messages_fts,
  10, 3, 1, 1, 2), date DESC` (subject, from, to, body, attachments), so a word
  in the subject counts ten times one in the body. `relevance: false` sorts
  newest first.
- **Why it matched:** results carry `subject_match`, a subject excerpt, beside
  the body `snippet`.
- **The tool description says how queries work:** words are ANDed; `OR`,
  quotes, prefixes, and `subject:` are available.
- Test: "a keyword search ranks the email about it above newer ones that
  mention it in passing". The laptop's `kaymail.py search` keeps its old
  ordering for now.
