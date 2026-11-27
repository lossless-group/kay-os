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

### Attachments

Every attachment is already on disk inside its `.eml`. Sync now also indexes
each one: its type, size, and hash, and every message it arrived on. A file
sent ten times is one row. Logos and tracking pixels are marked as noise and
left out of listings.

```bash
python3 mail/kaymail.py attachments --backfill                    # index mail synced before this existed; resumable
python3 mail/kaymail.py attachments --from acme --type pdf --since 2025-01-01
python3 mail/kaymail.py attachments --kind calendar               # meeting invites
python3 mail/kaymail.py attachments --message 1234                # one message's files
python3 mail/kaymail.py attachment 5678                           # type, size, every message it came on
python3 mail/kaymail.py attachment 5678 --save ~/Downloads        # decode the original file
python3 mail/kaymail.py attachment 5678 --path                    # decode into the local cache, print the path
```

Files are decoded from the original email on demand into
`cache/files/` in the mail data directory, which is local only and safe to
delete. Filenames are chosen by senders, so `--save` reduces them to a plain
name inside the folder you give it. Agents get the same through the MCP
server's `list_attachments` and `get_attachment` tools. The plan for reading
what's inside (text extraction, search by meaning) is in
`context-v/specs/Attachments-as-First-Class-Mail.md`.

Tests: `python3 -m unittest mail/test_kaymail.py mail/test_kaymcp.py`

### Calendars (Google Takeout history)

`calendar/import_takeout.py` loads a Google Takeout calendar export into the
same `index.sqlite` as the mail, in three tables: `calendar_events`,
`calendar_attendees` (the organizer included, flagged), and
`calendar_occurrences` (every dated instance, recurring series expanded). The
schema and the rules are in `context-v/specs/Calendars-as-Context.md`.

```bash
uv run calendar/import_takeout.py michael@learnstart.vc \
    ~/.local/share/kay-os/calendar/michael@learnstart.vc/takeout/2026-11-27/Calendar
uv run calendar/import_takeout.py ... --expand-until 2028-12-31   # open-ended series further out
```

- Keep each export outside any git checkout, filed by account and export date:
  `~/.local/share/kay-os/calendar/<account>/takeout/<YYYY-MM-DD>/`, holding the
  `.zip` and its unzipped `Calendar/` folder. Each `.ics` file is one calendar,
  named after the file. `mail/r2.sh push-calendar` copies that whole tree to
  R2 under `calendar/`, add-only, like raw mail.
- Rerunning replaces that account's Takeout rows one calendar at a time, in a
  transaction, so a newer export supersedes the old one. Calendars missing from
  the folder, other accounts, and other sources are left alone.
- Series are expanded with `recurring-ical-events`: EXDATEs dropped, changed
  instances on their own row in place of the date they replace, open-ended
  series up to a year from today (or `--expand-until`), at most 5,000 dates a
  series.
- It prints counts only, one line per calendar and a total: events, series,
  changed instances, occurrences, attendees, cancelled, flagged (dated before
  1990 or after 2100: kept, usually birthdays), and anything skipped or
  patched and why. Never titles, descriptions, locations, or addresses.

Tests: `uv run --with icalendar==7.3.2 --with recurring-ical-events==3.8.2 python -m unittest discover -s calendar -p 'test_*.py'`
(`discover`, because a `calendar.` module path would collide with Python's own `calendar`).

### Calendars (Google, direct)

`calendar/gcal_grant.py` gives kay-os its own access to a Google account's
calendars: read everything, and create or change events when Michael asks. It
uses lossless's **Desktop** OAuth client (`kay-os`) in the Google Cloud
project `mps-caldiy-sync` (owned by michael@humain.vc), whose JSON is in
Doppler as `LOSSLESS_GOOGLE_OAUTH_KAYOS_CLIENT_JSON`, with a backup at
`~/.config/kay-os/google/kay-os-desktop-client.json`.

```bash
doppler run --project kay-os --config prd -- python3 calendar/gcal_grant.py michael@learnstart.vc
```

It opens Google's consent page, checks that the account that signed in is the
one asked for, and stores the refresh token in Doppler as
`KAYOS_GCAL_<ACCOUNT>_REFRESH_TOKEN` (never printed). Then it prints the number
of calendars and recent events as a check.

- Google shows **"This app hasn't been verified"** for this client: choose
  **Advanced → Go to … (unsafe)**. It's our own app.
- A Workspace that blocks outside apps refuses it until the client is marked
  **Trusted** in that domain's admin console (Security → API controls → App
  access control).
