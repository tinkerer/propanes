# ProPanes

Feedback overlay + agent session bridge for web apps. Drop a script tag into your app, collect feedback with screenshots, and dispatch AI agents (Claude or Codex) that can see and interact with live browser sessions.

Now you're cooking with gases.

## Packages

| Package | Role |
|---|---|
| `widget` | Embeddable JS overlay — feedback button, session WebSocket, virtual mouse/keyboard receivers |
| `server` | Hono API + SQLite (Drizzle), session service, launcher daemon, Chief-of-Staff thread store |
| `admin` | Preact SPA dashboard (Signals + Vite) — feedback inbox, session terminals, popout panels |
| `shared` | TypeScript types, Zod schemas, constant tables (permission profiles, runtimes) |
| `e2e` | Playwright cross-viewport suite (desktop + mobile) for admin + widget |
| `harness` | Docker Compose stack (pw-server + pw-browser + your app) for sandboxed agent runs |
| `slack-bot` | Bolt-based Slack integration that dispatches agents from Slack threads |

## Quick start

```bash
git clone <repo> propanes
cd propanes
pnpm install
pnpm dev
```

`pnpm dev` runs turbo across packages. The server boots **two** node processes — the main API on `:3001` and the session service on `:3002` — watched independently. Admin dashboard at `http://localhost:3001/admin/` (default login: `admin`/`admin`, override via `ADMIN_USER` / `ADMIN_PASS`).

## Architecture

```
Browser (your app)         Server                       Agent runtime
┌──────────────┐    WS    ┌────────────────────┐  PTY  ┌────────────┐
│  ProPanes    │ ───────> │  :3001 main API    │ ────> │ claude CLI │
│   widget     │ <─────── │  :3002 sessions    │ <──── │  or codex  │
└──────────────┘ commands │  + Chief-of-Staff  │ output└────────────┘
                          │  + voice trace     │              │
                          └────────────────────┘              │
                                   │                          │
                              SQLite (Drizzle)                │
                                                              ▼
                          ┌────────────────────┐         ┌────────────┐
                          │ launcher-daemon    │ <─WS──> │ remote box │
                          │ (per remote node)  │         │ + harness  │
                          └────────────────────┘         └────────────┘
```

The widget opens a WebSocket to the server. Agents interact with the live page through REST endpoints — the server relays commands over the WebSocket and returns results. Sessions can run locally on the main host or on remote machines via launchers, including inside Docker harnesses.

## Widget

The `<script>` tag mounts a feedback button + session bridge. Configure via data attributes:

```html
<script src="http://localhost:3001/widget/propanes.js"
  data-endpoint="http://localhost:3001"
  data-app-key="pw_YOUR_KEY"
  data-position="bottom-right"
  data-collectors="console,network,performance,environment">
</script>
```

**Feedback collection:** textarea with screenshot capture (html-to-image), paste-to-attach images, submission history via arrow keys, gesture detector for swipe/long-press triggers.

**Data collectors** (opt-in via `data-collectors`):
- `console` — intercepts console.log/warn/error/info/debug
- `network` — hooks fetch to track HTTP errors
- `performance` — page load time, DOM content load, FCP
- `environment` — user agent, viewport, screen resolution, URL

**Session bridge:** WebSocket connection that lets agents execute commands in the page — JS evaluation, DOM queries, clicks, typing, navigation, mouse/keyboard events, screenshots. Supports batch execution, session aliasing, `waitFor` polling, and shadow DOM traversal.

**Custom hooks** — expose app-specific data to agents:

```js
window.agent = {
  getCartItems:    () => store.getState().cart.items,
  getFormErrors:   () => [...document.querySelectorAll('[data-error]')].map(el => el.textContent),
  getCurrentRoute: () => router.currentRoute.value,
};
```

Agents call hooks via `POST /api/v1/agent/sessions/:id/execute`.

## Agent runtimes and permission profiles

Two CLI runtimes are supported: **`claude`** and **`codex`**. Each session is spawned with a `permissionProfile` that encodes two orthogonal axes — I/O mode × permissions — so both are legible at a glance.

