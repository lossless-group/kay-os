---
title: "Attachments as First-Class Mail — Find Any Document Ever Sent to Me, by Name, by Words, or by Meaning"
lede: "Twenty years of decks, term sheets, contracts and invoices are already on disk and almost none of it is findable. This spec turns every attachment into something an agent can list, open, read, and search, without adding a single server."
date_created: 2026-11-24
date_modified: 2026-11-26
date_authored_initial_draft: 2026-11-24
date_authored_current_draft: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.2.0
status: Implementing
site_uuid: 417c81b7-006e-4da5-a33e-8191ffc4da39
hex_code: 1htbxa
summary: >-
  Product spec for attachments in the kay-os mail archive, built from the
  exploration Attachments, Search, and a Knowledge Graph. Four phases, each
  shippable alone. Phase 1 inventories every attachment into SQLite (one row
  per unique file by SHA-256, linked to every message it arrived on) and lets
  agents list and open them. Phase 2 converts documents to Markdown with
  Docling and makes their text keyword-searchable. Phase 3 adds search by
  meaning with sqlite-vec and Reciprocal Rank Fusion. Phase 4 builds a
  correspondent graph from headers. Everything stays local in index.sqlite
  plus one folder of Markdown; kaymail's sync stays standard-library only.
  LLM entity extraction, hosted stores, and phone access are out of scope.
tags:
  - Spec
  - Email
  - Attachments
  - SQLite
  - Hybrid-Search
  - Knowledge-Graph
  - MCP
publish: true
type: Specs
---

# Attachments as First-Class Mail

## Summary

The kay-os archive holds 439,135 messages, and about 40,000 of them carry
attachments: pitch decks, term sheets, contracts, financials, invoices,
signed PDFs. Every one of those files is already on disk, inside its original
`.eml`. None of them can be found by what they say. Today an attachment is a
filename in a comma-separated string, and the only way to read one is to open
the raw email by hand.

This spec makes attachments first-class. An agent (or Michael, from the
terminal) will be able to **list** them with real metadata, **open** the
original file, **read** its text, **search** inside it by exact words and by
meaning, and **see who** sent which documents to whom. It ships in four
phases, each useful on its own, and adds no servers: everything lives in the
existing `index.sqlite` plus one folder of Markdown files.

The reasoning behind every choice here, with sources, is in
[[Attachments-Search-and-a-Knowledge-Graph]]. This document is the build.

## Who It's For

- **Michael**, who remembers *that* someone sent the deck, roughly *when*, and
  roughly *what it said*, but not the sender, the subject line, or the
  filename.
- **Agents working the archive** through `kaymcp.py`: triage, follow-up
  drafting, meeting prep, deal research. They need the contents of
  attachments, not just their names, to do any of that well.

## The Jobs to Be Done

Each of these should be one tool call or one command when we're finished:

1. "Show me every PDF Acme sent us in 2025." (Phase 1)
2. "Give me the actual file from that message." (Phase 1)
3. "Find the term sheet that says *1x non-participating*." (Phase 2)
4. "Find the deck where they talked about customer acquisition cost," when the
   slide says "CAC trends." (Phase 3)
5. "Who has sent me documents about Project Falcon, and who else was on those
   threads?" (Phase 4)

## Goals

- Every attachment in the archive is inventoried, deduplicated by content, and
  linked to every message it arrived on.
- Real documents are separated from noise (signature logos, tracking pixels,
  inline images) so results aren't buried.
- Document text is readable as plain Markdown files a person can open, and is
  searchable by keyword and by meaning in one ranked list.
- Agents get all of this through the existing MCP server, with attachment text
  marked as untrusted exactly like email bodies.
- New mail is handled automatically. Every step resumes where it stopped and
  is safe to rerun, like sync is today.

## Non-Goals

- **No new servers.** No Postgres, graph database, vector database service, or
  DuckDB/Parquet copy.
- **No LLM extraction of entities or facts** (Graphiti and similar). Deferred
  until Phase 4 shows where it's worth the cost.
