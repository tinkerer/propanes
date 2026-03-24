# Terminal Companion Flow Analysis

## Overview

The terminal companion system in the admin UI consists of two parallel flows:
1. **Global Terminal Panel** (bottom panel with split panes)
2. **Popout Panels** (floating/docked windows with split panes)

Both flows follow the same pattern but use different state management functions.

---

## Global Terminal Panel Flow

### 1. Opening Terminal Companion (from ID menu)

**Location:** `GlobalTerminalPanel.tsx`, lines 296-312

```jsx
{(() => {
  const companions = getCompanions(sessionId);
  const termActive = companions.includes('terminal');
  return (
    <button onClick={() => {
      if (termActive) {
        idMenuOpen.value = null;
        toggleCompanion(sessionId, 'terminal');  // Toggle OFF
      } else {
        idMenuOpen.value = null;
        termPickerOpen.value = { kind: 'companion', sessionId };  // Open picker
      }
    }}>
      {termActive ? '\u2713 ' : ''}Terminal <kbd>M</kbd>
    </button>
  );
})()}
```

**Key Points:**
- If terminal companion already exists and is visible: toggle it OFF via `toggleCompanion()`
- If no terminal companion: open `TerminalPicker` modal with `kind: 'companion'`
- Also triggered via hotkey `M` when ID menu is open

### 2. "New Terminal" Button (from top button)

**Location:** `GlobalTerminalPanel.tsx`, lines 819-826

```jsx
<button
  class="terminal-collapse-btn"
  title="New terminal"
  onClick={(e) => {
    e.stopPropagation();
    termPickerOpen.value = { kind: 'new' };
  }}
>+</button>
```

**Key Points:**
- Opens `TerminalPicker` with `kind: 'new'` (shows new terminal, remote machines, harnesses, etc.)
- Does NOT require a parent session

### 3. Terminal Picker Modal

**Location:** `TerminalPicker.tsx`, lines 33-399

#### TerminalPickerMode Types:
```typescript
type TerminalPickerMode =
  | { kind: 'companion'; sessionId: string }   // Attaching to a parent session
  | { kind: 'new' }                             // Creating standalone or for global panel
  | { kind: 'claude' }                          // Creating Claude interactive session
  | { kind: 'url' };                            // URL iframe mode
```

#### Action Handlers:

**When `kind: 'companion'` (attaching to parent):**
```typescript
async function pickNew(launcherId?: string, harnessConfigId?: string) {
  onClose();
  const isCompanion = !!parentSessionId;  // true if kind: 'companion'
  const newId = await spawnTerminal(..., isCompanion);
  if (newId && parentSessionId) {
    await loadAllSessions();
    setTerminalCompanionAndOpen(parentSessionId, newId);  // KEY: Opens in right pane
  }
}

async function pickExisting(termSessionId: string) {
  onClose();
  if (parentSessionId) {
    setTerminalCompanionAndOpen(parentSessionId, termSessionId);  // KEY: Opens in right pane
  } else {
    openSession(termSessionId);  // Opens in main tab
  }
}
```

**When `kind: 'new'` (no parent):**
```typescript
const newId = await spawnTerminal(appId);  // Opens as tab in global panel
```

### 4. setTerminalCompanionAndOpen (Core Function)

**Location:** `sessions.ts`, lines 1952-1965

```typescript
export function setTerminalCompanionAndOpen(parentSessionId: string, termSessionId: string) {
  // 1. Store the mapping: parentSessionId → termSessionId
  setTerminalCompanion(parentSessionId, termSessionId);
  
  // 2. Register 'terminal' as a companion type for this session
  const current = getCompanions(parentSessionId);
  if (!current.includes('terminal')) {
    sessionCompanions.value = { ...sessionCompanions.value, [parentSessionId]: [...current, 'terminal'] };
    persistCompanions();
  }
  
  // 3. Open terminal as a tab in the right pane (split mode)
  openSessionInRightPane(companionTabId(parentSessionId, 'terminal'));
  
  // 4. Keep parent session active in left pane
  if (activeTabId.value !== parentSessionId) {
    activeTabId.value = parentSessionId;
    persistTabs();
  }
}
```

**Key Points:**
- Creates mapping: `parentSessionId → termSessionId` in `terminalCompanionMap`
- Adds 'terminal' to `sessionCompanions` for the parent
- **Opens as a tab in RIGHT PANE** via `openSessionInRightPane()`
- Parent session becomes active in LEFT PANE
- This is the critical difference from regular companion tabs

