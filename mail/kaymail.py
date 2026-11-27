#!/usr/bin/env python3
"""kaymail: pull every mailbox onto this disk, search it, watch it.

The local copy is the system of record. Agents read it; they never talk to a
mail provider. Access is read-only by construction: mailboxes are opened with
EXAMINE and bodies fetched with BODY.PEEK, so syncing can't mark, move, or
delete anything on the server. Mail deleted upstream stays in the archive.

Standard library only. Run `kaymail.py --help`.
"""

import argparse
import datetime
import email
import email.policy
import email.utils
import getpass
import hashlib
import html.parser
import imaplib
import json
import mimetypes
import os
import re
import sqlite3
import ssl
import sys
import time
import tomllib
from pathlib import Path

# imaplib caps response lines at 1MB; `UID SEARCH ALL` on a big mailbox is longer.
imaplib._MAXLINE = 100_000_000

BATCH_SIZE = 50
MAX_BODY_CHARS = 200_000
MAX_ATTEMPTS = 5
RETRY_BASE_SECONDS = 30

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    uidvalidity INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    is_primary INTEGER NOT NULL,  -- first sighting of these bytes in this account
    message_id TEXT,
    thread_id TEXT,
    date TEXT,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    labels TEXT,
    flags TEXT,
    size INTEGER,
    attachments TEXT,
    body TEXT,
    UNIQUE (account, mailbox, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS messages_sha ON messages (account, sha256);
CREATE INDEX IF NOT EXISTS messages_date ON messages (date);
CREATE TABLE IF NOT EXISTS mailboxes (
    account TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    uidvalidity INTEGER NOT NULL,
    backfill_done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account, mailbox)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
    subject, from_addr, to_addr, body, attachments,
    content='messages', content_rowid='id'
);
CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,          -- of the decoded bytes
    content_type TEXT,                    -- sniffed from bytes, falling back to declared
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,                   -- document | calendar | image | archive | other
    is_noise INTEGER NOT NULL DEFAULT 0,  -- logos, pixels, signature images
    first_seen TEXT,                      -- earliest message date carrying it
    extract_status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | skipped | failed (Phase 2)
    extractor TEXT, extractor_version TEXT, extracted_at TEXT,
    pages INTEGER, chars INTEGER, extract_error TEXT
);
CREATE TABLE IF NOT EXISTS message_attachments (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    part_index INTEGER NOT NULL,          -- position among the message's MIME parts
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    filename TEXT,
    declared_type TEXT,
    disposition TEXT,                     -- attachment | inline
    content_id TEXT,
    PRIMARY KEY (message_id, part_index)
);
CREATE INDEX IF NOT EXISTS message_attachments_att ON message_attachments (attachment_id);
CREATE INDEX IF NOT EXISTS attachments_kind ON attachments (kind, is_noise);
CREATE TABLE IF NOT EXISTS attachment_scans (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    status TEXT NOT NULL                  -- ok | error: so a backfill never parses a message twice
);
"""

# Images this small, or inline in the body and under the larger limit, are logos,
# icons, and tracking pixels. So is any image that arrives on more than
# NOISE_REPEATS messages. Real screenshots pasted into a body are usually bigger.
NOISE_MAX_BYTES = 10_000
NOISE_INLINE_MAX_BYTES = 50_000
NOISE_REPEATS = 50
ATTACHMENT_HINT = re.compile(rb"filename|name=|text/calendar|content-id", re.IGNORECASE)
MAGIC = [
    (b"%PDF", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"BEGIN:VCALENDAR", "text/calendar"),
    (b"PK\x03\x04", "application/zip"),
    (b"\x1f\x8b", "application/gzip"),
    (b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
]
KINDS = [
    ("calendar", ("text/calendar", "application/ics"), (".ics", ".vcs")),
    ("image", ("image/",), (".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".tif", ".tiff", ".bmp")),
    ("archive", ("application/zip", "application/gzip", "application/x-7z", "application/x-rar",
                 "application/x-tar", "application/x-zip"), (".zip", ".gz", ".tgz", ".7z", ".rar", ".tar")),
    ("document", ("application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument",
                  "application/vnd.ms-", "application/vnd.oasis.opendocument", "application/rtf",
                  "text/plain", "text/html", "text/markdown", "text/csv"),
     (".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".ods", ".odp", ".rtf",
      ".txt", ".md", ".html", ".htm", ".csv", ".key", ".pages", ".numbers")),
]


class AuthFailed(Exception):
    pass


class SyncStopped(Exception):
    pass


def config_path():
    default = Path.home() / ".config/kay-os/mail/accounts.toml"
    return Path(os.environ.get("KAYMAIL_CONFIG", default))


def data_dir():
    default = Path.home() / ".local/share/kay-os/mail"
    return Path(os.environ.get("KAYMAIL_DATA", default))


def refuse_git_checkout(path):
    """kay-os is a public repo. Mail and passwords must never land in a checkout."""
    path = Path(path).resolve()
    for parent in [path, *path.parents]:
        if (parent / ".git").exists():
            sys.exit(f"Refusing to keep mail or credentials inside a git checkout: {parent}")


def private_dir(path):
    refuse_git_checkout(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def load_accounts():
    path = config_path()
    if not path.exists():
        return []
    with path.open("rb") as handle:
        return tomllib.load(handle).get("account", [])


def save_accounts(accounts):
    path = config_path()
    private_dir(path.parent)
    lines = []
    for acct in accounts:
        lines.append("[[account]]")
        for key, value in acct.items():
            lines.append(f"{key} = {json.dumps(value)}")
        lines.append("")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(lines))


def select_accounts(name):
    accounts = load_accounts()
    if not accounts:
        sys.exit("No accounts yet. Run: kaymail.py add you@example.com")
    if name is None:
        return accounts
    matched = [a for a in accounts if a["address"] == name]
    if not matched:
        sys.exit(f"Unknown account: {name}")
    return matched


def open_db():
    private_dir(data_dir())
    path = data_dir() / "index.sqlite"
    db = sqlite3.connect(path, timeout=60)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    # The index holds every message's text, so it's owner-only like the raw mail.
    for name in ("index.sqlite", "index.sqlite-wal", "index.sqlite-shm"):
        if (data_dir() / name).exists():
            os.chmod(data_dir() / name, 0o600)
    return db


def connect(acct):
    host, port = acct["host"], acct.get("port", 993)
    if acct.get("tls", True):
        imap = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=120)
    else:
        imap = imaplib.IMAP4(host, port, timeout=120)
    try:
        imap.login(acct["address"], acct["password"])
    except imaplib.IMAP4.error as err:
        imap.shutdown()
        raise AuthFailed(f"{acct['address']}: login failed: {err}") from err
    return imap


def list_mailboxes(imap):
    """Return [(name, {lowercased flags})]."""
    _, data = imap.list()
    found = []
    for item in data:
        if item is None:
            continue
        line = item[0] + item[1] if isinstance(item, tuple) else item
        match = re.match(rb'\((.*?)\) (?:"[^"]*"|NIL) (.*)$', line)
        if not match:
            continue
        flags = {f.lower() for f in match.group(1).decode("ascii", "replace").split()}
        name = match.group(2).strip().decode("utf-8", "replace")
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        found.append((name, flags))
    return found


def is_gmail(imap):
    return "X-GM-EXT-1" in imap.capabilities


def mailboxes_to_sync(imap):
    boxes = list_mailboxes(imap)
    if is_gmail(imap):
        # All Mail already holds every message once, with its labels. Other
        # Gmail "folders" are views of it, so syncing them would only repeat it.
        all_mail = [name for name, flags in boxes if "\\all" in flags]
        if not all_mail:
            raise SyncStopped('All Mail is hidden from IMAP. Enable "Show in IMAP" for it in Gmail settings > Labels.')
        return all_mail
    skip = {"\\noselect", "\\trash", "\\junk", "\\drafts"}
    return [name for name, flags in boxes if not flags & skip]


def quote_mailbox(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_fetch(data):
    """Split imaplib's FETCH response into [(metadata bytes, raw message)].

    Attributes can sit on either side of the message literal, and a label can
    itself arrive as a literal, so metadata is accumulated until the closing paren.
    """
    messages, meta, body = [], b"", None
    for item in data:
        if isinstance(item, tuple):
            head, literal = item
            if re.search(rb"BODY\[\] \{\d+\}$", head):
                meta += head
                body = literal
            else:
                meta += head + literal
        elif item:
            meta += item
            if item.rstrip().endswith(b")"):
                if body is not None:
                    messages.append((meta, body))
                meta, body = b"", None
    return messages


def meta_field(meta, pattern):
    match = re.search(pattern, meta)
    return match.group(1).decode("utf-8", "replace") if match else None


class TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def html_to_text(markup):
    parser = TextExtractor()
    parser.feed(markup)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def header(msg, name):
    # Real-world headers are often malformed; the raw message is always kept.
    try:
        return str(msg[name] or "")
    except Exception:
        return ""


def part_text(part):
    try:
        return part.get_content()
    except Exception:
        return (part.get_payload(decode=True) or b"").decode("utf-8", "replace")


def parse_message(raw):
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    body, attachments = "", []
    try:
        part = msg.get_body(preferencelist=("plain", "html"))
        if part is not None:
            body = part_text(part)
            if part.get_content_type() == "text/html":
                body = html_to_text(body)
        attachments = [a.get_filename() or "" for a in msg.iter_attachments()]
    except Exception as err:
        print(f"  could not parse a message body ({err}); kept the raw copy", file=sys.stderr)
    return {
        "message_id": header(msg, "message-id").strip(),
        "from_addr": header(msg, "from"),
        "to_addr": ", ".join(filter(None, [header(msg, "to"), header(msg, "cc")])),
        "subject": header(msg, "subject"),
        "date_header": header(msg, "date"),
        "attachments": ", ".join(filter(None, attachments)),
        "body": str(body)[:MAX_BODY_CHARS],
    }


def sniff_type(data, declared, filename):
    """Trust unmistakable file signatures over what the sender declared."""
    sniffed = next((ctype for magic, ctype in MAGIC if data.startswith(magic)), None)
    if sniffed and sniffed != "application/zip":
        return sniffed
    if declared and declared != "application/octet-stream":
        return declared  # docx, xlsx and pptx are zips too; their declared type says which
    guessed = mimetypes.guess_type(filename or "")[0]
    return guessed or sniffed or declared or "application/octet-stream"


def attachment_kind(content_type, filename):
    suffix = Path(filename or "").suffix.lower()
    for kind, prefixes, suffixes in KINDS:
        if content_type.startswith(prefixes) or suffix in suffixes:
            return kind
    return "other"


def is_noise(kind, size, disposition, content_id):
    """Small images, and small images shown inline in the body. Repeats are refresh_noise's job."""
    inline = disposition == "inline" or bool(content_id)
    return kind == "image" and (size < NOISE_MAX_BYTES or (inline and size < NOISE_INLINE_MAX_BYTES))