- **No hosted parsing or embedding by default.** Attachment text doesn't leave
  the machine unless Michael chooses an API embedding provider (see Open
  Questions).
- **No phone or Worker access.** That depends on the separate decision about
  making the R2 copy queryable ([[Database-Setup-for-Email]]).
- **No opening of archives.** `.zip`, `.rar`, and similar are inventoried but
  not unpacked in this version.
- **No changes to sync's read-only guarantees.** Nothing here talks to a mail
  server.

## Principles

These settle arguments during the build:

1. **The `.eml` is the source of truth.** Everything in this spec is derived
   from it and can be rebuilt from it. Nothing derived is precious.
2. **Standard library for the core.** Phase 1 adds no dependencies to
   `kaymail.py`. Phases 2 and 3 live in separate modules installed with `uv`,
   and the archive keeps working without them.
3. **One file per unique attachment, named by its hash.** The same PDF
   forwarded thirty times is stored, extracted, and embedded once.
4. **Untrusted in, untrusted out.** Attachments are written by strangers. They
   are parsed in an isolated subprocess with a time limit, never executed, and
   their text reaches agents inside the same untrusted-content markers as
   email bodies.
5. **Owner-only on disk, never in a git checkout.** Same rules as the rest of
   the archive.

## Design

### Storage at a glance

```
~/.local/share/kay-os/mail/
├── raw/<account>/<sha[:2]>/<sha>.eml        # unchanged; source of truth
├── index.sqlite                              # + the new tables below
├── attachments/<sha[:2]>/<sha>.md            # extracted text (Phase 2), pushed to R2
├── attachments/<sha[:2]>/<sha>.read.pdf      # slimmed reading copy of a big PDF (Phase 2), pushed to R2
└── cache/files/<sha[:2]>/<sha>.<ext>         # decoded originals, on demand, local only
```

`attachments/` holds what is expensive to recreate (Docling output) and is
pushed to R2. `cache/` holds what is cheap to recreate (bytes decoded from the
`.eml`) and may be deleted at any time.

### Phase 1: Inventory and access

**Schema** (added to `SCHEMA` in `kaymail.py`):

```sql
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,          -- of the decoded bytes
    content_type TEXT,                    -- sniffed from bytes, falling back to declared
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,                   -- document | image | archive | calendar | other
    is_noise INTEGER NOT NULL DEFAULT 0,  -- logos, pixels, signature images
    first_seen TEXT,                      -- earliest message date carrying it
    extract_status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | skipped | failed (Phase 2)
    extractor TEXT, extractor_version TEXT, extracted_at TEXT,
    pages INTEGER, chars INTEGER, extract_error TEXT
);
CREATE TABLE IF NOT EXISTS message_attachments (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    part_index INTEGER NOT NULL,          -- position among the message's MIME parts
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    filename TEXT,
    declared_type TEXT,
    disposition TEXT,                     -- attachment | inline
    content_id TEXT,
    PRIMARY KEY (message_id, part_index)
);
CREATE INDEX IF NOT EXISTS message_attachments_att ON message_attachments (attachment_id);
CREATE INDEX IF NOT EXISTS attachments_kind ON attachments (kind, is_noise);
```

The existing `messages.attachments` filename string stays, so current search
and tests keep working.

**Kinds.** `kind` is set from the sniffed type, then the declared type, then
the filename extension:

| Kind | What | Example types |
|---|---|---|
| `document` | Something to read | PDF, Word, PowerPoint, Excel, plain text, HTML, Markdown, CSV |
| `calendar` | A meeting invite, update, cancellation, or reply | `text/calendar`, `application/ics`, `.ics` |
| `image` | A picture that isn't noise | PNG, JPEG, GIF, HEIC |
| `archive` | A container | zip, gzip, 7z |
| `other` | Anything else | `application/octet-stream` that can't be identified |

Calendar invites get their own kind because they're structured data, not
prose. In the humain.vc inventory (2026-11-26, 713 messages) they were 59 of
the 149 unique non-noise attachments, about 40%, next to 60 PDFs. Sending
them through Docling would waste time and lose the structure.

