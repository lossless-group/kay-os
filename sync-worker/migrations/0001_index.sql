-- The laptop's index (kaymail.SCHEMA) on D1, minus the IMAP-only mailboxes table.
-- mail/test_kaymail.py checks these tables column for column against SCHEMA.
-- Two differences from the laptop, both on messages:
--   1. mailbox, uidvalidity and uid may be NULL. Mail the laptop fetched has no Gmail
--      UID in R2, so it's indexed from headers alone. Those rows are kept unique by
--      (account, sha256), checked by the writer: SQLite treats NULLs in the UNIQUE
--      below as distinct.
--   2. body holds at most 20,000 characters (laptop: 200,000). The full message is in
--      R2, and D1 caps a database at 10 GB. The writer enforces this, not SQL.

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    mailbox TEXT,
    uidvalidity INTEGER,
    uid INTEGER,
    sha256 TEXT NOT NULL,
    is_primary INTEGER NOT NULL,  -- first sighting of these bytes in this account
    message_id TEXT,
    thread_id TEXT,
    date TEXT,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    labels TEXT,
    flags TEXT,
    size INTEGER,
    attachments TEXT,
    body TEXT,                    -- first 20,000 characters
    UNIQUE (account, mailbox, uidvalidity, uid)
);
CREATE INDEX messages_sha ON messages (account, sha256);
CREATE INDEX messages_date ON messages (date);

-- External content: the writer inserts the FTS row itself, with rowid = messages.id.
CREATE VIRTUAL TABLE messages_fts USING fts5 (
    subject, from_addr, to_addr, body, attachments,
    content='messages', content_rowid='id'
);

CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,          -- of the decoded bytes
    content_type TEXT,                    -- sniffed from bytes, falling back to declared
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,                   -- document | calendar | image | archive | other
    is_noise INTEGER NOT NULL DEFAULT 0,  -- logos, pixels, signature images
    first_seen TEXT,                      -- earliest message date carrying it
    extract_status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | skipped | failed
    extractor TEXT, extractor_version TEXT, extracted_at TEXT,
    pages INTEGER, chars INTEGER, extract_error TEXT
);

CREATE TABLE message_attachments (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    part_index INTEGER NOT NULL,          -- position among the message's MIME parts
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    filename TEXT,
    declared_type TEXT,
    disposition TEXT,                     -- attachment | inline
    content_id TEXT,
    PRIMARY KEY (message_id, part_index)
);
CREATE INDEX message_attachments_att ON message_attachments (attachment_id);
CREATE INDEX attachments_kind ON attachments (kind, is_noise);

CREATE TABLE attachment_scans (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    status TEXT NOT NULL                  -- ok | error, so a backfill never parses a message twice
);
