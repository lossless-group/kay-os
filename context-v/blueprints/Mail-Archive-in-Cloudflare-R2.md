---
title: "Mail Archive in Cloudflare R2 — How Every Inbox Gets Into the Bucket and Stays Current"
lede: "The laptop pulled the whole history; a Cloudflare Worker keeps it current a few times a day. This is how to pick it up from any computer."
date_created: 2026-11-07
date_modified: 2026-11-26
date_authored_initial_draft: 2026-11-07
date_authored_current_draft: 2026-11-07
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.2.0
status: In-Progress
site_uuid: 20ffd63f-6afb-40fe-aac5-f92a322aed19
hex_code: l0u9rl
summary: >-
  The working blueprint for kay-os mail storage. kaymail.py backfills each
  mailbox to a laptop, r2.sh pushes it to the private R2 bucket kay-os-mail,
  and the Worker kay-os-mail-sync (a cron plus one Durable Object per account)
  fetches new mail into the same bucket at the same paths. Covers the bucket
  layout, setting up a second computer, everyday commands, the state as of
  2026-11-07, and what's next: finish and push the LearnStart backfill, then
  hand that account to the Worker.
tags:
  - Blueprint
  - Mail
  - Cloudflare-R2
  - Cloudflare-Workers
  - Durable-Objects
---

# Mail Archive in Cloudflare R2

Related: [[Email-Repository-and-Agent-Harness]], [[A-Gateway-Between-Agents-and-My-Accounts]].

## How it fits together

```
 Gmail (IMAP, read-only)
   │                     │
   │ history             │ new mail, 4× a day
   ▼                     ▼
 laptop: mail/kaymail.py     Worker kay-os-mail-sync
   ~/.local/share/kay-os/mail      cron 7/11/15/19 Central → one Durable Object per account
   │                             │
   │ mail/r2.sh push             │ writes directly
   ▼                             ▼
 ───────────── R2 bucket kay-os-mail ─────────────
```

- **History** comes from the laptop. Gmail caps daily IMAP downloads, so a
  first backfill takes days. `mail/backfill.sh` retries through the cap.
- **New mail** comes from the Worker. It begins just past where the laptop's
  archive ended (the seed), so the two never overlap.
- **Read-only everywhere.** Mailboxes open with `EXAMINE` and bodies fetch with
  `BODY.PEEK`. Nothing marks, moves, or deletes mail.

## Bucket layout (`kay-os-mail`)

| Key | What | Written by |
|---|---|---|
| `raw/<account>/<sha[:2]>/<sha>.eml` | original message bytes, named by SHA-256 | r2.sh and the Worker (same paths) |
| `index/index.sqlite` | the laptop's search index (full text of every message) | r2.sh push |
| `meta/<account>/<encodeURIComponent(mailbox)>/<uidvalidity>/<uid>.json` | per-message metadata: uid, sha256, Gmail thread id, labels | Worker |
| `state/<account>/seed.json` | `{mailbox: {uidvalidity, lastUid}}` where the laptop left off | uploaded once by hand |
| `state/<account>/status.json` | the Worker's cursors, `lastRun`, `fetched`, `lastError` | Worker, every run |

Raw files never change once written, so pushes only add.

## The Worker (`sync-worker/`)

- `src/index.ts`: the cron handler fans out to `MailboxSync` Durable Objects,
  one per address (`idFromName(address)`), so each account has at most one IMAP
  session at a time. The object keeps its cursor in Durable Object storage and
  copies it to `status.json`.
- `src/sync.ts`: `syncAccount()` handles one pass. It fetches up to 200 messages
  per run, in batches of 50. With no seed, or after a UIDVALIDITY change, it
  starts from now instead of refetching. On an error it keeps the progress so
  far and records the message in `lastError`.
- `src/imap.ts`, `src/socket.ts`: a minimal read-only IMAP client over
  `cloudflare:sockets`.
- `wrangler.jsonc`: `workers_dev: false` and `preview_urls: false`, so there is
  no public URL. Bindings: R2 `MAIL` → `kay-os-mail`, Durable Object `SYNC`.
- Schedule: `0 1,13,17,21 * * *` UTC, which is 7am, 11am, 3pm, and 7pm US
  Central (8am–8pm during daylight time). Each run fetches up to 200 new
  messages per account. Until 2026-11-26 it ran every 5 minutes.
- Secret `ACCOUNTS`: a JSON list of `{address, password, host?}` (Gmail app
  passwords). It is write-only once set. Since 2026-11-26 it comes from
  Doppler (project `kay-os`, config `prd`), where `ACCOUNTS` references each
  password by name (`${KAYOS_MAIL_HUMAIN_APP_PASSWORD}`), so each password is
  stored once. It lists **mpstaton@gmail.com, michael@humain.vc and
  michael@mandatory.ventures**.
- Index: each message is written to the D1 database `kay-os-mail-index`
  (binding `INDEX`) as it's stored. Mail already in R2 is backfilled by
  Durable Object alarms, 100 messages a chunk, until each account is done;
  progress is in `status.json` under `backfill`. See
  [[Backfill-Runs-Ended-Before-Writing-Status]].

Tests use a fake Gmail and need no network: `cd sync-worker && pnpm test && pnpm typecheck`.
`pnpm smoke` runs the IMAP client against a real server and prints counts only.

## Setting up another computer

1. Clone kay-os and check out `development`.
2. Install rclone (`brew install rclone`, `sudo pacman -S rclone`; on NixOS
   r2.sh uses `nix run`), Node 22+, and pnpm.
