# Terminal Picker - Detailed Code Reference

## File Paths and Line Numbers

- **GlobalTerminalPanel.tsx**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/GlobalTerminalPanel.tsx`
- **DispatchTargetSelect.tsx**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/DispatchTargetSelect.tsx`
- **sessions.ts**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/sessions.ts`
- **api.ts**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/api.ts`
- **app.css**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/app.css`
- **SpotlightSearch.tsx**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/SpotlightSearch.tsx`
- **AddAppModal.tsx**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/AddAppModal.tsx`
- **DirPicker.tsx**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/DirPicker.tsx`

## TerminalCompanionPicker Component

**Location**: GlobalTerminalPanel.tsx, lines 81-182

### Component Structure
```
TerminalCompanionPicker
├── useEffect: click-outside detection (lines 115-122)
└── return JSX (lines 124-181)
    ├── Button: "New terminal"
    ├── Section: "Remote machines" (conditional, lines 127-137)
    ├── Section: "Harnesses" (conditional, lines 139-149)
    ├── Section: "Open terminals" (conditional, lines 151-165)
    └── Section: "Attach tmux session" (conditional, lines 167-179)
```

### Key Signals Used
- `cachedTargets` (from DispatchTargetSelect): machine/harness list
- `allSessions` (from sessions.ts): all active sessions
- `termPickerSessionId`: parent session being modified
- `termPickerTmux`: list of available tmux sessions
- `termPickerLoading`: async loading state

### Data Filtering Logic
```typescript
const existingTerminals = sessions.filter((s) => 
  s.permissionProfile === 'plain' && 
  s.id !== sessionId && 
  s.status !== 'failed'
);

const machines = targets.filter(t => !t.isHarness);
const harnesses = targets.filter(t => t.isHarness);
```

### Click Handlers
1. `pickExisting(termSessionId)`: Connect existing terminal
2. `pickNew(launcherId?, harnessConfigId?)`: Spawn new terminal on machine/harness
3. `pickTmux(tmuxName)`: Attach tmux session

## NewTerminalPicker Component

**Location**: GlobalTerminalPanel.tsx, lines 184-263

### Differences from TerminalCompanionPicker
- Positioned above trigger (bottom:100%) instead of below (top:100%)
- Excludes "Open terminals" section
- Includes "Local terminal" as first option

### Async Loading
```typescript
useEffect(() => {
  ensureTargetsLoaded();
  termPickerLoading.value = true;
  api.listTmuxSessions()
    .then((r) => { termPickerTmux.value = r.sessions; })
    .catch(() => { termPickerTmux.value = []; })
    .finally(() => { termPickerLoading.value = false; });
}, []);
```

## PaneHeader Component

**Location**: GlobalTerminalPanel.tsx, lines 265-463

### ID Dropdown Trigger
```typescript
// Line 322-326
onClick={() => { 
  idMenuOpen.value = idMenuOpen.value === sessionId ? null : sessionId; 
}}
```

### Terminal Companion Toggle
**Location**: Lines 368-387

Toggles terminal companion on/off. When enabling:
```typescript
termPickerSessionId.value = sessionId;
termPickerLoading.value = true;
api.listTmuxSessions()
  .then((r) => { termPickerTmux.value = r.sessions; })
  .catch(() => { termPickerTmux.value = []; })
  .finally(() => { termPickerLoading.value = false; });
```

### Menu Keyboard Shortcuts
**Location**: Lines 696-747

```typescript
const key = e.key.toLowerCase();
switch(key) {
  case 'c': navigator.clipboard.writeText(menuSessionId);
  case 't': navigator.clipboard.writeText(`TMUX= tmux -L prompt-widget attach-session -t pw-${menuSessionId}`);
  case 'j': navigator.clipboard.writeText(s?.jsonlPath);
  case 'l': toggleCompanion(menuSessionId, 'jsonl');
  case 'f': toggleCompanion(menuSessionId, 'feedback');
  case 'i': toggleCompanion(menuSessionId, 'iframe');
  case 'm': // Terminal companion picker logic
  case 'p'/'w'/'b'/'a': executePopout(menuSessionId, mode);
  case 's': enableSplit();
}
```

## State Management

### Signals in GlobalTerminalPanel.tsx

**Line 71-78:**
```typescript
const statusMenuOpen = signal<{ sessionId: string; x: number; y: number } | null>(null);
const renamingSessionId = signal<string | null>(null);
const renameValue = signal('');
const termPickerSessionId = signal<string | null>(null);
const termPickerTmux = signal<{ name: string; windows: number; created: string; attached: boolean }[]>([]);
const termPickerLoading = signal(false);
const newTermPickerOpen = signal(false);
export const idMenuOpen = signal<string | null>(null);
const panelResizing = signal(false);
```

### Signals in sessions.ts

**Lines 1804-1809:**
```typescript
export const terminalCompanionMap = signal<Record<string, string>>(
  loadJson('pw-terminal-companion-map', {})
);

function persistTerminalCompanionMap() {
  localStorage.setItem('pw-terminal-companion-map', JSON.stringify(terminalCompanionMap.value));
}
```

**Lines 1813-1817:**
```typescript
export function getTerminalCompanion(sessionId: string): string | undefined {
  return terminalCompanionMap.value[sessionId];
}

export function setTerminalCompanionAndOpen(parentSessionId: string, termSessionId: string) {
  terminalCompanionMap.value = { ...terminalCompanionMap.value, [parentSessionId]: termSessionId };
```

