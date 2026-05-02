# Pane Layout & Popout System

This directory implements two parallel layout hierarchies for organizing pane content: the **in-page pane tree** (LeafPane, PaneTree, SplitPane) and the **floating popout window system** (PopoutPanel + helpers). Both systems support tabbed containers, splits, collapsing, and drag-to-reorganize.

## Purpose

The pane system manages the main application layout: resizable, splittable panes containing tabs of sessions, views, and companions. The popout subsystem allows users to tear out tabs and panes into floating or docked panels that persist across page navigations. A bottom dock (GlobalTerminalPanel) provides quick access to terminal sessions as a separate, collapsible panel.

Key responsibilities:
- **Render** a hierarchical pane tree as a nested split-pane layout (LeafPane → PaneTree → SplitPane)
- **Persist** layout state and window positions to localStorage
- **Lazy-mount** active tabs only (strict rule: never mount inactive tabs with `display:none`)
- **Drag-and-drop** tabs and panes across the system (including pop-in/pop-out)
- **Hotkey shortcuts** for session control, popout management, docking, and minimize/maximize
- **Sync companion panes** (JSONL, feedback, terminal, iframe) when the active tab changes

## Two Pane Systems

### In-Page Pane Tree
Lives in the main app DOM alongside the sidebar. Consists of a binary split tree:
- **LeafPane**: (LeafPane.tsx:791) renders a leaf node containing tabs, or collapsed/empty states
- **SplitPane**: (SplitPane.tsx:26) wraps two children with a draggable divider (ratio-based or fixed first child for sidebar)
- **PaneTree**: (PaneTree.tsx:12) recurses through the tree to assemble splits and leaves
- **GlobalTerminalPanel**: (GlobalTerminalPanel.tsx:535) fixed bottom dock displaying sessions and companions with split mode

State storage: `layoutTree` in `lib/pane-tree.ts` (in-memory `signal`), persisted to localStorage via `persistPanelState` (in `lib/sessions.ts`).

### Popout Window System
Independent floating/docked panels that can hold multiple tabs and companion splits. Each panel is a `PopoutPanelState`:
- **PopoutPanel**: (PopoutPanel.tsx:418) renders all visible popout panels + snap guides
- **PanelView**: (PopoutPanel.tsx:59) wraps a single popout panel; manages dragging, resizing, and split mode
- **PopoutSingletonBar** / **PopoutMultiTabBar**: (PopoutSingletonBar.tsx:26 / PopoutMultiTabBar.tsx:35) tab bar + header for single or multi-tab panels
- **PopoutSplitPane**: (PopoutSplitPane.tsx:26) split mode for popout panels (main + companion panes)
- **DockedPanelGrabHandle**: (PopoutGrabHandle.tsx:22) visible edge handle for docked panels (click to toggle, drag to resize)

State storage: `popoutPanels` signal in `lib/sessions.ts`, persisted to localStorage via `persistPopoutState`.

**Key difference**: In-page leaves are immutable (controlled by pane-tree.ts); popout panels are direct `updatePanel` mutations. Popout panels can dock to left/right edges or float freely. Docked panels share fixed sidebar width; floating panels have absolute positioning.

## Component Map

