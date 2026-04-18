#!/bin/bash
# Opens a prompt-widget tmux session in Terminal.app
# Usage: open-in-terminal.sh <tmux-session-name>
TMUX_NAME="$1"
if [ -z "$TMUX_NAME" ]; then
  echo "Usage: $0 <tmux-session-name>" >&2
  exit 1
fi
TMPDIR_BASE=$(mktemp -d /tmp/pw-open-XXXXXX)
TMPFILE="$TMPDIR_BASE/open.command"
cat > "$TMPFILE" << EOF
TMUX= tmux -L prompt-widget attach-session -t $TMUX_NAME
rm -rf "$TMPDIR_BASE"
EOF
chmod +x "$TMPFILE"
open -a Terminal -e "$TMPFILE"
