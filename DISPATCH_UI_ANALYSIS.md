# Dispatch & Machine Management UI Analysis - Prompt Widget

## Executive Summary

The prompt-widget admin UI provides a comprehensive dispatch system that routes feedback to different computation targets (local, remote machines, or Docker harnesses). The system follows a layered architecture with:

1. **Dispatch Dialog** - User-facing modal for dispatching feedback
2. **Dispatch Picker** - Spotlight/command-palette for target selection
3. **Target Selection Component** - Cached dispatch targets (machines + harnesses)
4. **Machine & Harness Management Pages** - Settings for infrastructure setup
5. **Backend API Routes** - Server-side dispatch, machine, and launcher management

---

## 1. Dispatch Dialog Component

**File:** `packages/admin/src/components/DispatchDialog.tsx`

### Purpose
Modal dialog that allows users to dispatch feedback items to agent endpoints with optional target selection and custom instructions.

### Key Features

#### Signal Management
```javascript
export const dispatchDialogOpen = signal<DispatchDialogRequest | null>(null);
export const dispatchDialogResult = signal<'idle' | 'dispatched' | 'error'>('idle');

export interface DispatchDialogRequest {
  feedbackIds: string[];        // One or more feedback items
  appId?: string | null;        // Associated app (optional)
}
```

#### UI Structure
- **Header:** Dispatch status with escape hint
- **Agent Selector:** Dropdown showing agents (app-specific & global defaults)
- **Target Selector:** Grouped dropdown with:
  - Local (default)
  - Remote Machines (optgroup)
  - Harnesses (optgroup)
  - Each shows `activeSessions/maxSessions`
- **Mode Tabs:** Standard vs Assistant mode
  - **Standard:** Direct instructions
  - **Assistant:** Natural language prompt (prefixed with "[Assistant mode]")
- **Instructions Input:** Optional additional context
- **Error Display:** Red text for failed dispatches
- **Action Buttons:** Cancel & Dispatch

#### Target Loading
- Calls `ensureTargetsLoaded()` on mount to populate machines/harnesses
- Filters `cachedTargets` into two categories:
  ```javascript
  const machines = targets.filter(t => !t.isHarness);
  const harnesses = targets.filter(t => t.isHarness);
  ```

#### Dispatch Flow
```javascript
async function doDispatch() {
  // 1. Build instructions (Assistant mode prefixes with "[Assistant mode]")
  // 2. Loop over feedbackIds (batch dispatch)
  // 3. Call api.dispatch() with:
  //    - feedbackId
  //    - agentEndpointId (agent)
  //    - instructions (optional)
  //    - launcherId (target, optional for local)
  // 4. Open session if single feedback (not batch)
  // 5. Set result signal & close dialog
}
```

#### Keyboard Shortcuts
- **Escape:** Close dialog
- **Ctrl/Cmd + Enter:** Trigger dispatch

#### Batch Dispatch
- Supports multiple feedback items (shows count: "Dispatch (3)")
- Single feedback item opens session automatically
- Batch operations just dispatch without opening sessions

---

## 2. Dispatch Picker Component

**File:** `packages/admin/src/components/DispatchPicker.tsx`

### Purpose
Spotlight/command-palette-style picker for selecting dispatch targets with search and keyboard navigation.

### UI Architecture

#### Item Structure
```javascript
interface PickerItem {
  id: string;              // Unique ID (e.g., "machine:launcher-id")
  category: string;        // Targets | Remote Machines | Harnesses | Setup
  icon: string;           // Emoji icon (🖥 machine, 🧪 harness, etc.)
  title: string;          // Display name
  subtitle?: string;      // Metadata (hostname, sessions, etc.)
  launcherId: string;     // Payload launcher ID
}
```

#### Categories
1. **Targets**
   - Local (icon: 💻, empty launcherId)
2. **Remote Machines**
   - Each machine launcher (icon: 🖥️, shows hostname + session count)