**Noise rule.** An attachment is noise when it is an image and any of these is
true: it is under 10 KB, it is inline (or has a `Content-ID`) and under 50 KB,
or the same hash appears on more than 50 messages. *Changed during Phase 1
(2026-11-26):* the draft marked every inline image as noise, but screenshots
pasted into a message body are inline too, and on humain.vc the repeated
signature logos all came in under 33 KB, so inline images now need to be
small as well. The thresholds are constants, tuned once
against the real archive during Phase 1 (see acceptance criteria). Noise is
inventoried, never extracted, and hidden from results unless asked for.

**Writes.** `record_message` fills both tables for each newly stored message,
so new mail is covered by sync. Parsing failures are logged and skipped; they
never fail a sync.

**Backfill.** `kaymail.py attachments --backfill` walks every primary message
with no `message_attachments` rows, parses its `.eml` from disk, and fills the
tables. It needs no network, commits in batches, and resumes where it left off.
It prints progress the way sync does.

**CLI.**

```bash
kaymail.py attachments --from acme --type pdf --since 2025-01-01   # list
kaymail.py attachments --message 1234                              # one message's files
kaymail.py attachments --noise                                     # include logos and pixels
kaymail.py attachment 5678                     # metadata + every message it arrived on
kaymail.py attachment 5678 --save ~/Downloads  # decode and write the original file
kaymail.py attachment 5678 --path              # decode into cache/, print the path
```

`--json` works on all of them, one record per line, like `search`.

**MCP** (`kaymcp.py`):

- `read_message` returns `attachments` as a list of
  `{attachment_id, filename, content_type, size, kind}` (noise omitted)
  instead of the filename string.
- New `list_attachments`: the CLI listing filters, read-only.
- New `get_attachment`: metadata, the messages it arrived on, and the cached
  file path. From Phase 2 on, also the extracted text (cut at the same 30,000
  characters as bodies), wrapped in the untrusted-content markers.

**Housekeeping in scope.** New files and directories are created owner-only
(`0600`/`0700`) through the existing `private_dir` path. `open_db` also
tightens `index.sqlite` to `0600`; it is currently `0644`, which contradicts
the README.

### Phase 2: Extraction and keyword search

**New module `mail/extract.py`**, run as `uv run mail/extract.py` with its own
dependency list. kaymail and kaymcp import nothing from it.

- Picks attachments where `extract_status='pending'`, `is_noise=0`, and `kind`
  is `document` (PDF, Word, PowerPoint, Excel, plain text, HTML, Markdown,
  CSV). Images and archives become `skipped` with a reason. Calendar
  attachments go to the calendar parser below instead.
- Converts each with **Docling** in a subprocess with a time limit (default
  120 s) and a memory limit. Timeouts, crashes, encrypted files, and empty
  output are recorded as `failed` or `skipped` with `extract_error`, and are
  never retried automatically. `--retry-failed` retries them on request.
- OCR runs only when a PDF has no text layer.
- Docling's models are downloaded once at install. Extraction itself runs with
  no network.
- `--limit`, `--since`, and `--kind` let a run be scoped. `--fast` swaps in
  PyMuPDF4LLM for PDFs, for a quick first pass over the backlog.

**Output: one Markdown file per attachment**, written atomically to
`attachments/<sha[:2]>/<sha>.md`:

```markdown
---
sha256: 3f9a…
content_type: application/pdf
size: 482113
pages: 14
filenames: ["Acme Series A Term Sheet v3.pdf"]
first_seen: 2025-03-04T17:22:10+00:00
messages: [1234, 1299, 1301]
extractor: docling
extractor_version: 2.x.y
extracted_at: 2026-12-01T09:14:00+00:00
---

# Acme Series A Term Sheet
…
```

The frontmatter is written by kay-os, not by the document. Document text is
only ever in the body.

**Reading copies of oversized PDFs.** People send 20 MB decks that would read
the same at 3 MB. After Docling has run on the original, `extract.py` makes a
slimmed copy with Ghostscript, the same approach as memopop's
`src/asset_normalize.py` in `investment-memo-orchestrator`:

