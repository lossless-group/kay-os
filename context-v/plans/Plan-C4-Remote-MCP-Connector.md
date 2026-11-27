---
title: "Plan C4 — A Remote MCP Connector for the Claude App"
lede: "Let Claude on the phone search the archive, read a message, and open an attachment, through a login only Michael can pass."
date_created: 2026-11-26
date_modified: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.1.0
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

## Stage 2: build

*Rewritten 2026-11-27, after the spec's amendment.* Build v1 of the connector:
login through id.didi.sh and the four mail tools. Calendar tools come in a
later plan, once calendar data is in D1.

### Read first

- `context-v/specs/Mail-Connector-for-the-Claude-App.md`, **the amendment at
  the top wins** over the research sections below it.
- `AGENTS.md` (the hard rule and the read/write split; the connector sends
  them to every client).
- `mail/kaymcp.py` and `mail/test_kaymcp.py`: tool names, arguments,
  untrusted-content markers, and behaviour to match.
- `sync-worker/`: how this repo builds a Worker (`wrangler.jsonc`, hand-written
  runtime types in `src/cloudflare-workers.d.ts`, `src/db.ts` and the
  `test/sqlite-db.ts` D1 stand-in, `test/memory-bucket.ts`, node test runner,
  no frameworks), and `migrations/0001_index.sql` for the tables it reads.
- id.didi.sh, read-only: `https://id.didi.sh/.well-known/oauth-authorization-server`
  and `/.well-known/jwks.json` (one Ed25519 key), and in
  `ai-labs/id-didi-sh` on `origin/main`: `lib/id_didi_sh/oauth.ex` (token
  claims, resource matching) and `config/config.exs` (`oauth_resources`).

### Build

1. **`connector/`**, a new Worker named `kay-os-connector`, its own
   `wrangler.jsonc`, `package.json`, `tsconfig.json`, in `sync-worker/`'s
   style. Bindings: D1 `INDEX` → `kay-os-mail-index` (id
   `e23c087c-9638-432e-9f3a-1980a6412fcd`), R2 `MAIL` → `kay-os-mail`, and a
   second D1 `LOG` for the call log (database to be created by the parent;
   leave a placeholder id and say so). Route:
   `{ "pattern": "mcp.kay-os.lol", "custom_domain": true }`. Variables:
   `ALLOWED_DIDI_ID`, `RESOURCE` = `https://mcp.kay-os.lol`, `ISSUER` =
   `https://id.didi.sh`. No secrets are needed: tokens are verified with
   id.didi.sh's public key.
2. **Discovery and 401.** `GET /.well-known/oauth-protected-resource` (and the
   `/mcp`-suffixed path) returns RFC 9728 metadata naming
   `https://id.didi.sh` as the authorization server and `RESOURCE` as the
   resource. Any MCP request without a valid token gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="…"`.
3. **Token check** (`src/auth.ts`): fetch and cache the JWKS (cache an hour,
   refetch once on an unknown `kid`), verify the EdDSA signature with
   WebCrypto Ed25519, and require `typ` `at+jwt`, `iss` = `ISSUER`,
   `aud` = `RESOURCE`, unexpired `exp`, and `sub` = `ALLOWED_DIDI_ID`. **If
   `ALLOWED_DIDI_ID` is unset, refuse everyone but log the `sub` that tried**
   (only the id), so the first sign-in tells the parent which id to allow.
4. **MCP over streamable HTTP** at `POST /mcp`, JSON-RPC: `initialize` (with
   the instructions string from `kaymcp.py`, hard rule included), `tools/list`,
   `tools/call`, `ping`; notifications get `202`. Plain JSON responses are
   enough; no SSE stream is needed for these tools. Follow the current MCP
   spec's streamable-HTTP rules for the `Mcp-Session-Id` header if Claude
   sends one; keep the server stateless otherwise.
5. **Tools**, read-only, same names and arguments as `kaymcp.py`:
   `search_mail` (D1 FTS5, same filters and `snippet()`), `read_message`
   (D1 row; body from the R2 `.eml` parsed with `postal-mime`, cut at 30,000
   characters; thread by `thread_id`; attachments from D1 without noise),
   `list_attachments`, `get_attachment` (metadata and the messages it came
   on, plus a link the Worker serves itself: `GET /files/<sha>?t=<token>`,
   a 15-minute HMAC-signed token keyed by a secret `FILE_LINK_KEY`, decoding
   the file from the `.eml` and checking its SHA-256). `draft_reply` is not
   included.
6. **Untrusted content**, per the spec: every sender-written field (bodies,
   subjects, senders, filenames, snippets) inside markers with a random tag per
   response, and any marker look-alikes in the content defused.
7. **Call log**: one row per tool call in `LOG` (time, tool, arguments, ok or
   error, `sub`), via a `migrations/0001_log.sql` in `connector/`.
8. **Tests** with the D1 stand-in and memory bucket: discovery documents; 401
   without a token; a token signed by a test Ed25519 key is accepted, and
   wrong `aud`, wrong `iss`, expired, and wrong `sub` are each refused;
   unset `ALLOWED_DIDI_ID` refuses and logs the `sub`; each tool against
   fixture data (reuse `sync-worker/test/fixtures/deck.eml`); an email that
   says "ignore previous instructions" comes back inside markers; a forged
   closing marker in a body is defused; the file link checks its signature,
   expiry, and SHA-256.

### Done when

- `pnpm test` and the pinned `tsc --noEmit` pass in `connector/`; the
  `sync-worker/` and Python suites still pass.
- A local run (`node` against the handler with the stand-ins) answers
  `initialize`, `tools/list`, and a `search_mail` call with a test token.

### Hand back

Branch and commits, test counts, anything in the spec that didn't hold up
against the MCP or Claude docs, and what the parent must do before deploying
(create the `LOG` database, set `FILE_LINK_KEY`, register the resource in
id.didi.sh, set `ALLOWED_DIDI_ID` after the first sign-in).

## Rules for whoever builds this

- Stage 2: branch `cloud-c4-connector` off `development`. No deploy, no
  `--remote`, no `cf.sh`, no changes to id.didi.sh. New dependencies: only
  `postal-mime` (same pinned version as `sync-worker/`).
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