### 5. openSessionInRightPane (Enables Split)

**Location:** `sessions.ts`, lines 416-428

```typescript
export function openSessionInRightPane(sessionId: string) {
  // 1. Add to openTabs if not already there
  if (!openTabs.value.includes(sessionId)) {
    openTabs.value = [...openTabs.value, sessionId];
  }
  
  // 2. Enable split if not already enabled
  if (!splitEnabled.value) enableSplit(sessionId);
  
  // 3. Add to right pane tabs
  if (!rightPaneTabs.value.includes(sessionId)) {
    rightPaneTabs.value = [...rightPaneTabs.value, sessionId];
  }
  
  // 4. Make it active in right pane
  rightPaneActiveId.value = sessionId;
  persistSplitState();
  persistTabs();
}
```

**Key Points:**
- Automatically enables split mode
- Adds companion tab to `rightPaneTabs`
- Makes it the active tab in right pane
- Tab ID is already formatted as `terminal:{parentSessionId}`

### 6. toggleCompanion (Toggle OFF)

**Location:** `sessions.ts`, lines 2006-2052

```typescript
export function toggleCompanion(sessionId: string, type: CompanionType) {
  const current = getCompanions(sessionId);
  const tabId = companionTabId(sessionId, type);
  const isVisible = rightPaneTabs.value.includes(tabId) && splitEnabled.value;

  if (current.includes(type) && isVisible) {
    // TOGGLE OFF - only if visible
    const next = current.filter((t) => t !== type);
    sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: next };
    persistCompanions();

    // Clean up terminal companion map
    if (type === 'terminal') {
      removeTerminalCompanion(sessionId);  // Removes from terminalCompanionMap
    }

    // Close the tab from right pane
    const remaining = rightPaneTabs.value.filter((id) => id !== tabId);
    rightPaneTabs.value = remaining;
    if (rightPaneActiveId.value === tabId) {
      rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    
    // Disable split if right pane is empty
    if (remaining.length === 0 && splitEnabled.value) {
      disableSplit();
      return;
    }
    
    persistSplitState();
    // Also remove from openTabs
    if (openTabs.value.includes(tabId)) {
      openTabs.value = openTabs.value.filter((id) => id !== tabId);
      persistTabs();
    }
  } else {
    // TOGGLE ON
    if (!current.includes(type)) {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: [...current, type] };
      persistCompanions();
    }
    openSessionInRightPane(tabId);
  }
}
```

**Key Points:**
- Only toggles OFF if companion is both registered AND visible
- Cleans up `terminalCompanionMap` when removing terminal
- Removes from `rightPaneTabs` and `openTabs`
- Disables split if right pane becomes empty

---

## Popout Panel Flow

### 1. Opening Terminal Companion (from popout ID menu)

**Location:** `PopoutPanel.tsx`, lines 789-808

```jsx
{(() => {
  const panelRight = panel.rightPaneTabs || [];
  const termActive = panelRight.includes(companionTabId(activeId, 'terminal')) && panel.splitEnabled;
  return (
    <button onClick={(e: any) => {
      e.stopPropagation();
      if (termActive) {
        popoutIdMenuOpen.value = null;
        togglePanelCompanion(panel.id, activeId, 'terminal');  // Toggle OFF
      } else {
        popoutIdMenuOpen.value = null;
        popoutTermPickerSessionId.value = activeId;  // Store which session needs companion
        popoutTermPickerLoading.value = true;
        api.listTmuxSessions().then((r: any) => { popoutTermPickerTmux.value = r.sessions; });
      }
    }}>
      {termActive ? '\u2713 ' : ''}Terminal companion <kbd>M</kbd>
    </button>
  );
})()}
```

**Key Points:**
- Sets `popoutTermPickerSessionId.value` to the session needing a companion
- Loads tmux sessions for the picker
- Also toggles OFF if already active
- **Does NOT use `termPickerOpen` signal** (global modal) — uses internal picker

### 2. Popout Terminal Companion Picker (Internal Modal)

**Location:** `PopoutPanel.tsx`, lines 144-210

```tsx
function PopoutTerminalCompanionPicker({ sessionId, panelId, sessionMap, onClose }: ...) {
  async function pickExisting(termSessionId: string) {
    setTerminalCompanion(sessionId, termSessionId);
    onClose();
  }

  async function pickNew() {
    const newId = await spawnTerminal(null);
    if (newId) {
      setTerminalCompanion(sessionId, newId);
      onClose();
    }
  }

  async function pickTmux(tmuxName: string) {
    const newId = await attachTmuxSession(tmuxName, null, true);  // skipOpen = true
    if (newId) {
      setTerminalCompanion(sessionId, newId);
      onClose();
    }
  }
  // ... renders picker UI
}
```

