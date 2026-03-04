# Prompt Widget

Feedback overlay + agent session bridge for web apps. Drop a script tag into your app, collect feedback with screenshots, and dispatch AI agents that can see and interact with live browser sessions.

Four packages: **widget** (embeddable JS overlay), **server** (Hono API + SQLite), **admin** (Preact SPA dashboard), **shared** (types/schemas).

## Quick start

```bash
git clone https://github.com/tinkerer/prompt-widget.git
cd prompt-widget
npm install
npm run dev
```

This starts both the API server and the session service. Admin dashboard at `http://localhost:3001/admin/` (login: admin/admin).

## Architecture

```
Browser (your app)          Server (:3001)              Agent
┌──────────────┐     WS     ┌──────────────┐     PTY    ┌──────────┐
│ prompt-widget │ ─────────> │  session mgr │ ─────────> │ claude   │
│   overlay     │ <───────── │  + REST API  │ <───────── │   CLI    │
└──────────────┘  commands   └──────────────┘  output    └──────────┘
                                   │
                              SQLite (Drizzle)
```

The widget opens a WebSocket to the server. Agents interact with the live page through REST endpoints — the server relays commands over the WebSocket and returns results.

## What the widget does

The `<script>` tag creates a feedback button overlay. Configure via data attributes:

```html
<script src="http://localhost:3001/widget/prompt-widget.js"
  data-endpoint="http://localhost:3001"
  data-app-key="pw_YOUR_KEY"
  data-position="bottom-right"
  data-collectors="console,network,performance,environment">
</script>
```

**Feedback collection:** textarea with screenshot capture (html-to-image), paste-to-attach images, submission history via arrow keys.

**Data collectors** (opt-in via `data-collectors`):
- `console` — intercepts console.log/warn/error/info/debug
- `network` — hooks fetch to track HTTP errors
- `performance` — page load time, DOM content load, FCP
- `environment` — user agent, viewport, screen resolution, URL

**Session bridge:** WebSocket connection that lets agents execute commands in the page — JS evaluation, DOM queries, click, type, navigate, mouse/keyboard events, screenshots. Supports batch execution, session aliasing, `waitFor` polling, and shadow DOM traversal.

**Custom hooks** — expose app-specific data to agents:

```js
window.agent = {
  getCartItems:    () => store.getState().cart.items,
  getFormErrors:   () => [...document.querySelectorAll('[data-error]')].map(el => el.textContent),
  getCurrentRoute: () => router.currentRoute.value,
};
```

Agents call hooks via `POST /api/v1/agent/sessions/:id/execute`.

## Agent API

Agents interact with pages that have the widget embedded.

### Page inspection

```bash
BASE="http://localhost:3001/api/v1/agent/sessions/SESSION_ID"

curl -s "$BASE/screenshot"                    # Capture page screenshot
curl -s "$BASE/console"                       # Console logs
curl -s "$BASE/network"                       # Network errors
curl -s "$BASE/environment"                   # Browser/page environment
curl -s "$BASE/dom?selector=body"             # DOM snapshot with accessibility tree
curl -s -X POST "$BASE/execute" \
  -H 'Content-Type: application/json' \
  -d '{"expression": "return document.title"}'  # Run JS in page
```

### Mouse and keyboard

