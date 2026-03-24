# Prompt Widget Admin Codebase - Deep Exploration Analysis

## 1. Sessions Page Architecture (SessionsPage.tsx)

### Purpose
Displays a list of all agent sessions with filtering, sorting, and lifecycle controls. It's a standalone page that shows session cards with status indicators, metadata, and action buttons.

### Key Components
- **Session List**: Renders session cards with status, agent/feedback info, timing, and action buttons
- **Filtering**: Status filter dropdown (running, pending, completed, failed, killed, deleted)
- **Sorting**: Sessions sorted by status priority then by recency
- **Agent/Feedback Maps**: Maps agent IDs to names and feedback IDs to titles for display

### Data Flow
1. `loadMaps()` - Loads feedback titles and agent names from API
2. `loadAllSessions(true)` - Fetches all sessions including deleted ones
3. Sessions are filtered by:
   - App ID (if viewing scoped sessions)
   - Status (unless viewing deleted)
4. Sessions sorted by:
   - Status priority: running > pending > completed/failed/killed
   - Recency: newer first

### Key Features
- **Auto-terminal**: `autoTerminal=1` parameter spawns a terminal on page load
- **Session Opening**: `openSession()` attaches to running sessions or views completed ones
- **Archive/Delete**: Two-tier deletion (archive vs permanent)
- **Feedback Integration**: Links to related feedback items

---

## 2. Sidebar Session List with "Waiting for Input" Section (Layout.tsx)

### Location in Sidebar
The sidebar contains a collapsible "Sessions" drawer with:
- Running count badge
- **"Waiting for input" count badge** ← Key feature
- Session list organized into sections

### Rendering Logic (Lines 814-834)

```
waitingList = filtered.filter(s => 
  s.status === 'running' && 
  sessionInputStates.value.get(s.id) === 'waiting'
)
restList = all other sessions

RENDER ORDER:
1. If waitingList.length > 0:
   - "Waiting for input ({waitingList.length})" header (sidebar-section-label)
   - All waiting sessions
   - Divider
2. All other sessions
```

### Status Dot Behavior
Each session item shows a colored dot with:
- Base color: running (green dot) | pending (yellow) | completed (blue) | failed/killed (red)
- **Input state overlay**: When `inputState === 'waiting'`, dot gets `waiting` CSS class
  - Also shows in header: `{waitingCount > 0 && <span class="sidebar-waiting-badge">...`

### Identification of "Waiting" Sessions
```javascript
// From Layout.tsx lines 466, 760
const waitingCount = sessions.filter((s: any) => 
  s.status === 'running' && 
  sessionInputStates.value.get(s.id) === 'waiting'
).length;

// Check in filter
s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'
```

### Quick Navigation (Line 318-325)
```javascript
registerShortcut({
  sequence: 'g w',  // "Go to Waiting"
  key: 'w',
  label: 'Go to waiting session',
  category: 'Navigation',
  action: () => {
    const waiting = allSessions.value.find((s: any) => 
      s.status === 'running' && 
      sessionInputStates.value.get(s.id) === 'waiting'
    );
    if (waiting) {
      openSession(waiting.id);
      showActionToast('w', 'Waiting', 'var(--pw-success)');
    }
  },
})
```

---

## 3. Tab Switching & Keyboard Shortcuts (shortcuts.ts + Layout.tsx)

### Current Keyboard Shortcut Infrastructure

