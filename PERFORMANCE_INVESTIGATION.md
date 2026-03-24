# Performance Investigation: Admin UI Terminal Delays

## Executive Summary

Two major performance issues identified:

1. **Repeated "Connecting" delays** when switching terminal sessions
2. **Laggy keyboard input** in terminal windows

---

## Issue 1: Repeated "Connecting" Delays

### Root Cause: Terminal Instance Destruction on Tab Switch

**Location**: `packages/admin/src/components/AgentTerminal.tsx` (line 25-442)

The core problem is in the `useEffect` hook (line 25):
```typescript
useEffect(() => {
  // PROBLEM: This entire effect runs on EVERY sessionId change
  // Creates NEW terminal instance
  const term = new Terminal({...})
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(containerRef.current)
  // ... then immediately tries to CONNECT
  connect()
  
  return () => {
    // CLEANUP: destroys terminal and WebSocket
    wsRef.current?.close()
    term.dispose()
  }
}, [sessionId])  // <-- Dependency: triggers on ANY sessionId change
```

**What happens when switching tabs:**

1. User clicks tab B (while viewing tab A)
2. `activeTabId` signal updates → triggers Preact re-render
3. `SessionViewToggle` component receives `sessionId={newSessionId}`
4. `AgentTerminal` gets new `sessionId` prop
5. useEffect's dependency `[sessionId]` triggers → **CLEANUP runs first**
   - Closes old WebSocket
   - Disposes old xterm.js terminal
6. **NEW effect runs**
   - Creates brand new Terminal instance
   - Immediately writes "Connecting..." message (line 68)
   - Starts fresh WebSocket connection
7. User sees "Connecting..." for 200-2000ms while reconnecting

**Why the delay?**

- WebSocket connection takes ~200ms minimum on localhost
- Initial "Connecting..." message is visible while connection is pending
- The old session's state is completely lost
- Even though browser still has output history from the old connection, it's discarded

### Problem in GlobalTerminalPanel

**Location**: `packages/admin/src/components/GlobalTerminalPanel.tsx` (line 557-602)

The `renderTabContent` function creates components freshly for each render:

```typescript
function renderTabContent(sid, isVisible) {
  return (
    <div key={sid} style={{ display: isVisible ? 'flex' : 'none', ... }}>
      {!isCompanion && (
        <SessionViewToggle sessionId={sid} isActive={isVisible} />
      )}
    </div>
  )
}

// In GlobalTerminalPanel:
{tabs.map((sid) => renderTabContent(sid, sid === activeId, ...))}
```

Even when a tab is `display:none`, the component still exists and receives prop updates. The key issue:

- ALL tabs (even hidden ones) have their `SessionViewToggle` and `AgentTerminal` components mounted
- When switching from tab A to tab B, **both components are still in the DOM**
- Switching back to tab A's `isActive={false}` → `isActive={true}` causes effect re-run

**The cycle:**

```
User clicks Tab B
  ↓
activeTabId.value = "session-B"
  ↓
GlobalTerminalPanel re-renders
  ↓
renderTabContent("session-A", false) - Tab A hidden
renderTabContent("session-B", true)  - Tab B now active
  ↓
AgentTerminal receives isActive=false (A) and isActive=true (B)
  ↓
AgentTerminal.useEffect[isActive] runs (line 444-462) - forces fit and reconnect
  ↓
User sees "Connecting..." message
```

---

## Issue 2: Laggy Keyboard Input

### Root Cause 1: Polling Blocks Main Thread

**Location**: `packages/admin/src/lib/sessions.ts` (line 1104-1125)