**Rendered when:**
```jsx
{popoutTermPickerSessionId.value === activeId && (
  <PopoutTerminalCompanionPicker
    sessionId={activeId}
    panelId={panel.id}
    sessionMap={sessionMap}
    onClose={() => { popoutTermPickerSessionId.value = null; popoutIdMenuOpen.value = null; }}
  />
)}
```

**Key Points:**
- Only calls `setTerminalCompanion()` (not `setTerminalCompanionAndOpen()`)
- **Does NOT automatically enable split or open the tab**
- This is the difference! Popout panels handle opening separately.

### 3. togglePanelCompanion (Panel-Specific)

**Location:** `sessions.ts`, lines 595-643

```typescript
export function togglePanelCompanion(panelId: string, sessionId: string, type: CompanionType) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  const tabId = companionTabId(sessionId, type);
  const rightTabs = panel.rightPaneTabs || [];
  const isVisible = rightTabs.includes(tabId) && panel.splitEnabled;

  const current = getCompanions(sessionId);

  if (current.includes(type) && isVisible) {
    // TOGGLE OFF
    const next = current.filter((t) => t !== type);
    sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: next };
    persistCompanions();

    const remaining = rightTabs.filter((id) => id !== tabId);
    if (remaining.length === 0) {
      disablePanelSplit(panelId);
    } else {
      updatePanel(panelId, {
        rightPaneTabs: remaining,
        rightPaneActiveId: panel.rightPaneActiveId === tabId
          ? remaining[remaining.length - 1]
          : panel.rightPaneActiveId,
      });
      persistPopoutState();
    }
  } else {
    // TOGGLE ON
    if (!current.includes(type)) {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: [...current, type] };
      persistCompanions();
    }
    const newRight = rightTabs.includes(tabId) ? rightTabs : [...rightTabs, tabId];
    updatePanel(panelId, {
      splitEnabled: true,
      rightPaneTabs: newRight,
      rightPaneActiveId: tabId,
      splitRatio: panel.splitRatio ?? 0.5,
    });
    persistPopoutState();
    nudgeResize();
  }
}
```

**Key Points:**
- Works only on a specific panel (identified by `panelId`)
- Directly updates panel state via `updatePanel()`
- Enables split and adds tab in one call
- Does NOT handle `terminalCompanionMap` cleanup (bug?)

---

## State Management

### Key Signals:

1. **`terminalCompanionMap`** — Maps parent session ID → terminal session ID
   - Type: `Record<string, string>`
   - Persisted to localStorage
   - Functions: `getTerminalCompanion()`, `setTerminalCompanion()`, `removeTerminalCompanion()`

2. **`sessionCompanions`** — Tracks which companion types are registered for each session
   - Type: `Record<string, CompanionType[]>`
   - Persisted to localStorage
   - Functions: `getCompanions()`, `toggleCompanion()` (global), `togglePanelCompanion()` (panel)

3. **`termPickerOpen`** — Controls global TerminalPicker modal
   - Type: `TerminalPickerMode | null`
   - NOT persisted
   - Set by: ID menu, "+" button, hotkeys

4. **`popoutTermPickerSessionId`** — Controls popout's internal picker
   - Type: `string | null`
   - Stores which session needs a terminal companion

5. **`openTabs`** & **`rightPaneTabs`** — Track which tabs are open
   - Tab IDs: `sessionId` for regular, `type:sessionId` for companions
   - Persisted to localStorage

### Tab ID Format:
- Regular session: `"abc123def456"` (raw session ID)
- Companion tab: `"terminal:abc123def456"` (type:sessionId)

---

## Current State Persistence

**Global Terminal Panel:**
```
pw-terminal-companion-map  → terminalCompanionMap
pw-session-companions     → sessionCompanions
pw-open-tabs             → openTabs
pw-right-pane-tabs       → rightPaneTabs
pw-split-enabled         → splitEnabled
pw-right-pane-active     → rightPaneActiveId
```

**Popout Panels:**
```
pw-popout-panels         → popoutPanels (includes all panel state)
pw-popout-panels[].rightPaneTabs
pw-popout-panels[].splitEnabled
```

---

## Flow Diagram: Opening Terminal Companion in Global Panel

