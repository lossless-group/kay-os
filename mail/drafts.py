#!/usr/bin/env python3
"""drafts: write reply drafts into a mailbox's Drafts folder. Nothing is sent.

This is the only kay-os code that writes to a mail server, and all it can do is
APPEND a message flagged \\Draft. It logs in with its own app password
(`draft_password` in accounts.toml), never the one kaymail syncs with, so you can
revoke drafting without touching the archive. You open the draft in Gmail or on
your phone, edit it, and press send yourself.

Standard library only. Run `drafts.py --help`.
"""

import argparse
import email
import email.policy
import email.utils
import getpass
import imaplib
import sys
import time
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kaymail  # noqa: E402

MAX_QUOTED_CHARS = 20_000


def drafter(address):
    """The account entry with its drafting password swapped in for the sync one."""
    acct = next((a for a in kaymail.load_accounts() if a["address"] == address), None)
    if acct is None:
        raise ValueError(f"Unknown account: {address}")
    if not acct.get("draft_password"):
        raise ValueError(f"Drafting isn't set up for {address}. Run: drafts.py add {address}")
    return {**acct, "password": acct["draft_password"]}


def addresses(*values):
    return [(name, addr) for name, addr in email.utils.getaddresses([v for v in values if v]) if addr]


def build_reply(raw, own_address, body, reply_all=False, from_name=None):
    """A reply to `raw` from `own_address`, threaded and quoting the original."""
    original = email.message_from_bytes(raw, policy=email.policy.default)
    own = own_address.lower()
    sender = addresses(kaymail.header(original, "reply-to")) or addresses(kaymail.header(original, "from"))
    if all(addr.lower() == own for _, addr in sender):
        # Replying to my own message: it goes back to whoever I wrote to.
        sender = addresses(kaymail.header(original, "to"))
    to, cc, seen = [], [], {own}
    for name, addr in sender:
        if addr.lower() not in seen:
            seen.add(addr.lower())
            to.append(email.utils.formataddr((name, addr)))
    if reply_all:
        for name, addr in addresses(kaymail.header(original, "to"), kaymail.header(original, "cc")):
            if addr.lower() not in seen:
                seen.add(addr.lower())
                cc.append(email.utils.formataddr((name, addr)))
    if not to:
        raise ValueError("Couldn't work out who to reply to")

    subject = kaymail.header(original, "subject").strip()
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    message_id = kaymail.header(original, "message-id").strip()
    references = " ".join(filter(None, [kaymail.header(original, "references").strip(), message_id]))

    reply = EmailMessage()
    reply["From"] = email.utils.formataddr((from_name or "", own_address))
    reply["To"] = ", ".join(to)
    if cc:
        reply["Cc"] = ", ".join(cc)
    reply["Subject"] = subject
    reply["Date"] = email.utils.formatdate(localtime=True)
    reply["Message-ID"] = email.utils.make_msgid(domain=own_address.rpartition("@")[2])
    if message_id:
        reply["In-Reply-To"] = message_id
        reply["References"] = references

    quoted = kaymail.parse_message(raw)["body"][:MAX_QUOTED_CHARS]
    who = kaymail.header(original, "from") or "someone"
    when = kaymail.header(original, "date")
    intro = f"On {when}, {who} wrote:" if when else f"{who} wrote:"
    lines = "\n".join(f"> {line}" if line else ">" for line in quoted.splitlines())
    reply.set_content(f"{body.rstrip()}\n\n{intro}\n{lines}\n")
    return reply


def drafts_mailbox(imap):
    boxes = kaymail.list_mailboxes(imap)
    for name, flags in boxes:
        if "\\drafts" in flags:
            return name
    for name, _ in boxes:
        if name.lower() in ("drafts", "[gmail]/drafts", "inbox.drafts"):
            return name
    raise ValueError("This mailbox has no Drafts folder")


def save_draft(acct, message):
    imap = kaymail.connect(acct)
    try:
        mailbox = drafts_mailbox(imap)
        status, data = imap.append(kaymail.quote_mailbox(mailbox), r"(\Draft)",
                                   imaplib.Time2Internaldate(time.time()), message.as_bytes())
        if status != "OK":
            raise ValueError(f"The server refused the draft: {data}")
        return mailbox
    finally:
        imap.logout()


def draft_reply(db, message_id, body, reply_all=False):
    """Draft a reply to archived message `message_id` in the account it arrived on."""
    row = db.execute("SELECT account, sha256 FROM messages WHERE id=?", (message_id,)).fetchone()
    if row is None:
        raise ValueError(f"No message {message_id}")
    acct = drafter(row["account"])
    raw = kaymail.raw_path(row["account"], row["sha256"]).read_bytes()
    reply = build_reply(raw, acct["address"], body, reply_all, acct.get("name"))
    mailbox = save_draft(acct, reply)
    return {"account": acct["address"], "mailbox": mailbox, "to": reply["To"], "cc": reply["Cc"] or "",
            "subject": reply["Subject"], "in_reply_to": reply["In-Reply-To"] or ""}


def cmd_add(args):
    kaymail.refuse_git_checkout(kaymail.config_path())
    accounts = kaymail.load_accounts()
    acct = next((a for a in accounts if a["address"] == args.address), None)
    if acct is None:
        sys.exit(f"Add the account to kaymail first: kaymail.py add {args.address}")
    print("Make a second app password just for drafting, so it can be revoked on its own.")
    password = getpass.getpass(f"Drafting app password for {args.address}: ").replace(" ", "")
    candidate = {**acct, "password": password}
    imap = kaymail.connect(candidate)
    mailbox = drafts_mailbox(imap)
    imap.logout()
    acct["draft_password"] = password
    if args.name:
        acct["name"] = args.name
    kaymail.save_accounts(accounts)
    print(f"Drafting is on for {args.address}. Drafts go to {mailbox}.")


def cmd_reply(args):
    body = sys.stdin.read() if args.body == "-" else args.body
    try:
        result = draft_reply(kaymail.open_db(), args.id, body, args.all)
    except ValueError as err:
        sys.exit(str(err))
    print(f"Draft saved in {result['account']} {result['mailbox']}: {result['subject']} -> {result['to']}")


def build_parser():
    parser = argparse.ArgumentParser(prog="drafts", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help="turn on drafting for an account (prompts for a second app password)")
    add.add_argument("address")
    add.add_argument("--name", help="display name for the From line")
    add.set_defaults(func=cmd_add)

    reply = sub.add_parser("reply", help="draft a reply to an archived message")
    reply.add_argument("id", type=int, help="message id from kaymail search")
    reply.add_argument("body", help="reply text, or - to read it from stdin")
    reply.add_argument("--all", action="store_true", help="reply to everyone on the message")
    reply.set_defaults(func=cmd_reply)
    return parser


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except kaymail.AuthFailed as err:
        sys.exit(str(err))


if __name__ == "__main__":
    main()
