# ProPanes Admin UI - Pane/Panel/Tab Architecture

## Overview

The ProPanes admin UI uses a sophisticated **hybrid layout system** combining:
1. **Tree-based panes** (persistent split layout stored in localStorage)
2. **Floating popout panels** (floating windows with docking)
3. **Companion tabs** (secondary views like JSONL, feedback, iframe alongside main sessions)
4. **Right pane split** (optional right column for secondary sessions/companions)

---

## 1. PANE TREE SYSTEM (packages/admin/src/lib/pane-tree.ts)

### Core Data Structure

```typescript
// Binary tree where leaves contain tabs
type PaneNode = SplitNode | LeafNode

interface SplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  ratio: number                           // 0-1, first child gets this proportion
  children: [PaneNode, PaneNode]          // exactly 2 children
}

interface LeafNode {
  type: 'leaf'
  id: string
  panelType: 'tabs' | 'sidebar'
  tabs: string[]                          // tab IDs like "session-123" or "jsonl:session-123"
  activeTabId: string | null
  singleton?: boolean                     // well-known leaves (sidebar, page, sessions)
  collapsed?: boolean                     // when collapsed, shows as edge tab in parent split
  collapsedOffset?: number                // pixel offset when collapsed
}

interface LayoutTree {
  root: PaneNode
  focusedLeafId: string | null
}
```

### Tab ID Format

Tabs are identified by a `type:identifier` format:
- Session tabs: `"session-123-abc..."` (raw session ID)
- Companion tabs: `"jsonl:session-123"`, `"feedback:session-123"`, `"iframe:session-123"`, etc.
- View tabs: `"view:nav"`, `"view:feedback"`, `"view:sessions-list"`, etc.

### Key Leaf IDs (Well-Known)

- `SIDEBAR_LEAF_ID = 'sidebar-leaf'` - Left sidebar (navigation)
- `PAGE_LEAF_ID = 'page-leaf'` - Main content area (feedback list, aggregate view, etc.)
- `SESSIONS_LEAF_ID = 'sessions-leaf'` - Agent session tabs (originally hidden, appears when sessions open)

### Default Layout Structure

```
root-split (horizontal, 15% left / 85% right)
├─ sidebar-split (vertical)
│  ├─ sidebar-leaf (nav tabs, singleton)
│  └─ sidebar-split-lower (vertical, 45% top / 55% bottom)
│     ├─ sidebar-sessions (sessions list, singleton)
│     └─ sidebar-bottom (vertical, 50/50)
│        ├─ sidebar-terminals (terminals, singleton)
│        └─ sidebar-files (file tree, singleton)
└─ content-split (vertical, top/bottom)
   ├─ page-leaf (main view, singleton)
   └─ sessions-leaf (agent tabs, grows as sessions open)
```

### Tree Mutation API

All mutations are **immutable** - they clone the tree, mutate the clone, then commit via signal:

```typescript
// Splitting
splitLeaf(leafId, direction, newPosition, newTabs?, ratio?, moveActiveTab?)
splitLeafAtPosition(leafId, position, newTabs?, ratio?, moveActiveTab?)

// Merging
mergeLeaf(leafId)  // removes leaf, promotes sibling

// Tab management
addTabToLeaf(leafId, tabId, activate?)
removeTabFromLeaf(leafId, tabId, autoMerge?)
moveTab(fromLeafId, toLeafId, tabId)
setActiveTab(leafId, tabId)
replaceTabInLeaf(leafId, oldTabId, newTabId)
reorderTabInLeaf(leafId, tabId, insertBeforeTabId?)

// Collapse/expand
toggleLeafCollapsed(leafId)
setLeafCollapsed(leafId, collapsed)
collapseLeafToEdge(leafId, edge)  // edge: 'N'|'S'|'E'|'W'
setLeafCollapsedOffset(leafId, offset)

// Split ratio (divider position)
setSplitRatio(splitId, ratio, containerSizePx?)
```

### Immutability & Batching

```typescript
// Debounced via requestAnimationFrame
function batch(fn: () => void)
// Multiple mutations in the same frame coalesce into one signal update

// Tree gets committed via RAF-debounced signal
layoutTree.value = updatedTree

// Persists to localStorage after commit
function persist() { saveTree(tree) }
```

### Cascading Resize (Smart Divider Dragging)

When you drag a divider in a nested split hierarchy:
1. Adjacent pane (closest to divider) absorbs size change first
2. Once adjacent pane hits minimum, far pane starts shrinking
3. Cascades through nested same-direction splits so dragging feels like one continuous track
4. `MIN_LEAF_PX = 60px`, `COLLAPSED_LEAF_PX = 28px`

---

## 2. COMPANION TABS SYSTEM (packages/admin/src/lib/companion-state.ts)

