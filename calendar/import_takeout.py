# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "icalendar==7.3.2",
#     "recurring-ical-events==3.8.2",
# ]
# ///
"""import_takeout: load a Google Takeout calendar export into the mail index.

Each .ics file in the folder is one calendar: its name, minus .ics, is the
calendar_id and calendar_name. Every event becomes a calendar_events row, its
people calendar_attendees rows (the organizer too, flagged), and its dates
calendar_occurrences rows: one for a single event, one per date for a series,
with EXDATEs applied and changed instances in place of the dates they replace.

Rerunning replaces this account's Takeout rows calendar by calendar, inside one
transaction per calendar, so a newer export supersedes the old one. Calendars
not in the folder are left alone. The source files are only read.

Prints counts only: never titles, descriptions, locations, or addresses.

  uv run calendar/import_takeout.py michael@learnstart.vc \\
      ~/.local/share/kay-os/calendar/michael@learnstart.vc/takeout/2026-11-27/Calendar

Spec: context-v/specs/Calendars-as-Context.md
"""

import argparse
import datetime
import re
import sys
import zoneinfo
from pathlib import Path

import icalendar
import recurring_ical_events

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mail"))
import kaymail  # noqa: E402

SOURCE = "takeout"
MAX_DESCRIPTION_CHARS = 20_000
MAX_OCCURRENCES = 5_000
SANE_YEARS = (1990, 2100)
UTC = datetime.timezone.utc
ROLES = {"req-participant": "required", "opt-participant": "optional"}
CONFERENCE_URL = re.compile(r"https://(?:[\w-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|"
                            r"teams\.live\.com|webex\.com|whereby\.com|gotomeeting\.com)/[^\s<>\"')\]]+")

COUNTERS = ("events", "series", "changed", "occurrences", "attendees", "cancelled", "flagged",
            "capped", "expansion_failed", "orphan_instances", "duplicates", "skipped_no_uid",
            "skipped_bad_start", "bad_end")


def utc_iso(value, floating_tz):
    """A DATE as YYYY-MM-DD; a DATE-TIME in UTC like kaymail's messages.date."""
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=floating_tz)
        return value.astimezone(UTC).isoformat(timespec="seconds")
    if isinstance(value, datetime.date):
        return value.isoformat()
    raise ValueError(f"not a date: {type(value).__name__}")


def prop_dt(component, name):
    """The property's date or datetime, None if absent; raises if it's there but broken."""
    if name not in component:
        return None
    value = component.get(name)
    if isinstance(value, list):
        value = value[0]
    return value.dt


def text(component, name):
    value = component.get(name)
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0]
    return str(value)


def lower(value):
    return value.strip().lower() if value else None


def hyphenated(value):
    return re.sub(r"[\s_]+", "-", value.strip().lower()) if value else None


def address(value):
    if value is None:
        return None
    raw = str(value).strip()
    if raw.lower().startswith("mailto:"):
        raw = raw[7:]
    raw = raw.strip().lower()
    return raw or None


def floating_zone(calendar):
    """Times without a zone are in the calendar's X-WR-TIMEZONE, else UTC."""
    name = text(calendar, "X-WR-TIMEZONE")
    if name:
        try:
            return zoneinfo.ZoneInfo(name.strip())
        except (zoneinfo.ZoneInfoNotFoundError, ValueError):
            pass
    return UTC


def event_end(component, start):
    try:
        end = prop_dt(component, "DTEND")
        if end is not None:
            return end, False
        if "DURATION" in component:
            return start + component.get("DURATION").dt, False
    except Exception:
        return None, True
    if isinstance(start, datetime.datetime):
        return start, False
    return start + datetime.timedelta(days=1), False


def is_open_ended(component):
    rules = component.get("RRULE")
    if rules is None:
        return False
    if not isinstance(rules, list):
        rules = [rules]
    return any("COUNT" not in rule and "UNTIL" not in rule for rule in rules)


def is_series(component):
    return "RRULE" in component or "RDATE" in component


