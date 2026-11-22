---
title: "Replying and Scheduling on My Behalf — Mail That Goes Out, and Meeting Times That Get Agreed"
lede: "Read-only was the right place to start, but it isn't the goal. kay-os should draft and send replies, and handle the back-and-forth of finding a time across every calendar I keep."
date_created: 2026-11-22
date_modified: 2026-11-22
date_authored_initial_draft: 2026-11-22
date_authored_current_draft: 2026-11-22
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Open
site_uuid: ebf86d05-bf05-4cb3-b19b-95f98d17506f
hex_code: abnz6d
summary: >-
  Extends the gateway and harness explorations past read-only. The connector
  should also draft, reply and send, from the account a thread arrived on, and
  eventually negotiate meeting times across many calendars without Michael in
  the loop for routine cases. Keeps the archive's sync credential read-only and
  gives sending its own credential and path. Proposes a ladder of autonomy
  (drafts, approved sends, then narrow auto-sends) so trust grows one action at
  a time. Sketches the scheduling flow (detect a request, find free time across
  all calendars, offer at most three times, hold them, book on reply) and weighs
  reusing the self-hosted Cal.diy against calling each calendar directly.
tags:
  - Exploration
  - Email
  - Calendar
  - Scheduling
  - Gateway
  - MCP
  - Agent-Trust
  - Personal-Agents
publish: false
type: Explorations
---

# Replying and Scheduling on My Behalf

## Why Care?

An archive I can search is useful. But the guilt comes from mail I haven't
answered, and much of that mail is scheduling: "does Tuesday work?", "can you
do 30 minutes next week?", a thread with four people and three time zones. A
connector that can only read helps me find those threads. It doesn't get them
off my plate.

So the connector has two more jobs:

1. **Reply.** Draft, and eventually send, replies from the right account, in
   the right thread, in my voice.
2. **Schedule.** Handle the back-and-forth of finding a time across every
   calendar I keep, and put the meeting on all of them, ideally without me for
   the routine cases.

This builds on [[A-Gateway-Between-Agents-and-My-Accounts]] (kay-os holds the
keys, callers get scoped access) and [[Email-Repository-and-Agent-Harness]]
(agents that read vs. agents that act). On the splash, sending is the
Gatekeeper's job and calendars are the Timekeeper's.

## What Stays Read-Only

The archive sync keeps its read-only guarantee. Mailboxes open with `EXAMINE`
and bodies fetch with `BODY.PEEK`, and that credential never gains the power to
send.

Sending gets **its own credential and its own code path**. That way a bug or a
prompt injection in the sync can't send mail, and I can revoke sending without
stopping the archive. Mail kay-os sends shows up in Sent and comes back into
the archive through the ordinary sync, so the record stays complete.

## A Ladder of Autonomy

Trust grows one rung at a time, per caller and per kind of message:

| Rung | What the agent does | What I do |
|---|---|---|
| **1. Draft** | Writes a reply into the account's Drafts folder | Open it, edit, and send from Gmail or the phone |
| **2. Propose** | Puts a reply in a kay-os queue | Approve, edit or reject from the phone; kay-os sends |
| **3. Narrow auto-send** | Sends some replies on its own, within written rules | Read a log afterward, with an undo window where possible |