```bash
gs -dSAFER -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
   -dNOPAUSE -dQUIET -dBATCH -sOutputFile=<sha>.read.pdf <original>
```

`/ebook` lowers embedded images to 150 dpi and leaves text and vector drawing
alone. There's **no size floor**: the goal is less disk and faster transfers
for every file, and a try costs 0.2–5 seconds. Every unsigned PDF gets a try,
and the copy is **judged on what it costs the reader**, not on how big the
original was. It's kept only when it passes all four checks:

1. **Not signed.** No signature field (`/Sig`, `/ByteRange`) and no
   certification (`/DocMDP`). Rewriting a signed contract breaks its
   signature, so signed PDFs are never tried.
2. **Worth it.** At least 25% smaller and at least 100 KB saved
   (`READ_COPY_MIN_SAVING`, `READ_COPY_MIN_BYTES_SAVED`). Shaving 5 KB off a
   60 KB memo isn't worth a second file.
3. **Same words.** The text Ghostscript extracts (`-sDEVICE=txtwrite`) from
   the copy is within 0.5% of the original's (`READ_COPY_MAX_TEXT_DRIFT`).
   This catches the rare file where re-encoding drops characters.
4. **Still legible.** Each page of both files is rendered in grayscale at
   110 dpi, about what a laptop screen shows, and compared with ImageMagick
   (`compare -metric DSSIM`, where 0 means identical). The worst page must
   score at most **0.035** (`READ_COPY_MAX_DSSIM`). Decks over 30 pages are
   checked on 30 pages spread across the deck.

**How 0.035 was chosen.** On humain.vc (2026-11-26), the worst copy of all 60
PDFs scored 0.0317: an 11-page deck whose screenshots of an app's UI went
from 1.8 MB to 0.56 MB. The small UI text in those screenshots got visibly
blockier when zoomed in. Michael opened both side by side and judged the
slimmed one "perfectly great." So the bar sits just above it. If a copy ever
comes back that a person finds too degraded, lower the bar to just under that
copy's score and note it here.

**What the rules did to humain.vc.** Of 60 PDFs (74.8 MB), 11 pass and save
about 16.7 MB (22%). The rest were signed (the big contract-style files, which
would only have shrunk 15–35% anyway), not worth it (mostly text-only memos
under 200 KB that shrink a few KB), or failed the text check (one file lost
2.4% of its characters). Ghostscript made three files *bigger*; those fail
check 2. A gentler setting (200 dpi, `/printer`) was tried on the
lowest-scoring copies and didn't score better, so there's no second try.

The copy is a convenience, never a replacement. **Docling always reads the
original first**, since the original is the evidence and `pdfwrite` can drop
metadata, form fields, links, and the odd character. The one exception: a
scan that Docling can't finish within its time limit is retried on the
slimmed copy, because memopop measured identical OCR output on a 162 MB scan
reduced to 16 MB.

The original stays inside its `.eml` and in R2. `get_attachment` and the
connector hand out the reading copy when there is one, with a flag saying so,
and the original on request. New columns on `attachments`: `read_copy_size`,
`read_copy_status` (`made | signed | not_worth_it | text_drift | illegible | failed`), and `read_copy_dssim`, so the bar can be re-tuned without re-rendering.

Ghostscript printed colour-conversion warnings (`DeviceIndependentColor` with
blending) on several files. The legibility check covers shapes and text, not
colour, so **before this ships, spot-check a few of those in colour**, and if
colours shift, add `-sColorConversionStrategy=LeaveColorUnchanged`.

**This doesn't shrink the archive.** Every original is still inside its
`.eml`, so a reading copy adds bytes. Disk on the laptop is saved another way:
keep originals in R2, and keep only the index, Markdown, and reading copies
locally (`r2.sh pull` without `--raw` already works like this).

