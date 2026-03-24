# Floating/Popout Panel Architecture Analysis

## Overview
The admin UI uses a sophisticated floating panel system with support for:
- Floating panels with full drag/resize capabilities
- Docked panels (left/right sides with vertical positioning)
- Snap-to-grid alignment guides
- Auto-docking to edges
- Z-ordering and always-on-top functionality
- Split pane support within panels
- Minimization and maximization

---

## 1. PopoutPanel Component (`PopoutPanel.tsx`)

### Entry Point
The `PopoutPanel()` function serves as the main container that renders:
- All floating panels (`PanelView` components)
- All docked panel grab handles (`DockedPanelGrabHandle` components)
- Snap guide visual indicators
- Status menus and keyboard shortcuts

### Key Constants
```
SNAP_THRESHOLD = 20          // Distance to snap panels to screen edges
UNDOCK_THRESHOLD = 40        // Distance to trigger auto-undocking from docked edges
MIN_W = 300                  // Minimum floating panel width
MIN_H = 200                  // Minimum floating panel height
EDGE_SNAP = 8                // Distance to snap edges to other panels
CONTROL_BAR_BOTTOM = 40      // Height of control bar at top
GRAB_HANDLE_H = 48           // Height of docked panel grab handle
```

---

## 2. Panel State Structure (`PopoutPanelState`)

### Key Properties
```typescript
interface PopoutPanelState {
  id: string                           // Unique panel ID
  sessionIds: string[]                 // Tabs open in this panel
  activeSessionId: string              // Currently active tab
  docked: boolean                      // Is it docked (vs floating)?
  visible: boolean                     // Is it hidden?
  floatingRect: { x, y, w, h }         // Position/size when floating
  dockedHeight: number                 // Height when docked
  dockedWidth: number                  // Width when docked
  dockedTopOffset?: number             // Y offset within docked area
  minimized?: boolean                  // Is minimize button clicked?
  dockedSide?: 'left' | 'right'        // Which edge for docking
  grabY?: number                       // Y position of grab handle on docked
  alwaysOnTop?: boolean                // Pin on top of z-order?
  splitEnabled?: boolean               // Is split pane enabled?
  splitRatio?: number                  // Left/right pane ratio
  rightPaneTabs?: string[]             // Tabs in right pane
  rightPaneActiveId?: string | null    // Active tab in right pane
  maximized?: boolean                  // Is window maximized?
  preMaximizeRect?: { x, y, w, h }     // Saved rect before maximize
}
```

### Signals
- `popoutPanels`: Signal containing array of `PopoutPanelState`
- `snapGuides`: Signal with `[{x?, y?}]` for current snap guide positions
- `focusedPanelId`: Currently focused panel (times out after 2s)
- `activePanelId`: Which panel is active (brought to front)
- `panelZOrders`: Map<panelId, zIndex> for Z-ordering
- `dockedOrientation`: 'vertical' | 'horizontal' layout for docked panels
- `sidebarWidth`: Sidebar width in pixels

---

## 3. Positioning System

### Floating Panel Positioning
```typescript
const panelStyle = !docked ? 
  { 
    position: 'fixed',
    left: panel.floatingRect.x,
    top: panel.floatingRect.y,
    width: panel.floatingRect.w,
    height: isMinimized ? 34 : panel.floatingRect.h,
    zIndex: panelZIdx
  }
```

### Docked Panel Positioning
**Right-docked (vertical layout):**
```typescript
{
  position: 'fixed',
  right: 0,
  top: panelTop,
  width: panel.dockedWidth,
  height: panel.dockedHeight,
  zIndex: panelZIdx
}
```

**Left-docked:**
```typescript
{
  position: 'fixed',
  left: sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3),
  top: panelTop,
  width: panel.dockedWidth,
  height: panel.dockedHeight,
  zIndex: panelZIdx
}
```

**Horizontal layout (multiple right-docked panels):**
```typescript
const dockedPanels = popoutPanels.value.filter(p => p.docked && p.dockedSide !== 'left');
const idx = dockedPanels.findIndex(p => p.id === panel.id);
const perPanel = (window.innerHeight - 40) / count;
{
  position: 'fixed',
  right: 0,
  top: 40 + idx * perPanel,
  width: panel.dockedWidth,
  height: perPanel
}
```

