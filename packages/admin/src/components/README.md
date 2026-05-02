# `packages/admin/src/components/`

The admin SPA's component tree, grouped by feature area. 105 source files split across 15 directories. Each subdirectory has its own README.md that traces the code in detail.

## Layout

```
components/
├── shell/        top-level chrome (App, Layout, ControlBar, PageView, mobile variants)
├── cos/          Chief of Staff bubble — chat overlay for orchestrating sessions
├── panes/        in-page pane tree + popout tear-out window + GlobalTerminalPanel
├── terminal/     agent terminal, JSONL viewer, structured message rendering
├── sessions/     session list, swarm dashboard, summary, agent cards
├── dispatch/     dispatch dialogs, agent endpoint pickers, setup assistant
├── feedback/     feedback conversation, aggregate cluster wizard, unified composer
├── files/        file tree, git diff, companion views (file/iframe/terminal/artifact)
├── sidebar/      sidebar nav, spotlight (cmd-k) search
├── learnings/    learnings drawer + detail
├── modals/       app/agent/ssh setup, shortcut help
├── ai-assist/    in-app AI helper (chat, button, hints, autofix toast)
├── voice/        voice playback + trace
├── pickers/      spotlight-style pickers (terminal, dir, popup menu)
└── ui/           small primitives (Tooltip, Expandable, NotificationCenter, ...)
```

## Where things mount

```
main.tsx
└── shell/App
    └── shell/Layout
        ├── sidebar/SidebarNavView
        ├── shell/ControlBar
        ├── shell/PageView ──► pages/*Page.tsx
        ├── panes/GlobalTerminalPanel    (bottom dock — agent terminals)
        ├── cos/ChiefOfStaffBubble       (floating overlay — CoS chat)
        ├── pickers/TerminalPicker       (cmd-k picker for tabs/companions)
        ├── sidebar/SpotlightSearch      (cmd-k spotlight search)
        ├── ai-assist/HintToast
        ├── ai-assist/AutoFixToast
        └── ui/NotificationCenter
```

Pages (`pages/*Page.tsx`) generally import from this directory — they're the route-level
hosts for these components.

## Reading order for new contributors

1. `shell/README.md` — how the app boots and routes.
2. `panes/README.md` — the pane tree + popout system; everything else docks into this.
3. `terminal/README.md` — agent session views; the largest concentration of business logic.
4. `cos/README.md` — Chief of Staff overlay; biggest single feature area.
5. The rest are leaf features and can be read on demand.

## Conventions

- **Strict lazy tab rendering** — only the active tab per pane container is mounted.
  See `panes/README.md` for why.
- **Floating overlays use opaque backgrounds** — never `var(--pw-bg-surface)`; that token is
  translucent in dark scopes. See the CLAUDE.md "UI Conventions" section.
- **No `window.alert/confirm/prompt`** — use modals/, pickers/, or inline UI.
- **Imports use `.js` extensions** even from `.tsx` files (TS NodeNext resolution).

## Navigating

The directory layout follows feature areas, not technical layers. If you're not sure where
something lives, search for the export name; each subdirectory README has a component table
mapping file → role → key exports.
