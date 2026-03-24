# Cmd-K / Search Modal Implementation - Prompt Widget Admin UI

## Overview
The prompt-widget admin UI implements a command palette / spotlight search modal accessible via Cmd+K (Mac) or Ctrl+Shift+Space. This provides fast navigation and discovery across applications, feedback items, and agent sessions.

## Architecture

### Two-Mode Search System

The admin UI actually implements **two separate search/picker systems**:

#### 1. **SpotlightSearch** (Cmd+K / Ctrl+Shift+Space)
Main global search modal for applications, feedback, and sessions.
- **File**: `packages/admin/src/components/SpotlightSearch.tsx`
- **Triggered by**: 
  - Cmd+K (Mac) - registered in Layout.tsx line 260-265
  - Ctrl+Shift+Space (any platform) - registered in Layout.tsx line 252-259
- **Functionality**: Search and navigate to applications, feedback items, and agent sessions
- **Features**:
  - Debounced API search for feedback (200ms)
  - Local in-memory search for apps and sessions
  - Recent results history (10 items max)
  - Keyboard navigation (arrow keys, Enter, Escape)
  - Type-based result grouping (Applications, Sessions, Feedback)
  - Auto-scrolls selected item into view

#### 2. **TerminalPicker** (Terminal/Companion Launcher)
Modal for picking or creating terminal sessions and companions.
- **File**: `packages/admin/src/components/TerminalPicker.tsx`
- **Triggered by**: Various context actions
- **Modes**:
  - `{ kind: 'new' }` - Create new terminal/Claude session
  - `{ kind: 'companion'; sessionId }` - Attach companion to existing session
  - `{ kind: 'url' }` - Open URL in iframe
  - `{ kind: 'claude' }` - Create interactive Claude session
- **Functionality**:
  - Lists recent terminals, remote machines, harnesses, open terminals, tmux sessions, isolated components
  - Filters by query in title/subtitle
  - Smart categorization and MRU (Most Recently Used) ordering
  - Auto-detects URL inputs and prepends iframe opener
  - Loads tmux sessions via API

---

## Implementation Details

### SpotlightSearch (Cmd+K)

#### File: `packages/admin/src/components/SpotlightSearch.tsx`

**State Management:**
```typescript
- query: string (search input)
- results: SearchResult[] (combined application, session, feedback results)
- selectedIndex: number (keyboard navigation cursor)
- loading: boolean (feedback API search in progress)
- recentResults: Signal from settings.js (10-item history)
```

**Search Algorithm:**
```
1. Local search (instant):
   - Applications: match by name or ID
   - Sessions: match by custom label, feedback title, pane command/path/title, or session ID
   
2. API search (debounced 200ms):
   - Feedback items: search parameter sent to `/api/v1/admin/feedback?search=query&limit=10`
   - Results replace previous feedback results, keeping apps/sessions
```

**Result Types:**
```typescript
interface SearchResult {
  type: 'application' | 'feedback' | 'session'
  id: string
  title: string
  subtitle?: string
  icon: string                    // Unicode emoji
  route: string                   // Navigation path (for non-session results)
}
```

**Keyboard Navigation:**
- Arrow Up/Down: Move selection
- Enter: Navigate to selected result or open session
- Escape: Close modal

**Recent Results:**
- Automatically tracked in `recentResults` signal (localStorage via settings.js)
- Shows when query is empty
- Includes "Clear" button to reset history

**Result Grouping:**
```
Order: [Applications, Sessions, Feedback]
Grouped by type with category headers
```

#### Integration in Layout.tsx

**Lines 260-266 (Cmd+K shortcut registration):**
```typescript
registerShortcut({
  key: 'k',
  modifiers: { meta: true },    // Cmd on Mac, ignored on other platforms
  label: 'Spotlight search',
  category: 'General',
  action: () => setShowSpotlight((v) => !v),
})
```

**Lines 252-259 (Ctrl+Shift+Space shortcut registration):**
```typescript
registerShortcut({
  key: ' ',
  code: 'Space',
  modifiers: { ctrl: true, shift: true },
  label: 'Spotlight search',
  category: 'General',
  action: () => setShowSpotlight((v) => !v),
})
```

**Lines 1216 (Conditional render in Layout):**
```typescript
{showSpotlight && <SpotlightSearch onClose={() => setShowSpotlight(false)} />}
```