### Z-Index Calculation
```typescript
function getPanelZIndex(panel: PopoutPanelState): number {
  const order = panelZOrders.value.get(panel.id) || 0;
  const alwaysOnTop = !!panel.alwaysOnTop;
  // order*2 ensures most-recently-focused panel always wins
  // alwaysOnTop adds +1 so it stays above same-age unfocused panels
  return 950 + order * 2 + (alwaysOnTop ? 1 : 0);
}
```

---

## 4. Drag/Move Handling

### Header Drag Start (`onHeaderDragStart`)
1. Checks click target is not a button/select/link (ignore those)
2. Sets `dragging.current = true`
3. Records initial mouse position and panel position in `startPos`
4. Adds `popout-dragging` class for visual feedback

### Move Phase
**For docked panels:**
- Horizontal drag (dx > 3): Undocks if drag distance exceeds `UNDOCK_THRESHOLD`
- Vertical drag (dy > 3): Moves `dockedTopOffset` (reorder within docked stack)

**For floating panels:**
- Raw position calculated: `x = Math.max(0, Math.min(startPos.x + dx, window.innerWidth - 100))`
- Snap logic applied (see Snap System below)
- When near screen edges:
  - Right edge (x > innerWidth - SNAP_THRESHOLD): Auto-dock right
  - Left edge (x < sidebarWidth + SNAP_THRESHOLD): Auto-dock left

### End Phase
- Removes `popout-dragging` class
- Clears snap guides
- Calls `persistPopoutState()` to save to localStorage

---

## 5. Snap System

### Snap Position Calculation (`snapPosition` function)
Checks 4 types of targets:
1. Screen corners: (0,0), (window.innerWidth, 0), (0, window.innerHeight), etc.
2. Control bar bottom: y = CONTROL_BAR_BOTTOM (40)
3. Other floating panels: edges of their floatingRect

For each target, checks 8 alignments:
- Left edge snap: panel.left → target.left/right
- Right edge snap: panel.right → target.left/right
- Top edge snap: panel.top → target.top/bottom
- Bottom edge snap: panel.bottom → target.top/bottom

If distance < EDGE_SNAP (8px), records guide position.

Returns:
```typescript
{ 
  x: snappedX,
  y: snappedY,
  guides: [{ x?: number, y?: number }]  // Lines to show visually
}
```

### Visual Guides
Rendered as full-height (100vh) or full-width (100vw) lines:
```typescript
guides.map((g, i) => (
  <div
    class="snap-guide"
    style={
      g.x !== undefined
        ? { left: g.x, top: 0, width: 1, height: '100vh' }
        : { left: 0, top: g.y, width: '100vw', height: 1 }
    }
  />
))
```

---

## 6. Resize Handling

### Resize Start (`onResizeStart`)
- Parameter: `edge` = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
- Records initial mouse position and panel dimensions
- Adds `popout-dragging` class

### Resize Calculation (Floating Panels)
```typescript
// Example for east (right) resize:
w = Math.max(MIN_W, startWidth + dx)

// For north (top) resize:
h = Math.max(MIN_H, startHeight - dy)
y = startY + (startHeight - h)  // Move top up
```

For diagonal resizes, all dimensions are updated simultaneously with proper directional logic.

### Resize Calculation (Docked Panels)
- East/West: Adjusts `dockedWidth`
- North: Adjusts `dockedHeight` and `dockedTopOffset` together
- South: Adjusts `dockedHeight` downward
- Clamps `grabY` to valid range: `[0, h - GRAB_HANDLE_H]`

---

## 7. Docked Panel Grab Handle (`DockedPanelGrabHandle`)

### Position Calculation
**Left-docked:**
```typescript
leftPos = sidebarWidth + (collapsed ? 0 : 3) + (visible ? dockedWidth : 0)
top = getDockedPanelTop(panelId) + grabY
```

**Right-docked (vertical):**
```typescript
rightPos = visible ? dockedWidth : 0
top = getDockedPanelTop(panelId) + grabY
```

**Right-docked (horizontal):**
Multiple panels share the height. Each gets allocated: `perPanel = (window.innerHeight - 40) / count`

### Grab Handle Drag Behavior
1. **Horizontal drag** (dx > 3): Resizes `dockedWidth`
2. **Vertical drag** (dy > 3): Moves grab handle within panel
   - If grabY < 0: Panel grows upward, adjusts `dockedTopOffset`
   - If grabY > maxGrabY: Panel grows downward, increases `dockedHeight`
   - Otherwise: Just updates `grabY`

### Quick Click
If mouse up happens < 200ms with < 3px movement: Toggles panel visibility