def attachment_parts(msg):
    """(part_index, filename, declared_type, disposition, content_id, bytes) for every attachment.

    An attachment is a part marked as one, a part with a filename, a calendar
    invite (often an unnamed text/calendar alternative), or a non-text part the
    body points at by Content-ID. Body text and HTML parts are skipped.
    """
    for index, part in enumerate(msg.walk()):
        if part.is_multipart():
            continue
        try:
            ctype = part.get_content_type()
            filename = part.get_filename()
            disposition = part.get_content_disposition()
            content_id = header(part, "content-id").strip() or None
            if not (disposition == "attachment" or filename or ctype == "text/calendar"
                    or (content_id and not ctype.startswith("text/"))):
                continue
            data = part.get_payload(decode=True) or b""
        except Exception as err:
            print(f"  skipped an unreadable attachment part ({err})", file=sys.stderr)
            continue
        if data:
            yield index, filename, ctype, disposition, content_id, data


def record_attachments(db, message_id, raw, date):
    """Index one message's attachments. Safe to rerun; returns how many parts it found."""
    found = 0
    if ATTACHMENT_HINT.search(raw):
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        for index, filename, declared, disposition, content_id, data in attachment_parts(msg):
            sha = hashlib.sha256(data).hexdigest()
            ctype = sniff_type(data, declared, filename)
            kind = attachment_kind(ctype, filename)
            noise = is_noise(kind, len(data), disposition, content_id)
            db.execute(
                """INSERT INTO attachments (sha256, content_type, size, kind, is_noise, first_seen) VALUES (?,?,?,?,?,?)
                   ON CONFLICT (sha256) DO UPDATE SET
                       is_noise = max(is_noise, excluded.is_noise),
                       first_seen = CASE WHEN first_seen IS NULL OR excluded.first_seen < first_seen
                                         THEN excluded.first_seen ELSE first_seen END""",
                (sha, ctype, len(data), kind, int(noise), date),
            )
            attachment_id = db.execute("SELECT id FROM attachments WHERE sha256=?", (sha,)).fetchone()[0]
            db.execute(
                """INSERT OR IGNORE INTO message_attachments
                       (message_id, part_index, attachment_id, filename, declared_type, disposition, content_id)
                   VALUES (?,?,?,?,?,?,?)""",
                (message_id, index, attachment_id, filename, declared, disposition, content_id),
            )
            found += 1
    db.execute("INSERT OR REPLACE INTO attachment_scans (message_id, status) VALUES (?, 'ok')", (message_id,))
    return found