## API Calls

### From api.ts

**getDispatchTargets (lines 106-117):**
```typescript
getDispatchTargets: () =>
  request<{ targets: Array<DispatchTarget> }>('/admin/dispatch-targets')
```

**listTmuxSessions (lines 119-120):**
```typescript
listTmuxSessions: () =>
  request<{ sessions: { name: string; windows: number; created: string; attached: boolean }[] }>('/admin/tmux-sessions')
```

**spawnTerminal (lines 100-104):**
```typescript
spawnTerminal: (data?: { cwd?: string; appId?: string; launcherId?: string; harnessConfigId?: string }) =>
  request<{ sessionId: string }>('/admin/terminal', {
    method: 'POST',
    body: JSON.stringify(data || {}),
  })
```

**attachTmuxSession (lines 122-126):**
```typescript
attachTmuxSession: (data: { tmuxTarget: string; appId?: string }) =>
  request<{ sessionId: string }>('/admin/terminal/attach-tmux', {
    method: 'POST',
    body: JSON.stringify(data),
  })
```

## CSS Classes Reference

### Dropdown Menu
- `.id-dropdown-menu` - main dropdown container (app.css, line 5368)
- `.term-picker-menu` - terminal picker specific (class added to id-dropdown-menu)
- `.id-dropdown-menu button` - menu item buttons (line 5381)
- `.id-dropdown-menu button:hover` - hover state (line 5393)
- `.id-dropdown-separator` - divider between sections (line 5397)
- `.id-dropdown-menu kbd` - keyboard hint styling (line 5418)

### Modal
- `.modal-overlay` - full-screen dark overlay (app.css, line 1650)
- `.modal` - centered modal container (line 1660)
- `.modal-actions` - button container at bottom (line 1676)

### Spotlight Search
- `.spotlight-overlay` - full-screen overlay (app.css, line 5997)
- `.spotlight-container` - centered search box (line 6013)
- `.spotlight-input` - search input field (line 6045)
- `.spotlight-results` - scrollable results area (line 6083)
- `.spotlight-result` - individual result item (line 6119)
- `.spotlight-result:hover` / `.selected` - result highlighting (line 6128)
- `.spotlight-category` - section header (line 6088)

## Directory Picker (Reference Pattern)

**Location**: DirPicker.tsx

### Structure
- Click-outside detection (lines 20-28)
- Async directory listing (lines 30-43)
- Absolute positioned dropdown (lines 79-122)
- Path navigation with parent link
- Scrollable directory list with "Select" and "Enter" buttons

**CSS**:
- `.dir-picker-dropdown` - absolute positioned at `top:100%;left:0;right:0;margin-top:4px` (app.css, line 1804)

## Spotlight Search (Reference for Search Functionality)

**Location**: SpotlightSearch.tsx

### Features
- Keyboard navigation (Arrow keys, Enter, Escape)
- Debounced API search (200ms delay)
- Local filtering (applications, sessions)
- Recent results tracking
- Result grouping by type
- Auto-scroll to selected result

### Search Result Types
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

### Keyboard Handling (lines 128-154)
```typescript
function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    onClose();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSelectedIndex((i) => Math.min(i + 1, listLen - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSelectedIndex((i) => Math.max(i - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Handle selection
  }
}
```

## Click-Outside Detection Patterns

### Terminal Picker Pattern (lines 115-122)
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

### Directory Picker Pattern (DirPicker.tsx, lines 19-28)
```typescript
useEffect(() => {
  if (!open) return;
  function onClickOutside(e: MouseEvent) {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }
  document.addEventListener('mousedown', onClickOutside);
  return () => document.removeEventListener('mousedown', onClickOutside);
}, [open]);
```

### Modal Pattern (stopPropagation on backdrop click)
```typescript
<div class="modal-overlay" onClick={onClose}>
  <div class="modal" onClick={(e) => e.stopPropagation()}>
    {/* content */}
  </div>
</div>
```

## Terminal Picker Menu Item Render Examples

### Machine/Harness Button (lines 131-136)
```typescript
{machines.map(t => (
  <button key={t.launcherId} onClick={() => pickNew(t.launcherId)}>
    {t.machineName || t.name}
    <span style="float:right;opacity:0.5;font-size:10px">
      {t.activeSessions}/{t.maxSessions}
    </span>
  </button>
))}
```

### Session Button (lines 160-163)
```typescript
{existingTerminals.map((s) => {
  const label = s.paneCommand
    ? `${s.paneCommand}:${s.panePath || ''}`
    : (s.paneTitle || `pw-${s.id.slice(-6)}`);
  return (
    <button key={s.id} onClick={() => pickExisting(s.id)} title={s.id}>
      {label}
    </button>
  );
})}
```

### Tmux Button (lines 173-176)
```typescript
{s.name}
<span style="float:right;opacity:0.5;font-size:10px">
  {s.windows}w{s.attached ? ' \u2022' : ''}
</span>
```

## Related Components to Study

1. **AddAppModal.tsx** - Modal overlay pattern with multiple states
2. **ShortcutHelpModal.tsx** - Simpler modal with grouped content
3. **AgentTerminal.tsx** - WebSocket communication with terminal sessions
4. **SessionViewToggle.tsx** - Session view mode management
5. **PopoutPanel.tsx** - Floating panel management and z-index handling
