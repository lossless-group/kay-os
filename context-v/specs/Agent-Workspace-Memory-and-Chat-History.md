---
title: "Agent Workspace — Memory, Chat History, Compression, and Archive"
lede: "kay-os should remember what it was asked, what it found, and what it decided, across every conversation and every device, the way a good chief of staff does. This is the stub for how."
date_created: 2026-11-26
date_modified: 2026-11-26
date_authored_initial_draft: 2026-11-26
date_authored_current_draft: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Draft
site_uuid: 628eb865-c8e3-42bc-8dbe-6995cab377f7
hex_code: jqmmbz
summary: >-
  Stub spec. kay-os is meant to be a full agent workspace, not only a mail
  archive with tools: it needs a record of conversations, a working context
  that survives between sessions, long-term memory of people, commitments,
  and preferences, compression so long histories stay usable, and an archive
  that can be searched and rebuilt. This stub names the problem, what Claude's
  own apps already keep and what they don't, the parts the design has to
  cover, the constraints already decided elsewhere in kay-os, and the
  questions to settle before a real spec. Prior art to read first is the
  memory-layers-for-agents study in ai-labs.
tags:
  - Spec
  - Stub
  - Agent-Workspace
  - Memory
  - Chat-History
  - Context-Engineering
  - Compression
  - Archive
publish: true
type: Specs
---

# Agent Workspace — Memory, Chat History, Compression, and Archive

*Stub, 2026-11-26.* This names the problem and the questions. It isn't ready
to build from.

## Why this exists

The mail archive answers "what did people send me?" It doesn't answer "what
did I ask kay-os last Tuesday, what did it find, and what did we decide?"
Every Claude conversation starts close to empty. The connector serves mail,
not memory. So the same context gets re-explained, decisions made in one chat
are invisible in the next, and a to-do list agreed on the phone doesn't exist
on the laptop.

The goal is a workspace that behaves like a good chief of staff: it remembers
the conversation, keeps a running picture of what's in flight, knows the
people and the commitments, and can say where any of that came from.

## What already exists, and what doesn't

| Piece | Today | Gap |
|---|---|---|
| Claude app conversations | Kept by Claude, in Michael's account. Claude has its own memory and project knowledge. | A connector can't read them. Whatever kay-os should remember has to be written to kay-os by a tool call, or it's lost to kay-os. |
| Claude Code sessions | Transcripts on disk; the tree's Chroma corpus ingests them (`claude-code-sessions`, `claude-code-tool-traces`). | Laptop-only, coding-focused, not shaped as decisions or commitments. |
| kay-os MCP call logs | `logs/mcp-calls.jsonl` on the laptop; the connector spec adds a D1 call log. | A log of tool calls, not of what was concluded. |
| Mail archive | `.eml` in R2, index in D1. | The source material, not memory about it. |

## What the design has to cover

1. **Chat history.** What gets recorded from a conversation, by whom, and
   when: full transcripts, or only what the agent explicitly saves (a
   `remember` or `log_decision` tool)? Given the gap above, explicit saving
   through tools is probably the only reliable path from the Claude app.
2. **Working context.** A small, always-loaded picture of "now": open
   threads, active deals, this week's priorities, the to-do list. Updated
   often, read at the start of every session.
3. **Long-term memory.** People, organizations, commitments ("I said I'd send
   the deck Friday"), preferences, and decision rules, each with where it came
   from (a message id, a conversation, a date) and when it was last confirmed.
4. **Compression.** Rolling summaries so a year of history fits in a context
   window: per conversation, per thread, per person, per week. What is
   summarized, by what model, and how a summary links back to its sources.
5. **Archive.** Everything raw kept, append-only, in R2, so any summary or
   memory can be rebuilt from it, the same principle as the `.eml` files.
6. **Retrieval.** How an agent finds the right memory: keyword, meaning,
   recency, and relationship (the Phase 4 people graph), probably the same
   hybrid search the mail index will use.
7. **Forgetting and correction.** How Michael says "that's wrong" or "forget
   that", and how a memory gets superseded instead of contradicted.

## Constraints already decided elsewhere

- **Cloudflare-first.** No always-on machine at home. R2 for the archive, D1
  for indexes, Workers for tools, as in [[Attachments-as-First-Class-Mail]].
- **Sign-in through id.didi.sh**, as in [[Mail-Connector-for-the-Claude-App]].
- **The hard rule in kay-os `AGENTS.md`:** memory is never a licence to act.
  A remembered preference doesn't count as Michael asking, unless it's a
  signed-off decision rule.
- **Untrusted content stays marked.** A memory that came from an email keeps
  its provenance, so an injected instruction can't become a trusted "fact".

## Consumers waiting on this

- **Daily reports** and the **digest** (v2 of the cloud work): need working
  context to know what's new and what matters.
- **An ongoing to-do list**, spanning devices and conversations.
- **Triage with decision rules** (after the digest): needs signed-off rules
  stored somewhere every agent reads.

## Prior art to read first

- `ai-labs/studies/memory-layers-for-agents/`: Letta, mem0, Graphiti, Honcho,
  Hindsight, supermemory, beads, and others, with the study's checklist
  (storage topology, write policy, scopes, memory schema, recall, eviction).
- `ai-labs/studies/agent-harnesses/` and `agent-workspace-bundles/` for how
  harnesses package context.
- `context-v-corpus/context-v/explorations/Graphiti-Over-The-Lossless-Corpus.md`
  for what LLM-extracted memory cost in practice here.
- `kay-os/studies/study-email-toolkits-agents/` (msgvault, and the field it
  will survey).

## Open questions

- [ ] Explicit memory only (the agent saves what matters), or automatic
      capture as well?
- [ ] One workspace for all of Michael's life, or separate spaces (each
      fund, each client, personal) with explicit crossing?
- [ ] Which model writes summaries, and is that run on Cloudflare (Workers
      AI) or through the Claude API?
- [ ] How does Michael review and correct memory: a page, a chat command,
      a weekly digest of "here's what I now believe"?
- [ ] Build on a memory layer from the study (Letta, mem0, Honcho), or keep
      it as plain tables in D1 plus Markdown in R2, like the rest of kay-os?
