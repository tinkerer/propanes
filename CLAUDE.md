# propanes

Full-stack feedback overlay + agent session bridge. Four packages: `widget` (embeddable JS overlay), `server` (Hono API + SQLite), `admin` (Preact SPA dashboard), `shared` (types/schemas).

## ProPanes API (localhost:3001)

The server exposes a REST API. Use `curl` to query feedback, sessions, applications, and aggregate clusters directly.

### Checking Feedback

```bash
# List recent feedback (paginated)
curl -s 'http://localhost:3001/api/v1/admin/feedback?limit=20' | python3 -m json.tool

# Filter by app
curl -s 'http://localhost:3001/api/v1/admin/feedback?appId=APP_ID&limit=20' | python3 -m json.tool

# Filter by status (new, reviewed, dispatched, resolved, archived)
curl -s 'http://localhost:3001/api/v1/admin/feedback?status=new&limit=20' | python3 -m json.tool

# Get single feedback item
curl -s 'http://localhost:3001/api/v1/admin/feedback/FEEDBACK_ID' | python3 -m json.tool
```

### Checking Agent Sessions

```bash
# List all sessions
curl -s 'http://localhost:3001/api/v1/admin/agent-sessions' | python3 -m json.tool

# Get session by ID (includes output log)
curl -s 'http://localhost:3001/api/v1/admin/agent-sessions/SESSION_ID' | python3 -m json.tool

# Sessions for a specific feedback item
curl -s 'http://localhost:3001/api/v1/admin/agent-sessions?feedbackId=FEEDBACK_ID' | python3 -m json.tool
```

### Aggregate Clusters

```bash
# View clustered feedback
curl -s 'http://localhost:3001/api/v1/admin/aggregate' | python3 -m json.tool

# Filter clusters by app
curl -s 'http://localhost:3001/api/v1/admin/aggregate?appId=APP_ID' | python3 -m json.tool

# Only clusters with 2+ items
curl -s 'http://localhost:3001/api/v1/admin/aggregate?minCount=2' | python3 -m json.tool

# List action plans
curl -s 'http://localhost:3001/api/v1/admin/aggregate/plans' | python3 -m json.tool
```

### Applications

```bash
# List registered apps (shows IDs, names, project dirs)
curl -s 'http://localhost:3001/api/v1/admin/applications' | python3 -m json.tool
```

## Admin UI

The admin dashboard is at `http://localhost:3001/admin/`. The widget is embedded on the admin page itself.

- **Feedback list**: `http://localhost:3001/admin/#/app/APP_ID/feedback`
- **Feedback detail**: `http://localhost:3001/admin/#/app/APP_ID/feedback/FEEDBACK_ID`
- **Aggregate view**: `http://localhost:3001/admin/#/app/APP_ID/aggregate`
- **Sessions page**: `http://localhost:3001/admin/#/sessions`
- **Agents page**: `http://localhost:3001/admin/#/agents`

## Screenshots

**Prefer Playwright captures (`pw screenshot` or `pw-vnc screenshot`) over the widget's html-to-image capture.** The widget's built-in screenshot uses html-to-image, which frequently misses canvas content, cross-origin iframes, transformed/animated layers, and arbitrary CSS — the resulting PNG often doesn't match what's actually on screen.

