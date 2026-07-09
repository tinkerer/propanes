#!/bin/bash
set -euo pipefail
set -m

export HOME=/root
export DISPLAY="${DISPLAY:-:99}"
export IS_SANDBOX="${IS_SANDBOX:-1}"
export CLAUDE_BIN="${CLAUDE_BIN:-/usr/local/bin/claude}"
export CODEX_BIN="${CODEX_BIN:-/usr/local/bin/codex}"
export AGENT_USER="${AGENT_USER:-propanes}"
export AGENT_HOME="${AGENT_HOME:-/data/agent-home}"
export AGENT_AUTH_SEED_DIR="${AGENT_AUTH_SEED_DIR:-/var/run/propanes-agent-auth}"
export PROPANES_ROLE="${PROPANES_ROLE:-all}"

cleanup() {
  jobs -pr | xargs -r kill
}
trap cleanup EXIT TERM INT

seed_agent_home() {
  mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.codex"

  if [ -f "$AGENT_AUTH_SEED_DIR/claude-credentials.json" ]; then
    node -e 'const fs=require("fs");const seed=process.argv[1];const target=process.argv[2];let s={},t={};try{s=JSON.parse(fs.readFileSync(seed,"utf8"))}catch{};try{t=JSON.parse(fs.readFileSync(target,"utf8"))}catch{};const seedExp=s.claudeAiOauth?.expiresAt||0;const targetExp=t.claudeAiOauth?.expiresAt||0;if(!fs.existsSync(target)||fs.statSync(target).size===0||seedExp>targetExp){fs.copyFileSync(seed,target)}' \
      "$AGENT_AUTH_SEED_DIR/claude-credentials.json" \
      "$AGENT_HOME/.claude/.credentials.json"
  fi
  if [ -f "$AGENT_AUTH_SEED_DIR/codex-auth.json" ] && [ ! -s "$AGENT_HOME/.codex/auth.json" ]; then
    cp "$AGENT_AUTH_SEED_DIR/codex-auth.json" "$AGENT_HOME/.codex/auth.json"
  fi
  if [ -f "$AGENT_AUTH_SEED_DIR/codex-config.toml" ] && [ ! -s "$AGENT_HOME/.codex/config.toml" ]; then
    cp "$AGENT_AUTH_SEED_DIR/codex-config.toml" "$AGENT_HOME/.codex/config.toml"
  fi

  node -e 'const fs=require("fs");const seed=process.env.AGENT_AUTH_SEED_DIR+"/claude-config.json";const f=process.env.AGENT_HOME+"/.claude.json";let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};if(!j.oauthAccount&&fs.existsSync(seed)){try{j={...JSON.parse(fs.readFileSync(seed,"utf8")),...j}}catch{}};j.mcpServers=Object.assign({},j.mcpServers,{playwright:{type:"http",url:"http://localhost:8931/mcp"}});fs.writeFileSync(f,JSON.stringify(j))'

  chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_HOME"
  chmod 700 "$AGENT_HOME" "$AGENT_HOME/.claude" "$AGENT_HOME/.codex"
  [ ! -f "$AGENT_HOME/.claude/.credentials.json" ] || chmod 600 "$AGENT_HOME/.claude/.credentials.json"
  [ ! -f "$AGENT_HOME/.codex/auth.json" ] || chmod 600 "$AGENT_HOME/.codex/auth.json"
  [ ! -f "$AGENT_HOME/.codex/config.toml" ] || chmod 600 "$AGENT_HOME/.codex/config.toml"

  rm -rf /root/.claude /root/.codex
  ln -s "$AGENT_HOME/.claude" /root/.claude
  ln -s "$AGENT_HOME/.codex" /root/.codex
  ln -sf "$AGENT_HOME/.claude.json" /root/.claude.json
}

run_as_agent() {
  runuser -u "$AGENT_USER" -- env \
    HOME="$AGENT_HOME" \
    DISPLAY="$DISPLAY" \
    IS_SANDBOX="$IS_SANDBOX" \
    CLAUDE_BIN="$CLAUDE_BIN" \
    CODEX_BIN="$CODEX_BIN" \
    SERVER_WS_URL="${SERVER_WS_URL:-}" \
    LAUNCHER_ID="${LAUNCHER_ID:-}" \
    LAUNCHER_NAME="${LAUNCHER_NAME:-}" \
    LAUNCHER_AUTH_TOKEN="${LAUNCHER_AUTH_TOKEN:-}" \
    MAX_SESSIONS="${MAX_SESSIONS:-}" \
    TERM=xterm-256color \
    "$@"
}

seed_agent_home

if [ "$PROPANES_ROLE" != "launcher" ]; then
  # 1) ProPanes API and live terminal session service.
  node dist/session-service.js >/var/log/propanes-session-service.log 2>&1 &
  node dist/index.js >/var/log/propanes-server.log 2>&1 &
fi

# Headed display + noVNC stack.
: "${VNC_PASSWORD:?set VNC_PASSWORD from the propanes-secrets secret}"
mkdir -p /root/.vnc
x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd >/dev/null

Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac >/var/log/xvfb.log 2>&1 &
sleep 2
fluxbox >/var/log/fluxbox.log 2>&1 &
sleep 1
x11vnc -display "$DISPLAY" -rfbauth /root/.vnc/passwd -localhost -forever -shared -rfbport 5900 -quiet >/var/log/x11vnc.log 2>&1 &
sleep 1
websockify --web=/usr/share/novnc 6080 localhost:5900 >/var/log/novnc.log 2>&1 &

# Playwright MCP, headed on the virtual display.
DISPLAY="$DISPLAY" npx --yes @playwright/mcp@latest \
  --port 8931 \
  --host 127.0.0.1 \
  --allowed-hosts "localhost:8931;127.0.0.1:8931" \
  --browser chromium \
  --no-sandbox \
  >/var/log/pwmcp.log 2>&1 &

if [ "$PROPANES_ROLE" = "launcher" ]; then
  : "${SERVER_WS_URL:?set SERVER_WS_URL for launcher-only pods}"
else
  # Wait for the local server, then register the in-pod launcher.
  until curl -sf "http://localhost:${PORT:-3001}/api/v1/health" >/dev/null 2>&1; do
    sleep 1
  done
  export SERVER_WS_URL="${SERVER_WS_URL:-ws://localhost:${PORT:-3001}/ws/launcher}"
fi

export LAUNCHER_ID="${LAUNCHER_ID:-$(hostname)}"
export LAUNCHER_NAME="${LAUNCHER_NAME:-propanes-inpod}"
export MAX_SESSIONS="${MAX_SESSIONS:-5}"

run_as_agent node dist/launcher-daemon.js
