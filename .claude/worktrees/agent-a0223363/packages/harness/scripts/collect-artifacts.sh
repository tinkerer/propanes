#!/bin/sh
# Collect traces, videos, and screenshots from the harness containers.
# Usage: ./collect-artifacts.sh [output-dir]

set -e

OUTPUT_DIR="${1:-./artifacts}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="$OUTPUT_DIR/$TIMESTAMP"

mkdir -p "$DEST"

echo "Collecting artifacts to $DEST ..."

# Copy Playwright traces/videos from container
if docker cp pw-browser:/tmp/playwright-output/. "$DEST/playwright/" 2>/dev/null; then
  echo "  Playwright traces/videos copied"
else
  echo "  No Playwright artifacts found (container may not be running)"
fi

# Export feedback screenshots from server API
SERVER_URL="${PW_SERVER_URL:-http://localhost:3001}"
FEEDBACK=$(curl -sf "$SERVER_URL/api/v1/admin/feedback?limit=100" 2>/dev/null || echo "[]")

if [ "$FEEDBACK" != "[]" ]; then
  mkdir -p "$DEST/screenshots"
  echo "$FEEDBACK" | python3 -c "
import sys, json
items = json.load(sys.stdin)
if isinstance(items, dict):
    items = items.get('items', [])
for item in items:
    for ss in item.get('screenshots', []):
        print(ss['id'])
" 2>/dev/null | while read -r ssid; do
    curl -sf "$SERVER_URL/api/v1/images/$ssid" -o "$DEST/screenshots/$ssid.png" 2>/dev/null && \
      echo "  Screenshot: $ssid" || true
  done
fi

echo "Done. Artifacts at: $DEST"
ls -la "$DEST"
