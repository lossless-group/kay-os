"""Drives kaymail through real imaplib against a small local Gmail-shaped IMAP server."""

import json
import os
import re
import socketserver
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
        self.assertEqual(kaymail.load_accounts()[0]["password"], "s3cret")

    def test_refuses_to_store_inside_a_git_checkout(self):
        checkout = Path(self.tmp.name) / "repo"
        (checkout / ".git").mkdir(parents=True)
        with self.assertRaises(SystemExit):
            kaymail.private_dir(checkout / "mail")


if __name__ == "__main__":
    unittest.main()