**Calendar invites.** `extract.py` parses each `calendar` attachment with the
`icalendar` library (no models, no network) into one row per event:

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    uid TEXT NOT NULL,                 -- the event's UID, stable across updates
    sequence INTEGER NOT NULL DEFAULT 0,
    method TEXT,                       -- REQUEST | CANCEL | REPLY | PUBLISH
    summary TEXT, location TEXT, conference_url TEXT,
    starts_at TEXT, ends_at TEXT, tz TEXT,   -- ISO 8601, with the original zone kept
    rrule TEXT,                        -- recurrence rule, unexpanded
    organizer TEXT,
    attendees TEXT,                    -- JSON: [{email, name, role, partstat}]
    PRIMARY KEY (attachment_id, uid)
);
CREATE INDEX IF NOT EXISTS calendar_events_uid ON calendar_events (uid, sequence);
```

The same meeting arrives many times (the invite, each update, each reply), so
the current state of a meeting is the row with the highest `sequence` for its
`uid`, and a `CANCEL` at that sequence means it was called off. Recurrence
rules are stored, not expanded. A `REPLY` records who accepted or declined.
Summaries and locations come from the sender, so they're treated as untrusted
text like any other attachment.

The MCP gains `list_meetings` (by date range, person, or text), and
`get_attachment` returns the parsed event for a calendar attachment. These rows
also feed Phase 4: an invite is evidence of who meets with whom, which is a
stronger signal than a CC line. And they're the raw material for the
scheduling work in [[Replying-and-Scheduling-on-My-Behalf]].

**Keyword search.** A new FTS5 table indexes the extracted text with the
filename:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS attachments_fts USING fts5 (filename, content);
-- rowid = attachments.id
```

`search_mail` and `kaymail.py search` gain `--in mail|attachments|all`
(default `all`). An attachment hit comes back as its parent message (the
earliest one carrying it), with the attachment id and a snippet from the
document. Existing callers see the same result shape, with attachment hits
added.

**R2.** `r2.sh push` also copies `attachments/`. Unlike `raw/`, these files
can be rewritten when a better extractor runs, so the push compares checksums
instead of using `--immutable`. `cache/` is never pushed.

### Phase 3: Search by meaning (hybrid)

**New module `mail/embed.py`**, also run with `uv`.

- Splits each extracted Markdown file into chunks at headings, with a
  target size of about 500 tokens and a small overlap. Chunks go into a
  `chunks` table: attachment id, order, heading path, text.
- Embeds each chunk through a small provider interface. The default provider
  is a local model; an API provider is an opt-in setting. The model name and
  vector size are recorded in a `vector_meta` table, and changing either
  triggers a full re-embed rather than mixing vectors.
- Stores vectors in a **sqlite-vec** table inside `index.sqlite`.
- Resumable and incremental, like every other step.

**Hybrid ranking.** `search_mail` gains `mode: keyword | meaning | hybrid`
(default `hybrid` once Phase 3 ships, `keyword` before). Hybrid runs the
FTS5 query and the vector query separately and merges them with Reciprocal
Rank Fusion (k = 60), then groups chunk hits by attachment. If sqlite-vec
can't load, search falls back to keyword and says so in the response. It never
errors.

**Scope of embedding.** Attachment chunks only in this phase. Embedding email
bodies or thread summaries is a later decision, made once we see attachment
results.

### Phase 4: Who sent what to whom

Built from headers alone, no LLM, as plain SQLite tables:

- `people`: one row per normalized email address, with display names seen,
  first and last seen, and message counts sent and received.
- `edges`: `(from_person, to_person, kind, count, first_at, last_at)`, where
  kind is `emailed`, `cc_with` (both on the same message), or
  `sent_document` (an attachment went from one to the other). Aggregated, not
  one row per message.
- A rebuild command (`kaymail.py graph --rebuild`) plus incremental updates
  from sync.

**MCP:** a new `who` tool answers "who does Michael correspond with about X"
and "who else is on threads with Y" by combining search results with the
graph. It returns people, counts, and the message and attachment ids behind
each claim, so every answer can be checked.

## Acceptance Criteria

