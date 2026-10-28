#!/usr/bin/env bash
#
# onboard-user.sh — give a ProPanes member an isolated workspace on this VM.
#
#   sudo -E scripts/onboard-user.sh --user alice \
#        --app <APP_ID> [--app <APP_ID>=<git-url>] ... \
#        [--slack-user U012AB3CD [--slack-persona alicebot]] [--dry-run]
#
# Create the ProPanes user first (Users page or POST /admin/users). Run with an
# admin PROPANES_TOKEN in the environment (sudo -E keeps it). Re-running is safe:
# every step skips what already exists.
#
# What it sets up for <user>:
#   1. Linux account pp-<user> (home 0750) — the isolation boundary. The
#      member's agents run as this account, so they cannot read the operator's
#      home, ~/.claude / ~/.codex logins, the ProPanes database or its .env.
#   2. A private launcher (propanes-launcher@<user>) running as pp-<user>,
#      registered on a machine row, with the user pinned to it: every session
#      they start — and every widget auto-dispatch on their apps — runs there.
#   3. Their own copies of the suggested apps (--app), checked out under their
#      home, each with Claude / Claude YOLO / Codex / Codex YOLO agents.
#   4. Optionally (--slack-user ID) a link from their Slack account to the
#      shared Slack bot, which then works for them as this user. --slack-persona
#      names its replies to them.
#
# The member then finishes in a ProPanes terminal (which now opens as
# pp-<user>): `claude` to log in, `codex login`, `gh auth login`, and cloning
# any repo the script could not clone without their credentials.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PW="${PROPANES_API_URL:-http://localhost:3001}"
PUBLIC_URL="${PROPANES_PUBLIC_URL:-$PW}"
OPT=/opt/propanes
ETC=/etc/propanes/users

USERNAME="" SLACK_USER="" SLACK_PERSONA="" DRY=0 MAX_SESSIONS=5
APPS=()

usage() { sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user)         USERNAME="$2"; shift ;;
    --app)          APPS+=("$2"); shift ;;
    --slack-user)   SLACK_USER="$2"; shift ;;
    --slack-persona) SLACK_PERSONA="$2"; shift ;;
    --max-sessions) MAX_SESSIONS="$2"; shift ;;
    --dry-run)      DRY=1 ;;
    -h|--help)      usage 0 ;;
    *) echo "unknown flag: $1" >&2; usage 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then note "[dry-run] $*"; else "$@"; fi; }
as_user() { run runuser -u "$LINUX_USER" -- env HOME="$HOME_DIR" "$@"; }
api() {
  local method="$1" path="$2" body="${3:-}"
  curl -fsS -X "$method" -H "Authorization: Bearer $PROPANES_TOKEN" \
    ${body:+-H 'Content-Type: application/json' --data "$body"} "$PW/api/v1$path"
}

[ -n "$USERNAME" ] || usage 2
[[ "$USERNAME" =~ ^[a-z][a-z0-9-]{0,24}$ ]] || die "--user must be a lowercase name (letters, digits, -)"
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || die "run as root (sudo -E keeps PROPANES_TOKEN)"
[ -n "${PROPANES_TOKEN:-}" ] || die "PROPANES_TOKEN (an admin token) is required"
for bin in curl git node python3; do command -v "$bin" >/dev/null || die "$bin not found"; done
[ -z "$SLACK_USER" ] || [[ "$SLACK_USER" =~ ^[UW][A-Z0-9]{2,20}$ ]] || die "--slack-user must be a Slack member id (Profile → ⋯ → Copy member ID)"
[ -z "$SLACK_PERSONA" ] || [[ "$SLACK_PERSONA" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,39}$ ]] || die "--slack-persona must be a short display name"

LINUX_USER="pp-$USERNAME"
HOME_DIR="/home/$LINUX_USER"
LAUNCHER_ID="vm-$USERNAME"
USER_ETC="$ETC/$USERNAME"
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# --- 0. Resolve the ProPanes user -----------------------------------------
say "Looking up ProPanes user $USERNAME"
USER_ID="$(api GET /admin/users | json "print(next((u['id'] for u in d['users'] if u['username']=='$USERNAME'), ''))")"
[ -n "$USER_ID" ] || die "no ProPanes user '$USERNAME' — create it on the Users page first"
note "id $USER_ID"

# --- 1. Linux account -----------------------------------------------------
say "Linux account $LINUX_USER"
if id "$LINUX_USER" >/dev/null 2>&1; then
  note "exists"
else
  run useradd --create-home --home-dir "$HOME_DIR" --shell /bin/bash --comment "ProPanes member $USERNAME" "$LINUX_USER"
