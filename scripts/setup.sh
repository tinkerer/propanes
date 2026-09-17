#!/usr/bin/env bash
#
# propanes setup — take a bare machine to a running admin dashboard in one command.
#
#   ./scripts/setup.sh              # check deps, install, build, boot, seed, open browser
#   ./scripts/setup.sh --doctor     # report what's missing and exit, change nothing
#   ./scripts/setup.sh -y           # don't ask before installing missing system deps
#
# Everything here is idempotent: re-running on a configured machine is a no-op
# that ends with the dashboard open. Safe to run repeatedly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_MAJOR_MIN=22
PORT="${PORT:-3001}"
SESSION_PORT="${SESSION_SERVICE_PORT:-3002}"
STATE_DIR="$REPO_ROOT/.propanes"
DEV_LOG="$STATE_DIR/dev.log"

DOCTOR=0 ASSUME_YES=0 DO_OPEN=1 DO_START=1 DO_PLAYWRIGHT=1 DO_SEED=1 DO_INSTALL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --doctor)        DOCTOR=1 ;;
    -y|--yes)        ASSUME_YES=1 ;;
    --no-open)       DO_OPEN=0 ;;
    --no-start)      DO_START=0; DO_SEED=0; DO_OPEN=0 ;;
    --no-playwright) DO_PLAYWRIGHT=0 ;;
    --no-seed)       DO_SEED=0 ;;
    --no-install)    DO_INSTALL=0 ;;
    --port)          PORT="$2"; shift ;;
    -h|--help)       sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ---------- output ----------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; X=$'\033[0m'
else
  B=""; DIM=""; R=""; G=""; Y=""; C=""; X=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$C" "$X" "$B" "$*" "$X"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$X" "$*"; }
bad()   { printf '  %s✗%s %s\n' "$R" "$X" "$*"; }
info()  { printf '    %s%s%s\n' "$DIM" "$*" "$X"; }
die()   { printf '\n%serror:%s %s\n' "$R" "$X" "$*" >&2; exit 1; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '  %s?%s %s [Y/n] ' "$Y" "$X" "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------- platform ----------

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      PLATFORM=unknown ;;
esac

PKG=""
if   command -v brew    >/dev/null 2>&1; then PKG=brew
elif command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v pacman  >/dev/null 2>&1; then PKG=pacman
fi

# Homebrew keeps node@22 keg-only; put it on PATH so a machine that already has
# a too-new or too-old default `node` still gets a supported one.
if [ "$PKG" = brew ]; then
  for keg in node@22 node@24; do
    prefix="$(brew --prefix "$keg" 2>/dev/null || true)"
    if [ -n "$prefix" ] && [ -x "$prefix/bin/node" ]; then
      case ":$PATH:" in *":$prefix/bin:"*) ;; *) PATH="$prefix/bin:$PATH" ;; esac
      break
    fi
  done
  export PATH
fi

pkg_install() {
  local formula="$1"
  case "$PKG" in
    brew)   brew install "$formula" ;;
    apt)    sudo apt-get update -qq && sudo apt-get install -y "$formula" ;;
    dnf)    sudo dnf install -y "$formula" ;;
    pacman) sudo pacman -S --noconfirm "$formula" ;;
    *)      return 1 ;;
  esac
}

node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }

# ---------- requirement checks ----------

MISSING=()      # human label -> handled below
NEEDS_NODE=0 NEEDS_TMUX=0 NEEDS_GIT=0

step "Checking system requirements"

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  bad "git — not found"; NEEDS_GIT=1; MISSING+=(git)
fi

if command -v node >/dev/null 2>&1; then
  NM="$(node_major)"
  if [ -n "$NM" ] && [ "$NM" -ge "$NODE_MAJOR_MIN" ]; then
    ok "node $(node -v)"
  else
    bad "node $(node -v) — need >= v${NODE_MAJOR_MIN}"
    info "better-sqlite3 and node-pty are native modules built against the running ABI"
    NEEDS_NODE=1; MISSING+=("node>=${NODE_MAJOR_MIN}")
  fi
else
  bad "node — not found (need >= v${NODE_MAJOR_MIN})"; NEEDS_NODE=1; MISSING+=("node>=${NODE_MAJOR_MIN}")
fi

# tmux is not optional: every interactive agent session is a tmux session, and
# without it sessions silently fall back / fail to survive a service restart.
if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V | awk '{print $2}')"
else
  bad "tmux — not found (interactive agent sessions need it)"; NEEDS_TMUX=1; MISSING+=(tmux)
fi

# Agent CLIs are optional for booting the server, required to dispatch.
HAVE_CLAUDE=0 HAVE_CODEX=0
if command -v claude >/dev/null 2>&1; then HAVE_CLAUDE=1; ok "claude $(claude --version 2>/dev/null | head -1)"; else warn "claude CLI — not found (needed to dispatch claude agents)"; info "install: https://claude.com/download"; fi
if command -v codex  >/dev/null 2>&1; then HAVE_CODEX=1;  ok "codex $(codex --version 2>/dev/null | head -1)";  else warn "codex CLI — not found (needed to dispatch codex agents)";  info "install: npm i -g @openai/codex"; fi