### Bounce Animation
For autojump panel, bounce animation can be triggered via `handleBounceCounter` signal:
```typescript
// Animation on grab-bounce class:
// Left-docked: bounces rightward
// Right-docked: bounces leftward
```

---

## 8. CSS Styling

### Base Classes

#### Floating Panel
```css
.popout-floating {
  position: fixed;
  z-index: 950;
  background: var(--pw-terminal-bg);
  border: 2px solid #475569;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.popout-floating.panel-active {
  border-color: #6366f1;  /* Primary accent */
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.3), 0 8px 32px rgba(0, 0, 0, 0.5);
}

.popout-floating.minimized {
  /* Height collapses to tab bar height only (34px) */
}

.popout-floating.always-on-top {
  border-top-color: rgba(251, 191, 36, 0.35);  /* Amber accent */
}
```

#### Docked Panel
```css
.popout-docked {
  position: fixed;
  right: 0;
  background: var(--pw-terminal-bg);
  border: 2px solid #475569;
  border-right: none;
  border-radius: 8px 0 0 8px;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 950;
}

.popout-docked.docked-left {
  /* Mirror of right-docked for left side */
  right: auto;
  left: value;
  border-right: 2px solid;
  border-left: none;
  border-radius: 0 8px 8px 0;
}
```

#### Grab Handle
```css
.popout-grab-tab {
  position: fixed;
  width: 20px;
  background: #312e81;
  border: 2px solid #6366f1;
  border-right: none;
  border-radius: 8px 0 0 8px;
  cursor: move;
  z-index: 951;
  display: flex;
  align-items: center;
  justify-content: center;
}

.popout-grab-tab-left {
  border: 2px solid #6366f1;
  border-left: none;
  border-radius: 0 8px 8px 0;
}
```

#### Resize Handles
```css
/* Edge handles */
.popout-resize-n { top: -3px; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
.popout-resize-s { bottom: -3px; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
.popout-resize-e { right: -3px; top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
.popout-resize-w { left: -3px; top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }

/* Corner handles */
.popout-resize-ne { top: -3px; right: -3px; width: 12px; height: 12px; cursor: nesw-resize; }
.popout-resize-nw { top: -3px; left: -3px; width: 12px; height: 12px; cursor: nwse-resize; }
.popout-resize-se { bottom: -3px; right: -3px; width: 12px; height: 12px; cursor: nwse-resize; }
.popout-resize-sw { bottom: -3px; left: -3px; width: 12px; height: 12px; cursor: nesw-resize; }
```

#### Snap Guides
```css
.snap-guide {
  position: fixed;
  background: #6366f1;
  opacity: 0.5;
  z-index: 9999;
  pointer-events: none;
}
```

#### Tab Bar
```css
.popout-tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  background: #1e1b4b;
  border-bottom: 1px solid #312e81;
  min-height: 30px;
  cursor: grab;
  user-select: none;
}
```

---

## 9. PaneContent Component

The `PaneContent.tsx` defines a single function: `renderTabContent()`

### Purpose
Determines what to render based on tab ID format:
- `view:*` - Built-in UI views (page, feedback, aggregate, etc.)
- `jsonl:*` - JSONL conversation viewer
- `feedback:*` - Feedback detail page
- `iframe:*` - Arbitrary URL in iframe
- `terminal:*` - Terminal companion
- `isolate:*` - Isolated component demo
- `url:*` - URL companion
- `file:*` - File viewer
- Regular session ID: Terminal view with SessionViewToggle

### Key Logic
```typescript
export function renderTabContent(
  sid: string,
  isVisible: boolean,
  sessionMap: Map<string, any>,
  onExit?: (exitCode: number, terminalText: string) => void,
): JSX.Element {
  const isView = sid.startsWith('view:');
  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  // ... extract prefix type
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const sess = sessionMap.get(realSid);
  
  // Return appropriate component based on type
}
```

---

## 10. Sessions State Management

Key signals in `sessions.ts`:

### Panel Management
- `popoutPanels`: Array of `PopoutPanelState`
- `updatePanel(panelId, updates)`: Merge updates into panel state
- `persistPopoutState()`: Save to localStorage

### Helper Functions
- `getPanelZIndex(panel)`: Calculate z-index with always-on-top support
- `bringToFront(panelId)`: Update z-order and MRU history
- `toggleAlwaysOnTop(panelId)`: Toggle pin-on-top
- `getDockedPanelTop(panelId)`: Calculate Y position considering all docked panels