#### Single Modifiers
```
Ctrl+Shift+0-9    → Switch to tab by number (0 = toggle popout)
Ctrl+Shift+Left   → Previous session tab
Ctrl+Shift+Right  → Next session tab
Ctrl+Shift+P      → Go to previous tab (last used)
Ctrl+Shift+K      → Kill active session
Ctrl+Shift+R      → Resolve active session
Ctrl+Shift+W      → Close tab
Ctrl+Shift+`      → Toggle terminal panel
Ctrl+Shift+|      → Toggle docked orientation
Ctrl+Shift+"      → Toggle split pane
Ctrl+Shift+_      → Toggle popout
Ctrl+Shift++      → New terminal
Ctrl+Shift+Tab    → Cycle panel focus
```

#### Two-Key Sequences (g + ?)
```
g f → Go to Feedback
g a → Go to Agents
g g → Go to Aggregate
g s → Go to Sessions
g l → Go to Live
g p → Go to Preferences
g w → Go to Waiting [IMPORTANT: finds first running session with waiting input state]
g t → New terminal
```

#### Other Shortcuts
```
?     → Show keyboard help
t     → Toggle theme
Space → Escape key (close modal)
Ctrl+Space → Spotlight search
Cmd+K → Spotlight search (Mac)
Ctrl+\ → Toggle sidebar
```

### Shortcut Registration System (shortcuts.ts)

#### Core Structure
```typescript
interface Shortcut {
  key: string;                              // e.g., 'a', 'Enter', 'ArrowLeft'
  code?: string;                            // e.g., 'KeyA', 'Digit1' (matches e.code)
  modifiers?: { ctrl, shift, alt, meta };   // Which modifiers required
  sequence?: string;                        // e.g., "g f" (second key of two-key combo)
  label: string;                            // For help modal
  category: 'Navigation' | 'Panels' | 'General'
  action: () => void;
}
```

#### Registration & Cleanup
- `registerShortcut()` returns cleanup function
- All registered shortcuts in Layout.tsx useEffect cleanup on unmount
- Single global `document.addEventListener('keydown', handleKeyDown, true)` in capture phase

#### Shortcut Matching Logic (handleKeyDown)

**1. Input Focus Handling** (Lines 68-85)
- If input/textarea/contentEditable focused:
  - Allow: Escape, Spotlight (Ctrl+Space, Cmd+K), Panel shortcuts (Ctrl+Shift+digits/etc)
  - Block other shortcuts
  - xterm containers treated as input (don't steal keystrokes from PTY)

**2. Two-Key Sequence Handling** (Lines 88-102)
- If first key of sequence pending:
  - Wait for second key
  - Match against `sequence: "g f"` style shortcuts
  - Clear pending after 1 second timeout

**3. Sequence Starters** (Lines 104-121)
- Detect if key could start a sequence (e.g., "g")
- Prevent default, set pendingSequence timer
- Only if no direct shortcut matches

**4. Direct Shortcut Matching** (Lines 123-133)
- Match against registered shortcuts
- Check: key/code, modifiers, no sequence
- Execute action, preventDefault, stopPropagation

#### Tab Number System (sessions.ts)

**Global Session Numbering**
```javascript
allNumberedSessions() {
  // All tabs in main panel + all tabs in popout panels
  return [...openTabs.value, ...allPanelSessionIds]
}
```

**Tab Digit Handler** (lines 983-1005)
```javascript
handleTabDigit(digit: number) {
  // Supports multi-digit tabs: press 1, then 2 = go to tab 12
  // Or single digit directly
  // Digit 0 = toggle popout visibility
  
  if (pendingFirstDigit !== null) {
    combined = pendingFirstDigit * 10 + digit
    activateGlobalSession(all, combined)
    return
  }
  
  activateGlobalSession(all, digit)
  
  // If sessions >= 10, allow second digit
  if (digit !== 0 && all.length >= digit * 10 + 1) {
    pendingFirstDigit = digit
    // 500ms timeout to complete digit combo
  }
}
```

**Visual Feedback When Ctrl+Shift Held**
- `ctrlShiftHeld` signal tracks Ctrl+Shift state
- Terminal tabs show number badges when held
- Sidebar sessions show number badges when held
- `TabBadge` component shows pending digit in green

---

## 4. GlobalTerminalPanel Component Architecture

### Overall Structure
```
GlobalTerminalPanel
├── Tab bar (if not split)
│   ├── PaneTabBar (main tabs)
│   └── Actions (Split, New, Minimize)
├── Status menus
│   ├── statusMenuOpen (on dot click)
│   └── hotkeyMenuOpen (on Ctrl+Shift hold)
├── Terminal view (not split)
│   └── SessionViewToggle per tab
└── Split view (if enabled)
    ├── Left pane
    │   ├── Tab bar
    │   ├── SessionViewToggle
    │   └── Active terminal
    └── Right pane
        ├── Tab bar
        ├── SessionViewToggle
        └── Active terminal
