# Prompt Widget Admin Codebase Analysis

## Overview

This is a comprehensive exploration and analysis of the prompt-widget admin codebase, focusing on:
1. **Sessions management system** - How sessions are tracked and displayed
2. **"Waiting for input" feature** - How agent waiting states are detected and displayed
3. **Keyboard shortcuts system** - How keyboard input is handled globally
4. **Tab switching mechanism** - How terminal tabs work with split panes

## Generated Documents

### 1. CODEBASE_EXPLORATION_ANALYSIS.md (651 lines)
**Complete technical deep-dive covering:**
- Sessions page architecture
- Sidebar "Waiting for input" section implementation
- Keyboard shortcut infrastructure (single key, modifiers, two-key sequences)
- GlobalTerminalPanel component structure
- Tab bar rendering and status dot classes
- Session state signals and persistence
- Input state tracking mechanism
- WebSocket protocol flow
- Component hierarchy and data flow
- CSS classes for all indicators
- Potential enhancement areas

**Best for:** Understanding how everything works, implementation details, code references

### 2. QUICK_REFERENCE.md (263 lines)
**Fast lookup guide with:**
- How "Waiting for input" sessions are identified
- All keyboard shortcuts (Ctrl+Shift combos + g sequences)
- Shortcut registration pattern with examples
- State signals reference
- Component hierarchy tree
- File-to-feature mapping
- CSS classes quick reference
- localStorage keys list
- Testing guidelines and browser console commands
- Implementation examples

**Best for:** Quick lookups, implementation snippets, testing checklist

### 3. EXPLORATION_SUMMARY.md (259 lines)
**High-level findings covering:**
- Key findings about waiting feature
- Keyboard shortcut system overview
- Session tab management
- Component hierarchy
- Data flow diagrams
- Critical code locations table
- Essential vs reference files
- Key architectural insights
- Implementation guidelines
- Testing checklist

**Best for:** Understanding the big picture, deciding what to read next, quick reference

---

## Key Systems Explained

### The "Waiting for Input" System

**How it works:**
1. Server detects agent waiting (via bell character, syscall blocking, etc.)
2. Sends WebSocket message: `{ type: 'sequenced_output', content: { kind: 'input_state', state: 'waiting' } }`
3. Client stores in `sessionInputStates` map: `sessionId → 'waiting' | 'idle' | 'active'`
4. UI observes signal and displays:
   - Sidebar "Waiting for input (X)" badge
   - Separate section in sidebar session list
   - `waiting` CSS class on status dots
   - Navigation shortcut `g w` finds waiting sessions

**File locations:**
- Storage: `packages/admin/src/lib/sessions.ts:928-935`
- Sidebar display: `packages/admin/src/components/Layout.tsx:814-834`
- WebSocket handling: `packages/admin/src/components/AgentTerminal.tsx:246-248`
- Terminal tabs: `packages/admin/src/components/GlobalTerminalPanel.tsx:96-160`

### The Keyboard Shortcut System

**Architecture:**
- Central registry in `packages/admin/src/lib/shortcuts.ts`
- `registerShortcut()` API with cleanup
- Single global handler in capture phase
- Input-aware: respects xterm focus

**Current shortcuts:**
- `Ctrl+Shift+0-9` - Switch tabs by number
- `Ctrl+Shift+K/R/W/P` - Kill/Resolve/Close/Previous
- `Ctrl+Shift+Left/Right` - Cycle tabs
- `g f/a/g/s/l/p/w/t` - Navigation + actions
- `?`, `t`, Ctrl+\, Ctrl+Space - Utilities

**Implementation pattern:**
```javascript
registerShortcut({
  key: 'w',
  sequence: 'g w',
  label: 'Go to waiting session',
  category: 'Navigation',
  action: () => { /* has access to all state signals */ }
})
```

### Tab Management

**Multi-mode support:**
- **Main panel**: Single tab list, one active tab
- **Split pane**: Left + right panels, separate active tabs
- **Popout panels**: Docked/floating panels with separate tabs
- **Multi-digit selection**: Press 1, then 2 = tab 12 (500ms timeout)

**Visual feedback:**
- Tab numbers visible when Ctrl+Shift held
- Current digit highlighted in green (pending)
- Status dots show `waiting` state
- Hotkey menu shows when Ctrl+Shift held on active tab

---

## Quick Start Guide

### For Understanding the "Waiting for Input" Feature
1. Read: **EXPLORATION_SUMMARY.md** section "1. Waiting for Input System"
2. Reference: **QUICK_REFERENCE.md** section "Waiting for Input" table
3. Deep dive: **CODEBASE_EXPLORATION_ANALYSIS.md** section 2 & 6

### For Adding Custom Shortcuts
1. Read: **QUICK_REFERENCE.md** section "For Implementation"
2. Example: **CODEBASE_EXPLORATION_ANALYSIS.md** section 3
3. Register in: `Layout.tsx` useEffect (line 159+)

### For Understanding Tab Switching
1. Read: **EXPLORATION_SUMMARY.md** section "3. Session Tab Management"
2. Reference: **QUICK_REFERENCE.md** section "Session State Signals"
3. Code locations: **EXPLORATION_SUMMARY.md** table "Critical Code Locations"

