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

### Cloudflare R2 and other machines

`mail/r2.sh` copies the archive to a private R2 bucket and pulls it down
elsewhere. One machine syncs mail and pushes; the others pull and read.

```bash
mail/r2.sh check        # keys work? what's in the bucket?
mail/r2.sh push         # on the syncing machine: new raw mail + a fresh index
mail/r2.sh pull         # anywhere else: the index, enough to search and read
mail/r2.sh pull --raw   # also every original .eml
```

The search index holds every message's text, so a machine with only the index
can search and read mail. Raw files are named by their hash and never change,
so pushes only send what's new and never overwrite.

### Secrets

Every secret lives in 1Password and is read at run time. Nothing below is
written to disk or committed.

| Secret | Where it comes from | Where it lives | Who needs it |
|---|---|---|---|
| Mail app passwords | Google account → App passwords, one per mailbox | `~/.config/kay-os/mail/accounts.toml`, on the syncing machine only | `kaymail.py sync` |
| R2 access key ID + secret | Cloudflare → R2 → Manage API tokens, "Object Read & Write", this bucket only | 1Password, `Lossless Accounts` vault, the bucket's API Credential item | `r2.sh`, any computer |
| R2 endpoint | Cloudflare → R2 → the bucket's S3 API URL: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | same item | same |
| Bucket name | What you named the bucket (`kay-os-mail`) | not secret: `KAYOS_R2_BUCKET` | same |
| Cloudflare API token | My Profile → API Tokens, an Account token for Workers, R2 and Artifacts | same item, field `Your API Token` (plus `Account ID`) | `sync-worker/cf.sh`, to deploy |
| Artifacts repo token | Returned when the repo was created | 1Password, `Cloudlfare kay-os-mail-harness` item | git access to the harness repo |

`r2.sh` reads three fields from that item, named exactly `Access Key ID`,
`Secret Access Key`, and `S3 API Endpoint`. It finds the item by its 1Password
ID; set `KAYOS_OP_ITEM` and `KAYOS_OP_VAULT` to use a different one. It reads
the keys once per run and keeps them only in that run's memory.

Each computer needs the 1Password app with CLI integration turned on
(Settings → Developer) and rclone: `brew install rclone` on macOS,
`sudo pacman -S rclone` on Arch/Omarchy. On NixOS, `r2.sh` runs rclone through
`nix run` if it isn't installed. The iPhone holds no keys: it will reach the
archive through a connector in the Claude app, signed in like any other.