3. **Harnesses**
   - Each harness launcher (icon: 🧪, shows session count)
4. **Setup** (navigation items)
   - "Add remote machine..." (navigates to `/machines`)
   - "Add harness config..." (navigates to `/harnesses`)

#### Search & Navigation
- Live search filters items by title/subtitle
- Arrow keys navigate filtered list
- Enter selects item
- Escape closes picker
- Selected target highlighted with "(current)" badge
- Auto-scroll to selected item on navigation

#### Item Selection Logic
```javascript
function pick(item: PickerItem) {
  if (item.launcherId === '__nav_machines__') {
    navigate('/machines');
    onClose();
    return;
  }
  if (item.launcherId === '__nav_harnesses__') {
    navigate('/harnesses');
    onClose();
    return;
  }
  onSelect(item.launcherId);  // Empty string for local
  onClose();
}
```

#### DispatchTargetButton Component
- Small button wrapper that opens picker on click
- Shows selected target with icon + label + chevron
- Icons: 💻 (local), 🖥️ (machine), 🧪 (harness)

---

## 3. Dispatch Target Select Component

**File:** `packages/admin/src/components/DispatchTargetSelect.tsx`

### Purpose
Shared caching layer for dispatch targets (machines + harnesses) used by DispatchDialog, DispatchPicker, and MachinesPage.

### Architecture

#### Target Data Structure
```javascript
export interface DispatchTarget {
  launcherId: string;           // Unique launcher ID
  name: string;                 // Launcher name
  hostname: string;             // Machine hostname
  machineName: string | null;   // User-friendly machine name
  machineId: string | null;     // DB machine ID
  isHarness: boolean;           // True if harness, false if machine
  harnessConfigId: string | null; // Harness config ID
  activeSessions: number;       // Current active sessions
  maxSessions: number;          // Capacity limit
}
```

#### Caching Strategy
```javascript
export const cachedTargets = signal<DispatchTarget[]>([]);
let lastFetch = 0;

export async function refreshTargets() {
  // Calls api.getDispatchTargets() endpoint
  // Updates cachedTargets signal
  // Sets lastFetch timestamp
}

export function ensureTargetsLoaded() {
  // Refresh if > 10 seconds old
  if (Date.now() - lastFetch > 10_000) refreshTargets();
}
```

#### Cache Behavior
- 10-second cache window
- Lazy refresh on `ensureTargetsLoaded()` call
- On-focus refresh (DispatchTargetSelect component)
- Background errors ignored (stale data retained)

#### Simple Dropdown Select
```javascript
<select value={value} onChange={(e) => onChange(v || undefined)}>
  <option value="">Local</option>
  <optgroup label="Machines">
    {machines.map(t => <option>{t.machineName || t.name}</option>)}
  </optgroup>
  <optgroup label="Harnesses">
    {harnesses.map(t => <option>{t.name}</option>)}
  </optgroup>
</select>
```

---

## 4. Machines Page

**File:** `packages/admin/src/pages/MachinesPage.tsx`

### Purpose
Settings page for registering and managing remote machines that can host launchers and harnesses.

### Data Model
```javascript
interface Machine {
  id: string;                    // UUID
  name: string;                  // Display name
  hostname: string;              // DNS name or IP
  address: string;               // Hostname/IP for connection
  type: 'local' | 'remote' | 'cloud';
  status: 'online' | 'offline';
  capabilities?: {
    hasDocker: boolean;
    hasTmux: boolean;
    hasClaudeCli: boolean;
  };
  tags: string[];                // Custom tags (gpu, staging, etc.)
  lastSeenAt: string;            // ISO timestamp
}
```

### Form Fields
- **Name:** User-friendly display name
- **Hostname:** DNS name (e.g., "lab-mini.local")
- **Address:** Connection address (IP or tailnet hostname)
- **Type:** local | remote | cloud
- **Tags:** Comma-separated labels (gpu, arm64, staging)

### UI Components

