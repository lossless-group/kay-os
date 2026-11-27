"""Imports small synthetic Takeout folders into a throwaway index.

Needs icalendar and recurring-ical-events, so run it through uv:

  uv run --with icalendar==7.3.2 --with recurring-ical-events==3.8.2 \\
      python -m unittest discover -s calendar -p "test_*.py"
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
MISSING = ""
try:
    import import_takeout
except ImportError as error:  # icalendar or recurring-ical-events missing
    import_takeout = None
    MISSING = str(error)

ACCOUNT = "me@example.com"
HEADER = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Google Inc//Google Calendar 70.9054//EN\r\nX-WR-TIMEZONE:America/Los_Angeles\r\n"
FOOTER = "END:VCALENDAR\r\n"


def vevent(*lines):
    return "BEGIN:VEVENT\r\n" + "".join(f"{line}\r\n" for line in lines) + "END:VEVENT\r\n"


SINGLE = vevent(
    "UID:pitch-1@google.com",
    "DTSTART:20240305T170000Z",
    "DTEND:20240305T180000Z",
    "SUMMARY:Pitch",
    "STATUS:CONFIRMED",
    "SEQUENCE:2",
    "ORGANIZER;CN=Ada Founder:mailto:Ada@Acme.example",
    "ATTENDEE;CN=Ada Founder;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ada@acme.example",
    "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT:mailto:ME@example.com",
    "ATTENDEE;PARTSTAT=DECLINED:mailto:bob@acme.example",
    "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
    "DESCRIPTION:" + "x" * 25_000,
)
WEEKLY = vevent(  # five Mondays, the second skipped, the third moved to Tuesday
    "UID:weekly-1@google.com",
    "DTSTART;TZID=America/Los_Angeles:20240101T100000",
    "DTEND;TZID=America/Los_Angeles:20240101T110000",
    "RRULE:FREQ=WEEKLY;COUNT=5",
    "EXDATE;TZID=America/Los_Angeles:20240108T100000",
    "STATUS:CONFIRMED",
    "ORGANIZER:mailto:me@example.com",
) + vevent(
    "UID:weekly-1@google.com",
    "RECURRENCE-ID;TZID=America/Los_Angeles:20240115T100000",
    "DTSTART;TZID=America/Los_Angeles:20240116T120000",
    "DTEND;TZID=America/Los_Angeles:20240116T130000",
    "STATUS:CONFIRMED",
)
DAILY = vevent(  # never ends
    "UID:standup@google.com",
    "DTSTART:20241225T160000Z",
    "DTEND:20241225T161500Z",
    "RRULE:FREQ=DAILY",
)
ALL_DAY = vevent(
    "UID:offsite@google.com",
    "DTSTART;VALUE=DATE:20240610",
    "DTEND;VALUE=DATE:20240612",
)
CANCELLED = vevent(
    "UID:dropped@google.com",
    "DTSTART:20240401T150000Z",
    "DTEND:20240401T160000Z",
    "STATUS:CANCELLED",
)
ANCIENT = vevent(
    "UID:birthday-1933@google.com",
    "DTSTART;VALUE=DATE:19330412",
    "DTEND;VALUE=DATE:19330413",
)
BROKEN = vevent("UID:broken@google.com", "DTSTART:garbage")


@unittest.skipIf(import_takeout is None, f"icalendar not importable ({MISSING}); "
                 "run with uv run --with icalendar==7.3.2 --with recurring-ical-events==3.8.2")
class ImportTakeoutTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["KAYMAIL_DATA"] = f"{self.tmp.name}/data"
        self.folder = Path(self.tmp.name) / "Calendar"
        self.folder.mkdir()
        self.write("Work", SINGLE, WEEKLY, DAILY, ALL_DAY, CANCELLED, ANCIENT, BROKEN)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, *events):
        (self.folder / f"{name}.ics").write_text(HEADER + "".join(events) + FOOTER)

    def run_import(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            import_takeout.main([ACCOUNT, str(self.folder), "--expand-until", "2025-01-05", *extra])
        self.db = import_takeout.kaymail.open_db()
        self.addCleanup(self.db.close)
        return out.getvalue()

    def event(self, uid, recurrence_id=""):
        return self.db.execute("SELECT * FROM calendar_events WHERE uid=? AND recurrence_id=?",
                               (uid, recurrence_id)).fetchone()

    def occurrences(self, event_id):
        return [tuple(r) for r in self.db.execute(
            "SELECT starts_at, ends_at FROM calendar_occurrences WHERE event_id=? ORDER BY starts_at", (event_id,))]

    def test_single_event_with_attendees_and_organizer(self):
        self.run_import()
        event = self.event("pitch-1@google.com")
        self.assertEqual((event["source"], event["account"], event["calendar_id"], event["calendar_name"]),
                         ("takeout", ACCOUNT, "Work", "Work"))
        self.assertEqual((event["starts_at"], event["ends_at"], event["all_day"]),
                         ("2024-03-05T17:00:00+00:00", "2024-03-05T18:00:00+00:00", 0))
        self.assertEqual((event["status"], event["sequence"], event["organizer"], event["source_ref"]),
                         ("confirmed", 2, "ada@acme.example", "Work.ics"))
        self.assertEqual(event["conference_url"], "https://meet.google.com/abc-defg-hij")
        self.assertEqual(len(event["description"]), 20_000)
        self.assertEqual(self.occurrences(event["id"]), [("2024-03-05T17:00:00+00:00", "2024-03-05T18:00:00+00:00")])
        people = [tuple(r) for r in self.db.execute(
            "SELECT email, name, partstat, role, is_organizer FROM calendar_attendees WHERE event_id=? ORDER BY email",
            (event["id"],))]
        self.assertEqual(people, [
            ("ada@acme.example", "Ada Founder", "accepted", "required", 1),
            ("bob@acme.example", None, "declined", None, 0),
            ("me@example.com", "Me", "needs-action", "optional", 0),
        ])

    def test_weekly_series_with_exdate_and_moved_instance(self):
        self.run_import()
        series = self.event("weekly-1@google.com")
        self.assertEqual(series["rrule"], "FREQ=WEEKLY;COUNT=5")
        self.assertEqual(series["tz"], "America/Los_Angeles")
        self.assertEqual([s for s, _ in self.occurrences(series["id"])], [
            "2024-01-01T18:00:00+00:00", "2024-01-22T18:00:00+00:00", "2024-01-29T18:00:00+00:00"])
        moved = self.event("weekly-1@google.com", "2024-01-15T18:00:00+00:00")
        self.assertEqual(self.occurrences(moved["id"]), [("2024-01-16T20:00:00+00:00", "2024-01-16T21:00:00+00:00")])
        # The organizer is an attendee row even when no ATTENDEE names them.
        self.assertEqual(self.db.execute("SELECT email, is_organizer FROM calendar_attendees WHERE event_id=?",
                                         (series["id"],)).fetchall()[0][:], ("me@example.com", 1))

    def test_open_ended_series_stops_at_expand_until(self):
        self.run_import()
        standup = self.event("standup@google.com")
        dates = [s for s, _ in self.occurrences(standup["id"])]
        self.assertEqual(dates[0], "2024-12-25T16:00:00+00:00")
        self.assertEqual(dates[-1], "2025-01-05T16:00:00+00:00")
        self.assertEqual(len(dates), 12)

    def test_all_day_event_is_stored_as_dates(self):
        self.run_import()
        offsite = self.event("offsite@google.com")
        self.assertEqual((offsite["starts_at"], offsite["ends_at"], offsite["all_day"]), ("2024-06-10", "2024-06-12", 1))
        self.assertEqual(self.occurrences(offsite["id"]), [("2024-06-10", "2024-06-12")])

    def test_cancelled_event_is_kept_and_counted(self):
        out = self.run_import()
        self.assertEqual(self.event("dropped@google.com")["status"], "cancelled")
        self.assertIn("1 cancelled", out.splitlines()[0])

    def test_1933_event_is_kept_and_flagged_and_broken_one_skipped(self):
        out = self.run_import()
        ancient = self.event("birthday-1933@google.com")
        self.assertEqual(self.occurrences(ancient["id"]), [("1933-04-12", "1933-04-13")])
        self.assertIn("1 flagged", out)
        self.assertIn("1 skipped: unparseable start", out)
        self.assertIsNone(self.event("broken@google.com"))

    def test_output_is_counts_only(self):
        out = self.run_import()
        for secret in ("Pitch", "acme", "example.com", "meet.google", "xxxx"):
            self.assertNotIn(secret, out)
        self.assertIn("Work: 7 events, 2 series, 1 changed instances", out)

    def test_rerun_replaces_rather_than_duplicates(self):
        self.run_import()
        before = [self.db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                  for t in ("calendar_events", "calendar_attendees", "calendar_occurrences")]
        self.db.close()
        self.run_import()
        after = [self.db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                 for t in ("calendar_events", "calendar_attendees", "calendar_occurrences")]
        self.assertEqual(before, after)
        # A newer export without an event drops it, and nothing it owned is left behind.
        self.db.close()
        self.write("Work", WEEKLY)
        self.run_import()
        self.assertEqual(self.db.execute("SELECT count(*) FROM calendar_events").fetchone()[0], 2)
        orphans = self.db.execute("""SELECT (SELECT count(*) FROM calendar_attendees WHERE event_id NOT IN
                                        (SELECT id FROM calendar_events)) +
                                     (SELECT count(*) FROM calendar_occurrences WHERE event_id NOT IN
                                        (SELECT id FROM calendar_events))""").fetchone()[0]
        self.assertEqual(orphans, 0)

    def test_second_calendar_is_independent(self):
        self.write("Personal", SINGLE)
        self.run_import()
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM calendar_events WHERE uid='pitch-1@google.com'").fetchone()[0], 2)
        self.db.close()
        # Replacing Work leaves Personal alone, and a calendar missing from the folder stays.
        (self.folder / "Personal.ics").unlink()
        self.write("Work", ALL_DAY)
        self.run_import()
        counts = dict(self.db.execute("SELECT calendar_id, count(*) FROM calendar_events GROUP BY calendar_id"))
        self.assertEqual(counts, {"Personal": 1, "Work": 1})

    def test_other_sources_and_accounts_are_untouched(self):
        self.run_import()
        self.db.execute("""INSERT INTO calendar_events (source, account, calendar_id, uid, imported_at)
                           VALUES ('google', ?, 'Work', 'kept', 'now'), ('takeout', 'other@example.com', 'Work', 'kept', 'now')""",
                        (ACCOUNT,))
        self.db.commit()
        self.db.close()
        self.run_import()
        self.assertEqual(self.db.execute("SELECT count(*) FROM calendar_events WHERE uid='kept'").fetchone()[0], 2)

    def test_index_is_where_kaymail_keeps_it(self):
        self.run_import()
        self.assertTrue((Path(os.environ["KAYMAIL_DATA"]) / "index.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