| Axis | Values | Meaning |
|---|---|---|
| **I/O mode** | `interactive` / `headless` / `headless-stream` | TTY with visible TUI vs. one-shot `-p` pipe vs. persistent bidirectional JSON stream |
| **Permissions** | `yolo` (skip) / `require` (ask user) | Whether to pass `--dangerously-skip-permissions` (claude) / `--dangerously-bypass-approvals-and-sandbox` (codex) |

Combined into the profile set in `packages/shared/src/constants.ts::PERMISSION_PROFILES`:

| Profile | Mode | Perms | Notes |
|---|---|---|---|
| `interactive-require` | TTY | ask | claude only meaningful difference: `--session-id <uuid>` |
| `interactive-yolo` | TTY | skip | what the YOLO button picks first |
| `headless-yolo` | pipe | skip | claude `-p` one-shot; no permission back-channel |
| `headless-stream-yolo` | stream | skip | bidirectional JSON; codex falls back to `exec` |
| `headless-stream-require` | stream | ask | approval prompts arrive as JSON events for the admin UI to answer; claude only |
| `plain` | — | n/a | raw shell, no agent |

Resolution lives in `packages/server/src/session-service.ts::buildAgentCommand` and `packages/server/src/launcher-daemon.ts::buildAgentCommand`. Adding a new profile = adding it to the helper sets (`PIPE_PROFILES`, `SKIP_PROFILES`, `STREAM_PROFILES`) — don't reintroduce name-by-name comparisons.

**`headless-yolo` has no `-require` twin.** claude's `-p` mode has no channel to answer permission prompts, so headless-with-gating requires `--input-format stream-json` — that's `headless-stream-require`.

Prompt templates use Handlebars-style variables: `{{feedback.title}}`, `{{feedback.description}}`, `{{feedback.consoleLogs}}`, `{{app.name}}`, `{{app.projectDir}}`, `{{session.url}}`, `{{instructions}}`.

## Follow-up prompt queue

Yolo/headless sessions exit once the current turn completes. Instead of interrupting or killing + resuming manually, enqueue a follow-up — it fires on parent exit (completed, failed, or killed) and inherits the parent's permission flags via `--resume <claudeSessionId>`.

```bash
# Enqueue
curl -s -X POST http://localhost:3001/api/v1/admin/agent-sessions/SESSION_ID/followup \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"now also do X"}'

# Inspect / cancel
curl -s http://localhost:3001/api/v1/admin/agent-sessions/SESSION_ID/followups
curl -s -X DELETE http://localhost:3001/api/v1/admin/agent-sessions/followups/FOLLOWUP_ID

# Manual sweep (debugging only; normally runs every 5s)
curl -s -X POST http://localhost:3001/api/v1/admin/session-followups/sweep
```

Multiple followups on the same parent chain — each sweep dispatches one, and the new run becomes the parent for the next.

## Agent API (live page interaction)

```bash
BASE="http://localhost:3001/api/v1/agent/sessions/SESSION_ID"
```

### Page inspection

```bash
curl -s "$BASE/screenshot"                    # Capture page screenshot
curl -s "$BASE/console"                       # Console logs
curl -s "$BASE/network"                       # Network errors
curl -s "$BASE/environment"                   # Browser/page environment
curl -s "$BASE/dom?selector=body"             # DOM snapshot with accessibility tree
curl -s -X POST "$BASE/execute" \
  -H 'Content-Type: application/json' \
  -d '{"expression": "return document.title"}'
```

### Mouse and keyboard

```bash
# Click at coordinates (full mousedown + mouseup + click sequence)
curl -s -X POST "$BASE/mouse/click" -H 'Content-Type: application/json' -d '{"x":500,"y":300}'

# Hover (mouseenter + mouseover + mousemove)
curl -s -X POST "$BASE/mouse/hover" -H 'Content-Type: application/json' -d '{"selector":"button.menu"}'

# Drag from A to B with interpolated steps
curl -s -X POST "$BASE/mouse/drag" -H 'Content-Type: application/json' \
  -d '{"from":{"x":100,"y":200},"to":{"x":400,"y":200},"steps":10}'

# Type text into element
curl -s -X POST "$BASE/keyboard/type" -H 'Content-Type: application/json' \
  -d '{"text":"hello","selector":"input[name=search]"}'

# Press key with modifiers
curl -s -X POST "$BASE/keyboard/press" -H 'Content-Type: application/json' \
  -d '{"key":"a","modifiers":{"ctrl":true}}'
```