#### Machine Card
Displays:
- Machine name + status badge (ONLINE/OFFLINE)
- Type badge (local/remote/cloud)
- Terminal button (if launcher found for machine)
- Edit/Delete buttons
- Metadata tags (hostname, address, capabilities)
- Tag list with color coding
- Last seen timestamp

#### Actions
- **Terminal:** Spawn terminal on machine (requires active launcher)
- **Edit:** Open form to modify machine
- **Delete:** Remove machine (tracked in DeletedItemsPanel)
- **Setup Assist:** AI-powered setup help

### API Integration
```javascript
api.getMachines()              // List all machines
api.createMachine(data)        // Register new machine
api.updateMachine(id, data)    // Update machine
api.deleteMachine(id)          // Remove machine
```

### Launcher Connection
- Machines are linked to launchers via `machineId`
- Terminal button only shows if launcher exists:
  ```javascript
  const target = cachedTargets.value.find(t => t.machineId === m.id && !t.isHarness);
  ```
- Can spawn terminal by `target.launcherId`

---

## 5. Harnesses Page

**File:** `packages/admin/src/pages/HarnessesPage.tsx`

### Purpose
Settings page for creating and managing Docker harness configurations (isolated test environments with pw-server + browser + app).

### Data Model

#### Harness Config
```javascript
interface HarnessConfig {
  id: string;                    // UUID
  name: string;                  // Display name
  appId: string | null;          // Associated application
  machineId: string | null;      // Target machine
  appImage: string | null;       // Docker image (e.g., "my-org/my-app:latest")
  appPort: number | null;        // External app port
  appInternalPort: number | null; // Port inside container
  serverPort: number | null;     // pw-server port (default 3001)
  browserMcpPort: number | null; // Browser MCP port (default 8931)
  targetAppUrl: string | null;   // Internal app URL (e.g., "http://pw-app:80")
  composeDir: string | null;     // Docker compose directory
  envVars: Record<string, string> | null;
  status: 'stopped' | 'running' | 'starting' | 'error';
  
  // Claude authentication
  hostTerminalAccess: boolean;   // Allow shell on host
  claudeHomePath: string | null; // Path to ~/.claude
  anthropicApiKey: string | null; // API key for Claude
  
  // Timestamps
  createdAt: string;
  lastStartedAt: string | null;
}
```

### Form Fields
**Basic Configuration**
- Name
- Application (dropdown)
- Machine (dropdown)
- App Image (Docker image name)

**Port Configuration**
- App Port
- Internal Port
- Server Port
- Browser MCP Port

**Deployment**
- Target App URL
- Compose Dir
- Env Vars (JSON textarea)

**Claude Authentication**
- Claude Home Path
- Anthropic API Key (password input)
- Host Terminal Access (checkbox)

### UI Components

#### Harness Card (Managed)
Displays:
- Name + Status badge (STOPPED/RUNNING/STARTING/ERROR)
- Setup Assist button
- Control buttons:
  - **Start/Stop** (based on status)
  - **Session** (launch Claude session in container)
  - **Terminal** (open plain terminal)
  - **Host Terminal** (if enabled, open shell on host)
  - **Health** (check launcher health)
  - **Check Auth** (verify Claude credentials)
  - **Restart** (restart launcher daemon)
  - **Edit/Delete**

- Metadata tags:
  - App name (blue border)
  - Machine name
  - Docker image
  - Auth badge (green if credentials set)
  - Launcher version
  - Capability warnings (red: "No Docker", "No tmux", "No Claude CLI")

- Conditional displays:
  - Auth check result (green/yellow/red background)
  - Health info (expands on "Health" click)
  - Error message (red background)
  - External URL (clickable link)
  - Port info
  - Creation timestamp + last started

#### Health Check Results
Shows (if available):
- Uptime
- Node version
- Launcher version
- Platform/arch
- Memory (free/total)
- Active sessions
- Optional: Docker/tmux/Claude versions
- Claude home exists (yes/no)

