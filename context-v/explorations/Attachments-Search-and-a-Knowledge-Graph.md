---
title: "Attachments, Search, and a Knowledge Graph — Getting What's Inside the Mail Without Building a Data Platform"
lede: "Every attachment I've ever received is already on disk, sealed inside its email. The question is how to open them up for search, meaning-based recall, and a map of who sent what, without standing up five new services to do it."
date_created: 2026-11-24
date_modified: 2026-11-26
date_authored_initial_draft: 2026-11-24
date_authored_current_draft: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.1.2
status: Open
site_uuid: a41f9e8d-01db-49c7-a06a-4a65586ee528
hex_code: jpo8k1
summary: >-
  Surveys 2026 practice for making an email archive and its attachments
  searchable by keyword, by meaning, and by relationship, and picks a mix for
  kay-os. Compares where metadata lives (SQLite, DuckDB plus Parquet), what
  format extracted content takes (Markdown with frontmatter, YAML, JSON, Lua),
  which tool converts attachments (MarkItDown, Docling, PyMuPDF4LLM, Marker),
  where vectors live (sqlite-vec, ChromaDB, a hosted store), and how a graph
  gets built (from headers, or by LLM extraction with Graphiti). Recommends
  SQLite for metadata and every index, one Markdown file per unique attachment
  keyed by its hash, Docling run only on documents worth reading, sqlite-vec
  with rank fusion for hybrid search, and a graph built from headers first,
  with LLM extraction kept to the threads that matter. Lua is ruled out for
  stored content. A second pass weighs libSQL, Postgres with pgvector, and
  SurrealDB against that pick, records what running Graphiti on Neo4j actually
  cost, and reframes phone access as a Claude connector rather than a
  phone-searchable database. With no always-on machine at home, that
  connector runs on Cloudflare (a Worker over D1, Vectorize, and R2, with
  Docling in a Cloudflare Container), and a
  phone keeps at most a slim SQLite or libSQL file.
tags:
  - Exploration
  - Email
  - Attachments
  - SQLite
  - Hybrid-Search
  - Vector-Search
  - Knowledge-Graph
  - Document-Parsing
  - libSQL
  - Postgres
  - SurrealDB
  - MCP-Connectors
  - Tauri
  - Cloudflare-D1
  - Cloudflare-Containers
publish: true
type: Explorations
---

# Attachments, Search, and a Knowledge Graph

## Why Care?

Most of what matters in email arrives as an attachment: the term sheet, the
signed contract, the deck, the invoice, the spreadsheet of numbers. A search
that only reads message bodies misses all of it. Finding "the deck where they
said the CAC was under $200" takes either remembering who sent it or opening
dozens of PDFs.

kay-os already has the bytes. Sync fetches each whole message, so every
attachment is sitting inside its original `.eml` on disk (see
[[Database-Setup-for-Email]]). About 40,000 of the 439,135 archived messages
carry named attachments. What's missing is everything after that: knowing what
each attachment is, reading what's inside it, finding it by meaning and not
just by exact words, and seeing how people, threads, and documents connect.

The risk is overkill. The articles on this topic tend to describe a vector
database, a graph database, a document parser service, an analytics engine, and
an LLM pipeline all at once. This is one person's archive on one laptop. The
goal is the smallest mix of tools that does the job, fits together cleanly, and
can grow later.

## What We Want

1. **Metadata in a database.** Which attachments exist, their type, size, and
   hash, and every message each one arrived on. Fast to filter: "every PDF from
   acme since 2024."
2. **Content in a readable text file.** The extracted text of each attachment
   as a file a person, Obsidian, or an agent can open directly. It shouldn't be
   locked inside a database blob.
3. **Keyword search** over attachment text, the way body search works today.
4. **Search by meaning (vector search)** so "the deck about customer
   acquisition cost" finds a slide titled "CAC trends."
5. **Relationships (a graph):** who sent what to whom, which documents went
   around a deal, which people show up in the same threads.

## What 2026 Practice Looks Like

### msgvault: the closest prior art

