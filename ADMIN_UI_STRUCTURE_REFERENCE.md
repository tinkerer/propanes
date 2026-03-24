# Admin UI File Structure & Code References

## Directory Tree

```
packages/admin/src/
├── main.tsx                          # Entry point - renders <App /> to #app
├── app.css                           # All component styles
│
├── pages/                            # Page components (one per URL route)
│   ├── LoginPage.tsx
│   ├── GettingStartedPage.tsx
│   ├── ApplicationsPage.tsx          # (deprecated)
│   ├── ApplicationSettingsPage.tsx
│   ├── FeedbackListPage.tsx
│   ├── FeedbackDetailPage.tsx
│   ├── AggregatePage.tsx
│   ├── SessionsPage.tsx
│   ├── AgentsPage.tsx
│   ├── LiveConnectionsPage.tsx
│   ├── UserGuidePage.tsx
│   ├── SettingsPage.tsx
│   ├── InfrastructurePage.tsx
│   └── StandaloneSessionPage.tsx
│
├── components/                       # Reusable UI components
│   ├── App.tsx                       # Root routing & auth check
│   ├── Layout.tsx                    # Main shell (sidebar + content + panel)
│   │
│   ├── # Terminal Panel & Sessions
│   ├── GlobalTerminalPanel.tsx       # Bottom docked panel - MAIN PANEL
│   ├── PopoutPanel.tsx               # Floating windows
│   ├── PaneHeader.tsx                # Tab headers
│   ├── PaneTabBar.tsx                # Tab bar
│   │
│   ├── # Companion Views (rendered in panel)
│   ├── FeedbackCompanionView.tsx     # Feedback detail
│   ├── IframeCompanionView.tsx       # URL/page iframe
│   ├── TerminalCompanionView.tsx     # Terminal/tmux
│   ├── IsolateCompanionView.tsx      # Isolated component
│   ├── JsonlView.tsx                 # JSONL conversation
│   │
│   ├── # Message Display (inside JSONL/Terminal)
│   ├── StructuredView.tsx            # Grouped messages
│   ├── MessageRenderer.tsx           # Individual message (15+ tool types)
│   ├── SessionViewToggle.tsx         # Terminal/Structured/Split toggle
│   ├── AgentTerminal.tsx             # Terminal output
│   │
│   ├── # Modals & Popovers
│   ├── AddAppModal.tsx               # App creation/registration
│   ├── DispatchDialog.tsx            # Feedback dispatch modal
│   ├── ShortcutHelpModal.tsx         # Keyboard shortcuts
│   ├── TerminalPicker.tsx            # Terminal/companion picker (spotlight)
│   ├── SpotlightSearch.tsx           # Global search/command palette
│   │
│   ├── # AI Assist Components
│   ├── AiAssistButton.tsx            # Inline AI popup
│   ├── SetupAssistButton.tsx         # Infrastructure setup popup (draggable)
│   │
│   ├── # Dispatch & Selection
│   ├── DispatchPicker.tsx            # Agent/harness selector
│   ├── DispatchTargetSelect.tsx      # Target selector dropdown
│   ├── DirPicker.tsx                 # Directory picker
│   │
│   ├── # Utility Components
│   ├── ControlBar.tsx                # Control buttons
│   ├── RequestPanel.tsx              # Request input panel
│   ├── FileViewerPanel.tsx           # File viewer/explorer
│   ├── CropEditor.tsx                # Screenshot crop tool
│   ├── PerfOverlay.tsx               # Performance metrics
│   ├── Tooltip.tsx                   # Tooltip UI
│   ├── HintToast.tsx                 # Hint notifications
│   ├── AutoFixToast.tsx              # Autofix status
│   ├── DeletedItemsPanel.tsx         # Restore deleted items
│   └── Guide.tsx                     # Guide/tutorial content
│
└── lib/
    ├── state.js                      # Global auth/route state
    ├── sessions.js                   # Session/panel state (LARGE)
    ├── api.js                        # Backend API client
    ├── settings.js                   # User preference signals
    ├── shortcuts.js                  # Keyboard shortcut handling
    ├── perf.js                       # Performance tracking
    ├── output-parser.ts              # JSONL & terminal parsing
    ├── isolate.js                    # Isolated component system
    └── [others]
```

---

## Key Components Explained

### 1. App.tsx (Entry Point)
```
Location: /packages/admin/src/components/App.tsx
Size: ~175 lines
Purpose: Route parsing & page selection
```

