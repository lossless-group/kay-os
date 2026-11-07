#!/usr/bin/env bash
# Run wrangler with the Cloudflare API token from kay-os/.env (gitignored),
# or from 1Password if there's no .env.
#   ./cf.sh whoami | ./cf.sh dev | ./cf.sh deploy
set -euo pipefail
cd "$(dirname "$0")"
if [ -f ../.env ]; then
  set -a; . ../.env; set +a
  exec npx -y wrangler@4.158.0 "$@"
fi
vault="${KAYOS_OP_VAULT:-Lossless Accounts}"
item="${KAYOS_OP_ITEM:-kzjkc4imuewgr7gdorgohh4w7u}"   # "Cloudlfare kay-os-mail"
export CLOUDFLARE_API_TOKEN="op://$vault/$item/Your API Token"
export CLOUDFLARE_ACCOUNT_ID="op://$vault/$item/Account ID"
exec op run -- npx -y wrangler@4.158.0 "$@"
