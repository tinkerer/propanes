# Admin UI Structure - Chat Box Integration Analysis

## Overview
This document provides a complete map of the admin UI structure for implementing an "admin assist chat box" as a default panel.

---

## 1. Main Pages Directory

### Location
`/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/`

### All Pages (14 total)
1. **GettingStartedPage.tsx** - Initial setup guide
2. **LoginPage.tsx** - Authentication
3. **ApplicationsPage.tsx** - App list management (deprecated, redirects to AppSettingsPage)
4. **AgentsPage.tsx** - Global agent configuration
5. **AggregatePage.tsx** - Clustered feedback view
6. **AppSettingsPage.tsx** - Individual app settings
7. **LiveConnectionsPage.tsx** - Active widget sessions
8. **FeedbackListPage.tsx** - Feedback list for an app
9. **UserGuidePage.tsx** - User documentation
10. **SessionsPage.tsx** - Session management for an app
11. **FeedbackDetailPage.tsx** - Single feedback item detail view
12. **StandaloneSessionPage.tsx** - Full-screen session view
13. **SettingsPage.tsx** - User preferences (theme, shortcuts, etc.)
14. **InfrastructurePage.tsx** - Machines, launchers, harnesses, sprites

---

## 2. App Component & Router (App.tsx)

### Location
`/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/App.tsx`

### Key Points
- **Entry point**: Checks authentication via `isAuthenticated.value`
- **Route parser**: `parseAppRoute()` extracts app routes like `/app/{appId}/feedback`
- **Routing logic**:
  - Routes starting with `/app/{appId}/` → app-specific pages
  - Routes starting with `/settings/` → global settings pages
  - Routes starting with `/session/` → standalone session view
  - Root `/` redirects to first app's feedback or settings

### Route Structure
```
/                              → Redirect to /app/{appId}/feedback
/app/{appId}/feedback          → FeedbackListPage
/app/{appId}/feedback/{id}     → FeedbackDetailPage
/app/{appId}/sessions          → SessionsPage
/app/{appId}/aggregate         → AggregatePage
/app/{appId}/live              → LiveConnectionsPage
/app/{appId}/settings          → AppSettingsPage
/settings/agents               → AgentsPage
/settings/getting-started      → GettingStartedPage
/settings/user-guide           → UserGuidePage
/settings/preferences          → SettingsPage
/settings/infrastructure       → InfrastructurePage
/session/{sessionId}           → StandaloneSessionPage
```

---

## 3. Layout Structure (Layout.tsx)

### Location
`/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/Layout.tsx`

### Architecture
The Layout component is the main shell that wraps all pages with:

- **Sidebar**: Collapsible navigation with app list, nav links
- **Main content area**: Where page components render
- **Bottom panel**: Terminal/session panel with companion tabs
- **Popout panels**: Floating/docked windows for sessions

### Key UI Elements
1. **Sidebar** (`sidebarCollapsed` signal, `sidebarWidth`)
   - App switcher dropdown
   - Navigation links (Feedback, Sessions, Aggregate, Live, Settings)
   - Global nav: Agents, Settings, Guides
   - Width configurable via drag handle

2. **Main Content** 
   - Full-height flex container
   - Shows current page component

3. **GlobalTerminalPanel**
   - Bottom docked panel with tabs
   - Shows JSONL, Feedback, Iframe, Terminal companions
   - Split view support (left/right panes)
   - Minimizable, resizable, draggable

4. **PopoutPanel**
   - Floating windows for sessions
   - Independent of docked panel
   - Z-order management with `panelZOrders` and `bringToFront()`

---

## 4. GlobalTerminalPanel Component

### Location
`/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/GlobalTerminalPanel.tsx`

### Size & Complexity
- **File size**: ~52.8 KB (very large)
- **Purpose**: Renders the bottom panel with session tabs and companions

