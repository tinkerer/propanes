# Polling Audit — Prompt Widget

## Executive Summary

Found **15 polling instances** in the admin UI. The server already has 3 WebSocket servers + 1 SSE endpoint. Most admin polling can be replaced by extending the existing `/ws/agent-session` WebSocket or adding a general-purpose admin WebSocket.

## Existing Push Infrastructure (Server)

| Endpoint | Purpose | Used By |
|----------|---------|---------|
| `/ws` | Widget ↔ server comms | Widget sessions |
| `/ws/agent-session` | Session output streaming | Admin terminal views |
| `/ws/launcher` | Launcher registration + heartbeat | Remote launchers |
| `/api/v1/admin/feedback/events` (SSE) | Feedback new/updated events | Feedback list page |

## Admin Polling — Can Replace (High Value)

### 1. Session List — `sessions.ts:505-524`
- **Interval:** 5s active / 30s background
- **Fetches:** All sessions with status, inputState, paneTitle, paneCommand
- **Replace with:** Extend `/ws/agent-session` to push session list diffs. Server already tracks session state changes — just broadcast them.
- **Impact:** Eliminates the single most frequent API call across all admin pages.

### 2. Live Connections (sidebar badge) — `SidebarNavView.tsx:64-67`
- **Interval:** 5s
- **Fetches:** `getLiveConnections()` — widget sessions grouped by app
- **Replace with:** Push from server when widget connects/disconnects (already tracked in session registry).

### 3. Live Connections Page — `LiveConnectionsPage.tsx:184-189`
- **Interval:** 5s
- **Fetches:** Full session activity logs, last 50 commands per session
- **Replace with:** Same WebSocket channel as #2, with activity log deltas.

### 4. JSONL Messages — `JsonlView.tsx:58`
- **Interval:** 3s
- **Fetches:** Incremental JSONL messages (checks file size, fetches new bytes)
- **Replace with:** The session output is already streamed via `/ws/agent-session`. Could piggyback JSONL line events on that same channel instead of re-fetching the file.

### 5. Infrastructure Status — `InfrastructurePage.tsx:188`
- **Interval:** 10s
- **Fetches:** 6 parallel API calls (machines, harnesses, sprites, launchers, applications, dispatch targets)
- **Replace with:** Push infrastructure state changes. Launcher connect/disconnect already goes through `/ws/launcher` — just forward those events to admin clients.

### 6. Wiggum Runs — `WiggumPage.tsx:137,315` + `WiggumRunsPanel.tsx:60`
- **Interval:** 5s (3 separate polls)
- **Fetches:** Run status, iterations, screenshots, exit codes
- **Replace with:** Push run progress events from server. The server orchestrates runs and knows when state changes.

## Admin Polling — Lower Priority / Harder to Replace

### 7. Git Status — `GitChangesView.tsx:60` + `SidebarFilesDrawer.tsx:238`
- **Interval:** 10s
- **Fetches:** Branch name, file modifications, staged/unstaged counts
- **Why harder:** Git changes happen on the filesystem. Would need `fs.watch` or inotify on the server side. Polling is reasonable here.
- **Suggestion:** Keep polling but increase interval to 30s, or only poll when the git panel is visible.

### 8. JSONL File List — `GlobalTerminalPanel.tsx:107` + `LeafPane.tsx:137`
- **Interval:** 10s
- **Fetches:** List of JSONL files for a session (detects continuations/subagents)
- **Why harder:** File creation events need fs.watch. Could piggyback on session state changes if the server tracked JSONL file creation.
- **Suggestion:** Keep polling or add a "new JSONL file" event to the session WebSocket.

## Admin Polling — Keep As-Is

### 9. Auto-Jump Countdown — `sessions.ts:593-611`
- **Interval:** 1s (3-second countdown timer)
- **Reason:** This is a UI countdown, not data fetching. No replacement needed.

### 10. Auto-Fix Status — `autofix.ts:36-149`
- **Mechanism:** Single `setTimeout` with exponential backoff
- **Reason:** One-shot check after session init, not ongoing polling.

## Widget Polling — All Fine

| Pattern | File | Reason to Keep |
|---------|------|---------------|
| WebSocket reconnect | session.ts | Already push-based, backoff is correct |
| Element wait/poll | session.ts | DOM polling, no server alternative |
| Screenshot countdown | widget.ts, screenshot.ts | UI timer, not data |
| Cursor fade | input-events.ts | UI timer |
| Scroll/hover throttle | voice-recorder.ts | Event debouncing |
| Trigger dwell | widget.ts | UI timer |

## Recommended Approach

**Phase 1 — Admin WebSocket channel** (biggest bang for buck):
- Add a general `/ws/admin` WebSocket that pushes:
  - Session list changes (replaces #1, #2, #3)
  - Infrastructure state changes (replaces #5)
  - Wiggum run progress (replaces #6)
- This single WebSocket eliminates ~10 of 15 polling instances.

**Phase 2 — JSONL streaming**:
- Extend the existing agent-session WebSocket to push JSONL lines as they arrive (replaces #4).
- Add "new file" events for JSONL file detection (replaces #8).

**Phase 3 — Git status** (optional):
- Add `fs.watch` on `.git` directory to push git status changes.
- Or just increase polling interval since it's low-frequency data.

## Polling Heat Map

```
Every 1s:  [auto-jump countdown] — UI timer, keep
Every 3s:  [JSONL messages] — REPLACE
Every 5s:  [sessions] [live-connections×2] [wiggum×3] — REPLACE ALL
Every 10s: [git×2] [jsonl-files×2] [infrastructure] — REPLACE infra, keep/reduce git+jsonl-files
Every 30s: [sessions-hidden] — goes away when sessions polling is replaced
```

**Total API calls saved per minute (active tab):** ~26 calls/min eliminated
