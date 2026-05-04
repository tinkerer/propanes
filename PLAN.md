# ProPanes Desktop — Tauri Build Plan

## Overview

A macOS tray-icon app using Tauri v2 + tauri-nspanel. Two non-activating overlay panels:
1. **CoS Panel** — Chief of Staff chat (threads, tool use, responses)
2. **Feedback Panel** — Widget for DOM traversal feedback on any app

Connects to a running ProPanes server (no embedded server in phase 1).

---

## Phase 1: Minimalist Desktop Shell

### Package: `packages/desktop`

```
packages/desktop/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # App entry, tray, panel lifecycle
│   │   ├── tray.rs           # System tray icon + menu
│   │   └── panels.rs         # NSPanel creation/show/hide/position
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── icons/                # Tray + app icons
│   └── build.rs
├── src/                      # Preact frontend (lightweight)
│   ├── main.tsx              # Entry — routes to panel type
│   ├── cos/                  # CoS panel UI
│   │   ├── CosShell.tsx      # Thin shell: thread rail + composer + message stream
│   │   └── CosToolRenderer.tsx  # Stripped-down tool use display
│   ├── feedback/             # Feedback panel UI
│   │   └── FeedbackShell.tsx # Mini widget UI
│   └── lib/
│       ├── api.ts            # Direct fetch to server (no admin dependency)
│       ├── cos-api.ts        # CoS endpoints: history, threads, chat, SSE
│       └── tauri-bridge.ts   # invoke() wrappers for Rust commands
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### Approach: Lean frontend, not admin iframe

Instead of loading `?embed=cos` in a webview (which pulls the entire admin bundle + signals + xterm + 50 dependencies), build a **thin standalone Preact app** that talks directly to the CoS API:

- `GET /api/v1/admin/chief-of-staff/history/:agentId` — load threads
- `POST /api/v1/admin/chief-of-staff/threads` — create thread
- `POST /api/v1/admin/chief-of-staff/chat/:threadId` — send message
- `EventSource /threads/:threadId/events` — stream responses
- `GET /api/v1/admin/chief-of-staff/sessions` — active sessions
- `POST /api/v1/admin/chief-of-staff/lock` — advisory locks

This gives us a ~50KB bundle instead of ~2MB, instant startup, and no xterm/signal baggage.

### Rust Side

**Cargo.toml dependencies:**
```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-nspanel = { git = "https://github.com/ahkohd/tauri-nspanel", branch = "v2.1" }
tauri-plugin-global-shortcut = "2"
tauri-plugin-shell = "2"              # For opening URLs
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**tray.rs** — System tray:
- ProPanes icon in menu bar
- Left-click: toggle CoS panel at mouse position
- Right-click: context menu (Settings, Quit, server URL config)
- Status indicator: green dot when server connected, red when disconnected

**panels.rs** — NSPanel management:
- `create_cos_panel()` — 420×600px non-activating panel, rounded corners, shadow, transparent titlebar
- `create_feedback_panel()` — 360×500px non-activating panel
- Both use `NSWindowStyleMaskNonactivatingPanel` so they don't steal focus from the user's active app
- Panel positioning: near tray icon (CoS) or bottom-right (feedback)
- Show/hide with slide animation via CSS transitions
- `decorations: false` before panel conversion (required by nspanel)

**main.rs** — Tauri commands exposed to frontend:
```rust
#[tauri::command]
fn toggle_cos_panel(app: AppHandle) { ... }

#[tauri::command]
fn toggle_feedback_panel(app: AppHandle) { ... }

#[tauri::command]
fn set_server_url(url: String) { ... }

#[tauri::command]
fn get_server_url() -> String { ... }

#[tauri::command]
fn hide_panels(app: AppHandle) { ... }
```

### Frontend: CoS Panel

**CosShell.tsx** — Main CoS UI:
- Thread rail (numbered list on left edge, like existing CosThreadRail but simpler)
- Message list with SSE streaming (markdown rendered, tool calls shown as collapsible cards)
- Composer at bottom (text input + send, voice button for phase 2)
- Connection status indicator
- Server URL configurable via tray menu → stored in Tauri's app data dir

**CosToolRenderer.tsx** — Minimal tool use display:
- Bash: command + truncated output, expandable
- Edit/Write: file path + diff preview
- Read/Glob/Grep: file list
- Agent: nested task description + status
- Everything else: JSON fallback
- No xterm.js, no live terminal — just static renders of completed tool calls

