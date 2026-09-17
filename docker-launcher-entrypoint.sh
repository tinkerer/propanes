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

  # Claude Code settings: the seed carries the model/provider wiring
  # (ANTHROPIC_MODEL, the ANTHROPIC_DEFAULT_*_MODEL aliases, the Bedrock
  # switches) so a fresh agent home starts out pointed at the right provider
  # instead of at nothing.
  #
  # Bootstrap defaults, not policy: the seed only supplies keys the home does
  # not already have, at the top level and inside `env`. The live file wins
  # every conflict, because it is the one a human edits and it is the copy that
  # has been correct in practice — the GovCloud seed sat pinned to an invalid
  # model id (`claude-fable-5`) for weeks while the live file was fine, and a
  # seed that overrode `env` on each start would have re-broken a good home on
  # every restart. Repairing a bad live file stays an ops action.
  #
  # A missing, empty, or unparseable seed leaves the file untouched.
  if [ -s "$AGENT_AUTH_SEED_DIR/claude-settings.json" ]; then
    node -e 'const fs=require("fs");const seedPath=process.argv[1],targetPath=process.argv[2];let seed;try{seed=JSON.parse(fs.readFileSync(seedPath,"utf8"))}catch{};if(!seed||typeof seed!=="object"||Array.isArray(seed))process.exit(0);let cur;try{cur=JSON.parse(fs.readFileSync(targetPath,"utf8"))}catch{};if(!cur||typeof cur!=="object"||Array.isArray(cur))cur={};const out={...cur};for(const k of Object.keys(seed))if(k!=="env"&&!(k in out))out[k]=seed[k];const env={...(seed.env&&typeof seed.env==="object"?seed.env:{}),...(cur.env&&typeof cur.env==="object"?cur.env:{})};if(Object.keys(env).length)out.env=env;fs.writeFileSync(targetPath,JSON.stringify(out,null,2)+"\n")' \
      "$AGENT_AUTH_SEED_DIR/claude-settings.json" \
      "$AGENT_HOME/.claude/settings.json" \
      || echo "[entrypoint] claude-settings.json seed failed; leaving $AGENT_HOME/.claude/settings.json unchanged"
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

# Which propanes tree to run. Default is the baked /app build. A pod can opt
# into running from the NFS-mounted source tree by dropping a marker file on
# its persistent volume:
#
#   echo /mnt/stage-nfs-src/admin/propanes > /data/propanes-run-from-nfs
#
# (an empty marker uses that same default path). The marker lives on /data so
# the choice survives pod restarts and image rolls without a manifest change.
# NFS mode only engages for the artifacts the tree actually has built;
# otherwise we fall back to /app so a missing/unbuilt checkout can't brick the
# pod. Server and launcher are gated independently — a tree with a stale or
# partial build can still serve one of them.
PROPANES_APP_DIR=/app
NFS_LAUNCHER=""
NFS_MARKER=/data/propanes-run-from-nfs
if [ -f "$NFS_MARKER" ]; then
  NFS_DIR="$(head -1 "$NFS_MARKER" | tr -d '[:space:]')"
  NFS_DIR="${NFS_DIR:-/mnt/stage-nfs-src/admin/propanes}"
  if [ -f "$NFS_DIR/packages/server/dist/index.js" ]; then
    PROPANES_APP_DIR="$NFS_DIR"
    echo "[entrypoint] Running propanes services from $NFS_DIR (marker: $NFS_MARKER)"
  else
    echo "[entrypoint] $NFS_MARKER set but $NFS_DIR/packages/server/dist/index.js missing — falling back to /app"
  fi
  if [ -f "$NFS_DIR/packages/server/dist/launcher-daemon.js" ]; then
    NFS_LAUNCHER="$NFS_DIR/packages/server/dist/launcher-daemon.js"
  else
    echo "[entrypoint] $NFS_MARKER set but $NFS_DIR/packages/server/dist/launcher-daemon.js missing — launcher stays on /app"
  fi
fi

# Run a service in a restart loop so "rebuild on NFS, kill the node process"
# redeploys it without a pod restart.
supervise() {
  local script="$1" log="$2"
  while true; do
    node "$script" >>"$log" 2>&1 || true
    echo "[entrypoint $(date -Is)] $script exited, restarting in 2s" >>"$log"
    sleep 2
  done
}

if [ "$PROPANES_ROLE" != "launcher" ]; then
  # 1) ProPanes API and live terminal session service.
  cd "$PROPANES_APP_DIR/packages/server"
  supervise dist/session-service.js /var/log/propanes-session-service.log &
  supervise dist/index.js /var/log/propanes-server.log &
  cd /app/packages/server
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

# The launcher-daemon is this script's foreground process: when it exits, the
# entrypoint exits and the pod restarts. That is deliberate for the baked build
# — it is how a genuinely broken launcher surfaces as CrashLoopBackOff.
#
# In NFS mode we supervise it instead, so "rebuild on NFS, kill the launcher"
# redeploys it in place like the other services. Two guards keep that from
# hiding a broken build:
#
#   * A run that dies faster than LAUNCHER_MIN_UPTIME counts as a failed start.
#     After LAUNCHER_MAX_FAST_FAILS of those we stop trying NFS and drop to the
#     baked build for the rest of this pod's life — a bad checkout self-heals
#     to known-good code instead of looping on it.
#   * A run that stayed up past that threshold is treated as an intentional
#     restart (hot-deploy, operator kill), so the failure count resets.
#
# The fallback below is the original foreground invocation, so normal pod
# restart semantics resume the moment we stop using NFS. cwd stays at
# /app/packages/server either way: node resolves imports from the script's own
# path, and leaving cwd here keeps the daemon's incidental propanes.db on the
# container filesystem rather than writing it into the shared NFS tree.
LAUNCHER_MIN_UPTIME="${LAUNCHER_MIN_UPTIME:-20}"
LAUNCHER_MAX_FAST_FAILS="${LAUNCHER_MAX_FAST_FAILS:-3}"

if [ -n "$NFS_LAUNCHER" ]; then
  echo "[entrypoint] Running launcher from $NFS_LAUNCHER (supervised; falls back to /app after $LAUNCHER_MAX_FAST_FAILS fast exits)"
  fast_fails=0
  while [ "$fast_fails" -lt "$LAUNCHER_MAX_FAST_FAILS" ]; do
    started=$(date +%s)
    run_as_agent node "$NFS_LAUNCHER" || true
    uptime=$(( $(date +%s) - started ))
    if [ "$uptime" -lt "$LAUNCHER_MIN_UPTIME" ]; then
      fast_fails=$((fast_fails + 1))
      echo "[entrypoint] NFS launcher exited after ${uptime}s (fast failure $fast_fails/$LAUNCHER_MAX_FAST_FAILS); retrying in 2s"
      sleep 2
    else
      fast_fails=0
      echo "[entrypoint] NFS launcher exited after ${uptime}s; restarting in 2s"
      sleep 2
    fi
  done
  echo "[entrypoint] NFS launcher failed to stay up — falling back to the baked /app build for the rest of this pod's life"
fi

cd /app/packages/server
run_as_agent node dist/launcher-daemon.js
