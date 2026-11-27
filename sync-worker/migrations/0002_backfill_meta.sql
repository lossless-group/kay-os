-- What the backfill (C3) needs to know about mail the Worker fetched before it indexed as it
-- stored (C2): each meta/<account>/<mailbox>/<uidvalidity>/<uid>.json, keyed by the sha256 of its
-- .eml, read once per account so the walk over raw/ doesn't list every meta file each run.
-- Mail the laptop pushed to R2 has no meta file and so no row; it's indexed from headers alone.
-- Not one of the laptop's tables: mail/test_kaymail.py's parity test leaves it out.
CREATE TABLE r2_meta (
    account TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    uidvalidity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    internal_date TEXT,
    flags TEXT,       -- JSON array, as in the meta file
    labels TEXT,      -- JSON array of Gmail labels
    thread_id TEXT,
    PRIMARY KEY (account, sha256)
);