**Companion mode support (App.tsx lines 34-37):**
Iframes/companion windows can trigger Cmd+K via postMessage:
```typescript
if (e.metaKey && e.key === 'k') {
  e.preventDefault();
  window.parent.postMessage({ type: 'pw-companion-shortcut', key: 'cmd+k' }, '*');
}
```

**Receiving in Layout.tsx (lines 592-604):**
```typescript
useEffect(() => {
  function onMessage(e: MessageEvent) {
    if (e.data?.type !== 'pw-companion-shortcut') return;
    if (e.data.key === 'cmd+k' || e.data.key === 'ctrl+shift+space') {
      setShowSpotlight((v) => !v);
    } else if (e.data.key === 'escape') {
      setShowShortcutHelp(false);
      setShowSpotlight(false);
    }
  }
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}, []);
```

---

### TerminalPicker Modal

#### File: `packages/admin/src/components/TerminalPicker.tsx`

**Purpose**: Unified interface for launching or attaching terminals and companions

**Modes & Use Cases:**

1. **New Terminal** (`kind: 'new'`)
   - Spawn fresh terminal session
   - Optionally on remote machine or inside harness
   - Can be plain terminal or interactive Claude session

2. **Companion** (`kind: 'companion'; sessionId`)
   - Attach a terminal companion to an existing agent session
   - Shows available terminals to attach as companion pane

3. **URL** (`kind: 'url'`)
   - Simple input for entering a URL to open in iframe companion
   - Simpler interface than main picker (just input + icon)

4. **Claude** (`kind: 'claude'`)
   - Create an interactive Claude session
   - Used for design assist and setup assist features

**Result Categorization** (in order):
1. New Session (always first)
2. Recent (5 most recently used, MRU ordered)
3. Remote Machines (from dispatch targets)
4. Harnesses (from dispatch targets)
5. Open Terminals (all live terminals except recent ones)
6. Tmux Sessions (from backend)
7. Isolated Components
8. Open URL... (iframe option)

**Data Loading:**
```typescript
- Uses `cachedTargets` signal from DispatchTargetSelect.js
  (loaded by ensureTargetsLoaded())
- Fetches tmux sessions via api.listTmuxSessions()
  (shows loading spinner while fetching)
```

**URL Mode Special Logic (lines 99-136):**
```typescript
// If query looks like URL (http:// or https://), 
// prepend "Open in iframe" result
if (/^https?:\/\//i.test(query.trim())) {
  urlItem = { /* ...prepend to results */ }
}
```

**Filtering:**
- Filters all items by query against title + subtitle
- URL detection overrides normal filtering

**Actions on Selection:**
```typescript
pickNew(launcherId?, harnessConfigId?)
  → spawnTerminal(appId, launcherId, harnessConfigId, ...)
  → if in companion mode: setTerminalCompanionAndOpen()

pickExisting(termSessionId)
  → if in companion mode: setTerminalCompanionAndOpen()
  → else: openSession(termSessionId)

pickTmux(tmuxName)
  → attachTmuxSession(tmuxName, ...)
  → if in companion mode: setTerminalCompanionAndOpen()

submitUrl(url)
  → openUrlCompanion(url)
```

---

## AI Assist Button

#### File: `packages/admin/src/components/AiAssistButton.tsx`

**Overview**: Small chat bubble icon that opens a popover for requesting AI design assistance.

**Location**: Used in various contexts (not part of Cmd+K, but related to AI features)

**Functionality:**
```typescript
- Icon: SVG chat bubble (13x13px)
- On click: Opens AiAssistPopover
- Popover includes:
  - Header: "AI Assist" + context label
  - Textarea: "What would you like to change?" placeholder
  - Footer: "Go" button + Cmd+Enter hint

- On submit:
  - Calls api.designAssist(appId, { request, context, settingPath })
  - Opens the resulting session
  - Reloads all sessions
  - Closes popover
```

**API Call** (from api.ts line 159-163):
```typescript
designAssist: (appId: string, data: { request: string; context: string; settingPath?: string }) =>
  request<{ sessionId: string; feedbackId: string }>(`/admin/applications/${appId}/design-assist`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
```

**Popover Positioning:**
- Calculates position relative to trigger button
- Offset: 8px above, centered horizontally
- Updates on scroll/resize
- Click outside to close (except on button itself)

---

## Styling

