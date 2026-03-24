# Prompt Widget Admin UI - Terminal Picker Component Analysis

## Overview
The terminal picker is a sophisticated dropdown menu system that allows users to select and attach terminal sessions as "companions" to agent feedback sessions. The system includes multiple layers of menu components, data fetching, and state management.

## Key Components

### 1. Main Terminal Picker Components

#### **TerminalCompanionPicker** (GlobalTerminalPanel.tsx, lines 81-182)
- **Purpose**: Modal dropdown for picking a terminal to attach as a companion to an existing session
- **Trigger**: When `termPickerSessionId.value === sessionId` (line 403-408)
- **CSS Classes**: `id-dropdown-menu term-picker-menu`
- **Position**: Absolute, positioned at `top:100%;left:0;min-width:200px`

**Data Structure:**
```typescript
interface TerminalCompanionPickerProps {
  sessionId: string;          // Parent session ID
  sessionMap: Map<string, any>;
  onClose: () => void;
}
```

**Sections Displayed:**
1. "New terminal" button
2. "Remote machines" (if available)
   - Filtered from `targets` where `!t.isHarness`
   - Shows: `machineName`, `activeSessions/maxSessions`
3. "Harnesses" (if available)
   - Filtered from `targets` where `t.isHarness`
   - Shows: `name`, `activeSessions/maxSessions`
4. "Open terminals" (existing sessions)
   - Filtered from `allSessions` where `permissionProfile === 'plain'` and `id !== sessionId`
   - Shows: `paneCommand:panePath` or `paneTitle`
5. "Attach tmux session" (if available)
   - Loaded from API on demand
   - Shows: `name`, `windows` count, attachment status

#### **NewTerminalPicker** (GlobalTerminalPanel.tsx, lines 184-263)
- **Purpose**: Dropdown menu for creating new terminals from the panel's "+" button
- **Trigger**: When `newTermPickerOpen.value === true` (line 850-851)
- **CSS Classes**: `id-dropdown-menu term-picker-menu`
- **Position**: Absolute, positioned at `top:auto;bottom:100%;right:0;left:auto;min-width:200px`
- **Similar structure to TerminalCompanionPicker but excludes existing terminals section**

### 2. Session ID Dropdown Menu

#### **PaneHeader ID Dropdown** (GlobalTerminalPanel.tsx, lines 321-410)
- **CSS Classes**: `id-dropdown-menu`
- **Position**: Absolute, `top:100%;left:0`
- **Contains**:
  - Copy session ID
  - Copy tmux command
  - Copy JSONL path (if applicable)
  - Toggle JSONL companion
  - Toggle Feedback companion
  - Toggle Page iframe
  - Toggle Terminal companion ← **This triggers TerminalCompanionPicker**
  - Popout options (Panel, Window, Tab, Terminal.app)
  - Split panes option

**Key Signal**: `idMenuOpen` (line 78) - tracks which session's menu is open

### 3. Data Sources

#### **Dispatch Targets** (DispatchTargetSelect.tsx)
```typescript
interface DispatchTarget {
  launcherId: string;
  name: string;
  hostname: string;
  machineName: string | null;
  machineId: string | null;
  isHarness: boolean;
  harnessConfigId: string | null;
  activeSessions: number;
  maxSessions: number;
}
```

**API Endpoint**: `/admin/dispatch-targets`
**Cached Signal**: `cachedTargets` with 10-second TTL
**Refresh Function**: `ensureTargetsLoaded()` - checks if data older than 10s

#### **Tmux Sessions**
```typescript
interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}
```

**API Endpoint**: `/admin/tmux-sessions`
**Loading**: On-demand when picker is opened
**Signals**:
- `termPickerTmux` - array of tmux sessions
- `termPickerLoading` - boolean loading state

#### **Sessions** (allSessions signal from sessions.ts)
- Filtered for plain terminal sessions
- Properties used: `id`, `status`, `paneCommand`, `panePath`, `paneTitle`, `permissionProfile`

### 4. Related Signals and State

**From GlobalTerminalPanel.tsx:**
```typescript
const termPickerSessionId = signal<string | null>(null);
const termPickerTmux = signal<{ name: string; windows: number; created: string; attached: boolean }[]>([]);
const termPickerLoading = signal(false);
const newTermPickerOpen = signal(false);
const idMenuOpen = signal<string | null>(null);
```

**From sessions.ts:**
```typescript
export const terminalCompanionMap = signal<Record<string, string>>(
  loadJson('pw-terminal-companion-map', {})
);

export function getTerminalCompanion(sessionId: string): string | undefined {
  return terminalCompanionMap.value[sessionId];
}

export function setTerminalCompanionAndOpen(parentSessionId: string, termSessionId: string) {
  terminalCompanionMap.value = { ...terminalCompanionMap.value, [parentSessionId]: termSessionId };
  // Also opens the terminal as a companion tab
}
```

## CSS Styling

### Dropdown Menu Styles (app.css, lines 5368-5428)

```css
.id-dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  min-width: 180px;
  padding: 4px 0;
}

.id-dropdown-menu button {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: #cbd5e1;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  white-space: nowrap;
}

.id-dropdown-menu button:hover {
  background: #334155;
  color: #f1f5f9;
}

.id-dropdown-separator {
  height: 1px;
  background: #334155;
  margin: 4px 0;
}

.id-dropdown-menu kbd {
  float: right;
  font-size: 10px;
  color: #64748b;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 3px;
  padding: 0 4px;
  margin-left: 12px;
  line-height: 1.6;
}
```

