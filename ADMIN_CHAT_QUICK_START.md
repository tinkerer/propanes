# Admin UI Chat Box - Quick Start Summary

## What I Found

You have a sophisticated Preact SPA admin dashboard with:

1. **14 pages** across app-specific and global settings routes
2. **33 reusable components** for modals, panels, and UI
3. **Signals-based state management** (Preact Signals)
4. **Bottom docked panel** (GlobalTerminalPanel) with tabs for sessions
5. **Multiple companion types**: JSONL (conversations), Feedback, Iframe, Terminal, Isolated components, URLs
6. **Two existing assistant components**: AiAssistButton (inline popover) and SetupAssistButton (draggable popover)

---

## Where to Put the Admin Chat Box

### Best Option: Default Companion Tab in Bottom Panel

The GlobalTerminalPanel already manages tabs like:
- `jsonl:sessionId` - JSONL conversation viewer
- `feedback:sessionId` - Feedback detail
- `terminal:sessionId` - Terminal companion
- `iframe:sessionId` - Page iframe

**Add a new companion type**: `admin-assist:welcome`

**Advantages:**
- Follows existing UI patterns perfectly
- Integrated with other companions
- Auto-opens in bottom panel like other tabs
- Reuses all panel features (split view, minimize, fullscreen, keyboard shortcuts)
- Can be closed/reopened like other tabs

---

## Files to Read (Reference Only - Don't Modify)

### Core Architecture
- `/packages/admin/src/components/App.tsx` (175 lines) - Router
- `/packages/admin/src/components/Layout.tsx` (61.7 KB) - Main shell
- `/packages/admin/src/components/GlobalTerminalPanel.tsx` (52.8 KB) - Bottom panel hub

### Existing Assistants (Great Patterns)
- `/packages/admin/src/components/AiAssistButton.tsx` (130 lines) - Inline popover pattern
- `/packages/admin/src/components/SetupAssistButton.tsx` (250 lines) - Draggable popover with presets

### Message Display (Reuse for Chat)
- `/packages/admin/src/components/JsonlView.tsx` - JSONL viewer
- `/packages/admin/src/components/StructuredView.tsx` - Message grouping
- `/packages/admin/src/components/MessageRenderer.tsx` - Tool rendering (15+ types)

### Modal Reference
- `/packages/admin/src/components/AddAppModal.tsx` (213 lines) - Good UI patterns

### State
- `/packages/admin/src/lib/sessions.js` - Panel/tab state (50+ signals)
- `/packages/admin/src/lib/state.js` - Auth/route state
- `/packages/admin/src/lib/api.js` - Backend API client

---

## Files to Modify (4 Steps)

### Step 1: Update lib/sessions.ts
Add `'admin-assist'` to the `CompanionType` union:

```typescript
export type CompanionType = 
  | 'jsonl' 
  | 'feedback' 
  | 'iframe' 
  | 'terminal' 
  | 'isolate' 
  | 'url'
  | 'admin-assist';  // NEW
```

Update `extractCompanionType()` to recognize `admin-assist:`

Update `renderTabContent()` to handle the new type

### Step 2: Create AdminAssistCompanion.tsx
Create `/packages/admin/src/components/AdminAssistCompanion.tsx`

**Components:**
- Chat message history (array of { role, content, timestamp })
- Input textarea with Cmd+Enter to submit
- Loading state
- Error handling
- Message rendering (reuse StructuredView or MessageRenderer)

**API Integration:**
- Call `api.setupAssist({ request, entityType: 'admin' })`
- Get back `{ sessionId }`
- Load messages from session's JSONL output

**Reference**: AiAssistButton (popover pattern) + SetupAssistButton (preset pattern)

### Step 3: Update GlobalTerminalPanel.tsx
1. Auto-open `'admin-assist:welcome'` on first app load
2. Import new AdminAssistCompanion component
3. Render it in the `renderTabContent()` switch statement

```typescript
case 'admin-assist': {
  return <AdminAssistCompanion tabId={tabId} />;
}
```

### Step 4: Update app.css (Optional)
Add styles following existing patterns:
- `.admin-assist-container` - Main chat container
- `.admin-assist-messages` - Message list
- `.admin-assist-input` - Input area
- Reuse `.request-panel-textarea`, `.btn`, etc.

---

## Tab ID Format

Tab IDs use format: `'<type>:<identifier>'`

Examples:
- `'jsonl:abc123'` - JSONL viewer for session abc123
- `'feedback:abc123'` - Feedback viewer for session abc123  
- `'terminal:abc123'` - Terminal companion for session abc123
- `'admin-assist:welcome'` - Admin chat (default welcome tab)
- `'admin-assist:infrastructure'` - Admin chat for infrastructure context

---

## Key State Signals to Use

From `lib/sessions.js`:

```typescript
import { 
  openTabs,        // Array of tab IDs currently open
  activeTabId,     // ID of currently visible tab
  closeTab,        // Function to close a tab
  panelMinimized,  // Is bottom panel minimized
  panelHeight,     // Height of bottom panel (resizable)
} from '../lib/sessions.js';
```

---

## Existing CSS Classes to Reuse

```css
.ai-assist-popover        /* Popover container */
.ai-assist-header         /* Header with title */
.ai-assist-body           /* Content area */
.ai-assist-footer         /* Action buttons */
.request-panel-textarea   /* Textarea styling */
.btn, .btn-primary        /* Button styles */
.pw-panel                 /* Bottom panel */
.pw-tab-bar               /* Tab navigation */
.pw-tab-content           /* Tab content area */
```

