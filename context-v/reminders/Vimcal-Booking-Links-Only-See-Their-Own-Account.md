---
title: "Vimcal Booking Links Only See Their Own Account"
lede: "A Vimcal booking link offered a time that was busy on another account. The fix is to share every other account's free/busy into the account that owns the link."
date_created: 2026-11-27
date_modified: 2026-11-27
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
site_uuid: 35636eb0-8c3a-432c-8ced-52ce7abb0f52
hex_code: n3ar00
summary: >-
  Vimcal is connected to eight Google accounts, but each personal (booking)
  link only checks conflicts against calendars that belong to the link's own
  account; its "Check for conflict" list doesn't offer the other connected
  accounts. Fix: in Google Calendar, share each other account's primary
  calendar with the booking account as "See only free/busy", then switch
  those calendars on in the link's Check for conflict list. Verified
  2026-11-27 on the mpstaton@gmail.com link. Vimcal's MCP still reported the
  link as checking only its own calendar afterwards, so don't treat that field
  as the truth.
tags:
  - Reminder
  - Vimcal
  - Calendar
  - Booking-Links
publish: true
type: Reminders
---

# Vimcal Booking Links Only See Their Own Account

**The trap.** Vimcal shows all eight accounts in one calendar, so it's easy to
assume its booking links check all eight. They don't. A personal link checks
only calendars that belong to the account that owns it. On 2026-11-27 the
Gmail link (`book.vimcal.com/p/michaelstaton/30-minute-meeting-74649`)
offered 11am while michael@humain.vc had a meeting then. Every account had its
own default "30 Minute Meeting" link, each blind to the others.

**The fix that worked.** Pick one account to own the link you hand out (here
`mpstaton@gmail.com`). For every other account:

1. Google Calendar, signed in as that account → its main calendar →
   **⋮ → Settings and sharing**.
2. **Share with specific people or groups** → add the booking account →
   **See only free/busy (hide details)**.
3. If a Workspace domain refuses outside sharing: admin.google.com →
   **Apps → Google Workspace → Calendar → Sharing settings → External sharing
   options for primary calendars** → at least *Only free/busy information*.

Then in Vimcal, open the link (Shift+Y) → **Check for conflict** → switch on
the shared calendars. Give Vimcal a refresh to pick them up.

**Don't trust the API's list.** Afterwards, Vimcal's MCP
(`list_personal_links`) still showed the link's `blocked_calendar_ids` as
only `Michael@Personal`, while the app and the booking page checked all of
them. When an agent needs Michael's real availability, it reads events across
the accounts (`list_events`, `find_free_times`), not that field.

**Why not cal.diy.** cal.diy (self-host-stack, on Railway) checks every
connected calendar by design, which is what it was deployed for. It's parked
for now: its sign-in pages were returning 500, and Google's OAuth review for
its app was unresolved. The free/busy sharing above made it unnecessary for
booking.

Related: [[Agent-Workspace-Memory-and-Chat-History]] (calendars as context),
`self-host-stack/docs/caldiy/setup.md`.