Mouse commands show a visible cursor overlay (white pointer + red "AGENT" badge) that animates between positions and fades after 3s of inactivity. All commands return `{ element: { tagName, id, className, textContent } }` of the hit target.

### Batch execution

Run multiple commands in a single request. Sequential; stops on first error if `stopOnError: true` (default). Max 50 commands.

```bash
curl -s -X POST "$BASE/batch" -H 'Content-Type: application/json' -d '{
  "commands": [
    { "command": "clickAt", "params": { "x": 100, "y": 200 } },
    { "command": "waitFor", "params": { "selector": ".modal", "timeout": 5000 } },
    { "command": "screenshot", "params": {} }
  ],
  "stopOnError": true,
  "commandTimeout": 15000
}'
```

Returns `{ results, completedCount, totalCount, totalDurationMs, stoppedAtIndex }`.

### Session aliasing

Assign a human-readable name to a session ID. Aliases auto-cleanup on disconnect.

```bash
curl -s -X POST "$BASE/alias" -H 'Content-Type: application/json' -d '{"name":"my-page"}'
curl -s "http://localhost:3001/api/v1/agent/sessions/my-page/dom?selector=body"
curl -s -X DELETE "$BASE/alias" -H 'Content-Type: application/json' -d '{"name":"my-page"}'
```

### waitFor

Poll for a selector condition. Conditions: `exists`, `absent`, `visible`, `hidden`, `textContains`, `textEquals`.

```bash
curl -s -X POST "$BASE/waitFor" -H 'Content-Type: application/json' -d '{
  "selector": ".modal.visible",
  "condition": "exists",
  "timeout": 5000,
  "pollInterval": 100,
  "pierceShadow": false
}'
```

### Shadow DOM (`/deep`)

```
GET    /api/v1/agent/sessions/:id/dom/deep?selector=.btn
POST   /api/v1/agent/sessions/:id/click/deep
POST   /api/v1/agent/sessions/:id/type/deep
POST   /api/v1/agent/sessions/:id/mouse/hover/deep
```

### Compound widget actions

```
POST   /api/v1/agent/sessions/:id/widget/open        Open widget panel
POST   /api/v1/agent/sessions/:id/widget/close       Close widget panel
POST   /api/v1/agent/sessions/:id/widget/submit      Submit feedback via widget
POST   /api/v1/agent/sessions/:id/widget/screenshot  Screenshot with widget visible
```

## Admin dashboard

Preact SPA at `/admin/`. Pages:

- **Feedback list** — paginated inbox with type/status/tag/search filters, batch operations, quick-dispatch popup
- **Feedback detail** — full context (console logs, network errors, performance, environment, screenshots), status/tag editing, agent dispatch with custom instructions
- **Aggregate** — clusters by topic via Jaccard similarity; per-cluster action plans and AI analysis
- **Sessions** — agent activity log, terminal output viewer, kill/resume/archive
- **Settings** — global agent config, theme, keyboard navigation
- **Applications** — register apps with project directories, server URLs, hooks, API key management
- **Live connections** — real-time view of active widget WebSocket sessions
- **Machines / Launchers / Harnesses** — remote node registry and Docker stack control

### Multi-pane layout

Session terminals live in a tree of resizable panes (`packages/admin/src/lib/pane-tree.ts`). Tabs can be dragged into existing panes or onto empty space to split. Each pane lazily mounts only its **active tab** — never `display:none`-stashed — because each `AgentTerminal` creates an xterm.js instance + WebSocket + resize observers. Tree mutations are RAF-debounced via `commitTree()`.

Terminals can be **popped out** into independent floating or right-edge-docked panels with persistent layout (localStorage).

### Companion tabs

Tab IDs use `type:identifier`:

