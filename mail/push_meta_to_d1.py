#!/usr/bin/env python3
"""push_meta_to_d1: give the cloud index the laptop's per-message metadata.

Mail the laptop synced reached R2 as bare .eml files, so the Worker's backfill
indexed it with no conversation id, labels, or UID (those come from IMAP, not
from the message). The laptop index has all of them. This writes them into
D1's r2_meta table, which the backfill already reads when it indexes a
message, and fills thread_id on rows it indexed before.

  python3 mail/push_meta_to_d1.py --account michael@humain.vc            # push
  python3 mail/push_meta_to_d1.py --account michael@humain.vc --dry-run  # SQL files only

The SQL files hold message hashes and labels, so they're written to a private
temp folder and deleted afterwards unless --keep is given. Prints counts only.
Standard library only.
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kaymail  # noqa: E402

ROWS_PER_INSERT = 200
STATEMENTS_PER_FILE = 25  # 5,000 rows a file
CF = Path(__file__).resolve().parent.parent / "sync-worker" / "cf.sh"
LABEL = re.compile(r'"((?:[^"\\]|\\.)*)"|(\S+)')


def imap_list(raw):
    """IMAP's space-separated list, with quoted items unescaped: '"\\\\Inbox" Deals' -> ['\\Inbox', 'Deals']."""
    items = []
    for quoted, atom in LABEL.findall(raw or ""):
        items.append(re.sub(r"\\(.)", r"\1", quoted) if quoted or not atom else atom)
    return items


def sql_text(value):
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def meta_rows(db, account):
    return db.execute(
        """SELECT sha256, mailbox, uidvalidity, uid, date, flags, labels, thread_id
           FROM messages WHERE account=? AND is_primary=1 ORDER BY id""", (account,))


def write_files(rows, account, folder):
    files, statements, values, count = [], [], [], 0

    def flush_insert():
        if values:
            statements.append(
                "INSERT OR IGNORE INTO r2_meta (account, sha256, mailbox, uidvalidity, uid, "
                "internal_date, flags, labels, thread_id) VALUES\n" + ",\n".join(values) + ";")
            values.clear()

    def flush_file():
        flush_insert()
        if statements:
            path = folder / f"meta-{len(files) + 1:04d}.sql"
            path.write_text("\n".join(statements) + "\n")
            files.append(path)
            statements.clear()

    for sha, mailbox, uidvalidity, uid, date, flags, labels, thread_id in rows:
        values.append("(" + ", ".join([
            sql_text(account), sql_text(sha), sql_text(mailbox), str(int(uidvalidity)), str(int(uid)),
            sql_text(date), sql_text(json.dumps(imap_list(flags))), sql_text(json.dumps(imap_list(labels))),
            sql_text(thread_id or None),
        ]) + ")")
        count += 1
        if len(values) == ROWS_PER_INSERT:
            flush_insert()
            if len(statements) == STATEMENTS_PER_FILE:
                flush_file()
    flush_file()

    # Rows the backfill indexed before this metadata existed get their conversation id now.
    final = folder / f"meta-{len(files) + 1:04d}.sql"
    final.write_text(
        "UPDATE messages SET thread_id = (SELECT r.thread_id FROM r2_meta r\n"
        f"    WHERE r.account = messages.account AND r.sha256 = messages.sha256)\n"
        f"  WHERE account = {sql_text(account)} AND (thread_id IS NULL OR thread_id = '')\n"
        "    AND EXISTS (SELECT 1 FROM r2_meta r WHERE r.account = messages.account\n"
        "                AND r.sha256 = messages.sha256 AND r.thread_id IS NOT NULL);\n")
    files.append(final)
    return files, count


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--account", required=True)
    parser.add_argument("--dry-run", action="store_true", help="write the SQL files and print counts; touch nothing")
    parser.add_argument("--keep", action="store_true", help="keep the SQL files (they contain message metadata)")
    args = parser.parse_args()

    index = kaymail.data_dir() / "index.sqlite"
    db = sqlite3.connect(f"file:{index}?mode=ro", uri=True)
    folder = Path(tempfile.mkdtemp(prefix="kayos-meta-"))
    os.chmod(folder, 0o700)
    try:
        files, count = write_files(meta_rows(db, args.account), args.account, folder)
        with_thread = db.execute("SELECT count(*) FROM messages WHERE account=? AND is_primary=1 "
                                 "AND thread_id IS NOT NULL AND thread_id != ''", (args.account,)).fetchone()[0]
        print(f"{args.account}: {count} messages, {with_thread} with a conversation id, {len(files)} SQL files")
        if args.dry_run:
            print(f"dry run: nothing sent{f'; files in {folder}' if args.keep else ''}")
            return
        for n, path in enumerate(files, 1):
            subprocess.run([str(CF), "d1", "execute", "kay-os-mail-index", "--remote", "--yes", "--file", str(path)],
                           check=True, stdout=subprocess.DEVNULL)
            print(f"  {n}/{len(files)}", flush=True)
        print("done")
    finally:
        if not args.keep:
            shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    main()
