# `components/ai-assist/`

In-app AI helper. Sends prompts to Claude via the `designAssist` API and surfaces results as
chat panels, popovers, and toasts.

| File | Role | Key export | Mounted by |
|------|------|------------|------------|
| `AdminAssistChat.tsx:12` | Chat panel docked to the global terminal; presets for "feedback summary", "system status", "recent errors" | `AdminAssistChat` | `panes/GlobalTerminalPanel` |
| `AiAssistButton.tsx:11` | Button + popover for context-aware help on settings / feature pages | `AiAssistButton` | settings panels, page headers |
| `AutoFixToast.tsx:3` | Session failure toast → can launch an auto-fix diagnostic agent; tracks phase (pending → launching → active) | `AutoFixToast` | global UI layer (`shell/Layout`) |
| `HintToast.tsx:6` | Per-route contextual help toasts (1.2s delay, dismissable, can highlight a DOM target) | `HintToast` | global UI layer |

## Notes

- `AiAssistButton` positions its popover above the trigger and closes on click-outside.
- `AutoFixToast` captures the failed session's exit code and dispatches a follow-up session
  via `POST /api/v1/admin/dispatch` when the user accepts.
- `HintToast` reads route-keyed hint definitions from `lib/hints.ts`.
- All four feed back into the same `lib/admin-ws.ts` WebSocket for streamed responses.