### For Modifying the Keyboard System
1. Study: **CODEBASE_EXPLORATION_ANALYSIS.md** section 3
2. Reference: **QUICK_REFERENCE.md** shortcut patterns
3. Files: `shortcuts.ts` (registry) + `Layout.tsx` (registration)

---

## Critical Files Reference

### State Management
- `packages/admin/src/lib/sessions.ts` - All session signals, tab state, input states
- `packages/admin/src/lib/state.ts` - Global app state (route, auth, app ID)
- `packages/admin/src/lib/settings.ts` - User preferences (theme, shortcuts enabled, etc)

### Input Handling
- `packages/admin/src/lib/shortcuts.ts` - Keyboard shortcut registry and handler
- `packages/admin/src/lib/tab-drag.ts` - Tab drag-and-drop support

### UI Components
- `packages/admin/src/components/Layout.tsx` - Top-level layout, sidebar with waiting section, shortcut registration
- `packages/admin/src/components/GlobalTerminalPanel.tsx` - Terminal panel, tabs, split panes
- `packages/admin/src/components/SessionViewToggle.tsx` - View mode selector
- `packages/admin/src/components/AgentTerminal.tsx` - xterm.js terminal, WebSocket handling

### Pages
- `packages/admin/src/pages/SessionsPage.tsx` - Sessions list view
- `packages/admin/src/pages/FeedbackListPage.tsx` - Feedback list view
- `packages/admin/src/pages/SettingsPage.tsx` - Settings pages

---

## Architecture Highlights

### Reactive State Management
- All state stored in Preact signals (`packages/admin/src/lib/sessions.ts`)
- Components automatically re-render when signals change
- No manual subscription/unsubscription needed
- localStorage persistence automatic

### Smart Input Handling
- Shortcuts don't steal keys from xterm terminals
- Ctrl+Shift shortcuts allowed in any input (text selection disabled)
- Input-aware in capture phase of event flow
- Terminal container `.xterm` class recognized

### Flexible Tab System
- Supports main panel, split panes, and popout panels
- Each pane can have separate tab lists
- Tab numbers visible when holding modifier
- Multi-digit entry supported (1 + 2 = tab 12)

### Visual State Indicators
- Status dots with CSS classes for state
- Input state overlay (waiting/idle)
- Tab badges with number (Ctrl+Shift held)
- Hotkey menu auto-shows with available actions
- Section headers for logical grouping

---

## Data Flow Example: Waiting Session

```
1. Server detects waiting
   ↓
2. WebSocket: { type: 'sequenced_output', ... state: 'waiting' }
   ↓
3. AgentTerminal.tsx (line 246)
   WebSocket handler → onInputStateChange('waiting')
   ↓
4. SessionViewToggle (passed callback)
   onInputStateChange('waiting')
   ↓
5. sessions.ts (line 930)
   setSessionInputState(sessionId, 'waiting')
   ↓
6. Signal updated: sessionInputStates.set(sessionId, 'waiting')
   ↓
7. Layout.tsx observes signal (line 466)
   Counts waiting sessions, filters into sections
   ↓
8. Sidebar renders:
   - "Waiting for input (X)" header
   - Session in "waiting" section
   - Dot gets `waiting` CSS class
   ↓
9. GlobalTerminalPanel observes signal (line 118)
   Terminal tab status dot gets `waiting` class
   ↓
10. User can:
    - Click session in sidebar
    - Press `g w` to navigate
    - Use Ctrl+Shift+# to jump by number
```

---

## Testing Checklist

From **QUICK_REFERENCE.md**:
- [ ] Waiting session shows in sidebar with badge
- [ ] Status dots show `waiting` CSS class
- [ ] `g w` navigates to waiting session
- [ ] Ctrl+Shift held shows tab numbers
- [ ] Split panes work correctly
- [ ] Multi-digit selection works (1 then 2)
- [ ] localStorage persists after refresh
- [ ] Hotkey menu shows correct actions

---

## Summary

This codebase is well-architected with:
- **Clear separation**: State (signals) → Input (shortcuts) → UI (components)
- **Extensible design**: Easy to add new shortcuts or features
- **Smart handling**: Respects input focus, supports multiple UI modes
- **Complete feature**: "Waiting for input" already fully implemented

The three analysis documents provide different perspectives:
- **EXPLORATION_SUMMARY.md** - High-level overview (start here)
- **CODEBASE_EXPLORATION_ANALYSIS.md** - Deep technical details (go here for specifics)
- **QUICK_REFERENCE.md** - Fast lookup and examples (reference while coding)

---

## Next Steps

1. **Quick understanding**: Read EXPLORATION_SUMMARY.md
2. **For coding**: Open QUICK_REFERENCE.md in your editor
3. **For specifics**: Look up file/line in CODEBASE_EXPLORATION_ANALYSIS.md
4. **For testing**: Use QUICK_REFERENCE.md testing section + browser console examples

All documents are in the project root and cross-reference each other.