### Key Features
1. **Tab management**:
   - `openTabs` signal: Array of open session IDs
   - `activeTabId` signal: Currently active tab
   - Tab navigation with keyboard shortcuts (1-9, arrows)

2. **Companion tabs** (multiple types):
   - `jsonl:<sessionId>` - JSONL conversation viewer
   - `feedback:<sessionId>` - Feedback detail view
   - `iframe:<sessionId>` - Page iframe
   - `terminal:<sessionId>` - Terminal companion
   - `isolate:<componentName>` - Isolated component
   - `url:<fullUrl>` - Arbitrary URL iframe

3. **Split view support**:
   - `splitEnabled` signal
   - `leftPaneTabs` / `rightPaneTabs` signals
   - `splitRatio` for drag-to-resize divider

4. **Panel state management**:
   - `panelHeight` - Resizable height
   - `panelMinimized` - Collapse/expand
   - `panelMaximized` - Full-screen companion

### Companion Rendering
The panel renders different content types via `renderTabContent()`:
- **Structured/Terminal/Split view** for JSONL (conversation)
- **FeedbackCompanionView** for feedback details
- **IframeCompanionView** for pages/URLs
- **TerminalCompanionView** for terminal/tmux sessions
- **IsolateCompanionView** for isolated components

---

## 5. Existing Chat/Assistant Components

### SetupAssistButton.tsx
**Purpose**: Draggable popover for infrastructure setup (machines, harnesses, agents, sprites)
- **Location**: Infrastructure, Settings pages
- **Features**:
  - Preset quick-action buttons for common tasks
  - Textarea for custom requests
  - Fires async request via `api.setupAssist()`
  - Opens session tab when complete
  - Draggable header with viewport clamping

### AiAssistButton.tsx
**Purpose**: Inline popup for page-specific AI assistance
- **Location**: Feedback detail page, aggregate page, app settings
- **Features**:
  - Positioned near trigger button
  - Textarea for requests
  - Fires async request via `api.designAssist()`
  - Opens session tab when complete
  - Closes on outside click

### Key Pattern
Both assistant buttons:
1. Open a popover/modal with textarea
2. Submit request to API (which spawns an agent session)
3. Load sessions via `loadAllSessions()`
4. Open the session tab via `openSession(sessionId)`
5. Close the popover

---

## 6. AddAppModal Component (Reference)

### Location
`/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/AddAppModal.tsx`

### Purpose
Modal for creating/registering apps - **GOOD REFERENCE FOR UI PATTERNS**

### Key Sections
1. **Initial view**: Three card buttons
   - Create Project
   - Existing Directory
   - Clone Repository

2. **Mode-specific forms** with DirPicker component
3. **Success state** with code snippet copy
4. **Error handling** with user feedback

### UI Patterns to Reuse
- Modal overlay + stopPropagation
- Multi-state FSM (null → create/existing/clone → success)
- DirPicker for file selection
- Button state management (loading, disabled)
- Copy-to-clipboard with visual feedback

---

## 7. Admin UI Components (All Components)

### Located in
`/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/`

