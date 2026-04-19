# ProPanes Admin UI - Agent Management Architecture

## Overview

The admin UI is a Preact SPA (Single Page Application) served by the server at `/admin/`. It manages agent endpoints, session execution, feedback dispatch, and real-time terminal interaction. The architecture is built around **Preact Signals** for reactive state management and a **modular component system** with clear separation of concerns.

---

## 1. Core State Management (Signals-Based)

The admin UI uses **Preact Signals** for all reactive state, split across multiple state files:

### 1.1 Session State (`packages/admin/src/lib/session-state.ts`)

**Core Signals:**
- `openTabs: signal<string[]>` — IDs of all open terminal/page tabs
- `activeTabId: signal<string | null>` — Currently focused tab
- `previousTabId: signal<string | null>` — For Alt+Tab-like navigation
- `panelMinimized, panelMaximized, panelHeight` — Panel layout state
- `exitedSessions: signal<Set<string>>` — Sessions that have completed/failed
- `splitEnabled: signal<boolean>` — Whether split view is active
- `rightPaneTabs, rightPaneActiveId, splitRatio` — Split pane configuration
- `viewModes: signal<Record<string, ViewMode>>` — Per-session view mode (terminal/structured/split)
- `sessionInputStates: signal<Map<string, InputState>>` — Maps session ID → input state (waiting/active/interrupt)

**Persistence:** All state is localStorage-backed. Signals load from localStorage on init and persist on every change via `persistTabs()`, `persistSplitState()`, `persistPanelState()`.

### 1.2 Companion State (`packages/admin/src/lib/companion-state.ts`)

Manages **companion tabs** (secondary views rendered alongside sessions):

- `sessionCompanions: signal<Record<string, CompanionType[]>>` — Per-session companion types
- `terminalCompanionMap: signal<Record<string, string>>` — Maps parent session → terminal session ID
- **CompanionType values:** `jsonl | feedback | iframe | terminal | isolate | url | file`
- **Tab ID format:** `{type}:{sessionId}` (e.g., `jsonl:session123`, `terminal:agent456`)

Functions:
- `getCompanions(sessionId)` → list of active companion types for a session
- `companionTabId(sessionId, type)` → generates tab ID
- `extractCompanionType(tabId)` → parses companion type from tab ID
- `setTerminalCompanion(parentId, termSessionId)` → links a terminal session to a parent

### 1.3 Popout State (`packages/admin/src/lib/popout-state.ts`)

Manages **floating/docked panels** for multi-window layouts:

- `popoutPanels: signal<PopoutPanelState[]>` — Array of floating panel definitions
- `AUTOJUMP_PANEL_ID = 'p-autojump'` — Special panel that auto-opens waiting sessions

**PopoutPanelState fields:**
- `id: string` — Unique panel ID
- `sessionIds: string[]` — Sessions contained in this panel
- `activeSessionId: string | null` — Active session within panel
- `docked: boolean` — Whether docked or floating
- `floatingRect: { x, y, w, h }` — Position/size when floating
- `dockedHeight, dockedWidth, dockedSide` — Dimensions when docked
- `alwaysOnTop: boolean` — Z-index control

**Auto-jump feature:** Sessions with `inputState='waiting'` trigger auto-jump to next waiting session (configurable via settings).

### 1.4 Pane Tree State (`packages/admin/src/lib/pane-tree.ts`)

Manages the **hierarchical layout tree** for the main UI:

- `layoutTree: signal<LayoutTree>` — Root of the split-pane tree
- **Node types:**
  - `SplitNode` → recursively splits into two children (horizontal/vertical)
  - `LeafNode` → renders a list of tabs (sidebar, sessions, etc.)

**Well-known leaf IDs:**
- `SIDEBAR_LEAF_ID` — Navigation sidebar
- `PAGE_LEAF_ID` — Main page content
- `SESSIONS_LEAF_ID` — Terminal/session tabs

Functions:
- `findLeaf(root, id)` → locate leaf by ID
- `addTabToLeaf(leafId, tabId, makeActive)` → add tab to leaf
- `splitLeaf(leafId, direction)` → split a leaf into two
- `batch(fn)` → batch multiple tree operations for efficient re-render

### 1.5 Sessions Module (`packages/admin/src/lib/sessions.ts`)

**High-level orchestrator** that imports from all state modules and provides cross-cutting functions:

**Key Functions:**