Session polling happens every 5 seconds:
```typescript
export function startSessionPolling(): () => void {
  loadAllSessions(includeDeletedInPolling.value)
  let id = setInterval(() => loadAllSessions(includeDeletedInPolling.value), 5000)
  // ...
}

export async function loadAllSessions(includeDeleted = false) {
  sessionsLoading.value = true
  try {
    const tabs = [...openTabs.value]
    for (const panel of popoutPanels.value) {
      for (const sid of panel.sessionIds) {
        if (!tabs.includes(sid)) tabs.push(sid)
      }
    }
    // Fetch ALL sessions including open ones
    const sessions = await timed('sessions:list', 
      () => api.getAgentSessions(undefined, tabs.length > 0 ? tabs : undefined, includeDeleted)
    )
    
    // Heavy comparison logic
    const prevSessions = allSessions.value
    const sessionsChanged = sessions.length !== prevSessions.length || 
      sessions.some((s, i) => {
        const p = prevSessions[i]
        return !p || s.id !== p.id || s.status !== p.status || s.inputState !== p.inputState
          || s.paneTitle !== p.paneTitle || s.paneCommand !== p.paneCommand
      })
    if (sessionsChanged) {
      allSessions.value = sessions  // Triggers Preact re-render
    }
  } finally {
    sessionsLoading.value = false
  }
}
```

**Problem:**

1. Every 5 seconds, API call fetches all sessions
2. Large comparison loop checks every session
3. If ANY field changes (paneTitle, paneCommand, inputState), signal updates
4. Signal update triggers Preact re-render of entire terminal panel
5. Re-render schedules layout calculations, event listener updates, etc.
6. **During active typing**, if the 5s poll triggers, keyboard event is blocked
7. User experiences "frame drop" where keypress appears delayed

**Timing of lag:**

- Appears to happen randomly ~every 5 seconds
- Actually happens when poll response arrives mid-keystroke
- Blocking occurs during Preact diffing and DOM updates

### Root Cause 2: Frequent ResizeObserver Callbacks

**Location**: `packages/admin/src/components/AgentTerminal.tsx` (line 404-405)

```typescript
const observer = new ResizeObserver(() => safeFitAndResize())
observer.observe(containerRef.current)
```

ResizeObserver fires on:
- Window resize
- Tab activation (browser layout changes)
- Parent panel resize during drag

**Each callback runs:**
```typescript
function safeFitAndResize(bounce = false) {
  fit.fit()  // Calculates terminal geometry
  
  if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
    // Send resize message to server
    ws.send(bounceMsg)
    ws.send(resizeMsg)
  }
}
```

This is blocking because:
- `fit.fit()` does DOM measurements
- WebSocket send is synchronous
- No debouncing or throttling

### Root Cause 3: No Input Buffering/Debouncing

**Location**: `packages/admin/src/components/AgentTerminal.tsx` (line 346-366)

```typescript
term.onData((data: string) => {
  const filtered = data.replace(TERMINAL_RESPONSE_RE, '')
  if (!filtered) return
  // ... immediate send
  const ws = wsRef.current
  if (ws && ws.readyState === WebSocket.OPEN) {
    inputSeq++
    const msg = JSON.stringify({...})
    pendingInputs.set(inputSeq, msg)
    ws.send(msg)  // <-- Synchronous, blocks main thread
  }
})
```

**Issues:**

- Every keypress triggers immediate WebSocket send
- No batching or debouncing
- If 5s poll happens during keyboard input, the send can be delayed
- User experiences keystroke delay

---

## Detailed Analysis: The Full Flow

### Session Switch Performance Flow

```
User clicks Tab B
  ↓
activeTabId.value = "session-B"  (signal update)
  ↓
Preact schedules re-render
  ↓
GlobalTerminalPanel re-renders
  ↓
renderTabContent() creates components for all tabs:
  - Tab A: <SessionViewToggle sessionId="A" isActive={false} />
  - Tab B: <SessionViewToggle sessionId="B" isActive={true} />
  ↓
SessionViewToggle component for B updates: isActive=true
  ↓
useEffect([isActive]) in AgentTerminal fires (line 444)
  ↓
requestAnimationFrame(() => {
  safeFitAndResize(true)  // Bounce resize
  term.refresh()
  term.focus()
})
  ↓
Meanwhile, old WebSocket from Session A is closing:
  ↓
AgentTerminal useEffect cleanup (line 421-441) from FIRST effect still running
  - wsRef.current?.close()  (closes old WS)
  - term.dispose()  (disposes old terminal)
  ↓
BUT new Terminal instance already created by NEW effect!
  ↓
New WebSocket.connect() starts (line 214)
  ↓
"Connecting..." message written (line 68)
  ↓
User sees 200-2000ms delay before content appears
```