```bash
# Click at coordinates (fires full mousedown + mouseup + click sequence)
curl -s -X POST "$BASE/mouse/click" -H 'Content-Type: application/json' -d '{"x":500,"y":300}'

# Hover (fires mouseenter + mouseover + mousemove)
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

Mouse commands show a visible cursor overlay (white pointer + "AGENT" badge) that animates between positions.

## Admin dashboard

Preact SPA at `/admin/`. Pages:

- **Feedback list** — paginated inbox with filters (type, status, tag, search), batch operations, quick-dispatch to agents. Each item shows a short ID for quick reference.
- **Feedback detail** — full context (console logs, network errors, performance, environment, screenshots with annotations), status/tag editing, agent dispatch with custom instructions
- **Aggregate** — groups feedback by topic using Jaccard similarity, action plan creation per cluster, AI-driven analysis
- **Sessions** — agent session activity log with status filters, terminal output viewer, kill/resume/archive
- **Settings** — global agent configuration, theme (dark/light), keyboard navigation preferences
- **Applications** — register apps with project directories, server URLs, hooks, API key management
- **Live connections** — real-time view of active widget WebSocket sessions

### Companion tabs

Session terminals support companion tabs that render alongside agent output. Open companions from the session context menu or keyboard shortcuts.

| Type | What it shows |
|------|---------------|
| **JSONL** | Conversation viewer — parsed Claude JSONL with message grouping, tool rendering, token usage |
| **Feedback** | Feedback detail view for the dispatched item |
| **Page iframe** | Live iframe of the session's target URL |
| **Terminal** | Dedicated terminal companion for a session |
| **Isolate** | Isolated component rendered in an iframe |
| **URL iframe** | Arbitrary URL loaded in an iframe tab |

Companions follow session focus — switching sessions in the left pane auto-switches associated companions in the right pane.

### Structured JSONL viewer

The JSONL companion renders Claude agent conversations as formatted, interactive message flows:

- **Three view modes** — Terminal (raw PTY output), Structured (parsed messages), Split (55/45 side-by-side)
- **Message grouping** — consecutive assistant/tool_use/tool_result messages bundle into collapsible groups showing model name, tool count, and token usage (input/output/cache)
- **15+ tool renderers** — Bash (command + description), Edit (color-coded diff), Write/Read (syntax-highlighted), Glob/Grep (pattern + path), WebFetch/WebSearch, Task management, AskUserQuestion (with answer tracking), and more
- **Tool result modes** — toggle between Code (syntax-highlighted), Markdown (rendered), and Raw views
- **JSONL file browser** — dropdown to view individual files (main session, continuations, subagents) or merged view
- **Subagent tracking** — system markers for multi-agent workflows with parent/child relationships
- **Thinking blocks** — expandable extended reasoning sections
- **Auto-scroll** — follows latest output; scrolling up disables auto-scroll

### Live connections

The Live Connections page (`/admin/#/live`) shows all active widget WebSocket sessions in real-time:

- **Connection table** — status (active/idle), URL, browser type, viewport, user ID, connected duration, last activity time
- **Activity tracking** — each session logs commands by category (screenshots, scripts, mouse, keyboard, navigation, inspections, widget interactions)
- **Expandable rows** — click to see the last 50 commands with timestamp, duration, and success/failure status
- **5-second polling** — connections update automatically; idle = no activity for 30+ seconds

### Sidebar session management

The sidebar has a resizable sessions drawer with search and quick archive. Each session tab shows a status dot that opens a context menu with **Kill**, **Resolve** (marks feedback resolved and closes the session), **Resume**, **Close tab**, and **Archive** actions. Tabs can be numbered — hold `Ctrl+Shift` to see numbers and press `Ctrl+Shift+N` to jump.

### Multi-panel popout system

Session terminals can be popped out of the sidebar into independent floating or docked panels:

- **Drag to pop out** — drag a session tab away from the sidebar to create a floating panel
- **Float / Dock** — toggle between a freely-positioned floating panel and a docked panel pinned to the right edge
- **Drag between panels** — move session tabs between panels, or drag to empty space to split into a new panel
- **Resizable** — all edges are draggable (floating panels: all four sides; docked: top, bottom, left)
- **Persistent layout** — panel positions, sizes, and docked state are saved to localStorage

### Terminal features

Session terminals are full PTY-backed xterm.js instances with:

- **Three view modes** — Terminal (full), Structured (parsed output), Split (55/45 side-by-side)
- **Tmux copy-mode** — drag to select enters copy-mode automatically; vi keybindings (`v` visual select, `Space`/`y` to copy via pbcopy, `Enter` to copy and exit)
- **Right-click context menu** — different options for normal mode (copy, paste, select all, copy tmux attach command) and copy-mode (copy selection, exit copy-mode)
- **Open in terminal** — launches the tmux session in a native Terminal.app window for full local access
- **Auto-resize** — PTY dimensions update on tab switch and panel resize

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` / `Ctrl+Shift+Space` | Spotlight search (apps, sessions, feedback) |
| `Ctrl+\` | Toggle sidebar |
| `` ` `` | Minimize/restore terminal |
| `g f` | Go to feedback |
| `g a` | Go to aggregate |
| `g s` | Go to sessions |
| `g l` | Go to live connections |
| `g g` | Go to settings |
| `g p` | Go to applications |
| `g t` | Go to agents |
| `Ctrl+Shift+0-9` | Jump to session tab by number |
| `?` | Show shortcut help |

