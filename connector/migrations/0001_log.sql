-- The connector's call log (spec rule 4), in its own D1 database, kay-os-connector-log, bound as
-- LOG, so the index binding is never written. One row per tool call, download, and refused
-- sign-in. Arguments are what Claude asked for (search terms are useful when auditing what an
-- injected session went looking for). Never tokens, tickets, or anything from an email: no
-- subjects, bodies, senders, or filenames.
CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,          -- UTC, ISO 8601 to the second
    tool TEXT NOT NULL,        -- a tool name, 'download', or 'auth' (a refused, genuine token)
    args TEXT,                 -- JSON: the tool's arguments; for download, {"sha": ...}; for auth, {"reason": ...}
    ok INTEGER NOT NULL,       -- 1 or 0
    error TEXT,
    sub TEXT                   -- the didi account id the token was issued to
);
CREATE INDEX calls_at ON calls (at);
