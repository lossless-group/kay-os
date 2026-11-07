---
title: "Email Repository and Agent Harness — One Archive of Every Inbox, and the Agents That Work It"
lede: "kaymail already pulls whole mailboxes to disk. The next step is a permanent home for them, more accounts, and agents that mine, triage and sync contacts from the archive."
date_created: 2026-11-06
date_modified: 2026-11-06
date_authored_initial_draft: 2026-11-06
date_authored_current_draft: 2026-11-06
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Open
site_uuid: 87f214cc-8f9b-4601-a6e7-d945fb0c2c8a
hex_code: f6fww2
summary: >-
  Exploration of turning kaymail (kay-os's read-only mail puller) into a
  standing email repository on Cloudflare (Hetzner as fallback) that covers many accounts, plus a
  harness of agents that mine, process, triage and sync contacts from it.
  Records what exists today (two accounts, about 62 GB on disk), splits the work
  into the repository and the harness, and proposes a layered archive (raw
  .eml as record, rebuildable indexes on top) and a safety split between agents
  that read and agents that act. Links rather than repeats the existing hosting,
  secrets, Hermes and CRM docs. Leaves the specific mining and triage needs as
  open questions for Michael to fill in.
tags:
  - Exploration
  - Email
  - Kaymail
  - Personal-Assistant
  - Agent-Harness
  - Self-Hosting-Cloud
  - Cloudflare
  - Hetzner
  - Contact-Sync
  - Triage
publish: false
type: Explorations
---

# Email Repository and Agent Harness

## Why Care?

Email is where most of the facts about Michael's working life live: who he
knows, what was promised, what is waiting on him, which deals and clients went
where. Today it sits in several provider inboxes, each searchable only on its
own and only through that provider's interface.

kaymail (`mail/kaymail.py`, shipped 2026-11-03) changed the first half of that:
it pulls whole mailboxes onto a disk we control, read-only, and indexes them
for search. What it doesn't yet do is:

1. **Live somewhere permanent.** It runs on a laptop, so it stops when the
   laptop sleeps or a terminal closes.
2. **Take any account easily.** Adding the Hypernova Workspace account failed on
   2026-11-06 (cause not yet diagnosed; see Open Questions).
3. **Do anything with the mail.** Search is the only thing it offers. Mining,
   triage and contact sync are all still manual.

Two things shape everything below. **Most of my communication happens on my
phone,** so whatever this becomes has to work well from an iPhone first.
And **most of my guilt and shame comes from email.** The harness should lower
that, not add to it: tell me what actually needs me, say plainly what can wait
or be ignored, and never become another inbox nagging me.

This exploration is about both halves: the **repository** (an archive of every
inbox that keeps growing) and the **harness** (agents built around Michael's
specific email needs, working on that archive).

## What Exists Today

Verified on 2026-11-06:

| Account | Messages | Size | Range | State |
|---|---|---|---|---|
| Personal Gmail | 228,292 | 18.65 GB | 2004-07 → 2026-11 | Fully downloaded |
| LearnStart (Workspace) | 117,000 | 34.00 GB | 2010-09 → 2026-11 | ~93,650 to go; backfill running |

On disk: **60 GB** of raw `.eml` plus a **2.5 GB** SQLite index. If the rest of
learnstart is like what's already down, it adds roughly another 25–30 GB, so
expect **about 90 GB for two accounts** before adding any more.

What kaymail already guarantees, and the harness should keep:

- **Read-only by construction.** `EXAMINE` and `BODY.PEEK`, so a sync can't
  change anything on the server. Mail deleted upstream stays in the archive.
- **The local copy is the system of record.** Agents read the archive, never
  the provider. Swapping agents never means downloading again.
- **Outside every git repo.** Credentials in `~/.config/kay-os/mail/`, mail in
  `~/.local/share/kay-os/mail/`, owner-only. Both paths can be moved with
  `KAYMAIL_CONFIG` and `KAYMAIL_DATA`.
- **New-mail feed.** `watch` appends arrivals to `events.jsonl`, which is the
  natural trigger for any agent that reacts to new mail.
- **Email is untrusted input.** Anyone can put text into the archive by
  sending a message (README, "Mail" section).

## Half One: The Repository

### Where it lives

**Leaning: Cloudflare.** (2026-11-06.) A Hetzner VPS was the first idea, for
cheap disk. Two things moved it:

- **We're in the US.** Hetzner's cheap servers and its Storage Boxes are
  Europe-only. Its US servers cost about four times as much for the same specs,
  and Hostinger's US prices depend on a 24-month prepayment.
- **Cloudflare already has a service for nearly every piece**, and we already
  use some of them: Artifacts for event-hog, a Worker for `hubspot-mcp`, and R2
  for corpora ([[JuiceFS-Pinned-Path-Off-Local-Substrate]]). Its products are
  ahead of the field but hard to find, because the names don't say what they
  do. Hence this table:

| Cloudflare name | What it actually is | Our use |
|---|---|---|
| **Workers** | Small programs that run on Cloudflare, no server to manage | The gateway, the APIs, glue |
| **Durable Objects** | A Worker with its own private SQLite database (10 GB each) and a timer, which never runs twice at once | One per mail account: runs the sync and holds that account's index |
| **R2** | File storage, like S3, with no download fees | Raw `.eml`: ~90 GB is about $1.35/mo |
| **D1** | A SQLite database (10 GB cap) | Shared tables: contacts, triage log |
| **Containers** | Docker containers started by a Worker; up to 20 GB of temporary disk each | Fallback for running `kaymail.py` mostly as is |
| **Queues** / **Workflows** | A job queue / multi-step jobs that retry and survive restarts | New-mail triggers, triage, contact sync |
| **Workers AI** | Hosted models, GPU billed per use | Embeddings, summaries: GPU on demand, no box to rent |
| **Vectorize** | A vector database | Semantic search over the archive |
| **AI Gateway** | A logging proxy in front of model calls | Seeing every model call the harness makes |
| **Access** | Login in front of any app or API | Protecting the gateway; per-caller service tokens |
| **Tunnel** | A private connection out of any machine, no open ports | Reaching a laptop or box without exposing it |
| **Artifacts** | Git repos built for agents | The roles and rules files, with history |

Everything there is driven by `wrangler` (the command-line tool) and an API,
so it can be set up, inspected and changed from a terminal session.

**The hard part is the sync.** A backfill is a days-long, throttled IMAP
session, which is the least natural thing to run on Cloudflare. Two ways:

1. **A Durable Object per account** that wakes on its timer, opens IMAP over a
   Worker TCP socket, fetches a batch into R2 and its own index, then sleeps.
   It's the most Cloudflare-native, but it means rewriting kaymail's sync in
   TypeScript.
2. **kaymail in a Container,** changed to write mail to R2 instead of local
   disk, since a Container's disk is temporary and capped at 20 GB.

The laptop backfill can keep running in the meantime. The `.eml` files already
on disk upload to R2 as they are.

**To verify before building:** that FTS5 search works in Durable Object SQLite
or D1 (nothing in the docs I found confirms it), and that Worker sockets hold
an IMAP session long enough for a useful batch. If FTS5 isn't there, search
needs another home (Vectorize plus plain SQL filters, or a small box).

**Hetzner stays the fallback** if the sync proves awkward on Cloudflare: a box
for the sync only, with Cloudflare still in front.

### Layers

Keep the raw mail as the only thing that can't be rebuilt; everything else is
derived and can be thrown away:

| Layer | What | Rebuildable? |
|---|---|---|
| **Record** | Raw `.eml` per message, per account | No: back this up |
| **Index** | SQLite + FTS5 (today's `index.sqlite`) | Yes, from the record |
| **Derived** | Threads, contacts, entities, embeddings, triage labels | Yes, from record + index |
| **Outputs** | CRM records, drafts, digests, notes | Live elsewhere (CRM, Artifacts, docs) |

This lets the harness try a new extractor or embedding model without risking
the archive. It also means the backup plan is short: back up the record and
the account config.

### Adding accounts

Gmail and Workspace accounts work today with an app password. That route has
limits:

- **Workspace admins can switch off app passwords or IMAP** for a whole domain.
  That's a likely cause of the hypernova failure, but it hasn't been confirmed.
- **The proper long-term route is OAuth** (IMAP with `XOAUTH2`), which doesn't
  depend on app passwords. It means registering a Google Cloud OAuth app, which
  has its own verification hurdles; see
  [[Pickup_OAuth-Caldiy--Check-for-Google-Cloud-App-Verification]].
- **Non-Gmail accounts** already work with `--host`.

Off the laptop, `add` can't prompt in a terminal, so adding an account becomes
a small page behind Access, or a `wrangler secret put`. Account passwords
would live as Worker secrets. That's simpler than the open secrets question in
[[Per-Client-Self-Host-Stacks-Twenty-First-on-Railway]] (OpenBao, Infisical,
and others), and probably enough for one person's mail.

### Running it

- One sync per account, on a timer, resuming where it left off (as
  `backfill.sh` does today).
- New arrivals go onto a Queue, replacing `events.jsonl`.
- R2 is the record. A second copy elsewhere (the laptop, or another R2
  bucket) covers deleting something by mistake.

## Half Two: The Harness

### The jobs

Named so far: mining, processing, triage, contact sync. Each needs different
access and carries different risk:

| Job | Reads | Writes | Risk |
|---|---|---|---|
| **Mining** | Whole archive, history | Derived layer, notes | Low: nothing leaves |
| **Processing** | Messages, attachments | Derived layer (threads, entities, summaries) | Low |
| **Triage** | New mail from `events.jsonl` | Labels, a queue, digests | Medium if it touches the provider |
| **Contact sync** | Senders, signatures, threads | CRM records | Medium: writes to shared systems |
| **Replies, drafts** | Thread | Draft text | High if it can send |

The needs behind each job are Michael's and aren't written down yet. They're
the first open question.

### A harness I control and can see into

My email is complicated because my roles are. One person is a founder, an
investor at more than one firm, a consultant to several clients, and a private
individual, often in the same thread, across accounts that don't line up neatly
with any one role. No off-the-shelf triage gets that right, and it won't stay
right, because roles and involvements change.

So the harness has to keep changing, and I have to be able to steer it. Some
ways to get there:

- **Roles as a file I edit.** Who I am to whom: firms, clients, people,
  projects, what each account is mostly for, what "needs me" means in each
  role. Plain markdown, kept in a private repo (this one is public), read by
  every agent instead of hidden in prompts or a vendor's memory.
- **Rules and skills as files too.** Triage rules and procedures live as text
  I can read and change, with history, so I can see what changed and roll it
  back.
- **Agents propose changes; I approve them.** When an agent notices a new
  client, a role ending, or a rule that keeps misfiring, it suggests an edit as
  a diff I accept or reject, rather than quietly learning something I can't
  see. This is the same idea as Hermes' skill-write approval in
  [[Customizing-Hermes-Agent-through-API]].
- **Every decision is visible.** Each triage or sync decision is logged with
  the rule and the reasoning behind it, so I can look at any message and see
  why it was handled the way it was.
- **Corrections become rule changes.** When I fix a decision, that fix should
  turn into a proposed change to the roles or rules file, so the same mistake
  doesn't come back.

This is also why the harness shouldn't live inside Hermes or any one agent's
memory: the roles and rules are mine, and agents come and go.

### Safety: agents that read, agents that act

Because email is untrusted input, a message can contain instructions aimed at
whatever agent reads it. Two rules follow:

1. **Reading agents get no outbound tools.** Mining, processing and triage read
   the archive and write only to the derived layer.
2. **Acting agents work from reviewed output.** Contact sync and drafting take
   their input from the derived layer, after a human has reviewed it or the
   change is small and reversible. Anything that sends mail, emails others, or
   changes shared records waits for approval.

The provider stays read-only. If triage should ever label or archive in Gmail
itself, that's a separate, write-capable credential, added deliberately.

### Contact sync targets

Contacts already have homes, each with an operating guide:

- **Twenty CRM** (Lossless, Palmer AI, The Water Foundation instances):
  [[lossless-crm-interface-guidelines]] covers routing, provenance and the
  timeline-row rule.
- **Decile Hub**: [[decilehub-interface]] and [[decile-hub-interface]] cover
  the never-duplicate rule and name-matching. Email is Decile's natural key for
  People, so the archive is a good source of the emails those skills say never
  to invent.

Contact sync should feed those skills, not replace them.

### Which harness

The archive should work with any harness. Agents reach it through one
interface: kaymail's CLI (`search --json`, `show --json`) today, and an MCP
server over the same queries next. Any of these can then sit on top:

- **Claude Code** with skills from `lossless-agent-skills`, for interactive
  work.
- **Hermes**, already on Michael's phone: see
  [[Customizing-Hermes-Agent-through-API]] for wiring our skills and MCP into it.
- **Scheduled jobs** (Workflows and Queues), for triage and digests driven by
  `events.jsonl`.

Agents that aren't trusted with the accounts yet, Hermes in particular, could reach the archive through a kay-os gateway instead; see
[[A-Gateway-Between-Agents-and-My-Accounts]].

Email skills (triage rules, contact-sync procedure) belong in
`lossless-agent-skills` like every other skill, not in this repo.

### Where GPU comes in

Most of the harness runs on CPU: sync, FTS search, rules-based triage, and
calls to hosted models. A GPU matters for two jobs:

- **Embedding the whole archive** for semantic search: a one-off bulk job, then
  small increments.
- **Running a local model over private mail** if some mail shouldn't go to a
  hosted API.

Both are bursty. Workers AI covers them at a per-use price; a model it doesn't
host could go to an hourly GPU rental (RunPod, Vast, Modal) for one job.

## Open Questions

1. **What are the specific needs?** For each job: what should mining find,
   what counts as "needs me" in triage, which contacts go to which CRM, what
   should a daily digest say.
2. **Why did adding the Hypernova account fail?** The error message, and whether the
   Workspace has app passwords or IMAP turned off.
3. **Which accounts are next,** and are any of them not Google?
4. **Which sync route on Cloudflare:** a Durable Object per account
   (rewrite in TypeScript) or kaymail in a Container (writing to R2)?
5. **Is anything off limits?** Accounts or senders whose mail should never go
   to a hosted model, which decides whether a local model is needed.
6. **Where do the roles and rules files live?** A private GitHub repo, a
   Cloudflare Artifacts repo, and how do I review proposed
   changes from the phone?
7. **Does derived output live in D1 and R2, in Cloudflare Artifacts**
   ([[Using-Cloudflare-Artifacts-as-Knowledge-Graph]]), or both?

## Suggested First Spike

1. Test the two unknowns: FTS5 in a Durable Object's SQLite, and an IMAP
   batch fetch over a Worker TCP socket against one account.
2. Upload the `.eml` already on disk to an R2 bucket (`rclone` or
   `wrangler`), keeping the laptop copy.
3. Put a small read-only MCP server (a Worker, behind Access) in front of
   search, with a token for Hermes and a call log; see
   [[A-Gateway-Between-Agents-and-My-Accounts]].
4. Write down one job's needs (probably triage or contact sync) and build it
   as a reading agent that only writes a reviewable queue.
