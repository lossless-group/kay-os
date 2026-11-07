#!/usr/bin/env bash
# Render the kay-os share images from scripts/og-template.html with headless
# Firefox (Technique B in the generate-consistent-og-images skill: rasterize
# the hero instead of illustrating it).
#
#   scripts/render-og.sh            # all formats
#   scripts/render-og.sh BannerTall # one format
#
# Run from anywhere. Writes splash/public/ogimage__Kay-Os--<Format>.jpg; an
# existing file moves to .ogimage-archive/ with today's date first.
# Needs firefox and ImageMagick (on NixOS, ImageMagick runs through nix run).
set -euo pipefail
ONLY="${1:-}"
cd "$(dirname "$0")/.."

TEMPLATE="$PWD/scripts/og-template.html"
ARCHIVE=.ogimage-archive
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if command -v magick >/dev/null; then im=(magick)
elif command -v nix >/dev/null; then im=(nix run nixpkgs#imagemagick --)
else echo "needs ImageMagick" >&2; exit 1; fi

# format  width  height   (aspect)
FORMATS=(
  "Banner 1200 630"          # 1.91:1 OG / X / Slack / LinkedIn
  "BannerTall 1200 1600"     # 3:4  WhatsApp / iMessage
  "BannerTallMax 1200 1800"  # 2:3
  "Portrait 1080 1350"       # 4:5  LinkedIn portrait / IG feed
  "PortraitTall 1080 1920"   # 9:16 Stories / Reels
  "Square 1200 1200"         # 1:1  avatars, Discord
)

render() {
  local name=$1 w=$2 h=$3 out="public/ogimage__Kay-Os--$1.jpg"
  timeout 90 firefox --headless --profile "$(mktemp -d -p "$TMP")" \
    --window-size="$w,$h" --screenshot "$TMP/$name.png" \
    "file://$TEMPLATE?w=$w&h=$h" >/dev/null 2>&1
  [ -s "$TMP/$name.png" ] || { echo "failed: $name" >&2; return 1; }
  if [ -f "$out" ]; then
    mkdir -p "$ARCHIVE"
    mv "$out" "$ARCHIVE/ogimage__Kay-Os--$name--$(date +%Y-%m-%d-%H%M%S).jpg"
  fi
  "${im[@]}" "$TMP/$name.png" -crop "${w}x${h}+0+0" -strip -quality 86 "$out"
  echo "wrote $out"
}

for f in "${FORMATS[@]}"; do
  set -- $f
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || continue
  render "$@"
done
cp public/ogimage__Kay-Os--Banner.jpg public/ogimage__Kay-Os--Default.jpg 2>/dev/null || true
