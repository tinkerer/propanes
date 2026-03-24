# Prompt Widget Admin Terminal Panel Architecture

## Overview
The admin package has a sophisticated multi-panel terminal system with:
- **Global Terminal Panel** - Fixed bottom panel with tab bar (main container)
- **Popout Panels** - Floating or docked right-edge panels supporting multiple sessions per panel
- **Tab Dragging** - Drag-to-reorder, drag-to-popout, drag-to-panel operations
- **Panel Focus & Navigation** - Keyboard shortcuts for switching between panels
- **State Management** - Preact signals for reactive state persistence to localStorage

---

## 1. Global Terminal Panel (GlobalTerminalPanel.tsx)

### Structure
- Fixed bottom container with resizable height
- Horizontal tab bar with scrollable tabs
- Active session renderer below tabs
- Collapse/minimize button

### Key Signals (from sessions.ts)
```
openTabs: string[]                    // Session IDs in global tab bar
activeTabId: string | null            // Currently active session
panelMinimized: boolean               // Minimize state
panelHeight: number                   // Height in px
exitedSessions: Set<string>           // Sessions that have exited
waitingSessions: Set<string>          // Sessions waiting for input
focusedPanelId: 'global' | string    // Which panel has focus ring
```

### Behavior
1. **Tab Badge System**: Shows numbered access (Ctrl+Shift+1-9)
   - When holding Ctrl+Shift, badges appear on status dots
   - Shows pending digit prefix in green
   - Dimmed for unreachable tabs

2. **Status Menu**: Click status dot to open context menu
   - Kill session (Ctrl+Shift+K)
   - Resolve session (Ctrl+Shift+R) - kills + marks feedback resolved
   - Resume exited session
   - Close tab (Ctrl+Shift+W)

3. **Resizing**: Drag top edge to resize panel height
   - Auto-expands when resizing minimized panel
   - Persists height to localStorage

4. **Tab Dragging**: Mouse down on tab triggers drag
   - Creates ghost element following cursor
   - Detects drop targets (other panels or "null" for popout)
   - Shows reorder indicator if hovering same panel's tab bar
   - On drop: calls appropriate action

5. **View Mode**: Dropdown to switch terminal/structured/split views
   - Stored per-session in viewModes signal

6. **Hotkey Indicator**: Shows kill/resolve/close shortcuts when Ctrl+Shift held
   - Positioned relative to active status dot
   - Auto-hides when held keys released

---

## 2. Popout Panels (PopoutPanel.tsx)

### PopoutPanelState Interface
```typescript
interface PopoutPanelState {
  id: string                         // Unique panel ID (p-RANDOM)
  sessionIds: string[]               // Sessions in this panel
  activeSessionId: string            // Currently active session
  docked: boolean                    // Is docked to right edge?
  visible: boolean                   // Show or hide panel
  floatingRect: { x, y, w, h }      // Position/size when floating
  dockedHeight: number               // Height when docked
  dockedWidth: number                // Width when docked
  dockedTopOffset?: number           // Top offset for stacking
  minimized?: boolean                // Minimized state (floating only)
}
```

### Architecture
- **Multiple Floating Windows**: Can create many independent floating panels
- **Docked Right Edge**: Panels can dock to right, stacked vertically or horizontally
- **Grab Handles**: Left-edge handles for docked panels (resize drag or click to toggle visibility)
- **Tab Bars**: Multi-session panels show horizontal tabs

### Docked Orientation
```typescript
type DockedOrientation = 'vertical' | 'horizontal'
```
- **Vertical**: Stacked top-to-bottom, each gets proportional height
- **Horizontal**: Proportional widths (used with orientation = 'horizontal')

### Dragging Behavior

#### Header Drag (onHeaderDragStart)
- Click & hold panel header to move
- Floating panels: smooth snap to grid (EDGE_SNAP=8px) with visual guides
- Docked panels: drag left to undock (UNDOCK_THRESHOLD=40px)
  - When dragged >40px left, converts to floating with preserved dimensions
  - Snap threshold 20px triggers auto-dock when dragged near right edge