## Agent endpoints

Three execution modes:

| Mode | How it works |
|------|-------------|
| `webhook` | HTTP POST to your URL with feedback payload |
| `headless` | Spawns `claude` CLI as PTY, passes prompt via `-p` flag |
| `interactive` | Spawns `claude` CLI as PTY, sends prompt after shell is ready |

Three permission profiles for PTY modes:

| Profile | Behavior |
|---------|----------|
| `interactive` | Agent waits for user approval on tool use |
| `auto` | No user prompts, agent runs autonomously |
| `yolo` | Skips all permission checks |

Prompt templates use Handlebars-style variables: `{{feedback.title}}`, `{{feedback.description}}`, `{{feedback.consoleLogs}}`, `{{app.name}}`, `{{app.projectDir}}`, `{{session.url}}`, `{{instructions}}`.

## Session management

Agent sessions run as PTY processes managed by the session service. Features:

- **Tmux integration** — if tmux is available, sessions persist across service restarts. On startup, orphaned `pw-*` tmux sessions are automatically recovered. Custom tmux config (`tmux-pw.conf`) provides mouse support, vi copy-mode bindings, and clipboard integration.
- **Output streaming** — WebSocket protocol with sequence numbers for reliable delivery, ACK-based replay for reconnection
- **Output persistence** — logs flushed to SQLite every 10s (last 500KB retained)
- **Kill/resume** — running sessions can be killed or resumed from the admin UI or sidebar context menu
- **Open in terminal** — any running tmux session can be opened in a native Terminal.app window via `POST /api/v1/admin/agent-sessions/:id/open-terminal`
- **Copy tmux attach** — copy the `tmux attach` command to clipboard for manual reattachment
- **Short ID lookup** — sessions and feedback can be referenced by short ID prefix

## Remote machines and launchers

### Machine registry

Register compute nodes (local, cloud, GPU boxes) via the admin UI or API. Each machine tracks:

- **Capabilities** — Docker, tmux, Claude CLI support
- **Tags** — for organization and filtering
- **Online status** — computed live from connected launchers

```
GET/POST/PATCH/DELETE  /api/v1/admin/machines
```

### Distributed launchers

Launchers are daemon processes that run on each machine, connecting to the server via WebSocket:

```bash
# On the remote machine
SERVER_WS_URL=ws://your-server:3001/ws/launcher \
LAUNCHER_ID=gpu-box \
MACHINE_ID=machine-uuid \
MAX_SESSIONS=5 \
npm run start:launcher
```

Each launcher:
- Registers with the server on connect (capabilities, hostname, machine ID)
- Spawns Claude CLI sessions as PTY processes when the server sends `spawn_session`
- Streams output back via WebSocket with sequence-numbered packets
- Heartbeats every 30s; server prunes stale launchers after 90s
- Manages concurrent load (`MAX_SESSIONS`, default 5)

Multiple launchers can connect. The server selects by availability via `findAvailableLauncher()`. Sessions on remote machines can be opened in a local Terminal.app window via SSH.

```
GET  /api/v1/launchers              List connected launchers with session counts
```

### Session transfer

Completed sessions can be transferred between launchers. The server exports JSONL files (including continuations and subagents) plus artifact files (edited source files, plan files), then imports them on the target machine. This enables workflows where an agent starts on one machine and continues on another.

### Harnesses (Docker containerized testing)

Harnesses run isolated Docker Compose stacks with a browser, app, and pw-server for agent testing:

```
GET/POST/PATCH/DELETE  /api/v1/admin/harness-configs
POST  /api/v1/admin/harness-configs/:id/start     Start Docker Compose stack
POST  /api/v1/admin/harness-configs/:id/stop      Stop Docker Compose stack
POST  /api/v1/admin/harness-configs/:id/session   Launch agent session inside container
```

