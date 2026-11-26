---
title: "Connecting a Google Workspace Mailbox — 2-Step Verification, IMAP, and an App Password"
lede: "Two mailboxes are already connected, but the steps were never written down. This is the click-by-click playbook for the third, and for every one after it."
date_created: 2026-11-26
date_modified: 2026-11-26
date_authored_initial_draft: 2026-11-26
date_authored_current_draft: 2026-11-26
authors:
  - Michael Staton
augmented_with:
  - Claude Code on Claude Opus 5.5
at_semantic_version: 0.0.1.0
status: Draft
site_uuid: 1848de68-907c-4e06-9f8c-ee5a3333c385
hex_code: v36uyg
summary: >-
  A click-by-click playbook for connecting a Google Workspace mailbox to
  kay-os. The Workspace admin allows 2-Step Verification and IMAP in the Admin
  console. The mailbox owner turns on 2-Step Verification, checks that All
  Mail is visible to IMAP, and creates an app password. `kaymail.py add` tests
  and saves it, then a small sync, the full backfill, and optionally a drafting
  password and the Cloudflare sync Worker. Lists what you should see at each
  step, the exact errors each missed step produces, how to revoke access, and
  OAuth as the read-only route kaymail doesn't speak yet. The first account to
  follow it is michael@humain.vc.
tags:
  - Blueprint
  - Playbook
  - Mail
  - Google-Workspace
  - IMAP
  - App-Passwords
publish: true
type: Blueprints
---

# Connecting a Google Workspace Mailbox

kay-os reads mail over IMAP, logged in with an **app password**: a
16-character password Google generates for one app, which can be revoked
without touching the account's real password. Two mailboxes are already
connected this way, `mpstaton@gmail.com` (personal Gmail) and
`michael@learnstart.vc` (Google Workspace), so the route works on Workspace.
What we never wrote down was each click, and which ones belong to the
Workspace admin versus the mailbox owner. This is that list.

The next mailbox is **`michael@humain.vc`**. It's newer and much smaller than
the other two, so it's the place to build and test the attachments, D1, and
connector work in [[Attachments-Search-and-a-Knowledge-Graph]] before running
it over 440,000 messages.

Related: [[Mail-Archive-in-Cloudflare-R2]] (the bucket and the Worker),
[[Database-Setup-for-Email]] (where the mail lands).

Google moves these menus around. Every path below was checked against Google's
help pages in November 2026. If a label doesn't match, use the search bar at
the top of the Admin console or of your Google Account page, and type the
setting's name.

## Overview

| Part | Who | Where | Time |
|---|---|---|---|
| A. Allow 2-Step Verification | Workspace super admin | admin.google.com | 2 min |
| B. Allow IMAP | Workspace super admin | admin.google.com | 2 min, then up to 24 h to apply |
| C. Turn on 2-Step Verification | Mailbox owner | myaccount.google.com | 5 min |
| D. Check All Mail is visible to IMAP | Mailbox owner | Gmail settings | 1 min |
| E. Create the app password | Mailbox owner | myaccount.google.com | 1 min |
| F. Connect and sync | You, in a terminal | the kay-os checkout | minutes for a small inbox |
| G. Optional: drafting | Mailbox owner + terminal | both | 2 min |
| H. Optional: the Worker | Terminal | `sync-worker/` | 5 min |

An admin can allow or block IMAP and revoke app passwords, but **can't create
an app password for a user**. Parts C, D, and E always happen signed in as the
mailbox itself. If you're also the domain's admin, you do everything.

> **The app password is not made in the Admin console.** Make it in your own
> Google Account, signed in as the mailbox:
> **<https://myaccount.google.com/apppasswords>**
>
> - `admin.google.com` (the Admin console) holds the domain-wide switches:
>   parts A and B.
> - `myaccount.google.com` (your Google Account) holds your own mailbox's
>   settings: 2-Step Verification at
>   <https://myaccount.google.com/security> (part C) and app passwords at
>   <https://myaccount.google.com/apppasswords> (part E).
>
> If the app passwords page says the setting isn't available, turn on 2-Step
> Verification first. If that option is missing too, the admin has to do
> part A.

