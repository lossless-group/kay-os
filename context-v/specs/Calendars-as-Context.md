---
title: "Calendars as Context — Every Meeting, Every Account, One Table"
lede: "Who did I meet, when, about what, and what came of it? kay-os answers that by putting every meeting from every calendar next to the mail, in one table of events and one of the people in them."
date_created: 2026-11-27
date_modified: 2026-11-27
date_authored_initial_draft: 2026-11-27
date_authored_current_draft: 2026-11-27
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.1.0
status: Implementing
site_uuid: 3741b9b8-84ae-4a62-8ca2-5a42e53d27c7
hex_code: j7tr7d
summary: >-
  Spec for calendars in kay-os. Four sources feed one schema: Google Takeout
  exports (history, first import: learnstart's ~9,200 events back to 2013),
  kay-os's own Google Calendar access (refresh tokens from
  calendar/gcal_grant.py, synced by the Worker with sync tokens), Vimcal's MCP
  (eight accounts kay-os has no direct grant for), and the invites already in
  the mail archive. Tables: calendar_events (one row per event per calendar
  per source), calendar_attendees, and calendar_occurrences (recurring series
  expanded into dated instances). The same event seen through several sources
  is one meeting, grouped by iCalendar UID. Reading is free; creating events
  and sending invites happens when Michael asks, per AGENTS.md. Laptop
  index.sqlite first, then D1 with the same tables.
tags:
  - Spec
  - Calendar
  - Google-Calendar
  - Vimcal
  - Takeout
  - iCalendar
  - Context
publish: true
type: Specs
---

# Calendars as Context

## Why

Mail says what people wrote. Calendars say who Michael actually spent time
with, how often, and when last. Together they answer the questions an agent
gets asked every day: "when did I last meet Ana?", "who did I meet most in the
2015 fundraise?", "what's on tomorrow, and what did each of these people last
email me?", "who was on the Neuralink allocation call?".

Today those meetings are spread over nine Google accounts and a dozen
calendars. This spec puts them in one place, next to the mail, with the people
in each meeting as rows an agent can join on.

## Sources

| Source | Covers | How it arrives | Status |
|---|---|---|---|
| **Google Takeout** | Everything an account ever had, every calendar, up to the export date | A `.zip` of `.ics` files, imported once | learnstart exported 2026-11-27: 13 calendars, ~9,200 events (2013–2026), 6,387 attendee addresses. Stored at `~/.local/share/kay-os/calendar/michael@learnstart.vc/takeout/2026-11-27/` and in R2 under `calendar/` |
| **Google direct** | Live, every calendar on the account, read and write | `calendar/gcal_grant.py` refresh tokens in Doppler; the Worker syncs with Google sync tokens | learnstart granted 2026-11-27; others on request |
| **Vimcal** | Live, eight accounts (mandatory, humain, gmail, lossless, avalanche, hypernova, colearn, the-water-foundation) | Vimcal MCP: `list_events` in 31-day windows, read; `create_event` etc. to write | Connected in Claude and kay-os sessions |
| **Mail invites** | Meetings someone emailed an invite for, any account in the archive | `calendar` attachments already indexed (Phase 1 of [[Attachments-as-First-Class-Mail]]) | 71 in humain, 89 in mandatory.ventures, untold in Gmail and learnstart |

The same meeting can arrive through several of these. That's expected: each
source keeps its own row, and the **iCalendar UID** ties them together.

## Schema

Added to `kaymail.SCHEMA` (laptop) and as a D1 migration (cloud), same columns
in both, covered by the schema parity test.

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,             -- takeout | google | vimcal | mail_invite
    account TEXT NOT NULL,            -- the account whose calendar this is
    calendar_id TEXT NOT NULL,        -- provider calendar id, or the Takeout file's calendar name
    calendar_name TEXT,
    uid TEXT NOT NULL,                -- iCalendar UID: the same meeting across sources
    recurrence_id TEXT NOT NULL DEFAULT '',  -- '' for a single event or a series; set for a changed instance
    sequence INTEGER NOT NULL DEFAULT 0,
    status TEXT,                      -- confirmed | tentative | cancelled
    summary TEXT, description TEXT,   -- description cut at 20,000 characters
    location TEXT, conference_url TEXT,
    starts_at TEXT, ends_at TEXT,     -- ISO 8601 UTC; all-day events as dates
    all_day INTEGER NOT NULL DEFAULT 0,
    tz TEXT,                          -- the event's own time zone
    rrule TEXT,                       -- recurrence rule, as written
    organizer TEXT,                   -- email
    visibility TEXT, transparency TEXT,
    created_at TEXT, updated_at TEXT, -- from CREATED / LAST-MODIFIED
    source_ref TEXT,                  -- file name, provider event id, or attachment id
    imported_at TEXT NOT NULL,
    UNIQUE (source, account, calendar_id, uid, recurrence_id)
);
CREATE INDEX IF NOT EXISTS calendar_events_uid ON calendar_events (uid);
CREATE INDEX IF NOT EXISTS calendar_events_start ON calendar_events (starts_at);

CREATE TABLE IF NOT EXISTS calendar_attendees (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id),
    email TEXT NOT NULL,              -- lowercased
    name TEXT,
    partstat TEXT,                    -- accepted | declined | tentative | needs-action
    role TEXT,                        -- required | optional | chair
    is_organizer INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, email)
);
CREATE INDEX IF NOT EXISTS calendar_attendees_email ON calendar_attendees (email);