```
User clicks "Terminal" in ID menu
    ↓
termPickerOpen = { kind: 'companion', sessionId: 'parent-xyz' }
    ↓
TerminalPicker modal opens
    ↓
User selects option (new, existing, tmux, or machine)
    ↓
pickNew() or pickExisting() called
    ↓
spawnTerminal() / attachTmuxSession()
    ↓
Returns newTerminalId
    ↓
setTerminalCompanionAndOpen(parentSessionId, newTerminalId)
    ├─ terminalCompanionMap[parent] = terminal
    ├─ sessionCompanions[parent] = [..., 'terminal']
    ├─ openSessionInRightPane('terminal:parent')
    │   ├─ openTabs.push('terminal:parent')
    │   ├─ splitEnabled = true
    │   ├─ rightPaneTabs.push('terminal:parent')
    │   └─ rightPaneActiveId = 'terminal:parent'
    └─ activeTabId = parentSessionId (keep parent visible in left pane)
    ↓
Right pane renders terminal:parent tab
    ↓
renderTabContent() extracts parentSessionId from 'terminal:parent'
    ↓
getTerminalCompanion(parentSessionId) → newTerminalId
    ↓
<TerminalCompanionView companionSessionId={newTerminalId} />
```

---

## Flow Diagram: Toggling OFF Terminal Companion

```
User clicks "Terminal" again (when active)
    ↓
toggleCompanion(sessionId, 'terminal')
    ↓
Check: is companion in sessionCompanions? AND visible in rightPaneTabs?
    ↓
removeTerminalCompanion(sessionId)  → remove from terminalCompanionMap
    ↓
Remove from sessionCompanions
    ↓
Remove 'terminal:sessionId' from rightPaneTabs
    ↓
If rightPaneTabs is now empty: disableSplit()
    ├─ splitEnabled = false
    └─ rightPaneTabs = []
    ↓
Remove 'terminal:sessionId' from openTabs
    ↓
Persist state changes
```

---

## Rendering: TerminalCompanionView

**Location:** `GlobalTerminalPanel.tsx`, lines 557-602 (`renderTabContent()`)

```typescript
function renderTabContent(sid: string, isVisible: boolean, sessionMap, onExit) {
  const isTerminal = sid.startsWith('terminal:');
  const realSid = isTerminal ? sid.slice(sid.indexOf(':') + 1) : sid;
  
  if (isTerminal) {
    const termSid = getTerminalCompanion(realSid);
    return termSid 
      ? <TerminalCompanionView companionSessionId={termSid} /> 
      : <div class="companion-error">No companion terminal</div>;
  }
}
```

**Key Points:**
- Extracts parent session ID from tab ID (`terminal:parent` → `parent`)
- Looks up terminal session ID via `getTerminalCompanion(parent)` → `terminalId`
- Passes terminal ID to `TerminalCompanionView`
- If mapping is missing, shows error

---

## Differences: Global Panel vs Popout Panel

| Aspect | Global Panel | Popout Panel |
|--------|--------------|--------------|
| **Open Modal** | `termPickerOpen` signal (global) | `popoutTermPickerSessionId` (internal) |
| **After Selection** | `setTerminalCompanionAndOpen()` | `setTerminalCompanion()` only |
| **Split Enabled** | Automatic (in `openSessionInRightPane()`) | Manual (in `togglePanelCompanion()` when toggling ON) |
| **Tab Opened** | Yes, immediately | No, user must toggle ON later |
| **Companion Cleanup** | `toggleCompanion()` handles it | `togglePanelCompanion()` doesn't clean `terminalCompanionMap` |
| **Modal Type** | Single global modal for all panes | Separate internal picker per popout |

---

## Issues / Discrepancies

1. **Popout `togglePanelCompanion()` doesn't clean `terminalCompanionMap`**
   - When toggling OFF, it should call `removeTerminalCompanion(sessionId)`
   - Currently only removes from `sessionCompanions`
   - Could leave orphaned mappings in `terminalCompanionMap`

2. **Popout picker doesn't auto-open the tab**
   - After `setTerminalCompanion()`, user must manually toggle ON
   - Global panel auto-opens via `openSessionInRightPane()`
   - Inconsistent UX

3. **No error handling in popout picker**
   - Doesn't show feedback if terminal creation fails
   - Global picker closes immediately regardless of success

4. **Tab rendering assumes terminal mapping exists**
   - If `terminalCompanionMap` is corrupted or missing, shows generic error
   - No recovery mechanism