### Types

```typescript
type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url' | 'file' | 'wiggum-runs' | 'artifact'

// Tab ID: "<type>:<sessionId>"
function companionTabId(sessionId, type): string
function extractCompanionType(tabId): CompanionType | null
function extractSessionFromTab(tabId): string | null
```

### Per-Session Companion Registry

```typescript
sessionCompanions = signal<Record<string, CompanionType[]>>()
// Example: { "sess-123": ["jsonl", "feedback", "iframe"] }

terminalCompanionMap = signal<Record<string, string>>()
// Maps parent session → child terminal session (1:1)
// Example: { "agent-sess-123": "terminal-child-456" }
```

### Companion Sibling Logic

When opening a companion, the system tries to find a "companion sibling":
- Search the sibling leaf of the session's leaf
- If sibling is empty OR contains only companions (from any session), reuse it
- Otherwise, create a new split

This coalesces all companions into one pane instead of spawning a new split per session.

```typescript
function findCompanionSibling(sessionLeafId, sessionId): LeafNode | null
// Returns sibling if it's all-companions or empty
```

### Opening Companions

```typescript
toggleCompanion(sessionId, type, position?)
// position?: 'left' | 'right' | 'above' | 'below'

// Toggles ON:
//   - Mark companion as open in sessionCompanions
//   - Find/create companion tab: "jsonl:session-123"
//   - Add tab to sibling leaf or create new split
//   - Activate the tab

// Toggles OFF:
//   - Remove from sessionCompanions
//   - Remove companion tab from leaf
//   - Auto-merge empty non-well-known leaves
//   - Remove from right pane if present
```

---

## 3. POPOUT PANEL SYSTEM (packages/admin/src/lib/popout-state.ts)

### Panel State

```typescript
interface PopoutPanelState {
  id: string
  sessionIds: string[]                  // multiple sessions per panel
  activeSessionId: string
  
  // Floating state
  docked: boolean
  visible: boolean
  floatingRect: { x, y, w, h }
  
  // Docked state
  dockedHeight: number
  dockedWidth: number
  dockedTopOffset?: number
  dockedSide?: 'left' | 'right'
  
  // Split pane inside panel (optional)
  splitEnabled?: boolean
  splitRatio?: number
  rightPaneTabs?: string[]
  rightPaneActiveId?: string | null
  
  // Visual
  minimized?: boolean
  maximized?: boolean
  preMaximizeRect?: { x, y, w, h }
  alwaysOnTop?: boolean
  grabY?: number
  
  // Internal
  autoOpened?: boolean
  splitCollapsed?: boolean
  splitCollapsedOffset?: number
  splitEdge?: 'N'|'S'|'E'|'W'
}

popoutPanels = signal<PopoutPanelState[]>()
focusedPanelId = signal<string | null>()
panelZOrders = signal<Map<string, number>>()
```

### Panel Lifecycle

```typescript
// Find/update
findPanelForSession(sessionId)
updatePanel(panelId, partial)
removePanel(panelId)

// Z-order management
bringToFront(panelId)
getPanelZIndex(panelId)

// Docking/floating
togglePanelDocked(panelId)
toggleAlwaysOnTop(panelId)

// Special panels
AUTOJUMP_PANEL_ID = 'p-autojump'   // auto-opened waiting sessions
COS_PANEL_ID = 'p-cos'              // center-of-screen mode
```

### Auto-Jump Panel (AUTOJUMP_PANEL_ID)

Floating panel that auto-opens when sessions wait for input:
- Can be docked to left/right or float
- Per-session dimension memory (so switching sessions restores their panel size/position)
- Survives session transitions via `saveAutoJumpDimsForActiveSession()` + `applyAutoJumpDimsForSession()`

---

## 4. SESSION STATE & RIGHT PANE SPLIT (packages/admin/src/lib/session-state.ts)

### Session Tab Registry

```typescript
openTabs = signal<string[]>()           // all open session IDs
activeTabId = signal<string | null>()   // currently active session

// Right pane (optional split column for secondary sessions/companions)
splitEnabled = signal(false)
rightPaneTabs = signal<string[]>()      // tabs in right column
rightPaneActiveId = signal<string | null>()
splitRatio = signal(0.5)
```

### Session Input State

```typescript
sessionInputStates = signal<Map<string, InputState>>()
// InputState: 'waiting' | 'interrupted' | 'delayed'
// Maps sessions that are blocked waiting for user input
```

---

## 5. COMPONENT HIERARCHY

### PaneTree.tsx
Root component that renders the entire pane tree recursively.
```typescript
export function PaneTree({ node: PaneNode }) {
  if (node.type === 'leaf') return <LeafPane leaf={node} />
  return <SplitPane direction={node.direction} ...>
    <PaneTree node={node.children[0]} />
    <PaneTree node={node.children[1]} />
  </SplitPane>
}
```

