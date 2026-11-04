# kay-os

A personal assistant agent colony for ADHD/2ex allstars

## Mail

`mail/kaymail.py` pulls every connected mailbox onto this disk, indexes it for
search, and logs new arrivals for monitoring agents. It only needs Python 3.11+.

```bash
python3 mail/kaymail.py add you@gmail.com   # prompts for an app password
python3 mail/kaymail.py sync --limit 200    # try it on the newest 200
python3 mail/kaymail.py sync                # the full archive; safe to rerun
mail/backfill.sh you@gmail.com              # same, but retries through provider limits
python3 mail/kaymail.py search '"term sheet"' --from acme --since 2023-01-01
python3 mail/kaymail.py show 1234
python3 mail/kaymail.py watch               # poll; new mail goes to events.jsonl
```

A big first sync can take days, because Gmail caps daily IMAP downloads. Run
`backfill.sh` once per account under `nohup` or similar, with its log in
`~/.local/share/kay-os/mail/logs/`. It stops if a login fails, and restarting it
resumes where it left off. Mail arrives newest first and is searchable right away.

Non-Gmail accounts take `--host imap.example.com`. Search uses
[FTS5 syntax](https://www.sqlite.org/fts5.html#full_text_query_syntax), and
`--json` gives agents one record per line.

- **Read-only.** Mailboxes open with `EXAMINE` and bodies fetch with `BODY.PEEK`,
  so a sync can't mark, move, or delete anything. Mail deleted upstream stays here.
- **Outside this public repo.** Credentials are in
  `~/.config/kay-os/mail/accounts.toml`, mail in `~/.local/share/kay-os/mail/`, both
  owner-only and in plain text. The tool refuses to use a path inside a git checkout.
- **Email is untrusted input.** Anyone can write text into your archive by sending
  you a message, so agents reading it shouldn't also hold tools that can send or
  delete without a human approving.

Tests: `python3 -m unittest mail/test_kaymail.py`