def refresh_noise(db):
    """An image that arrives on dozens of messages is a logo, whatever its size."""
    db.execute(
        """UPDATE attachments SET is_noise=1 WHERE kind='image' AND is_noise=0 AND id IN (
               SELECT attachment_id FROM message_attachments GROUP BY attachment_id
               HAVING count(DISTINCT message_id) > ?)""",
        (NOISE_REPEATS,),
    )


def scan_message(db, message_id, account, sha, date, raw=None):
    """Index attachments for one stored message. A parse failure is recorded, never raised."""
    try:
        if raw is None:
            raw = raw_path(account, sha).read_bytes()
        return record_attachments(db, message_id, raw, date)
    except Exception as err:
        print(f"  could not index attachments of message {message_id} ({err})", file=sys.stderr)
        db.execute("INSERT OR REPLACE INTO attachment_scans (message_id, status) VALUES (?, 'error')", (message_id,))
        return 0


def backfill_attachments(db, account=None):
    """Index attachments for every primary message not scanned yet. Resumable and idempotent."""
    sql = ("SELECT id, account, sha256, date FROM messages m WHERE is_primary=1 "
           "AND NOT EXISTS (SELECT 1 FROM attachment_scans s WHERE s.message_id=m.id)")
    params = []
    if account:
        sql += " AND account=?"
        params.append(account)
    todo = db.execute(sql + " ORDER BY date DESC", params).fetchall()
    if todo:
        print(f"Indexing attachments in {len(todo)} messages", file=sys.stderr)
    found = 0
    for n, row in enumerate(todo, 1):
        found += scan_message(db, row["id"], row["account"], row["sha256"], row["date"])
        if n % 500 == 0 or n == len(todo):
            db.commit()
            print(f"  {n}/{len(todo)}", file=sys.stderr)
    refresh_noise(db)
    db.commit()
    return len(todo), found