---

## Component Hierarchy

```
<Layout>
  └─ Main content area
  └─ <GlobalTerminalPanel>
       └─ Tab bar (shows all open tabs)
       └─ Active companion content
            ├─ <JsonlView /> (for jsonl:*)
            ├─ <FeedbackCompanionView /> (for feedback:*)
            ├─ <TerminalCompanionView /> (for terminal:*)
            ├─ <IframeCompanionView /> (for iframe:*)
            └─ <AdminAssistCompanion /> (for admin-assist:*) ← NEW
  └─ <PopoutPanel /> (floating windows)
```

---

## API Integration Pattern

From existing components (AiAssistButton, SetupAssistButton):

```typescript
import { api } from '../lib/api.js';
import { openSession, loadAllSessions } from '../lib/sessions.js';

// 1. Submit request
const { sessionId } = await api.setupAssist({
  request: "user's message",
  entityType: 'admin',
  // entityId optional
});

// 2. Refresh session list
await loadAllSessions();

// 3. Open session tab (optional - chat can be inline)
openSession(sessionId);
```

---

## All 14 Pages at a Glance

App-specific:
- FeedbackListPage - List of feedback items
- FeedbackDetailPage - Single feedback detail
- SessionsPage - Sessions for an app
- AggregatePage - Clustered feedback
- LiveConnectionsPage - Active widget sessions
- AppSettingsPage - App configuration

Global settings:
- AgentsPage - Global agent configuration
- GettingStartedPage - Setup guide
- UserGuidePage - User documentation
- SettingsPage - User preferences (theme, shortcuts)
- InfrastructurePage - Machines, launchers, harnesses, sprites
- LoginPage - Authentication

Special:
- StandaloneSessionPage - Full-screen session view
- ApplicationsPage (deprecated)

---

## All 33 Components at a Glance

**Router & Layout:**
- App.tsx - Routing
- Layout.tsx - Main shell

**Bottom Panel:**
- GlobalTerminalPanel.tsx - Tab hub (LARGE)
- PopoutPanel.tsx - Floating windows

**Tab Content (Companions):**
- JsonlView.tsx - JSONL viewer
- FeedbackCompanionView.tsx - Feedback detail
- TerminalCompanionView.tsx - Terminal/tmux
- IframeCompanionView.tsx - URL iframe
- IsolateCompanionView.tsx - Isolated component

**Message Display:**
- StructuredView.tsx - Message grouping
- MessageRenderer.tsx - Tool rendering
- AgentTerminal.tsx - Terminal output
- SessionViewToggle.tsx - View mode toggle

**Modals & Popovers:**
- AddAppModal.tsx - App creation
- DispatchDialog.tsx - Feedback dispatch
- ShortcutHelpModal.tsx - Keyboard help
- TerminalPicker.tsx - Terminal picker
- SpotlightSearch.tsx - Global search

**AI Assistants:**
- AiAssistButton.tsx - Inline popover
- SetupAssistButton.tsx - Draggable popover

**Selection:**
- DispatchPicker.tsx - Agent/harness picker
- DispatchTargetSelect.tsx - Target dropdown
- DirPicker.tsx - Directory picker

**Utilities:**
- ControlBar.tsx - Control buttons
- RequestPanel.tsx - Request input
- FileViewerPanel.tsx - File viewer
- CropEditor.tsx - Screenshot crop
- PerfOverlay.tsx - Performance metrics
- Tooltip.tsx - Tooltips
- HintToast.tsx - Hint notifications
- AutoFixToast.tsx - Autofix toast
- DeletedItemsPanel.tsx - Restore items
- Guide.tsx - Guide content

---

## Key URLs Routes

```
/                           → Redirect to /app/{appId}/feedback
/app/{appId}/feedback       → Feedback list
/app/{appId}/feedback/{id}  → Feedback detail
/app/{appId}/sessions       → Sessions
/app/{appId}/aggregate      → Aggregate clusters
/app/{appId}/live           → Live connections
/app/{appId}/settings       → App settings

/settings/agents            → Global agents
/settings/infrastructure    → Machines/harnesses/sprites
/settings/preferences       → User preferences
/settings/getting-started   → Getting started guide
/settings/user-guide        → User guide

/session/{sessionId}        → Standalone session (fullscreen)
```

---

## Quick Checklist

- [x] Understand GlobalTerminalPanel is the bottom panel hub
- [x] Understand companion types are added to CompanionType union
- [x] Understand tab ID format is `'<type>:<identifier>'`
- [x] Know where to add renderTabContent case
- [x] Know how to call api.setupAssist() to create sessions
- [x] Know state signals: openTabs, activeTabId, panelHeight, etc.
- [x] Know to reuse CSS classes like .request-panel-textarea, .btn
- [ ] Create AdminAssistCompanion.tsx
- [ ] Update lib/sessions.ts with 'admin-assist' type
- [ ] Update GlobalTerminalPanel.tsx to auto-open and render
- [ ] Add styles to app.css if needed
- [ ] Test the chat panel in bottom area

---

## Reference Documents

Three detailed docs have been created:

1. **ADMIN_ASSIST_CHAT_INTEGRATION.md** - Full architecture & integration options
2. **ADMIN_UI_STRUCTURE_REFERENCE.md** - Detailed component explanations & state
3. **QUICK_START_SUMMARY.md** - This file

All saved to project root for easy reference.