def conference_url(component, description, location):
    for name in ("X-GOOGLE-CONFERENCE", "CONFERENCE"):
        value = text(component, name)
        if value:
            return value.strip()
    for blob in (location, description):
        if blob:
            match = CONFERENCE_URL.search(blob)
            if match:
                return match.group(0)
    return None


def attendees(component):
    """(email, name, partstat, role, is_organizer) per person, the organizer included."""
    people = {}
    found = component.get("ATTENDEE") or []
    if not isinstance(found, list):
        found = [found]
    for attendee in found:
        email = address(attendee)
        if not email or email in people:
            continue
        params = getattr(attendee, "params", {})
        role = hyphenated(params.get("ROLE"))
        people[email] = [email, params.get("CN"), hyphenated(params.get("PARTSTAT")), ROLES.get(role, role), 0]
    organizer = component.get("ORGANIZER")
    email = address(organizer)
    if email:
        if email in people:
            people[email][4] = 1
        else:
            params = getattr(organizer, "params", {})
            people[email] = [email, params.get("CN"), None, None, 1]
    return [tuple(person) for person in people.values()]


def parse_event(component, floating, counts):
    """The calendar_events columns for one VEVENT, or None (and a count) if it can't be kept."""
    uid = text(component, "UID")
    if not uid or not uid.strip():
        counts["skipped_no_uid"] += 1
        return None
    try:
        start = prop_dt(component, "DTSTART")
        if start is None:
            raise ValueError("no DTSTART")
        starts_at = utc_iso(start, floating)
        rid = prop_dt(component, "RECURRENCE-ID")
        recurrence_id = utc_iso(rid, floating) if rid is not None else ""
    except Exception:
        counts["skipped_bad_start"] += 1
        return None
    end, bad_end = event_end(component, start)
    if bad_end:
        counts["bad_end"] += 1
    try:
        ends_at = utc_iso(end, floating) if end is not None else None
    except ValueError:
        ends_at = None
    if not SANE_YEARS[0] <= int(starts_at[:4]) <= SANE_YEARS[1]:
        counts["flagged"] += 1

    def stamp(name):
        try:
            value = prop_dt(component, name)
            return utc_iso(value, UTC) if value is not None else None
        except Exception:
            return None

    tz = None
    dtstart = component.get("DTSTART")
    if dtstart is not None and dtstart.params.get("TZID"):
        tz = dtstart.params.get("TZID")
    elif isinstance(start, datetime.datetime):
        tz = str(start.tzinfo) if start.tzinfo is not None else str(floating)
    rrule = component.get("RRULE")
    if rrule is not None:
        rules = rrule if isinstance(rrule, list) else [rrule]
        rrule = "\n".join(rule.to_ical().decode() for rule in rules)
    description = text(component, "DESCRIPTION")
    if description is not None:
        description = description[:MAX_DESCRIPTION_CHARS]
    location = text(component, "LOCATION")
    try:
        sequence = int(component.get("SEQUENCE", 0))
    except (TypeError, ValueError):
        sequence = 0
    return {
        "uid": uid.strip(),
        "recurrence_id": recurrence_id,
        "sequence": sequence,
        # Google writes STATUS on every event; when it's missing the meeting is on.
        "status": lower(text(component, "STATUS")) or "confirmed",
        "summary": text(component, "SUMMARY"),
        "description": description,
        "location": location,
        "conference_url": conference_url(component, description, location),
        "starts_at": starts_at,
        "ends_at": ends_at,
        "all_day": 0 if isinstance(start, datetime.datetime) else 1,
        "tz": tz,
        "rrule": rrule,
        "organizer": address(component.get("ORGANIZER")),
        "visibility": lower(text(component, "CLASS")),
        "transparency": lower(text(component, "TRANSP")),
        "created_at": stamp("CREATED"),
        "updated_at": stamp("LAST-MODIFIED"),
        "attendees": attendees(component),
        "is_series": recurrence_id == "" and is_series(component),
        "open_ended": is_open_ended(component),
        "component": component,
    }


def newer(a, b):
    """True if event a should win over b for the same (uid, recurrence_id)."""
    return (a["sequence"], a["updated_at"] or "") >= (b["sequence"], b["updated_at"] or "")