#### CSS Classes (from app.css):

**Spotlight Container** (lines 6171-6362):
```css
.spotlight-overlay
  - Modal backdrop (dark overlay with fade-in animation)
  
.spotlight-container
  - Main modal box (white, rounded, shadow)
  - Slide-down animation from top
  
.spotlight-input-row
  - Input container with icon, input, keyboard hint
  
.spotlight-input
  - Large text input, 14px font, full width
  
.spotlight-results
  - Scrollable result list
  
.spotlight-category
  - Section header (12px, muted text)
  
.spotlight-result
  - Individual result item (padding, hover highlight)
  - Highlight on selection (blue bg)
  
.spotlight-result-icon
  - Emoji icon (20px)
  
.spotlight-result-text
  - Flex column with title + subtitle
  
.spotlight-result-type
  - Small label in result (applications/sessions/feedback)
  
.spotlight-empty
  - "No results found" message
  
.spotlight-spinner
  - Loading spinner animation
  
.spotlight-esc
  - Keyboard hint badge (right side)
```

**Animation Timings:**
- Modal fade-in: 100ms ease-out
- Container slide-down: 150ms ease-out
- Selected item auto-scroll: `block: 'nearest'` (instant)

---

## Keyboard Shortcuts System

#### File: `packages/admin/src/lib/shortcuts.ts`

**Architecture:**
- Global singleton `registry: Shortcut[]`
- Capture-phase keydown listener on document
- `registerShortcut()` adds to registry, returns cleanup function
- Handles:
  - Direct single-key shortcuts
  - Two-key sequences (e.g., "g f" for Go to Feedback)
  - Modifier combinations (Ctrl, Shift, Alt, Meta)
  - Sticky mode (Ctrl+Shift triple-tap for hands-free operations)
  - Xterm protection (prevents shortcuts when typing in terminal)

**Spotlight Special Cases** (lines 72-88):
```typescript
// Spotlight (Cmd+K or Ctrl+Shift+Space) works from ANY input context
if (ctrlOrMeta && shiftHeld && e.code === 'Space') { /* allow through */ }
else if (ctrlOrMeta && e.key === 'k') { /* allow through */ }
else { /* normal input blocking applies */ }
```

This means you can press Cmd+K even when typing in a textarea or input field.

**All Shortcuts Registered in Layout.tsx:**
```
General:
  ? → Show keyboard shortcuts
  t → Toggle theme
  Esc → Close modals
  Cmd+K → Spotlight search
  Ctrl+Shift+Space → Spotlight search

Navigation (g sequences):
  g f → Go to Feedback
  g a → Go to Agents
  g g → Go to Aggregate
  g s → Go to Sessions
  g l → Go to Live
  g p → Go to Preferences

Panels (Ctrl+Shift combinations):
  Ctrl+\ → Toggle sidebar
  Backquote → Toggle terminal panel
  Ctrl+Shift+~ → Toggle terminal panel
  Ctrl+Shift+Arrows → Navigate between pages/tabs
  Ctrl+Shift+Digits → Tab switching
  Ctrl+Shift+J → Toggle jump panel

And more for terminal management...
```

---

## Settings & Persistence

#### File: `packages/admin/src/lib/settings.ts`

**Search-Related Signals:**
```typescript
export const recentResults = signal<RecentResult[]>([])

interface RecentResult {
  type: 'application' | 'feedback' | 'session'
  id: string
  title: string
  subtitle?: string
  icon: string
  route: string
}
```

**Persistence:**
- Stored in localStorage (via Preact signals sync)
- Limited to 10 most recent items
- Automatically updated when selecting a result
- Includes "Clear" button in UI

---

## API Endpoints Used

**From packages/admin/src/lib/api.ts:**

