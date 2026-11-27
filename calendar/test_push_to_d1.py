"""push_to_d1 --dry-run over a synthetic index, its files applied to a stand-in D1.

The stand-in is SQLite with sync-worker/migrations applied, as the Worker tests use.
Standard library only:

  python3 -m unittest discover -s calendar -p "test_push_to_d1.py"
"""

import contextlib
import io
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import push_to_d1  # noqa: E402

ACCOUNT = "me@example.com"
MIGRATIONS = Path(__file__).resolve().parent.parent / "sync-worker" / "migrations"
TRICKY = "Line one\nIt's \"quoted\"; DROP TABLE calendar_events; -- not really\n\x00NUL and ünïcode ✓"


def event(db, uid, account=ACCOUNT, source="takeout", description=None, attendees=(), dates=()):
    cur = db.execute(
        """INSERT INTO calendar_events (source, account, calendar_id, calendar_name, uid, summary, description,
               starts_at, all_day, imported_at)
           VALUES (?, ?, 'Work', 'Work', ?, ?, ?, ?, 0, '2026-11-27T08:00:00+00:00')""",
        (source, account, uid, f"Secret title {uid}", description, dates[0] if dates else "2026-01-01T10:00:00+00:00"))
    for email in attendees:
        db.execute("INSERT INTO calendar_attendees (event_id, email, name, partstat) VALUES (?, ?, ?, 'accepted')",
                   (cur.lastrowid, email, email.split("@")[0]))
    for start in dates:
        db.execute("INSERT INTO calendar_occurrences (event_id, starts_at) VALUES (?, ?)", (cur.lastrowid, start))
    return cur.lastrowid


def d1():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")  # D1 enforces them
    for path in sorted(MIGRATIONS.glob("*.sql")):
        db.executescript(path.read_text())
    return db


def apply(db, files):
    for path in files:
        db.executescript(path.read_text(encoding="utf-8"))


def counts(db, account=ACCOUNT, source="takeout"):
    scope = "SELECT id FROM calendar_events WHERE source = ? AND account = ?"
    return (
        db.execute("SELECT count(*) FROM calendar_events WHERE source = ? AND account = ?", (source, account)).fetchone()[0],
        db.execute(f"SELECT count(*) FROM calendar_attendees WHERE event_id IN ({scope})", (source, account)).fetchone()[0],
        db.execute(f"SELECT count(*) FROM calendar_occurrences WHERE event_id IN ({scope})", (source, account)).fetchone()[0],
    )