if [ "$DOCTOR" = 1 ]; then
  step "Doctor summary"
  if [ ${#MISSING[@]} -eq 0 ]; then
    ok "all required dependencies present"
  else
    bad "missing: ${MISSING[*]}"
    [ -n "$PKG" ] && info "installable with: $PKG" || info "no supported package manager detected"
  fi
  exit $([ ${#MISSING[@]} -eq 0 ] && echo 0 || echo 1)
fi

# ---------- install missing system deps ----------

if [ ${#MISSING[@]} -gt 0 ]; then
  if [ "$DO_INSTALL" = 0 ]; then
    die "missing ${MISSING[*]} and --no-install was passed"
  fi
  if [ -z "$PKG" ]; then
    die "missing ${MISSING[*]} and no supported package manager (brew/apt/dnf/pacman) was found. Install them manually and re-run."
  fi
  step "Installing missing dependencies with $PKG"
  if ! confirm "install ${MISSING[*]} via $PKG?"; then
    die "declined. Install ${MISSING[*]} manually and re-run."
  fi
  [ "$NEEDS_GIT"  = 1 ] && { pkg_install git || die "failed to install git"; ok "git installed"; }
  if [ "$NEEDS_TMUX" = 1 ]; then pkg_install tmux || die "failed to install tmux"; ok "tmux installed"; fi
  if [ "$NEEDS_NODE" = 1 ]; then
    case "$PKG" in
      brew) pkg_install "node@$NODE_MAJOR_MIN" || die "failed to install node@$NODE_MAJOR_MIN"
            prefix="$(brew --prefix "node@$NODE_MAJOR_MIN")"; PATH="$prefix/bin:$PATH"; export PATH ;;
      apt)  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | sudo -E bash -
            sudo apt-get install -y nodejs ;;
      *)    pkg_install nodejs || die "failed to install nodejs" ;;
    esac
    NM="$(node_major)"
    [ -n "$NM" ] && [ "$NM" -ge "$NODE_MAJOR_MIN" ] || die "node is still $(node -v 2>/dev/null || echo missing) after install"
    ok "node $(node -v)"
  fi
fi

# ---------- pnpm ----------

step "Preparing pnpm"
PNPM_SPEC="$(node -p "require('./package.json').packageManager || 'pnpm@latest'" 2>/dev/null || echo pnpm@latest)"
if ! command -v corepack >/dev/null 2>&1; then
  npm i -g corepack >/dev/null 2>&1 || die "corepack unavailable and 'npm i -g corepack' failed"
fi
corepack enable >/dev/null 2>&1 || true
corepack prepare "$PNPM_SPEC" --activate >/dev/null 2>&1 || die "could not activate $PNPM_SPEC"
ok "$PNPM_SPEC ($(pnpm -v))"

# ---------- workspace install + build ----------

step "Installing workspace dependencies"
pnpm install || die "pnpm install failed"
ok "dependencies installed"

step "Building packages"
pnpm build || die "pnpm build failed"
ok "shared, widget, admin, server built"

# ---------- playwright ----------

if [ "$DO_PLAYWRIGHT" = 1 ]; then
  step "Installing Playwright browsers"
  # Both e2e projects (desktop-chromium, mobile-iphone-14) run on chromium, so
  # that's the only engine worth downloading. --with-deps needs root on Linux.
  if [ "$PLATFORM" = linux ] && [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then
    pnpm --filter @propanes/e2e exec playwright install --with-deps chromium || warn "playwright browser install failed — 'pnpm test:e2e' won't run until it succeeds"
  else
    pnpm --filter @propanes/e2e exec playwright install chromium || warn "playwright browser install failed — 'pnpm test:e2e' won't run until it succeeds"
  fi
  ok "chromium ready"
fi

# ---------- boot ----------

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_for_port() {
  local p="$1" label="$2" tries=90
  while [ "$tries" -gt 0 ]; do
    port_busy "$p" && { ok "$label listening on :$p"; return 0; }
    sleep 1; tries=$((tries - 1))
  done
  return 1
}

if [ "$DO_START" = 1 ]; then
  step "Starting propanes"
  mkdir -p "$STATE_DIR"
  if port_busy "$PORT"; then
    ok "already running on :$PORT — reusing it"
  else
    ( cd packages/server && PORT="$PORT" SESSION_SERVICE_PORT="$SESSION_PORT" nohup pnpm dev >"$DEV_LOG" 2>&1 & echo $! >"$STATE_DIR/dev.pid" )
    info "logs: $DEV_LOG"
    wait_for_port "$PORT" "main API" || { tail -30 "$DEV_LOG" >&2; die "server never came up on :$PORT — see $DEV_LOG"; }
  fi
  wait_for_port "$SESSION_PORT" "session service" || {
    tail -30 "$DEV_LOG" >&2
    die "session service never came up on :$SESSION_PORT — terminals will not work. See $DEV_LOG"
  }
fi

# ---------- seed + readiness ----------

if [ "$DO_SEED" = 1 ]; then
  step "Registering local app and agent endpoints"
  node scripts/seed-local.mjs --port "$PORT" || warn "seeding failed — the server is up, register manually in the dashboard"
fi

# ---------- open ----------

ADMIN_URL="http://localhost:$PORT/admin/"
if [ "$DO_OPEN" = 1 ]; then
  step "Opening the dashboard"
  if   [ "$PLATFORM" = macos ] && command -v open >/dev/null 2>&1; then open "$ADMIN_URL" && ok "$ADMIN_URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$ADMIN_URL" >/dev/null 2>&1 && ok "$ADMIN_URL"
  else warn "open $ADMIN_URL in your browser"
  fi
fi

printf '\n%sPropanes is up.%s  %s\n' "$B" "$X" "$ADMIN_URL"
printf '  %slogin%s      admin / admin  (override with ADMIN_USER / ADMIN_PASS)\n' "$DIM" "$X"
printf '  %slogs%s       tail -f %s\n' "$DIM" "$X" "$DEV_LOG"
printf '  %sstop%s       pkill -f "packages/server"\n\n' "$DIM" "$X"