```

### Tab Bar Rendering (PaneTabBar component)

**Per-Tab Element**:
```jsx
<button class="terminal-tab" onMouseDown={startTabDrag}>
  <span class="status-dot">
    {/* Color: exited, running, etc */}
    {/* Input state class: waiting, idle */}
    {/* If Ctrl+Shift held: show number badge */}
  </span>
  <span>{tabLabel}</span>  {/* Truncated to 24 chars */}
  <span class="tab-close" onClick={closeTab}>&times;</span>
</button>
```

**Status Dot States**:
- Base: `status-dot running|pending|completed|failed|killed|exited`
- Input state: `status-dot ${inputState}` where inputState = 'waiting' | 'idle'
- Number badge: Shows when `ctrlShiftHeld.value && tabNum !== null`

### Waiting Session Visibility in Terminal Panel

1. **Status dot visual**: Gets `waiting` class when `sessionInputStates.value.get(sid) === 'waiting'`
2. **Status menu trigger**: Right-click dot or click while Ctrl+Shift held
3. **Hotkey menu**: Auto-shows when Ctrl+Shift held on active tab
4. **Global shortcuts work**: Can execute kill/resolve/etc on waiting sessions

### Tab Switching Implementation

**Click-Based**:
```javascript
onMouseDown handles drag or single click
Single click → onClickFallback → onActivate(sid)
```

**Keyboard-Based**:
```javascript
Ctrl+Shift+Left/Right  → cycleSessionTab(-1/1)
Ctrl+Shift+0-9         → handleTabDigit(digit)
```

**Arrow Tab Switching** (Layout.tsx, lines 501-526):
```javascript
function cycleSessionTab(dir: number) {
  if (splitEnabled && focusedPanelId === 'split-right') {
    // Cycle right pane tabs
    const idx = rightPaneActiveId.value 
      ? rightPaneTabs.indexOf(rightPaneActiveId.value) 
      : -1;
    const next = rightPaneTabs[(idx + dir + length) % length];
    rightPaneActiveId.value = next;
  } else if (splitEnabled) {
    // Cycle left pane tabs
  } else {
    // Cycle main tabs
  }
}
```

### Split Pane Tab Management

**State Signals**:
- `splitEnabled`: bool
- `rightPaneTabs`: string[] (session IDs in right pane)
- `rightPaneActiveId`: string | null
- `splitRatio`: number (0.2-0.8)
- `leftPaneTabs()`: computed from `openTabs - rightPaneTabs`

**Enable/Disable**:
```javascript
enableSplit(sessionId?) {
  // Move target session to right pane
  rightPaneTabs = [target]
  rightPaneActiveId = target
  activeTabId = last remaining left tab
}

disableSplit() {
  // Merge all back to main panel
  rightPaneTabs = []
  rightPaneActiveId = null
}
```

---

## 5. Session State Management (sessions.ts)

### Core State Signals

**Tab/Panel State**:
```javascript
openTabs = signal<string[]>()           // Main panel tabs
activeTabId = signal<string | null>()   // Active tab in main panel
rightPaneTabs = signal<string[]>()      // Right pane tabs (split mode)
rightPaneActiveId = signal<string | null>()
splitEnabled = signal<boolean>()
splitRatio = signal<number>()           // 0.2-0.8 range
```

**Session Input State** ← CRITICAL
```javascript
type InputState = 'active' | 'idle' | 'waiting'
sessionInputStates = signal<Map<string, InputState>>()