class PushToD1Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.index = Path(self.tmp.name) / "index.sqlite"
        db = sqlite3.connect(self.index)
        db.executescript(push_to_d1.kaymail.SCHEMA)
        # Another account's rows come first, so this account's ids don't start at 1.
        event(db, "other-1", account="someone@else.example", attendees=["x@y.example"], dates=["2026-01-01T09:00:00+00:00"])
        self.single = event(db, "single-1", description=TRICKY, attendees=["ada@acme.example", ACCOUNT],
                            dates=["2026-02-01T10:00:00+00:00"])
        event(db, "weekly-1", attendees=["bob@acme.example"],
              dates=[f"2026-03-{d:02d}T17:00:00+00:00" for d in range(1, 29, 7)])
        event(db, "big-1", description="é" * 30_000 + "x" * 40_000, dates=["2026-04-01T10:00:00+00:00"])
        for i in range(30):  # enough rows to need several files at --rows-per-file 10
            event(db, f"bulk-{i}", attendees=[f"p{i}@acme.example"], dates=[f"2026-05-{i % 28 + 1:02d}T10:00:00+00:00"])
        event(db, "google-1", source="google", attendees=["z@acme.example"], dates=["2026-06-01T10:00:00+00:00"])
        db.commit()
        self.laptop = counts(db)
        db.close()

    def push(self, *extra, out="out"):
        args = ["--account", ACCOUNT.upper(), "--source", "takeout", "--db", str(self.index),
                "--out", str(Path(self.tmp.name) / out), "--dry-run", *extra]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            push_to_d1.main(args)
        files = sorted((Path(self.tmp.name) / out).glob("*.sql"))
        return stdout.getvalue(), files

    def test_dry_run_writes_files_that_rebuild_the_laptop_rows_in_d1_with_their_ids(self):
        output, files = self.push("--rows-per-file", "10")
        self.assertEqual(self.laptop, (33, 33, 36))
        self.assertIn("laptop: 33 events, 33 attendees, 36 occurrences (takeout, me@example.com)", output)
        self.assertIn("written: 33 events, 33 attendees, 36 occurrences in", output)
        self.assertIn("ids: D1's highest other id 0 (assumed: dry run); laptop ids kept as they are, 2..34 in D1", output)
        self.assertIn("1 descriptions shortened", output)
        self.assertIn("dry run: nothing sent", output)
        # Counts only: no titles, descriptions or addresses.
        self.assertNotRegex(output, r"Secret title|ada@|acme|Line one")

        names = [f.name for f in files]
        self.assertEqual(names[0], "000-delete.sql")
        self.assertEqual([re.sub(r"^\d+-", "", n) for n in names[1:]],
                         ["events.sql"] * 4 + ["attendees.sql"] * 4 + ["occurrences.sql"] * 4)
        for path in files:
            text = path.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"(?im)^\s*(BEGIN|COMMIT|PRAGMA)\b", path.name)
            for statement in text.split(";\n"):
                self.assertLess(len(statement.encode()), 100_000, path.name)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

        cloud = d1()
        self.addCleanup(cloud.close)
        apply(cloud, files)
        self.assertEqual(counts(cloud), self.laptop)
        self.assertEqual(cloud.execute("PRAGMA foreign_key_check").fetchall(), [])
        laptop = sqlite3.connect(self.index)
        self.addCleanup(laptop.close)
        # Same ids, same values, the tricky text intact but for its NUL.
        self.assertEqual(cloud.execute("SELECT id, uid FROM calendar_events ORDER BY id").fetchall(),
                         laptop.execute("SELECT id, uid FROM calendar_events WHERE account = ? AND source = 'takeout' ORDER BY id",
                                        (ACCOUNT,)).fetchall())
        self.assertEqual(cloud.execute("SELECT description FROM calendar_events WHERE id = ?", (self.single,)).fetchone()[0],
                         TRICKY.replace("\x00", ""))
        self.assertEqual(cloud.execute("SELECT event_id, email FROM calendar_attendees ORDER BY 1, 2").fetchall(),
                         laptop.execute("""SELECT a.event_id, a.email FROM calendar_attendees a JOIN calendar_events e
                                           ON e.id = a.event_id WHERE e.account = ? AND e.source = 'takeout' ORDER BY 1, 2""",
                                        (ACCOUNT,)).fetchall())
        big = cloud.execute("SELECT length(description) FROM calendar_events WHERE uid = 'big-1'").fetchone()[0]
        self.assertTrue(0 < big < 70_000)

        # Rerunning replaces: same counts, not double.
        apply(cloud, files)
        self.assertEqual(counts(cloud), self.laptop)

    def test_ids_move_above_rows_other_pushes_or_create_event_wrote(self):
        cloud = d1()
        self.addCleanup(cloud.close)
        # create_event's rows got ids 1..5 in D1 before this push.
        for i in range(5):
            event(cloud, f"made-{i}", source="google", attendees=["ana@partner.example"], dates=["2026-12-01T10:00:00+00:00"])
        output, files = self.push("--d1-max-id", "5")
        self.assertIn("laptop ids shifted up by 4, 6..38 in D1", output)
        apply(cloud, files)
        self.assertEqual(counts(cloud), self.laptop)
        self.assertEqual(counts(cloud, source="google"), (5, 5, 5), "the other rows are untouched")
        self.assertEqual(cloud.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(cloud.execute("SELECT count(*) FROM calendar_attendees a JOIN calendar_events e ON e.id = a.event_id "
                                       "WHERE e.uid = 'single-1'").fetchone()[0], 2, "attendees follow their event")

        # Laptop ids already above everything else stay put.
        output, _ = self.push("--d1-max-id", "1", out="again")
        self.assertIn("laptop ids kept as they are, 2..34 in D1", output)

    def test_refusals(self):
        with self.assertRaises(SystemExit) as nothing:
            with contextlib.redirect_stdout(io.StringIO()):
                push_to_d1.main(["--account", "nobody@example.com", "--source", "takeout", "--db", str(self.index),
                                 "--out", str(Path(self.tmp.name) / "o"), "--dry-run"])
        self.assertIn("no takeout calendar rows for nobody@example.com", str(nothing.exception))
        checkout = Path(self.tmp.name) / "repo"
        (checkout / ".git").mkdir(parents=True)
        with self.assertRaises(SystemExit) as inside:
            self.push(out="repo/out")
        self.assertIn("inside a git checkout", str(inside.exception))
        self.push(out="used")
        with self.assertRaises(SystemExit) as used:
            self.push(out="used")
        self.assertIn("already holds .sql files", str(used.exception))

    def test_offset_rule(self):
        self.assertEqual(push_to_d1.id_offset([10, 11, 12], 0), 0)
        self.assertEqual(push_to_d1.id_offset([10, 11, 12], 9), 0)
        self.assertEqual(push_to_d1.id_offset([10, 11, 12], 10), 1)
        self.assertEqual(push_to_d1.id_offset([10, 11, 12], 500), 491)
        self.assertEqual(push_to_d1.literal("it's"), "'it''s'")
        self.assertEqual(push_to_d1.literal(None), "NULL")


if __name__ == "__main__":
    unittest.main()