### SplitPane.tsx
Container that renders two children with a draggable divider.
- Handles horizontal/vertical splits
- Drag events update split ratio
- Cascading resize logic
- Fixed-size mode for sidebar (pixel-based instead of ratio)

```typescript
interface SplitPaneProps {
  direction: 'horizontal' | 'vertical'
  ratio: number
  splitId: string
  onRatioChange: (splitId, ratio, containerSizePx?) => void
  fixedFirstSize?: number          // for sidebar
  onFixedResize?: (newSize) => void
  firstCollapsed?: boolean
  secondCollapsed?: boolean
  hideSecond?: boolean             // for empty sessions-leaf
}
```

### LeafPane.tsx
Renders a single leaf with tab bar + active tab content.

**Key Pattern: Lazy Tab Rendering**
- Only mount the ACTIVE tab component
- Inactive tabs are not rendered (not display:none, completely unmounted)
- This prevents creating multiple xterm.js instances which would freeze the browser
- `tabs.filter(sid => sid === activeTabId).map(...)` not `tabs.map(...)`

```typescript
// Render content - ONLY active tab mounted
{leaf.tabs
  .filter(tabId => tabId === leaf.activeTabId)
  .map(tabId => renderTabContent(tabId))}
```

### PaneContent.tsx
Router that renders different content based on tab type:
- View tabs: `view:nav`, `view:feedback`, etc. → pages/views
- Session tabs: session ID → AgentTerminal
- Companion tabs: `jsonl:`, `feedback:`, `iframe:`, etc. → companion viewers

### GlobalTerminalPanel.tsx
Container for the main pane tree + popout panels + right split pane.
- Renders PaneTree for left/center
- Renders PopoutPanel instances (floating/docked)
- Renders right pane if split enabled
- Manages drag-and-drop between panes

### PopoutPanel.tsx
Floating/docked panel with titlebar, tab bar, session tabs inside.
- Can have its own split pane (right column)
- Supports floating, docked-left, docked-right
- Maximization, minimization, always-on-top
- Titlebar with action menu (close, dock, pin, etc.)

### AgentTerminal.tsx
Renders a single agent session terminal using xterm.js.
- Each instance: one WebSocket + one PTY
- Only mounted when tab is active
- `data-session-id` attribute for focus management

---

## 6. KEY INTERACTIONS & PATTERNS

### Opening a Session

```
openSession(sessionId)
  ├─ Check if already in a popout panel → activate there
  ├─ Check if already in pane tree → setActiveTab
  ├─ Otherwise:
  │  ├─ ensureSessionsLeaf()  // create sessions leaf if missing
  │  ├─ addTabToLeaf(sessions-leaf, sessionId)
  │  └─ Auto-open JSONL companion for headless sessions
  └─ Auto-navigate to feedback if enabled
```

### Splitting a Leaf

```
splitLeaf(leafId, direction, newPosition, newTabs)
  ├─ Clone tree
  ├─ Create newLeaf with newTabs
  ├─ Create newSplit with (oldLeaf, newLeaf)
  ├─ Replace oldLeaf with newSplit in tree
  └─ commitTree() → signal update + persist
```

### Dragging a Tab

```
startTabDrag(tabId, fromLeafId)
  ├─ Show ghost image
  ├─ On dragover leaf → highlight drop zone
  ├─ On drop:
  │  ├─ If dropping on popout panel → popOutTab
  │  ├─ If dropping on another leaf → moveTab
  │  └─ If dropping in empty space → openPanelExternally (new popout)
  └─ Cleanup ghost
```

### Pop Out to Panel

```
popOutTab(sessionId, leafId, position?)
  ├─ removeTabFromLeaf(leafId, sessionId)
  ├─ Create new PopoutPanelState
  ├─ Add to popoutPanels signal
  └─ persistPopoutState()
```

### Companion Toggle

```
toggleCompanion(sessionId, 'jsonl')
  ├─ If OFF: remove from sessionCompanions, remove tab from leaf
  ├─ If ON:
  │  ├─ Add to sessionCompanions
  │  ├─ Find companion sibling (reuse if exists)
  │  ├─ If sibling exists: addTabToLeaf(sibling, companionTab)
  │  └─ Otherwise: splitLeaf(..., [companionTab])
  └─ persistCompanions()
```

---

## 7. PERSISTENCE

### LocalStorage Keys