Each harness config specifies:
- **Machine** — which registered machine to deploy on
- **App image** — Docker image for the application under test
- **Ports/env** — container port mappings and environment variables
- **Compose dir** — path to `docker-compose.yml` on the target machine

When an agent endpoint has a `harnessConfigId`, dispatch automatically routes sessions to that harness's launcher. The admin UI shows managed configs and live unmanaged harnesses with start/stop/launch controls.

## REST API

### Feedback

```
POST   /api/v1/feedback                    Submit feedback (JSON or multipart with screenshots)
POST   /api/v1/feedback/programmatic       Submit from code (error reports, analytics)
GET    /api/v1/admin/feedback              List (paginated, filterable by type/status/tag/appId/search)
GET    /api/v1/admin/feedback/:id          Get single item with tags and screenshots
PATCH  /api/v1/admin/feedback/:id          Update status, title, description, tags
DELETE /api/v1/admin/feedback/:id          Delete
POST   /api/v1/admin/feedback/batch        Batch operations
GET    /api/v1/admin/feedback/events       SSE stream of new feedback
```

### Agent sessions

```
POST   /api/v1/admin/dispatch              Dispatch feedback to agent (webhook or PTY)
GET    /api/v1/admin/agent-sessions        List sessions (filter by feedbackId)
GET    /api/v1/admin/agent-sessions/:id    Get session with output log
POST   /api/v1/admin/agent-sessions/:id/kill      Kill running session
POST   /api/v1/admin/agent-sessions/:id/resume    Resume session
POST   /api/v1/admin/agent-sessions/:id/archive   Soft delete
POST   /api/v1/admin/agent-sessions/:id/open-terminal  Open in native Terminal.app
DELETE /api/v1/admin/agent-sessions/:id            Permanent delete
```

### Aggregate

```
GET    /api/v1/admin/aggregate             Clustered feedback (filter by appId, minCount)
POST   /api/v1/admin/aggregate/analyze     AI-driven clustering for an app
POST   /api/v1/admin/aggregate/analyze-cluster   AI analysis of specific cluster
GET    /api/v1/admin/aggregate/plans       List action plans
POST   /api/v1/admin/aggregate/plans       Create plan
PATCH  /api/v1/admin/aggregate/plans/:id   Update plan
DELETE /api/v1/admin/aggregate/plans/:id   Delete plan
```

### Virtual mouse and keyboard

```
POST   /api/v1/agent/sessions/:id/mouse/move     Move cursor (shows visible pointer)
POST   /api/v1/agent/sessions/:id/mouse/click    Click at coordinates or selector
POST   /api/v1/agent/sessions/:id/mouse/hover    Hover element (mouseenter + mouseover)
POST   /api/v1/agent/sessions/:id/mouse/drag     Drag from A to B with interpolated steps
POST   /api/v1/agent/sessions/:id/mouse/down     Low-level mousedown
POST   /api/v1/agent/sessions/:id/mouse/up       Low-level mouseup
POST   /api/v1/agent/sessions/:id/keyboard/press  Press key (with optional modifiers)
POST   /api/v1/agent/sessions/:id/keyboard/type   Type text into element
POST   /api/v1/agent/sessions/:id/keyboard/down   Low-level keydown
POST   /api/v1/agent/sessions/:id/keyboard/up     Low-level keyup
```

### Batch execution

Execute multiple commands in a single request. Commands run sequentially; execution stops on first error if `stopOnError` is true (default).

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

Returns `{ results, completedCount, totalCount, totalDurationMs, stoppedAtIndex }`. Max 50 commands per batch.

### Session aliasing

Assign a human-readable name to a session ID, then use the alias anywhere a session ID is accepted.

```bash
# Set alias
curl -s -X POST "$BASE/alias" -H 'Content-Type: application/json' -d '{"name":"my-page"}'

# Now use "my-page" instead of the session ID
curl -s "http://localhost:3001/api/v1/agent/sessions/my-page/dom?selector=body"

# Remove alias
curl -s -X DELETE "$BASE/alias" -H 'Content-Type: application/json' -d '{"name":"my-page"}'
```