CREATE TABLE IF NOT EXISTS calendar_occurrences (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    PRIMARY KEY (event_id, starts_at)
);
CREATE INDEX IF NOT EXISTS calendar_occurrences_start ON calendar_occurrences (starts_at);
```

**Every event gets occurrences.** A single event gets one row; a series is
expanded into one row per date, applying `EXDATE`s and dropping dates that a
changed instance (`recurrence_id`) replaces. Open-ended series are expanded to
one year past the import date and extended by later imports. A series stops at
5,000 occurrences. "When did I last meet X" is a query on occurrences joined to
attendees, never on `starts_at` alone.

This replaces the invite-only `calendar_events` table sketched in the
attachments spec's Phase 2: invites become `source = 'mail_invite'` rows with
`source_ref` = the attachment id.

## One meeting, several rows

A meeting seen through Takeout, Google, and an emailed invite is three rows
with one UID. Queries that count meetings group by `uid` (and
`recurrence_id`, and the occurrence date). When they disagree, the freshest
wins: the highest `sequence`, then the latest `updated_at`, then source order
**google > vimcal > takeout > mail_invite**. A `cancelled` status from any
source with the highest sequence cancels the meeting.

## Importing

**Takeout (first, now).** `calendar/import_takeout.py`, run with `uv` (it needs
`icalendar` and `recurring-ical-events`; the mail core stays standard-library
only). Arguments: the account and the folder of `.ics` files. Each file is a
calendar (its name, minus `.ics`, is `calendar_id` and `calendar_name`).
Rerunning replaces that account's Takeout rows calendar by calendar, so a
newer export simply supersedes the old one. Prints counts only: events,
series, occurrences, attendees, cancelled, and anything skipped with why
(for example the 1933-dated event in learnstart's export: kept, flagged in the
report).

**Google direct (next, plan C5).** The Worker's per-account Durable Object
syncs calendars after mail: full list first, then Google's `syncToken` for
changes only, into D1. Expanded occurrences come from Google itself
(`singleEvents=true` for a bounded window) or from the same expansion code.

**Vimcal.** Through the connector's upstream setting for the eight accounts
without a direct grant: month windows backwards to fill history, then forward
on the schedule.

**Mail invites.** The calendar parser in the attachments spec's Phase 2 writes
`mail_invite` rows. Invites matter most for accounts with no calendar access,
and as evidence of who was invited even when the calendar row was deleted.

## People

Attendee emails are the join key. `calendar_attendees.email` lines up with
mail senders and recipients and with Twenty people by email, so "everything
about Ana" is mail threads, meetings, and her CRM record by one address.
Several addresses for one person is the Phase 4 people graph's job, not this
spec's.

## Rules

- **Reading is free; writing waits for Michael's ask** (`AGENTS.md`). One ask
  covers a whole job ("invite these twelve people to Tuesday's call").
- **Titles, descriptions, and locations are written by whoever sent the
  invite.** They are untrusted text, marked as such when served to agents,
  and never instructions.
- **Private stays private.** Events marked `private` are stored, but tools
  return them as busy blocks unless Michael asks about one directly.
- **Storage**: calendar data lives where mail does: `~/.local/share/kay-os/`
  on the laptop and D1 in the cloud, never in a git checkout.

## What the learnstart import showed (2026-11-27)

9,242 events across 13 calendars became 41,723 dated occurrences with 41,482
attendee rows. Three things to know when querying:

- **About 500 yearly all-day series start between 1933 and 1989** with no
  attendees: birthdays and anniversaries. They make up the 17,268 occurrences
  dated before 2013 and add about 500 all-day dates to every year. Counts of
  meetings should filter on `all_day = 0`; "people met" is unaffected.
- **Times are stored as UTC with `+00:00`**, the same as `messages.date`, so
  calendar and mail times compare as strings. Compare against
  `strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')`, not `datetime('now')`.
- **195 events have no occurrences, correctly**: series whose every date was
  excluded or replaced, and series Google cut short ("delete this and
  following" leaves an UNTIL before the start).

People met per year (not cancelled or declined, excluding Michael's own
addresses and resource calendars): 670 in 2013, 918 in 2015, 892 in 2020,
379 in 2022, 101 so far in 2026.

## Queries this should answer

```sql
-- When did I last meet someone?
SELECT max(o.starts_at) FROM calendar_occurrences o
JOIN calendar_attendees a ON a.event_id = o.event_id
WHERE a.email = 'ana@example.com'
  AND o.starts_at <= strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now');  -- same format as stored times

-- Who did I meet most in 2015?
SELECT a.email, count(DISTINCT o.starts_at) AS meetings FROM calendar_occurrences o
JOIN calendar_attendees a ON a.event_id = o.event_id
JOIN calendar_events e ON e.id = o.event_id
WHERE o.starts_at LIKE '2015%' AND e.status != 'cancelled' AND a.email NOT LIKE 'michael@%'
GROUP BY a.email ORDER BY meetings DESC LIMIT 20;
```

## Plans

- **Takeout importer** (now): `calendar/import_takeout.py`, the tables in
  `kaymail.SCHEMA`, tests, and the learnstart import.
- **C5, Google direct sync in the Worker**: D1 migration with these tables,
  token refresh, sync tokens, per-account state.
- **C6, calendar tools in the connector**: `list_meetings`, `meetings_with`,
  `last_met`, `find_free_time`, and, on Michael's ask, `create_event`.

## Open questions

- [ ] Which accounts get a direct Google grant, and which stay on Vimcal?
- [ ] How far back should Vimcal backfill go for accounts without a Takeout?
- [ ] Should declined meetings count as "met"? (Proposed: no; they're kept
      but excluded from "met" queries by default.)
