#!/bin/sh
# Entrypoint for pw-browser container.
# Substitutes environment variables into init-script.js, then launches Playwright MCP.

set -e

PW_SERVER_URL="${PW_SERVER_URL:-http://pw-server:3001}"
PW_APP_KEY="${PW_APP_KEY:-}"

INIT_SCRIPT="/scripts/init-script.js"
GENERATED="/tmp/init-script-generated.js"

# Prepend window globals so init-script.js can read them
cat > "$GENERATED" <<EOF
window.__PW_SERVER_URL = '${PW_SERVER_URL}';
window.__PW_APP_KEY = '${PW_APP_KEY}';
EOF

cat "$INIT_SCRIPT" >> "$GENERATED"

echo "[pw-browser] Server URL: $PW_SERVER_URL"
echo "[pw-browser] App key: ${PW_APP_KEY:-(none)}"
echo "[pw-browser] Starting Playwright MCP on :8931"

exec node cli.js \
  --headless \
  --browser chromium \
  --no-sandbox \
  --port 8931 \
  --host 0.0.0.0 \
  --init-script "$GENERATED" \
  --save-trace \
  "$@"