**Styling:**
- Dark theme only (matches existing CoS dark aesthetic)
- CSS modules or plain CSS (no admin's global stylesheet)
- Vibrancy/blur background via Tauri window config for macOS feel

### Frontend: Feedback Panel

**FeedbackShell.tsx** — Mini feedback widget:
- Text area for feedback
- Screenshot button (uses Tauri's `screenshot` API or `CGWindowListCreateImage` via Rust command — captures the actual screen, not DOM)
- Element picker: **deferred to phase 2** (needs a11y APIs to pick elements in other apps)
- Submit button → `POST /api/v1/feedback`
- Recent feedback list (last 5 items)

### Build Integration

**package.json:**
```json
{
  "name": "@propanes/desktop",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "preview": "vite preview"
  }
}
```

**vite.config.ts:**
- Preact + Vite (same setup as admin but standalone)
- Output to `src-tauri/` for Tauri to bundle

**Workspace integration:**
- Add `packages/desktop` to `pnpm-workspace.yaml`
- Turbo: desktop depends on `shared` (for types/schemas)
- Does NOT depend on `admin` or `server` packages

### Tauri Config Highlights

```json
{
  "app": {
    "withGlobalTauri": true,
    "trayIcon": { "iconPath": "icons/tray.png", "iconAsTemplate": true },
    "windows": []  // No default window — panels created programmatically
  },
  "bundle": {
    "identifier": "com.propanes.desktop",
    "macOS": { "minimumSystemVersion": "13.0" }
  }
}
```

No default windows — tray-only app. Panels are created via nspanel on startup and shown/hidden.

---

## Phase 2: System Integration

### 2a. Auto-Update

- Add `tauri-plugin-updater` with GitHub releases as update source
- Check for updates on launch + every 6 hours
- Tray menu shows "Update Available" badge
- One-click update from tray

### 2b. Global Hotkeys via Accessibility

**Modifier-tap detection** (e.g., double-tap Control to summon CoS):
- Register with `tauri-plugin-global-shortcut` for initial binding
- For modifier-only taps (Control×2, Option×2), use macOS Accessibility API via `objc2` crate:
  - `CGEventTapCreate` with `kCGEventFlagsChanged` mask
  - Track modifier key press/release timestamps
  - Double-tap within 400ms → toggle CoS panel
  - Triple-tap → toggle feedback panel
- **Voice mode**: tap then hold (>500ms) on the second press → activate microphone, release → send voice input
- Requires Accessibility permission (prompt user on first launch)

### 2c. Accessibility-Based App Parsing

Replace DOM traversal (which only works in-browser) with macOS Accessibility APIs:

- `AXUIElementCreateApplication(pid)` to get the focused app's UI tree
- Walk `AXChildren` to enumerate windows, views, buttons, text fields
- Extract: role, title, value, description, position, size, enabled state
- Present as a selectable element tree in the feedback panel (like the existing element picker but for native apps)
- Screenshot + overlay: capture screen region via `CGWindowListCreateImage`, overlay bounding rects of AX elements

**Rust module: `a11y.rs`**
```rust
#[tauri::command]
fn get_focused_app_elements() -> Vec<AXElement> { ... }

#[tauri::command]
fn get_element_at_point(x: f64, y: f64) -> AXElement { ... }

#[tauri::command]
fn capture_screen_region(x: i32, y: i32, w: i32, h: i32) -> Vec<u8> { ... }
```

### 2d. Record Mode (Activity Observer)

Watch user interactions across the system:

- `AXObserverCreate` + `AXObserverAddNotification` for:
  - `kAXFocusedUIElementChangedNotification` — track what user clicks/focuses
  - `kAXValueChangedNotification` — track text input
  - `kAXWindowMovedNotification`, `kAXWindowResizedNotification` — layout changes
  - `kAXApplicationActivatedNotification` — app switches
- Record timeline: `[(timestamp, app, element, action, value?)]`
- Periodic screenshots (every N seconds or on significant UI change)
- Toggle via tray menu or hotkey
- Export as structured report attached to feedback

### 2e. System Monitoring

Surface system-level context alongside feedback:

- **Active app info**: `NSWorkspace.shared.frontmostApplication` — bundle ID, name, PID
- **Window list**: `CGWindowListCopyWindowInfo` — all visible windows with bounds, owner, title
- **Process stats**: CPU/memory for foreground app via `proc_pidinfo`
- **Console logs**: `OSLog` stream filtered to frontmost app's subsystem
- **Network**: active connections for the focused app via `lsof -i -p PID` equivalent
- Surface in a "System Context" drawer in the CoS panel — collapsible, auto-refreshes

---

## Implementation Order

### Phase 1 (this PR)
1. Scaffold `packages/desktop` with Tauri v2 + Vite + Preact
2. Tray icon with show/hide + context menu
3. CoS panel via tauri-nspanel (non-activating)
4. CoS API client (threads, chat, SSE streaming)
5. CoS message renderer (markdown + tool cards)
6. Thread rail + thread switching
7. Feedback panel via tauri-nspanel (text + screenshot via Rust)
8. Server URL configuration (persisted)

### Phase 2 (follow-up)
9. Auto-update via tauri-plugin-updater
10. Modifier-tap hotkeys via CGEventTap
11. Voice mode (tap + hold)
12. A11y element picker for native apps
13. Record mode (AXObserver activity timeline)
14. System monitoring drawer