fi
run chmod 0750 "$HOME_DIR"
OPERATOR_HOME_MODE="$(stat -c %a "$REPO_ROOT/.." 2>/dev/null || echo '?')"
case "$OPERATOR_HOME_MODE" in
  *[1-7]) note "WARNING: $(dirname "$REPO_ROOT") is world-accessible (mode $OPERATOR_HOME_MODE); chmod o-rwx it or $LINUX_USER can read it" ;;
esac

# --- 2. Shared runtimes under /opt (readable by member accounts) ----------
say "Launcher runtime in $OPT/launcher"
BUNDLE="$REPO_ROOT/packages/server/dist/launcher-bundle.mjs"
[ -f "$BUNDLE" ] || (cd "$REPO_ROOT/packages/server" && run node esbuild-launcher.mjs)
run install -d -m 0755 "$OPT/launcher/node_modules"
run install -m 0644 "$BUNDLE" "$OPT/launcher/launcher-bundle.mjs"
for mod in node-pty ws; do
  # pnpm links these into the store; -L copies the real files.
  run rm -rf "$OPT/launcher/node_modules/$mod"
  run cp -rL "$REPO_ROOT/packages/server/node_modules/$mod" "$OPT/launcher/node_modules/$mod"
done
run chmod -R a+rX "$OPT/launcher"

# Agent CLIs: codex is usually a system package; claude's native installer puts
# it in the installing user's home, which the member cannot reach — so the
# member gets their own copy (and their own login) in theirs.
CODEX_BIN="$(command -v codex || true)"
if [ -n "$CODEX_BIN" ] && ! runuser -u "$LINUX_USER" -- test -x "$(readlink -f "$CODEX_BIN")" 2>/dev/null; then
  note "codex at $CODEX_BIN is not executable by $LINUX_USER; install it system-wide (npm i -g @openai/codex)"
fi
CLAUDE_BIN="$HOME_DIR/.local/bin/claude"
if [ "$DRY" = 1 ] || [ ! -x "$CLAUDE_BIN" ]; then
  say "Installing Claude Code for $LINUX_USER"
  as_user bash -c 'curl -fsSL https://claude.ai/install.sh | bash' || note "claude install failed; the member can run the installer in their terminal"
fi

# --- 3. Checkouts of the suggested apps ------------------------------------
APPS_JSON="["
CLONES=""
for spec in "${APPS[@]+"${APPS[@]}"}"; do
  APP_ID="${spec%%=*}"
  REMOTE=""; [ "$spec" != "$APP_ID" ] && REMOTE="${spec#*=}"
  SRC="$(api GET /admin/applications | json "a=next((a for a in d if a['id']=='$APP_ID'), None); print(a['projectDir'] if a else '')")"
  [ -n "$SRC" ] || die "suggested app $APP_ID not found"
  [ -n "$REMOTE" ] || REMOTE="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"
  # The member signs in with `gh auth login` (HTTPS), not an SSH key.
  REMOTE="$(echo "$REMOTE" | sed -E 's#^git@([^:]+):#https://\1/#')"
  DEST="$HOME_DIR/$(basename "$SRC")"
  say "App $APP_ID → $DEST"
  if [ -d "$DEST/.git" ]; then
    note "checkout exists"
  elif [ -z "$REMOTE" ]; then
    as_user mkdir -p "$DEST"
    note "no git remote for $SRC — created an empty $DEST"
  elif ! as_user git clone --quiet "$REMOTE" "$DEST" 2>/dev/null; then
    as_user mkdir -p "$DEST"
    note "could not clone $REMOTE without the member's credentials; they run in their terminal:"
    note "  gh auth login && git clone $REMOTE $DEST"
  fi
  [ -n "$REMOTE" ] && CLONES+="clone_app $(printf '%q %q' "$REMOTE" "$DEST")"$'\n'
  APPS_JSON+="{\"fromAppId\":\"$APP_ID\",\"projectDir\":\"$DEST\"},"
done
APPS_JSON="${APPS_JSON%,}]"

# ~/setup-apps.sh: the member re-runs the clones after `gh auth login` (the
# Slack bot's setup guide points at it). Safe to run again: it skips checkouts.
SETUP_SCRIPT="$HOME_DIR/setup-apps.sh"
if [ "$DRY" = 1 ]; then
  note "[dry-run] write $SETUP_SCRIPT"
else
  cat > "$SETUP_SCRIPT" <<SETUP
