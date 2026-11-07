#!/usr/bin/env bash
# Copy the mail archive to Cloudflare R2, or pull it down on another machine.
# Keys come from 1Password at run time and are never written to disk.
#
# Usage:
#   mail/r2.sh check    confirm the keys work and show what's in the bucket
#   mail/r2.sh push     upload new raw mail and a fresh copy of the search index
#   mail/r2.sh pull     download the search index (enough to search and read mail)
#   mail/r2.sh pull --raw   also download every original .eml
#
# Needs: the 1Password CLI (`op`, signed in) and rclone.
# Keys: the 1Password item described under "Secrets" in the README.
set -euo pipefail

vault="${KAYOS_OP_VAULT:-Personal}"
item="${KAYOS_OP_ITEM:-zqaaxeiwxhlarwydfmdumiow7e}"   # "Cloudlfare kay-os-mail"
bucket_name="${KAYOS_R2_BUCKET:-kay-os-mail}"
data="${KAYMAIL_DATA:-$HOME/.local/share/kay-os/mail}"
config="${KAYMAIL_CONFIG:-$HOME/.config/kay-os/mail/accounts.toml}"

die() { echo "r2.sh: $*" >&2; exit 1; }

command -v op >/dev/null || die "needs the 1Password CLI (op). https://developer.1password.com/docs/cli/get-started/"
if command -v rclone >/dev/null; then
  rclone=(rclone)
elif command -v nix >/dev/null; then
  rclone=(nix run nixpkgs#rclone --)
else
  die "needs rclone: 'brew install rclone' on macOS, 'sudo pacman -S rclone' on Arch/Omarchy"
fi

# rclone reads its remote from these variables; `op run` swaps each op:// reference
# for the real value, in the child process only.
ref() { echo "op://$vault/$item/$1"; }
export RCLONE_CONFIG_KAYR2_TYPE=s3
export RCLONE_CONFIG_KAYR2_PROVIDER=Cloudflare
if [ -z "${KAYR2_RESOLVED:-}" ]; then
  export RCLONE_CONFIG_KAYR2_ACCESS_KEY_ID="$(ref "Access Key ID")"
  export RCLONE_CONFIG_KAYR2_SECRET_ACCESS_KEY="$(ref "Secret Access Key")"
  export RCLONE_CONFIG_KAYR2_ENDPOINT="$(ref "S3 API Endpoint")"
fi
export RCLONE_CONFIG_KAYR2_NO_CHECK_BUCKET=true

# Resolve the keys once, then re-run this script with them in its environment
# (memory only), so a push lasting hours never stops at a second 1Password prompt.
if [ -z "${KAYR2_RESOLVED:-}" ] && [ -n "${1:-}" ]; then
  exec op run -- env KAYR2_RESOLVED=1 "$0" "$@"
fi
r2() { "${rclone[@]}" "$@"; }
# Live progress in a terminal; one summary line a minute in a log.
if [ -t 1 ]; then progress=(--progress); else progress=(--stats 1m --stats-one-line --stats-log-level NOTICE); fi
b="$bucket_name"

cmd="${1:-}"
case "$cmd" in
  check)
    echo "Bucket: $b"
    r2 size "kayr2:$b"
    ;;

  push)
    [ -d "$data/raw" ] || die "no archive at $data"
    # Raw files are named by their hash and never change, so --immutable skips
    # anything already uploaded and refuses to overwrite.
    r2 copy "$data/raw" "kayr2:$b/raw" --immutable --size-only \
      --transfers 64 --checkers 64 "${progress[@]}"
    # Snapshot the index first: a sync may be writing to it right now.
    snap="$(mktemp -d)"
    trap 'rm -rf "$snap"' EXIT
    python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close()' \
      "$data/index.sqlite" "$snap/index.sqlite"
    r2 copyto "$snap/index.sqlite" "kayr2:$b/index/index.sqlite" "${progress[@]}"
    echo "Pushed $(date -Is)"
    ;;

  pull)
    # A machine that syncs mail owns its index; pulling would overwrite it.
    [ -e "$config" ] && die "this machine syncs mail ($config exists); pull is for machines that only read"
    mkdir -p "$data" && chmod 700 "$data"
    r2 copyto "kayr2:$b/index/index.sqlite" "$data/index.sqlite" "${progress[@]}"
    chmod 600 "$data/index.sqlite"
    if [ "${2:-}" = "--raw" ]; then
      r2 copy "kayr2:$b/raw" "$data/raw" --immutable --size-only --transfers 64 "${progress[@]}"
    fi
    echo "Pulled to $data. Try: python3 mail/kaymail.py search 'invoice'"
    ;;

  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
