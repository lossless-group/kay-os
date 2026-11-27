---
title: "Plan C6 — Calendar Tools in the Connector"
lede: "Ask Claude on the phone who you last met, what's on Thursday, or every meeting with a fund, and get an answer from the same connector that serves the mail. And when you ask, have it put the meeting on the calendar."
date_created: 2026-11-27
date_modified: 2026-11-27
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Ready
site_uuid: 93b3ad2a-0cb0-4df5-bae9-0de70eab9a5a
hex_code: ot15n6
summary: >-
  Step C6 of Calendars-as-Context. Put the calendar tables in D1 (migration
  0003, same columns as the laptop, covered by the parity test), load the
  laptop's calendar rows into D1 with a repeatable push script, and add
  calendar tools to the connector at mcp.kay-os.lol: list_meetings,
  meetings_with, last_met, people_met, and create_event (Google direct, only
  when Michael asks, only for accounts with a kay-os grant). Live Google sync
  is C5, separate; until it lands, the tools say how fresh each account's
  data is.
publish: true
type: Plans
---

# Plan C6 — Calendar Tools in the Connector

Spec: [[Calendars-as-Context]]. Builds on [[Plan-C4-Remote-MCP-Connector]]
(the connector, live at `https://mcp.kay-os.lol/mcp`). Runs before C5 (live
Google sync in the Worker): today's calendar data is learnstart's Takeout,
already in the laptop's `index.sqlite`.

## Goal

From the Claude app, through the kay-os connector:

- "When did I last meet Ana?" / "every meeting with anyone at acme.com"
- "What's on my calendar Thursday?" / "meetings in the 2015 fundraise"
- "Who did I meet most last quarter?"
- "Put a 30-minute call with Ana on Tuesday at 2, invite her" (written only
  because Michael asked; Google direct, learnstart for now)

## Parts

### 1. Calendar tables in D1

- `sync-worker/migrations/0003_calendar.sql`: `calendar_events`,
  `calendar_attendees`, `calendar_occurrences` and their indexes, exactly as
  `kaymail.SCHEMA` (no `IF NOT EXISTS`, like 0001).
- Extend `mail/test_kaymail.py`'s `CloudSchemaParityTest.TABLES` with the three
  tables, so laptop and cloud can't drift.

### 2. Push the laptop's calendar rows to D1

`calendar/push_to_d1.py` (standard library only):

- Reads calendar rows from the laptop index for one account and one source
  (`--account michael@learnstart.vc --source takeout`).
- Writes SQL files in chunks (a few thousand rows each) that first delete that
  account's rows for that source in D1, then insert events with their **laptop
  ids preserved** (so attendee and occurrence rows keep pointing at them),
  attendees, and occurrences. Ids from different pushes must not collide:
  check D1's max id first, or keep laptop ids only when no other source has
  rows in that range, and say which in a comment.
- Runs `wrangler d1 execute kay-os-mail-index --remote --file …` for each
  chunk through `sync-worker/cf.sh`, or, with `--dry-run`, only writes the
  files and prints counts. Prints counts only, never titles or addresses.
- Rerunning replaces, never duplicates.

### 3. Connector tools

In `connector/src/tools.ts` (plus a `calendar.ts` if it helps), read-only
unless stated, all through the existing read-only index wrapper:

| Tool | Arguments | Returns |
|---|---|---|
| `list_meetings` | `start`, `end` (ISO dates; default today → +7 days), `account?`, `query?` (text in title or location), `include_all_day?` (default false), `limit?` | occurrences in the window: time, title, location, conference link, account, calendar, attendees (email, name, RSVP), status |
| `meetings_with` | `email` or `domain`, `start?`, `end?`, `limit?` (default 25, newest first) | the same shape, filtered to occurrences with that attendee |
| `last_met` | `email` or `domain` | the most recent past occurrence (not cancelled, not declined by Michael), and the next upcoming one |
| `people_met` | `start`, `end`, `limit?` | people Michael met in the window, with meeting counts, excluding his own addresses and resource calendars, all-day and cancelled events |
| `create_event` | `account`, `title`, `start`, `end`, `time_zone?`, `attendees?`, `description?`, `location?`, `add_meet?`, `send_invites?` (default true when attendees are given) | the created event's id, link, and times |