| Type | Format | Shows |
|---|---|---|
| `jsonl:` | `jsonl:<sessionId>` | Structured JSONL conversation viewer |
| `feedback:` | `feedback:<sessionId>` | Feedback detail for the dispatched item |
| `iframe:` | `iframe:<sessionId>` | Live iframe of the session's target URL |
| `terminal:` | `terminal:<sessionId>` | Dedicated terminal companion |
| `isolate:` | `isolate:<componentName>` | Isolated component in iframe |
| `url:` | `url:<fullUrl>` | Arbitrary URL iframe |

Open programmatically with `toggleCompanion(sessionId, type)`, `openUrlCompanion(url)`, or `openIsolateCompanion(name)`. Adding a new type means updating `CompanionType`, `extractCompanionType()`, `renderTabContent()`, `PaneHeader`, `PaneTabBar`, and `PopoutPanel` rendering/labeling.

### Structured JSONL viewer

The JSONL companion renders Claude conversations as interactive message flows:

- **Three view modes** — Terminal (raw PTY output), Structured (parsed messages), Split (55/45 side-by-side)
- **Message grouping** — consecutive assistant/tool_use/tool_result bundle into collapsible groups with model name, tool count, token usage (input/output/cache)
- **15+ tool renderers** — Bash, Edit (color-coded diff), Write/Read (syntax-highlighted), Glob/Grep, WebFetch/WebSearch, Task, AskUserQuestion, etc.
- **Tool result modes** — Code (syntax-highlighted), Markdown (rendered), Raw
- **JSONL file browser** — view individual files (main session, continuations, subagents) or merged
- **Subagent tracking** — system markers for parent/child workflows
- **Thinking blocks** — expandable extended reasoning sections
- **Auto-scroll** — follows latest output; scrolling up disables it

### Chief-of-Staff and voice

A persistent assistant thread ("Ops") lives in the admin chrome (`ChiefOfStaffBubble`). It's a long-running Claude session with this repo's CLAUDE.md and tools — used to triage feedback, dispatch agents, query infra, and coordinate concurrent Ops sessions via an advisory lock API.

```
POST /api/v1/admin/chief-of-staff/lock      { requestId, key }
DELETE /api/v1/admin/chief-of-staff/lock/:requestId/:key
GET  /api/v1/admin/chief-of-staff/sessions  Inspect concurrent sessions
```

Assistant replies and screenshots reach the bubble from the agent's output stream — `<cos-reply>` tags are extracted and rendered automatically. Embed images as markdown data URLs (`![](data:image/png;base64,...)`) inside a cos-reply tag; there is no separate POST endpoint for posting messages back into a thread.

A voice bridge (`packages/server/src/routes/voice.ts` + `VoiceTracePanel`) ingests microphone audio from a popup window and streams transcribed user turns into the thread.

### Live connections

Polls `GET /api/v1/agent/sessions` every 5s. Backend tracking in `packages/server/src/sessions.ts` (in-memory registry, 200-entry activity log cap per session). Activity auto-categorized into screenshot, script, mouse, keyboard, interaction, navigation, inspect, widget, other. Expandable rows show last 50 commands with timing and success/failure.

### Sidebar session management

Resizable sessions drawer with search and quick archive. Each session tab shows a status dot that opens a context menu with **Kill**, **Resolve** (marks feedback resolved + closes session), **Resume**, **Close tab**, **Archive**. Hold `Ctrl+Shift` to see tab numbers; `Ctrl+Shift+N` to jump.

### Terminal features

PTY-backed xterm.js instances:

- **Tmux copy-mode** — drag-to-select enters copy-mode; vi keybindings (`v` visual, `Space`/`y` to copy via pbcopy, `Enter` to copy + exit)
- **Right-click context menu** — different options for normal mode (copy, paste, select all, copy `tmux attach`) vs copy-mode
- **Open in terminal** — launches the tmux session in a native Terminal.app via `POST /api/v1/admin/agent-sessions/:id/open-terminal`
- **Auto-resize** — PTY dimensions update on tab switch and panel resize

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+Shift+Space` | Spotlight search (apps, sessions, feedback) |
| `Ctrl+\` | Toggle sidebar |
| `` ` `` | Minimize/restore terminal |
| `g f` / `g a` / `g s` / `g l` / `g g` / `g p` / `g t` | Go to feedback / aggregate / sessions / live / settings / applications / agents |
| `Ctrl+Shift+0-9` | Jump to session tab by number |
| `?` | Show shortcut help |

