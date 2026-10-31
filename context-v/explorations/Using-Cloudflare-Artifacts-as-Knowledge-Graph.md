---
title: "Using Cloudflare Artifacts as Knowledge Graph — One Git Record Every Agent Can Reach"
lede: "Hermes can pull from Cloudflare Artifacts: it's plain git. Artifacts isn't a graph itself, though. It's the record a graph is built from, with history, undo, and a repo per colony member."
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
site_uuid: 02c7c0da-94a6-4cd0-be28-5441841b0198
hex_code: xbdybx
summary: >-
  Answers whether a Hermes Agent hosted on Agent37 can pull in Cloudflare
  Artifacts (yes: Artifacts is Git hosting, Hermes has a shell and git, and a
  per-repo token is all it needs) and whether Artifacts can serve as kay-os's
  knowledge graph (not by itself: it stores files and history, not nodes and
  edges). Proposes a split already proven in event-hog: Artifacts holds the
  human-readable, wikilinked markdown record with per-commit provenance, and a
  derived index (D1 tables shaped like event-hog's agnostic-crm, or Graphiti
  later) holds the graph, rebuilt from git on every push. Every surface
  (Hermes, Claude Code, Claude on the phone) reaches the same record through
  git or a small Worker MCP. Also maps colony members onto Artifacts repos:
  a read-only baseline imported from lossless-agent-skills, forked per agent.
tags:
  - Exploration
  - Cloudflare-Artifacts
  - Knowledge-Graph
  - Hermes-Agent
  - Agent37
  - Agent-Memory
  - Agent-Skills
  - Cloudflare-D1
  - MCP
publish: true
related:
  - "[[Customizing-Hermes-Agent-through-API]]"
  - "[[2026-10-25_Three-Layers-and-an-Agnostic-CRM-for-Event-Hog]]"
  - "[[Graphiti-Over-The-Lossless-Corpus]]"
  - "[[Memory-Layers-for-the-In-App-Chat-Package]]"
  - "[[Do-We-Need-a-Sandbox-Behind-Homebase]]"
  - "[[cloudflare-artifacts-interface]]"
---

# Using Cloudflare Artifacts as Knowledge Graph

## Why Care?

[[Customizing-Hermes-Agent-through-API]] ended with two loose threads:

1. Hermes' self-made skills should live somewhere we can read, edit and roll
   back. It proposed a private GitHub repo, `kay-skills`.
2. Hermes doesn't build a knowledge graph unless we install a memory provider,
   and choosing one is a real decision, because ADHD/2e support depends on
   remembering what the person can't hold.

We already run Cloudflare Artifacts in production for event-hog
([[2026-10-25_Three-Layers-and-an-Agnostic-CRM-for-Event-Hog]]), and we have
an operating skill for it ([[cloudflare-artifacts-interface]]). So the
question is whether Artifacts answers both threads at once.

**Short answer:** yes for the first, and half-yes for the second. Hermes can
pull from Artifacts today. Artifacts is a good *record* for a knowledge graph,
but it isn't the graph.

## Can Hermes Pull From Artifacts?

**Yes.** Artifacts is Git hosting built for agents: each repo is its own Git
service with a remote URL and its own tokens, and any git client can clone and
push. A Hermes instance on Agent37 has a shell, `git`, and outbound HTTPS, so
nothing about Artifacts is Hermes-specific. Three ways in, from simplest to
most capable:

| Route | How | Credential Hermes holds | Good for |
|---|---|---|---|
| **Plain git** | `git clone` the repo's `remote` into the instance; pull on a cron or before a task | One **repo token** (`art_v1_…`), `read` or `write`, scoped to one repo, TTL up to a year | Skills (via `skills.external_dirs` / `skills.create_dir`) and the markdown record |
| **REST reads** | `GET …/repos/:name/file?ref=&path=`, `/log`, `/tree` without cloning | A **Cloudflare API token** | Avoid for Hermes: that token reaches every repo in the account, not one |
| **Worker MCP** | A small Worker with the `ARTIFACTS` binding, exposing tools like `read_note`, `search`, `log_observation`; added with `hermes mcp add` | A per-person connector URL (later, real OAuth) | Shared access for Hermes, Claude Code and Claude on the phone, with no token on the instance |

The token rules from [[cloudflare-artifacts-interface]] apply unchanged:

- **Never persist a token in `.git/config`.** Pass it as an
  `http.extraHeader` or through a credential helper reading from
  `~/.hermes/.env` (where Hermes already keeps secrets).