3. Create `kay-os/.env`. It is gitignored and never committed. The values are
   in 1Password, vault **Lossless Accounts**, item **"Cloudlfare kay-os-mail"**
   (`kzjkc4imuewgr7gdorgohh4w7u`):

   ```bash
   cd kay-os
   i="op://Lossless Accounts/kzjkc4imuewgr7gdorgohh4w7u"
   cat > .env <<EOF
   CLOUDFLARE_ACCOUNT_ID=$(op read "$i/Account ID")
   CLOUDFLARE_API_TOKEN=$(op read "$i/Your API Token")
   R2_ACCESS_KEY_ID=$(op read "$i/Access Key ID")
   R2_SECRET_ACCESS_KEY=$(op read "$i/Secret Access Key")
   R2_ENDPOINT=$(op read "$i/S3 API Endpoint")
   KAYOS_R2_BUCKET=kay-os-mail
   EOF
   chmod 600 .env
   ```

   Without a `.env`, `r2.sh` and `cf.sh` fall back to reading 1Password on each run.
4. Check that it works:

   ```bash
   mail/r2.sh check                 # keys work, bucket listing (slow: ~400k objects)
   sync-worker/cf.sh whoami         # Cloudflare account lossless-group
   cd sync-worker && pnpm install && pnpm test
   ```

5. To search mail on this machine, run `mail/r2.sh pull` to get the index, or
   `mail/r2.sh pull --raw` to get every .eml as well.

The Artifacts repo for the agent harness is in the item
**"Cloudlfare kay-os-mail-harness"** (`6cpphm6nmy6jqbmvn7kp23smwq`), which holds
the Remote URL and initial token. Nothing uses it yet.

## Everyday commands

```bash
# Is the Worker running? lastRun should be from the latest scheduled run.
sync-worker/cf.sh tail                                   # live logs: "<address>: fetched N"
rclone cat kayr2:kay-os-mail/state/mpstaton@gmail.com/status.json   # with KAYR2 env from r2.sh

# Deploy after changing sync-worker/
cd sync-worker && pnpm test && npx -y -p typescript@5.9.3 tsc --noEmit && ./cf.sh deploy

# Change the account list: edit ACCOUNTS in Doppler (kay-os/prd), then
./cf.sh accounts                # sends the resolved list from Doppler; never printed

# Laptop archive → R2 (only new files go up; the index is replaced)
mail/r2.sh push
mail/r2.sh push you@example.com # one account's raw mail only, no index
```

To make a seed for an account (run on the machine holding its archive):

```bash
sqlite3 ~/.local/share/kay-os/mail/index.sqlite \
  "select json_group_object(mailbox, json_object('uidvalidity', uidvalidity, 'lastUid', m))
     from (select mailbox, uidvalidity, max(uid) m from messages
            where account='ADDRESS' group by mailbox, uidvalidity)" > seed.json
# upload to state/ADDRESS/seed.json, using rclone with the r2.sh remote
```

The seed must exist **before** the account is added to `ACCOUNTS`. Without it,
the Worker's first run starts from now, and mail between the laptop's last
sync and that moment has to come from the laptop.

## State as of 2026-11-07

| Account | Laptop | R2 `raw/` | Cloud sync |
|---|---|---|---|
| mpstaton@gmail.com | 228,292, backfill done | 228,418 (includes new mail from the Worker) | on since 2026-11-07, cursor UID ≈815,369, no errors |
| michael@learnstart.vc | 170,150, ≈39k still to fetch | 170,150 | not yet |

The LearnStart backfill (`mail/backfill.sh michael@learnstart.vc`) runs on the
Omarchy laptop and stops at Gmail's daily OVERQUOTA. Rerunning it resumes.

## State as of 2026-11-26

| Account | Laptop | R2 `raw/` | Cloud sync |
|---|---|---|---|
| mpstaton@gmail.com | 228,292 (to 2026-11-05) | plus ≈1,570 from the Worker since 2026-11-07 | on; cursor UID 816,702 |
| michael@learnstart.vc | 210,843, backfill done | not checked | not yet |
| michael@humain.vc | 713, backfill done | 714 (pushed 2026-11-26) | on from 2026-11-26; seed UID 1127; D1 backfill done |
| michael@mandatory.ventures | 714, backfill done | 714 (pushed 2026-11-27) | on from 2026-11-27; seed UID 973; D1 backfill done |

## Next

- [ ] Finish the LearnStart backfill, then `mail/r2.sh push`.
- [ ] Make and upload LearnStart's seed, then add it to `ACCOUNTS`
      (`host` is optional; it's Gmail).
- [ ] Make `r2.sh push` run on a schedule on the syncing laptop (systemd timer),
      so the laptop's backfill reaches R2 without anyone remembering to push.
- [ ] Have the Worker write an index too. Today `index/index.sqlite` comes only
      from the laptop, so mail the Worker fetches is in `raw/` and `meta/` but
      can't be searched until something indexes it.
- [ ] Read access for agents: the connector and gateway in
      [[A-Gateway-Between-Agents-and-My-Accounts]].

## Gotchas met so far

- `wrangler login` fails on this Linux machine because its callback listens only
  on `[::1]:8976`. Use the API token through `cf.sh` instead.
- Overlapping `op` calls dismiss each other's 1Password prompts. `.env` avoids
  that.
- The 1Password items moved to the Lossless Accounts vault, which gave them new
  IDs. If `r2.sh` can't find its item, check the ID first.
- `r2.sh check` sizes every object, so it takes minutes on ~400k files.