1. **Session Lifecycle:**
   - `openSession(sessionId)` — Open/focus a session tab
   - `closeTab(sessionId)` — Close session tab
   - `killSession(sessionId)` — Terminate running session
   - `deleteSession(sessionId)` — Archive session
   - `permanentlyDeleteSession(sessionId)` — Delete session record
   - `resumeSession(sessionId)` → creates new session from previous one

2. **Terminal Spawning:**
   - `spawnTerminal(appId?, launcherId?, harnessConfigId?)` → start new terminal
   - `attachTmuxSession(tmuxTarget, appId?, launcherId?)` → attach to existing tmux

3. **Dispatch (Agent Execution):**
   - `quickDispatch(feedbackId, appId?)` — dispatch to default agent
   - `batchQuickDispatch(feedbackIds[], appId?)` — dispatch multiple
   - `ensureAgentsLoaded()` → cache agents for dispatch picker

4. **Polling & Loading:**
   - `loadAllSessions(includeDeleted?, isAutoPoll?)` — fetch all sessions from server
   - `startSessionPolling()` → poll every 5s (or 30s when hidden)

5. **Auto-jump (Waiting→Active Transitions):**
   - `setSessionInputState(sessionId, state)` → track input state, trigger auto-jump
   - `activateSessionInPlace(sessionId)` → activate without opening
   - `cancelAutoJump()` — dismiss pending auto-jump

---

## 2. API Client (`packages/admin/src/lib/api.ts`)

Thin REST client wrapper over `/api/v1` endpoints.

### Agent Endpoints
```typescript
api.getAgents(appId?)           // GET /admin/agents?appId=...
api.createAgent(data)           // POST /admin/agents
api.updateAgent(id, data)       // PATCH /admin/agents/:id
api.deleteAgent(id)             // DELETE /admin/agents/:id
```

### Agent Sessions
```typescript
api.getAgentSessions(feedbackId?, includeIds?, includeDeleted?)
api.getAgentSession(id)
api.killAgentSession(id)
api.resumeAgentSession(id)
api.archiveAgentSession(id)
api.deleteAgentSession(id)
api.getJsonl(id, fileFilter?)
api.getJsonlFiles(id)
```

### Dispatch
```typescript
api.dispatch({feedbackId, agentEndpointId, instructions?, launcherId?, harnessConfigId?})
api.spawnTerminal(data)
api.attachTmuxSession(data)
api.getDispatchTargets()        // List launchers, harnesses, sprites
api.listTmuxSessions()
api.listLauncherTmuxSessions(launcherId)
```

### Dispatch Target Selection
```typescript
api.getApplications()
```

All requests are authenticated via `Authorization: Bearer <token>` header from localStorage.

---

## 3. Key Pages & Components

### Pages (`packages/admin/src/pages/`)

#### **AgentsPage.tsx**
- Lists all agent endpoints grouped by app
- CRUD for agents (create, edit, delete)
- Shows agent mode (interactive/headless/webhook), permission level, app scope
- Modal for editing/creating agents via `AgentFormModal`

#### **SessionsPage.tsx**
- Lists all active/completed sessions
- Filters: status (running/pending/completed/failed/killed), target (local/machine/harness/sprite)
- Search by session ID, feedback title, agent name
- Batch operations: spawn terminal, purge deleted sessions
- Shows session metadata: agent name, feedback link, duration, target

#### **LiveConnectionsPage.tsx**
- Polls `GET /api/v1/agent/sessions` every 5s
- Shows **widget sessions** (live WebSocket connections)
- Activity log: last 50 commands with timing, category, success/failure

#### **Other Pages:**
- `FeedbackListPage`, `FeedbackDetailPage` — Feedback management
- `AggregatePage` — Clustered feedback & action plans
- `ApplicationsPage`, `AppSettingsPage` — App configuration
- `InfrastructurePage` — Machines, harnesses, sprites
- `SettingsPage` — Admin UI settings
- `GettingStartedPage` — Onboarding

### Core Components

#### **AgentCard.tsx**
- Displays single agent with name, mode, permission profile, app scope
- Shows "DEFAULT" badge if default agent
- Edit/Delete buttons

#### **AgentFormModal.tsx**
- Form for creating/editing agents
- Fields:
  - `name` — Agent display name
  - `appId` — App scope (optional; if unset, is global)
  - `mode` — `interactive` | `headless` | `webhook`
  - `permissionProfile` — `interactive` | `auto` | `yolo` (for non-webhook)
  - `allowedTools` — Comma-separated list of pre-approved tools
  - `isDefault` — Mark as default for quick dispatch
  - **Advanced:** URL, auth header (for webhooks), prompt template, auto-plan

