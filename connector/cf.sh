#!/usr/bin/env bash
# Run wrangler against the connector Worker (kay-os-connector at mcp.kay-os.lol).
#   ./cf.sh deploy | ./cf.sh tail | ./cf.sh deployments list | ./cf.sh versions view <id>
#
# sync-worker/cf.sh changes into sync-worker/ before it runs, so `deploy` there
# always deploys the mail-sync Worker, even when run from this folder. This
# script reuses its credentials (kay-os/.env, else 1Password) and points
# wrangler at this folder's wrangler.jsonc.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  "" ) echo "usage: connector/cf.sh <wrangler command> [args]" >&2; exit 2 ;;
  accounts ) echo "accounts is a sync-worker command; run sync-worker/cf.sh accounts" >&2; exit 2 ;;
esac
# Bundling resolves imports from connector/node_modules, so install first.
[ -d "$here/node_modules" ] || (cd "$here" && pnpm install --frozen-lockfile)
exec "$here/../sync-worker/cf.sh" "$@" --config "$here/wrangler.jsonc"