- **Use the `remote` the API returns**, never a hand-built URL.
- **Give Hermes repo tokens, never the account API token.** A read token for
  shared baselines, a write token only for the repo that is Hermes' own.

*(Verify on first use: that Agent37's sandbox egress allows
`<ACCOUNT_ID>.artifacts.cloudflare.net`, and that Agent37's git speaks
protocol v1 for push, which Artifacts requires.)*

## Is Artifacts a Knowledge Graph?

**Not by itself.** Artifacts stores files and commits. A knowledge graph is
nodes, typed edges, and a way to walk them. Artifacts has no query over
relationships, no entity resolution, and no index beyond repo-level `search`
on names.

What it *does* give a graph is what graph stores are bad at:

- **A human-readable source of truth.** Notes are markdown with frontmatter
  and `[[wikilinks]]`, the same shape as every `context-v/`. The person can
  read and fix them on a phone.
- **Provenance for free.** Every fact traces to `repo@commit:path`, and every
  commit says who (or which agent) wrote it.
- **Undo.** A bad agent write is a `git revert`, not a database restore.
- **Independence from the instance.** Agent37 backs up `/home/node` nightly,
  but that's a backup of a box. An Artifacts repo outlives the box, and
  another agent can clone it.

The memory-layers exploration already argued the same split:
*"the human-readable markdown layer is irreplaceable for human review"*
([[Memory-Layers-for-the-In-App-Chat-Package]], quoting the Graphiti profile),
and extraction at write time loses information. Graphiti over the changelog
([[Graphiti-Over-The-Lossless-Corpus]]) showed what a graph adds on top:
questions about relationships and change that files can't answer.

## The Proposed Shape: Record in Artifacts, Graph Derived From It

This is event-hog's three-layer decision, minus HubSpot:

| Layer | What it is | Its job |
|---|---|---|
| **Record** | Artifacts repos in a `kay-os` namespace | Markdown notes, skills, observations. Every write is a commit. Edited by people and agents |
| **Graph index** | D1, bound to a Worker | Nodes and edges parsed from the record. Queryable. **Rebuildable from git at any time** |
| **Agent memory** | Hermes' `MEMORY.md` / `USER.md` and, optionally, a provider like Hindsight | Fast, in-context recall on the instance. A cache, not the record |

How a fact moves:

1. Hermes (or the person, or Claude Code) writes or edits a note and pushes.
2. Artifacts' **event subscription** for pushes triggers the Worker.
3. The Worker reads the changed files at that commit, parses frontmatter and
   wikilinks, and upserts nodes and edges in D1, each carrying
   `source = <repo>@<commit>:<path>`.
