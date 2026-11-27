#!/usr/bin/env python3
"""push_to_d1: copy one account's calendar rows for one source from the laptop index to D1.

Reads calendar_events, calendar_attendees and calendar_occurrences for
(--account, --source) from the laptop's index.sqlite (opened read-only) and
writes them as SQL files for `wrangler d1 execute --file`, in order:

  000-delete.sql            delete that account's rows for that source in D1
  001-events.sql ...        the events, with their laptop ids (see "Ids" below)
  ...-attendees.sql         their people
  ...-occurrences.sql       their dates

Then it runs each file against kay-os-mail-index through sync-worker/cf.sh and
checks D1's counts against the laptop's. With --dry-run it only writes the files
and prints counts. Rerunning replaces, never duplicates: the first file deletes
what the last push wrote. A push that stops halfway leaves D1 partial until the
next run, which starts from the delete again.

Ids. Attendee and occurrence rows point at their event by id, so events keep
their laptop ids, shifted only when they'd collide: the pushed block must sit
entirely above every other row in D1's calendar_events (rows from other pushes,
and the google rows the connector's create_event writes, which SQLite numbers
max(id) + 1). Before writing, the push asks D1 for the highest id outside this
account and source; if the laptop's lowest id isn't above it, every id in the
block moves up by the same offset. In a dry run nothing is asked: D1's highest
other id is --d1-max-id (default 0, an empty table).

D1's limits: no BEGIN/COMMIT in a file (D1 runs a file as one batch), each
statement under 100 KB, so rows are packed into multi-row INSERTs of at most
90 KB, and files of at most --rows-per-file rows and 4 MB.

Prints counts only, never titles, descriptions, locations or addresses. The SQL
files hold real calendar data: they go in a private temporary directory outside
any git checkout, deleted after a successful push. A dry run keeps them and
says where; delete them when done.

  python3 calendar/push_to_d1.py --account michael@learnstart.vc --source takeout --dry-run
  python3 calendar/push_to_d1.py --account michael@learnstart.vc --source takeout

Standard library only. Spec: context-v/specs/Calendars-as-Context.md (Plan C6).
"""

import argparse
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mail"))
import kaymail  # noqa: E402

DATABASE = "kay-os-mail-index"
CF = Path(__file__).resolve().parent.parent / "sync-worker" / "cf.sh"
SOURCES = ("takeout", "google", "vimcal", "mail_invite")
MAX_STATEMENT_BYTES = 90_000   # D1: 100 KB per statement
MAX_FILE_BYTES = 4_000_000
ROWS_PER_FILE = 5_000

EVENT_COLUMNS = ("id", "source", "account", "calendar_id", "calendar_name", "uid", "recurrence_id", "sequence",
                 "status", "summary", "description", "location", "conference_url", "starts_at", "ends_at",
                 "all_day", "tz", "rrule", "organizer", "visibility", "transparency", "created_at",
                 "updated_at", "source_ref", "imported_at")
ATTENDEE_COLUMNS = ("event_id", "email", "name", "partstat", "role", "is_organizer")
OCCURRENCE_COLUMNS = ("event_id", "starts_at", "ends_at")


def literal(value):
    """A SQL literal. Text is quoted with '' doubled; NUL can't be in a SQLite literal, so it goes."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return "'" + str(value).replace("\x00", "").replace("'", "''") + "'"


def scope_sql(account, source):
    return f"source = {literal(source)} AND account = {literal(account)}"


def delete_sql(account, source):
    events = f"SELECT id FROM calendar_events WHERE {scope_sql(account, source)}"
    return [
        f"DELETE FROM calendar_occurrences WHERE event_id IN ({events});",
        f"DELETE FROM calendar_attendees WHERE event_id IN ({events});",
        f"DELETE FROM calendar_events WHERE {scope_sql(account, source)};",
    ]


def read_rows(db, account, source):
    """The scope's rows from the laptop index, events ordered by id."""
    scope = "SELECT id FROM calendar_events WHERE source = ? AND account = ?"
    events = db.execute(f"SELECT {', '.join(EVENT_COLUMNS)} FROM calendar_events "
                        "WHERE source = ? AND account = ? ORDER BY id", (source, account)).fetchall()
    attendees = db.execute(f"SELECT {', '.join(ATTENDEE_COLUMNS)} FROM calendar_attendees "
                           f"WHERE event_id IN ({scope}) ORDER BY event_id, email", (source, account)).fetchall()
    occurrences = db.execute(f"SELECT {', '.join(OCCURRENCE_COLUMNS)} FROM calendar_occurrences "
                             f"WHERE event_id IN ({scope}) ORDER BY event_id, starts_at", (source, account)).fetchall()
    return [list(r) for r in events], [list(r) for r in attendees], [list(r) for r in occurrences]