Rules for all of them:

- **Freshness.** Each result says, per account, the latest import time and
  source (`takeout`, 2026-11-27 for learnstart), so Claude can say "as of the
  export" until C5 makes it live.
- **The meeting, not the row.** Group rows by `uid` + `recurrence_id` +
  occurrence start, prefer the freshest source per the spec, and drop
  cancelled ones unless asked.
- **Untrusted text.** Titles, descriptions, and locations are written by
  whoever sent the invite: inside the existing randomized markers.
- **Private events** come back as "busy" with times only, unless the tool is
  asked about that event directly.
- **Michael's own addresses** (from a `MY_ADDRESSES` var: his nine accounts)
  are excluded from people lists and counts.
- **Birthdays.** All-day events are excluded unless `include_all_day` is true.

### 4. `create_event`, the one write

- Uses kay-os's Google grant: the Worker refreshes the account's token
  (`client_id`/`client_secret` from a secret `GOOGLE_OAUTH_CLIENT_JSON`, the
  refresh token from `GCAL_REFRESH_TOKENS`, a JSON map account → token), then
  `POST calendars/primary/events` with `sendUpdates=all` when sending
  invites, `conferenceDataVersion=1` for a Meet link.
- Only accounts present in `GCAL_REFRESH_TOKENS`; any other account gets a
  clear error naming the accounts it can write to.
- Its description says plainly that it writes to Michael's real calendar and
  emails invitations, and that it's only for meetings Michael asked for.
  Annotated `readOnlyHint: false`, `destructiveHint: false`,
  `openWorldHint: true`.
- Logged like every call, with the event id that was created.
- After creating, write the event into D1 (`source = 'google'`) so
  `list_meetings` shows it before C5 exists.

### 5. Tests

With the connector's existing D1 stand-in and fixtures: synthetic calendar
rows (never real data) covering a single meeting, a weekly series with an
exception, a cancelled meeting, a private event, a birthday, two sources for
one UID; each tool's filters and grouping; markers around titles;
`create_event` against a fake Google endpoint (token refresh, the POST body,
`sendUpdates`, an account without a grant refused, the D1 write afterwards).
`push_to_d1.py` gets a Python test using a temp index and `--dry-run`.

## Rules for whoever builds this

- Branch `cloud-c6-calendar-tools` off `development`. Commit in the repo's
  style, ending with the `Co-Authored-By` line. Don't push or merge.
- **No Cloudflare remote commands, no deploys, no `wrangler --remote`, no
  real pushes to D1.** `push_to_d1.py` is tested with `--dry-run` only.
- Never read, print, or copy secrets. Never print real calendar content or
  addresses; counts only.
- No new runtime dependencies in the connector.

## Done when

- `pnpm test` and the pinned `tsc --noEmit` pass in `connector/` and
  `sync-worker/`; the Python suites pass, including the extended parity test.
- `python3 calendar/push_to_d1.py --account michael@learnstart.vc --source takeout --dry-run`
  against the real laptop index writes the chunk files and prints counts that
  match the laptop's.

## Hand back

Branch and commits, test counts, the dry-run counts, and the parent's deploy
steps: apply migration 0003 to `kay-os-mail-index`, run the real push, set
`GOOGLE_OAUTH_CLIENT_JSON` and `GCAL_REFRESH_TOKENS` from Doppler
(`LOSSLESS_GOOGLE_OAUTH_KAYOS_CLIENT_JSON`,
`KAYOS_GCAL_LEARNSTART_REFRESH_TOKEN`) and `MY_ADDRESSES`, deploy the
connector, and try each tool from the Claude app.