### Auto-docking Logic
When floating near edges during drag:
```typescript
if (ev.clientX > window.innerWidth - SNAP_THRESHOLD) {
  updatePanel(panel.id, {
    docked: true,
    dockedSide: 'right',
    dockedHeight: currentPanel.floatingRect.h,
    dockedWidth: currentPanel.floatingRect.w,
    dockedTopOffset: 0,
  });
} else if (ev.clientX < sidebarWidth.value + SNAP_THRESHOLD) {
  updatePanel(panel.id, {
    docked: true,
    dockedSide: 'left',
    ...
  });
}
```

---

## 11. Usage Example: Opening a Panel

```typescript
// From sessions.ts updatePanel call
updatePanel('panel-1', {
  visible: true,
  floatingRect: { x: 100, y: 200, w: 600, h: 400 },
  sessionIds: ['session-abc'],
  activeSessionId: 'session-abc',
  docked: false,
  dockedHeight: 400,
  dockedWidth: 600,
});

// Component renders with:
// - position: fixed; left: 100px; top: 200px; width: 600px; height: 400px;
// - All 8 resize handles visible (floating)
// - Tab bar with session tab
// - Split handles if split pane enabled
```

---

## 12. Key Gotchas & Design Decisions

### 1. Split Pane vs Single Pane
- Floating panels support split panes: left/right with draggable divider
- Split ratio is stored per panel: `splitRatio` (0.2 - 0.8)
- CSS: `.popout-split-divider { cursor: col-resize; }`

### 2. Minimize vs Hide
- **Minimize** (floating only): Height collapses to tab bar (34px)
- **Hide**: Panel remains in state but `visibility: false` (no grab handle shown)

### 3. Maximize
- Stores `preMaximizeRect` before maximizing
- Sets `floatingRect: { x: 0, y: 40, w: window.innerWidth, h: window.innerHeight - 40 }`

### 4. Auto-Undocking
- Only from docked state when dragging > UNDOCK_THRESHOLD (40px)
- Different thresholds for left vs right: left needs rightward drag, right needs leftward drag

### 5. Grab Handle Y Position
- For docked panels, grab handle can be moved independently
- Growing upward subtracts from `dockedHeight` and adds negative `dockedTopOffset`
- Growing downward just increases `dockedHeight`
- Prevents grab handle from going outside panel bounds

### 6. Z-Order Formula
```
zIndex = 950 + (order * 2) + (alwaysOnTop ? 1 : 0)
```
- Base: 950 (above most UI but below modals at 9999)
- Multiplier of 2: Leaves room for always-on-top to interleave
- Always-on-top adds +1: Stays above unfocused panels of same age

### 7. Snap Guides During Drag
- `snapGuides` signal is updated during drag
- Guides rendered as full-screen lines (1px width/height)
- Cleared when drag ends

### 8. LocalStorage Persistence
- Entire `popoutPanels` array saved to `pw-popout-panels`
- Auto-jump session dimensions saved separately
- All changes persisted immediately via `persistPopoutState()`

---

## 13. File Paths

Key files to understand the system:
- `/packages/admin/src/components/PopoutPanel.tsx` - Main floating panel component
- `/packages/admin/src/components/PaneContent.tsx` - Tab content rendering
- `/packages/admin/src/lib/sessions.ts` - State management (signals, helpers)
- `/packages/admin/src/app.css` - All styling (search "popout", "snap-guide", "grab")

---

## 14. Summary of Key Mechanisms

| Feature | How It Works |
|---------|-------------|
| **Drag** | `onHeaderDragStart` → mousemove updates position → snap logic applied |
| **Resize** | `onResizeStart(edge)` → mousemove calculates new dimensions → clamped to MIN_W/MIN_H |
| **Snap** | `snapPosition()` checks distance to targets → guides stored in signal → rendered |
| **Auto-dock** | During drag, check proximity to screen edges → if close enough, update `docked` + `dockedSide` |
| **Z-order** | `panelZOrders` map maintains order → `bringToFront()` increments counter → formula calculates zIndex |
| **Split Pane** | `splitEnabled` flag + `splitRatio` (0-1) → left: `ratio`, right: `1-ratio` |
| **Docked Layout** | Horizontal: each panel gets `(height - 40) / count` | Vertical: panels stack at `top: value + offset` |
| **Grab Handle** | Separate div positioned absolutely on docked panel → drag updates `grabY` or `dockedWidth` |
| **Minimize** | Floating only → height collapses when `minimized` flag set |
| **Always On Top** | Flag adds +1 to z-index calculation → stays above unfocused panels |