def attachment_report(db, account=None):
    """Totals by kind: what's there, before deciding what to extract."""
    where, params = "", []
    if account:
        where = ("WHERE a.id IN (SELECT ma.attachment_id FROM message_attachments ma "
                 "JOIN messages m ON m.id=ma.message_id WHERE m.account=?)")
        params.append(account)
    kinds = db.execute(
        f"""SELECT kind, is_noise, count(*) AS n, coalesce(sum(size),0) AS bytes
            FROM attachments a {where} GROUP BY kind, is_noise ORDER BY is_noise, n DESC""", params).fetchall()
    return [dict(r) for r in kinds]


def find_attachments(db, account=None, sender=None, type_=None, kind=None, since=None, until=None,
                     message_id=None, noise=False, limit=50):
    """Attachments matching the filters, newest message first, one row per unique file."""
    where, params = ["m.is_primary=1"], []
    for clause, value in (("m.account=?", account), ("m.from_addr LIKE ?", sender and f"%{sender}%"),
                          ("a.kind=?", kind), ("m.date >= ?", since), ("m.date < ?", until),
                          ("m.id=?", message_id)):
        if value is not None:
            where.append(clause)
            params.append(value)
    if type_:
        where.append("(a.content_type LIKE ? OR ma.filename LIKE ?)")
        params += [f"%{type_}%", f"%.{type_.lstrip('.')}"]
    if not noise:
        where.append("a.is_noise=0")
    return db.execute(
        f"""SELECT a.id, a.content_type, a.size, a.kind, a.is_noise,
                   coalesce(ma.filename, (SELECT n.filename FROM message_attachments n
                                          WHERE n.attachment_id = a.id AND n.filename IS NOT NULL
                                          LIMIT 1)) AS filename,
                   m.id AS message_id, m.account, max(m.date) AS date, m.from_addr, m.subject,
                   count(DISTINCT m.id) AS messages
            FROM attachments a
            JOIN message_attachments ma ON ma.attachment_id = a.id
            JOIN messages m ON m.id = ma.message_id
            WHERE {" AND ".join(where)}
            GROUP BY a.id ORDER BY date DESC LIMIT ?""",
        (*params, limit),
    ).fetchall()


def attachment_detail(db, attachment_id):
    row = db.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    if row is None:
        raise ValueError(f"No attachment {attachment_id}")
    messages = db.execute(
        """SELECT m.id, m.account, m.date, m.from_addr, m.subject, ma.filename, ma.disposition
           FROM message_attachments ma JOIN messages m ON m.id = ma.message_id
           WHERE ma.attachment_id=? AND m.is_primary=1 ORDER BY m.date""",
        (attachment_id,),
    ).fetchall()
    return {**dict(row), "messages": [dict(m) for m in messages]}


