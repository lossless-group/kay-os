#!/usr/bin/env bash
# Download one account's whole mailbox, waiting out provider limits between runs.
# Stops on a login failure so a bad password can't lock the account.
# Usage: mail/backfill.sh you@example.com
set -u
account="$1"
here="$(cd "$(dirname "$0")" && pwd)"
logs="${KAYMAIL_DATA:-$HOME/.local/share/kay-os/mail}/logs"
mkdir -p "$logs"
log="$logs/backfill-$account.log"

for run in $(seq 1 480); do
  echo "=== run $run $(date -Is)" >> "$log"
  if python3 "$here/kaymail.py" sync --account "$account" >> "$log" 2>&1; then
    echo "=== complete $(date -Is)" >> "$log"
    exit 0
  fi
  if tail -n 5 "$log" | grep -q "login failed"; then
    echo "=== stopped: login failed $(date -Is)" >> "$log"
    exit 1
  fi
  sleep 1800
done
echo "=== gave up after $run runs $(date -Is)" >> "$log"
exit 1