Rung 3 is for messages whose content comes from structured data rather than
free text. A scheduling reply ("Tuesday 2pm, Wednesday 10am or Thursday 4pm
Central work for me") is built from slots and a template, so a hostile email
can't steer what it says. A free-form reply to a client should stay on rung 2
for a long time, maybe for good.

Each caller gets its own ceiling. Claude Code driven by me might reach rung 2
quickly. Hermes stays on rung 1 until its call log earns more. Scheduled jobs
get only the narrow rung-3 templates.

## Sending: the Mechanics

- **Reply from the account the mail came to.** The thread's account picks the
  sender. Replies need `In-Reply-To` and `References` headers (and Gmail's
  thread ID, if going through its API) so they thread correctly for everyone.
- **Which route.** SMTP with an app password is quick, but it's the same kind of
  password the sync uses and it can do anything. The Gmail API with OAuth can
  ask for just what's needed. Google treats Gmail scopes as sensitive or
  restricted, and restricted ones bring a heavier review, so check which scope
  each step needs before building on it. Workspace domains I administer can
  register an *internal* app, which skips that review. The Cal.diy OAuth
  handoff ([[Pickup_OAuth-Caldiy--Check-for-Google-Cloud-App-Verification]])
  is the precedent for going through Google's review.
- **Voice.** The roles file from [[Email-Repository-and-Agent-Harness]] says
  who I am to whom. A voice guide sits next to it, and my sent mail in the
  archive is the evidence for both.
- **Everything is logged:** the draft, who proposed it, who approved it, and
  what was actually sent.

## Scheduling Across Many Calendars

### The calendars

Personal Gmail, LearnStart and other Workspace accounts, Apple/iCloud, and
client calendars I've been given access to. Any one of them alone gives a wrong
picture of when I'm free. The Timekeeper's first job, before any negotiating,
is to read them all and know where I'm actually busy.

### The flow

1. **Spot the request.** Triage flags a thread as a scheduling request: who,
   how long, how urgent, and which role it belongs to.
2. **Find free time** across every calendar, with my rules applied: working
   hours per role, buffers, focus blocks, travel, the time zone of each person,
   and how many meetings a day is too many.
3. **Offer at most three times** (a kay-os house rule), or a booking link when
   the other side prefers one.
4. **Hold them.** Put tentative holds on my calendar so two threads can't be
   offered the same slot. Release the holds when the thread settles or goes
   quiet.
5. **Read the answer.** Accept, counter-offer, "none of these", or a reply from
   their assistant rather than them.
6. **Book it.** Create the event on the right calendar, invite everyone, add
   the video link, release the other holds, and confirm in the thread.
7. **Handle afterward.** Reschedules, cancellations and "running 5 late" follow
   the same rules.

Multi-party threads are the hard case: everyone's availability is partial, and
the agent has to converge without spamming the thread.

### Reuse Cal.diy or call calendars directly?

Cal.diy, our self-hosted Cal.com, already does the availability half: it
connects many calendars, computes free time, serves booking pages, and creates
events. The source is `self-host-stack/core/cal.diy` (a submodule of
`lossless-group/cal.diy`), deployed on Railway at
`caldiy-production-b476.up.railway.app` and linked from the portal at
`lossless.at/lossless/scheduling`; setup is in `self-host-stack/docs/caldiy/`.
It's connected to Apple. Google Calendar was waiting on Google's OAuth review
from 2026-08-22, and the `self-host-stack` changelog of 2026-11-01 still found
no sign of approval; check whether that came through.

- **Use Cal.diy as the engine.** kay-os handles the email conversation and asks
  Cal.diy for availability and bookings through its API. One OAuth app and one
  set of calendar connections, already built.
- **Call each calendar directly.** More control over holds and rules, but it
  rebuilds availability logic Cal.com has spent years on.

Starting with Cal.diy and replacing pieces only when it gets in the way seems
like the cheaper bet.

## Safety

Email is untrusted input, and an agent that can send is what prompt injection
goes after. Taken together, the rules above cover it:

- The agent reading a thread can propose a reply but can't send it, except
  for rung-3 templates whose content comes from slots, not from the email.
- Drafting may need context from the archive ("what did we agree last
  time?"). That's fine on rungs 1 and 2, because I see the draft before it goes
  out. Rung 3 gets no archive search.
- Never send to an address that isn't already on the thread without approval.
- A per-caller daily cap on sends, and one switch that turns all sending off.

## Open Questions

1. **What may go out without me?** Scheduling replies only, or also
   acknowledgements ("got it, will look this week")?
2. **Approval from the phone:** a kay-os page, a push notification, a Hermes
   chat, or Gmail drafts themselves (rung 1 needs no new UI at all)?
3. **Which calendars, which accounts,** and which are read-only to me (client
   calendars I can see but shouldn't write to)?
4. **Scheduling rules:** hours per role, buffers, max meetings per day, focus
   blocks, which video link per account.
5. **Did Google approve the Cal.diy OAuth app,** and does its API cover holds,
   or only bookings?
6. **Gmail API or SMTP** for sending, per account, given the scope review.
7. **Does the other side know they're talking to an agent?** Sign scheduling
   mail as an assistant, or as me?

## Possible First Steps

1. Ship the connector with `search` and `show` plus **`draft_reply`**, which
   writes into the right account's Drafts folder (rung 1). Useful on day one,
   and nothing goes out without me pressing send.
2. Check the Cal.diy Google review, connect every calendar there, and expose a
   `find_times` tool that returns at most three slots.
3. Put both together for one case: a scheduling request comes in, and a draft
   offering three held times appears in Drafts.
4. After a few weeks of reading those drafts, decide what earns rung 2 and
   rung 3.