[msgvault](https://github.com/kenn-io/msgvault) (also published as
[wesm/msgvault](https://github.com/wesm/msgvault)) is an open-source offline
email archiver with nearly the same shape as kaymail:

- SQLite is the store of record. Parquet files, queried by DuckDB, serve fast
  aggregate queries ([query docs](https://pkg.go.dev/github.com/wesm/msgvault/internal/query)).
- Attachments are stored once by SHA-256, so "the same meeting-notes PDF
  forwarded ten times takes up one copy"
  ([Korben](https://korben.info/en/msgvault-free-your-emails-from-gmail-prison.html)).
- An `extract-attachments` command pulls out and indexes attachment text.
- One announcement reports nearly 2 million emails and 150,000 attachments
  ([LinuxLinks](https://www.linuxlinks.com/msgvault-archive-lifetime-email-chat/)).
- [Issue #154](https://github.com/kenn-io/msgvault/issues/154) (February 2026)
  proposes Graph RAG over the archive, linking people and content and
  summarizing each thread. It's still a proposal.

It also comes with a warning: Parquet aggregates go stale until the next full
rebuild. That's the cost of keeping a second analytics copy next to SQLite.

### Keyword plus vector search in one SQLite file

The local-first pattern in 2026 is "hybrid" search inside one SQLite file:
FTS5 for keywords, [sqlite-vec](https://github.com/asg017/sqlite-vec) for
vectors, and Reciprocal Rank Fusion (RRF) to merge the two ranked lists. RRF
ranks each result by its position in both lists, so it needs no score tuning.

- The [vstash paper](https://arxiv.org/pdf/2604.15484) builds exactly this. Its
  argument: vector search misses exact terms like names, codes, and invoice
  numbers, and keyword search misses paraphrases. You need both.
- A [DEV series on a local email agent](https://dev.to/sviat_barbutsa/how-search-and-ask-work-local-hybrid-rag-with-chromadb-sqlite-fts5-226c)
  pairs FTS5 with ChromaDB and reports about 3-second searches over 18,000
  emails. It embeds a short curated summary plus attachment filenames, not raw
  bodies. It also warns that FTS5 needs escaping for email addresses and
  invoice numbers. This is one blog series, so treat the numbers as anecdotal.
- [PingCAP's look at OpenClaw](https://www.pingcap.com/blog/building-local-first-rag-with-sqlite-for-ai-agent-memory/)
  checks whether sqlite-vec loads and falls back to brute-force search if it
  doesn't. [VecLite](https://pypi.org/project/veclite/) packages the whole
  FTS5 + vector + RRF pattern as a Python library.

### Vector search or a graph? Both, at different jobs

- A [2026 comparison](https://futureagi.com/blog/vector-databases-knowledge-graphs-rag-2025/)
  says production systems use vectors for recall and a graph for relationship
  questions. GraphRAG and LightRAG build on embeddings rather than replace them.
- A [September 2026 preprint](https://arxiv.org/pdf/2610.37728) reports
  GraphRAG answering 16 of 20 enterprise questions, versus 10 for text-to-SQL
  and 3 for vector-only RAG. The misses were relationship questions that
  similarity search can't express. Its arXiv ID looks unusual; verify it before
  leaning on it.
- [Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
  (from Zep, [paper](https://arxiv.org/html/2501.13956)) builds a time-aware
  graph by having an LLM extract entities and facts. A
  [critique](https://dev.to/gentic_news/zep-ais-graphiti-agent-memory-without-schema-is-just-storage-4d7j)
  points out that every step (finding entities, merging duplicates, resolving
  contradictions) is an LLM judgment call. A
  [2026 survey](https://codepointer.substack.com/p/agent-memory-systems-and-knowledge)
  places it next to Mem0 (vectors) and Cognee (an extraction pipeline). One
  case study needed 5–7 minutes for 18 chunks, fine nightly for a notes file,
  but impossible for 440,000 messages.

### Turning attachments into text

- [MarkItDown](https://github.com/microsoft/markitdown) (Microsoft) is fast and
  shallow. In [one hands-on test](https://ndurner.github.io/markitdown-docling-document-parsing)
  it broke tables and returned an empty string for a scanned PDF.
- [Docling](https://arxiv.org/html/2501.17887v1) (IBM Research) keeps tables
  and multi-column layouts and does OCR, at higher compute cost.
- [PyMuPDF4LLM](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/) is a
  light middle option for clean digital PDFs.
- Marker is the accuracy-first option and wants a GPU. LlamaParse is a hosted
  service.
- Comparisons: [DEV](https://dev.to/dmaxdev/markitdown-vs-docling-vs-marker-pdf-to-markdown-for-llms-571o),
  [HURIDOCS](https://huridocs.org/2026/06/markdown-conversion-tool/),
  [a 2026 roundup](https://martinuke0.github.io/posts/2026-01-06-transform-any-document-into-llm-ready-data-top-parsing-libraries-revealed).
  Version numbers and benchmarks differ across sources, so check current
  releases before choosing.

## The Choices, Compared

### Where metadata lives

| Option | Benefits | Trade-offs |
|---|---|---|
| **SQLite, in `index.sqlite`** | Already the index. Joins straight to `messages`. Built into Python. One file to push to R2. | Big aggregate scans are slower than a columnar engine. |
| **SQLite + DuckDB over Parquet** (msgvault's mix) | Very fast counts and breakdowns over millions of rows. | A second copy that goes stale until rebuilt. A new dependency. At 440,000 messages it isn't needed. |
| **Postgres + pgvector** | One server for rows, vectors, and full-text search. | A server to run and back up, for one person on one laptop. |

**Pick SQLite.** Revisit DuckDB only if dashboards over the whole archive feel slow.

### What format extracted content takes

| Format | Benefits | Trade-offs |
|---|---|---|
| **Markdown with YAML frontmatter** | Readable by a person, Obsidian, and an agent. The Chroma ingest, LFM, and context-v tooling in this tree already read it. Headings make natural chunk boundaries for embeddings. | Frontmatter parsing needs a YAML library (or a small, strict reader). |
| **JSON sidecar** | Built into Python. Strict and easy to validate. Good for structured parts: per-page text, tables as rows. | Unpleasant to read long text in. Obsidian won't render it. |
| **YAML only** | Readable, and holds structure. | Long multi-line text in YAML is easy to get subtly wrong. Not much gain over Markdown frontmatter. |
| **Lua tables** | Expressive, and works as both data and config. | Python can't read Lua without running it or writing a parser. **The content comes from attachments that strangers email in, so a single escaping bug in a data file that is also code becomes a way to run their code.** Nothing else in the tree reads Lua. |

**Pick Markdown with frontmatter**, one file per unique attachment, at
`attachments/<sha[:2]>/<sha>.md` next to `raw/`. Add a JSON sidecar only when
a document type needs structure the Markdown can't hold, such as spreadsheet
cells. Lua belongs in config and scripting, not in stored content that came
from outside.

### Which tool converts attachments

| Tool | Good at | Weak at | Fit |
|---|---|---|---|
| MarkItDown | Speed, many formats (docx, pptx, xlsx, html) | Tables, scanned PDFs | Office files and simple docs |
| PyMuPDF4LLM | Fast, clean digital PDFs | Complex layouts, scans | The first pass on PDFs |
| Docling | Tables, layout, OCR | Slower, heavier install | PDFs that matter: decks, term sheets, financials |
| Marker | Highest accuracy | Wants a GPU | Overkill here |
| LlamaParse | Hosted, no setup | Sends private attachments to a third party | Ruled out for this archive |

**Pick Docling as the default**, since one tool is simpler than routing between
three, and narrow it with filters rather than tools. Skip inline logos and
tracking pixels, skip anything already extracted (same hash), and start with
PDFs, Office files, and plain text. If Docling proves too slow over the whole
backlog, fall back to PyMuPDF4LLM for the first pass and send only flagged
documents to Docling.

### Where vectors live

| Option | Benefits | Trade-offs |
|---|---|---|
| **sqlite-vec inside `index.sqlite`** | Same file as metadata and FTS5, so a hybrid query is one SQL statement with RRF. Goes to R2 with everything else. | A loadable extension. Some Python builds (macOS system Python, for one) ship `sqlite3` without extension loading; use a `uv`-managed Python. |
| **ChromaDB** (the tree's existing corpus) | Already running here, with an MCP server agents know. | A second store that has to stay in sync with SQLite. Hybrid ranking happens in our code, across two systems. |
| **A hosted vector store** | Reachable from the phone and the Worker. | Sends private mail text to a third party. Another bill. |

**Pick sqlite-vec.** Keep Chroma for the context-v corpus it already serves.
Revisit hosting when the phone needs meaning-based search, likely together with
the D1 question in [[Database-Setup-for-Email]].

### How the graph gets built

| Approach | Benefits | Trade-offs |
|---|---|---|
| **From headers, in SQLite** | No LLM. Exact. Covers the whole archive in minutes. People, addresses, threads, and "sent this attachment to" edges come straight from From/To/Cc, thread ids, and the attachments link table. | Knows who talked to whom, not what about. |
| **LLM extraction (Graphiti or similar)** | Finds companies, deals, amounts, and commitments inside the text, with time awareness. | Slow and costly at archive scale. Every edge is a model judgment that can be wrong. Needs a graph database (Neo4j or FalkorDB). |
| **A graph database for everything** | Rich graph queries. | Another server, and most of the value is already in the header graph. |

**Build the header graph first**, as plain tables in SQLite. Run LLM extraction
only on a chosen slice (active deals, a client's threads, the attachments
flagged as important), and only once the header graph shows where it's worth
it. We have already run Graphiti over our own corpus, and the numbers argue
hard against using it at archive scale (see
[[#Graphiti and Neo4j, from experience]]).

## The Recommended Mix

Five pieces, all running locally, two files to back up:

1. **`index.sqlite`**, extended with:
   - `attachments`: one row per unique attachment (hash, type, size, extraction status)
   - `message_attachments`: links attachments to every message they arrived on, with filename, part index, and inline-or-attached
   - `attachments_fts`: FTS5 over extracted text
   - `chunks` + a sqlite-vec table: embeddings of attachment chunks, and later of thread summaries
   - `people` and `edges`: the header graph
2. **`attachments/<sha[:2]>/<sha>.md`**: the extracted content, with frontmatter
   pointing back to the hash, the message ids, the extractor and its version,
   and the page count.
3. **Docling**, run as an optional step installed with `uv`, so kaymail's sync
   stays standard-library only.
4. **An embedding model**, local or via an API (see Open Questions).
5. **One hybrid search call**: FTS5 and vector results merged with RRF, exposed
   as a `search_mail` option and a new `get_attachment` tool in `kaymcp.py`.

How they fit: sync keeps writing raw `.eml` files. A separate `extract` step
reads the new ones, fills the metadata tables, writes Markdown, and updates
FTS5. An `embed` step chunks new Markdown into vectors. Each step resumes where
it left off and can be rerun, like sync. `r2.sh` already pushes `index.sqlite`.
The `attachments/` folder would be pushed the same way as `raw/`: named by
hash, never overwritten.

**Left out on purpose:** DuckDB/Parquet, Postgres, a graph database, a hosted
vector store, Marker, and LLM extraction across the whole archive. Each one can
be added later without redoing the pieces above.

## Second Pass: libSQL, Postgres, SurrealDB, and the Phone

*Added 2026-11-25, after review.* Five challenges to the first pass, each with
a verdict. Some of them move the recommendation; most of them sharpen it.

### libSQL instead of plain SQLite

The case for it: [libSQL](https://github.com/tursodatabase/libsql) is a fork of
SQLite, maintained by a company (Turso) and open to outside contributions,
which SQLite itself is not. It reads and writes ordinary SQLite files, and it
adds things we'd otherwise bolt on.

**One correction.** libSQL is not the Rust one. libSQL is the original C code
base, forked; its server and client libraries are where the Rust lives. The
Rust rewrite is a separate project, [Turso Database](https://blog.openreplay.com/turso-rust-sqlite-evolution/)
(formerly Limbo), and it is still in beta. Turso's own
[libSQL repo](https://github.com/tursodatabase/libsql) says new features are
being developed in Turso Database. So "maintained by a whole company" cuts both
ways: libSQL is [production-ready](https://docs.turso.tech/libsql), but the
company's attention has moved to the rewrite
([layerbase's summary](https://layerbase.com/blog/libsql-vs-turso)). One
source says hosted edge replicas are closed to new users; we couldn't confirm
that from Turso's docs.

What libSQL would earn us here:

| Feature | Why it matters for kay-os |
|---|---|
| **Native vector columns and index** | Replaces sqlite-vec, which is a loadable extension that some Python builds refuse to load. One less moving part. |
| **Embedded replicas** | A local file that syncs from a remote primary. This is the cleanest answer anywhere in this doc to "SQLite only works where the file is." |
| **SQLite file compatibility** | Everything in the first pass works unchanged. Moving later is a driver swap, not a migration. |

What to check before switching: the state of the Python client (we couldn't
confirm its FTS5 support or DB-API behavior in this pass), and whether sync
should stay on the standard library's `sqlite3`.

**Verdict: yes, as the upgrade path, not the starting point.** Write the schema
so it runs on both. Switch to libSQL when we add vectors (Phase 3 of the
spec), since that's the step where sqlite-vec's extension loading would bite.
Don't wait for the Rust rewrite.

### Graphiti and Neo4j, from experience

We already ran this stack over the context-v corpus, and it's written up in
`context-v-corpus/context-v/explorations/Graphiti-Over-The-Lossless-Corpus.md`
and its companion reminder, `Chroma-and-Graphiti-Gotchas.md`. The numbers:

- **Hosted (Claude Haiku):** $0.759 and about 46 seconds per episode.
- **Local (Gemma 3 12B):** free, but about 1,050 seconds per episode, and the
  rate got worse as the graph grew.
- Episodes must be replayed oldest-first, so the work doesn't parallelize well.

For 440,000 messages at one episode each, that's about $334,000 hosted, or
about 14 years local. Even a 1% slice (4,400 threads) is about $3,300 and 56
hours. On top of that, Neo4j's browser and Cypher didn't make the graph
legible to a person, and a graph nobody can read isn't a second brain.

**Verdict: this confirms the first pass.** The header graph goes in plain
tables. LLM extraction stays limited to a chosen slice, and its output goes into
the same tables, not into Neo4j.

### SurrealDB

SurrealDB does handle embeddings. The 3.x line has HNSW vector indexes, with
[DiskANN added in 3.1](https://surrealdb.com/blog/surrealdb-3-1-stability-diskann-and-a-new-release-process),
BM25 full-text search, hybrid search merged by RRF, and graph edges that are
records in their own right ([features](https://surrealdb.com/features)). One
statement can mix a graph traversal, a vector search, and a keyword match. It
runs embedded or as a server, and
[4.0 shipped in November 2026](https://www.blocksandfiles.com/architecture/2026/11/05/surrealdb-supplies-faster-performance-and-more-scalbility-with-major-v40-update/5307871).
Caveats: the speed numbers are the
[vendor's own benchmarks](https://surrealdb.com/blog/surrealdb-3-0-benchmarks-a-new-foundation-for-performance),
and the license appears to be the Business Source License. Check it before
building anything commercial on it.

The better argument for SurrealDB isn't the brand. **augment-it already runs
it** as its canonical layer, with persons, organizations, affiliation edges, an
observations log, an MCP server (surrealmcp), and a skill
(`surrealdb-canonical-layer`). It's the one graph-capable database this tree
already knows how to operate. Correspondents in the mail archive and persons in
augment-it are the same kind of thing.

That's also the risk. augment-it is multi-tenant client data, and this archive
is private mail. Joining them makes a leak in either one a leak of both.

**Verdict: not now, but it's the graph database we'd pick if we ever need
one.** The header graph in SQL tables comes first. If relationship questions
outgrow recursive SQL, SurrealDB beats Neo4j for us, on familiarity, on
legibility, and because it holds vectors in the same store. If we do adopt it,
the mail graph gets its own namespace, never augment-it's tenant tables.

### Postgres with pgvector

The direct answer: **if we pick Postgres, we don't need SQLite or libSQL for
the index.** Postgres does the rows, keyword search (`tsvector`), vectors
(pgvector), and graph walks (recursive queries, or Apache AGE). The raw `.eml`
files stay either way. Running both would mean two copies of the truth to
keep in sync, for nothing.

| | Embedded file (SQLite / libSQL) | Postgres + pgvector |
|---|---|---|
| Runs as | A file opened by whatever needs it | A server that must always be up |
| Backup | Copy one file to R2 | `pg_dump`, or the host's snapshots |
| Remote access | Only via a replica (libSQL) or a connector in front | Native, and from a Worker via Hyperdrive if hosted (Neon, Supabase) |
| Fits Tauri | Yes, it embeds | No, the app would be a client to a server |
| Fits msgvault | Same family (it uses SQLite) | Would mean replacing msgvault's store |
| Industry standard | For on-device and local-first | For servers |

**Verdict: stay with SQLite-family files.** Postgres is the right call if
kay-os becomes a fully server-side service. The always-on part runs on
Cloudflare as D1, which is SQLite too (next section).

### The phone gets in through Claude, not through the database

This is the biggest change to the first pass. If the phone reaches the
archive by chatting with Claude in the Claude app, and Claude works through a
connector, then **the phone never queries the database. Claude calls the
connector, and the connector queries the database.** The tree already runs
custom connectors this way (the MemoPop and event CRM connectors in the Claude
app), so the pattern is proven here.

"SQLite only works where the file is" then becomes "the connector has to be
reachable from Claude, all the time." There's no always-on machine at home,
and the laptop sleeps, so **the connector runs on Cloudflare.** That's less of
a privacy step than it sounds: the raw `.eml` files are already in R2, so
Cloudflare already holds the archive. This adds the index and the extracted
text, at the same provider.

| Piece | On Cloudflare | Notes |
|---|---|---|
| Connector | A Worker serving MCP over HTTP, with OAuth | Cloudflare publishes an agents SDK and an OAuth provider library for remote MCP servers on Workers; confirm current versions before building. |
| Metadata, keyword search, header graph | D1 (hosted SQLite) | The same schema as `index.sqlite`. **D1 caps a database at [10 GB](https://developers.cloudflare.com/d1/platform/limits), and that cap can't be raised.** Today's index is 3 GB. Split by account (one database per mailbox) from the start. Confirm FTS5 works on D1, including export and import of FTS tables, before relying on it. Rows have a 1–2 MB size cap (the docs disagree), so long bodies get truncated in the index, and the full text stays in R2. |
| Vectors | Vectorize | Replaces sqlite-vec and libSQL vectors on the cloud side. Hybrid search becomes a few lines in the Worker: query D1 FTS5 and Vectorize, then merge with RRF. |
| Raw mail and extracted text | R2 | Already there for raw mail. `attachments/<sha[:2]>/<sha>.md` goes in next to it. |
| Embeddings | Workers AI, or computed on the laptop | Workers AI keeps the text inside Cloudflare and needs no laptop. |
| Attachment extraction | Cloudflare Containers running Docling | Docling runs layout, table, and OCR models locally on CPU (PyTorch plus several hundred MB of weights), so it can't run in a Worker. A Container can, since it runs an ordinary Docker image on demand and scales to zero when idle. New mail lands in R2, a Queue message goes out, and a Worker hands the attachment to the Docling container, which writes the `.md` to R2 and the row to D1. Check that the largest instance size has enough memory for Docling (a few GB), and what the per-page cost comes to. Workers AI's document-to-Markdown conversion could take simple files cheaply; test it against Docling on a sample. |

Who writes what: the sync Worker already stores new mail in R2. It also inserts
the D1 rows, so the cloud index stays current without the laptop. The laptop
pushes the backlog once, and can run the first big Docling and embedding pass
over it for free, since it's already on local disk. After that, extraction
runs in the Container, and nothing waits on the laptop. R2 holds the source of truth, and the laptop's
`index.sqlite` and D1 are both rebuildable from it.

**The alternative to D1 is hosted libSQL (Turso).** It has no 10 GB cap and
has native vectors, and Workers can reach it over HTTP. But it's a second
vendor holding the mail. Stay on D1 and Vectorize unless the cap or FTS5 gets
in the way.

The connector needs things a local tool didn't: OAuth tied to one account,
read-only tools by default, drafts but never sends, and the untrusted-content
markers `kaymcp.py` already applies. A prompt injection in any email now
reaches a Claude session that can see everything. That deserves its own spec.

### What lives on the phone itself

SurrealDB is too heavy to put on a phone, and a 73 GB archive doesn't belong
there either. If there's ever a phone app, beyond chatting with Claude, it keeps
**a small SQLite or libSQL file with just enough to look things up**: people,
thread headers for recent months, attachment metadata, and anything pinned.
Tapping a message or attachment fetches it from the Worker.

One catch: a libSQL embedded replica copies the *whole* database. So the phone
file is its own slim database that the Worker builds, not a replica of the full
index.

That puts SurrealDB, if we ever use it, on the server only.

### Tauri for a native app

memopop (`apps/memopop-native`) and flave already ship Tauri wrappers, so a
kay-os app has a known path. Tauri 2 targets desktop, iOS, and Android. Through
the SQL plugin or libSQL's Rust crate, the same app embeds the full index on
the laptop and the slim file on the phone. Both talk to the Worker for anything
they don't hold. Postgres can't embed, and SurrealDB is too heavy for the phone
build.

**Verdict:** SQLite-family files on every device, plus Cloudflare for
everything that has to be always on.

### The revised mix

1. **Laptop:** `index.sqlite` stays the full local index, with the schema kept
   compatible with D1 and libSQL. The laptop runs the one-time backfills.
2. **Cloud (always on):** a Worker MCP connector over D1 (one database per
   account), Vectorize, and R2. The sync Worker keeps D1 current as mail
   arrives, and a Docling Container extracts new attachments. Turso is the fallback if D1's limits bite.
3. **Phone:** Claude in the Claude app through that connector first. A
   Tauri app with a slim SQLite or libSQL file comes later, if ever.
4. **Graph:** header tables, in D1 and locally. LLM extraction only on a
   slice. No Neo4j. SurrealDB, if a graph database is ever earned, runs on the
   server only.
5. **Not Postgres.** It would only make sense if we dropped the files and went
   fully server-side, and Cloudflare already covers server-side for us.
6. **msgvault** uses SQLite too. It's local-only, so if we adopt it, the
   Cloudflare layer is still ours to build.

## Open Questions

- **Embedding model: local or API?** Local keeps the mail on the machine but
  costs laptop time for the backlog. An API is fast but sends attachment text
  to a provider. Possibly local for the backlog, with the model chosen once
  we've measured.
- **How much is there?** Count the unique attachments by hash and type before
  sizing the backfill. That's a read-only pass over `raw/`.
- **Scanned documents.** Docling's OCR is slow. Run OCR on everything, or only
  when no text layer is found?
- **Thread summaries.** The DEV series embeds summaries, not raw bodies. Is a
  per-thread summary worth an LLM pass, and for which threads?
- **Phone access.** Reframed in
  [[#The phone gets in through Claude, not through the database]]: the
  question is now where the connector runs, not which database the phone
  can reach.
- **The Worker's 48 MB limit.** Mail the Cloudflare Worker syncs skips messages
  over 48 MB, so their attachments only arrive through the laptop sync.

## See Also

- [[Database-Setup-for-Email]]: how mail is stored today
- [[Mail-Archive-in-Cloudflare-R2]]: the R2 layout attachments would join
- [[Email-Repository-and-Agent-Harness]]: what the archive is for
- [[A-Gateway-Between-Agents-and-My-Accounts]]: why attachment text stays marked as untrusted