## Before you start

1. **Sign in as the right account.** If you're signed into several Google
   accounts, Google often opens the wrong one. Use a separate browser profile,
   or a private window, signed in only as `michael@humain.vc`. Check the round
   avatar at the top right of any Google page: click it, and the email under
   your name is the account you're acting as.
2. **Find out if you're the admin.** Open [admin.google.com](https://admin.google.com).
   - If the Admin console opens, you're an admin. Do parts A and B yourself.
   - If you see *"You don't have access"* or get sent to your Google Account
     page, you're not. Whoever set up `humain.vc` (whoever pays for its
     Workspace) is. Send them parts A and B, or ask them for a yes that both
     are already on. Many domains already have both, so check before asking.
3. **Have 1Password open.** You'll save backup codes and the app password.

## A. Admin: allow 2-Step Verification

Google help: [Deploy 2-Step Verification](https://knowledge.workspace.google.com/admin/security/deploy-2-step-verification).

1. At [admin.google.com](https://admin.google.com), signed in as a **super
   admin**.
2. Click **Menu** (☰, top left) → **Security** → **Authentication** →
   **2-step verification**.
3. The left panel lists organizational units. Leave the top one (the domain
   name) selected to apply to everyone, or pick the unit you're in.
4. Under *Authentication*, check **Allow users to turn on 2-Step
   Verification**.
5. Leave **Enforcement** as it was. Turning it **On** forces 2-Step
   Verification on every user in that unit, which isn't needed here and will
   surprise your colleagues.
6. Leave **Methods** as **Any**. *Only security key* blocks app passwords
   (see the failures table).
7. Click **Save**.

## B. Admin: allow IMAP

Google help: [Recommendations for setting up IMAP](https://support.google.com/a/answer/10547014).

1. At [admin.google.com](https://admin.google.com): **Menu** (☰) → **Apps** →
   **Google Workspace** → **Gmail** → **End User Access**.
2. In the left panel, pick the domain (everyone) or your organizational unit.
   The setting is per unit, so repeat it for every unit that needs it.
3. Scroll to **POP and IMAP access**. Hover over it and click the pencil icon
   to edit.
4. Check **Enable IMAP access for all users**.
5. Under the mail-client option, choose **Allow any mail client**. The other
   choice, restricting IMAP to a list of OAuth client IDs, shuts out app
   passwords, since kaymail isn't an OAuth client.
6. Click **Save**.

Google says changes can take up to 24 hours to apply; in practice it's often
15 to 30 minutes. If part F fails with the IMAP error in the failures table
right after this, wait and retry. Don't create a new app password.

Ignore any guide that mentions **Less secure apps**. Google removed that
setting for every account in 2025.

## C. Mailbox owner: turn on 2-Step Verification

1. Signed in as `michael@humain.vc`, open
   [myaccount.google.com/security](https://myaccount.google.com/security).
2. Find the section **How you sign in to Google**, and click
   **2-Step Verification**. Google asks for your password again.
3. If it already says **On**, skip to part D.
4. Click **Turn on 2-Step Verification** and follow the prompts. Use an
   **authenticator app**. 1Password can hold the code: in the account's
   1Password item, add a *One-Time Password* field and scan the QR code
   Google shows. Don't choose a security key as the *only* method.
5. On the same page, click **Backup codes** → **Get backup codes**. Save all
   ten in the account's 1Password item. They're how you get back in if the
   authenticator is lost.

If there's no 2-Step Verification option at all, part A hasn't been done for
your unit yet.

## D. Mailbox owner: check All Mail is visible to IMAP

kaymail syncs Gmail's **All Mail** folder, which holds every message once with
its labels. If All Mail is hidden from IMAP, part F stops with *"All Mail is
hidden from IMAP."*

1. Open [mail.google.com](https://mail.google.com) as `michael@humain.vc`.
2. Click the **gear** icon (top right) → **See all settings**.
3. Open the **Labels** tab.
4. Find **All Mail** under *System labels*. In the **Show in IMAP** column,
   make sure the box is checked. If it isn't, check it. Settings on this tab
   save on their own.
5. While you're in settings, open **Forwarding and POP/IMAP**. If there's an
   **IMAP access** section with **Enable IMAP**, select it and click
   **Save Changes** at the bottom. Some accounts no longer have this switch,
   because the admin setting in part B controls it. If it's missing, that's
   fine.

## E. Mailbox owner: create the app password

1. Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   directly. Google doesn't link this page from its menus anymore. You can
   also type **App passwords** into the search bar at the top of your Google
   Account page. Google may ask for your password again.
2. Under **App name**, type **`kay-os sync`**. The name only tells you later
   what it was for.
3. Click **Create**.
4. A box shows the password as four groups of four letters, like
   `abcd efgh ijkl mnop`. **Google shows it once.** Copy it now.
5. Save it in 1Password, in the `michael@humain.vc` login item. Add a password
   field labeled *kay-os sync app password*, or make a new item called
   *kay-os sync — michael@humain.vc*. Put it in the same vault as the
   account's own login.
   If Doppler is set up (see *Secrets → Doppler* in the kay-os README), also
   store it there as `KAYOS_MAIL_HUMAIN_APP_PASSWORD` in the `kay-os` project,
   config `prd`. In a normal terminal (not an agent session, whose output is
   saved), run `doppler secrets set KAYOS_MAIL_HUMAIN_APP_PASSWORD`, paste,
   press Enter, type a line with just `.`, and press Enter. The paste shows on
   screen.
6. Click **Done**. The page now lists *kay-os sync* with its creation date.
   You can delete it there at any time.

If the page says *"The setting you are looking for is not available for your
account,"* go to the failures table.

## F. Connect and sync

In a terminal, from the kay-os checkout (Python 3.11 or newer; `python3
--version` to check):

```bash
cd ~/code/lossless-monorepo/ai-labs/kay-os
python3 mail/kaymail.py add michael@humain.vc
```

You'll see:

```
Use an app password, not your account password.
App password for michael@humain.vc:
```

Paste the app password and press **Enter**. **Nothing appears while you
paste**; the input is hidden. The spaces don't matter, since kaymail strips
them. It then logs in before it saves anything. On success:

```
Connected michael@humain.vc. Will sync: [Gmail]/All Mail
Saved to /home/mps/.config/kay-os/mail/accounts.toml (owner-only permissions).
```

If it fails, nothing was saved. Fix the cause from the failures table and run
`add` again.

Then sync a small slice first, check it, and pull the rest:

```bash
python3 mail/kaymail.py sync --account michael@humain.vc --limit 200   # newest 200
python3 mail/kaymail.py accounts                                       # counts, dates, status
python3 mail/kaymail.py search --account michael@humain.vc --limit 5   # newest 5, as a sanity check
mail/backfill.sh michael@humain.vc                                     # everything else; resumable
```

- `accounts` prints a line like `michael@humain.vc: 200 messages, 0.05 GB,
  2026-… to 2026-…, backfill incomplete`. It reads *backfilled* once the
  backfill finishes.
- `backfill.sh` writes its progress to
  `~/.local/share/kay-os/mail/logs/backfill-michael@humain.vc.log`. Follow it
  with `tail -f` on that file. A small inbox finishes in one run, in minutes.
  Gmail's daily IMAP download cap only matters for archives the size of the
  other two. If it does hit the cap, the script waits 30 minutes and tries
  again, for up to ten days.
- The password is in `~/.config/kay-os/mail/accounts.toml` and the mail in
  `~/.local/share/kay-os/mail/`, both readable only by you. kaymail refuses to
  keep either inside a git checkout.

## G. Optional: drafting

Drafting saves replies to the Drafts folder and never sends. It uses its own
app password, so you can switch drafting off without stopping the archive.

1. Repeat part E with the app name **`kay-os drafts`**. Save it in 1Password
   next to the first one.
2. Run:

   ```bash
   python3 mail/drafts.py add michael@humain.vc --name "Michael Staton"
   ```

   Paste the drafting password when asked, the same way.

## H. Optional: hand it to the Worker

To keep the account current from Cloudflare without the laptop, add it to the
sync Worker's account list. See [[Mail-Archive-in-Cloudflare-R2]] for the full
picture.

1. Push the backfill to R2 first, the same order LearnStart followed:

   ```bash
   mail/r2.sh push
   ```

2. Replace the Worker's account list. **This replaces the whole list**, so
   paste every account the Worker should sync, not just the new one. The
   other passwords are in 1Password and in `accounts.toml`.

   ```bash
   cd sync-worker && ./cf.sh secret put ACCOUNTS
   # paste: [{"address":"michael@learnstart.vc","password":"..."}, {"address":"michael@humain.vc","password":"..."}]
   ```

3. Check it within five minutes with `sync-worker/cf.sh tail`. You should
   see a line like `michael@humain.vc: fetched N`.

## When it fails

The error text below is what Gmail's IMAP server returns. kaymail prints it
after `michael@humain.vc: login failed:`.

| What you see | Cause | Fix |
|---|---|---|
| App passwords page: *"The setting you are looking for is not available for your account"* | 2-Step Verification is off; or it's set to security key only; or the account is in Advanced Protection; or the admin's policy blocks app passwords | Do part C. Add an authenticator method. If it still fails, ask the admin. |
| No 2-Step Verification option in part C | The admin hasn't done part A for your unit | Part A |
| `[ALERT] Application-specific password required` | The account's real password was pasted, not the app password | Part E, then `add` again |
| `[AUTHENTICATIONFAILED] Invalid credentials (Failure)` | A mistyped or revoked app password | Create a fresh one (part E). Delete the old one from the App passwords page. |
| `[ALERT] Your account is not enabled for IMAP use` | IMAP is off for your unit, or the change from part B hasn't applied yet | Part B, or part D step 5. If part B was just done, wait up to 24 hours. |
| `All Mail is hidden from IMAP. Enable "Show in IMAP" for it in Gmail settings > Labels.` | All Mail's *Show in IMAP* box is unchecked | Part D |
| Worked before, fails now | The app password was deleted; the account password was changed (which revokes every app password); or the admin changed policy | New app password (part E), then `add` again |
| `backfill.sh` stops with `=== stopped: login failed` in its log | Any of the login errors above | It stops on purpose, so repeated bad logins don't lock the account. Fix and rerun it. |

## Revoking access

- **The mailbox owner:** on the [App passwords](https://myaccount.google.com/apppasswords)
  page, click the trash icon next to *kay-os sync* or *kay-os drafts*.
  Changing the account password also revokes every app password.
- **The admin:** revoke the user's app passwords from the user's page in the
  Admin console, or turn IMAP off in part B.
- **Locally:** delete the account's block from `accounts.toml`. The archived
  mail stays in `~/.local/share/kay-os/mail/` until you delete it.
- **The Worker:** run part H step 2 again without the account.

## What an app password can do

Everything. It isn't limited to reading mail. kay-os stays read-only by
construction (`EXAMINE`, `BODY.PEEK`, and an IMAP client that rejects write
commands), but anything holding the password could send, delete, or read the
whole account. That's why it lives only in 1Password, `accounts.toml`, and the
Worker secret.

The read-only alternative is **OAuth with the `gmail.readonly` scope**. In a
Workspace domain, an app registered as *Internal* in the domain's own Google
Cloud project skips Google's app review. kaymail doesn't speak OAuth yet
(XOAUTH2 over IMAP, or the Gmail API). It's worth adding before a cloud
connector holds these credentials. That ties into
[[Attachments-Search-and-a-Knowledge-Graph]] and
[[A-Gateway-Between-Agents-and-My-Accounts]].
