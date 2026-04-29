# AGENTS.md

Quick rules for any agent (Claude Code, Codex, etc.) working in this repo.
This file is terse on purpose. For project architecture and API usage, see
`CLAUDE.md`. For visual design, see `DESIGN_SPEC.md`.

## Design / colors

**Read `DESIGN_SPEC.md` before touching any color.**

The allowed palette is **black, grey, blue, red, orange, yellow** (the
"flame" palette). Do not introduce green, purple, pink, teal, cyan, or
indigo-leaning colors anywhere — not in `app.css`, not in inline
`style=` props, not in `packages/widget/src/styles.ts`, not in SVGs.

When editing CSS:

- Prefer existing `--pw-*` tokens in `packages/admin/src/app.css` over
  raw hex.
- If you need a new accent, pick from the palette in
  `DESIGN_SPEC.md` §1.1 and add it as a token in both the `:root` and
  dark-theme blocks.
- If you find an existing violation (green success, purple badge, etc.)
  in code you are already editing, fix it in the same change.

Category differentiation (badges, tool kinds, activity types) must come
from labels, icons, shape, or shade — NOT from hue jumps outside the
flame palette.

## Testing / screenshots

When verifying UI changes, use **Playwright**, not the widget's
html-to-image capture. Default to the headless shared browser:

```bash
~/.claude/bin/pw goto 'http://localhost:3001/admin/#/...'
~/.claude/bin/pw screenshot   # → /tmp/pw_screen.png, then Read it
```

Use `pw-vnc` instead when you need a visible display. The widget's
`/screenshot` / `screenshot: true` path runs html-to-image and misses
canvas, cross-origin iframes, transforms, and assorted CSS — only use
it when you specifically need the PNG attached to a feedback row.
See `CLAUDE.md` → "Screenshots / Visual Testing".

## Other conventions

- Never use `window.prompt/alert/confirm` in admin code — build proper
  in-app UI (see `CLAUDE.md` → "UI Conventions").
- Strict lazy tab rendering in `LeafPane` / `GlobalTerminalPanel` /
  `PopoutPanel` — only mount the active tab.
- Use `commitTree()` for `layoutTree` mutations; do not set the signal
  directly.
- See `CLAUDE.md` for the rest of the project's operating rules, API
  surface, and directory layout.