setSessionInputState(sessionId: string, state: InputState) {
  // Store non-active states in map
  // Maps are keyed by session ID
}
```

**Session Loading** (lines 680-704):
```javascript
async function loadAllSessions(includeDeleted = false) {
  const sessions = await api.getAgentSessions(...)
  allSessions.value = sessions
  
  // Update input states from API
  const next = new Map(sessionInputStates.value)
  for (const s of sessions) {
    if (s.inputState && s.inputState !== 'active') {
      next.set(s.id, s.inputState)
    } else {
      next.delete(s.id)
    }
  }
  sessionInputStates.value = next
}
```

### Session Lifecycle Functions

**openSession(sessionId)**:
- Add to openTabs if not present
- Set as activeTabId
- Unminimize panel
- Optionally navigate to feedback (if autoNavigateToFeedback enabled)

**closeTab(sessionId)**:
- Remove from openTabs / rightPaneTabs
- Update activeTabId to neighbor
- Remove from popout panels
- Persist changes

**killSession(sessionId)**:
- API call to kill
- Update status to 'killed'
- Mark as exited
- Close tab

**resumeSession(sessionId)**:
- API call to spawn new session continuing old one
- Replace old ID with new ID in all tab lists
- Remove from exitedSessions

**deleteSession/permanentlyDeleteSession**:
- Archive (soft delete) vs permanent delete
- Close tab after delete

### Data Persistence (localStorage)

```javascript
pw-open-tabs           // Current open tabs
pw-active-tab          // Current active tab
pw-panel-minimized     // Panel state
pw-panel-height        // Panel height
pw-exited-sessions     // Set of exited session IDs
pw-split-enabled       // Split mode on/off
pw-right-pane-tabs     // Right pane tab list
pw-right-pane-active   // Right pane active tab
pw-split-ratio         // Split ratio
pw-popout-panels       // Popout panel definitions
pw-sidebar-width       // Sidebar width
pw-sessions-drawer     // Sessions drawer open/closed
pw-show-resolved       // Show resolved sessions filter
pw-session-status-filters
pw-session-type-filters
pw-session-search-query
pw-sessions-height     // Sessions drawer height
pw-view-modes          // Per-session view mode (terminal/structured/split)
```

---

## 6. Input State Tracking ("Waiting for Input")

### Where Input State Comes From

**WebSocket Messages in AgentTerminal.tsx** (lines 246-248):
```javascript
case 'input_state': {
  onInputStateChange?.(content.state || 'active');
}
```

**Server Signals State Change**:
- Server detects agent waiting for input (bell character, blocked syscall, etc)
- Sends `{ type: 'sequenced_output', content: { kind: 'input_state', state: 'waiting' } }`
- AgentTerminal calls `onInputStateChange('waiting')`

**SessionViewToggle Component** (receives callback):
```javascript
onInputStateChange={(s) => setSessionInputState(sid, s)}
```

**State Storage** (sessions.ts):
```javascript
function setSessionInputState(sessionId: string, state: InputState) {
  const next = new Map(sessionInputStates.value);
  if (state === 'active') {
    next.delete(sessionId);  // Only store non-active
  } else {
    next.set(sessionId, state);
  }
  sessionInputStates.value = next;
}
```

### Display Path

1. **Sidebar**: 
   - Session dot gets `waiting` CSS class if `sessionInputStates.get(id) === 'waiting'`
   - Separate "Waiting for input" section header with count
   
2. **Terminal Tab**:
   - Status dot shows `waiting` class styling
   - Accessible via Ctrl+Shift held to see number badge
   
3. **Quick Navigation**:
   - `g w` shortcut finds and opens first waiting session

### Server-Side Protocol

The server sends input state via WebSocket. Session knows about waiting via one of:
- Bell character detection (Ctrl+G)
- Read syscall blocking
- Agent framework signaling
- (Implementation in server codebase)

---

## 7. Hotkey System Details

### Hotkey Menu Auto-Show (GlobalTerminalPanel.tsx, lines 197-223)

When Ctrl+Shift held:
1. Check `showHotkeyHints.value` setting
2. Find active tab's status dot position
3. Show menu near dot with simplified action labels:
   - `Kill K` (not `Ctrl+Shift+K`)
   - `Resolve R`
   - `Pop out P`
   - `Close tab W`

This is a "mode" where holding Ctrl+Shift shows available single-letter options.

### Menu Positioning
```javascript
const dot = tabsRef.current?.querySelector('.terminal-tab.active .status-dot')
const dotRect = dot.getBoundingClientRect()
const x = Math.max(scrollRect.left, Math.min(dotRect.left, scrollRect.right - 120))
const y = dotRect.bottom + 4
```

Prevents menu from scrolling out of tab bar view.

---

## 8. Component Relationships & Data Flow

```
Layout (top-level)
├─ Shortcut registration (Layout.tsx useEffect)
├─ Sidebar navigation
│  ├─ Sessions drawer
│  │  ├─ "Waiting for input" section (dynamic)
│  │  ├─ Session list
│  │  └─ Each session shows inputState as dot class
│  └─ Filter/search
├─ GlobalTerminalPanel
│  ├─ Tab bar (PaneTabBar)
│  │  └─ Per-tab with status-dot + inputState class
│  ├─ Status menus (triggered by clicking dot)
│  └─ Terminal body
│     └─ SessionViewToggle → AgentTerminal
│        └─ WebSocket → receives input_state → calls onInputStateChange
└─ PopoutPanel (docked/floating panels)
```

**Signal Flow for "Waiting"**:
1. Server sends `input_state: 'waiting'`
2. WebSocket handler calls `onInputStateChange('waiting')`
3. SessionViewToggle calls `setSessionInputState(sid, 'waiting')`
4. `sessionInputStates` map updated
5. Layout/GlobalTerminalPanel components re-render:
   - Sidebar section updates
   - Status dots re-render with `waiting` class
   - Hotkey menu positions/shows
6. Ctrl+Shift held shows tab numbers
7. `g w` shortcut can find waiting sessions

---

## 9. CSS Classes Used

### Session Status Indicators

**Sidebar**:
```css
.session-status-dot.running       /* green */
.session-status-dot.pending       /* yellow */
.session-status-dot.completed     /* blue */
.session-status-dot.failed        /* red */
.session-status-dot.killed        /* red */
.session-status-dot.waiting       /* pulsing? highlight? */
.session-status-dot.idle          /* muted? */
.sidebar-waiting-badge            /* count badge "X waiting" */
.sidebar-section-label.waiting-section-label
```

**Terminal Tabs**:
```css
.status-dot.running|pending|etc
.status-dot.waiting
.status-dot.idle
.tab-number-badge                 /* when Ctrl+Shift held */
.tab-badge-pending                /* first digit highlighted */
.tab-badge-dimmed                 /* subsequent digits muted */
```

---

## 10. Summary of "Waiting for Input" System

### Identification
- Sessions marked by server when waiting for input
- Stored in `sessionInputStates` map keyed by session ID
- Type: `InputState = 'active' | 'idle' | 'waiting'`

### Display Locations
1. **Sidebar header**: Count badge and separate section
2. **Sidebar session dots**: `waiting` CSS class
3. **Terminal tab dots**: `waiting` CSS class (when tab visible)
4. **Hotkey menu**: Accessible when Ctrl+Shift held on any waiting tab

### Navigation
- **`g w` keyboard shortcut**: Finds first running session with `waiting` state
- **Manual**: Click session in "Waiting for input" section
- **Tab switching**: Use Ctrl+Shift+digits to jump to waiting tab by number

### Technical Path
```
Server (detects waiting) 
  → WebSocket input_state message
  → AgentTerminal.onInputStateChange('waiting')
  → setSessionInputState(sid, 'waiting')
  → sessionInputStates map updated
  → Components observe signal, re-render
  → CSS classes applied
  → Visual indicators shown