Aliases are automatically cleaned up when the session disconnects.

### waitFor

Poll for a selector condition before proceeding. Useful for waiting on modals, spinners, or dynamic content.

```bash
curl -s -X POST "$BASE/waitFor" -H 'Content-Type: application/json' -d '{
  "selector": ".modal.visible",
  "condition": "exists",
  "timeout": 5000,
  "pollInterval": 100,
  "pierceShadow": false
}'
```

Conditions: `exists`, `absent`, `visible`, `hidden`, `textContains`, `textEquals`. For text conditions, pass `"text": "expected value"`. Returns `{ found, selector, condition, elapsedMs, timedOut, element }`.

### Shadow DOM queries

Selector-based commands can pierce open shadow roots with dedicated `/deep` endpoints or via the `pierceShadow` param on `waitFor`:

```
GET    /api/v1/agent/sessions/:id/dom/deep?selector=.btn    DOM snapshot through shadow roots
POST   /api/v1/agent/sessions/:id/click/deep                Click element inside shadow DOM
POST   /api/v1/agent/sessions/:id/type/deep                 Type into shadow DOM element
POST   /api/v1/agent/sessions/:id/mouse/hover/deep          Hover shadow DOM element
```

The accessibility tree (`getDom`) also traverses shadow roots when using the `/deep` variant.

### Compound widget actions

High-level endpoints for common widget interactions:

```
POST   /api/v1/agent/sessions/:id/widget/open        Open widget panel (feedback, aggregate, etc.)
POST   /api/v1/agent/sessions/:id/widget/close       Close widget panel
POST   /api/v1/agent/sessions/:id/widget/submit      Submit feedback via widget (with optional screenshot)
POST   /api/v1/agent/sessions/:id/widget/screenshot   Screenshot with widget visible (includeWidget defaults to true)
```

### Agent testing primitives

```
POST   /api/v1/agent/sessions/:id/batch           Execute commands sequentially in one request
POST   /api/v1/agent/sessions/:id/alias            Set session alias (alphanumeric, hyphens, underscores)
DELETE /api/v1/agent/sessions/:id/alias            Remove session alias
POST   /api/v1/agent/sessions/:id/waitFor          Poll for selector condition (exists/absent/visible/hidden/text)
GET    /api/v1/agent/sessions/:id/dom/deep         DOM snapshot piercing shadow roots
POST   /api/v1/agent/sessions/:id/click/deep       Click through shadow DOM
POST   /api/v1/agent/sessions/:id/type/deep        Type into shadow DOM element
POST   /api/v1/agent/sessions/:id/mouse/hover/deep Hover through shadow DOM
POST   /api/v1/agent/sessions/:id/widget/open      Open widget panel
POST   /api/v1/agent/sessions/:id/widget/close     Close widget panel
POST   /api/v1/agent/sessions/:id/widget/submit    Submit feedback via widget
POST   /api/v1/agent/sessions/:id/widget/screenshot Screenshot including widget
```

### Applications and agents

```
GET/POST/PATCH/DELETE  /api/v1/admin/applications
GET/POST/PATCH/DELETE  /api/v1/admin/agents
POST  /api/v1/admin/applications/:id/regenerate-key
```

## Performance profiling

The admin dashboard has built-in instrumentation for API call timing. See [docs/performance-profiling.md](docs/performance-profiling.md) for details on the on-screen overlay, console logging (`pwPerf()` in the browser console), and server-side metric persistence.

## Development

```bash
npm run dev              # Start server + session service (watch mode)
npm run build            # Build all packages

# Individual services
cd packages/server
npm run dev:server       # Just the API server
npm run dev:sessions     # Just the session service
npm run dev:launcher     # Just the launcher daemon

# Database
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Apply migrations
```

## Project structure

```
packages/
  widget/       Embeddable JS overlay (web component + session bridge)
  server/       Hono API server, session service, launcher daemon (SQLite/Drizzle)
  admin/        Preact SPA dashboard (Signals + Vite)
  shared/       Shared TypeScript types and Zod schemas
```