def expand_series(master, changed, calendar, floating, horizon, counts):
    """Occurrences for one UID: [(row key, starts_at, ends_at)], changed instances in their own row.

    `changed` maps recurrence_id -> parsed changed instance. Dates a changed instance
    replaces come out of recurring-ical-events already swapped for the instance.
    """
    sub = icalendar.Calendar()
    if "X-WR-TIMEZONE" in calendar:
        sub.add("X-WR-TIMEZONE", calendar["X-WR-TIMEZONE"])
    for timezone in calendar.walk("VTIMEZONE"):
        sub.add_component(timezone)
    sub.add_component(master["component"])
    for instance in changed.values():
        sub.add_component(instance["component"])

    start = master["component"].get("DTSTART").dt
    begin = (start.date() if isinstance(start, datetime.datetime) else start) - datetime.timedelta(days=2)
    out = []
    for occurrence in recurring_ical_events.of(sub).after((begin.year, begin.month, begin.day)):
        occ_start = occurrence.get("DTSTART").dt
        starts_at = utc_iso(occ_start, floating)
        if master["open_ended"] and starts_at[:10] > horizon:
            break
        if len(out) >= MAX_OCCURRENCES:
            counts["capped"] += 1
            break
        occ_end = occurrence.get("DTEND")
        ends_at = utc_iso(occ_end.dt, floating) if occ_end is not None else None
        rid = occurrence.get("RECURRENCE-ID")
        key = utc_iso(rid.dt, floating) if rid is not None else ""
        out.append((key if key in changed else "", starts_at, ends_at))
    return out


