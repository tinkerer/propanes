# `components/pickers/`

Spotlight-style pickers and popup-menu primitives. Per CLAUDE.md UI conventions, **never** use
`window.prompt/alert/confirm` — pick from these instead.

| File | Role | Key export | Mounted by |
|------|------|------------|------------|
| `TerminalPicker.tsx:49` | The cmd-palette for tabs and companions: 10 categories (Layout, Views, New, Machines, Harnesses, Sprites, Recent, Open, Isolates, Iframe). Supports `{ kind: 'companion', sessionId }`, `{ kind: 'new' }`, `{ kind: 'url' }`. | `TerminalPicker` | global picker via `termPickerOpen` signal |
| `DirPicker.tsx:11` | Directory browser; input + popup with up/select via API endpoint | `DirPicker` | `modals/AddAppModal`, agent form |
| `PopupMenu.tsx:29` | Portal-based menu primitive (escapes `overflow:hidden`); viewport-clamps so it never falls off-screen | `PopupMenu` | `DirPicker`, context menus across the app |

## Notes

- `TerminalPicker` is the single source of truth for opening tabs in the pane system.
  Categories are collapsible; collapsed state is persisted to `localStorage`.
  Keyboard nav: arrows, Enter, Esc.
- `PopupMenu` uses `createPortal` + `useLayoutEffect` for positioning. Opaque background is
  required (see CLAUDE.md UI Conventions) — do not switch to `var(--pw-bg-surface)`.
- For URL input, open `TerminalPicker` in `{ kind: 'url' }` mode rather than building a custom
  input.