## Session lifecycle

- **Tmux integration** — sessions persist across service restarts; orphaned `pw-*` tmux sessions are auto-recovered. Custom config (`tmux-pw.conf`) provides mouse, vi copy-mode, and clipboard integration.
- **Output streaming** — WebSocket protocol with sequence numbers; ACK-based replay on reconnect.
- **Output persistence** — flushed to SQLite every 10s (last 500KB retained).
- **Kill / resume** — running sessions controllable from admin UI or sidebar context menu.
- **Open in terminal** — any tmux-backed session via `POST /api/v1/admin/agent-sessions/:id/open-terminal`.
- **Short ID lookup** — sessions and feedback resolvable by short ID prefix.

## Remote machines, launchers, harnesses

### Machine registry

```
GET/POST/PATCH/DELETE  /api/v1/admin/machines
```

Each machine tracks capabilities (Docker, tmux, Claude CLI), tags, and online status (computed live from connected launchers).

### Launchers

Daemon processes that connect to the server via WebSocket and spawn PTY sessions on remote nodes.

```bash
SERVER_WS_URL=ws://your-server:3001/ws/launcher \
LAUNCHER_ID=gpu-box \
MACHINE_ID=machine-uuid \
MAX_SESSIONS=5 \
pnpm --filter @propanes/server start:launcher
```

Each launcher registers on connect (capabilities, hostname, machine ID), spawns sessions on `spawn_session`, streams output back as seq-numbered packets, heartbeats every 30s, and is pruned after 90s of silence. Server selects an available launcher via `findAvailableLauncher()`. Sessions on remote machines can be opened in a local Terminal.app via SSH.

```
GET  /api/v1/launchers
```

### Session transfer

Completed sessions can be moved between launchers via `transferSession()` in `packages/server/src/dispatch.ts` — exports JSONL files (main + continuations + subagents) and artifact files, then imports on the target.

### Harnesses

Docker Compose stacks (browser + app + pw-server) for isolated agent runs.

```
GET/POST/PATCH/DELETE  /api/v1/admin/harness-configs
POST  /api/v1/admin/harness-configs/:id/start    Start Docker Compose stack
POST  /api/v1/admin/harness-configs/:id/stop     Stop Docker Compose stack
POST  /api/v1/admin/harness-configs/:id/session  Launch agent session inside container
```

Each config specifies machine, app image, port mappings, env vars, and compose dir. When an agent endpoint has `harnessConfigId`, dispatch routes to that harness's launcher; the admin UI shows managed configs alongside live unmanaged harnesses with start/stop/launch controls. See `packages/harness/README.md` for the standalone harness layout.

## REST API

### Feedback

```
POST   /api/v1/feedback                    Submit feedback (JSON or multipart)
POST   /api/v1/feedback/programmatic       Submit from code (error reports, analytics)
GET    /api/v1/admin/feedback              List (paginated, filter by type/status/tag/appId/search)
GET    /api/v1/admin/feedback/:id          Get single item with tags + screenshots
PATCH  /api/v1/admin/feedback/:id          Update status / title / description / tags
DELETE /api/v1/admin/feedback/:id
POST   /api/v1/admin/feedback/batch        Batch operations
GET    /api/v1/admin/feedback/events       SSE stream of new feedback
POST   /api/v1/admin/feedback/:id/dispatch Dispatch a feedback item to an agent endpoint
```

### Agent sessions