### Complete List (33 components)
1. **App.tsx** - Root routing component
2. **Layout.tsx** - Main shell (sidebar + content + panel)
3. **GlobalTerminalPanel.tsx** - Bottom docked panel with tabs
4. **PopoutPanel.tsx** - Floating windows for sessions
5. **AddAppModal.tsx** - App creation/registration modal
6. **AiAssistButton.tsx** - Inline AI assist popover
7. **SetupAssistButton.tsx** - Infrastructure setup draggable popover
8. **TerminalPicker.tsx** - Spotlight/command palette for terminal selection
9. **SpotlightSearch.tsx** - Global search/command palette
10. **DirPicker.tsx** - Directory/file picker
11. **ShortcutHelpModal.tsx** - Keyboard shortcuts reference
12. **Tooltip.tsx** - Tooltip UI
13. **DispatchDialog.tsx** - Feedback dispatch modal
14. **DispatchPicker.tsx** - Agent/harness selection picker
15. **DispatchTargetSelect.tsx** - Select dispatch target
16. **ControlBar.tsx** - Control buttons area
17. **HintToast.tsx** - Hint notifications
18. **AutoFixToast.tsx** - Autofix status toast
19. **RequestPanel.tsx** - Request input panel
20. **PerfOverlay.tsx** - Performance metrics overlay
21. **FileViewerPanel.tsx** - File viewer/explorer
22. **CropEditor.tsx** - Screenshot crop tool
23. **JsonlView.tsx** - JSONL conversation viewer
24. **StructuredView.tsx** - Structured message display
25. **MessageRenderer.tsx** - Individual message rendering (15+ tool types)
26. **SessionViewToggle.tsx** - Terminal/Structured/Split view switch
27. **FeedbackCompanionView.tsx** - Feedback detail in companion
28. **IframeCompanionView.tsx** - URL/page iframe companion
29. **TerminalCompanionView.tsx** - Terminal/tmux companion
30. **IsolateCompanionView.tsx** - Isolated component companion
31. **AgentTerminal.tsx** - Terminal output display
32. **DeletedItemsPanel.tsx** - Restore deleted items
33. **Guide.tsx** - Guide/tutorial content

---

## 8. State Management (lib/state.js & lib/sessions.js)

### Global State
Located in `packages/admin/src/lib/`

#### Session & Panel State (`sessions.js`)
- `openTabs` - Array of open session IDs
- `activeTabId` - Currently focused tab
- `panelHeight` - Bottom panel height
- `panelMinimized` - Is panel minimized
- `panelMaximized` - Is companion full-screen
- `sidebarCollapsed` - Is sidebar collapsed
- `splitEnabled` - Split view active
- `leftPaneTabs` / `rightPaneTabs` - Split pane tabs
- `popoutPanels` - Array of floating windows
- `termPickerOpen` - Terminal picker modal state
- `terminalCompanionMap` - Terminal companion sessions

#### Navigation & Auth (`state.js`)
- `isAuthenticated` - Auth status
- `currentRoute` - Current URL route
- `selectedAppId` - Currently selected app
- `applications` - Loaded apps

### Key Functions
- `openSession(sessionId)` - Open a session tab
- `toggleCompanion(sessionId, type)` - Add companion tab
- `openUrlCompanion(url)` - Open URL companion
- `persistPanelState()` - Save panel layout to localStorage
- `closeTab(tabId)` - Close a tab
- `focusSessionTerminal(sessionId)` - Focus terminal
- `popOutTab(tabId)` - Move to floating panel

---

## 9. Where an "Admin Assist Chat Box" Could Go

### Option 1: Always-Visible Sidebar Chat (Best for Admin Context)
- **Location**: Right side of sidebar (new vertical panel)
- **Visibility**: Always visible in Layout.tsx
- **Content**: Admin context questions, infrastructure help, settings guidance
- **Integration**: Use SetupAssistButton pattern but permanent
- **Pros**: Always accessible, doesn't interfere with main content
- **Cons**: Uses horizontal space

### Option 2: Default Companion Tab in GlobalTerminalPanel
- **Location**: Bottom panel, auto-add a `chat:<context>` tab type
- **Visibility**: Always open when Layout renders
- **Content**: Contextual help based on current page
- **Integration**: Add new companion type `chat:admin`
- **Pros**: Follows existing UI pattern, integrated with other companions
- **Cons**: Competes with other tabs, can be closed

### Option 3: Floating Popover (Non-Modal)
- **Location**: Bottom-right corner or sidebar corner
- **Visibility**: Always visible, can minimize
- **Content**: Global admin assistant
- **Integration**: Similar to SetupAssistButton but persistent
- **Pros**: Non-intrusive, always accessible
- **Cons**: Floats over content