#### Unmanaged Live Harnesses
Shows harnesses reported by launchers that don't have a config:
- Launcher name + online/offline status
- Launcher ID + hostname
- App URL (clickable)
- App image
- Connected timestamp

### API Integration
```javascript
api.getHarnessConfigs(appId?)           // List configs
api.createHarnessConfig(data)           // Create new
api.updateHarnessConfig(id, data)       // Update
api.deleteHarnessConfig(id)             // Delete

api.startHarness(id)                    // Start Docker stack
api.stopHarness(id)                     // Stop Docker stack
api.launchHarnessSession(id, opts)      // Spawn Claude session
api.spawnTerminal(data)                 // Spawn terminal (container or host)

api.getLauncherHealth(launcherId)       // Health metrics
api.checkClaudeAuth(harnessConfigId)    // Verify credentials
api.restartLauncher(launcherId)         // Restart launcher daemon
```

### Polling
- `loadAll()` runs every 10 seconds (fetches configs, live harnesses, machines, launchers)
- Pulls live harness list from `/admin/launchers/harnesses`

---

## 6. Admin API Client (Dispatch-Related)

**File:** `packages/admin/src/lib/api.ts`

### Dispatch API
```javascript
dispatch(data: {
  feedbackId: string;           // ID to dispatch
  agentEndpointId: string;      // Agent endpoint ID
  instructions?: string;        // Optional custom instructions
  launcherId?: string;          // Optional target (empty = local)
}): Promise<{
  dispatched: boolean;
  sessionId?: string;           // Session ID if created
  status: number;
  response: string;
}>
```

### Targets API
```javascript
getDispatchTargets(): Promise<{
  targets: Array<{
    launcherId: string;
    name: string;
    hostname: string;
    machineName: string | null;
    machineId: string | null;
    isHarness: boolean;
    harnessConfigId: string | null;
    activeSessions: number;
    maxSessions: number;
  }>
}>
```

### Machines API
```javascript
getMachines(): Promise<Machine[]>
createMachine(data: Record<string, unknown>): Promise<Machine>
updateMachine(id: string, data: Record<string, unknown>): Promise<Machine>
deleteMachine(id: string): Promise<{ ok: boolean; id: string }>
```

### Harness Configs API
```javascript
getHarnessConfigs(appId?: string): Promise<HarnessConfig[]>
createHarnessConfig(data: Record<string, unknown>): Promise<HarnessConfig>
updateHarnessConfig(id: string, data: Record<string, unknown>): Promise<HarnessConfig>
deleteHarnessConfig(id: string): Promise<{ ok: boolean; id: string }>

startHarness(id: string): Promise<{ ok: boolean; status: string }>
stopHarness(id: string): Promise<{ ok: boolean; status: string }>
launchHarnessSession(id: string, opts?: {
  prompt?: string;
  permissionProfile?: string;
  serviceName?: string;
}): Promise<{ ok: boolean; sessionId: string }>

checkClaudeAuth(harnessConfigId: string): Promise<{
  hasClaudeDir: boolean;
  hasCredentials: boolean;
  claudeVersion?: string;
  error?: string;
}>
```

### Launcher API
```javascript
getLaunchers(): Promise<{ launchers: Launcher[] }>
getHarnesses(): Promise<{ harnesses: Harness[] }>
getLauncher(id: string): Promise<Launcher>
restartLauncher(id: string): Promise<{ ok: boolean }>
getLauncherHealth(id: string): Promise<HealthMetrics>
```

---

## 7. Routing & Navigation

**File:** `packages/admin/src/components/App.tsx`

### Route Structure
```
/                           → Redirect to first app's feedback
/app/:appId/feedback        → Feedback list for app
/app/:appId/feedback/:id    → Feedback detail
/app/:appId/aggregate       → Clustered feedback view
/app/:appId/sessions        → Agent sessions for app
/app/:appId/live            → Live widget connections
/app/:appId/settings        → App-specific settings

/settings/agents            → Global agent endpoints
/settings/machines          → Remote machine management
/settings/harnesses         → Harness configuration
/settings/getting-started   → Initial setup guide
/settings/preferences       → Admin preferences

/session/:id                → Standalone session view
/feedback/:id               → Legacy feedback detail redirect
```