#### **GlobalTerminalPanel.tsx**
- Main terminal UI container (xterm.js-based)
- Tab bar with session IDs
- Hotkey hints (1-9 for session switching)
- Companion tabs (JSONL, feedback, iframe, terminal)
- Status menu (rename, colors, popout)
- Split pane controls

#### **AgentTerminal.tsx**
- **xterm.js** integration for terminal rendering
- WebSocket connection to server for sequenced I/O
- Mouse mode tracking (DECSET 1003 SGR encoding for tmux popup menus)
- Input state tracking (waiting/active/interrupt)
- Exit code handling → triggers `autofix` on errors
- Reconnect logic with exponential backoff (max 10 attempts)

#### **DispatchDialog.tsx**
- Modal for dispatching feedback to agents
- Selects: agent, target (local/machine/harness/sprite)
- Modes: Standard (instructions) | Assistant (natural language)
- Batch dispatch support
- Shows online status and session capacity per target

#### **DispatchTargetSelect.tsx**
- Loads and caches dispatch targets from `GET /admin/dispatch-targets`
- Categorizes: local, machines, harnesses, sprites
- Helpers: `targetKey()`, `findTargetByKey()`, `parseTargetKey()`

#### **PaneContent.tsx**
- Router for tab content based on tab ID format:
  - `view:page`, `view:feedback`, `view:sessions`, etc. → pages
  - `fb:<feedbackId>` → feedback detail
  - Session IDs → AgentTerminal with companions

#### **SessionViewToggle.tsx**
- View mode selector: Terminal | Structured | Split
- Toggles between raw xterm output and parsed JSONL visualization

### Companion Components

- **JsonlView.tsx** — Renders JSONL conversation flow with tool results
- **MessageRenderer.tsx** — 15+ tool renderers (Bash, Edit, Read/Write, Glob, Grep, WebFetch, Task, etc.)
- **FeedbackCompanionView.tsx** — Renders associated feedback item
- **TerminalCompanionView.tsx** — Embedded terminal session
- **IframeCompanion.tsx** — iframe for pages/URLs

---

## 4. Agent Endpoint Schema

From `packages/shared/src/schemas.ts`:

```typescript
agentEndpointSchema = {
  id: string (ULID)
  name: string
  url?: string                     // For webhook mode
  authHeader?: string | null       // For webhook mode
  isDefault: boolean
  appId?: string | null            // null = global agent
  mode: 'interactive' | 'headless' | 'webhook'
  permissionProfile: 'interactive' | 'auto' | 'yolo'
  allowedTools?: string | null     // Comma-separated
  autoPlan?: boolean
  promptTemplate?: string | null   // Custom system prompt
  createdAt: string (ISO)
  updatedAt: string (ISO)
}
```

---

## 5. Session Lifecycle & Signals Flow

### Creating a Session

1. **User clicks "Spawn Terminal"** or **Dispatch Feedback**
   - `AgentsPage` → modal to pick agent
   - `DispatchDialog` → confirm feedback, agent, target
   
2. **API call:**
   ```typescript
   api.dispatch({feedbackId, agentEndpointId, ...})
   // or
   api.spawnTerminal({appId?, launcherId?, ...})
   ```

3. **Server responds** with `{ sessionId }`
   - `openSession(sessionId)` called automatically
   - Session added to `openTabs`
   - Tab rendered in active leaf
   
4. **WebSocket connection** (via AgentTerminal)
   - Connects to `/ws/sessions/:sessionId`
   - Streams xterm output, mouse events, keyboard input
   - Tracks input state (waiting/active) via `setSessionInputState()`

5. **Auto-jump triggers** (if enabled)
   - When session transitions from `waiting` → `active`
   - Next waiting session auto-activates with 3s countdown
   - User typing cancels countdown

### Closing a Session

1. User clicks "×" on tab → `closeTab(sessionId)`
   - Removes from `openTabs`
   - Updates `activeTabId` to neighbor
   - If in split pane, updates right/left pane tabs
   - Persists to localStorage

2. Server signals session exit → `markSessionExited(sessionId)`
   - Adds to `exitedSessions` set
   - If exit code ≠ 0, triggers `autofix()` module

### Polling & Updates

`startSessionPolling()` sets up interval:
- Calls `api.getAgentSessions()` every 5s
- Compares with `allSessions` signal
- Updates only if changed (status, paneTitle, inputState)
- Pauses to 30s when page hidden
- Continues only if no user typing (debounce)