| File | Role | Key Exports | Parent |
|------|------|-------------|--------|
| **LeafPane.tsx** | In-page tab container with split/collapse UI | `LeafPane` (791) | PaneTree |
| **PaneTree.tsx** | Recursive pane tree renderer | `PaneTree` (12) | Layout.tsx |
| **SplitPane.tsx** | Generic horizontal/vertical split with draggable divider | `SplitPane` (26) | PaneTree |
| **GlobalTerminalPanel.tsx** | Bottom dock with split-view companion support | `GlobalTerminalPanel` (535) | Layout.tsx |
| **PopoutPanel.tsx** | Root renderer for all popout panels (floating + docked grab handles) | `PopoutPanel` (418) | Layout.tsx |
| **PanelView** (PopoutPanel.tsx:59) | Single popout panel wrapper; drag/resize/hotkey handlers | — | PopoutPanel |
| **PopoutSingletonBar.tsx** | Single-tab header (id label, controls, window menu) | `PopoutSingletonBar` (26) | PanelView |
| **PopoutMultiTabBar.tsx** | Multi-tab bar + session header (tab list, id label, controls) | `PopoutMultiTabBar` (35) | PanelView |
| **PopoutSplitPane.tsx** | Popout split pane with main + companion | `PopoutSplitPane` (26) | PanelView |
| **PopoutPaneHeader.tsx** | Companion pane header (for JSONL, feedback, terminal, etc. tabs) | `PopoutPaneHeader` (19) | PopoutSplitPane |
| **PopoutGrabHandle.tsx** | Docked panel edge handle (visible when docked, drag/click behavior) | `DockedPanelGrabHandle` (22) | PopoutPanel |
| **PopoutResizeHandles.tsx** | 8-direction resize borders for floating panels (4-6 edges for docked) | `PopoutResizeHandles` (5) | PanelView |
| **PopoutPanelContent.tsx** | Helper components: PanelTabBadge, tabLabel, companionCopyId, IdDropdownMenu, WindowMenu | — | PopoutMultiTabBar, PopoutSingletonBar, PopoutSplitPane |
| **PopoutPanelMenus.tsx** | Status-dot menu and Ctrl+Shift hotkey menu | `PopoutStatusMenu`, `PopoutHotkeyMenu` (26, 98) | PopoutPanel |
| **PaneContent.tsx** | Renders tab content (session, view, or companion frame) | `renderTabContent` (41) | LeafPane, GlobalTerminalPanel, PanelView, PopoutSplitPane |
| **popout-signals.ts** | Shared signal state (menu open flags, rename state) | popoutIdMenuOpen, popoutWindowMenuOpen, popoutStatusMenuOpen, popoutHotkeyMenuOpen, renamingSessionId, renameValue, companionMenuOpen | PopoutPanel and child components |
| **usePopoutPanelHotkeys.ts** | Keyboard shortcuts for popout menus + Ctrl+Shift overlay | `usePopoutPanelHotkeys` (36) | PopoutPanel |

## State Model

### Pane Tree State (lib/pane-tree.ts)
- **layoutTree**: Preact signal holding the in-page pane tree root (binary SplitNode or LeafNode)
- **commitTree()**: RAF-debounced function that writes layout to localStorage (batches rapid changes)
- **setSplitRatio(), splitLeaf(), mergeLeaf(), setActiveTab()** etc.: Mutate layoutTree and call commitTree
- **focusedLeafId**: Which leaf has keyboard focus (used to highlight borders and dispatch Ctrl+Shift)

**Leaves are immutable within a render**: changes flow through action functions (setActiveTab, splitLeaf) that mutate the signal, triggering re-renders.

### Popout Panel State (lib/sessions.ts)
- **popoutPanels**: Preact signal array of `PopoutPanelState` objects
- **updatePanel(panelId, patch)**: Direct mutation of panel state (merge-update)
- **persistPopoutState()**: Serializes popoutPanels array to localStorage; called after every state change
- **getDockedPanelTop()**, **getPanelZIndex()**: Compute positions/z-orders of docked panels at render time

**Docked panels auto-position**: N/S edges (top 40px) split available height; left edge uses fixed sidebar width; right docks stacked vertically or horizontally based on `dockedOrientation` signal.

