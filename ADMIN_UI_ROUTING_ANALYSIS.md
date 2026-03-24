# Prompt Widget Admin UI - Routing & Settings Architecture Analysis

## Executive Summary

The admin UI has a clear separation between **global settings** and **per-app settings**. Currently:
- **Global settings** (at `/settings/applications`) manages application CRUD and basic app properties
- **Per-app settings** (at `/app/{appId}/settings`) manages request panel configuration and control actions for individual apps

This document details how routing works and identifies what application settings exist globally vs. per-app, providing the foundation for planning the move of Applications management from global to per-app context.

---

## Routing Architecture

### Route Structure in App.tsx

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/App.tsx`

The routing system uses pattern matching with a custom `parseAppRoute()` function:

```typescript
function parseAppRoute(route: string): { appId: string; sub: string; param?: string } | null {
  const m = route.match(/^\/app\/([^/]+)\/(.+)$/);
  // Matches: /app/{appId}/{subRoute}/{optionalParam}
}
```

### Route Table

| Route Pattern | Page Component | Context | Notes |
|---|---|---|---|
| `/app/{appId}/feedback` | FeedbackListPage | Per-app | Lists feedback items for app |
| `/app/{appId}/feedback/{id}` | FeedbackDetailPage | Per-app | Single feedback detail view |
| `/app/{appId}/aggregate` | AggregatePage | Per-app | Clustered feedback analysis |
| `/app/{appId}/sessions` | SessionsPage | Per-app | Agent sessions for app |
| `/app/{appId}/live` | LiveConnectionsPage | Per-app | Live widget connections |
| `/app/{appId}/settings` | AppSettingsPage | Per-app | **Per-app configuration** |
| `/settings/agents` | AgentsPage | Global | Agent endpoints (not per-app) |
| `/settings/applications` | ApplicationsPage | Global | **App CRUD + basic config** |
| `/settings/machines` | MachinesPage | Global | Machine/hardware management |
| `/settings/harnesses` | HarnessesPage | Global | Test harness configs |
| `/settings/preferences` | SettingsPage | Global | UI preferences, tmux configs |
| `/settings/getting-started` | GettingStartedPage | Global | Onboarding guide |
| `/session/{sessionId}` | StandaloneSessionPage | Standalone | Session-only view |

---

## Sidebar Navigation Structure

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/Layout.tsx` (lines 748-904)

### Apps Section
```typescript
// Lines 789-847
// Rendered for each app in applications.value
// Shows app as main item with sub-nav when selected:
- Feedback (with count badge)
- Aggregate
- Sessions
- Live
- Settings (per-app)
```

### Settings Section
```typescript
// Lines 748-755
const settingsItems = [
  { path: '/settings/agents', label: 'Agents', icon: '🤖' },
  { path: '/settings/applications', label: 'Applications', icon: '📦' },  // <-- GLOBAL
  { path: '/settings/machines', label: 'Machines', icon: '🖥' },
  { path: '/settings/harnesses', label: 'Harnesses', icon: '🐧' },
  { path: '/settings/getting-started', label: 'Getting Started', icon: '📖' },
  { path: '/settings/preferences', label: 'Preferences', icon: '⚙' },
];
```

**Current Flow**:
```
Sidebar → Settings Section → Applications
       → (Navigate to /settings/applications)
       → ApplicationsPage shows all apps in a list
       → Click Edit → Form modal appears with app properties
```

---

## Global Settings Page

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/SettingsPage.tsx`

### Global Settings Sections

| Section | Purpose | Type |
|---------|---------|------|
| **Appearance** | Theme selection (light/dark/system) | UI Preference |
| **Keyboard Shortcuts** | Enable/disable, view shortcuts | UI Preference |
| **Terminal** | Session tab display, auto-jump behavior | UI Preference |
| **Tmux Configurations** | Create/edit named tmux configs | Global Resource |
| **Panel Presets** | Save/restore panel layouts | UI State |
| **Tooltips** | Show/hide tooltip hints | UI Preference |
| **Guides** | Interactive onboarding tours | UI State |
| **Developer** | Performance metrics overlay | Debug |

**Key Note**: Tmux configurations are **global** but **assigned per-app** in the ApplicationsPage form.

---

## Applications Page (Global)

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/ApplicationsPage.tsx`

### Current Responsibilities

This page manages **three categories** of application settings:

#### 1. Application Metadata (Always shown)
- **Name** - Application display name
- **Project Directory** - Working directory for Claude Code sessions
- **Server URL** (optional) - Base URL of the app's web server
- **Hooks** - Comma-separated list of window.agent.* method names
- **Description** - Markdown/text description of the app

#### 2. Session Settings (Shown when editing)
- **Tmux Configuration** - Select named config or use global default
- **Default Permission Profile** - Interactive / Auto / Yolo (skip permissions)
- **Default Allowed Tools** - Tool allowlist for Claude Code sessions
- **Agent Path** - Custom path to Claude Code binary