---

## 6. Input State Management

Sessions track **input state** to indicate what Claude is waiting for:

```typescript
type InputState = 'waiting' | 'interrupt' | 'active'

sessionInputStates: Map<sessionId, InputState>
```

**Transitions:**
- `active` (default) — agent running
- `waiting` → agent waiting for user input (question asked, modal, etc.)
- `interrupt` → user interrupted execution

**Auto-jump Logic:**
When a session moves from `waiting` → `active`:
1. Check if other sessions still waiting
2. If `autoJumpWaiting.value && !isUserTyping()`:
   - Set `pendingAutoJump` to next waiting session
   - Start 3s countdown (or immediate if `autoJumpInterrupt`)
   - Cancel if user starts typing (unless interrupt mode)

---

## 7. Dispatch System Architecture

### Dispatch Targets

Loaded from `GET /api/v1/admin/dispatch-targets`:

```typescript
interface DispatchTarget {
  launcherId: string
  name: string
  hostname: string
  machineName?: string | null
  machineId?: string | null
  isHarness: boolean
  harnessConfigId?: string | null
  isSprite?: boolean
  spriteConfigId?: string | null
  activeSessions: number
  maxSessions: number
  online: boolean
}
```

**Target categories:**
- **Local** — default, runs on admin server machine
- **Remote Machines** — registered compute nodes
- **Harnesses** — Docker Compose stacks for isolated testing
- **Sprites** — VM provisioning (cloud-managed)

### Dispatch Flow

1. User opens **DispatchDialog** with feedback ID(s)
2. Selects agent endpoint, target, and optional instructions
3. **Standard mode:** plain text instructions
4. **Assistant mode:** natural language → agent auto-plans
5. For each feedback ID:
   ```typescript
   api.dispatch({
     feedbackId: string,
     agentEndpointId: string,
     instructions?: string,
     launcherId?: string,
     harnessConfigId?: string
   })
   ```
6. Server returns `{ sessionId }`
7. If single dispatch: `openSession(sessionId)` → open tab
8. If batch: load next, show toast

---

## 8. View Modes

**Terminal mode** (raw xterm output):
- Default for interactive/webhook agents
- Real-time streaming output
- Keyboard/mouse input passthrough

**Structured mode** (parsed JSONL):
- Default for auto/yolo agents
- Renders Claude conversation with tool invocations
- Tool result display with syntax highlighting
- Image/base64 rendering with lightbox

**Split mode**:
- Side-by-side terminal + JSONL
- Allows inspection while execution continues

---

## 9. Settings & Configuration

From `packages/admin/src/lib/settings.ts`:

- `autoNavigateToFeedback: signal<boolean>` — Jump to feedback after dispatch
- `autoJumpWaiting: signal<boolean>` — Auto-switch to waiting sessions
- `autoJumpInterrupt: signal<boolean>` — Skip user-typing check
- `autoJumpDelay: signal<boolean>` — 3s countdown vs immediate
- `autoCloseWaitingPanel: signal<boolean>` — Close auto-jump panel on completion
- `autoJumpLogs: signal<boolean>` — Debug logging
- `showTabs: signal<boolean>` — Show tab bar
- `showHotkeyHints: signal<boolean>` — Show 1-9 hotkey hints
- `popoutMode: PopoutMode` — Window management strategy

All settings stored in localStorage with `pw-settings-*` prefix.

---

## 10. Keyboard Shortcuts (Terminal Focus)

From `packages/admin/src/lib/terminal-state.ts`:

- **1-9** → Switch to numbered session
- **Escape** → Focus terminal
- **Alt+Tab / Cmd+Tab** → Toggle between current and previous tab
- **Ctrl/Cmd+Shift+*key*** → Custom commands (configurable)
- **Ctrl+C** in terminal → Send interrupt signal

---

## 11. Key Design Patterns

### Signals for Reactive State
- All UI state is a signal
- Changes auto-trigger re-renders
- No useState needed (though hooks used for local lifecycle)

### Modular State Files
- `session-state.ts` → core tab/panel state
- `companion-state.ts` → secondary tabs
- `popout-state.ts` → floating panels
- `pane-tree.ts` → layout tree
- `sessions.ts` → cross-cutting functions
- `settings.ts` → user preferences
- `terminal-state.ts` → terminal hotkeys