### Option 4: Toggle Button in Header/Sidebar
- **Location**: Top of sidebar or in ControlBar
- **Visibility**: Toggle to show/hide chat panel
- **Content**: Persistent chat window (side panel)
- **Integration**: New signal for `adminChatOpen` in state.js
- **Pros**: Clean, doesn't occupy space when hidden
- **Cons**: Requires extra click to access

### **Recommended**: Option 2 - Default Chat Companion Tab
This fits best with the existing architecture:

```typescript
// In GlobalTerminalPanel, auto-open a companion
if (!openTabs.value.includes('admin-assist')) {
  openTabs.value = ['admin-assist', ...openTabs.value];
  if (!activeTabId.value) activeTabId.value = 'admin-assist';
}
```

Create new companion type in `lib/sessions.ts`:
```typescript
type CompanionType = 
  | 'jsonl' 
  | 'feedback' 
  | 'iframe' 
  | 'terminal' 
  | 'isolate' 
  | 'url'
  | 'admin-assist';  // NEW
```

Render component in GlobalTerminalPanel:
```typescript
case 'admin-assist': {
  return <AdminAssistCompanion />;
}
```

---

## 10. Implementation Checklist

### Files to Modify
1. `packages/admin/src/lib/sessions.ts`
   - Add `admin-assist` to `CompanionType` union
   - Update `extractCompanionType()` to recognize `admin-assist:`
   - Update `renderTabContent()` to render admin assist view

2. `packages/admin/src/components/GlobalTerminalPanel.tsx`
   - Auto-open `admin-assist` tab on first load
   - Render admin assist companion in tab content

3. `packages/admin/src/components/PaneHeader.tsx` (if exists)
   - Label for `admin-assist` tab

4. Create `packages/admin/src/components/AdminAssistCompanion.tsx`
   - Chat UI component
   - Message history
   - Input textarea
   - API integration

### Files to Reference (Don't Modify)
- `AiAssistButton.tsx` - Popover pattern
- `SetupAssistButton.tsx` - Draggable pattern + presets
- `JsonlView.tsx` - Message rendering pattern
- `StructuredView.tsx` - Message grouping pattern
- `MessageRenderer.tsx` - Tool result rendering
- `AddAppModal.tsx` - Modal/form patterns

---

## 11. Key APIs & Integration Points

### From App to Session
```typescript
import { openSession, loadAllSessions } from '../lib/sessions.js';
import { api } from '../lib/api.js';

// Create session from admin assist request
const { sessionId } = await api.setupAssist({
  request: "user's question",
  entityType: 'admin',  // or custom
});

// Load updated sessions
await loadAllSessions();

// Open the session tab (optional - chat can be inline)
openSession(sessionId);
```

### Rendering Messages
Use `StructuredView` or `MessageRenderer` for Claude responses:
- `StructuredView.tsx` - Groups messages by type
- `MessageRenderer.tsx` - Renders individual tools + results
- `JsonlView.tsx` - Full JSONL conversation viewer

---

## 12. CSS Classes to Reuse

From `app.css` and component styles:
- `.ai-assist-popover` - Popover styling
- `.ai-assist-header` - Header with title
- `.ai-assist-body` - Content area
- `.ai-assist-footer` - Action buttons area
- `.request-panel-textarea` - Textarea styling
- `.btn`, `.btn-primary`, `.btn-sm` - Button styles
- `.modal`, `.modal-overlay` - Modal backdrop
- `.form-group`, `.form-error` - Form elements

---

## Summary

The admin UI is a Preact SPA with:
- **Routing**: URL-driven with app/settings/session routes
- **Layout**: Sidebar + main content + bottom panel + floating windows
- **Panels**: GlobalTerminalPanel manages tabs with multiple companion types
- **State**: Signals-based reactive state management
- **Patterns**: Modals, popovers, draggable windows, split views

**Best integration point**: GlobalTerminalPanel as a default `admin-assist` companion tab, following the existing JSONL/feedback/iframe/terminal pattern.