**What it does:**
- Checks `isAuthenticated.value`
- Parses URL routes with `parseAppRoute()`
- Renders appropriate page based on route
- Wraps in `Layout` for authenticated users
- Renders `LoginPage` for unauthenticated users

**Key signals from imports:**
- `isAuthenticated`, `currentRoute`, `navigate`, `selectedAppId`, `applications`

---

### 2. Layout.tsx (Main Shell)
```
Location: /packages/admin/src/components/Layout.tsx
Size: ~61.7 KB (very large)
Purpose: Main UI shell with sidebar, content, panel, popouts
```

**Structure:**
```
<Layout>
  ├── Sidebar (collapsible)
  │   ├── App switcher dropdown
  │   ├── App-specific nav links
  │   └── Global nav (Agents, Settings, Guides)
  │
  ├── Main Content Area
  │   └── {page component renders here}
  │
  ├── Bottom Panel (GlobalTerminalPanel)
  │   ├── Tab bar
  │   └── Active companion view (JSONL, Feedback, Iframe, Terminal)
  │
  ├── Floating Windows (PopoutPanel)
  │   └── Additional session windows
  │
  └── Overlays
      ├── Tooltips
      ├── Toasts
      ├── Modals
      └── Drag handles
```

**Key signals:**
- `sidebarCollapsed`, `sidebarWidth`, `selectedAppId`
- `openTabs`, `activeTabId`, `panelHeight`, `panelMinimized`
- `popoutPanels`, `popoutIdMenuOpen`, `popoutWindowMenuOpen`

---

### 3. GlobalTerminalPanel.tsx (Bottom Panel Hub)
```
Location: /packages/admin/src/components/GlobalTerminalPanel.tsx
Size: ~52.8 KB (HUGE - the biggest component)
Purpose: Renders tabs and companions (JSONL, Feedback, Iframe, Terminal)
```

**Features:**
1. **Tab Management**
   - `openTabs` - Array of tab IDs like `['jsonl:abc123', 'terminal:def456']`
   - `activeTabId` - Currently visible tab
   - Tab switching via keyboard (1-9 shortcuts)

2. **Companion Types**
   ```typescript
   type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url';
   // Tab ID format: '<type>:<identifier>'
   ```

3. **View Modes**
   - Terminal view (raw output)
   - Structured view (parsed messages)
   - Split view (side-by-side)

4. **Split View**
   - `splitEnabled` - Left/right panes
   - `leftPaneTabs` / `rightPaneTabs`
   - `splitRatio` - Drag-to-resize

5. **Panel State**
   - `panelHeight` - Bottom panel height (resizable)
   - `panelMinimized` - Minimize/expand button
   - `panelMaximized` - Fullscreen companion
   - `persistPanelState()` - Save to localStorage

**How it renders tabs:**
```typescript
// Pseudo-code
if (companion.type === 'jsonl') return <JsonlView />;
if (companion.type === 'feedback') return <FeedbackCompanionView />;
if (companion.type === 'terminal') return <TerminalCompanionView />;
if (companion.type === 'iframe') return <IframeCompanionView />;
// ... etc
```

---

### 4. JsonlView.tsx (Message Viewer)
```
Location: /packages/admin/src/components/JsonlView.tsx
Size: ~Medium (message loading + parsing)
Purpose: Load, parse, display Claude conversations
```

**Key features:**
- Loads JSONL files from API with polling
- Two parsers:
  1. `JsonOutputParser` - Structured JSON from `--output-format stream-json`
  2. `TerminalOutputParser` - Heuristic CLI output parsing
- Three view modes: Terminal, Structured, Split
- File filter dropdown
- Message grouping (assistant groups tools together)

---

### 5. StructuredView.tsx (Message Grouping)
```
Location: /packages/admin/src/components/StructuredView.tsx
Purpose: Group messages by type, show tool counts, token usage
```

**Message grouping logic:**
- Assistant messages grouped with their tools
- Shows token count and tool count per group
- User inputs standalone
- System messages standalone
- Click to expand/collapse

---

### 6. MessageRenderer.tsx (Message Display)
```
Location: /packages/admin/src/components/MessageRenderer.tsx
Size: Large (15+ tool renderers)
Purpose: Render individual messages and tool results
```

**Supported tool renders:**
1. Bash output (code block)
2. Edit (before/after diff)
3. Write/Read (syntax highlighted code)
4. Glob (file list)
5. Grep (search results)
6. WebFetch/WebSearch (markdown + images)
7. Task tools (task details)
8. AskUserQuestion (user input)
9. Skill invocation
10. +5 more...