#### 3. Fields in Database Schema
```typescript
// From packages/server/src/db/schema.ts (applications table)
id: text
name: text
apiKey: text (auto-generated)
projectDir: text
serverUrl: text (optional)
hooks: text (JSON array)
description: text
tmuxConfigId: text (optional, references tmuxConfigs.id)
defaultPermissionProfile: text (references tmuxConfigs)
defaultAllowedTools: text
agentPath: text
screenshotIncludeWidget: boolean
autoDispatch: boolean
controlActions: text (JSON array)          // <-- Per-app
requestPanel: text (JSON object)            // <-- Per-app
createdAt: text
updatedAt: text
```

---

## Per-App Settings Page

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/AppSettingsPage.tsx`

### Current Responsibilities

This page manages **request panel** and **control actions** for a specific app:

#### 1. Prompt Prefix
- Text prepended to every request from the request panel
- Stored in: `app.requestPanel.promptPrefix`

#### 2. Default Agent
- Which agent endpoint to use for requests
- Stored in: `app.requestPanel.defaultAgentId`

#### 3. Request Suggestions
- Preset prompts shown as quick-fill options
- Array of `{ label, prompt }` objects
- Stored in: `app.requestPanel.suggestions[]`

#### 4. Request Preferences
- Checkboxes shown in request panel
- When checked, snippet is appended to prompt
- Each has: `{ id, label, promptSnippet, default }`
- Stored in: `app.requestPanel.preferences[]`

#### 5. Control Actions (Moved from global SettingsPage)
- Shell commands that appear as buttons in control bar
- Each has: `{ id, label, command, icon }`
- Stored in: `app.controlActions[]`

### Storage Structure

These are stored as JSON in the `applications` table:

```typescript
// requestPanel (JSON object)
{
  suggestions: [
    { label: "Build Docker", prompt: "Build the Docker image..." }
  ],
  preferences: [
    { id: "pref-123", label: "Auto-commit", promptSnippet: "\nCommit changes automatically", default: true }
  ],
  promptPrefix: "You are working on project XYZ...",
  defaultAgentId: "agent-456"
}

// controlActions (JSON array)
[
  { id: "action-123", label: "Run Tests", command: "npm test", icon: "▶️" },
  { id: "action-456", label: "Build", command: "npm run build", icon: "🔨" }
]
```

---

## API Methods for App Management

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/api.ts`

### Application CRUD

```typescript
// Get all applications
getApplications(): Promise<any[]>

// Get single app with all properties
getApplication(id: string): Promise<any>

// Create new app
createApplication(data: Record<string, unknown>): Promise<{ id: string; apiKey: string }>

// Update app (request panel + control actions)
updateApplication(id: string, data: Record<string, unknown>): Promise<void>

// Delete app
deleteApplication(id: string): Promise<void>

// Regenerate API key
regenerateApplicationKey(id: string): Promise<{ id: string; apiKey: string }>
```

### Data Structure Passed to updateApplication()

```typescript
{
  name: string,
  projectDir: string,
  serverUrl?: string,
  hooks: string[],
  description: string,
  tmuxConfigId?: string | null,
  defaultPermissionProfile: 'interactive' | 'auto' | 'yolo',
  defaultAllowedTools?: string | null,
  agentPath?: string | null,
  screenshotIncludeWidget: boolean,
  autoDispatch: boolean,
  
  // Per-app settings
  requestPanel: {
    suggestions?: Array<{ label: string; prompt: string }>,
    preferences?: Array<{ id: string; label: string; promptSnippet: string; default: boolean }>,
    promptPrefix?: string,
    defaultAgentId?: string
  },
  controlActions?: Array<{ id: string; label: string; command: string; icon?: string }>
}
```

---

## Current Settings Distribution

### Global (/settings/applications)
- ✅ App CRUD operations
- ✅ Name, projectDir, serverUrl, hooks, description
- ✅ Tmux config selection
- ✅ Default permission profile
- ✅ Default allowed tools
- ✅ Agent path selection
- ✅ API key display & regeneration

### Per-App (/app/{appId}/settings)
- ✅ Request panel prompt prefix
- ✅ Default agent for requests
- ✅ Request suggestions
- ✅ Request preferences
- ✅ Control actions

---

## Application State Management

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/state.js`

### Global Application List

```typescript
// Signal containing all loaded applications
const applications = signal<any[]>([])

// Load applications from API
const loadApplications = async () => {
  const data = await api.getApplications()
  applications.value = data
}

// Track which app is currently selected
const selectedAppId = signal<string | null>(null)
```

The `loadApplications()` function is called:
1. On app startup (App.tsx useEffect)
2. After creating/updating/deleting an app (ApplicationsPage, AppSettingsPage)
3. When sidebar apps are refreshed

---

## Navigation Between App and Global Settings

**Current User Flow**:

```
User is in per-app view: /app/{appId}/feedback
    ↓
Click "Settings" in per-app subnav
    ↓
Navigate to: /app/{appId}/settings
    ↓
See request panel + control actions config
    ↓
(To edit basic app properties, must navigate to /settings/applications)
```

**Proposed Change Context**:
Moving Applications from global to per-app would mean:

```
User is in per-app view: /app/{appId}/feedback
    ↓
