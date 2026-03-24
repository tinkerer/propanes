# Admin UI Layout & Companion Type System Analysis

## AHOY MEAT COMPUTER! 🤖🧠⚡

---

## 1. Main App Shell Layout

### App.tsx Structure (High Level)
- **File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/App.tsx`
- **Purpose**: Routes pages and authenticates users
- **Return Structure** (lines 169-174):
  ```
  <>
    <Layout>{page}</Layout>        ← Main admin UI wrapper
    <DispatchDialog />
  </>
  ```

### Layout.tsx Structure (Sidebar + Main + Panel)
- **File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/Layout.tsx` (1335 lines)
- **Three-Part Layout** (lines 1218-1228):
  ```
  <div class="pw-layout">
    <div class="sidebar">
      - Sessions drawer (expandable)
      - Terminals drawer (expandable)
      - Resize handles between sections
    </div>
    
    <div class="sidebar-edge-handle" />  ← Draggable
    
    <div class="main-wrapper">
      <ControlBar />                      ← Top control bar
      <div class="main">
        <RequestPanel />                  ← Floating request helper
        {children}                        ← Page content (FeedbackListPage, etc.)
      </div>
    </div>
    
    <GlobalTerminalPanel />               ← Bottom panel
    <PopoutPanel />                       ← Floating panels
    ... overlays & toasts
  </div>
  ```

---

## 2. Companion Type System

### Type Definition
- **File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/sessions.ts` line 1954
- **Current Types**:
  ```typescript
  export type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url';
  ```
- **Tab ID Format**: `{type}:{identifier}`
  - `jsonl:{sessionId}` → JSONL conversation viewer
  - `feedback:{sessionId}` → Feedback detail view
  - `iframe:{sessionId}` → Page iframe
  - `terminal:{sessionId}` → Terminal companion
  - `isolate:{componentName}` → Isolated component in iframe
  - `url:{fullUrl}` → Arbitrary URL iframe

### Key Functions
- `extractCompanionType(tabId)` (line 2013): Parses tab ID to determine if it's a companion type
  ```typescript
  const prefix = tabId.slice(0, idx);
  if (prefix === 'jsonl' || prefix === 'feedback' || ...) return prefix;
  return null;
  ```
- `companionTabId(sessionId, type)` (line 2003): Creates tab ID → `${type}:${sessionId}`
- `extractSessionFromTab(tabId)` (line 2007): Gets session ID from tab ID
- `getCompanions(sessionId)` (line 2021): Gets all companion types for a session
- `toggleCompanion(sessionId, type)` (line 2029): Opens/closes a companion type
- `openUrlCompanion(url)` (line 2085): Opens URL in right pane
- `openIsolateCompanion(componentName)` (line 2077): Opens isolated component

### Companion Storage
- `sessionCompanions` signal (line 1996): `Record<string, CompanionType[]>` stored in localStorage
  - Maps session ID → array of companion types
  - Persisted to `pw-session-companions`
- `terminalCompanionMap` signal (line 1957): Maps parent session → terminal session ID

---

## 3. GlobalTerminalPanel (Bottom Panel)

### File & Location
- **File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/GlobalTerminalPanel.tsx`
- **Imported in Layout.tsx** (line 7): Rendered at line 1227
- **CSS Classes**: `.global-terminal-panel`, `.terminal-tab`, `.terminal-tab.active`

### Default State (No Tabs)
- **Code** (lines 661-674):
  ```typescript
  export function GlobalTerminalPanel() {
    const tabs = openTabs.value;
    if (tabs.length === 0) {
      // Still render TerminalPicker even when no tabs open
      if (termPickerOpen.value) {
        return (
          <TerminalPicker
            mode={termPickerOpen.value}
            onClose={() => { termPickerOpen.value = null; }}
          />
        );
      }
      return null;  ← Returns null; no panel visible
    }
    // ... render tabs and content
  }
  ```

### Tab Content Rendering
- **renderTabContent()** (lines 612-659): Dispatches to correct companion component
  ```typescript
  // Parse tab ID to determine type
  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  
  // Render appropriate component
  if (isUrl) {
    return <IframeCompanionView url={realSid} />;
  } else if (isIsolate) {
    return <IsolateCompanionView componentName={realSid} />;
  } else if (isJsonl) {
    return <JsonlView sessionId={realSid} />;
  } else if (isFeedback) {
    return <FeedbackCompanionView feedbackId={sess.feedbackId} />;
  } else if (isIframe) {
    return <IframeCompanionView url={sess.url} />;
  } else if (isTerminal) {
    return <TerminalCompanionView companionSessionId={termSid} />;
  } else {
    // Regular session → SessionViewToggle
    return <SessionViewToggle ... />;
  }
  ```

### Split Pane Structure
- **Left Pane**: Main sessions (openTabs)
- **Right Pane**: Companions for active left session (rightPaneTabs)
- **Control Signals**:
  - `splitEnabled` (line 32): Boolean to show/hide right pane
  - `rightPaneTabs` (line 33): Array of companion tab IDs in right pane
  - `rightPaneActiveId` (line 34): Currently active companion tab
  - `splitRatio` (line 35): Resize ratio between panes

---

## 4. SetupAssistButton Pattern Reference

### File & Purpose
- **File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/SetupAssistButton.tsx`
- **Purpose**: Floating popover button for AI-assisted setup
- **Used For**: Machines, harnesses, agents, sprites

### UI Pattern (Reusable for Admin Chat)
- **Button**: Small icon button with .ai-assist-btn class
- **Popover**: Floating div positioned near trigger button
  - Draggable header
  - Auto-clamped to viewport (lines 84-90, 101-116)
  - Click-outside closes (lines 146-156)
  - Textarea with placeholders
  - Preset buttons (lines 203-218)
  - Submit button + keyboard shortcut hint

### Key Implementation Details
```typescript
// Positioning logic
const trigger = triggerRef.current.getBoundingClientRect();
let x = trigger.left + trigger.width / 2 - pw / 2;  // Center on button
let y = trigger.top - ph - 8;  // Try above
if (y < 8) y = trigger.bottom + 8;  // Fall back to below
const clamped = clampToViewport(x, y, pw, ph);

