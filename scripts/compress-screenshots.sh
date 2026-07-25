#!/usr/bin/env bash
# Convert the raw README screenshots (e2e/screenshots/raw/*.png, produced by
# `cd e2e && npm run screenshots`) into committed WebP files under
# docs/screenshots/. Requires cwebp (NixOS: nix-shell -p libwebp; Debian:
# apt install webp).
#
# Images over the size budget are retried at lower quality, then downscaled —
# the README displays them at ~830px wide, so 2048px is still >2x sharp.
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=e2e/screenshots/raw
OUT=docs/screenshots
BUDGET=153600 # 150 KiB

command -v cwebp >/dev/null || {
  echo "cwebp not found — install libwebp (nix-shell -p libwebp / apt install webp)" >&2
  exit 1
}

shopt -s nullglob
pngs=("$RAW"/*.png)
[ ${#pngs[@]} -gt 0 ] || { echo "no PNGs in $RAW — run the capture first" >&2; exit 1; }

mkdir -p "$OUT"
for png in "${pngs[@]}"; do
  out="$OUT/$(basename "${png%.png}").webp"
  cwebp -quiet -q 80 -m 6 -sharp_yuv "$png" -o "$out"
  if [ "$(stat -c%s "$out")" -gt "$BUDGET" ]; then
    cwebp -quiet -q 75 -m 6 -sharp_yuv "$png" -o "$out"
  fi
  if [ "$(stat -c%s "$out")" -gt "$BUDGET" ]; then
    cwebp -quiet -q 75 -m 6 -sharp_yuv -resize 2048 0 "$png" -o "$out"
  fi
  printf '%-42s %6d KiB\n' "$(basename "$out")" "$(( $(stat -c%s "$out") / 1024 ))"
done

echo
echo "total: $(du -sh "$OUT" | cut -f1)"
