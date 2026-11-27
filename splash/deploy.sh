#!/usr/bin/env bash
# Build the splash for https://kay-os.lol and deploy it to the kay-os-site Worker.
#   ./deploy.sh            build and deploy
#   ./deploy.sh --dry-run  build and check the bundle, deploy nothing
#
# Only the OpenPanel client ID is read from Doppler (kay-os/prd); it ends up in
# the page's HTML by design. OPENPANEL_SECRET never goes near the build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
client_id="$(doppler secrets get OPENPANEL_CLIENT_ID --plain --no-check-version --project kay-os --config prd)"
[ -d node_modules ] || pnpm install --frozen-lockfile
SITE_URL=https://kay-os.lol OPENPANEL_CLIENT_ID="$client_id" NODE_ENV=production pnpm build
if [ "${1:-}" = "--dry-run" ]; then
  exec "$here/../sync-worker/cf.sh" deploy --dry-run --config "$here/wrangler.jsonc"
fi
exec "$here/../sync-worker/cf.sh" deploy --config "$here/wrangler.jsonc"