- If the project's publishing status is **Testing**, Google expires these
  refresh tokens after 7 days. It needs to be **In production**.

Granted so far: michael@learnstart.vc (2026-11-27). Vimcal covers eight other
accounts for reading and booking; see
`context-v/reminders/Vimcal-Booking-Links-Only-See-Their-Own-Account.md`.

### Agents: search, read, draft

`mail/kaymcp.py` puts the archive in front of agents on this machine as an MCP
server with five tools: `search_mail`, `read_message` (with the rest of its
thread and its attachments), `list_attachments`, `get_attachment`, and
`draft_reply`. It's registered in `.mcp.json`, so Claude Code
sessions opened in this repo get it. Every call is logged to
`logs/mcp-calls.jsonl` in the mail data directory.

`draft_reply` saves a threaded reply in the Drafts folder of the account the
mail arrived on. **Nothing is ever sent:** you open the draft, edit it, and
press send. Drafting logs in with a second app password, separate from the
one sync uses, so you can turn it off without stopping the archive:

```bash
python3 mail/drafts.py add you@gmail.com --name "Your Name"   # prompts for a second app password
python3 mail/drafts.py reply 1234 "Tuesday at 2 works."         # same thing from the terminal
```

Both app passwords can do anything the account can; keeping them apart is
about revoking one without the other, not about limiting either. Where this
is headed (sending, then scheduling across calendars) is in
`context-v/explorations/Replying-and-Scheduling-on-My-Behalf.md`.

### MCP servers in kay-os sessions