```typescript
// Search feedback (used by SpotlightSearch)
getFeedback: (params: Record<string, string | number> = {})
  - GET /api/v1/admin/feedback
  - Supports: search, appId, status, limit, page

// Load applications
getApplications: () 
  - GET /api/v1/admin/applications
  - Returns: { id, name, projectDir, ... }

// Load agent sessions (for session search results)
// Sessions are loaded globally via polling in sessions.js

// Spawn new terminal
spawnTerminal: (data?: { cwd?, appId?, launcherId?, harnessConfigId?, permissionProfile?, tmuxTarget? })
  - POST /api/v1/admin/terminal
  - Returns: { sessionId }

// Load dispatch targets (machines + harnesses)
getDispatchTargets: ()
  - GET /api/v1/admin/dispatch-targets
  - Used by TerminalPicker for machine/harness selection

// List tmux sessions
listTmuxSessions: ()
  - GET /api/v1/admin/tmux-sessions
  - Returns: { sessions: [{ name, windows, created, attached }] }

// Attach to existing tmux
attachTmuxSession: (data: { tmuxTarget, appId? })
  - POST /api/v1/admin/terminal/attach-tmux
  - Returns: { sessionId }

// AI Assist
designAssist: (appId, data: { request, context, settingPath? })
  - POST /api/v1/admin/applications/{appId}/design-assist
  - Returns: { sessionId, feedbackId }
```

---

## Integration Points

### 1. Global Usage
- **Main Layout** renders SpotlightSearch conditionally at line 1216
- **Shortcut registration** happens in useEffect in Layout.tsx (lines 200-588)
- **Theme persistence** and other settings loaded from settings.ts

### 2. Session Management
- SpotlightSearch can open sessions via `openSession(sessionId)`
- TerminalPicker spawns new sessions via `spawnTerminal()`
- Both integrate with `allSessions` signal and session lifecycle

### 3. Companion Mode
- App.tsx detects Cmd+K in iframes and sends postMessage to parent
- Layout receives message and toggles spotlight search
- SpotlightSearch can open companions via result navigation

### 4. AI Features
- AiAssistButton calls `designAssist()` API
- Opens the resulting session for interaction
- Used in multiple contexts (feedback, aggregate, etc.)

---

## Data Flow Diagram

```
User presses Cmd+K or Ctrl+Shift+Space
    ↓
shortcuts.ts handleKeyDown() matches registered shortcut
    ↓
Layout.tsx action: setShowSpotlight(true)
    ↓
SpotlightSearch component mounts
    ↓
Input focused (useEffect)
    ↓
User types query
    ↓
Local search triggers:
  - Applications: filter by name/id (instant)
  - Sessions: filter by custom label/feedback title/command/id (instant)
    ↓
API search triggers (debounced 200ms):
  - Feedback: GET /api/v1/admin/feedback?search=query&limit=10
    ↓
Results grouped by type and displayed
    ↓
User navigates with arrow keys or mouse
    ↓
User presses Enter or clicks result
    ↓
Result action:
  - Session: openSession(id) → opens in left sidebar
  - App/Feedback: navigate(route) → changes page
    ↓
Recent result tracked in recentResults signal
    ↓
SpotlightSearch closes (onClose callback)
```

---

## UX Features

1. **Always-Available**: Works from any input field (special case in shortcuts.ts)
2. **Fast Local Search**: Apps and sessions search instantly
3. **Debounced API Search**: Feedback search waits 200ms to avoid query spam
4. **Recent Results**: Shows 10 most recent selections when query is empty
5. **Auto-Scroll**: Selected item scrolls into view automatically
6. **Type-Based Grouping**: Results organized by category with headers
7. **Keyboard-First**: Full keyboard navigation, no mouse required
8. **Visual Feedback**: Hover + keyboard selection both highlight items
9. **Emoji Icons**: Quick visual identification of result types
10. **Loading State**: Spinner shows while API search is pending

---

## Notes for Development

### Key Files to Modify:
- `SpotlightSearch.tsx` - Core search logic and UI
- `Layout.tsx` - Shortcut registration (lines 260-265, 252-259)
- `TerminalPicker.tsx` - Terminal/companion selection
- `shortcuts.ts` - Keyboard event handling
- `AiAssistButton.tsx` - AI assist popover
- `api.ts` - Backend API calls

### Adding New Search Types:
1. Define new SearchResult interface
2. Add search logic in SpotlightSearch search() function
3. Update groupResults() for result categorization
4. Add new route/action in selectResult()

### Styling:
- CSS lives in `app.css` (lines 6171-6362 for spotlight)
- Use CSS variables: `--pw-*` (text, bg, borders, etc.)
- Animations use `@keyframes` for fade-in and slide-down

### Testing Considerations:
- Test Cmd+K and Ctrl+Shift+Space separately
- Verify search works from input fields
- Test API debouncing (200ms delay for feedback)
- Verify companion iframe Cmd+K forwarding
- Check recent results persistence across page reloads