**Features:**
- Syntax highlighting with Prism
- Image thumbnails with lightbox
- Auto-truncate long output with expand button
- Base64/URL image detection

---

### 7. AiAssistButton.tsx (Inline Assistant)
```
Location: /packages/admin/src/components/AiAssistButton.tsx
Size: ~130 lines
Purpose: Small popover for page-specific AI help
```

**Flow:**
1. User clicks button → popover appears
2. User types request → submit with Cmd+Enter
3. Call `api.designAssist(appId, { request, context })`
4. Get back `{ sessionId }`
5. `openSession(sessionId)` - opens tab
6. `loadAllSessions()` - refresh session list
7. Popover closes

**Used on:**
- Feedback detail page
- Aggregate page
- App settings page

---

### 8. SetupAssistButton.tsx (Infrastructure Assistant)
```
Location: /packages/admin/src/components/SetupAssistButton.tsx
Size: ~250 lines
Purpose: Draggable popover for infrastructure setup with presets
```

**Flow:**
1. User clicks button → draggable popover appears
2. Shows preset buttons (entity-specific presets)
3. User clicks preset or types custom request
4. Call `api.setupAssist({ request, entityType, entityId })`
5. Get back `{ sessionId }`
6. Fire-and-forget async:
   - `loadAllSessions()`
   - `openSession(sessionId)`
7. Popover closes immediately