#!/usr/bin/env bash
# Clones your ProPanes apps that are not checked out yet. Run after: gh auth login
set -u
clone_app() {
  if [ -d "\$2/.git" ]; then echo "✓ \$2"; return; fi
  if [ -d "\$2" ] && [ -n "\$(ls -A "\$2")" ]; then echo "! \$2 exists and is not a git checkout; move it aside and re-run"; return; fi
  echo "→ cloning \$1 into \$2"
  git clone "\$1" "\$2" || echo "! could not clone \$1 — did gh auth login succeed, and can your GitHub account read the repo?"
}
${CLONES}
SETUP
  chown "$LINUX_USER":"$LINUX_USER" "$SETUP_SCRIPT"; chmod 0755 "$SETUP_SCRIPT"
fi

# --- 4. ProPanes workspace (apps, agents, machine, launcher pin) -----------
say "ProPanes workspace for $USERNAME"
BODY="{\"apps\":$APPS_JSON,\"launcherId\":\"$LAUNCHER_ID\",\"machine\":{\"name\":\"$USERNAME @ $(hostname -s)\",\"hostname\":\"$(hostname -s)\",\"defaultCwd\":\"$HOME_DIR\"},\"mintToken\":true}"
if [ "$DRY" = 1 ]; then
  note "[dry-run] POST /admin/users/$USER_ID/onboard $BODY"
  RESULT='{"machine":{"id":"DRY-RUN"},"apps":[],"token":"DRY-RUN"}'
else
  RESULT="$(api POST "/admin/users/$USER_ID/onboard" "$BODY")"
fi
MACHINE_ID="$(echo "$RESULT" | json "print(d['machine']['id'])")"
MEMBER_TOKEN="$(echo "$RESULT" | json "print(d['token'])")"
echo "$RESULT" | json "
for a in d['apps']: print('    app   %-24s %s %s' % (a['name'], a['id'], '(new)' if a['created'] else ''))
print('    agents %d created, %d kept' % (sum(x['created'] for x in d.get('agents',[])), sum(not x['created'] for x in d.get('agents',[]))))"

# --- 5. Launcher service ---------------------------------------------------
say "Launcher $LAUNCHER_ID (propanes-launcher@$USERNAME)"
write_env() {  # path, mode, content — root-owned, group = the member
  if [ "$DRY" = 1 ]; then note "[dry-run] write $1"; return; fi
  install -d -m 0750 -o root -g "$LINUX_USER" "$USER_ETC"
  ( umask 027; printf '%s\n' "$3" > "$1" )
  chown root:"$LINUX_USER" "$1"; chmod "$2" "$1"
}
WS_URL="$(echo "$PW" | sed 's#^http#ws#')/ws/launcher"
write_env "$USER_ETC/launcher.env" 0640 "SERVER_WS_URL=$WS_URL
LAUNCHER_ID=$LAUNCHER_ID
LAUNCHER_NAME=$USERNAME @ $(hostname -s)
MACHINE_ID=$MACHINE_ID
MAX_SESSIONS=$MAX_SESSIONS
${LAUNCHER_AUTH_TOKEN:+LAUNCHER_AUTH_TOKEN=$LAUNCHER_AUTH_TOKEN
}CLAUDE_BIN=$CLAUDE_BIN
CODEX_BIN=${CODEX_BIN:-codex}
PATH=$HOME_DIR/.local/bin:/usr/local/bin:/usr/bin:/bin
PROPANES_API_URL=$PW
PROPANES_TOKEN=$MEMBER_TOKEN"
run install -m 0644 "$REPO_ROOT/ops/vm-user/propanes-launcher@.service" /etc/systemd/system/propanes-launcher@.service
run systemctl daemon-reload
run systemctl enable --now "propanes-launcher@$USERNAME.service"
run systemctl restart "propanes-launcher@$USERNAME.service"

# --- 6. Slack -------------------------------------------------------------
if [ -n "$SLACK_USER" ]; then
  say "Slack: link $SLACK_USER to $USERNAME on the shared bot"
  BODY="{\"slackUserId\":\"$SLACK_USER\",\"slackPersona\":\"$SLACK_PERSONA\"}"
  if [ "$DRY" = 1 ]; then note "[dry-run] PATCH /admin/users/$USER_ID $BODY"
  else api PATCH "/admin/users/$USER_ID" "$BODY" >/dev/null; fi
  note "The shared bot picks the link up within a minute. They mention it (or DM it) as usual."
fi
say "Done. $USERNAME's sessions now run as $LINUX_USER on launcher $LAUNCHER_ID."
note "Their first steps, in a ProPanes terminal ($PUBLIC_URL/admin/ → New terminal):"
note "  claude            # log in to their own Claude account"
note "  codex login       # their own Codex/ChatGPT account"
note "  gh auth login     # git credentials for their checkouts"
note "  bash ~/setup-apps.sh  # clone any app checkout that needed their credentials"
note "With --slack-user, the Slack bot DMs them these steps with a link to the terminal."
