#!/bin/sh
# Entrypoint for pw-server container.
# Generates .mcp.json at repo root so Claude CLI discovers browser MCP.

set -e

BROWSER_URL="${BROWSER_MCP_URL:-http://pw-browser:8931/sse}"

cat > /app/.mcp.json <<EOF
{"mcpServers":{"playwright":{"type":"sse","url":"${BROWSER_URL}"}}}
EOF

echo "[pw-server] Generated /app/.mcp.json (playwright SSE: $BROWSER_URL)"

# Start session-service in background
echo "[pw-server] Starting session-service on :3002..."
node dist/session-service.js &

# Run main server as PID 1
exec "$@"