```

---

## 11. Potential Enhancement Areas

### For Implementing Custom Shortcuts
1. Add new shortcut in Layout.tsx useEffect (line 159+)
2. Use `registerShortcut()` API with:
   - `key` or `code` + `modifiers`
   - `sequence` for two-key combos
   - `category` for help modal grouping
3. Cleanup returned by effect
4. Can access any state signal from closure

### For Waiting Session Features
1. Already tracked in `sessionInputStates` map
2. Already displayed in sidebar with section header
3. Already have `g w` shortcut to navigate
4. Can add more custom shortcuts/displays using signal

### For Tab Switching Improvements
1. Current: number badges + digit shortcuts + arrow keys
2. Tab cycling works per-pane (left, right, or main)
3. Split pane aware (different active IDs per pane)
4. Can hook into `cycleSessionTab()` logic for custom behavior

---

## Files Reference

| File | Purpose |
|------|---------|
| `SessionsPage.tsx` | Sessions list page view |
| `GlobalTerminalPanel.tsx` | Main terminal panel + split panes |
| `Layout.tsx` | Top-level layout + sidebar + shortcut registration |
| `sessions.ts` | Session state signals + lifecycle functions |
| `state.ts` | Global app state (route, auth, app ID) |
| `shortcuts.ts` | Keyboard shortcut system + registry |
| `settings.ts` | User preferences (theme, hotkey hints, etc) |
| `AgentTerminal.tsx` | Terminal emulation (xterm) + WebSocket |
| `SessionViewToggle.tsx` | View mode selector (terminal/structured/split) |