### localStorage Persistence
Every state change calls `persist*()` function:
- `persistTabs()` → `pw-open-tabs`, `pw-active-tab`, etc.
- `persistCompanions()` → `pw-session-companions`
- `persistPopoutState()` → `pw-popout-panels`
- Automatic recovery on page reload

### Lazy Component Rendering
Tab content only renders when visible:
- `renderTabContent(tabId, isVisible)` checks `isVisible`
- Hidden tabs get `display:none` CSS
- AgentTerminal defers `fit()` until first visibility

### Performance Optimizations
1. **Debounced polling** — skip if user typing
2. **Partial session updates** — only update if changed
3. **Batched tree operations** — `batch()` reduces renders
4. **Signal subscriptions** — computed() for derived state
5. **Lazy loading** → agents, targets cached until needed

---

## 12. Error Handling & Recovery

### Session Errors
- Non-zero exit code → `handleSessionExit()` → autofix module
- WebSocket disconnect → auto-reconnect (10 attempts, exponential backoff)
- Terminal fit errors → swallowed, continue

### API Errors
- 401 → clear token, redirect to login
- Other errors → toast notification, console log
- Validation errors → show in modal

### Auto-fix Module
- Triggered on session exit with error
- Analyzes terminal output
- Suggests fixes or common solutions

---

## 13. Files Organization

```
packages/admin/src/
├── lib/
│   ├── session-state.ts          # Core signals
│   ├── companion-state.ts        # Companion tabs
│   ├── popout-state.ts           # Floating panels
│   ├── pane-tree.ts              # Layout tree
│   ├── sessions.ts               # High-level orchestration
│   ├── api.ts                    # REST client
│   ├── state.ts                  # Global state (route, app selection)
│   ├── settings.ts               # User preferences
│   ├── terminal-state.ts         # Hotkey handling
│   ├── agent-constants.ts        # Agent mode/profile descriptions
│   ├── shortcuts.ts              # Keyboard bindings
│   ├── tab-drag.ts               # Tab drag-drop
│   ├── autofix.ts                # Error recovery suggestions
│   └── ...
├── pages/
│   ├── AgentsPage.tsx            # Agent CRUD
│   ├── SessionsPage.tsx          # Session list
│   ├── LiveConnectionsPage.tsx   # Widget connections
│   ├── FeedbackListPage.tsx      # Feedback list
│   ├── FeedbackDetailPage.tsx    # Feedback detail
│   ├── AggregatePage.tsx         # Clustered feedback
│   ├── ApplicationsPage.tsx      # App management
│   ├── InfrastructurePage.tsx    # Machines/harnesses
│   └── ...
├── components/
│   ├── GlobalTerminalPanel.tsx   # Main terminal UI
│   ├── AgentTerminal.tsx         # xterm.js wrapper
│   ├── AgentCard.tsx             # Agent display
│   ├── AgentFormModal.tsx        # Agent form
│   ├── DispatchDialog.tsx        # Dispatch UI
│   ├── DispatchPicker.tsx        # Target picker
│   ├── DispatchTargetSelect.tsx  # Target management
│   ├── JsonlView.tsx             # JSONL renderer
│   ├── MessageRenderer.tsx       # Tool output
│   ├── PaneContent.tsx           # Tab router
│   ├── SessionViewToggle.tsx     # View mode
│   ├── TerminalPicker.tsx        # Session/terminal picker
│   ├── SpotlightSearch.tsx       # Command palette
│   └── ...
└── main.tsx
```

---

## 14. Important Constants

### Mode Info
```typescript
MODE_INFO = {
  interactive: { icon: '💻', label: 'Interactive', color: 'var(--pw-primary)' },
  headless: { icon: '⚙️', label: 'Headless', color: '#22c55e' },
  webhook: { icon: '🔗', label: 'Webhook', color: '#f59e0b' },
}
```

### Permission Profiles
```typescript
PROFILE_DESCRIPTIONS = {
  interactive: { label: 'Supervised', desc: 'You approve each tool use', icon: '👁' },
  auto: { label: 'Autonomous', desc: 'Pre-approved tools run automatically', icon: '🤖' },
  yolo: { label: 'Full Auto', desc: 'No permission checks (sandboxed only)', icon: '⚡' },
}
```

### Companion Types
- `jsonl` — JSONL viewer (Claude conversation)
- `feedback` — Associated feedback item
- `iframe` — Page iframe
- `terminal` — Embedded terminal
- `isolate` — Isolated component preview
- `url` — Arbitrary URL
- `file` — File viewer

---

## 15. End-to-End Test Harness (`packages/e2e`)

