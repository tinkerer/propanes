#!/bin/sh
# Installed as /usr/local/bin/claude (in place of npm's root-owned symlink).
#
# The npm-global tree is root-owned, so `claude update` inside an agent
# session (running as the propanes user) fails with "npm global folder isn't
# writable". Prefer a user-owned native install in $HOME/.local/bin when one
# exists: `claude install` in any session creates it on the persistent /data
# volume, after which `claude update` works without root and the installed
# version survives pod restarts. Root (server-side classifier jobs) has no
# ~/.local/bin/claude and keeps using the baked npm copy.
if [ -n "${HOME:-}" ] && [ -x "$HOME/.local/bin/claude" ]; then
  exec "$HOME/.local/bin/claude" "$@"
fi
exec /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe "$@"
