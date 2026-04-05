# prompt-widget

Full-stack feedback overlay + agent session bridge. Four packages: `widget` (embeddable JS overlay), `server` (Hono API + SQLite), `admin` (Preact SPA dashboard), `shared` (types/schemas).

## Prompt Widget API (localhost:3001)

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

**Always use the widget's built-in screenshot capability. Never use browser MCP tools.**

The widget is embedded on the admin page and all widget-enabled pages. To take a screenshot, submit feedback programmatically with `screenshot: true` via the widget's JS API (from the browser console or session bridge), or use the `/screenshot` slash command. The screenshot will be captured via html-to-image and attached to the feedback item, which can then be retrieved via the admin API at `/api/v1/images/:screenshotId`.

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