def attachment_bytes(db, attachment_id):
    """Decode an attachment from the first original that still holds it, checking its hash."""
    sha = db.execute("SELECT sha256 FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    if sha is None:
        raise ValueError(f"No attachment {attachment_id}")
    for row in db.execute(
            """SELECT ma.part_index, m.account, m.sha256 FROM message_attachments ma
               JOIN messages m ON m.id = ma.message_id WHERE ma.attachment_id=?""", (attachment_id,)):
        path = raw_path(row["account"], row["sha256"])
        if not path.exists():
            continue
        msg = email.message_from_bytes(path.read_bytes(), policy=email.policy.default)
        for index, *_, data in attachment_parts(msg):
            if index == row["part_index"] and hashlib.sha256(data).hexdigest() == sha[0]:
                return data
    raise ValueError(f"Attachment {attachment_id} isn't in any original on this machine (r2.sh pull --raw)")


def attachment_suffix(content_type, filename):
    suffix = Path(filename or "").suffix.lower()
    if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        return suffix
    return mimetypes.guess_extension(content_type or "") or ".bin"


def cache_attachment(db, attachment_id):
    """Decode into cache/files/ (local only, safe to delete) and return the path."""
    row = db.execute(
        """SELECT a.sha256, a.content_type, ma.filename FROM attachments a
           JOIN message_attachments ma ON ma.attachment_id = a.id WHERE a.id=? LIMIT 1""",
        (attachment_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"No attachment {attachment_id}")
    sha = row["sha256"]
    path = data_dir() / "cache/files" / sha[:2] / f"{sha}{attachment_suffix(row['content_type'], row['filename'])}"
    if not path.exists():
        data = attachment_bytes(db, attachment_id)
        private_dir(path.parent)
        temp = path.with_suffix(".tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        temp.replace(path)
    return path


def safe_filename(filename, fallback):
    """A sender-chosen filename, reduced to one harmless path component."""
    name = Path((filename or "").replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f/]", "", name).lstrip(".").strip()[:150]
    return name or fallback


def to_utc(internaldate, date_header):
    try:
        parsed = datetime.datetime.strptime(internaldate.strip(), "%d-%b-%Y %H:%M:%S %z")
    except (AttributeError, ValueError):
        try:
            parsed = email.utils.parsedate_to_datetime(date_header)
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc).isoformat(timespec="seconds")


def raw_path(account, sha):
    return data_dir() / "raw" / account / sha[:2] / f"{sha}.eml"


def store_raw(account, raw):
    sha = hashlib.sha256(raw).hexdigest()
    path = raw_path(account, sha)
    if not path.exists():
        private_dir(path.parent)
        temp = path.with_suffix(".tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
        temp.replace(path)
    return sha


def record_message(db, acct, mailbox, uidvalidity, meta, raw):
    """Store one message. Returns its event dict if it's new, else None."""
    account = acct["address"]
    uid = meta_field(meta, rb"\bUID (\d+)")
    if uid is None:
        return None
    sha = store_raw(account, raw)
    seen = db.execute("SELECT 1 FROM messages WHERE account=? AND sha256=? LIMIT 1", (account, sha)).fetchone()
    parsed = parse_message(raw)
    date = to_utc(meta_field(meta, rb'INTERNALDATE "([^"]+)"'), parsed["date_header"])
    labels = meta_field(meta, rb"X-GM-LABELS \((.*?)\)(?: |\)|$)") or ""
    cursor = db.execute(
        """INSERT OR IGNORE INTO messages (account, mailbox, uidvalidity, uid, sha256, is_primary,
               message_id, thread_id, date, from_addr, to_addr, subject, labels, flags, size,
               attachments, body)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (account, mailbox, uidvalidity, int(uid), sha, 0 if seen else 1,
         parsed["message_id"], meta_field(meta, rb"X-GM-THRID (\d+)"), date,
         parsed["from_addr"], parsed["to_addr"], parsed["subject"], labels,
         meta_field(meta, rb"FLAGS \((.*?)\)") or "", len(raw),
         parsed["attachments"], parsed["body"]),
    )
    if cursor.rowcount != 1 or seen:
        return None
    db.execute(
        "INSERT INTO messages_fts (rowid, subject, from_addr, to_addr, body, attachments) VALUES (?,?,?,?,?,?)",
        (cursor.lastrowid, parsed["subject"], parsed["from_addr"], parsed["to_addr"], parsed["body"], parsed["attachments"]),
    )
    scan_message(db, cursor.lastrowid, account, sha, date, raw)
    return {
        "id": cursor.lastrowid, "account": account, "mailbox": mailbox, "date": date,
        "from": parsed["from_addr"], "subject": parsed["subject"], "labels": labels,
        "message_id": parsed["message_id"],
    }


def uids_to_fetch(db, imap, account, mailbox, uidvalidity, backfill_done):
    """UIDs missing locally, newest first, so recent mail is usable while old mail fills in."""
    known_max = None
    if backfill_done:
        known_max = db.execute(
            "SELECT max(uid) FROM messages WHERE account=? AND mailbox=? AND uidvalidity=?",
            (account, mailbox, uidvalidity),
        ).fetchone()[0]
    if known_max is not None:
        _, data = imap.uid("SEARCH", f"UID {known_max + 1}:*")
        # `n:*` always matches the newest message, even when it's below n.
        return sorted((u for u in map(int, data[0].split()) if u > known_max), reverse=True)
    _, data = imap.uid("SEARCH", "ALL")
    known = {
        row[0] for row in db.execute(
            "SELECT uid FROM messages WHERE account=? AND mailbox=? AND uidvalidity=?",
            (account, mailbox, uidvalidity),
        )
    }
    return sorted((u for u in map(int, data[0].split()) if u not in known), reverse=True)


def sync_mailbox(db, imap, acct, mailbox, limit):
    account = acct["address"]
    typ, detail = imap.select(quote_mailbox(mailbox), readonly=True)
    if typ != "OK":
        raise imaplib.IMAP4.error(f"could not open {mailbox}: {detail}")
    uidvalidity = int(imap.response("UIDVALIDITY")[1][0])

    state = db.execute(
        "SELECT uidvalidity, backfill_done FROM mailboxes WHERE account=? AND mailbox=?", (account, mailbox)
    ).fetchone()
    backfill_done = bool(state and state["uidvalidity"] == uidvalidity and state["backfill_done"])
    db.execute(
        """INSERT INTO mailboxes (account, mailbox, uidvalidity, backfill_done) VALUES (?,?,?,?)
           ON CONFLICT (account, mailbox) DO UPDATE SET uidvalidity=excluded.uidvalidity, backfill_done=excluded.backfill_done""",
        (account, mailbox, uidvalidity, int(backfill_done)),
    )
    db.commit()

    uids = uids_to_fetch(db, imap, account, mailbox, uidvalidity, backfill_done)
    complete = limit is None or len(uids) <= limit
    if limit is not None:
        uids = uids[:limit]
    if uids:
        print(f"{account} {mailbox}: {len(uids)} to fetch", file=sys.stderr)

    attrs = "UID FLAGS INTERNALDATE RFC822.SIZE"
    if is_gmail(imap):
        attrs += " X-GM-THRID X-GM-MSGID X-GM-LABELS"
    attrs = f"({attrs} BODY.PEEK[])"

    events, stored = [], 0
    for start in range(0, len(uids), BATCH_SIZE):
        batch = ",".join(map(str, uids[start:start + BATCH_SIZE]))
        typ, data = imap.uid("FETCH", batch, attrs)
        if typ != "OK":
            raise imaplib.IMAP4.error(f"fetch failed in {mailbox}: {data}")
        for meta, raw in parse_fetch(data):
            event = record_message(db, acct, mailbox, uidvalidity, meta, raw)
            stored += 1
            # A first backfill isn't news. Only mail arriving after it is an event.
            if event and backfill_done:
                events.append(event)
        db.commit()
        print(f"  {min(start + BATCH_SIZE, len(uids))}/{len(uids)}", file=sys.stderr)

    if complete:
        db.execute("UPDATE mailboxes SET backfill_done=1 WHERE account=? AND mailbox=?", (account, mailbox))
        db.commit()
    return events, stored


def append_events(events):
    if not events:
        return
    fd = os.open(data_dir() / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a") as handle:
        for event in events:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def sync_once(db, acct, limit):
    imap = connect(acct)
    events, stored = [], 0
    try:
        remaining = limit
        for mailbox in mailboxes_to_sync(imap):
            new_events, new_stored = sync_mailbox(db, imap, acct, mailbox, remaining)
            events += new_events
            stored += new_stored
            if remaining is not None:
                remaining -= new_stored
                if remaining <= 0:
                    break
    finally:
        try:
            imap.logout()
        except (imaplib.IMAP4.error, OSError):
            pass
    if stored:
        refresh_noise(db)
        db.commit()
    append_events(events)
    return stored, events


def sync_with_retry(db, acct, limit):
    """Sync is resumable by construction (it fetches what's missing), so a failure just means run it again."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return sync_once(db, acct, limit)
        except AuthFailed:
            raise
        except (imaplib.IMAP4.error, imaplib.IMAP4.abort, OSError) as err:
            db.rollback()
            if attempt == MAX_ATTEMPTS:
                raise SyncStopped(
                    f"{acct['address']}: stopped after {attempt} attempts ({err}). "
                    "Everything fetched so far is saved; rerun to resume. "
                    "Gmail caps daily IMAP downloads, so a big first sync can take several days."
                ) from err
            wait = RETRY_BASE_SECONDS * 2 ** (attempt - 1)
            print(f"{acct['address']}: {err}; retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def cmd_add(args):
    refuse_git_checkout(config_path())
    print("Use an app password, not your account password.")
    password = getpass.getpass(f"App password for {args.address}: ").replace(" ", "")
    acct = {"address": args.address, "host": args.host, "port": args.port, "password": password}
    imap = connect(acct)
    boxes = mailboxes_to_sync(imap)
    imap.logout()
    accounts = [a for a in load_accounts() if a["address"] != args.address] + [acct]
    save_accounts(accounts)
    print(f"Connected {args.address}. Will sync: {', '.join(boxes)}")
    print(f"Saved to {config_path()} (owner-only permissions).")


def cmd_accounts(args):
    db = open_db()
    for acct in load_accounts():
        row = db.execute(
            "SELECT count(*) n, min(date) oldest, max(date) newest, coalesce(sum(size),0) bytes "
            "FROM messages WHERE account=? AND is_primary=1", (acct["address"],)
        ).fetchone()
        done = db.execute(
            "SELECT count(*) total, coalesce(sum(backfill_done),0) done FROM mailboxes WHERE account=?",
            (acct["address"],),
        ).fetchone()
        status = "backfilled" if done["total"] and done["total"] == done["done"] else "backfill incomplete"
        print(f"{acct['address']}: {row['n']} messages, {row['bytes'] / 1e9:.2f} GB, "
              f"{row['oldest'] or '-'} to {row['newest'] or '-'}, {status}")


def cmd_sync(args):
    db = open_db()
    failed = False
    for acct in select_accounts(args.account):
        try:
            stored, _ = sync_with_retry(db, acct, args.limit)
            print(f"{acct['address']}: fetched {stored}")
        except (AuthFailed, SyncStopped) as err:
            print(err, file=sys.stderr)
            failed = True
    sys.exit(1 if failed else 0)


def cmd_watch(args):
    db = open_db()
    accounts = select_accounts(args.account)
    print(f"Watching {len(accounts)} account(s) every {args.interval}s. Events: {data_dir() / 'events.jsonl'}", file=sys.stderr)
    while True:
        for acct in accounts:
            try:
                _, events = sync_with_retry(db, acct, None)
                for event in events:
                    print(json.dumps(event, ensure_ascii=False), flush=True)
            except (AuthFailed, SyncStopped) as err:
                print(err, file=sys.stderr)
        time.sleep(args.interval)


def search(db, query=None, account=None, sender=None, since=None, until=None, limit=25, relevance=False):
    """Rows matching an FTS5 query and filters. Raises ValueError on a bad query."""
    where, params = ["m.is_primary=1"], []
    if account:
        where.append("m.account=?")
        params.append(account)
    if sender:
        where.append("m.from_addr LIKE ?")
        params.append(f"%{sender}%")
    if since:
        where.append("m.date >= ?")
        params.append(since)
    if until:
        where.append("m.date < ?")
        params.append(until)
    if query:
        sql = ("SELECT m.id, m.account, m.date, m.from_addr, m.subject, m.labels, m.thread_id, "
               "snippet(messages_fts, 3, '[', ']', '...', 24) AS snippet "
               "FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid "
               "WHERE messages_fts MATCH ? AND " + " AND ".join(where))
        params.insert(0, query)
        sql += " ORDER BY rank" if relevance else " ORDER BY m.date DESC"
    else:
        sql = ("SELECT m.id, m.account, m.date, m.from_addr, m.subject, m.labels, m.thread_id, '' AS snippet "
               "FROM messages m WHERE " + " AND ".join(where) + " ORDER BY m.date DESC")
    try:
        return db.execute(sql + " LIMIT ?", (*params, limit)).fetchall()
    except sqlite3.OperationalError as err:
        raise ValueError(f'Bad search query ({err}). Quote exact phrases: \'"term sheet"\'') from err


def cmd_search(args):
    db = open_db()
    try:
        rows = search(db, args.query, args.account, args.sender, args.since, args.until, args.limit, args.relevance)
    except ValueError as err:
        sys.exit(str(err))
    for row in rows:
        if args.json:
            print(json.dumps(dict(row), ensure_ascii=False))
        else:
            print(f"{row['id']:>8}  {(row['date'] or '')[:10]}  {row['account']}  {row['from_addr'][:40]}  {row['subject'][:80]}")
            if row["snippet"]:
                print(f"          {' '.join(row['snippet'].split())}")


def cmd_show(args):
    db = open_db()
    row = db.execute("SELECT * FROM messages WHERE id=?", (args.id,)).fetchone()
    if row is None:
        sys.exit(f"No message {args.id}")
    path = raw_path(row["account"], row["sha256"])
    if args.raw:
        print(path)
        return
    if args.json:
        print(json.dumps({**dict(row), "raw_path": str(path)}, ensure_ascii=False))
        return
    for label, key in (("From", "from_addr"), ("To", "to_addr"), ("Date", "date"), ("Subject", "subject"),
                       ("Labels", "labels"), ("Attachments", "attachments")):
        if row[key]:
            print(f"{label}: {row[key]}")
    print(f"Raw: {path}\n\n{row['body']}")


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def cmd_attachments(args):
    db = open_db()
    if args.backfill:
        scanned, found = backfill_attachments(db, args.account)
        print(f"Scanned {scanned} messages, found {found} attachment parts.")
        for row in attachment_report(db, args.account):
            label = f"{row['kind']} (noise)" if row["is_noise"] else row["kind"]
            print(f"  {row['n']:>7}  {human_size(row['bytes']):>9}  {label}")
        return
    rows = find_attachments(db, args.account, args.sender, args.type, args.kind, args.since, args.until,
                            args.message, args.noise, args.limit)
    for row in rows:
        if args.json:
            print(json.dumps(dict(row), ensure_ascii=False))
        else:
            seen = f" (on {row['messages']} messages)" if row["messages"] > 1 else ""
            print(f"{row['id']:>7}  {(row['date'] or '')[:10]}  {human_size(row['size']):>9}  {row['kind']:<8}  "
                  f"{(row['filename'] or '(no name)')[:60]}  msg {row['message_id']}{seen}")


def cmd_attachment(args):
    db = open_db()
    try:
        if args.save:
            detail = attachment_detail(db, args.id)
            name = safe_filename(detail["messages"][0]["filename"] if detail["messages"] else None,
                                 f"{detail['sha256'][:12]}{attachment_suffix(detail['content_type'], None)}")
            dest = Path(args.save).expanduser() / name
            stem, n = dest.stem, 2
            while dest.exists():
                dest = dest.with_name(f"{stem} ({n}){dest.suffix}")
                n += 1
            dest.write_bytes(attachment_bytes(db, args.id))
            print(dest)
            return
        if args.path:
            print(cache_attachment(db, args.id))
            return
        detail = attachment_detail(db, args.id)
    except ValueError as err:
        sys.exit(str(err))
    if args.json:
        print(json.dumps(detail, ensure_ascii=False))
        return
    print(f"{detail['content_type']}, {human_size(detail['size'])}, {detail['kind']}"
          f"{', noise' if detail['is_noise'] else ''}\nsha256 {detail['sha256']}\nArrived on:")
    for m in detail["messages"]:
        print(f"  msg {m['id']:>7}  {(m['date'] or '')[:10]}  {m['from_addr'][:40]}  {m['filename'] or '(no name)'}")


def build_parser():
    parser = argparse.ArgumentParser(prog="kaymail", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help="connect a mailbox (prompts for an app password)")
    add.add_argument("address")
    add.add_argument("--host", default="imap.gmail.com")
    add.add_argument("--port", type=int, default=993)
    add.set_defaults(func=cmd_add)

    accounts = sub.add_parser("accounts", help="show connected accounts and sync progress")
    accounts.set_defaults(func=cmd_accounts)

    sync = sub.add_parser("sync", help="download whatever is missing, newest first; safe to rerun")
    sync.add_argument("--account")
    sync.add_argument("--limit", type=int, help="fetch at most this many messages per account")
    sync.set_defaults(func=cmd_sync)

    watch = sub.add_parser("watch", help="keep syncing; print and log newly arrived mail")
    watch.add_argument("--account")
    watch.add_argument("--interval", type=int, default=120, help="seconds between checks")
    watch.set_defaults(func=cmd_watch)

    search = sub.add_parser("search", help="full-text search across every account")
    search.add_argument("query", nargs="?", help='FTS5 syntax: term*, "exact phrase", subject:invoice, a OR b')
    search.add_argument("--account")
    search.add_argument("--from", dest="sender")
    search.add_argument("--since", help="YYYY-MM-DD")
    search.add_argument("--until", help="YYYY-MM-DD")
    search.add_argument("--limit", type=int, default=25)
    search.add_argument("--relevance", action="store_true", help="best match first instead of newest first")
    search.add_argument("--json", action="store_true")
    search.set_defaults(func=cmd_search)

    show = sub.add_parser("show", help="read one message")
    show.add_argument("id", type=int)
    show.add_argument("--raw", action="store_true", help="print the path of the original .eml")
    show.add_argument("--json", action="store_true")
    show.set_defaults(func=cmd_show)

    attachments = sub.add_parser("attachments", help="list attachments, or index them with --backfill")
    attachments.add_argument("--backfill", action="store_true", help="index every message not indexed yet; resumable")
    attachments.add_argument("--account")
    attachments.add_argument("--from", dest="sender")
    attachments.add_argument("--type", help="pdf, xlsx, image/png, ...")
    attachments.add_argument("--kind", choices=["document", "calendar", "image", "archive", "other"])
    attachments.add_argument("--since", help="YYYY-MM-DD")
    attachments.add_argument("--until", help="YYYY-MM-DD")
    attachments.add_argument("--message", type=int, help="one message's attachments")
    attachments.add_argument("--noise", action="store_true", help="include logos and tracking pixels")
    attachments.add_argument("--limit", type=int, default=50)
    attachments.add_argument("--json", action="store_true")
    attachments.set_defaults(func=cmd_attachments)

    attachment = sub.add_parser("attachment", help="one attachment: where it arrived, or its file")
    attachment.add_argument("id", type=int)
    attachment.add_argument("--save", metavar="DIR", help="decode the original file into DIR")
    attachment.add_argument("--path", action="store_true", help="decode into the local cache and print the path")
    attachment.add_argument("--json", action="store_true")
    attachment.set_defaults(func=cmd_attachment)
    return parser


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except (AuthFailed, SyncStopped) as err:
        sys.exit(str(err))


if __name__ == "__main__":
    main()