// Submit handler
async function submit(requestText?: string) {
  const { sessionId } = await api.setupAssist({
    request: finalText,
    entityType,
    entityId,
  });
  await loadAllSessions();
  openSession(sessionId);  // Auto-opens in panel
}
```

---

## 5. Adding a New Companion Type

### Step-by-Step Process

#### 1. Update Type Definition
- **File**: `packages/admin/src/lib/sessions.ts` line 1954
- Add to `CompanionType` union:
  ```typescript
  export type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url' | 'admin-chat';
  ```

#### 2. Update Type Extraction
- **File**: `packages/admin/src/lib/sessions.ts` line 2017
- Add to `extractCompanionType()` type check:
  ```typescript
  if (prefix === 'jsonl' || prefix === 'feedback' || ... || prefix === 'admin-chat') return prefix;
  ```

#### 3. Create Companion Component
- Create new file: `packages/admin/src/components/AdminChatCompanionView.tsx`
- Component signature:
  ```typescript
  export function AdminChatCompanionView({ sessionId }: { sessionId: string }) {
    // Render chat UI
  }
  ```

#### 4. Add Rendering Logic
- **File**: `packages/admin/src/components/GlobalTerminalPanel.tsx` line 618
- Add type check in `renderTabContent()`:
  ```typescript
  const isAdminChat = sid.startsWith('admin-chat:');
  // ...
  } else if (isAdminChat) {
    return <AdminChatCompanionView sessionId={realSid} />;
  ```

#### 5. Add to PopoutPanel
- **File**: `packages/admin/src/components/PopoutPanel.tsx`
- Same `renderTabContent()` pattern

---

## 6. Opening Companions Programmatically

### From Sessions Library
- `toggleCompanion(sessionId, type)` (line 2029)
  ```typescript
  export function toggleCompanion(sessionId: string, type: CompanionType) {
    const tabId = companionTabId(sessionId, type);
    openSessionInRightPane(tabId);  // Opens in right pane
  }
  ```

- `openUrlCompanion(url)` (line 2085)
  ```typescript
  const tabId = `url:${url}`;
  openSessionInRightPane(tabId);
  ```

- `openIsolateCompanion(componentName)` (line 2077)
  ```typescript
  const tabId = `isolate:${componentName}`;
  openSessionInRightPane(tabId);
  ```

### Usage in Components
```typescript
import { toggleCompanion } from '../lib/sessions.js';

// Open admin chat for current session
toggleCompanion(sessionId, 'admin-chat');
```

---

## 7. SetupAssistButton Usage Pattern

### Location Pattern
- Buttons appear on infrastructure pages (machines, harnesses, etc.)
- Classes: `.btn-admin-assist` for guide targeting

### Button Invocation
```typescript
<SetupAssistButton
  entityType="machine"
  entityId={machineId}
  entityLabel={machineName}
/>
```

### Preset Buttons
- Defined as `PRESETS` and `NEW_ENTITY_PRESETS` objects (lines 11-53)
- Each preset has `label` and `request` fields
- Fire-and-forget: closes modal, opens session when ready

### API Call
- Endpoint: `api.setupAssist({ request, entityType, entityId })`
- Response: `{ sessionId }`
- Result: Auto-opens in session panel via `openSession(sessionId)`

---

## 8. Layout Hierarchy Summary

```
App (page routing)
  └─ Layout
      ├─ Sidebar
      │   ├─ Sessions drawer
      │   └─ Terminals drawer
      ├─ Main wrapper
      │   ├─ ControlBar (top)
      │   ├─ RequestPanel (floating)
      │   └─ Page content {children}
      ├─ GlobalTerminalPanel (bottom split pane)
      │   ├─ Left pane: Session tabs
      │   └─ Right pane: Companion tabs
      ├─ PopoutPanel (floating windows)
      └─ Overlays & toasts
```

---

## 9. Key Files Reference

| File | Purpose | Key Content |
|------|---------|-------------|
| `App.tsx` | Route dispatcher | Page selection, auth |
| `Layout.tsx` | Main UI shell | Sidebar + main + panel layout |
| `GlobalTerminalPanel.tsx` | Bottom panel | Tab rendering, split pane |
| `PopoutPanel.tsx` | Floating panels | Docked/floating session panels |
| `SetupAssistButton.tsx` | Setup helper | Popover UI pattern reference |
| `sessions.ts` | State management | Companion types, tab open/close |
| `TerminalPicker.tsx` | Session picker | Spotlight search for sessions |

---

## 10. Admin Chat Implementation Strategy

### Approach
1. Add `admin-chat` to `CompanionType` union
2. Create `AdminChatCompanionView.tsx` (render chat interface)
3. Update `renderTabContent()` in GlobalTerminalPanel & PopoutPanel
4. Add storage for chat messages (localStorage or signals)
5. Implement chat input + message history UI
6. Connect to API or OpenAI/Claude API for responses

### Triggering Admin Chat
- Add button to header/toolbar: "Admin Chat"
- Open via: `toggleCompanion(null, 'admin-chat')` (session-less companion)
- Or attach to specific session: `toggleCompanion(sessionId, 'admin-chat')`

### Right Pane Auto-Open
- When user clicks "Admin Chat", calls `toggleCompanion()`
- This automatically opens the companion in the right pane (split enabled)
- Chat stays persistent across session switches (if not session-specific)

---