#### Resize Handles
- **Floating**: 8 handles (n, s, e, w, ne, nw, se, sw)
  - Each handle can independently resize in its direction
  - Minimum size: 300x200px

- **Docked**: Only 3 handles (n, s, w) because right edge is fixed
  - Top/bottom resize changes panel height
  - Left resize changes panel width (moves content left)
  - Top resize respects panel's dockedTopOffset (prevents overlapping previous panel)

#### Snap Guides
- During floating panel drag: EDGE_SNAP alignment guides appear
- Snaps panel edges to:
  - Window edges (0, innerWidth, innerHeight)
  - Other floating panels' edges
- Visual feedback: blue vertical/horizontal lines (`.snap-guide`)

### Multi-Tab Panels
- Tabs are horizontal bar within header
- Each tab shows session label + close button (×)
- Tab styling distinguishes active/inactive
- Tab drag enables reordering within panel or moving to another panel

### Focus Ring
- `panel-focused` class adds glowing border (2px #6366f1)
- Auto-hides after 2 seconds with `setFocusedPanel(null)`
- Applied when switching panels with Ctrl+Shift+Tab

### Visibility Toggle
- Grab handle quick-click (no drag movement) toggles `visible` property
- Hidden panels show only the grab handle (collapsed state)
- Click handle again to reveal panel

---

## 3. Tab Drag System (tab-drag.ts)

### Drag Flow
1. **Start**: Mouse down on tab (not on close button or status dot)
2. **Threshold**: Need 6px movement to start drag (prevents accidental drag on click)
3. **Ghost Creation**: Creates `.tab-drag-ghost` element following cursor
4. **Drop Detection**: Uses `elementsFromPoint(x, y)` to find targets

### Drop Target Detection
```typescript
type DropTarget = 
  | { type: 'panel'; panelId: string }   // Another panel's tab bar
  | { type: 'main' }                     // Global tab bar
  | null                                 // Empty space = create new panel
```

- Scans DOM at cursor position, excludes ghost & reorder indicator
- Looks for `[data-panel-id]` to identify popout panels
- Looks for `.terminal-tab-bar` to identify global tab bar

### Reorder Indicator
- Only shows when hovering **same panel's tab bar**
- Compares cursor X against tab midpoints
- Vertical line (.`tab-reorder-indicator`) marks insertion point
- Inserts before tab if cursor left of midpoint, appends if right of last tab

### Drop Actions

#### From Global Tab
- **Drop on other panel**: `moveSessionToPanel(sessionId, targetPanelId)`
  - Removes from global tabs
  - Adds to target panel's sessionIds
  - Sets as active in target

- **Drop on main**: Already in main, ignores
- **Drop on empty space**: `popOutTab(sessionId)`
  - Creates new panel (docked, 400x500 default)
  - Removes from global tabs

#### From Popout Panel
- **Drop on main**: `popBackIn(sessionId)`
  - Removes from source panel
  - Adds to global openTabs
  - Deletes source panel if empty

- **Drop on other panel**: `moveSessionToPanel(sessionId, targetPanelId)`
  - Same as above (moves between panels)

- **Drop on empty space + had reorder indicator**: Do nothing (same panel reorder)
- **Drop on empty space + no reorder**: `splitFromPanel(sessionId)`
  - Creates new panel with just this session
  - Removes from source panel

### Visual Feedback
- **Ghost Element**: Follows cursor with opacity 0.9
- **will-drop**: Border turns green when over valid drop target
- **drop-target**: Target gets green highlight/box-shadow
- **tab-dragging**: Source tab dims to 30% opacity

---

## 4. Session State Management (sessions.ts)

### Core Signals
```typescript
// Tab bar state
openTabs: signal<string[]>           // Session IDs in global tabs
activeTabId: signal<string | null>   // Current active session
panelMinimized: boolean              // Global panel minimize state
panelHeight: number                  // Global panel height

// Popout state
popoutPanels: signal<PopoutPanelState[]>  // All floating/docked panels
snapGuides: signal<{x?, y?}[]>            // Snap alignment guides
dockedOrientation: signal<'vertical' | 'horizontal'>

// Session metadata
exitedSessions: signal<Set<string>>     // Sessions that have ended
viewModes: signal<Record<string, ViewMode>>  // View mode per session
waitingSessions: signal<Set<string>>    // Sessions waiting for input
focusedPanelId: signal<string | null>  // Current focus ring target
pendingFirstDigit: signal<number | null> // For Ctrl+Shift+1-9 multi-digit access

// Other
allSessions: signal<AgentSession[]>     // All sessions from server
panelPresets: signal<PanelPreset[]>     // Saved panel configurations
```

### Persistence
```typescript
persistTabs()          // Saves openTabs, activeTabId, exitedSessions
persistPanelState()    // Saves panelHeight, panelMinimized
persistPopoutState()   // Saves popoutPanels[] to localStorage
```

Each saves to `localStorage` with keys like `pw-open-tabs`, `pw-popout-panels`, etc.

### Key Functions

#### Tab Ordering
```typescript
reorderGlobalTab(sessionId, insertBeforeId)
reorderTabInPanel(panelId, sessionId, insertBeforeId)
```
- Remove session from array
- Insert before insertBeforeId or append if null
- Update signal and persist

#### Panel Operations
```typescript
popOutTab(sessionId)           // Create new docked panel OR make existing visible
popBackIn(sessionId)           // Move session back to global tabs
moveSessionToPanel(sessionId, targetPanelId)  // Move between panels
splitFromPanel(sessionId)      // Create new panel from session in existing panel
updatePanel(panelId, updates)  // Merge partial updates
removePanel(panelId)           // Delete panel entirely
```

#### Docked Panel Layout
```typescript
getDockedPanelTop(panelId): number
```
- Calculates vertical position by summing heights of previous panels
- Accounts for dockedTopOffset
- Called when rendering popout panels to set CSS position

#### Session Navigation
```typescript
openSession(sessionId)         // Add to global tabs + activate
closeTab(sessionId)            // Remove from tabs or panel, cleanup
```

#### Tab Numbering
```typescript
allNumberedSessions(): string[]     // Global tabs + all panel sessions (ordered)
handleTabDigit(digit: 1-9)          // Activate tab by number
handleTabDigit0()                   // Toggle popout visibility
```
- Supports 2-digit access: press 1 then 2 = tab 12
- First digit pending for 500ms
- Clears on timeout or second digit

#### Multi-Digit Tab Access
```typescript
pendingFirstDigit: signal<number | null>
```
- When user presses Ctrl+Shift+1:
  - activateGlobalSession(allNumberedSessions(), 1)
  - Set pendingFirstDigit = 1
  - Start 500ms timer
- If another digit pressed within 500ms:
  - Combined = 10 + digit = 11-19 (for 2-digit tabs)
  - If time expires, clear pending

---

## 5. Agent Terminal Component (AgentTerminal.tsx)

### Purpose
Renders xterm.js terminal for a single session's PTY output

### Props
```typescript
sessionId: string              // Server session ID
isActive?: boolean             // Is this the active tab (affects resizing)
onExit?: (exitCode) => void   // Callback when session exits
onWaitingChange?: (waiting) => void  // Callback for input wait state
```

### WebSocket Protocol
- Connects to `/ws/agent-session?sessionId=...&token=...`
- **Sequenced Protocol** (new):
  - `sequenced_output`: Server sends seq, client acks with `output_ack`
  - `sequenced_input`: Client sends seq, server acks with `input_ack`
  - Deduplication by seq number
  - Pending inputs retransmitted on reconnect

- **Legacy Protocol** (fallback):
  - `history`, `output`, `exit` messages

### Features

#### Mouse Mode Tracking
- Parses ANSI CSI sequences to detect mouse mode (9, 1000, 1002, 1003)
- Tracks SGR encoding (DECSET 1006)
- **Injects manual mousemove events** when mode 1003 (any-event)
  - xterm.js doesn't reliably send moves without button held
  - Needed for tmux popup menu hover highlights

#### Terminal Response Filtering
- Removes DA1/DA2/DSR responses before sending to PTY
- Prevents junk in PTY input on reconnect after timeout

#### Resize Handling
- ResizeObserver monitors container changes
- Calls `safeFitAndResize()` on change
- Bounces size (rows-1, then rows) on macOS to force SIGWINCH
- Fits and repositions on tab activation

#### Reconnection Logic
- Max 10 attempts with exponential backoff (1s → 30s cap)
- On failure after max attempts: manual retry button
- Replays pending inputs + requests output replay

#### Connection States
- **Waiting indicator**: Pulsing status dot when input/file operation active
- **Exit detection**: Transitions to exited state, disables input
- **Auto-reconnect**: Transparent to user unless >10 failures

---

## 6. Layout Component (Layout.tsx)

### Root Container Structure
```
<div class="layout">
  <div class="sidebar">
    <!-- App navigation, settings, sessions drawer -->
  </div>
  <div class="sidebar-edge-handle"> <!-- Resize handle -->
  <div class="main">
    <!-- Page content -->
  </div>
  <GlobalTerminalPanel />  <!-- Bottom fixed panel -->
  <PopoutPanel />          <!-- Floating/docked panels -->
</div>
```

### Main Area Bottom Padding
- Adds `paddingBottom` to account for terminal panel height
- Calculated from `panelMinimized ? 66px : panelHeight`
- Prevents content overlap

### Sidebar Sessions Drawer
- Fixed height, resizable via drag handle
- Shows all sessions with filtering/search
- Status dots for quick context menu
- Sorting: open tabs first, then by status (running > pending > completed)

### Keyboard Shortcuts (Registered in Layout)
```
?                   → Show keyboard help modal
t                   → Toggle theme
Escape              → Close modals
Ctrl+Shift+Space    → Spotlight search
Cmd+K               → Spotlight search (Mac)
Ctrl+\              → Toggle sidebar
`                   → Toggle terminal panel minimize
Ctrl+Shift+`        → Toggle terminal panel minimize
g + f               → Go to Feedback page
g + a               → Go to Agents page
g + g               → Go to Aggregate page
g + s               → Go to Sessions page
g + l               → Go to Live page
g + p               → Go to Preferences page
Ctrl+Shift+↑/↓      → Cycle app pages
Ctrl+Shift+←/→      → Cycle session tabs
g + t               → New terminal
Ctrl+Shift+0-9      → Switch to tab (0=toggle popout)
Ctrl+Shift+W        → Close popup/tab
Ctrl+Shift+_        → Toggle pop out / dock active
Ctrl+Shift++        → New terminal
Ctrl+Shift+Tab      → Cycle panel focus
Ctrl+Shift+|        → Toggle docked orientation
Ctrl+Shift+R        → Resolve active session
Ctrl+Shift+K        → Kill active session
```

---

## 7. CSS Architecture (app.css)

### Colors
```
--pw-terminal-bg: #1e293b          (dark slate)
--pw-terminal-border: #334155      (darker slate)
--pw-terminal-text-dim: #64748b    (gray)
--pw-primary: #6366f1              (indigo)
```

### Layout Principles

#### Global Terminal Panel
```css
.global-terminal-panel {
  position: fixed;
  bottom: 0;
  right: 0;
  z-index: 900;
  flex-direction: column;
  height: computed dynamically
}
.terminal-resize-handle { height: 4px; cursor: ns-resize; }
.terminal-tab-bar { height: 32px; flex-shrink: 0; }
.terminal-tabs { flex: 1; overflow-x: auto; }
.terminal-active-header { flex-shrink: 0; }
.terminal-body { flex: 1; overflow: hidden; }
```

#### Tab Styling
```css
.terminal-tab {
  display: flex;
  padding: 4px 10px;
  border-radius: 4px 4px 0 0;    /* Top rounded, bottom sharp */
  transition: all 0.15s;
}
.terminal-tab.active {
  background: #334155;
  box-shadow: inset 0 -2px 0 #6366f1;  /* Bottom accent line */
}
.terminal-tab .status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;            /* Green = running */
}
.terminal-tab .status-dot.exited { background: #64748b; }
.terminal-tab .status-dot.waiting {
  animation: pulse-green 1.5s infinite;
}
```

#### Floating Panels
```css
.popout-floating {
  position: fixed;
  z-index: 950;
  border: 2px solid #6366f1;
  border-radius: 8px;
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.3), 
              0 8px 32px rgba(0, 0, 0, 0.5);
  flex-direction: column;
}
```

#### Docked Panels
```css
.popout-docked {
  position: fixed;
  right: 0;
  border-radius: 8px 0 0 8px;     /* Left rounded, right straight */
  border-right: none;             /* Flush to edge */
  z-index: 950;
}
.popout-grab-tab {
  position: fixed;
  width: 20px;
  border-radius: 8px 0 0 8px;
  cursor: ew-resize;
  z-index: 951;                   /* Higher than panel */
}
```

#### Drag Feedback
```css
.tab-drag-ghost {
  position: fixed;
  z-index: 10000;
  padding: 4px 12px;
  border: 2px solid #6366f1;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.tab-drag-ghost.will-drop {
  border-color: #22c55e;          /* Green when dropping */
  box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3);
}

.terminal-tab-bar.drop-target {
  box-shadow: inset 0 -2px 0 #22c55e;  /* Bottom green line */
}
[data-panel-id].drop-target {
  box-shadow: 0 0 0 2px #22c55e;       /* Green outline */
}

.tab-reorder-indicator {
  position: fixed;
  width: 2px;
  background: #6366f1;
  z-index: 10001;
  box-shadow: 0 0 4px rgba(99, 102, 241, 0.6);
}

.snap-guide {
  position: fixed;
  background: #6366f1;
  opacity: 0.5;
  z-index: 9999;
}
```

#### Resize Handles
```css
.popout-resize-n { top: -2px; height: 4px; cursor: ns-resize; }
.popout-resize-e { right: -2px; width: 4px; cursor: ew-resize; }
.popout-resize-ne { top: -2px; right: -2px; width: 8px; height: 8px; cursor: nesw-resize; }
```

#### Focus Ring
```css
.panel-focused {
  box-shadow: 0 0 0 2px #6366f1, 
              0 0 12px rgba(99, 102, 241, 0.4) !important;
  transition: box-shadow 0.2s ease;
}
```

### Z-Index Hierarchy
```
10001   tab-reorder-indicator
10000   status-dot-menu, tab-drag-ghost
9999    snap-guide
951     popout-grab-tab
950     popout-floating, popout-docked
900     global-terminal-panel
```

---

## Key Interactions Summary

### User Action → System Response

| Action | Handler | Result |
|--------|---------|--------|
| Click tab in global bar | openSession(id) | Activate tab, highlight it |
| Drag tab slowly | startTabDrag() | Ghost follows, no-op on release |
| Drag tab >6px | startTabDrag() + drag | Ghost + drop detection |
| Drop on panel | moveSessionToPanel() | Tab moves to panel |
| Drop in void | popOutTab() | New docked panel created |
| Drop on main | popBackIn() | Tab moves to global bar |
| Drag floating panel header | onHeaderDragStart() | Snap guides, floating rect updates |
| Drag floating >40px left | → docked conversion | Floats to docked, dimensions preserved |
| Drag docked >20px right | → auto-dock | Snaps to right edge |
| Drag panel top edge | onResizeStart('n') | Height shrinks up |
| Double-click floating header | updatePanel({minimized}) | Toggle minimize |
| Click grab handle (docked) | (no drag) | toggle visibility |
| Drag grab handle | onGrabMouseDown() | Adjust dockedWidth |
| Ctrl+Shift+0 | handleTabDigit(0) | togglePopoutVisibility() |
| Ctrl+Shift+1 | handleTabDigit(1) | activateGlobalSession(1) |
| Ctrl+Shift+1 then 2 | handleTabDigit(2) | activateGlobalSession(12) |
| Click status dot | Open menu | Kill/Resolve/Resume options |
| Ctrl+Shift while holding | Show badges | Tab numbers visible |
| Hold Ctrl+Shift+K | Kill menu | Context menu visible |
| Ctrl+Shift+Tab | cyclePanelFocus(1) | Next panel gets focus ring |
| Ctrl+Shift+\| | toggleDockedOrientation() | Vertical ↔ Horizontal |

---

## State Flow Diagram

```
User Action (drag, click, key)
    ↓
HTML Event (mousedown, mousemove, mouseup)
    ↓
Component Handler / Tab-drag.ts
    ↓
sessions.ts Signal Updates
    ↓
localStorage.setItem()
    ↓
Preact Re-render (via signals)
    ↓
Visual Update (DOM, CSS classes)
```

### Example: Drag Tab to Popout
```
mousedown on tab
  → startTabDrag() called
    → store initial position
    → setup mousemove/mouseup listeners

mousemove 6px+
  → dragging = true
  → createGhost() (adds DOM element)
  → updateGhost(x, y)
  → dropTarget = detectDropTarget()
  → highlightTarget(dropTarget)

mouseup
  → remove listeners, ghost, classes
  → if (no dragging) onClickFallback()
  → if (dropTarget.type === 'main') popOutTab(sessionId)
    → openTabs.value = filtered
    → activeTabId.value = sessionId (if was active)
    → popoutPanels.value.push(new panel)
    → persistTabs()
    → persistPopoutState()
    → nudgeResize() (dispatch resize events)
    
Signal change triggers Preact re-render:
  → GlobalTerminalPanel updates openTabs display
  → PopoutPanel appears with new panel
```

---

## Notable Edge Cases

1. **Docked Panel Height Overflow**: 
   - dockedTopOffset prevents top resize from pushing above topmost position
   - Calculated relative to getDockedPanelTop baseline

2. **Bouncing SIGWINCH on macOS**:
   - TIOCSWINSZ skips SIGWINCH if size unchanged
   - safeFitAndResize sends rows-1 first, then correct size

3. **Mouse Mode 1003 without Button Handling**:
   - xterm.js doesn't emit mousemove events when no button held
   - Manually inject SGR mouse events on mousemove for hover support

4. **Sidebar Divider Between Tabbed/Non-Tabbed**:
   - Visual divider inserted to separate open tabs from other sessions
   - Helps with visual grouping

5. **Panel Preset Restoration**:
   - Saves/restores entire panel configuration
   - Preserves all geometry, visibility states, active sessions

6. **Exited Session Handling**:
   - Session stays in openTabs but marked as exited
   - Button state changes to "Resume" (calls resumeSession API)
   - Creates new session with new ID

7. **Waiting State Animation**:
   - Pulsing green dot + "waiting" class on status dot
   - Indicates agent is waiting for stdin/file operation

---

## Files & Dependencies

**Core Components**:
- `/packages/admin/src/components/GlobalTerminalPanel.tsx` - 362 lines
- `/packages/admin/src/components/PopoutPanel.tsx` - 534 lines
- `/packages/admin/src/components/AgentTerminal.tsx` - 432 lines
- `/packages/admin/src/components/Layout.tsx` - 812 lines

**Supporting**:
- `/packages/admin/src/lib/tab-drag.ts` - 228 lines (drag & drop logic)
- `/packages/admin/src/lib/sessions.ts` - 820 lines (state management)
- `/packages/admin/src/lib/shortcuts.ts` - Keyboard shortcut registration
- `/packages/admin/src/lib/settings.ts` - Theme, tab display settings
- `/packages/admin/src/lib/state.js` - Navigation, app selection

**Styles**:
- `/packages/admin/src/app.css` - ~4,400 lines
  - Lines 2000-2350: Global terminal panel
  - Lines 4000-4350: Popout panels, drag feedback, snap guides

**External**:
- `@preact/signals` - Reactive state management
- `@xterm/xterm` & `@xterm/addon-fit` - Terminal emulator
- `preact/hooks` - useEffect, useRef, etc.

