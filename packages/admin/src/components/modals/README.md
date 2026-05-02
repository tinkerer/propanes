# `components/modals/`

Top-level dialog modals. Each is a controlled signal-driven popup; opening = setting the
corresponding signal in `lib/state.ts`.

| File | Role | Key export | Trigger |
|------|------|------------|---------|
| `AddAppModal.tsx:16` | Register a new app — create / clone / use existing dir; outputs HTML snippet for embedding the widget | `AddAppModal` | `addAppModalOpen` signal |
| `AgentFormModal.tsx:14` | Create / edit agent endpoints (runtime: claude or codex; permission profile; tool presets; custom prompts; Meta-Wiggum preset) | `AgentFormModal` | agents settings page |
| `ShortcutHelpModal.tsx:7` | Keyboard shortcut help — auto-grouped by category | `ShortcutHelpModal` | keyboard handler (Ctrl+Shift+?) |
| `SshSetupDialog.tsx:5` | Configure local SSH bridge URL (user/host/port) for terminal access | `SshSetupDialog` | `sshSetupDialog` signal |

## Notes

- `AddAppModal` includes an AI-assist onboarding step.
- `AgentFormModal` exposes the full set of permission profiles documented in
  `packages/shared/src/constants.ts::PERMISSION_PROFILES` (see CLAUDE.md "Permission Profiles").
- `SshSetupDialog` reads/writes `settings.localBridgeUrl`.
- Modals here are *modals*: page-blocking. For floating contextual UI, see `components/pickers/`.