### Navigation Flow for Dispatch Targets
1. **From Feedback:** Click "Dispatch" button → DispatchDialog opens
2. **Select Target:** Dropdown or open DispatchPicker via icon
3. **Setup New Target:**
   - In DispatchPicker, click "Add remote machine..." → `/settings/machines`
   - Or click "Add harness config..." → `/settings/harnesses`
4. **Return & Dispatch:** Back to DispatchDialog, select newly created target

---

## 8. Admin UI Flow Diagram

```
┌─────────────────────────────────────────────────┐
│         Admin UI App.tsx Routing                │
└──────────────────┬──────────────────────────────┘
                   │
        ┌──────────┴───────────┐
        │                      │
   ┌────▼──────┐      ┌───────▼────┐
   │Feedback    │      │Settings    │
   │Pages       │      │Pages       │
   └────┬──────┘      └───────┬────┘
        │                      │
   ┌────▼──────┐      ┌───────▼──────────┐
   │Dispatch   │      │Machines | Harnesses
   │Dialog     │      │Pages             │
   └────┬──────┘      └───────┬──────────┘
        │                      │
   ┌────▼──────────────────────▼────────┐
   │DispatchDialog Picker               │
   │┌──────────────────────────────────┐│
   ││DispatchPicker / Dropdown         ││
   ││ - Local                          ││
   ││ - Remote Machines (from targets) ││
   ││ - Harnesses (from targets)       ││
   ││ - Setup navigation items         ││
   │└──────────────────────────────────┘│
   └────┬──────────────────────────────┘
        │
   ┌────▼──────────────────────────┐
   │DispatchTargetSelect           │
   │(Cached targets from API)       │
   │┌──────────────────────────────┐│
   ││ api.getDispatchTargets()      ││
   ││ (10s cache, lazy refresh)    ││
   │└──────────────────────────────┘│
   └────┬──────────────────────────┘
        │
        ├─────────────────────────────────┐
        │                                 │
   ┌────▼──────────┐          ┌──────────▼────┐
   │MachinesPage   │          │HarnessesPage  │
   │- List machines│          │- List harnesses
   │- Add machine  │          │- Add harness  │
   │- Edit machine │          │- Edit harness │
   │- Connect      │          │- Start/Stop   │
   │  terminal     │          │- Launch       │
   └───────────────┘          │  session      │
                              │- Health check │
                              │- Auth check   │
                              └───────────────┘
```

---

## 9. Data Flow: Dispatching Feedback

### Step-by-Step Flow

1. **User clicks "Dispatch"** on feedback item
   ```javascript
   openDispatchDialog(feedbackIds, appId);
   // dispatchDialogOpen.value = { feedbackIds, appId }
   ```

2. **Dialog mounts & loads data**
   ```javascript
   - ensureTargetsLoaded()  // Refresh targets cache
   - api.getAgents(appId)   // Load agents
   - setAgentId(default)    // Select default agent
   ```

3. **User selects target** (or uses default local)
   ```javascript
   - Dropdown or DispatchPicker
   - setTarget(launcherId or '')
   // ''   = local
   // uuid = specific launcher
   ```

4. **User optionally selects mode & enters instructions**
   ```javascript
   - mode: 'standard' | 'assistant'
   - instructions: free text
   ```

5. **User clicks "Dispatch" or Cmd+Enter**
   ```javascript
   doDispatch() {
     finalInstructions = mode === 'assistant'
       ? `[Assistant mode] ${assistantPrompt}\n\nAdditional: ${instructions}`
       : instructions;
     
     for (feedbackId of feedbackIds) {
       api.dispatch({
         feedbackId,
         agentEndpointId: agentId,
         instructions: finalInstructions,
         launcherId: target || undefined
       })
     }
     
     if (single feedback && result.sessionId) {
       openSession(result.sessionId)  // Auto-open session
     }
     
     dispatchDialogResult.value = 'dispatched'
     onClose()
   }
   ```

