# Sessions Components

Central UI layer for viewing and managing agent sessions, terminal sessions, and FAFO swarm experiments.

## Purpose

These components provide the main dashboard views for:
- **Agent sessions** — interactive Claude sessions with feedback, tasks, and file operations tracked
- **Terminal sessions** — plain TTY shells launched locally or on remote machines
- **Swarm experiments** — FAFO (fail-fast-off) evolutionary search and Wiggum iterative testing runs
- **Session controls** — restart, companion tabs (JSONL, summary, feedback, terminal), copying IDs

## Component Map

| File | Role | Exports | Mounted |
|------|------|---------|---------|
| **SessionsListView.tsx:127** | Main agent sessions sidebar; filters, search, grouped by app/swarm/CoS; auto-jump detection; Quick Dispatch inline popup | `SessionsListView()` | `/app/*/sessions` sidebar |
| **TerminalsListView.tsx:26** | Plain TTY terminal list (permissionProfile='plain'); much simpler than agents | `TerminalsListView()` | `/app/*/terminals` sidebar |
| **SessionIdMenu.tsx:30** | Dropdown menu for session context menu (copy ID, toggle companions, restart/resume, open in panel/window/Terminal.app) | `SessionIdMenu()` | Triggered from session row menu button (hamburger icon) |
| **SessionSummaryView.tsx:269** | Parses JSONL, builds summary (tasks created/updated, files read/edited with diffs); expandable sections | `SessionSummaryView()` | Companion tab (`summary` kind) in session panel |
| **AgentCard.tsx:11** | Read-only card for an agent endpoint config; shows mode, runtime, permission profile, app, auto-plan badge | `AgentCard()` | `/app/*/agents` page |
| **SwarmDashboard.tsx:88** | FAFO multi-path and single-path swarm manager (47 KB); list, create, detail view with gen strips, run cells, feedback, comparison, convergence chart, knowledge file | `SwarmDashboard()` | `/app/*/wiggum` page main panel |
| **WiggumRunsPanel.tsx:45** | List of Wiggum iteration runs spawned by a parent session; status, progress bar, pause/resume/stop; expandable iterations | `WiggumRunsPanel()` | Companion tab (`wiggum-runs` kind) in session panel |

## SessionsListView vs TerminalsListView

**SessionsListView** (`src/components/sessions/SessionsListView.tsx:164`):
- Filters to agent sessions: `s.permissionProfile !== 'plain'`
- Tracks input state (running/idle/waiting) per session
- Renders hierarchy: swarm groups (Wiggum, FAFO, CoS) → parent–child via parentSessionId
- Sections: waiting agents, rest of agents (by app/swarm)
- Features: rename via feedback title or local label, auto-jump for waiting sessions, Quick Dispatch (+) button per app section

**TerminalsListView** (`src/components/sessions/TerminalsListView.tsx:26`):
- Filters to plain terminals: `s.permissionProfile === 'plain'`
- Simpler: open/closed, sorted by status then time
- No hierarchy, no waiting state, no dispatch popup
- Just: status dot, label, menu button, delete button

## SwarmDashboard

**Large multi-faceted UI** (~47 KB) for FAFO (evolutionary search with fitness feedback).

Sections:
1. **List view** (lines 88–224): shows all swarms for the selected app, create-swarm form, swarm cards with status/mode/artifact type badge, "Assist" button
2. **Create form** (lines 229–368): swarm name, single vs multi-path mode, artifact type (screenshot/svg/script/diff), fitness preset (imgdiff/test-pass/custom), target artifact, fan-out, base port; creates via `api.createSwarm()`
3. **Detail view** (lines 372–598): on swarm selection, shows generation strips (horizontal, each gen has run cells)
   - **Paths panel** (multi-path only): status, worktree port, focus lines, running/done counts
   - **Convergence chart** (SVG sparkline): fitness trend across generations
   - **Generation strips**: each gen shows runs as cells, best/median score, path names
   - **Run cells** (lines 757–1133): expanded view shows session links, compare-with-target mode (side-by-side images), annotation, feedback buttons (+1/-1/neutral)
   - **Knowledge file panel**: accumulated markdown from fitness evals