```
POST   /api/v1/admin/dispatch                            Dispatch (webhook or PTY)
GET    /api/v1/admin/agent-sessions                      List (filter by feedbackId)
GET    /api/v1/admin/agent-sessions/:id                  Get session with output log
POST   /api/v1/admin/agent-sessions/:id/kill
POST   /api/v1/admin/agent-sessions/:id/resume
POST   /api/v1/admin/agent-sessions/:id/archive
POST   /api/v1/admin/agent-sessions/:id/open-terminal
DELETE /api/v1/admin/agent-sessions/:id
POST   /api/v1/admin/agent-sessions/:id/followup         Enqueue follow-up prompt
GET    /api/v1/admin/agent-sessions/:id/followups
DELETE /api/v1/admin/agent-sessions/followups/:id
POST   /api/v1/admin/session-followups/sweep             Manual sweep (debug)
```

### Aggregate

```
GET    /api/v1/admin/aggregate                   Clustered feedback (filter by appId, minCount)
POST   /api/v1/admin/aggregate/analyze           AI clustering for an app
POST   /api/v1/admin/aggregate/analyze-cluster   AI analysis of specific cluster
GET/POST/PATCH/DELETE  /api/v1/admin/aggregate/plans
```

### Applications, agents, machines

```
GET/POST/PATCH/DELETE  /api/v1/admin/applications
GET/POST/PATCH/DELETE  /api/v1/admin/agents
GET/POST/PATCH/DELETE  /api/v1/admin/machines
GET/POST/PATCH/DELETE  /api/v1/admin/harness-configs
GET                    /api/v1/launchers
POST                   /api/v1/admin/applications/:id/regenerate-key
```

## Performance profiling

The admin dashboard has built-in instrumentation for API call timing. See [docs/performance-profiling.md](docs/performance-profiling.md) for the on-screen overlay, console logging (`pwPerf()` in the browser console), and server-side metric persistence.

## Development

```bash
pnpm dev               # Turbo: server + session service in watch mode (3001 + 3002)
pnpm build             # Build all packages
pnpm test              # Run package test suites
pnpm test:e2e          # Playwright E2E (desktop + mobile)
pnpm test:e2e:update   # Update visual baselines
pnpm lint
```

Per-package:

```bash
# Server (port 3001 main, 3002 sessions)
pnpm --filter @propanes/server dev               # Both watchers (concurrently)
pnpm --filter @propanes/server dev:server        # Just main API
pnpm --filter @propanes/server dev:sessions      # Just session service
pnpm --filter @propanes/server dev:launcher      # Launcher daemon

# Database (run from packages/server, paths in drizzle.config.ts)
pnpm --filter @propanes/server db:generate
pnpm --filter @propanes/server db:migrate

# Slack bot
pnpm --filter @propanes/slack-bot dev

# Harness (Docker Compose)
cd packages/harness && docker compose up
```

**Session-service caveat:** if session-service code changes aren't taking effect, the service is running stale code — kill the whole `dev:sessions` chain and relaunch. Live tmux-backed sessions survive the restart via `tryRecoverSession()`.

## UI conventions

- **No `window.prompt()` / `window.alert()` / `window.confirm()`** in the admin UI. Build proper in-app UI (modals, spotlight pickers, inline inputs).
- **Strict lazy tab rendering** in `LeafPane`, `GlobalTerminalPanel`, `PopoutPanel` — only mount the **active tab** per container. Each `AgentTerminal` is an xterm.js + WebSocket + resize observer; multiple mounted simultaneously will freeze Chrome.
- **RAF-debounced tree commits** — never set `layoutTree.value` directly outside `commitTree()` or `batch`.
- **TerminalPicker** is the spotlight picker for URLs and companion selection. Open via `termPickerOpen.value = { kind: 'url' }` or `{ kind: 'companion', sessionId }` or `{ kind: 'new' }`.

## Project structure

```
packages/
  widget/       Embeddable JS overlay (web component + session bridge)
  server/       Hono API, session service, launcher daemon (SQLite/Drizzle)
  admin/        Preact SPA dashboard (Signals + Vite)
  shared/       Shared TypeScript types and Zod schemas
  e2e/          Playwright cross-viewport suite
  harness/      Dockerized agent sandbox
  slack-bot/    Slack Bolt integration
```

See [CLAUDE.md](CLAUDE.md) for the working notes used by Claude Code sessions in this repo.
