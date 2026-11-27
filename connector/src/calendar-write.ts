// The one place the connector writes to the index: after create_event, the event it just created
// goes into the calendar tables as a source = 'google' row, so list_meetings shows it before live
// sync (C5) exists. Inserts only, into the calendar tables only, with the source fixed in the SQL;
// test/store.test.ts holds this file to that. Everything else reads through ReadOnlyIndex.
import type { Db } from "./db.ts";

export interface GoogleEventRow {
  account: string;
  calendarId: string;
  uid: string;
  sequence: number;
  status: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  conferenceUrl: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  tz: string | null;
  organizer: string | null;
  visibility: string | null;
  transparency: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Google's event id. */
  sourceRef: string;
  importedAt: string;
  attendees: { email: string; name: string | null; partstat: string | null; role: string | null; isOrganizer: boolean }[];
}

// The new row, found by its UNIQUE key; the source is part of the SQL, never a parameter.
const THE_EVENT = "FROM calendar_events WHERE source = 'google' AND account = ? AND calendar_id = ? AND uid = ? AND recurrence_id = ''";

export class CalendarWriter {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The event, its people, and its one occurrence, in one batch (all or nothing). */
  async recordGoogleEvent(e: GoogleEventRow): Promise<void> {
    const key = [e.account, e.calendarId, e.uid];
    const statements = [
      this.#db.prepare(`INSERT INTO calendar_events (source, account, calendar_id, calendar_name, uid, recurrence_id,
          sequence, status, summary, description, location, conference_url, starts_at, ends_at, all_day, tz, rrule,
          organizer, visibility, transparency, created_at, updated_at, source_ref, imported_at)
        VALUES ('google', ?, ?, NULL, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(e.account, e.calendarId, e.uid, e.sequence, e.status, e.summary, e.description, e.location,
          e.conferenceUrl, e.startsAt, e.endsAt, e.allDay ? 1 : 0, e.tz, e.organizer, e.visibility, e.transparency,
          e.createdAt, e.updatedAt, e.sourceRef, e.importedAt),
      ...e.attendees.map((a) => this.#db.prepare(
        `INSERT INTO calendar_attendees (event_id, email, name, partstat, role, is_organizer) SELECT id, ?, ?, ?, ?, ? ${THE_EVENT}`)
        .bind(a.email, a.name, a.partstat, a.role, a.isOrganizer ? 1 : 0, ...key)),
      this.#db.prepare(`INSERT INTO calendar_occurrences (event_id, starts_at, ends_at) SELECT id, ?, ? ${THE_EVENT}`)
        .bind(e.startsAt, e.endsAt, ...key),
    ];
    await this.#db.batch(statements);
  }
}