6. **Server processes dispatch** (in admin.ts)
   - Route: `POST /admin/dispatch`
   - Calls `dispatchFeedbackToAgent()`
   - If `launcherId` provided, routes to that launcher
   - Otherwise, runs locally
   - Returns sessionId (or error)

---

## 10. Key UI Patterns

### Target Selection UX
- **Dropdown in DispatchDialog:** Simple, grouped by type (Local/Machines/Harnesses)
- **Picker in DispatchPicker:** Search, keyboard nav, "current" badge, setup shortcuts
- **DispatchTargetButton:** Compact button for inline selection

### Status Indicators
- **Machines:** ONLINE/OFFLINE badge (green/gray)
- **Harnesses:** STOPPED/RUNNING/STARTING/ERROR badge (colored by status)
- **Launchers:** Online status in picker (implicit from presence)
- **Sessions:** `activeSessions/maxSessions` in all target lists

### Form Patterns
- **Modal forms:** Agent form, machine form, harness form
- **Conditional fields:** Harness auth section only shows when relevant
- **JSON input:** Env vars textarea with monospace font
- **Password input:** API key field masked

### Navigation
- **Escape closes dialogs:** DispatchDialog, DispatchPicker
- **Cmd+K shortcut:** Spotlight search (likely for global nav)
- **Tab navigation:** Form fields, keyboard shortcuts
- **Hash routing:** `#/settings/machines`, `#/app/APP_ID/feedback`

### Feedback on Actions
- **Error display:** Red text in dialogs/forms
- **Loading states:** "Saving...", "Dispatching..."
- **Deleted items panel:** Track deletions with undo
- **Toast notifications:** (via actionToast signal)

---

## 11. Integration Points

### From Feedback Pages
- `FeedbackListPage`: Dispatch button on items
- `FeedbackDetailPage`: Dispatch action in detail view
- Opens dialog: `openDispatchDialog(feedbackIds, appId)`

### From Settings
- `MachinesPage`: Register and manage machines
- `HarnessesPage`: Create and manage harness configs
- Both use cached targets for showing launcher connections
- Both call `loadAll()` on mount with 10s polling

### With Sessions
- `openSession(sessionId)` opens new session in tabs
- Dispatched sessions appear in GlobalTerminalPanel
- Can attach to existing harness/machine session

### With Terminal
- `spawnTerminal()` opens shell on machine/harness
- Requires active launcher for target
- Routed through `POST /admin/terminal` API

---

## 12. Caching & Performance

### Target Cache (DispatchTargetSelect)
- **Signal:** `cachedTargets`
- **Duration:** 10 seconds
- **Update Triggers:**
  - Explicit `refreshTargets()` call
  - `ensureTargetsLoaded()` on 10s check
  - On-focus refresh in dropdown
- **Error Handling:** Stale data retained on failure

### Machine/Harness Data
- **Polls every 10 seconds** on respective pages
- **No caching:** Fresh fetch on each poll
- **Keeps UI up-to-date** with live launcher connections

### Application List
- **Loaded once on App mount**
- **Deferred feedback counts** (requestAnimationFrame)
- **No polling** (users rarely change app list)

---

## Summary

The dispatch UI is a multi-layered system:

1. **User-facing layer** (DispatchDialog) presents simple target selection
2. **Discovery layer** (DispatchPicker) enables search and navigation to setup pages
3. **Caching layer** (DispatchTargetSelect) aggregates machines and harnesses
4. **Management layer** (MachinesPage, HarnessesPage) allows CRUD of infrastructure
5. **Backend routing** dispatches to correct launcher or local execution

The system elegantly handles local-first dispatch (default), remote dispatch (via launcher), and isolated harness dispatch (Docker) through a single, unified interface.