4. Any agent asks a relationship question ("who did I promise something to
   this week?", "which of my projects is waiting on Sarah?") through the
   Worker MCP, and gets answers that cite the note to open.

**Write order: git first, then the index.** If D1 fails, the git record
stands. Same rule as event-hog, for the same reason.

### What the graph holds

Port event-hog's agnostic-crm model rather than inventing one. Its entities
already fit a personal graph:

| event-hog entity | kay-os use |
|---|---|
| **People, Organizations, Affiliations** | The person's world: family, clients, collaborators, and the roles between them |
| **Observations** (claims with a source, append-only) | What any agent learned, side by side when they conflict. "Kay prefers mornings for deep work," source: a Hermes session, commit `a1b2c3` |
| **Interactions** | Actual contact: calls, messages, meetings. These produce observations |
| **Locations** (human-defined, nested) | "Home", "the studio", "Austin", for place-based reminders |

Two additions a personal assistant needs that event-hog doesn't:

- **Commitments**: a promise with an owner, a counterparty, and a due state.
  The thing ADHD support most needs remembered.
- **Projects**: what commitments and notes roll up to.

### User-authored versus agent-authored

The memory-layers exploration's trust split carries over, and Artifacts makes
it structural rather than a tag:

- **The person's notes** (`notes/`, `reminders/`): high-trust, always loaded.
  Agents propose changes as a branch or a pending write; the person merges.
- **Agent observations** (`observations/`): low-trust, written freely,
  append-only, retrieved by relevance and hedged when quoted.

With Hermes this lines up with `memory.write_approval` and
`skills.write_approval`: approved writes go to the person's tree, everything
else to the agent's.

## Colony Members as Repos

kay-os is "an agent colony," and Artifacts was built for a repo per agent.
That makes the mapping natural:

| Repo | Flag | Who writes | Holds |
|---|---|---|---|
| `kay-os/baseline-skills` | `read_only` | Nobody (re-imported from GitHub) | A phone-friendly subset of `lossless-agent-skills`, imported from the public repo |
| `kay-os/hermes-skills` | — | Hermes, through `skills.create_dir` | What Hermes learned. Replaces the GitHub `kay-skills` repo proposed in the Hermes exploration |
| `kay-os/<agent>-skills` | — | Each future colony member | That member's own skills, forked from the baseline |
| `kay-os/graph` | — | Everyone, through the Worker or git | The shared record: notes, observations, commitments |

Why this beats a private GitHub repo for agent-written skills:

- **One token per repo, scoped and expiring.** A GitHub token for an agent is
  usually broader than one repo.
- **Fork is a first-class call.** A new colony member starts from the
  baseline with its own history and tokens.
- **Events on push** make "reindex the graph" and "tell me what the agent
  learned today" a Worker, not a cron on the instance.

What GitHub still does better: browsing and diffing on the phone. Artifacts
has no web UI of its own, so reading Hermes' changes means the Worker MCP
(Claude on the phone can show a diff), a clone, or a mirror. If the GitHub
review experience matters most, keep `kay-skills` on GitHub and use Artifacts
for the graph only.

## Costs and Limits

From [[cloudflare-artifacts-interface]] (verify against live docs before
committing to it):

- **Open beta** since 2026-10-01. Fine for a personal colony; a reason to keep
  the record exportable (it's git, so it is).
- **1 GB per repo** for new repos, 1 TB per account. Notes and skills are
  tiny. Attachments (voice memos, photos, PDFs) belong in R2, linked from
  notes.
- **Billing** is per account, so bulk repo creation is a decision. A handful
  of colony repos is not.
- **Wrangler can't fork or import.** Use REST or the binding for those.
  Fork, import and delete are still untested in our skill.
- **Jurisdiction is per namespace and permanent.** Decide it before the first
  repo, since the first repo creates the namespace implicitly without one.

## Open Questions

1. **Which Cloudflare account?** The skill's config knows two: `edviro` and
   `lossless` (no namespaces yet). kay-os is personal, so it may want its own
   account, or a `kay-os` namespace in `lossless`. Personal data sitting in
   the Lossless business account is a boundary worth deciding on purpose.
2. **GitHub or Artifacts for Hermes' skills?** Artifacts for scoped tokens,
   forks and push events; GitHub for reviewing diffs on the phone.
3. **D1 now, Graphiti later?** D1 tables are cheap and proven in event-hog.
   Graphiti's bi-temporal edges ("this was true until…") fit a life that
   changes, but bring an LLM extraction bill per episode and a Neo4j to run.
4. **Hindsight on top, or instead?** A memory provider gives Hermes fast
   recall on the instance. If Artifacts is the record, the provider is a
   cache. Worth checking whether Hindsight can be seeded from, or write back
   to, files.
5. **One Worker MCP for every surface?** If Claude on the phone, Claude Code
   and Hermes all use the same connector, the graph is shared without any of
   them holding git credentials. That is event-hog's homebase pattern applied
   to one person.

## Suggested First Spike

Small, reversible, and on the account question's answer:

1. Create a `kay-os` namespace (explicitly, so jurisdiction is a choice) and
   one repo, `hermes-skills`. Mint a write token with a short TTL.
2. On the Agent37 instance, clone it with header auth, point
   `skills.create_dir` at it, keep `skills.write_approval: true`, and add a
   nightly commit-and-push.
3. After a week, read the log with REST (`/log`) and judge whether the
   learned skills are worth keeping.
4. Only then: a `graph` repo, the push-triggered Worker, and the first D1
   migration, copied from event-hog's `migrations/`.

## Sources

- Skill: `context-v/agent-skills/cloudflare-artifacts-interface/SKILL.md` and
  `references/api-map.md` at the anchor monorepo root (tested live 2026-10-25)
- Decision: `self-host-stack/hubs/event-hog-mcp/context-v/decisions/2026-10-25_Three-Layers-and-an-Agnostic-CRM-for-Event-Hog.md`
- Reference implementation: `self-host-stack/hubs/event-hog-mcp/` (Worker,
  `memory-fs.ts`, D1 migrations)
- `context-v-corpus/context-v/explorations/Graphiti-Over-The-Lossless-Corpus.md`
- `ai-labs/context-v/explorations/Memory-Layers-for-the-In-App-Chat-Package.md`
- `self-host-stack/context-v/explorations/Do-We-Need-a-Sandbox-Behind-Homebase.md`
- Cloudflare Artifacts docs: `https://developers.cloudflare.com/artifacts/llms.txt`;
  event subscriptions: `https://developers.cloudflare.com/artifacts/guides/event-subscriptions/`