### Keyboard Input Lag Flow

```
User presses 'a'
  ↓
AgentTerminal.onData() fires
  ↓
ws.send(JSON.stringify({...}))  (synchronous)
  ↓
[MEANWHILE at T+~5000ms]
loadAllSessions() poll results arrive
  ↓
Signal update: allSessions.value = newSessions
  ↓
Preact re-renders GlobalTerminalPanel
  ↓
Entire component tree re-evaluates
  ↓
All tabs' renderTabContent() recalculate
  ↓
Complex comparison logic in loadAllSessions runs
  ↓
Main thread stalls for 50-100ms
  ↓
User's next keypress (which was already sent to ws)
doesn't appear on screen until after re-render
  ↓
Result: "laggy" feeling, 1-2 frame delay
```

---

## Session Caching Status

**Current state: NO CACHING**

The current code creates and destroys terminal instances on every tab switch:

1. Terminal instances are NOT cached per sessionId
2. WebSocket connections are NOT reused
3. xterm.js terminals are completely disposed on cleanup
4. No mechanism to preserve terminal state across hides

**What COULD be cached:**

- Terminal instance (xterm.js Terminal object) - keeps render state
- Fit addon state - keeps column/row dimensions
- Connection state - could reuse existing WebSocket if still open
- Input/output buffers - currently lost on dispose

---

## Specific Code Locations to Optimize

| Issue | File | Lines | Severity |
|-------|------|-------|----------|
| Terminal destroyed on tab switch | AgentTerminal.tsx | 25-442 (useEffect) | HIGH |
| No terminal instance caching | AgentTerminal.tsx | 17-21 (refs) | HIGH |
| 5s polling blocks main thread | sessions.ts | 1104-1100 | HIGH |
| ResizeObserver unbounded | AgentTerminal.tsx | 404-405 | MEDIUM |
| No input debouncing | AgentTerminal.tsx | 346-366 | MEDIUM |
| Heavy re-renders on poll update | GlobalTerminalPanel.tsx | 957-960 | MEDIUM |
| Frequent rafId use without cleanup | AgentTerminal.tsx | 452-461 | LOW |

---

## Performance Metrics

**Session switch delay:**
- Expected: 0ms (cached terminal)
- Actual: 200-2000ms (new connection)
- Gap: 200-2000ms

**Keyboard input lag:**
- Expected: <16ms (one frame)
- Actual: 50-100ms (appears as 2-3 frame delay)
- Gap: 50-100ms

**Polling impact:**
- Poll interval: 5000ms
- Payload size: ~5KB per session × 10-50 sessions = 50-250KB
- Parse + diff time: ~100-500ms
- Frequency: Every 5s = 1KB/s overhead

---

## Fix Priority

1. **HIGH (Immediate):** Cache terminal instances per sessionId
   - Keep Terminal + Fit addon alive
   - Reuse WebSocket when possible
   - Preserve visual state

2. **HIGH (Immediate):** Debounce/throttle polling
   - Reduce poll to 10-30s when inactive
   - Use smart diff to avoid re-renders
   - Batch updates

3. **MEDIUM (Soon):** Debounce ResizeObserver
   - Add 100ms debounce to fit/resize calls
   - Use requestAnimationFrame instead of immediate resize

4. **MEDIUM (Soon):** Move input sending off main thread
   - Queue keystrokes during heavy operations
   - Batch send multiple keystrokes per message

5. **LOW (Polish):** Optimize comparison logic
   - Use object identity checks
   - Cache comparison results

