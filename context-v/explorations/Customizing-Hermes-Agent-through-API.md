---
title: "Customizing Hermes Agent through API — Making a Hosted Hermes Mine"
lede: "Hermes already speaks the same skill standard we do. The work is wiring our skills in, our accounts on, and its own skills back out where we can edit them."
date_created: 2026-10-27
date_modified: 2026-10-27
date_authored_initial_draft: 2026-10-27
date_authored_current_draft: 2026-10-27
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5 (1M context)
at_semantic_version: 0.0.0.1
status: Open
site_uuid: 04d447dd-9713-4616-8b28-9f9d5976428b
hex_code: rcm8pc
summary: >-
  Exploration of how to turn a Hermes Agent hosted on Agent37 Cloud (already
  reachable from Michael's phone) into kay-os's first colony member. Grounds
  every claim in the current docs (Hermes Agent v0.22.5, released 2026-10-22;
  Agent37 docs as of 2026-10). Finds that Hermes skills follow the
  agentskills.io spec our lossless-agent-skills repo already follows, that
  Hermes can scan our skills as an external directory, that its self-made
  skills live as plain files under ~/.hermes/skills which Agent37 exposes over
  a Files API, SSH and exec, and that accounts arrive through two doors:
  Agent37's managed Composio (OAuth per instance) and Hermes' own MCP client.
  Corrects one assumption: Hermes does not build a knowledge graph by default;
  that takes a memory-provider plugin such as Hindsight.
tags:
  - Exploration
  - Hermes-Agent
  - Agent37
  - Agent-Skills
  - Personal-Assistant
  - MCP
  - Composio
  - Agent-Memory
publish: true
---

# Customizing Hermes Agent through API

## Why Care?

There's a Hermes agent on the phone already, and right now it's a stranger.
It doesn't know the Lossless skills, it can't see the accounts (Gmail, calendar,
the three Twenty CRMs, Decile Hub, GitHub), and the skills it writes for itself
pile up somewhere nobody can see or prune.

kay-os is meant to be a colony of personal-assistant agents for ADHD/2e
all-stars. Hermes is the obvious first member, because it is built around a
**learning loop**: it writes its own procedural memory (skills) and curates its
own notes. A learning loop you can't inspect is a liability, though. The
system can only be trusted once a human can read, edit, pin and delete what the
agent has learned.

So the question is: **through which APIs do we (1) give it our skills,
(2) give it our accounts, and (3) get its own evolving skills back where we can
add, edit and remove them?**

## The Two Layers

| Layer | What it is | Who runs it |
|---|---|---|
| **Hermes Agent** | Open-source, self-improving agent by Nous Research. Persistent memory, self-created skills, cron, a messaging gateway for 20+ platforms, an MCP client, an OpenAI-compatible API server, and a web dashboard. Latest stable: **v0.22.5 (2026-10-22)**. | Open source, [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) |
| **Agent37 Cloud** | YC-backed hosting for agent harnesses (Hermes, OpenClaw, Claude Code, Codex, Pi, OpenCode, custom). Each instance is a persistent gVisor sandbox with its own disk, metered per minute, auto-sleeps when idle. Template `agent37-hermes` is Hermes out of the box. | Agent37 (managed) |

Nous also sells its own hosted option, [Hermes Cloud](https://portal.nousresearch.com/cloud).
This exploration assumes the existing Agent37 instance, but almost everything
below is Hermes-level and would carry over.

## The APIs We Have to Work With

Agent37 exposes **two planes with one key** (`sk_live_…`):

| Plane | Base URL | Auth header | What we'd use it for |
|---|---|---|---|
| Sandbox API | `https://api.agent37.com/v1` | `Authorization: Bearer` | Instances, templates, backups, fork, budgets, integrations (Composio) |
| Sandbox API on the machine | `https://sandbox.agent37.app` | `X-Agent37-Key` | `POST /v1/instances/{id}/exec`: run any shell command; logs |
| Agent API | `https://{instanceId}.agent37.app` | `X-Agent37-Key` | `POST /v1/responses` (chat), `/v1/sessions`, **`/v1/files`**, `/v1/models`, `/v1/health` |

Any other port inside the instance (Hermes' dashboard, terminal, file browser)
is reachable at `https://{instanceId}-{port}.agent37.app`, also behind the key
or a signed URL.

Hermes adds its own surfaces inside the instance:

- **API server** (OpenAI-compatible): `/v1/chat/completions`, `/v1/responses`,
  plus Hermes-native `/v1/runs` (with `/v1/runs/{id}/steer` to course-correct a
  live run), `/api/sessions/{id}/chat`, and `/api/jobs` for cron.
- **Dashboard REST**: `GET /api/skills`, `PUT /api/skills/toggle`,
  `GET|PUT /api/config`, `GET|PUT|DELETE /api/env`, `/api/cron/jobs`,
  `/api/sessions/search`, `/api/profiles`.
- **CLI** (reachable through Agent37 exec or SSH): `hermes skills …`,
  `hermes curator …`, `hermes mcp add …`, `hermes profile …`, `hermes memory …`.

**The key fact:** a Hermes skill is just a directory with a `SKILL.md` on disk,
and Agent37 hands us root on that disk three ways: the Files API, exec, and SSH.
None of this needs a special Hermes skills API.

## Goal 1: Give It Our Skills

Hermes skills are **compatible with the [agentskills.io](https://agentskills.io/specification) open standard**,
and `lossless-agent-skills` follows that spec too. So there's no format
conversion to do, only placement.

Hermes reads skills from, in precedence order:

```text
project (.hermes/skills, .agents/skills) → ~/.hermes/skills (local) → skills.create_dir → skills.external_dirs
```

**Recommended: mount our repo as an external directory.**

1. Clone `lossless-agent-skills` onto the instance (exec or SSH), for example to
   `~/lossless-agent-skills`.
2. Add it to `~/.hermes/config.yaml`:

   ```yaml
   skills:
     external_dirs:
       - ~/lossless-agent-skills
   ```

3. Keep it fresh with a Hermes or Agent37 cron that runs `git pull`.

Caveats from the docs:

- **External dirs are not write-protected.** If Hermes' process can write
  there, its `skill_manage` patches will edit our canonical skills in place.
  Either `chmod -R a-w` the clone, or treat it as a branch and review its diffs
  like a PR. Read-only is the safer default. Edits to our skills stay in the
  `lossless-agent-skills` repo, per the anchor rule.
- **Local wins on name collisions.** If Hermes creates a skill with the same name
  as one of ours, its copy shadows ours (it gets logged as shadowed). Check this
  periodically.
- **Many of our skills assume our Mac.** Paths like `/Users/mpstaton/...`, Claude
  Code tools, and the `chroma` MCP won't exist in the sandbox. Expect to curate
  a phone-assistant subset (inbox triage, CRM interface, event prep, PSP,
  expense reports) rather than the whole catalog. Hermes' `platforms:` and
  `requires_toolsets:` frontmatter can hide the ones that can't run there.

Agent37's own docs say **skills don't belong in a custom image**, because
`/home/node` is masked at runtime. Install them into the running instance
instead.

## Goal 2: Give It Our Accounts

Two doors, and we'll probably want both.

**Door A: Agent37 managed Composio (fastest).** Every instance ships with a
Composio entity, so Gmail, Google Calendar, Slack, Notion, GitHub and 250+ other
apps connect via OAuth with no tokens to hold. Driven by:

```text
GET    /v1/instances/{id}/integrations/toolkits
POST   /v1/instances/{id}/integrations/connect      → returns an OAuth link to open on the phone
GET    /v1/instances/{id}/integrations/connections
DELETE /v1/instances/{id}/integrations/connections/{connectedAccountId}
```

It supports **multiple accounts of one app** (useful: personal plus Lossless
Gmail). Connections survive restarts and image updates. Tool calls are metered
from the Agent37 wallet; connecting is free. The agent can also connect apps
from inside a conversation.

**Door B: Hermes' own MCP client (for our bespoke servers).** Composio won't
cover the Twenty CRM instances, Decile Hub, Edviro CRM, or anything we self-host.
Hermes reads `mcp_servers` from `~/.hermes/config.yaml`, and `hermes mcp add`
stores OAuth tokens separately under `~/.hermes/mcp-tokens/`. Secrets go in
`~/.hermes/.env` and are referenced as `${VAR}` or `${env:VAR}`, the same
syntax Cursor and Claude configs use, so snippets copy across unchanged.

Open item: confirm each connector we use in claude.ai exposes a remote MCP
URL that a third-party client can OAuth into. Some of ours are custom
connectors we control (the Twenty instances); others may be claude.ai-only.

## Goal 3: Own Its Evolving Skills

How Hermes learns, per the docs:

- **`skill_manage` tool**: the agent creates, patches, deletes and adds
  supporting files to skills. Its system prompt nudges it to save a skill
  whenever it works out a multi-step workflow, recovers from a dead end, or
  gets corrected.
- **Background review**: after turns (roughly every 10), a forked agent reviews
  the session and can write or patch skills and memory.
- **`/learn`**: we can point it at a URL, folder, PDF, or "what I just showed
  you" and it authors a skill (large sources become knowledge-base skills with
  `references/`).
- **Curator**: when idle, it moves agent-created skills through
  active → stale (14 days unused) → archived (30 days) into
  `~/.hermes/skills/.archive/`. LLM consolidation into umbrella skills is
  **off by default** (`curator.consolidate: true` to enable). It never deletes,
  only archives, and archives are restorable.

The controls that give us add/edit/remove:

| Need | Mechanism |
|---|---|
| **Review before it lands** | `skills.write_approval: true` stages every write under `~/.hermes/pending/skills/`; `/skills pending`, `/skills diff <id>`, `/skills approve|reject <id>`, from the CLI or **from chat on the phone**. Memory has the same gate (`memory.write_approval`). |
| **Read / edit / delete by hand** | Agent37 Files API on `~/.hermes/skills/…`: `GET /v1/files`, `GET|PUT /v1/files/content`, `PATCH /v1/files` (move), `DELETE /v1/files` (`rm -rf`, no undo except backup restore), `GET /v1/files/archive` (whole tree as `.tar.gz`). Or SSH, or VS Code Remote SSH. |
| **Enable / disable without deleting** | Dashboard `PUT /api/skills/toggle` (writes `skills.disabled`). |
| **Protect a skill from the agent** | `hermes curator pin <name>` blocks both the curator and the agent's own `skill_manage`. |
| **Steer where new skills go** | `skills.create_dir` redirects agent-created skills to a directory we choose, for example a git working tree. |
| **History & rollback** | The curator keeps an audit ledger with single-edit rollback. Agent37 backs up `/home/node` nightly (7 rotating slots) plus on-demand, and supports instance **fork**. |

**Proposed shape for kay-os:** make the agent's skills a git repo.

1. Set `skills.create_dir` to a git working tree on the instance, for example
   `~/kay-skills/`, cloned from a **private** repo (it will contain personal
   procedures, so not public `kay-os`).
2. A nightly cron commits and pushes it (`git add -A && git commit && git push`).
   Every lesson the agent learned becomes a diff we can read on GitHub, from
   the phone.
3. Edits flow both ways: we edit in the repo, the cron pulls; or we edit in place
   over the Files API or SSH.
4. Turn on `skills.write_approval` while we calibrate trust, and turn it off once
   the diffs look consistently good.
5. Promote the good ones: when a Hermes-made skill proves generally useful, port
   it into `lossless-agent-skills` deliberately (human-authored, following our
   conventions), not via the agent writing into the shared repo.

**Alternative:** host that repo on Cloudflare Artifacts instead of GitHub, for
a token scoped to one repo, forks per colony member, and push events. See
[[Using-Cloudflare-Artifacts-as-Knowledge-Graph]].

Note the precedence wrinkle: `~/.hermes/skills` (local) outranks
`skills.create_dir`, so bundled and hub skills still win any name clashes.

## A Correction: Memory Is Not a Knowledge Graph (by Default)

Hermes' built-in memory is two small, bounded files: `MEMORY.md` (the agent's
notes, about 2,200 characters) and `USER.md` (the user profile, about 1,375
characters). On top of those it has FTS5 search over past sessions. That's a
curated notebook, not a graph.

A graph comes from **memory-provider plugins**, which run alongside the
built-in memory:

- **Hindsight** (vectorize-io, from the plugin catalog): knowledge graph,
  entity resolution, multi-strategy retrieval, `hindsight_reflect` for
  cross-memory synthesis.
- Others: Holographic, RetainDB and ByteRover ship bundled; Honcho, Supermemory,
  Mem0 and OpenViking are catalog installs. One user story describes an
  `agentmemory` provider shared across Hermes, Claude Code and Cursor, which is
  interesting next to our own Chroma corpus.

So "Hermes builds its own knowledge graph" is true only after we choose and
install a provider. That choice is a real decision for kay-os, because
ADHD/2e support lives or dies on remembering context the person can't hold.
A second option keeps the record outside Hermes: markdown in Cloudflare
Artifacts, with the graph derived from it
([[Using-Cloudflare-Artifacts-as-Knowledge-Graph]]).

## Where the Phone Fits

Hermes reaches the phone through its messaging gateway (Telegram, WhatsApp,
Signal, iMessage via BlueBubbles, and others) or through Hermes Desktop/mobile
pointed at a remote backend. Agent37 documents three more routes: connecting
Hermes Desktop over SSH (`agent37 ssh setup`, host `<id>.agent37.app`, user
`node`), an iMessage line per agent through Inkbox (webhooks wake a sleeping
instance), and a reference texting assistant called `instinct`.

Every route ends up at the same instance, disk and `~/.hermes`, so
customization done over the API shows up on the phone automatically.

## Open Questions

1. **Which app is on the phone?** Agent37's dashboard, a messaging channel
   (Telegram, iMessage), or Hermes' own client? This decides where approvals
   (`/skills approve`) happen.
2. **Profiles per colony member?** Hermes profiles (`~/.hermes/profiles/<name>`,
   each with its own `SOUL.md`, skills, memory and sessions) are selectable per
   turn on Agent37's `POST /v1/responses` via `profile`. The colony could be one
   instance with N profiles, or N instances. Profiles are cheaper; instances
   isolate accounts better (Composio is per *instance*, not per profile).
3. **Which memory provider?** Hindsight for the graph, or something that can
   share memory with Claude Code sessions on the Mac?
4. **Which subset of `lossless-agent-skills` is phone-safe?**
5. **Model and spend.** Use Agent37's managed LLM router with a per-instance
   budget, or bring our own keys (Hermes works with any OpenAI-compatible
   endpoint, Anthropic native, and others)?
6. **Self-evolution beyond the curator.** A Reddit thread reports a Nous
   "Hermes Agent Self-Evolution" project that uses DSPy plus GEPA to optimize
   skill files from execution traces. It's unverified here; read upstream before
   relying on it.

## Suggested First Spike

All of it goes through the existing instance's APIs:

1. `GET /v1/files?path=~/.hermes/skills`: inventory what Hermes has already
   taught itself.
2. Pull it down with `GET /v1/files/archive?path=~/.hermes/skills`, commit it to
   a new private `kay-skills` repo, and read it.
3. Over exec: clone `lossless-agent-skills` read-only, add it to `external_dirs`,
   set `skills.create_dir` to the `kay-skills` clone, and turn on
   `skills.write_approval`.
4. Connect Gmail and Google Calendar through `/integrations/connect`, and add
   one Twenty MCP server via `hermes mcp add`.
5. From the phone: ask it to do one real task, then approve or reject the skill
   write it proposes.

## Sources

- Hermes Agent docs: [home](https://hermes-agent.nousresearch.com/docs/), [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator), [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers), [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), [Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard), [Profile Distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions)
- Hermes release [v0.22.5](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5) (2026-10-22)
- [Hermes Cloud](https://portal.nousresearch.com/cloud) (Nous-hosted alternative)
- Agent37: [Cloud overview](https://www.agent37.com/cloud), [Core concepts](https://www.agent37.com/docs/agents-api/concepts), [Files](https://www.agent37.com/docs/agents-api/files), [Run commands](https://www.agent37.com/docs/agents-api/exec), [App integrations](https://www.agent37.com/docs/agents-api/integrations), [Managed services](https://www.agent37.com/docs/agents-api/managed-services), [Templates](https://www.agent37.com/docs/agents-api/templates), [Custom image](https://www.agent37.com/docs/agents-api/custom-image), [Sessions & profiles](https://www.agent37.com/docs/agents-api/sessions), [Backups](https://www.agent37.com/docs/agents-api/instance-backups), [SSH](https://www.agent37.com/docs/agents-api/ssh), [Hermes Desktop](https://www.agent37.com/docs/agents-api/hermes-desktop), [iMessage](https://www.agent37.com/docs/agents-api/imessage), [docs index (llms.txt)](https://www.agent37.com/docs/llms.txt)
- [Agent37 on Y Combinator](https://www.ycombinator.com/companies/agent-37)
- [r/hermesagent: Self-Evolution (DSPy + GEPA)](https://www.reddit.com/r/hermesagent/comments/1t5ifvg/nous_research_just_dropped_hermes_agent/) (community report, unverified)