**Features:**
- Draggable header (can move anywhere)
- Viewport clamping (doesn't go off-screen)
- Preset buttons for common tasks
- Different presets for new vs existing entities
- Entities: machine, harness, agent, sprite

**Used on:**
- Infrastructure page
- Settings pages

---

### 9. AddAppModal.tsx (Reference Pattern)
```
Location: /packages/admin/src/components/AddAppModal.tsx
Size: ~213 lines
Purpose: Modal for app creation/registration (GOOD PATTERN REFERENCE)
```

**Pattern:**
1. Initial view: Three card buttons (Create, Existing, Clone)
2. Mode selection sets state (`mode = 'create' | 'existing' | 'clone'`)
3. Form with fields specific to mode
4. Submit handler calls API
5. Success state shows result + code snippet
6. Copy-to-clipboard with visual feedback

**Reusable pattern:**
```typescript
const [mode, setMode] = useState<Mode>(null);
// null → card selection
// 'create' | 'existing' | 'clone' → forms
// success state after submit

if (success) {
  // Show result view
} else if (mode === null) {
  // Show card selection
} else {
  // Show mode-specific form
}
```

---

## State Management

### Global State Files

#### 1. lib/state.js
```
Auth & Navigation State

Signals:
- isAuthenticated: boolean
- currentRoute: string (e.g. '/app/abc123/feedback')
- selectedAppId: string | null
- applications: Application[]
- loadApplications(): Promise<void>
- navigate(route: string): void
- clearToken(): void

Changes:
- setInterval polling for session updates
- localStorage persistence for route
```

#### 2. lib/sessions.js (HUGE - 50+ signals)
```
Session & Panel State - THE BIG STATE FILE

Key signals:
- openTabs: string[] - Array of open tab IDs
- activeTabId: string | null - Currently visible tab
- allSessions: Session[] - All agent sessions
- exitedSessions: Set<string> - Completed sessions

Panel state:
- panelHeight: number - Bottom panel height
- panelMinimized: boolean
- panelMaximized: boolean
- panelZOrders: Map<string, number> - Z-index tracking
- sidebarCollapsed: boolean
- sidebarWidth: number

Split view:
- splitEnabled: boolean
- leftPaneTabs: string[]
- rightPaneTabs: string[]
- splitRatio: number (0-1)

Companion state:
- openCompanions: Map<string, CompanionType[]>
- terminalCompanionMap: Map<string, string>
- termPickerOpen: signal<TermPickerState | null>

Session labels & colors:
- sessionLabels: Map<string, string>
- sessionColors: Map<string, string>

Polling & polling:
- startSessionPolling(): void
- allNumberedSessions: Session[] (numbered 1-9)

Key functions:
- openSession(sessionId): void
- toggleCompanion(sessionId, type): void
- openUrlCompanion(url): void
- closeTab(tabId): void
- deleteSession(sessionId): void
- focusSessionTerminal(sessionId): void
- persistPanelState(): void
- bringToFront(panelId): void
```

#### 3. lib/settings.js
```
User Preferences State

Signals:
- toggleTheme: boolean
- showTabs: boolean
- arrowTabSwitching: boolean
- showHotkeyHints: boolean
- autoJumpWaiting: boolean
- autoJumpInterrupt: boolean
- autoJumpDelay: number
- autoCloseWaitingPanel: boolean

Sync:
- Saved to localStorage
- Loaded on app init
```

#### 4. lib/api.js
```
Backend API Client

Methods:
- designAssist(appId, { request, context }): Promise<{ sessionId }>
- setupAssist({ request, entityType, entityId }): Promise<{ sessionId }>
- getAgentSessions(options): Promise<Session[]>
- getApplications(): Promise<Application[]>
- ... many more
```

---

## Routing & Navigation

### URL Routes (from App.tsx)

```
Public:
/login

Authenticated:
/                           → Redirect to /app/{appId}/feedback

App-specific routes:
/app/{appId}/feedback       → FeedbackListPage
/app/{appId}/feedback/{id}  → FeedbackDetailPage
/app/{appId}/sessions       → SessionsPage
/app/{appId}/aggregate      → AggregatePage
/app/{appId}/live           → LiveConnectionsPage
/app/{appId}/settings       → AppSettingsPage

Global settings:
/settings/agents            → AgentsPage
/settings/getting-started   → GettingStartedPage
/settings/user-guide        → UserGuidePage
/settings/preferences       → SettingsPage
/settings/infrastructure    → InfrastructurePage

Session routes:
/session/{sessionId}        → StandaloneSessionPage (full-screen)
/feedback/{id}              → FeedbackDetailPage (legacy, redirects)

Route navigation:
navigate('/app/abc123/feedback')
```

### Tab ID Format

```
Tab ID = '<type>:<identifier>'

Examples:
jsonl:abc123                 → JSONL companion for session abc123
feedback:abc123             → Feedback companion for session abc123
terminal:abc123             → Terminal companion for session abc123
iframe:abc123               → Iframe companion for session abc123
isolate:ComponentName       → Isolated component ComponentName
url:https://example.com     → Arbitrary URL
admin-assist:context        → Admin chat (TO BE ADDED)
```

---

## CSS Architecture

### Main Styles File
```
Location: /packages/admin/src/app.css
Contains: All component styles (generated from components)

Key classes:
- .pw-layout - Main container
- .pw-sidebar - Left sidebar
- .pw-main - Main content area
- .pw-panel - Bottom docked panel
- .pw-tab-bar - Tab navigation
- .pw-tab-content - Tab content area
- .pw-popout - Floating window
- .pw-modal, .modal-overlay - Modal styles
- .ai-assist-popover - Popover styling
- .ai-assist-header, .ai-assist-body, .ai-assist-footer
- .btn, .btn-primary, .btn-sm - Button styles
- .request-panel-textarea - Textarea styling
- .form-group, .form-error - Form element styles
```

### Dark Mode
```
CSS variables (set in theme toggle):
--pw-bg-primary
--pw-bg-secondary
--pw-text-primary
--pw-text-secondary
--pw-text-muted
--pw-border-color
--pw-accent-color
```

---

## Summary of Key Connections

### To Open a Session in a Tab
```typescript
import { openSession, loadAllSessions } from '../lib/sessions.js';

const { sessionId } = await api.setupAssist({ request, entityType });
await loadAllSessions();
openSession(sessionId);  // Adds to openTabs, sets activeTabId
```

### To Render Custom Content in Bottom Panel
```typescript
// In GlobalTerminalPanel.tsx, in the renderTabContent() function:
case 'admin-assist': {
  return <AdminAssistCompanion tabId={tabId} />;
}

// Tab ID format: 'admin-assist:context'
// Will be called with tabId = 'admin-assist:admin-help'
```

### To Add a Default Tab on App Load
```typescript
// In GlobalTerminalPanel or Layout, useEffect on mount:
useEffect(() => {
  if (openTabs.value.length === 0) {
    openTabs.value = ['admin-assist:welcome'];
    activeTabId.value = 'admin-assist:welcome';
  }
}, []);
```

---

## Next Steps

1. **Create AdminAssistCompanion.tsx**
   - Component to render in bottom panel
   - Chat UI with message history + input
   - API integration for sending requests

2. **Update lib/sessions.ts**
   - Add `'admin-assist'` to CompanionType union
   - Update `extractCompanionType()` to parse it
   - Update `renderTabContent()` to render it

3. **Update GlobalTerminalPanel.tsx**
   - Auto-open `'admin-assist:welcome'` tab on first load
   - Import and render the new component

4. **Update app.css** (if needed)
   - Add styles for chat UI
   - Follows existing `.ai-assist-*` pattern