**Phase 1**
- Backfill completes over the full archive on this laptop, survives being
  killed and restarted, and produces the same rows when run twice.
- Every message whose `attachments` string is non-empty has at least one
  `message_attachments` row.
- A hand-checked sample of 50 attachments flagged noise and 50 not flagged
  agrees with the noise rule at least 95% of the time. Thresholds are tuned
  until it does, then frozen as constants.
- `kaymail.py attachment <id> --save` produces a byte-identical file to the
  part in the `.eml`, checked by hash.
- The report from the backfill states totals: unique attachments, by kind,
  noise share, and total size. This answers "how much is there?" before Phase 2
  is sized.

**Phase 2**
- On a test set of 30 real documents chosen by Michael (decks, term sheets,
  spreadsheets, one scanned PDF), the Markdown is readable and tables survive
  in at least 25.
- A malformed or hostile PDF in the test suite times out or fails cleanly
  without stopping the run.
- Searching a phrase that appears only inside a known attachment returns that
  attachment's message first.

**Phase 3**
- On 20 questions Michael writes in his own words about documents he knows
  exist, the right document appears in the top 5 hybrid results for at least
  16, and hybrid beats keyword-only on the same set.
- With sqlite-vec unavailable, search still answers with keyword results.

**Phase 4**
- For 10 people Michael picks, the top correspondents and shared documents
  match his sense of reality, and every answer cites message ids.

**Every phase**
- Tests in the style of `test_kaymail.py` and `test_kaymcp.py`, using the
  fake IMAP server and synthetic `.eml` fixtures. No real mail in tests.
- `python3 -m unittest` passes with only the standard library installed;
  Phase 2 and 3 tests skip cleanly when their dependencies are missing.
- README and a changelog entry ship with the phase.

## Risks

| Risk | Mitigation |
|---|---|
| A crafted attachment exploits the parser | Subprocess, time and memory limits, no network during extraction, never executed, text marked untrusted |
| Prompt injection inside a document | Same untrusted markers as bodies; agents reading attachments still can't send mail (only draft) |
| Docling too slow over the backlog | `--fast` first pass, then Docling on chosen kinds and dates; extraction order is newest first, like sync |
| The noise rule hides a real document | Noise is inventoried, never deleted; `--noise` shows it; rule tuned against a hand-checked sample |
| Index grows large with vectors | Vector size and chunk count measured after Phase 2; documented before Phase 3 starts |
| Embedding with an API leaks private text | Local by default; API is an explicit setting, named in the README |

## Rollout

Each phase is a separate branch off `development`, merged when its acceptance
criteria pass, with its own changelog entry. Phase 1 can start immediately.
Phase 2 starts once Phase 1's totals are known. Phase 3 needs the embedding
decision below. Phase 4 can run in parallel with 2 or 3, since it reads only
headers.

## Open Questions (decisions needed)

- [ ] **Embedding provider for Phase 3.** Local model (private, slow on the
      backlog) or API (fast, sends attachment text out). Proposal: local by
      default, decide the model after measuring Phase 2's volume.
- [ ] **The Phase 2 test set.** Michael picks the 30 documents and writes the
      20 Phase 3 questions.
- [ ] **OCR policy** for scanned documents: only when no text layer (proposed),
      or always.
- [ ] **Archives.** Unpack `.zip` attachments in a later version, or never?
- [ ] **Reading copies beyond PDFs.** Large images (resize to 2,400 px wide,
      as memopop does) and PowerPoint files (convert to PDF first)?
- [ ] **Body embeddings.** Whether, after Phase 3, to embed email bodies or
      per-thread summaries too.

## Related

- [[Attachments-Search-and-a-Knowledge-Graph]]: the exploration behind this spec, with sources
- [[Database-Setup-for-Email]]: how mail is stored today
- [[Mail-Archive-in-Cloudflare-R2]]: the R2 layout `attachments/` joins
- [[Email-Repository-and-Agent-Harness]]: what the archive is for
- [[A-Gateway-Between-Agents-and-My-Accounts]]: why everything from mail is treated as untrusted