A Playwright workspace lives at `packages/e2e`. It runs every spec twice
— once at desktop 1440x900 (`desktop-chromium`) and once at iPhone 14
(`mobile-iphone-14`) — and treats the admin as a black box.

### Running

```bash
npm run test:e2e            # boot fresh server, seed, run, tear down
npm run test:e2e:update     # same, but refresh visual snapshots
```

The orchestrator at `packages/e2e/scripts/run-e2e.mjs`:

1. Picks a free port (`net.createServer().listen(0)`).
2. Spawns `tsx src/index.ts` from `packages/server` with a temp
   `DB_PATH`, temp `UPLOAD_DIR`, deterministic `JWT_SECRET`, and
   `ADMIN_PASS=e2e-admin-pass`.
3. Waits for `/api/v1/health`.
4. Seeds — via the real REST API — one application, one default agent
   endpoint, and three feedback items.
5. Exports `E2E_*` env vars and runs `playwright test`.
6. Tears the server down + removes the temp dir on exit.

There is no mocking of the server, DB, or filesystem. The single
intentional `page.route` mock is the dispatch POST in
`04-dispatch-dialog.spec.ts`, so the dialog test doesn't actually spawn a
Claude Code session.

### What the suite covers

| Spec | What it asserts |
| ---- | --------------- |
| `01-auth.spec.ts` | Login form submits, bad creds show inline error, login page visual baseline |
| `02-feedback-list.spec.ts` | Seeded rows render, search filter narrows, "+ New" form opens, table visual baseline |
| `03-feedback-detail.spec.ts` | Detail page renders title + description, visual baseline |
| `04-dispatch-dialog.spec.ts` | Quick-dispatch action opens modal, Escape closes, dispatch click POSTs (intercepted), visual baseline |
| `05-sessions-page.spec.ts` | Sessions page mounts on empty state, visual baseline |
| `06-widget-submit.spec.ts` | `POST /api/v1/feedback/programmatic` round-trips into the admin list |
| `07-message-renderer-visual.spec.ts` | MessageRenderer fixtures (Bash, Edit, AskUserQuestion, long-output collapsed/expanded) |
| `08-mobile-assertions.spec.ts` | Viewport meta present, no horizontal scroll, tap targets ≥ 44px (annotation-only on mobile until the redesign lands) |

### Adding a new MessageRenderer fixture

Fixtures are defined in
`packages/admin/src/components/MessageFixturesIsolate.tsx` and surfaced
via the admin's `isolate` query param:

```
http://localhost:3001/admin/?isolate=msg-fixture&fixture=<name>
```

To add a new tool render baseline:

1. Add an entry to `FIXTURES` in `MessageFixturesIsolate.tsx` with a
   fully-formed `ParsedMessage[]`.
2. Rebuild admin: `cd packages/admin && npm run build`.
3. Append the fixture name to the `FIXTURES` array in
   `packages/e2e/tests/07-message-renderer-visual.spec.ts`.
4. Run `npm run test:e2e:update` to capture the baseline image.

### Mobile assertions are soft today

The current admin is not yet responsive — that's owned by a sibling
agent. To avoid blocking the harness on missing UI, mobile-only checks
(horizontal overflow, tap-target size) are recorded as test annotations
on the `mobile-iphone-14` project rather than hard failures. They remain
hard assertions on `desktop-chromium`. When the mobile redesign lands,
flip the `if (isMobile)` branches in `08-mobile-assertions.spec.ts` to
hard `expect()` calls.

### Snapshot baseline

Snapshots live under `packages/e2e/tests/__snapshots__/<spec>/<name>-<project>.png`.
They are committed and represent CURRENT behavior; sibling agents (mobile
site, voice mode, structured view interaction, code cleanup) should diff
their PR baselines against the ones recorded here.

---

## Summary

The admin UI is a **highly interactive, real-time** application with sophisticated state management. Key strengths:

1. **Signals-based reactivity** — efficient, fine-grained updates
2. **Modular state architecture** — clear separation of concerns
3. **localStorage persistence** — survives page reload
4. **Auto-jump feature** — intelligently switches focus based on agent input state
5. **Multi-window support** — floating/docked panels for complex workflows
6. **Dispatch targets** — flexibility for local, remote, container, and cloud execution
7. **Rich terminal UI** — xterm.js with mouse tracking, reconnect, exit handling
8. **Permission-based access** — interactive/auto/yolo profiles for security

The architecture makes it easy to add new agent types, dispatch targets, and companion views by following established patterns.