Key UI patterns:
- Status colors: pending (#888) / running (#4CAF50) / paused (#FF9800) / completed (#2196F3) / failed (#f44336)
- Compact run cells expand on click to full detail (screenshots, knobs JSON, feedback form)
- ImageAnnotator: click+drag on result to select region for annotation

## WiggumRunsPanel

**"Wiggum" = iterative agent refinement via screenshot feedback**, spawned as child sessions by a meta-wiggum coordinator.

Shows runs under a parent sessionId:
- Fetches via `api.getWiggumRunsByParent(sessionId)`
- Subscribes to admin WebSocket for live updates
- Per run: status badge, progress bar (currentIteration/maxIterations), prompt snippet (expandable), iterations list
- Each iteration: exit code circle (green=0, red=fail, orange=pending), session link, screenshot thumbnail

Actions: pause, resume, stop (conditional on status).

Rendered as a companion tab (`wiggum-runs` kind) — togglable from SessionIdMenu (line 155).

## AgentCard

Minimal **read-only card** for agent endpoint config in `/app/*/agents` admin page.

Shows:
- Agent name (with DEFAULT badge if isDefault=true)
- Mode tag (interactive/webhook/etc.) with color
- Runtime icon + label (Claude/Codex) if not webhook
- Permission profile (interactive-require / interactive-yolo / etc.)
- App badge (if linked) or "Global" (if not)
- Auto-plan badge (if autoPlan=true)
- Webhook URL (if mode=webhook)

Edit/Delete buttons at top right.

## SessionIdMenu

**Dropdown context menu** for a single session, opened from the hamburger icon in SessionsListView.

Submenu structure (collapsible via toggleSubmenu):
- **Copy**: session ID, JSONL path, feedback ID
- **Companion**: toggle JSONL, summary, feedback (ticket), iframe, terminal, wiggum-runs; + "Iframe..." picker + "Open App" (if harness)
- **Open In**: panel toggle (pop back or pop out), window, browser tab, Terminal.app, split panes (if tab context)
- **Restart as**: nested runtime choice (Claude/Codex) → permission profile (rows from DISPATCHABLE_PROFILES)

Handles three contexts (line 25): tab (can split), popout panel (pop back), standalone (mobile).

Keyboard shortcuts (Kbd labels):
- C = copy session ID, J = JSONL path, D = feedback ID
- L = JSONL companion, Y = summary, F = feedback, I = iframe, M = terminal, W = wiggum-runs, U = custom iframe
- O = open app (harness only)
- P = panel, W = window, B = browser tab, T = Terminal.app, S = split (tab only)

## Gotchas

1. **SessionsListView is large** (~843 lines): hierarchies (swarm + parentSessionId), app grouping, CoS thread dividers, auto-jump logic, quick dispatch modal all inline. Consider splitting into sub-components if further expanding.

2. **Auto-jump polling**: on each interval, SessionsListView checks for waiting sessions and pops them into focus if autoJumpWaiting=true. The popup shows Ctrl+Shift+A to jump, Ctrl+Shift+X to cancel. Can be disabled per-session via status menu.

3. **SwarmDashboard fitness score format**: the fitness detail JSON has optional fields (ssim, edge_iou, hist_corr, pixel_mean). Only present if the fitness function returns them; renders only what's available.

4. **WiggumRunsPanel WebSocket subscribe**: the unsubscribe function is returned from useEffect (line 61), so it auto-cleans on unmount. Parent sessionId must be stable (from props).

5. **SessionIdMenu submenu flip**: if opening near the right viewport edge, submenus flip left (line 54 checks innerWidth - rect.left < 200 + 220).

6. **Nested hierarchy rendering**: SessionsListView builds both parentSessionId tree AND swarmId/wiggumRunId groups. A session can't be in both (swarmChildIds and childIds are mutually exclusive).