Order of preference:
1. **`pw screenshot`** (headless shared browser) — fast, scriptable, drives the same Chromium the rest of the workflow uses. Result lands at `/tmp/pw_screen.png`; `Read` it directly.
2. **`pw-vnc screenshot`** (visible Chromium on `DISPLAY=:1`, watchable via NoVNC at `:6080`) — when you need to see the page rendered with a real display, or when the user is watching live. Result lands at `/tmp/pw_vnc_screen.png`.
3. **Ask the user to capture and attach a screenshot** — when neither headless nor VNC Playwright can reach the page (e.g. an external app, native UI, or auth state you can't reproduce).

Only fall back to the widget's html-to-image (`/screenshot` slash command or programmatic feedback with `screenshot: true`) when you specifically need the screenshot attached to a feedback item via `/api/v1/images/:screenshotId` — and even then expect lossy capture.

## Virtual Mouse & Keyboard (Agent API)

Agents can interact with page elements via coordinates — useful for canvas, drag-and-drop, and hover menus that don't respond to CSS selectors.

### Mouse commands

```bash
BASE="http://localhost:3001/api/v1/agent/sessions/SESSION_ID"

# Move cursor (shows visible pointer with "AGENT" badge)
curl -s -X POST "$BASE/mouse/move" -H 'Content-Type: application/json' -d '{"x":500,"y":300}'

# Click at coordinates (mousedown + mouseup + click sequence)
curl -s -X POST "$BASE/mouse/click" -H 'Content-Type: application/json' -d '{"x":500,"y":300}'

# Right-click (button: 2)
curl -s -X POST "$BASE/mouse/click" -H 'Content-Type: application/json' -d '{"x":500,"y":300,"button":2}'

# Hover (by selector or coordinates — fires mouseenter + mouseover + mousemove)
curl -s -X POST "$BASE/mouse/hover" -H 'Content-Type: application/json' -d '{"selector":"button.menu"}'
curl -s -X POST "$BASE/mouse/hover" -H 'Content-Type: application/json' -d '{"x":200,"y":100}'

# Drag from point A to B (interpolated mousemove steps)
curl -s -X POST "$BASE/mouse/drag" -H 'Content-Type: application/json' \
  -d '{"from":{"x":100,"y":200},"to":{"x":400,"y":200},"steps":10,"stepDelayMs":16}'

# Low-level mousedown / mouseup
curl -s -X POST "$BASE/mouse/down" -H 'Content-Type: application/json' -d '{"x":100,"y":200}'
curl -s -X POST "$BASE/mouse/up" -H 'Content-Type: application/json' -d '{"x":400,"y":200}'
```

### Keyboard commands

```bash
# Press key (keydown + keypress + keyup)
curl -s -X POST "$BASE/keyboard/press" -H 'Content-Type: application/json' -d '{"key":"Tab"}'

# Press with modifiers
curl -s -X POST "$BASE/keyboard/press" -H 'Content-Type: application/json' -d '{"key":"a","modifiers":{"ctrl":true}}'

# Low-level keydown / keyup (for holding keys)
curl -s -X POST "$BASE/keyboard/down" -H 'Content-Type: application/json' -d '{"key":"Shift"}'
curl -s -X POST "$BASE/keyboard/up" -H 'Content-Type: application/json' -d '{"key":"Shift"}'

# Type text (inserts characters into input/textarea/contentEditable)
curl -s -X POST "$BASE/keyboard/type" -H 'Content-Type: application/json' \
  -d '{"text":"hello world","selector":"input[placeholder=\"Search...\"]"}'

# Type into currently focused element (no selector)
curl -s -X POST "$BASE/keyboard/type" -H 'Content-Type: application/json' -d '{"text":"hello"}'
```

All mouse commands show a visible cursor overlay (white pointer + red "AGENT" label) that animates between positions and fades after 3s of inactivity. All commands return `{ element: { tagName, id, className, textContent } }` of the hit target.

The original `click` (by CSS selector) and `type` (sets `.value` directly) commands are unchanged for backward compatibility.

## Interacting with Pages That Have the Widget

Applications with the widget embedded expose a feedback overlay. Submit feedback programmatically via the API or use the widget's built-in camera button.

### Submitting Feedback via API

```bash
# Submit feedback for an app
curl -X POST 'http://localhost:3001/api/v1/feedback' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Summary of feedback",
    "description": "Detailed description",
    "type": "manual",
    "sessionId": "optional-session-id",
    "appId": "APP_ID"
  }'

# Submit programmatic feedback (error reports, analytics)
curl -X POST 'http://localhost:3001/api/v1/feedback/programmatic' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Error report title",
    "description": "Details",
    "type": "error_report",
    "appId": "APP_ID",
    "tags": ["bug", "critical"]
  }'
```

## Development

```bash
# Start the server (from repo root)
cd packages/server && npm run dev

# Start the admin UI (served by server at /admin)
cd packages/admin && npm run dev

# Build all packages
npm run build --workspaces
```

The dev setup runs **two** node processes: the main server (`src/index.ts`, port 3001) and the session-service (`src/session-service.ts`, port 3002). They're watched independently. If session-service code changes aren't taking effect, the service is running stale code — kill the whole `pnpm dev:sessions` chain and relaunch. Live tmux-backed sessions survive the restart via `tryRecoverSession()`.

## Permission Profiles

Agent sessions are spawned with a `permissionProfile` that encodes **two orthogonal axes** — I/O mode × permissions. Profile names follow the `<mode>-<perms>` format so both axes are legible at a glance.

| Axis | Values | Meaning |
|---|---|---|
| **I/O mode** | `interactive` / `headless` / `headless-stream` | TTY with visible TUI vs. one-shot `-p` pipe vs. persistent bidirectional JSON stream |
| **Permissions** | `yolo` (skip) / `require` (ask user) | Whether to pass `--dangerously-skip-permissions` (claude) / `--dangerously-bypass-approvals-and-sandbox` (codex) |

Combining the axes gives the full profile set (`packages/shared/src/constants.ts::PERMISSION_PROFILES`, resolved in `packages/server/src/session-service.ts::buildAgentCommand` and `packages/server/src/launcher-daemon.ts::buildAgentCommand`):

| Profile | Mode | Perms | Claude flags | Codex flags |
|---|---|---|---|---|
| `interactive-require` | TTY | ask | `--session-id <uuid>` | (none) |
| `interactive-yolo` | TTY | skip | `--dangerously-skip-permissions --session-id <uuid>` | `--dangerously-bypass-approvals-and-sandbox` |
| `headless-yolo` | pipe | skip | `-p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions` | `exec --dangerously-bypass-approvals-and-sandbox <prompt>` |
| `headless-stream-yolo` | stream | skip | `--print --input-format stream-json --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions` | `exec --dangerously-bypass-approvals-and-sandbox` (no native stream protocol; falls back to exec) |
| `headless-stream-require` | stream | ask | `--print --input-format stream-json --output-format stream-json --include-partial-messages --verbose` (no skip flag — approval prompts arrive as JSON events for the admin UI to answer) | `exec` only (codex exec has no approval back-channel yet; prefer claude for this profile) |
| `plain` | — | n/a | shell only | shell only |

Helper sets in `buildAgentCommand` keep the logic honest:

```ts
const PIPE_PROFILES   = { headless-yolo, headless-stream-yolo, headless-stream-require };
const SKIP_PROFILES   = { interactive-yolo, headless-yolo, headless-stream-yolo };
const STREAM_PROFILES = { headless-stream-yolo, headless-stream-require };
```

If `SKIP_PROFILES.has(profile)` the runtime passes the skip flag; otherwise it doesn't. Same for pipe / stream. Adding a new profile = adding it to these sets; don't reintroduce name-by-name comparisons scattered through the code.

**Why `headless-yolo` can't exist as `headless-require`**: claude's `-p` one-shot mode has no channel to answer permission prompts. Running headless *with* permission gating requires `--input-format stream-json` so approvals can be sent back over stdin — that's `headless-stream-require`. "Headless but ask me" = use `headless-stream-require`, not `headless-yolo` minus the flag.

**YOLO button vs. selecting a "yolo" agent from the picker** — they now produce the same behavior. The widget/admin YOLO button (`QuickDispatchPopup.pickYoloAgent`, `widget.ts::pickYoloAgent`) prefers `interactive-yolo`, falling back to `headless-yolo` / `headless-stream-yolo`. The seeded "yolo" / "codex-yolo" endpoints are migrated to `interactive-yolo` at startup (`db/index.ts` migration step 3) so picker selection and the button are both TTY + skip by default. If you *want* headless batch behavior from a named "yolo" endpoint, edit it explicitly — the migration only touches rows still on the legacy `headless-yolo` default.

**Lifecycle: follow-up prompt queue for exiting sessions.** Yolo/headless sessions exit once the current turn completes. Instead of interrupting or killing + resuming manually, enqueue a follow-up:

```bash
# Enqueue (the prompt fires on parent exit — completed, failed, or killed)
curl -s -X POST http://localhost:3001/api/v1/admin/agent-sessions/SESSION_ID/followup \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"now also do X"}'

# Inspect queue for a session
curl -s http://localhost:3001/api/v1/admin/agent-sessions/SESSION_ID/followups

# Cancel a queued followup (before it dispatches)
curl -s -X DELETE http://localhost:3001/api/v1/admin/agent-sessions/followups/FOLLOWUP_ID

# Manually trigger the sweep (debugging only; normally runs every 5s)
curl -s -X POST http://localhost:3001/api/v1/admin/session-followups/sweep
```

Under the hood a 5s timer in the main server (`dispatchPendingFollowups` in `routes/admin/session-followups.ts`) scans for pending followups whose parent has reached a terminal status, then respawns via `resumeAgentSession()` so the new run uses `--resume <claudeSessionId>` and inherits the parent's permission flags. Multiple followups on the same parent chain — each sweep dispatches one, and the next becomes the parent for the subsequent followup.

## UI Conventions

- **Never use `window.prompt()`, `window.alert()`, or `window.confirm()`** in the admin UI. These are ugly, block the thread, and break the UX. Instead, build proper in-app UI (modals, spotlight pickers, inline inputs).
- **Strict lazy tab rendering**: In `LeafPane`, `GlobalTerminalPanel`, and `PopoutPanel`, only mount the **active tab** per container. Never render inactive tabs with `display:none` — each `AgentTerminal` creates an xterm.js instance + WebSocket + resize observers, and mounting multiple simultaneously will freeze Chrome. Use `tabs.filter(sid => sid === activeTabId).map(...)` instead of `tabs.map(...)`.
- **RAF-debounced tree commits**: `commitTree()` in `pane-tree.ts` is debounced via `requestAnimationFrame` so multiple mutations within a frame coalesce into one signal update. Never set `layoutTree.value` directly outside of `commitTree` or `batch`.
- For URL input, use the `TerminalPicker` in `{ kind: 'url' }` mode via `termPickerOpen.value = { kind: 'url' }`.
- For terminal/companion selection, use the `TerminalPicker` in `{ kind: 'companion', sessionId }` or `{ kind: 'new' }` mode.
- The `TerminalPicker` is a spotlight/command-palette component (`packages/admin/src/components/TerminalPicker.tsx`) that handles all picker interactions with keyboard navigation and categories.

## Companion Tabs

The admin panel supports companion tabs that render alongside agent sessions. Tab IDs use a `type:identifier` format:

| Type | Tab ID format | What it shows |
|------|--------------|---------------|
| `jsonl:` | `jsonl:<sessionId>` | JSONL conversation viewer |
| `feedback:` | `feedback:<sessionId>` | Feedback detail view |
| `iframe:` | `iframe:<sessionId>` | Page iframe (session's URL) |
| `terminal:` | `terminal:<sessionId>` | Terminal companion |
| `isolate:` | `isolate:<componentName>` | Isolated component in iframe |
| `url:` | `url:<fullUrl>` | Arbitrary URL in iframe |

To open companions programmatically from admin code:
- `toggleCompanion(sessionId, 'jsonl')` — toggle JSONL/feedback/iframe/terminal companions
- `openUrlCompanion(url)` — open a URL iframe tab
- `openIsolateCompanion(componentName)` — open an isolated component tab
- `termPickerOpen.value = { kind: 'url' }` — open URL picker UI

Companion types are defined in `CompanionType` union in `packages/admin/src/lib/sessions.ts`. When adding a new companion type, update: `CompanionType`, `extractCompanionType()`, `renderTabContent()` in GlobalTerminalPanel, `PaneHeader`, `PaneTabBar`, `PopoutPanel.renderPanelTabContent()`, and `PopoutPanel.tabLabel()`.

## Structured JSONL Viewer

The JSONL companion tab renders Claude conversations as interactive message flows. Three view modes: Terminal (raw), Structured (parsed), Split (side-by-side). Key components:

- `packages/admin/src/components/StructuredView.tsx` — message grouping (assistant groups with tool count/token usage, user inputs, standalone system messages)
- `packages/admin/src/components/MessageRenderer.tsx` — 15+ tool renderers (Bash, Edit with diff, Write/Read with syntax highlighting, Glob/Grep, WebFetch/WebSearch, Task, AskUserQuestion, etc.)
- `packages/admin/src/components/JsonlView.tsx` — JSONL data loading with incremental parsing, file filter support, 3s polling
- `packages/admin/src/lib/output-parser.ts` — two parsers: `JsonOutputParser` (structured JSON from `--output-format stream-json`) and `TerminalOutputParser` (heuristic state machine for CLI output)
- `packages/admin/src/components/SessionViewToggle.tsx` — view mode switching

Tool results support three display modes: Code (syntax-highlighted), Markdown (rendered), Raw. Auto-truncates long output with expand button. Detects base64/URL images and renders thumbnails with lightbox.

## Live Connections

The Live Connections page (`/admin/#/live`) shows active widget WebSocket sessions. Source: `packages/admin/src/pages/LiveConnectionsPage.tsx`.

- Polls `GET /api/v1/agent/sessions` every 5s
- Shows status (active/idle), URL, browser, viewport, user, connected duration, last activity
- Expandable rows show last 50 commands with timing, category, and success/failure
- Activity auto-categorized into: screenshot, script, mouse, keyboard, interaction, navigation, inspect, widget, other
- Backend tracking in `packages/server/src/sessions.ts` (in-memory registry, 200-entry activity log cap per session)

## Remote Machines & Launchers

### Machine registry
Machines are registered compute nodes. Schema: `packages/server/src/db/schema.ts` (`machines` table). Routes: `packages/server/src/routes/machines.ts`.

```bash
# CRUD
curl -s 'http://localhost:3001/api/v1/admin/machines' | python3 -m json.tool
```

### Launchers
Daemon processes on remote machines. Source: `packages/server/src/launcher-daemon.ts` (daemon), `packages/server/src/launcher-registry.ts` (server-side registry).

```bash
# Start launcher on remote machine
SERVER_WS_URL=ws://server:3001/ws/launcher LAUNCHER_ID=gpu-box MACHINE_ID=uuid MAX_SESSIONS=5 npm run start:launcher

# List connected launchers
curl -s 'http://localhost:3001/api/v1/launchers' | python3 -m json.tool
```

Launchers connect via WebSocket, spawn PTY sessions, stream output with seq-numbered packets, heartbeat every 30s.

### Session transfer
Sessions can be transferred between launchers via `transferSession()` in `packages/server/src/dispatch.ts`. Exports JSONL files (main + continuations + subagents) and artifact files, imports on target machine.

## Harnesses (Docker Testing)

Harness configs define Docker Compose stacks for isolated agent testing. Schema: `harnessConfigs` table. Routes: `packages/server/src/routes/harness.ts`.

```bash
# List harness configs
curl -s 'http://localhost:3001/api/v1/admin/harness-configs' | python3 -m json.tool

# Start/stop harness
curl -s -X POST 'http://localhost:3001/api/v1/admin/harness-configs/CONFIG_ID/start'
curl -s -X POST 'http://localhost:3001/api/v1/admin/harness-configs/CONFIG_ID/stop'

# Launch session inside harness
curl -s -X POST 'http://localhost:3001/api/v1/admin/harness-configs/CONFIG_ID/session'
```

Each config specifies machine, app image, ports, env vars, compose dir. When an agent endpoint has `harnessConfigId`, dispatch routes to that harness's launcher. Start/stop sends `StartHarness`/`StopHarness` to the launcher which runs `docker compose up -d`/`docker compose down`.

## Key Directories

- `packages/server/src/routes/` — API route handlers (feedback, admin, aggregate, agent-sessions)
- `packages/admin/src/pages/` — Admin UI pages
- `packages/admin/src/lib/api.ts` — Frontend API client
- `packages/server/src/db/schema.ts` — Database schema (SQLite/Drizzle)
- `packages/shared/src/` — Shared types and Zod schemas
- `packages/widget/` — Embeddable feedback overlay widget

## Visible VNC Browser (pw-vnc)

To open a visible browser watchable via NoVNC at `azstaging.myworkbench.ai:6080`:

```bash
~/.claude/bin/pw-vnc-start          # launch/restart visible Chromium on DISPLAY=:1
~/.claude/bin/pw-vnc goto <url>     # navigate
~/.claude/bin/pw-vnc screenshot     # saves to /tmp/pw_vnc_screen.png
~/.claude/bin/pw-vnc eval <js>
~/.claude/bin/pw-vnc url
~/.claude/bin/pw-vnc click <selector>
~/.claude/bin/pw-vnc wait-nav
```

IPC: `/tmp/pw_vnc_cmd.txt` + `/tmp/pw_vnc_result.txt`. PID: `/tmp/pw_vnc_daemon.pid`.
Daemon source: `~/.claude/bin/pw-vnc-daemon.py` (uses full Playwright Chromium, DISPLAY=:1).
Login to staging: use `pw-vnc eval` with the React native-setter hack (no `pw-login` wrapper yet).
The headless `pw` and visible `pw-vnc` daemons are fully independent.