def id_offset(laptop_ids, d1_other_max):
    """0 if the laptop's ids already sit above every other D1 row, else the shift that puts them there."""
    if not laptop_ids:
        return 0
    low = min(laptop_ids)
    return 0 if low > d1_other_max else d1_other_max + 1 - low


def statements(table, columns, rows, counts, max_rows):
    """Multi-row INSERTs of at most max_rows rows, each under MAX_STATEMENT_BYTES, as (sql, rows) pairs."""
    head = f"INSERT INTO {table} ({', '.join(columns)}) VALUES\n"
    batch, size = [], len(head.encode())
    for row in rows:
        values = "(" + ", ".join(literal(v) for v in row) + ")"
        length = len(values.encode()) + 2
        if len(head.encode()) + length > MAX_STATEMENT_BYTES and table == "calendar_events":
            # One event too big for a statement on its own: its description gives way.
            at = columns.index("description")
            while len(head.encode()) + length > MAX_STATEMENT_BYTES and row[at]:
                row[at] = row[at][: len(row[at]) * 3 // 4]
                values = "(" + ", ".join(literal(v) for v in row) + ")"
                length = len(values.encode()) + 2
            counts["descriptions_shortened"] += 1
        if batch and (size + length > MAX_STATEMENT_BYTES or len(batch) >= max_rows):
            yield head + ",\n".join(batch) + ";\n", len(batch)
            batch, size = [], len(head.encode())
        batch.append(values)
        size += length
    if batch:
        yield head + ",\n".join(batch) + ";\n", len(batch)


def write_files(out, account, source, events, attendees, occurrences, rows_per_file, counts):
    """Write 000-delete.sql and the insert files; return their paths in run order."""
    paths = []

    def write(name, text):
        path = out / f"{len(paths):03d}-{name}.sql"
        path.write_text(text, encoding="utf-8")
        path.chmod(0o600)
        paths.append(path)

    write("delete", "\n".join(delete_sql(account, source)) + "\n")
    for table, columns, rows in (("calendar_events", EVENT_COLUMNS, events),
                                 ("calendar_attendees", ATTENDEE_COLUMNS, attendees),
                                 ("calendar_occurrences", OCCURRENCE_COLUMNS, occurrences)):
        name = table.removeprefix("calendar_")
        chunk, chunk_rows, chunk_bytes = [], 0, 0
        for sql, n in statements(table, columns, rows, counts, rows_per_file):
            size = len(sql.encode())
            if chunk and (chunk_rows + n > rows_per_file or chunk_bytes + size > MAX_FILE_BYTES):
                write(name, "".join(chunk))
                chunk, chunk_rows, chunk_bytes = [], 0, 0
            chunk.append(sql)
            chunk_rows += n
            chunk_bytes += size
            counts[f"{name}_rows"] += n
        if chunk:
            write(name, "".join(chunk))
    return paths


def wrangler(*args):
    """Run wrangler through cf.sh (which brings the Cloudflare token); output is never printed."""
    return subprocess.run([str(CF), *args], capture_output=True, text=True)


def d1_query(sql):
    done = wrangler("d1", "execute", DATABASE, "--remote", "--json", "--command", sql)
    if done.returncode != 0:
        sys.exit(f"D1 query failed (wrangler exit {done.returncode}); nothing was pushed")
    try:
        return json.loads(done.stdout)[0]["results"]
    except (ValueError, KeyError, IndexError):
        sys.exit("Couldn't read wrangler's JSON reply; nothing was pushed")


def private_out_dir(path):
    if path is None:
        return Path(tempfile.mkdtemp(prefix="kay-os-d1-push-"))
    path = Path(path).expanduser()
    kaymail.refuse_git_checkout(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(path.glob("*.sql")):
        sys.exit(f"{path} already holds .sql files; give an empty folder")
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Push one account's calendar rows for one source to D1.")
    parser.add_argument("--account", required=True, help="e.g. michael@learnstart.vc")
    parser.add_argument("--source", required=True, choices=SOURCES)
    parser.add_argument("--dry-run", action="store_true", help="write the SQL files and print counts; touch nothing")
    parser.add_argument("--db", type=Path, help="the laptop index (default: kaymail's index.sqlite)")
    parser.add_argument("--out", type=Path, help="an empty folder for the SQL files (default: a private temp dir)")
    parser.add_argument("--d1-max-id", type=int, default=0,
                        help="dry run only: D1's highest calendar_events id outside this account and source")
    parser.add_argument("--rows-per-file", type=int, default=ROWS_PER_FILE)
    args = parser.parse_args(argv)
    account = args.account.strip().lower()

    path = args.db or (kaymail.data_dir() / "index.sqlite")
    if not Path(path).exists():
        sys.exit(f"No index at {path}")
    db = sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True)
    events, attendees, occurrences = read_rows(db, account, args.source)
    db.close()
    if not events:
        sys.exit(f"The laptop index has no {args.source} calendar rows for {account}; nothing to push")

    if args.dry_run:
        other_max = args.d1_max_id
    else:
        other_max = d1_query(f"SELECT coalesce(max(id), 0) AS max_id FROM calendar_events "
                             f"WHERE NOT ({scope_sql(account, args.source)})")[0]["max_id"]
    offset = id_offset([e[0] for e in events], other_max)
    if offset:
        for e in events:
            e[0] += offset
        for row in attendees + occurrences:
            row[0] += offset

    out = private_out_dir(args.out)
    counts = {"events_rows": 0, "attendees_rows": 0, "occurrences_rows": 0, "descriptions_shortened": 0}
    files = write_files(out, account, args.source, events, attendees, occurrences, args.rows_per_file, counts)

    print(f"laptop: {len(events)} events, {len(attendees)} attendees, {len(occurrences)} occurrences "
          f"({args.source}, {account})")
    print(f"written: {counts['events_rows']} events, {counts['attendees_rows']} attendees, "
          f"{counts['occurrences_rows']} occurrences in {len(files)} files "
          f"({sum(f.stat().st_size for f in files):,} bytes)")
    print(f"ids: D1's highest other id {other_max}{' (assumed: dry run)' if args.dry_run else ''}; "
          + (f"laptop ids shifted up by {offset}" if offset else "laptop ids kept as they are")
          + f", {min(e[0] for e in events)}..{max(e[0] for e in events)} in D1")
    if counts["descriptions_shortened"]:
        print(f"{counts['descriptions_shortened']} descriptions shortened to fit D1's statement limit")

    if args.dry_run:
        print(f"dry run: nothing sent. The files are in {out}; they hold real calendar data, delete them when done.")
        return

    for number, file in enumerate(files, 1):
        done = wrangler("d1", "execute", DATABASE, "--remote", "--yes", "--file", str(file))
        if done.returncode != 0:
            sys.exit(f"{file.name} failed (wrangler exit {done.returncode}) after {number - 1} of {len(files)} files. "
                     f"D1 is partial until a rerun, which starts over from the delete. Files kept in {out}.")
        print(f"sent {file.name} ({number}/{len(files)})")
    scope = scope_sql(account, args.source)
    d1 = d1_query(
        f"SELECT (SELECT count(*) FROM calendar_events WHERE {scope}) AS events, "
        f"(SELECT count(*) FROM calendar_attendees WHERE event_id IN (SELECT id FROM calendar_events WHERE {scope})) AS attendees, "
        f"(SELECT count(*) FROM calendar_occurrences WHERE event_id IN (SELECT id FROM calendar_events WHERE {scope})) AS occurrences")[0]
    print(f"D1 now: {d1['events']} events, {d1['attendees']} attendees, {d1['occurrences']} occurrences")
    if (d1["events"], d1["attendees"], d1["occurrences"]) != (len(events), len(attendees), len(occurrences)):
        sys.exit(f"D1's counts don't match the laptop's. Files kept in {out}.")
    shutil.rmtree(out)
    print("matches the laptop; the SQL files are deleted")


if __name__ == "__main__":
    main()