```
'pw-layout-tree'               // LayoutTree JSON
'pw-session-companions'        // Record<sessionId, CompanionType[]>
'pw-terminal-companion-map'    // Record<sessionId, childSessionId>
'pw-popout-panels'             // PopoutPanelState[]
'pw-pane-mru'                  // PaneMruEntry[] (most-recently-used)
'pw-autojump-session-dims'     // AutoJumpSessionDims per session
'pw-docked-orientation'        // 'vertical' | 'horizontal'
'pw-panel-state'               // { sidebarWidth, panelMinimized, ... }
'pw-tabs'                      // { openTabs, activeTabId, ... }
'pw-split-state'               // { splitEnabled, rightPaneTabs, ... }
```

### Auto-Save Pattern

- Signal subscriptions trigger persist functions
- RAF debouncing coalesces multiple mutations
- `batch()` defers signal updates until all mutations complete

---

## 8. MIGRATION & COMPATIBILITY

### Historical Migrations

1. **`'sidebar'` → `'tabs'` panelType** - All panels now use tabs model
2. **`'view:page'` → `'view:feedback'`** - Page view renamed
3. **Sessions list moved to separate leaf** - Not colocated with nav
4. **Singleton flag enforcement** - Well-known leaves marked as singleton
5. **ControlBar removal** - Was in tree, now fixed top bar

---

## 9. NATIVE PORTING CONSIDERATIONS

### Data Model (Straightforward Port)

The tree/panel/companion data structures are **pure TypeScript**:
- No DOM dependencies
- Signal-based reactivity → easily replace with SwiftUI `@State`, React hooks, or native state management
- Persist same to UserDefaults/file system

### Rendering (React → SwiftUI/UIKit Pattern)

**Current Preact Pattern:**
```tsx
<SplitPane direction={node.direction} ratio={ratio}>
  <PaneTree node={child1} />  {/* recursive */}
  <PaneTree node={child2} />
</SplitPane>
```

**Native Pattern:**
```swift
// SwiftUI
@State var layoutTree: PaneNode

var body: some View {
  renderPaneNode(layoutTree)
}

func renderPaneNode(_ node: PaneNode) -> some View {
  switch node {
  case let .split(split):
    HStack(spacing: 0) {
      renderPaneNode(split.children[0])
      Divider().frame(width: 4)  // or custom drag divider
      renderPaneNode(split.children[1])
    }
  case let .leaf(leaf):
    TabContainer(leaf)
  }
}
```

### Dragging & Resizing

Current: `onMouseDown` listener → compute ratio from mouse position

Native: UIDragInteraction / NSView.mouseDragged → same ratio math

### xterm.js → Native Terminal View

Current: each AgentTerminal mounts xterm.js in a div

Native: SwiftUI `TerminalView` or UIView wrapper around PTY library (e.g., `SwiftTerminal`)

### Popout Windows

Current: FloatingPanel positioned absolutely with CSS transforms

Native: 
- macOS: NSWindowController / SwiftUI window group
- iOS: Floating popover / split view controller (iPadOS)
- Windows: separate WinUI windows

---

## 10. EXAMPLE: SPLIT → SESSION → COMPANION FLOW

```
1. User clicks "split right" on session leaf
   ├─ splitLeaf(sessionLeafId, 'horizontal', 'second', [])
   └─ New empty leaf created to the right

2. User opens JSONL companion on session
   ├─ toggleCompanion(sessionId, 'jsonl')
   ├─ findCompanionSibling(sessionLeafId) → finds the split we just made
   ├─ addTabToLeaf(companionLeafId, 'jsonl:sessionId')
   └─ LeafPane renders both "sessionId" and "jsonl:sessionId" tabs

3. User clicks "pop out" on session tab
   ├─ popOutTab(sessionId, sessionLeafId)
   ├─ removeTabFromLeaf(sessionLeafId, sessionId)
   ├─ Create PopoutPanelState with sessionIds=[sessionId]
   ├─ Add to popoutPanels signal
   ├─ GlobalTerminalPanel now renders PopoutPanel + original leaf (now with just jsonl:sessionId)
   └─ Both views (pane + popout) share the same companion state via sessionCompanions
```

---

## 11. KEY MENTAL MODELS

1. **Tree is immutable** - every mutation clones, modifies, commits
2. **Tab invariant** - a tab lives in exactly one leaf at a time
3. **Well-known leaves** - certain leaves (sidebar, page) are special and never merge away
4. **Companion sibling coalescing** - all companions of all sessions share one leaf if possible
5. **Lazy rendering** - only active tab is mounted to avoid xterm.js explosion
6. **Z-order via signals** - popout panels track MRU via panelZOrders map
7. **Dual input state** - session tabs in main pane AND session copies in popout panels can exist simultaneously
8. **Cascading resize** - nested splits act like one continuous track when divider is dragged
9. **Local-first** - tree/state fully persisted to localStorage, survives refresh/reload
10. **Batching for perf** - RAF debouncing coalesces signal updates within a frame