def import_calendar(db, account, path, horizon, imported_at):
    counts = dict.fromkeys(COUNTERS, 0)
    calendar = icalendar.Calendar.from_ical(path.read_bytes())
    floating = floating_zone(calendar)
    by_key = {}
    for component in calendar.walk("VEVENT"):
        event = parse_event(component, floating, counts)
        if event is None:
            continue
        key = (event["uid"], event["recurrence_id"])
        if key in by_key:
            counts["duplicates"] += 1
            if not newer(event, by_key[key]):
                continue
        by_key[key] = event

    # Occurrences per (uid, recurrence_id).
    occurrences = {key: [] for key in by_key}
    changed_by_uid = {}
    for (uid, rid), event in by_key.items():
        if rid:
            changed_by_uid.setdefault(uid, {})[rid] = event
    for (uid, rid), event in by_key.items():
        if rid:
            continue
        if event["is_series"]:
            changed = changed_by_uid.get(uid, {})
            try:
                for row_rid, starts_at, ends_at in expand_series(event, changed, calendar, floating, horizon, counts):
                    occurrences[(uid, row_rid)].append((starts_at, ends_at))
                continue
            except Exception:
                counts["expansion_failed"] += 1
                for row_rid in changed:
                    occurrences[(uid, row_rid)] = []
        occurrences[(uid, "")].append((event["starts_at"], event["ends_at"]))
    for (uid, rid), event in by_key.items():
        if rid and (uid, "") not in by_key:
            counts["orphan_instances"] += 1
        # A changed instance the expansion didn't place (no series, moved past the
        # horizon, or the series failed) still happened on its own date.
        if rid and not occurrences[(uid, rid)]:
            occurrences[(uid, rid)].append((event["starts_at"], event["ends_at"]))

    calendar_id = path.stem
    with db:  # one transaction: the old rows go only if the new ones land
        old = "SELECT id FROM calendar_events WHERE source=? AND account=? AND calendar_id=?"
        scope = (SOURCE, account, calendar_id)
        db.execute(f"DELETE FROM calendar_occurrences WHERE event_id IN ({old})", scope)
        db.execute(f"DELETE FROM calendar_attendees WHERE event_id IN ({old})", scope)
        db.execute("DELETE FROM calendar_events WHERE source=? AND account=? AND calendar_id=?", scope)
        for key, event in by_key.items():
            cursor = db.execute(
                """INSERT INTO calendar_events (source, account, calendar_id, calendar_name, uid,
                       recurrence_id, sequence, status, summary, description, location, conference_url,
                       starts_at, ends_at, all_day, tz, rrule, organizer, visibility, transparency,
                       created_at, updated_at, source_ref, imported_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (SOURCE, account, calendar_id, calendar_id, event["uid"], event["recurrence_id"],
                 event["sequence"], event["status"], event["summary"], event["description"],
                 event["location"], event["conference_url"], event["starts_at"], event["ends_at"],
                 event["all_day"], event["tz"], event["rrule"], event["organizer"], event["visibility"],
                 event["transparency"], event["created_at"], event["updated_at"], path.name, imported_at),
            )
            event_id = cursor.lastrowid
            db.executemany(
                """INSERT INTO calendar_attendees (event_id, email, name, partstat, role, is_organizer)
                   VALUES (?,?,?,?,?,?)""",
                [(event_id, *person) for person in event["attendees"]],
            )
            inserted = db.executemany(
                "INSERT OR IGNORE INTO calendar_occurrences (event_id, starts_at, ends_at) VALUES (?,?,?)",
                [(event_id, s, e) for s, e in occurrences[key]],
            )
            counts["events"] += 1
            counts["series"] += 1 if event["is_series"] else 0
            counts["changed"] += 1 if event["recurrence_id"] else 0
            counts["cancelled"] += 1 if event["status"] == "cancelled" else 0
            counts["attendees"] += len(event["attendees"])
            counts["occurrences"] += inserted.rowcount
    return counts


def report_line(name, counts):
    line = (f"{name}: {counts['events']} events, {counts['series']} series, {counts['changed']} changed instances, "
            f"{counts['occurrences']} occurrences, {counts['attendees']} attendees, "
            f"{counts['cancelled']} cancelled, {counts['flagged']} flagged (dated before "
            f"{SANE_YEARS[0]} or after {SANE_YEARS[1]})")
    extras = [
        ("capped", f"series capped at {MAX_OCCURRENCES} occurrences"),
        ("expansion_failed", "series that couldn't be expanded (kept with their first date)"),
        ("orphan_instances", "changed instances without their series"),
        ("duplicates", "duplicate events (kept the newest)"),
        ("bad_end", "unparseable end times (kept without an end)"),
        ("skipped_bad_start", "skipped: unparseable start"),
        ("skipped_no_uid", "skipped: no UID"),
    ]
    notes = [f"{counts[key]} {label}" for key, label in extras if counts[key]]
    return line + ("; " + "; ".join(notes) if notes else "")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Import a Google Takeout calendar folder into the mail index.")
    parser.add_argument("account", help="the account whose calendars these are, e.g. michael@learnstart.vc")
    parser.add_argument("folder", type=Path, help="the folder of .ics files (Takeout/Calendar)")
    parser.add_argument("--expand-until", metavar="YYYY-MM-DD",
                        help="expand open-ended series up to this date (default: a year from today)")
    args = parser.parse_args(argv)

    today = datetime.datetime.now(UTC).date()
    if args.expand_until:
        try:
            horizon = datetime.date.fromisoformat(args.expand_until).isoformat()
        except ValueError:
            sys.exit(f"--expand-until wants YYYY-MM-DD, got {args.expand_until!r}")
    else:
        horizon = (today + datetime.timedelta(days=365)).isoformat()
    files = sorted(args.folder.expanduser().glob("*.ics"))
    if not files:
        sys.exit(f"No .ics files in {args.folder}")

    db = kaymail.open_db()
    imported_at = datetime.datetime.now(UTC).isoformat(timespec="seconds")
    totals = dict.fromkeys(COUNTERS, 0)
    for path in files:
        try:
            counts = import_calendar(db, args.account, path, horizon, imported_at)
        except Exception as error:  # a file icalendar can't read at all: say so, keep going
            print(f"{path.stem}: not imported ({type(error).__name__}); its earlier rows are unchanged")
            continue
        print(report_line(path.stem, counts))
        for key in COUNTERS:
            totals[key] += counts[key]
    print(report_line(f"Total ({len(files)} calendars, open-ended series expanded to {horizon})", totals))
    db.close()


if __name__ == "__main__":
    main()
