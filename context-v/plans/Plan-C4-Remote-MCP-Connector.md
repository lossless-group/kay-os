---
title: "Plan C4 — A Remote MCP Connector for the Claude App"
lede: "Let Claude on the phone search the archive, read a message, and open an attachment, through a login only Michael can pass."
date_created: 2026-11-26
date_modified: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.0.1
status: Ready
site_uuid: 5c921919-2492-4feb-9413-0a89d3651c20
hex_code: 3f6fag
summary: >-
  Step C4 of the cloud index, in two stages with a stop between them. Stage 1
  is research and a short spec: how Claude's custom connectors authenticate
  today, which Cloudflare building blocks serve a remote MCP server with
  OAuth, and the security rules (one allowed account, read-only tools,
  untrusted-content markers, call logging). Michael signs that spec off.
  Stage 2 builds a separate connector Worker that serves search_mail,
  read_message, list_attachments and get_attachment from D1 and R2. Needs C1
  to C3 for real data, but stage 1 can start now.
publish: true
type: Plans
---

# Plan C4 — A Remote MCP Connector for the Claude App

Spec: [[Attachments-as-First-Class-Mail]], *Cloud*, step C4. Related:
[[A-Gateway-Between-Agents-and-My-Accounts]], [[Attachments-Search-and-a-Knowledge-Graph]]
(*The phone gets in through Claude*).

## Goal

Michael adds one custom connector in the Claude app. After that, Claude
anywhere (phone included) can search his mail and open attachments, and
nobody else can.

This plan has **two stages with a hard stop between them.** Stage 1 needs
Michael's sign-off, because the login is the whole security story.

## Stage 1: research and a spec (can start now)

1. **Research, from current docs, not memory.** Cite every source.
   - How Claude's custom (remote MCP) connectors authenticate today: OAuth
     flow, dynamic client registration, token lifetimes, which transports
     (streamable HTTP, SSE).
   - Cloudflare's options for a remote MCP server: the `agents` SDK
     (`McpAgent`), `@cloudflare/workers-oauth-provider`, Cloudflare Access in
     front of a Worker. For each: what it needs, how upstream login works
     (Google sign-in restricted to `michael@humain.vc`? GitHub? Access with a
     one-time PIN?), and how it would fit Claude's flow.
   - How the tree's other connectors in the Claude app do it (MemoPop, the
     event CRM). Look for their code in the monorepo (`ai-labs/memopop-ai`,
     `ai-labs/mcps/`) and say what can be reused.
2. **Write `context-v/specs/Mail-Connector-for-the-Claude-App.md`** in the
   repo's spec style (see `Attachments-as-First-Class-Mail.md` for frontmatter
   and tone):
   - The recommended login, with the alternatives and why not.
   - Tools: `search_mail` (D1 FTS), `read_message` (D1 row, body from the R2
     `.eml`, cut at 30,000 characters), `list_attachments`, `get_attachment`
     (metadata, plus a way to get the file: a short-lived signed R2 URL or the
     bytes; recommend one). Same names and argument shapes as
     `mail/kaymcp.py`, so prompts carry over. No drafting, no sending.
   - Security rules: one allowed identity; every tool read-only; email
     bodies, filenames and attachment contents inside the
     untrusted-content markers `kaymcp.py` uses; every call logged (where?);
     token lifetime and revocation; what an attacker who controls one email can
     and can't do through it.
   - Where it lives: a new Worker under `kay-os/connector/`, reading D1 and R2
     with read-only intent. Can it get read-only bindings, or only by
     convention? Say which.
   - Cost and limits.
   - Open questions for Michael.
3. **Stop.** Hand back the spec path and a short summary. Build nothing.

## Stage 2: build (after sign-off)

Outline only. Stage 1 will change it.

- `kay-os/connector/` with its own `wrangler.jsonc`, `package.json`, tests in
  the same style as `sync-worker/` (node test runner, in-memory fakes, the
  C1 node:sqlite D1 stand-in).
- Tools ported from `kaymcp.py`, reading D1 and R2. Tests for each, including
  a prompt-injection fixture (an email that says "ignore previous
  instructions"), which must come back inside the markers.
- Login per the signed-off spec, with a test that a second identity is
  refused.
- The parent session deploys, adds the connector in the Claude app with
  Michael, and runs the spec's acceptance checks from the phone.

## Rules for whoever builds this

- Stage 1 writes one new spec file and nothing else. Branch
  `cloud-c4-connector-spec` off `development`. Commit with the repo's
  conventions, ending with the `Co-Authored-By` line. Don't push or merge.
- **Never touch Cloudflare, the Claude app, or any OAuth provider.** Research
  is reading only.
- Never read, print, or copy secrets.
- Mark anything you couldn't verify from a primary source as unverified.

## Hand back

Stage 1: the spec path, a five-line summary of the recommended login and why,
and the open questions.