### Terminal Picker Styling (term-picker-menu)
Uses same `.id-dropdown-menu` class with additional inline styles:
- TerminalCompanionPicker: `style="top:100%;left:0;min-width:200px"`
- NewTerminalPicker: `style="top:auto;bottom:100%;right:0;left:auto;min-width:200px"`

## Modal/Popup Patterns in Codebase

### 1. Modal Pattern (Modal Overlay)
```typescript
// Modal wrapper with overlay
<div class="modal-overlay" onClick={onClose}>
  <div class="modal" onClick={(e) => e.stopPropagation()}>
    {/* content */}
  </div>
</div>
```

**Used by:**
- AddAppModal (app creation/registration)
- ShortcutHelpModal (keyboard help)

**Styles (app.css, lines 1650-1681):**
```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--pw-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--pw-bg-surface);
  border-radius: 12px;
  padding: 24px;
  width: 90%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--pw-shadow-lg);
  color: var(--pw-text-primary);
}
```

### 2. Dropdown/Submenu Pattern (Relative Positioning)
```typescript
// Dropdown positioned relative to trigger
<div class="id-dropdown-menu" style="top:100%;left:0;...">
  {/* menu items */}
</div>
```

**Used by:**
- Terminal picker menus
- ID/session dropdown menus
- Directory picker (DirPicker.tsx)

### 3. Spotlight Search Pattern (Full-Screen Overlay)
```typescript
<div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="spotlight-container">
    {/* search interface */}
  </div>
</div>
```

**Styles (app.css, lines 5997-6182):**
- Fullscreen fixed overlay with z-index 9999
- Centered container with fade-in/slide-down animations
- Keyboard-navigable results

## Directory Picker Component (DirPicker.tsx)

While not a terminal picker, it's a good reference for nested dropdown patterns:
- Positioned as absolute dropdown: `top:100%;left:0;right:0;margin-top:4px`
- Nested structure: path header + scrollable item list
- Click-outside detection for closing
- Async data loading with loading states

## Keyboard Interaction

**From GlobalTerminalPanel.tsx (lines 696-747):**
The ID dropdown menu responds to keyboard shortcuts:
- `C`: Copy session ID
- `T`: Copy tmux command
- `J`: Copy JSONL path
- `L`: Toggle JSONL companion
- `F`: Toggle feedback companion
- `I`: Toggle iframe companion
- `M`: Open terminal companion picker
- `P`: Pop out as panel
- `W`: Pop out as window
- `B`: Pop out as browser tab
- `A`: Pop out to Terminal.app
- `S`: Enable split panes
- `Escape`: Close menu

## Click-Outside Handling

**Pattern used in terminal pickers (lines 115-122, 197-204):**
```typescript
useEffect(() => {
  function handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.term-picker-menu')) onClose();
  }
  setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
  return () => document.removeEventListener('mousedown', handleClick);
}, [onClose]);
```

## Existing Search/Cmd-K Functionality

### SpotlightSearch Component (SpotlightSearch.tsx)

**Trigger**: Cmd-K / Ctrl-K (managed in Layout.tsx or App.tsx)

**Features:**
- Keyboard navigation (Arrow Up/Down, Enter, Escape)
- Local search: applications, sessions (synchronous)
- API search: feedback (debounced 200ms)
- Recent results tracking (stored in `recentResults` signal)
- Result grouping by type: Applications, Sessions, Feedback
- Selected result highlighting and auto-scroll

**Search Algorithm:**
- Case-insensitive substring matching
- Multi-field search: title, subtitle, ID, pane info
- Debounced API calls to avoid spam

**Result Structure:**
```typescript
interface SearchResult {
  type: 'application' | 'feedback' | 'session';
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
  route: string;
}
```

## Architecture Summary

```
GlobalTerminalPanel
├── PaneHeader
│   ├── ID Dropdown Menu (.id-dropdown-menu)
│   │   └── Terminal companion button (M key)
│   │       └── TerminalCompanionPicker (popup)
│   │           ├── New terminal button
│   │           ├── Remote machines section
│   │           ├── Harnesses section
│   │           ├── Open terminals section
│   │           └── Tmux sessions section
│   └── Other options (popout, split, etc.)
└── Panel button (+)
    └── NewTerminalPicker (popup)
        ├── Local terminal
        ├── Remote machines section
        ├── Harnesses section
        └── Tmux sessions section

Data Flow:
dispatch-targets API → cachedTargets signal
                    ↓
                TerminalCompanionPicker
                ↓ (if machines/harnesses exist)
            Display in dropdown sections
                    ↓
    On selection: spawnTerminal() or attachTmuxSession()
                    ↓
            setTerminalCompanionAndOpen()
                    ↓
            terminalCompanionMap signal
```

## Files Summary

| File | Purpose | Key Components/Functions |
|------|---------|--------------------------|
| GlobalTerminalPanel.tsx | Main terminal panel component | TerminalCompanionPicker, NewTerminalPicker, PaneHeader |
| DispatchTargetSelect.tsx | Dropdown select for dispatch targets | DispatchTarget interface, cachedTargets signal |
| sessions.ts | Session state management | terminalCompanionMap, setTerminalCompanionAndOpen, spawnTerminal, attachTmuxSession |
| api.ts | API client | getDispatchTargets, listTmuxSessions, spawnTerminal, attachTmuxSession |
| app.css | Styling | .id-dropdown-menu, .term-picker-menu, .modal, .spotlight-* |
| SpotlightSearch.tsx | Cmd-K search | SearchResult, search algorithm, keyboard navigation |
| AddAppModal.tsx | App creation modal | modal pattern reference |
| DirPicker.tsx | Directory selection | Dropdown pattern reference, click-outside handling |