### Companion State
- **Companion tabs** (jsonl:, feedback:, terminal:, iframe:, artifact:, etc.) are tracked as sessionIds in popout panels
- **syncPanelCompanions()**: When active session changes, auto-switch the companion tab to match (e.g., if a session gets a new terminal companion, the panel's right pane auto-navigates to it)
- **splitRatio / splitEdge / splitCollapsed**: PopoutPanelState tracks split geometry; in-page leaves use layoutTree

### Refresh & Debounce
- **layoutTree commits**: RAF-debounced via commitTree; doesn't block renders
- **Popout updates**: Synchronous, persisted immediately (smaller state, no RAF needed)

## Tab Rendering Rule: Strict Lazy Mount

**Critical invariant**: Only the active tab per container is mounted as DOM. **Never use `display:none` for inactive tabs.**

### Where This Matters

**LeafPane.tsx:1427–1429** (in-page):
```typescript
{leaf.tabs.filter((sid) => sid === leaf.activeTabId).map((sid) =>
  renderTabContent(sid, true, sessionMap, ...)
)}
```
Only the active tab is passed to `renderTabContent`. Inactive tabs are never mounted.

**GlobalTerminalPanel.tsx:973, 1000, 1062** (bottom dock):
```typescript
{tabs.filter((sid) => sid === activeId).map((sid) => renderTabContent(sid, true, ...))}
// Left pane:
{leftTabs.filter((sid) => sid === activeId).map((sid) => renderTabContent(sid, true, ...))}
// Right pane (companion):
{rightTabs.filter((sid) => sid === rightActive).map((sid) => renderTabContent(sid, true, ...))}
```

**PopoutSplitPane.tsx:106, 215** (popout split):
```typescript
{leftTabs.filter((sid) => sid === activeId).map((sid) => renderTabContent(sid, true, sessionMap))}
{activeCompanionId && renderTabContent(activeCompanionId, true, sessionMap)}
```

**PanelView (PopoutPanel.tsx:390)** (popout single-tab):
```typescript
{activeId && renderTabContent(activeId, true, sessionMap)}
```

### Why
- **AgentTerminal** is expensive to mount (WebSocket, event listeners, state machine)
- Mounting multiple AgentTerminal instances **freezes Chrome** due to event handler overhead
- Each container (pane, panel, split pane) can only safely show one session's terminal at a time
- Users switch tabs frequently; lazy mount makes switching instant (unmount old, mount new)

**Enforcement**: Never render inactive tabs with `display:none` or `opacity:0`. Always filter the tab array before mapping.

## Hotkeys

**usePopoutPanelHotkeys.ts:36** wires up all popout panel keyboard shortcuts:

### ID Menu (popoutIdMenuOpen, lines 67–133)
Open via session id label click or via Ctrl+Shift hotkey menu. Shortcuts:
- **C**: Copy session ID
- **P**: Pop back in (move tab to a main pane)
- **W**: Open in new window
- **B**: Open in new browser tab
- **J**: Copy JSONL file path
- **L**: Toggle JSONL companion
- **Y**: Toggle summary companion
- **F**: Toggle feedback companion
- **I**: Toggle iframe companion
- **M**: Toggle or create terminal companion

### Window Menu (popoutWindowMenuOpen, lines 136–199)
Open via hamburger button or Ctrl+Shift. Shortcuts:
- **S**: Pop back in active tab
- **W**: Toggle "always on top" pin
- **A**: Toggle dock left (Ctrl+Shift+A shows keyboard hint)
- **D**: Toggle dock right
- **Space**: Minimize/maximize (floating only)
- **M**: Maximize (floating only)

### Ctrl+Shift Hotkey Overlay (popoutHotkeyMenuOpen, lines 202–247)
When Ctrl+Shift is held and a popout panel is focused, a menu appears at the active tab's status dot. Menus:
- **Status dot menu** → K (kill), R (resolve), P (session menu), E (window menu), W (close tab)
- **Pane hamburger menu** (LeafPane.tsx:1258) → toggle split, collapse, pop out (via PopOutSubmenuItem)

### In-Page Pane Hotkeys
- **Ctrl+Shift+'"'** (leaderboard quote): Split right
- **Ctrl+Shift+'-'** (minus): Split down
- **Ctrl+Shift+S**: Enable split in GlobalTerminalPanel

Wired in LeafPane.tsx (split handlers in pane header menu) and GlobalTerminalPanel.tsx (hotkey handler in tabs effect, lines 605–661).

## Gotchas

### RAF Debounce Misfire
**pane-tree.ts commitTree()** is RAF-debounced. If you mutate layoutTree directly (don't), commitTree might batch the changes into a single localStorage write, losing intermediate states. Always use action functions like `setActiveTab()` that call commitTree internally.

**Popout panels** do NOT use RAF debounce — each updatePanel call persists immediately. Risk of localStorage thrashing on rapid drags; mitigated by using `persistPopoutState()` only after drag/resize ends.

### Controller Registration & focusedLeafId
**focusedLeafId** tracks which pane has keyboard focus for Ctrl+Shift overlay and hotkey menus. If you add a new leaf, call `setFocusedLeaf(leafId)` when the user clicks it. Omitting this breaks hotkey positioning (overlay doesn't find the right status dot).

### Cross-Pane Drag Mechanics
Tabs can be **dragged between leaves**, between a leaf and a popout panel, or between popout panels. **tab-drag.ts** (not in this dir) handles the physics:
- **startTabDrag()**: Initiates a drag ghost; sets dropZones
- **dragOverLeafZone**: Signal tracks which leaf zone the drag is over (tab insert, v-split, h-split, popout)
- **drop**: Calls `reorderTabInLeaf()`, `splitLeaf()`, `popOutTab()`, or `popBackIn()` depending on zone

Edges of leaves show diagonal drop zones during drag to trigger splits. Popout panel grab handles show "drop to pop out" overlay.

### Companion vs. Agent Terminal Tabs
- **Companion terminals** ("terminal:sessionId") are auto-created when a user clicks the "M" hotkey on a regular session
- **Agent terminals** ("pw-sessionId") are regular sessions that run shell commands
- **getTerminalCompanion()** returns the agent terminal paired with a session (stored in terminalCompanionMap)
- When a session's active terminal changes, **syncPanelCompanions()** auto-switches the panel's right pane to the new terminal tab
- **termPickerOpen** signal + **TerminalPicker** component (in pickers/) let users create or reassign terminals

### Popout Panel Docking
**Left dock** (dockedSide='left'): Fixed width, uses sidebar width; appears to the right of sidebar.
**Right dock** (dockedSide='right'): Fixed width, shares right edge; multiple panels stack vertically (horizontal orientation) or side-by-side (vertical).
**Floating**: Absolute positioning; can be minimized (header bar only) or maximized (full window minus 40px top).

**dockedOrientation** signal determines how right-docked panels stack. Set via window resizing heuristics or user options (look for toggleDockedOrientation calls in sessions.ts).

### Sidebar Collapse & Panel Width
When sidebar collapses, **sidebarWidth** is still set but a visual "collapsed" style hides it. Left-docked panels reposition to account for sidebar width change:
- **PopoutPanel.tsx:100**: `left: sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3)`
- **GlobalTerminalPanel.tsx:836**: `left: sidebarWidth + (sidebarCollapsed ? 0 : 3)`

The `+ 3` is a 3px gap for the collapse button hover area.

### SplitPane Fixed First Child
**SplitPane.tsx:13** prop **fixedFirstSize**: If set, the first child uses fixed px width/height instead of flex ratio. Used for the sidebar (which resizes to a pixel size, not a ratio). **onFixedResize** callback updates the pixel size; ratio is ignored.

### Singleton Views
Certain tabs are "singletons" — only one instance allowed per leaf. Examples: "view:sessions-list", "view:files". When opening a singleton, if it's already open in another leaf, that leaf activates instead of duplicating. Logic in LeafPane.tsx (getTabLabel, getSingletonMeta).

### Collapsed Edge Handles
When a leaf is collapsed, it appears as a thin handle on the parent split's edge (W, E, N, or S depending on parent direction and child position). Dragging along the edge **repositions** the handle; dragging perpendicular to the edge **expands** it. Click with no drag = toggle expanded. Same mechanic for popout split panes (PopoutSplitPane.tsx:111–129).

### Always-On-Top Zindex
**PopoutPanel** uses `panelZOrders` signal to track z-order. **alwaysOnTop** flag moves a panel's z-index above others. **bringToFront()** updates z-order when a panel is clicked. toggleAlwaysOnTop in usePopoutPanelHotkeys (line 148).