Click "Settings" in per-app subnav (renamed to "App Settings" or similar)
    ↓
Navigate to: /app/{appId}/settings
    ↓
See ALL app settings:
  - App metadata (name, projectDir, hooks, etc.)
  - Request panel config
  - Control actions
  - Session settings (tmux, permissions)
```

---

## Key Observations for Planning

### 1. **Separation of Concerns**
- **Global ApplicationsPage**: Currently responsible for CRUD + basic metadata
- **Per-app AppSettingsPage**: Currently responsible for request panel + control actions
- **No clean boundary**: Both manage "application settings" but in different places

### 2. **Data Consistency**
- Both pages call `api.updateApplication()` with overlapping data
- Both refresh `applications.value` after save
- No conflicts observed (different fields managed)

### 3. **Navigation Complexity**
- To manage all app settings, user must visit two pages
- No obvious indication that "Applications" page is for all-app CRUD vs. per-app config

### 4. **Sidebar Navigation Pattern**
- Sidebar clearly shows per-app context with sub-nav items
- Settings section is global/cross-app
- Moving Applications under per-app would maintain consistency with app-focused UI

### 5. **API Structure**
- Single `updateApplication()` endpoint handles all app updates
- Database stores all settings on the `applications` table
- No API barrier to moving UI

### 6. **Tmux Config Assignment**
- Global tmux configs are managed at `/settings/preferences`
- They're assigned per-app in the ApplicationsPage form
- This pattern could continue under per-app settings if needed

---

## TypeScript Interfaces

### Application Object (Full)
```typescript
{
  id: string
  name: string
  apiKey: string
  projectDir: string
  serverUrl?: string
  hooks: string[]
  description: string
  tmuxConfigId?: string
  defaultPermissionProfile: 'interactive' | 'auto' | 'yolo'
  defaultAllowedTools?: string
  agentPath?: string
  screenshotIncludeWidget: boolean
  autoDispatch: boolean
  
  // Per-app settings
  requestPanel: {
    suggestions?: Array<{ label: string; prompt: string }>
    preferences?: Array<{ id: string; label: string; promptSnippet: string; default: boolean }>
    promptPrefix?: string
    defaultAgentId?: string
  }
  controlActions: Array<{ id: string; label: string; command: string; icon?: string }>
  
  // Metadata
  createdAt: string
  updatedAt: string
}
```

### TmuxConfig Object
```typescript
{
  id: string
  name: string
  content: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}
```

---

## Files to Modify for Architecture Changes

If moving Applications from global to per-app:

| File | Component | Change |
|------|-----------|--------|
| App.tsx | Routing | Remove `/settings/applications` route if apps moved to per-app |
| Layout.tsx | Sidebar | Remove "Applications" from global settingsItems array |
| Layout.tsx | Sidebar | Possibly add "Manage Apps" or "All Apps" to app sub-nav or global |
| AppSettingsPage.tsx | Page | Merge ApplicationsPage CRUD + metadata into this page |
| ApplicationsPage.tsx | Page | Could become `AllApplicationsPage` for app management view (global or per-app floating button) |
| api.ts | API | No changes needed (API structure supports both scenarios) |

---

## Summary Table: Settings by Ownership

| Setting | Current Location | Type | Scope |
|---------|------------------|------|-------|
| App name | `/settings/applications` | Form field | Per-app |
| Project directory | `/settings/applications` | Form field | Per-app |
| Server URL | `/settings/applications` | Form field | Per-app |
| Hooks | `/settings/applications` | Form field | Per-app |
| Description | `/settings/applications` | Form field | Per-app |
| Tmux config | `/settings/applications` | Dropdown (select global resource) | Per-app |
| Permission profile | `/settings/applications` | Dropdown | Per-app |
| Allowed tools | `/settings/applications` | Text field (tool allowlist) | Per-app |
| Agent path | `/settings/applications` | Text field | Per-app |
| **Prompt prefix** | `/app/{appId}/settings` | Textarea | Per-app |
| **Default agent** | `/app/{appId}/settings` | Dropdown | Per-app |
| **Request suggestions** | `/app/{appId}/settings` | List editor | Per-app |
| **Request preferences** | `/app/{appId}/settings` | List editor | Per-app |
| **Control actions** | `/app/{appId}/settings` | List editor | Per-app |
| API key | `/settings/applications` | Display only | Per-app |
| Tmux configurations (global) | `/settings/preferences` | List editor | Global |
| Theme | `/settings/preferences` | Buttons | Global/Local |
| Keyboard shortcuts | `/settings/preferences` | Toggles | Global/Local |
| Terminal behavior | `/settings/preferences` | Toggles | Global/Local |
| Panel presets | `/settings/preferences` | List editor | Global/Local |

---

## Conclusion

The current architecture has a natural division:
- **Global Applications Page**: Manages app lifecycle and basic properties
- **Per-app Settings Page**: Manages request panel and control actions

**All settings are stored per-app** in the database, making it straightforward to consolidate them into a single per-app management interface. The sidebar navigation clearly supports this with per-app sub-nav patterns already established.
