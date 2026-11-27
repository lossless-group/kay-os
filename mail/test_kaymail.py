"""Drives kaymail through real imaplib against a small local Gmail-shaped IMAP server."""

import json
import os
import re
import socketserver
import sqlite3
import stat
import sys
import tempfile
import threading
import unittest
from argparse import Namespace
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kaymail  # noqa: E402


def plain(subject, body, sender="ada@example.com"):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = "me@example.com"
    msg["Subject"] = subject
    msg["Message-ID"] = f"<{subject.replace(' ', '-')}@example.com>"
    msg.set_content(body)
    return msg.as_bytes()


def html_with_attachment():
    msg = EmailMessage()
    msg["From"] = "bob@example.com"
    msg["Subject"] = "Quarterly numbers"
    msg.set_content("<p>Revenue <b>grew</b></p><style>.hidden{color:red}</style>", subtype="html")
    msg.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="q3-report.pdf")
    return msg.as_bytes()


PDF = b"%PDF-1.4\n" + b"deck page " * 500
LOGO = b"\x89PNG\r\n\x1a\n" + b"\x00" * 400
INVITE = ("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:pitch-1\r\n"
          "SUMMARY:Pitch\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


def deck_message(filename="Acme Deck.pdf", subject="Our deck"):
    """A deck, a signature logo, and a meeting invite sent both inline and as invite.ics."""
    msg = EmailMessage()
    msg["From"] = "founder@acme.example"
    msg["Subject"] = subject
    msg.set_content("Deck attached, and an invite for Tuesday.")
    msg.add_alternative(INVITE.encode(), maintype="text", subtype="calendar")
    msg.add_attachment(PDF, maintype="application", subtype="pdf", filename=filename)
    msg.add_attachment(LOGO, maintype="image", subtype="png", filename="logo.png",
                       disposition="inline", cid="<logo@acme.example>")
    msg.add_attachment(INVITE.encode(), maintype="application", subtype="ics", filename="invite.ics")
    return msg.as_bytes()


BROKEN_CHARSET = (
    b"From: carol@example.com\r\nSubject: Odd charset\r\n"
    b"Content-Type: text/plain; charset=not-a-charset\r\n\r\nwaffle body\r\n"
)


class FakeImap(socketserver.StreamRequestHandler):
    def send(self, text):
        self.wfile.write(text if isinstance(text, bytes) else text.encode())

    def handle(self):
        server = self.server
        self.send("* OK ready\r\n")
        while line := self.rfile.readline():
            tag, _, rest = line.decode().strip().partition(" ")
            server.commands.append(rest)
            verb = rest.upper()
            if verb.startswith("CAPABILITY"):
                self.send("* CAPABILITY IMAP4rev1 X-GM-EXT-1\r\n")
            elif verb.startswith("LOGIN"):
                if server.password not in rest:
                    self.send(f"{tag} NO bad credentials\r\n")
                    continue
            elif verb.startswith("LIST"):
                self.send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n')
                self.send('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n')
            elif verb.startswith("EXAMINE"):
                self.send(f"* {len(server.mail)} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n{tag} OK [READ-ONLY] done\r\n")
                continue
            elif verb.startswith("UID SEARCH"):
                match = re.search(r"UID (\d+):\*", rest)
                uids = sorted(server.mail)
                if match:
                    floor = int(match.group(1))
                    # Real IMAP: n:* always includes the highest UID.
                    uids = [u for u in uids if u >= floor] or uids[-1:]
                self.send(f"* SEARCH {' '.join(map(str, uids))}\r\n")
            elif verb.startswith("UID FETCH"):
                for uid in map(int, rest.split()[2].split(",")):
                    raw = server.mail[uid]
                    labels = 'X-GM-LABELS ("\\\\Inbox" "Deals")'
                    date = 'INTERNALDATE "05-Jan-2024 10:00:00 +0100"'
                    if uid % 2:  # attributes before the literal
                        self.send(f"* {uid} FETCH (UID {uid} FLAGS (\\Seen) {date} X-GM-THRID 99 {labels} BODY[] {{{len(raw)}}}\r\n")
                        self.send(raw + b")\r\n")
                    else:  # attributes after it
                        self.send(f"* {uid} FETCH (BODY[] {{{len(raw)}}}\r\n")
                        self.send(raw + f" UID {uid} FLAGS () {date} X-GM-THRID 99 {labels})\r\n".encode())
            elif verb.startswith("LOGOUT"):
                self.send(f"* BYE\r\n{tag} OK bye\r\n")
                return
            self.send(f"{tag} OK done\r\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class KaymailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["KAYMAIL_DATA"] = f"{self.tmp.name}/data"
        os.environ["KAYMAIL_CONFIG"] = f"{self.tmp.name}/config/accounts.toml"
        self.server = Server(("127.0.0.1", 0), FakeImap)
        self.server.mail = {1: plain("Term sheet", "the liquidation preference"), 2: html_with_attachment(), 3: BROKEN_CHARSET}
        self.server.commands = []
        self.server.password = "s3cret"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.acct = {"address": "me@example.com", "host": "127.0.0.1", "port": self.server.server_address[1],
                     "password": "s3cret", "tls": False}
        self.db = kaymail.open_db()

    def tearDown(self):
        self.db.close()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def rows(self):
        return self.db.execute("SELECT * FROM messages ORDER BY uid").fetchall()

    def fts(self, query):
        return [r[0] for r in self.db.execute("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", (query,))]

    def test_backfill_stores_raw_and_parses_every_message(self):
        stored, events = kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual(stored, 3)
        self.assertEqual(events, [], "a first backfill must not raise monitoring events")
        rows = self.rows()
        self.assertEqual(rows[0]["subject"], "Term sheet")
        self.assertEqual(rows[0]["date"], "2024-01-05T09:00:00+00:00")
        self.assertEqual(rows[0]["thread_id"], "99")
        self.assertIn("Deals", rows[0]["labels"])
        self.assertIn("Deals", rows[1]["labels"], "labels after the literal must parse too")
        self.assertEqual(rows[1]["attachments"], "q3-report.pdf")
        self.assertIn("Revenue grew", rows[1]["body"])
        self.assertNotIn("color", rows[1]["body"])
        self.assertIn("waffle", rows[2]["body"], "a bad charset must not lose the body")
        for row in rows:
            self.assertEqual(kaymail.raw_path(row["account"], row["sha256"]).read_bytes(), self.server.mail[row["uid"]])

    def test_sync_never_writes_to_the_server(self):
        kaymail.sync_once(self.db, self.acct, None)
        joined = "\n".join(self.server.commands).upper()
        self.assertIn("EXAMINE", joined)
        self.assertIn("BODY.PEEK[]", joined)
        self.assertNotIn("SELECT ", joined)
        for verb in ("STORE", "EXPUNGE", "APPEND", "COPY", "DELETE", "MOVE"):
            self.assertNotIn(verb, joined)

    def test_only_all_mail_is_synced_on_gmail(self):
        kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual({r["mailbox"] for r in self.rows()}, {"[Gmail]/All Mail"})

    def test_rerun_is_idempotent_and_new_mail_becomes_an_event(self):
        kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual(kaymail.sync_once(self.db, self.acct, None), (0, []))
        self.server.mail[4] = plain("Wire instructions", "routing number")
        stored, events = kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual(stored, 1)
        self.assertEqual(events[0]["subject"], "Wire instructions")
        logged = (Path(os.environ["KAYMAIL_DATA"]) / "events.jsonl").read_text().splitlines()
        self.assertEqual(json.loads(logged[0])["subject"], "Wire instructions")
        self.assertEqual(self.server.commands.count("UID SEARCH ALL"), 1, "after backfill, polling must not list all UIDs")

    def test_limited_backfill_takes_newest_first_and_resumes(self):
        kaymail.sync_once(self.db, self.acct, 1)
        self.assertEqual([r["uid"] for r in self.rows()], [3])
        kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual([r["uid"] for r in self.rows()], [1, 2, 3])
        self.assertEqual(kaymail.sync_once(self.db, self.acct, None)[1], [], "finishing a backfill raises no events")

    def test_search_finds_body_and_attachment_names_and_dedupes(self):
        kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual(len(self.fts('"liquidation preference"')), 1)
        self.assertEqual(len(self.fts("q3*")), 1)
        self.server.mail[4] = self.server.mail[1]  # same bytes in a second location
        kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual(len(self.fts('"liquidation preference"')), 1)

    def test_search_command_with_date_order_and_snippet(self):
        kaymail.sync_once(self.db, self.acct, None)
        self.db.commit()
        args = Namespace(query="liquidation", account=None, sender="ada", since="2024-01-01", until=None,
                         limit=5, relevance=False, json=True)
        from contextlib import redirect_stdout
        from io import StringIO
        out = StringIO()
        with redirect_stdout(out):
            kaymail.cmd_search(args)
        result = json.loads(out.getvalue())
        self.assertEqual(result["subject"], "Term sheet")
        self.assertIn("[liquidation]", result["snippet"])

    def message_id(self, uid):
        return self.db.execute("SELECT id FROM messages WHERE uid=?", (uid,)).fetchone()[0]

    def test_sync_indexes_each_attachment_once_and_sorts_out_noise(self):
        self.server.mail[4] = deck_message()
        self.server.mail[5] = deck_message("../../Acme Deck v2.pdf", "Deck again")
        kaymail.sync_once(self.db, self.acct, None)
        deck = self.message_id(4)
        parts = self.db.execute("SELECT count(*) FROM message_attachments WHERE message_id=?", (deck,)).fetchone()[0]
        self.assertEqual(parts, 4, "deck, logo, the inline invite and invite.ics")
        listed = {r["kind"]: r for r in kaymail.find_attachments(self.db, message_id=deck)}
        self.assertEqual(set(listed), {"document", "calendar"}, "the logo is noise, and both invites are one file")
        self.assertEqual(listed["document"]["filename"], "Acme Deck.pdf")
        self.assertEqual(listed["calendar"]["content_type"], "text/calendar")
        pdf = kaymail.find_attachments(self.db, type_="pdf", sender="acme")
        self.assertEqual([(r["size"], r["messages"]) for r in pdf], [(len(PDF), 2)], "same bytes, one row")
        logo = kaymail.find_attachments(self.db, message_id=deck, noise=True, kind="image")
        self.assertEqual(logo[0]["is_noise"], 1)
        [q3] = kaymail.find_attachments(self.db, message_id=self.message_id(2))
        self.assertEqual((q3["kind"], q3["content_type"]), ("document", "application/pdf"))

    def test_backfill_rebuilds_the_same_rows_and_reruns_as_a_no_op(self):
        self.server.mail[4] = deck_message()
        kaymail.sync_once(self.db, self.acct, None)
        snapshot = lambda: self.db.execute(
            "SELECT ma.message_id, ma.part_index, ma.filename, a.sha256, a.kind, a.is_noise "
            "FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id ORDER BY 1, 2").fetchall()
        before = [tuple(r) for r in snapshot()]
        for table in ("message_attachments", "attachments", "attachment_scans"):
            self.db.execute(f"DELETE FROM {table}")  # an archive synced before attachments were indexed
        self.assertEqual(kaymail.backfill_attachments(self.db), (4, 5))
        self.assertEqual([tuple(r) for r in snapshot()], before)
        self.assertEqual(kaymail.backfill_attachments(self.db), (0, 0))

    def test_attachment_files_decode_exactly_and_save_under_a_safe_name(self):
        self.server.mail[4] = deck_message("../../etc/Acme Deck.pdf")
        kaymail.sync_once(self.db, self.acct, None)
        [pdf] = kaymail.find_attachments(self.db, type_="pdf", sender="acme")
        self.assertEqual(kaymail.attachment_bytes(self.db, pdf["id"]), PDF)
        cached = kaymail.cache_attachment(self.db, pdf["id"])
        self.assertEqual((cached.read_bytes(), cached.suffix), (PDF, ".pdf"))
        self.assertEqual(stat.S_IMODE(cached.stat().st_mode), 0o600)
        downloads = Path(self.tmp.name) / "downloads"
        downloads.mkdir()
        from contextlib import redirect_stdout
        from io import StringIO
        with redirect_stdout(StringIO()):
            kaymail.cmd_attachment(Namespace(id=pdf["id"], save=str(downloads), path=False, json=False))
        self.assertEqual([p.name for p in downloads.iterdir()], ["Acme Deck.pdf"])
        self.assertEqual(kaymail.safe_filename("..", "fallback.bin"), "fallback.bin")
        self.assertEqual(kaymail.safe_filename("a\\b\x00c.pdf", "x"), "bc.pdf")

    def test_bad_password_is_reported_not_retried(self):
        self.acct["password"] = "wrong"
        with self.assertRaises(kaymail.AuthFailed):
            kaymail.sync_with_retry(self.db, self.acct, None)
        self.assertEqual(sum(c.upper().startswith("LOGIN") for c in self.server.commands), 1)

    def test_mail_and_credentials_are_owner_only(self):
        kaymail.save_accounts([self.acct])
        kaymail.sync_once(self.db, self.acct, None)
        self.assertEqual(stat.S_IMODE(kaymail.config_path().stat().st_mode), 0o600)
        raw = kaymail.raw_path(self.acct["address"], self.rows()[0]["sha256"])
        self.assertEqual(stat.S_IMODE(raw.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((kaymail.data_dir() / "index.sqlite").stat().st_mode), 0o600)
        self.assertEqual(kaymail.load_accounts()[0]["password"], "s3cret")

    def test_refuses_to_store_inside_a_git_checkout(self):
        checkout = Path(self.tmp.name) / "repo"
        (checkout / ".git").mkdir(parents=True)
        with self.assertRaises(SystemExit):
            kaymail.private_dir(checkout / "mail")


class SharedAttachmentRulesTest(unittest.TestCase):
    """The Worker's src/rules.ts passes the same file: the two can't sort attachments differently."""

    def test_rule_cases(self):
        cases = json.loads((Path(__file__).parent / "testdata" / "attachment_rules.json").read_text())
        self.assertGreater(len(cases), 20)
        for case in cases:
            with self.subTest(case["name"]):
                data = bytes.fromhex(case["first_bytes_hex"])
                ctype = kaymail.sniff_type(data, case["declared_type"], case["filename"])
                kind = kaymail.attachment_kind(ctype, case["filename"])
                noise = kaymail.is_noise(kind, case["size"], case["disposition"], case["content_id"])
                self.assertEqual({"content_type": ctype, "kind": kind, "is_noise": noise}, case["expected"])


class CloudSchemaParityTest(unittest.TestCase):
    """The Worker's D1 index (sync-worker/migrations) must keep the laptop's table shapes."""

    TABLES = ("messages", "messages_fts", "attachments", "message_attachments", "attachment_scans",
              "calendar_events", "calendar_attendees", "calendar_occurrences")
    # Laptop-fetched mail has no Gmail UID in R2; see migrations/0001_index.sql.
    MAY_BE_NULL_IN_D1 = {("messages", "mailbox"), ("messages", "uidvalidity"), ("messages", "uid")}

    @staticmethod
    def shape(db):
        tables = {t: db.execute(f"PRAGMA table_info({t})").fetchall() for t in CloudSchemaParityTest.TABLES}
        # Named indexes and the ones UNIQUE and PRIMARY KEY create, with their columns.
        indexes = {
            t: sorted(
                (name, unique, origin, db.execute(f"PRAGMA index_info({name})").fetchall())
                for _, name, unique, origin, _ in db.execute(f"PRAGMA index_list({t})")
            )
            for t in CloudSchemaParityTest.TABLES
        }
        return tables, indexes

    def test_d1_migrations_match_kaymail_schema(self):
        laptop = sqlite3.connect(":memory:")
        laptop.executescript(kaymail.SCHEMA)
        cloud = sqlite3.connect(":memory:")
        migrations = sorted((Path(__file__).parent.parent / "sync-worker" / "migrations").glob("*.sql"))
        self.assertTrue(migrations)
        for path in migrations:
            cloud.executescript(path.read_text())

        laptop_tables, laptop_indexes = self.shape(laptop)
        cloud_tables, cloud_indexes = self.shape(cloud)
        for table in self.TABLES:
            with self.subTest(table=table):
                expected = laptop_tables[table]
                self.assertTrue(expected, f"{table} missing from kaymail.SCHEMA")
                actual = [
                    (cid, name, kind, 1 if (table, name) in self.MAY_BE_NULL_IN_D1 else notnull, default, pk)
                    for cid, name, kind, notnull, default, pk in cloud_tables[table]
                ]
                self.assertEqual(actual, expected)
        # The NULL allowance is a real difference, not a stale exemption.
        nullable = {(name, notnull) for _, name, _, notnull, _, _ in cloud_tables["messages"]}
        for _, column in self.MAY_BE_NULL_IN_D1:
            self.assertIn((column, 0), nullable)
        self.assertEqual(cloud_indexes, laptop_indexes)
        # Not compared: mailboxes holds the laptop's IMAP cursors, which the Worker keeps in
        # Durable Object storage.


if __name__ == "__main__":
    unittest.main()