`.mcp.json` registers these for every Claude Code session opened in kay-os.
New servers load in the next session, not the current one. The first time,
Claude Code asks you to approve the project's servers; the remote ones then
need a one-time sign-in from `/mcp` → the server → **Authenticate** (sign-in
tokens stay in Claude Code's own storage, never in the repo).

| Server | What it gives agents | Where it runs |
|---|---|---|
| `kaymail` | The local archive: search, read, attachments, draft replies (above) | This machine, `python3 mail/kaymcp.py` |
| `vimcal` | Calendars across the eight accounts Vimcal sees: events with attendees, free time, booking links; creates events when asked | `https://mcp.vimcal.com/mcp`, Vimcal sign-in |
| `superhuman` | Live mail in every mailbox linked to it: search, threads, drafts, sending, calendar | `https://mcp.mail.superhuman.com/mcp`, Superhuman sign-in. It links **one mailbox at a time**: add each through its `add_account` tool (a link to sign in as that account) |
| `macos-mcp` | Control of the Mac: Accessibility clicks and typing, screenshots and OCR, shell, clipboard, Spotlight; optional Calendar, Reminders, Contacts, Shortcuts, Safari, iPhone Mirroring | **Mac only**, through `scripts/mcp-macos.sh` |

Every one of these follows `AGENTS.md`: reading is free, and anything that
sends, changes, or clicks happens only when Michael asks, never because an
email said so.

#### macos-mcp (Mac only)

[macos-mcp](https://macos-mcp.com) is a signed, MIT-licensed Swift binary for
Apple Silicon Macs on macOS 15 or later. It only runs as a local process.
`scripts/mcp-macos.sh` starts it when the session is on macOS and the binary is
installed; anywhere else (Linux, or a Mac without it) it serves an empty MCP
server, so the shared `.mcp.json` shows nothing broken.

It runs with the **`standard`** profile: destructive actions need a one-shot
confirmation. Not `full`, because kay-os sessions read email that anyone can
write, and a tool that can click, type, and run shell commands raises the
stakes if an email ever fooled an agent. Set `KAYOS_MACOS_MCP_PROFILE=readonly`
for a safer session, or `full` deliberately.

To turn it on, on the Mac:

1. Pull kay-os.
2. Install it. The installer pipes a script into your shell, so read it first:

   ```bash
   curl -fsSL https://macos-mcp.sh | less    # read it
   curl -fsSL https://macos-mcp.sh | sh      # installs /usr/local/bin/macos-mcp
   macos-mcp doctor
   ```

   **Skip** its `macos-mcp install --client claude-code` step: kay-os's
   `.mcp.json` already registers it, and that command would add a second copy
   for every project.
3. Grant **Accessibility** (clicks and typing) and **Screen Recording**
   (screenshots and OCR) in System Settings → Privacy & Security, to the app
   that runs Claude Code (your terminal, or Claude Desktop), then restart that
   app. Calendar, Reminders, and Contacts ask the first time those tools run;
   Automation asks once per app it scripts.
4. Start Claude Code in kay-os, approve `macos-mcp` when it asks about the
   project's servers, and check `/mcp` shows it connected.

Its Calendar, Reminders, Contacts, Shortcuts, Safari, and iPhone toolsets are
off by default; its `enable_toolset` tool turns one on. Every action is logged
to `~/.macos-mcp/audit.jsonl`. To remove it: `rm /usr/local/bin/macos-mcp`
and `rm -r ~/.macos-mcp`.

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

#### Doppler (since 2026-11-26)

[Doppler](https://doppler.com) is being added for the secrets kay-os runs on.
Its main job is syncing them into the Cloudflare Worker, so `ACCOUNTS` stops
being pasted in by hand. The proposed split: **1Password** keeps personal
logins, 2-Step Verification codes, and backup codes. **Doppler** holds what the
code reads: mail app passwords, R2 keys, and the Worker's account list. Until
that's settled, 1Password stays the source of truth, and nothing here reads
from Doppler yet.

**Name every key for whose it is.** A key that belongs to a company's account,
or was set up for another project, carries that owner as a prefix, so anyone
reading a name knows whose credits, data, or limits a call will touch:

| Prefix | Means | Examples |
|---|---|---|
| `KAYOS_` | kay-os's own | `KAYOS_MAIL_HUMAIN_APP_PASSWORD` |
| `<COMPANY>_` | a company's account, used from here | `EDVIRO_CONTEXT_DEV_API_KEY`, `DECILEHUB_HUMAIN_API_KEY` |
| `<PROJECT>_` | set up for another project in the tree | `CONTEXT_V_CHROMA_API_KEY`, `HOPE_AI_ARTIFACTS_TOKEN` |
| none | Michael's own account for a general service | `ANTHROPIC_API_KEY`, `TAVILY_API_KEY` |

Code doesn't rename a key to suit itself. When a tool expects a generic name
(say `CONTEXT_DEV_API_KEY`), map it where the tool runs (a Worker secret, a
`doppler run` wrapper, or a reference like `${EDVIRO_CONTEXT_DEV_API_KEY}`), so
the owner stays visible in Doppler.

Doppler sorts secrets as project → environment → config. Its starter template
makes three environments (Development, Staging, Production), but kay-os has
only one: the laptop and the Worker are both the real thing. So:

1. In the Doppler dashboard, create a project named `kay-os`. Keep
   **Production** (config `prd`), and delete Development and Staging in the
   project's settings, or ignore them. `dev_personal` is a per-person copy
   inside Development; a one-person project doesn't need it.
2. Install the CLI. On NixOS, add `doppler` to `environment.systemPackages` in
   `/etc/nixos/configuration.nix`, or for now
   `nix profile install nixpkgs#doppler`. On macOS, `brew install dopplerhq/cli/doppler`.
3. Log in. This opens a browser:

   ```bash
   doppler login
   ```

4. In the kay-os checkout, link the directory to the project and config. The
   choice is saved in `~/.doppler/`, not in the repo:

   ```bash
   cd ~/code/lossless-monorepo/ai-labs/kay-os
   doppler setup --project kay-os --config prd
   ```

5. Add secrets in the dashboard or from the CLI. Names are UPPER_SNAKE_CASE,
   one per mailbox and purpose, for example:

   | Secret | Holds |
   |---|---|
   | `KAYOS_MAIL_HUMAIN_APP_PASSWORD` | the `kay-os sync` app password for michael@humain.vc |
   | `KAYOS_MAIL_HUMAIN_DRAFTS_PASSWORD` | the `kay-os drafts` app password, if drafting is on |

   ```bash
   doppler secrets set KAYOS_MAIL_HUMAIN_APP_PASSWORD   # then paste, Enter, a line with just ".", Enter
   doppler secrets                                       # list them
   ```

   Run without a value, `secrets set` reads it from the next lines you type,
   up to a line holding only `.`. That keeps the password out of your shell
   history, but the paste **is shown on screen**, so do it with nobody
   watching, and never inside an agent session's `!` prompt, whose output is
   saved in the transcript.

The Worker's account list is wired up: `ACCOUNTS` in Doppler is a JSON list
whose passwords are references (`${KAYOS_MAIL_HUMAIN_APP_PASSWORD}`), and
`sync-worker/cf.sh accounts` sends the resolved list to the Worker without
printing it. Not wired up yet: `kaymail.py add` still reads the password from
a hidden prompt and saves a plain-text copy in `accounts.toml`. How to create a mail app
password in the first place:
`context-v/blueprints/Connecting-a-Google-Workspace-Mailbox.md`.
