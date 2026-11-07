---
title: "A Gateway Between Agents and My Accounts — Letting Hermes In Without Handing It the Keys"
lede: "I don't trust Hermes Agent with my email, CRM or calendar yet. kay-os could sit in between: it holds the accounts, and agents get only what it lets through."
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
site_uuid: 75808956-db20-41ca-b6ba-081554547ee6
hex_code: 4qrt1l
summary: >-
  Early thinking on giving kay-os an API that Hermes Agent and other services
  call instead of connecting to email, CRM and calendar directly, because
  Hermes isn't trusted with those accounts yet. Notes that the Homebase spec in
  self-host-stack already designs most of this (a proxy that holds credentials
  and fronts many tools as one connector) and that the difference for kay-os is
  trust in the caller rather than the person. Sketches ways to limit what an
  untrusted caller can do (scopes per caller, proposals instead of actions,
  narrower reads, an audit log) as options, not decisions.
tags:
  - Exploration
  - Hermes-Agent
  - Gateway
  - MCP
  - Agent-Trust
  - Email
  - CRM
  - Calendar
publish: false
type: Explorations
---

# A Gateway Between Agents and My Accounts

## Why Care?

[[Customizing-Hermes-Agent-through-API]] lays out how to connect Gmail,
Calendar and the Twenty CRMs to Hermes directly. That works, but it gives
Hermes the full power of each account, and I don't trust it with that yet.

What I'd rather have is an intermediary: kay-os holds the accounts, and Hermes
(and anything else) asks kay-os for what it needs. kay-os decides what gets
through. If Hermes misbehaves, or turns out to be worse than it looks, I cut
off one caller instead of revoking every account.

## Most of This Is Already Designed

The Homebase spec ([[Homebase-MCP-One-Connector-Per-Client]], in
`self-host-stack`, still a draft) is very close to this already:

- a **proxy** that holds every credential on the server, so no agent ever sees
  one (its H1 and H5);
- **one connector** in front of many tools, grouped by service (`twenty_*`,
  and so on; H3 and H4);
- skills served alongside the tools;
- writes held back behind confirmation at first (H7).

So the likely shape is a kay-os instance of Homebase rather than something new.
The email archive ([[Email-Repository-and-Agent-Harness]]) would be one more
service behind it.

## Where kay-os Is Different

Homebase is built for clients who trust their own agent, so it gives them full
read-write (its D5). In kay-os the person is trusted and **one of the callers
isn't**. That suggests a few things worth trying, none of them settled:

- **Separate access per caller.** Hermes, Claude Code, Claude on the phone and
  scheduled jobs each get their own token and their own list of tools, so
  Hermes can see less than Claude Code does.
- **Proposals instead of actions.** An untrusted caller drafts "add this person
  to Twenty" or "accept this meeting", and kay-os queues it for me to approve,
  ideally from the phone. kay-os carries out what I approve, not Hermes.
- **Narrower reads.** Search results and summaries rather than the whole
  archive at once; free/busy rather than full calendar details; some accounts
  or senders left out entirely.
- **Mark untrusted content.** Email bodies are written by strangers. Returning
  them labeled as untrusted data won't stop prompt injection, but combined with
  proposals it limits what injection can do.
- **A log of every call,** per caller, so I can see what Hermes actually asked
  for before trusting it with more.

Trust can then grow one tool at a time instead of all at once.

## Open Questions

1. **How does Hermes reach it?** Hermes runs on Agent37. If the gateway is a
   Cloudflare Worker behind Access ([[Email-Repository-and-Agent-Harness]]),
   it's a public HTTPS address that only callers with a valid token get
   through, which Hermes can reach without any network setup.
2. **Auth.** Homebase points to didi.sh as its authorization server, which
   still lacks the OAuth endpoints MCP clients expect. For one person, a token
   per caller may be enough to start.
3. **Where do approvals happen?** Phone, a web page, a chat channel?
4. **Fork or share Homebase code?** One codebase with per-caller limits as a
   feature might serve clients too, if they ever want the same caution.
5. **Which tools first?** Probably email search, read-only.

## Possible First Step

Put a small read-only MCP server in front of the mail archive (`search` and
`show`) with a token just for Hermes and a call log. Connect Hermes to that
instead of Gmail, and see what it asks for.
