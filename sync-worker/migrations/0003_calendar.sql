-- The laptop's calendar tables (kaymail.SCHEMA) on D1, column for column; mail/test_kaymail.py's
-- parity test holds them together. Spec: context-v/specs/Calendars-as-Context.md.
-- Rows arrive two ways until C5 syncs Google here: calendar/push_to_d1.py copies the laptop's rows
-- for one account and source (Takeout), and the connector's create_event records the events it
-- creates (source = 'google').

CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,             -- takeout | google | vimcal | mail_invite
    account TEXT NOT NULL,            -- the account whose calendar this is
    calendar_id TEXT NOT NULL,        -- provider calendar id, or the Takeout file's calendar name
    calendar_name TEXT,
    uid TEXT NOT NULL,                -- iCalendar UID: the same meeting across sources
    recurrence_id TEXT NOT NULL DEFAULT '',  -- '' for a single event or a series; set for a changed instance
    sequence INTEGER NOT NULL DEFAULT 0,
    status TEXT,                      -- confirmed | tentative | cancelled
    summary TEXT, description TEXT,   -- description cut at 20,000 characters
    location TEXT, conference_url TEXT,
    starts_at TEXT, ends_at TEXT,     -- ISO 8601 UTC; all-day events as dates
    all_day INTEGER NOT NULL DEFAULT 0,
    tz TEXT,                          -- the event's own time zone
    rrule TEXT,                       -- recurrence rule, as written
    organizer TEXT,                   -- email
    visibility TEXT, transparency TEXT,
    created_at TEXT, updated_at TEXT, -- from CREATED / LAST-MODIFIED
    source_ref TEXT,                  -- file name, provider event id, or attachment id
    imported_at TEXT NOT NULL,
    UNIQUE (source, account, calendar_id, uid, recurrence_id)
);
CREATE INDEX calendar_events_uid ON calendar_events (uid);
CREATE INDEX calendar_events_start ON calendar_events (starts_at);

CREATE TABLE calendar_attendees (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id),
    email TEXT NOT NULL,              -- lowercased
    name TEXT,
    partstat TEXT,                    -- accepted | declined | tentative | needs-action
    role TEXT,                        -- required | optional | chair
    is_organizer INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, email)
);
CREATE INDEX calendar_attendees_email ON calendar_attendees (email);

CREATE TABLE calendar_occurrences (
    event_id INTEGER NOT NULL REFERENCES calendar_events(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    PRIMARY KEY (event_id, starts_at)
);
CREATE INDEX calendar_occurrences_start ON calendar_occurrences (starts_at);
