# Prompt Widget Codebase Exploration Report

## Overview

The prompt-widget is a full-stack feedback overlay system with support for remote terminal/harness management, agent dispatch, and session bridging across local and remote machines.

---

## 1. TERMINAL SIDEBAR & CREATION FLOW

### Terminal Sidebar Component
**File:** `/packages/admin/src/components/GlobalTerminalPanel.tsx`

#### The "+" Button (New Terminal)
- **Location:** Lines 841-852
- **Component:** `<button class="terminal-collapse-btn">+</button>`
- **Behavior:** Toggles `newTermPickerOpen` signal to show/hide `<NewTerminalPicker>`
- **State:** `newTermPickerOpen` is a Preact signal (line 77)

#### Terminal Creation Pickers

**1. NewTerminalPicker (Lines 184-263)**
- Appears above the "+" button in a dropdown menu
- Options:
  - "Local terminal" → calls `spawnTerminal(selectedAppId.value)`
  - "Remote machines" section (from `getDispatchTargets()`) → `spawnTerminal(selectedAppId.value, launcherId)`
  - "Harnesses" section → `spawnTerminal(selectedAppId.value, launcherId)`
  - "Attach tmux" section → `attachTmuxSession(tmuxName, selectedAppId.value)`

**2. TerminalCompanionPicker (Lines 81-182)**
- Appears when adding a terminal companion to an existing session
- Allows picking existing terminal sessions, creating new ones, or attaching tmux sessions

#### Terminal Creation Functions
**File:** `/packages/admin/src/lib/sessions.ts`

```typescript
export async function spawnTerminal(appId?: string, launcherId?: string) {
  const result = await api.spawnTerminal({ appId, launcherId });
  return result.sessionId;
}

export async function attachTmuxSession(tmuxTarget: string, appId?: string) {
  const result = await api.attachTmuxSession({ tmuxTarget, appId });
  return result.sessionId;
}
```

#### What Happens When "+" is Clicked

1. User clicks "+" button (line 845)
2. `newTermPickerOpen.value` toggles to `true`
3. `NewTerminalPicker` component renders (line 850-851)
4. User selects option (local, remote machine, harness, or tmux)
5. Corresponding function is called:
   - `spawnTerminal(appId?, launcherId?)` 
   - `attachTmuxSession(tmuxName, appId?)`
6. Session is created and added to `openTabs`
7. Terminal component (`AgentTerminal`) connects via WebSocket to session

### Terminal Data Display

**Terminal Tab Bar (Lines 500-607)**
- Shows all open terminal sessions with labels
- Labels show:
  - For plain terminals: `{paneCommand}:{panePath}` or `{paneTitle}`
  - For labeled sessions: custom label set by user (double-click to rename)
  - With icon `🖥️` prefix for plain mode terminals
- Status dot shows:
  - Green/normal: running
  - Gray: exited
  - Color codes: waiting (yellow), busy (blue), error (red) based on `inputState`

**Tab Numbering**
- `allNumberedSessions()` creates global tab order
- Tabs can be navigated via Ctrl+Shift + number
- Badge shows "1", "2", etc. when Ctrl+Shift held

---

## 2. MACHINES PAGE

**File:** `/packages/admin/src/pages/MachinesPage.tsx`

### Data Model
```typescript
interface Machine {
  id: string;                    // ULID
  name: string;                  // User-assigned name
  hostname?: string;             // e.g., "lab-mini.local"
  address?: string;              // IP or domain, e.g., "10.0.0.5"
  type: 'local' | 'remote' | 'cloud';
  status: 'online' | 'offline';  // Live (has connected launcher)
  capabilities?: {
    hasDocker?: boolean;
    hasTmux?: boolean;
    hasClaudeCli?: boolean;
  };
  tags?: string[];               // Custom labels
  lastSeenAt?: string;           // ISO timestamp
  createdAt: string;
  updatedAt: string;
}
```

### UI Layout
- **Header:** "Machines" title + "Add Machine" button (line 116)
- **Form:** Add/Edit machine with fields:
  - Name (required)
  - Hostname
  - Address
  - Type dropdown (local, remote, cloud)
  - Tags (comma-separated)
- **Machine Cards:**
  - Name + status badge (ONLINE/OFFLINE, colored)
  - Type badge
  - Meta tags: hostname, address, capabilities
  - Custom tags displayed as pills
  - Last seen timestamp
  - Buttons: Setup Assist, Edit, Delete

### Status Management
- **Real-time:** Every 10 seconds, `loadMachines()` refreshes (line 101)
- **Online Detection:** Checks if any launcher is connected with `machineId` match
- **Live Status:** Merged from `listLaunchers()` in dispatch-targets endpoint

### API Methods
**File:** `/packages/admin/src/lib/api.ts` (lines 354-370)

```typescript
getMachines: () => request<any[]>('/admin/machines'),
createMachine: (data: Record<string, unknown>) => 
  request<any>('/admin/machines', { method: 'POST', body: JSON.stringify(data) }),
updateMachine: (id: string, data: Record<string, unknown>) =>
  request<any>(`/admin/machines/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
deleteMachine: (id: string) =>
  request<{ ok: boolean; id: string }>(`/admin/machines/${id}`, { method: 'DELETE' }),
```

### Backend Routes
**File:** `/packages/server/src/routes/machines.ts`

- `GET /` - List all machines with live status
- `POST /` - Create machine
- `GET /:id` - Get single machine with live status
- `PATCH /:id` - Update machine
- `DELETE /:id` - Delete machine (unlinks harness configs)

---

## 3. HARNESSES PAGE

**File:** `/packages/admin/src/pages/HarnessesPage.tsx`

### Data Model
```typescript
interface HarnessConfig {
  id: string;                      // ULID
  name: string;                    // User-assigned name
  appId?: string;                  // Linked application
  machineId?: string;              // Assigned machine
  status: 'stopped' | 'starting' | 'running' | 'error';
  appImage?: string;               // Docker image, e.g., "my-org/my-app:latest"
  appPort?: number;                // External app port
  appInternalPort?: number;        // Container app port
  serverPort?: number;             // pw-server port (default 3001)
  browserMcpPort?: number;         // Browser MCP port
  targetAppUrl?: string;           // URL inside container, e.g., "http://pw-app:80"
  composeDir?: string;             // Path to docker-compose directory
  envVars?: Record<string, string>; // Environment variables (JSON)
  createdAt: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  errorMessage?: string;           // If status is 'error'
}
```

### UI Layout
- **Header:** "Harnesses" title + "Create Harness" button
- **Form:** Create/Edit harness with fields:
  - Name (required)
  - Application selector (dropdown)
  - Machine selector (dropdown showing status)
  - App Image
  - Port fields: App Port, Internal Port, Server Port, Browser MCP Port
  - Target App URL
  - Compose Dir
  - Env Vars (JSON textarea)
- **Harness Cards:**
  - Name + status badge (STOPPED, STARTING, RUNNING, ERROR)
  - App ID and Machine name tags
  - App Image tag
  - URLs: External (if running) and internal app URL
  - Port summary
  - Error message (if any)
  - Creation and last started timestamp
  - **Action buttons:**
    - If stopped/error: "Start" button
    - If running: "Session" button (launch Claude session), "Stop" button
    - Always: "Edit", "Delete" buttons

### Status Management
- **Real-time:** Every 10 seconds, `loadAll()` refreshes all data
- **Running Status:** Checks if harness config has status='running' and launcher is online
- **URL Generation:** `getHarnessUrl()` builds `http://{machine.address}:{serverPort}/admin/`

### Harness Lifecycle

1. **Create:** POST `/admin/harness-configs` with config data
2. **Start:** POST `/admin/harness-configs/{id}/start`
   - Finds launcher connected from machineId
   - Sends StartHarness message to launcher
   - Status changes to 'starting'
3. **Running:** Launcher reports status back, status becomes 'running'
4. **Launch Session:** POST `/admin/harness-configs/{id}/session`
   - Returns sessionId for Claude Code session in container
5. **Stop:** POST `/admin/harness-configs/{id}/stop`
   - Status changes to 'stopped'
   - Launcher unlinked

### API Methods
**File:** `/packages/admin/src/lib/api.ts` (lines 372-403)

```typescript
getHarnessConfigs: (appId?: string) => 
  request<any[]>(`/admin/harness-configs${qs}`),
createHarnessConfig: (data: Record<string, unknown>) =>
  request<any>('/admin/harness-configs', { method: 'POST', body: JSON.stringify(data) }),
updateHarnessConfig: (id: string, data: Record<string, unknown>) =>
  request<any>(`/admin/harness-configs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
deleteHarnessConfig: (id: string) =>
  request<{ ok: boolean; id: string }>(`/admin/harness-configs/${id}`, { method: 'DELETE' }),
startHarness: (id: string) =>
  request<{ ok: boolean; status: string }>(`/admin/harness-configs/${id}/start`, { method: 'POST' }),
stopHarness: (id: string) =>
  request<{ ok: boolean; status: string }>(`/admin/harness-configs/${id}/stop`, { method: 'POST' }),
launchHarnessSession: (id: string, data?: {...}) =>
  request<{ ok: boolean; sessionId: string }>(`/admin/harness-configs/${id}/session`, { method: 'POST' }),
```

### Backend Routes
**File:** `/packages/server/src/routes/harness-configs.ts`

- `GET /` - List harness configs (optionally filtered by appId)
- `POST /` - Create harness config
- `GET /:id` - Get single harness config
- `PATCH /:id` - Update harness config
- `DELETE /:id` - Delete harness config
- `POST /:id/start` - Start harness (sends message to launcher)
- `POST /:id/stop` - Stop harness (sends message to launcher)
- `POST /:id/session` - Launch Claude session in harness container

---

## 4. DISPATCH TARGETS & REMOTE TERMINAL FUNCTIONALITY

### Dispatch Targets Endpoint
**File:** `/packages/server/src/routes/admin.ts` (lines 603-653)

Returns list of available targets for terminal spawn and agent dispatch:

```typescript
interface DispatchTarget {
  launcherId: string;        // Launcher ID
  name: string;              // Machine or harness name
  hostname: string;          // From launcher
  machineName: string | null; // From machines table
  machineId: string | null;  // Foreign key to machines
  isHarness: boolean;        // True if harness config, false if machine
  harnessConfigId: string | null;
  activeSessions: number;    // Current session count
  maxSessions: number;       // From launcher capabilities
}
```

**Sources:**
1. Connected launchers with `isLocal=false` and `readyState=1`
2. Running harness configs with connected launchers

### Terminal Creation Flow (Backend)

**Endpoint:** `POST /admin/terminal`
**File:** `/packages/server/src/routes/admin.ts` (lines 1300-1319)

```typescript
POST /admin/terminal
Body: { cwd?: string, appId?: string, launcherId?: string }
Response: { sessionId: string }
```

**Flow:**
1. Receives cwd, appId, launcherId
2. If appId provided but no cwd, resolves cwd from application.projectDir
3. Calls `dispatchTerminalSession({ cwd, appId, launcherId })`
4. Returns sessionId

**Backend Function:** `dispatchTerminalSession` in `/packages/server/src/dispatch.ts`
- Creates a new agent session with permissionProfile='plain'
- Targets specified launcher (remote machine or harness)
- PTY allocated on remote

### Tmux Attach Flow

**Endpoint:** `POST /admin/terminal/attach-tmux`
**File:** `/packages/server/src/routes/admin.ts` (lines 1328-1343)

```typescript
POST /admin/terminal/attach-tmux
Body: { tmuxTarget: string, appId?: string }
Response: { sessionId: string }
```

**Flow:**
1. `tmuxTarget` = tmux session name to attach
2. Calls `dispatchTmuxAttachSession({ tmuxTarget, appId })`
3. Creates new agent session with PTY bridge to existing tmux session
4. Returns sessionId

**Tmux Session Listing:**
**Endpoint:** `GET /admin/tmux-sessions`
**File:** `/packages/server/src/routes/admin.ts` (lines 1322-1325)

Returns list of available tmux sessions from default server:
```typescript
Response: { 
  sessions: Array<{
    name: string;
    windows: number;
    created: string;
    attached: boolean;
  }>
}
```

---

## 5. MACHINE/HARNESS DATA AVAILABILITY

### On MachinesPage
**Available Fields per Machine:**
- id, name, hostname, address
- type (local|remote|cloud)
- status (online|offline from live launcher check)
- capabilities (hasDocker, hasTmux, hasClaudeCli)
- tags (custom labels)
- lastSeenAt (timestamp)

**Loaded via:** `api.getMachines()` every 10s

### On HarnessesPage
**Available for Each Harness Config:**
- All fields from HarnessConfig model (see above)
- Live status: 'running' if harness has launcher connected
- URL generation based on machine.address + serverPort
- App name via appId lookup in applications
- Machine name via machineId lookup in machines

**Loaded via:**
- `api.getHarnessConfigs()`
- `api.getHarnesses()` (live harnesses from launchers)
- `api.getMachines()` (for lookups)
- `api.getApplications()` (for lookups)

### In Terminal Pickers
**Available in NewTerminalPicker (lines 186-187):**
```typescript
const targets = cachedTargets.value;
const machines = targets.filter(t => !t.isHarness);
const harnesses = targets.filter(t => t.isHarness);
```

**Fields for Each Target:**
- launcherId, name, hostname, machineName, machineId
- isHarness, activeSessions, maxSessions

---

## 6. AGENT ACTIONS & HARNESS CONTROL

### Harness Card Action Buttons
**File:** `/packages/admin/src/pages/HarnessesPage.tsx` (lines 346-360)

**Conditional Buttons:**

1. **If status = 'stopped' or 'error':**
   - `Start` button → `handleStart(h.id)`
   - Disabled if no machineId assigned

2. **If status = 'running':**
   - `Session` button → `handleLaunchSession(h.id)`
     - Launches Claude Code session inside harness container
     - Calls `api.launchHarnessSession(id, { permissionProfile: 'yolo' })`
   - `Stop` button → `handleStop(h.id)`
     - Sends stop message to launcher
     - Unlinks launcherId from harness config

3. **Always visible:**
   - `Edit` button → Opens form with current config
   - `Delete` button → Removes harness config

### Backend Handler: Launch Harness Session
**File:** `/packages/server/src/routes/harness-configs.ts` (lines 178-218)

```typescript
POST /admin/harness-configs/:id/session
Body: { prompt?: string, permissionProfile?: string, serviceName?: string }
Response: { ok: true, sessionId: string }
```

**Flow:**
1. Finds harness config
2. Checks status is 'running'
3. Finds connected launcher for harness
4. Calls `dispatchHarnessSession({...})`
5. Returns sessionId for Claude Code UI to connect

---

## 7. REMOTE HARNESS CONNECTIONS

### Launcher-to-Server Connection
**Mechanism:** WebSocket bidirectional messages

**Launcher Metadata Tracked:**
- `id`: Launcher ID
- `name`: Name (e.g., "remote-lab")
- `hostname`: Hostname of remote machine
- `machineId`: Foreign key to machines table
- `isLocal`: Boolean (true = local, false = remote)
- `capabilities.maxSessions`: Max concurrent sessions
- `activeSessions`: Current running sessions (Set)
- `harness?`: If running harness, harness metadata
- `harnessConfigId?`: Link to harness config

**Connection Status:**
- `ws.readyState === 1`: Connected
- Otherwise: Disconnected (offline)

### Machine Address & Connectivity
**Used For:**
1. **External URL generation** - Harness UI at `http://{machine.address}:{serverPort}/admin/`
2. **Setup assist** - SSH checks to machine address
3. **Display** - Shows in machine card and harness config

**Example Addresses:**
- `10.0.0.5` (IP)
- `lab.tailnet` (Tailscale domain)
- `lab-mini.local` (mDNS)

### How Remote Terminals Work
1. User clicks "+" → picks "Remote machine" or "Harness"
2. Frontend calls `spawnTerminal(appId?, launcherId)`
3. Backend `dispatchTerminalSession({ launcherId })` creates agent session targeting that launcher
4. Launcher PTY allocated on remote machine
5. AgentTerminal WebSocket connects to session
6. Input/output flows through session bridge (sequenced protocol)

---

## 8. KEY INTEGRATION POINTS

### Frontend State Management
**File:** `/packages/admin/src/lib/sessions.ts`

**Terminal State:**
- `openTabs`: Array of session IDs
- `activeTabId`: Currently viewed session
- `splitEnabled`: Split pane mode
- `panelMinimized/Maximized`: Panel state
- `sessionLabels`: Custom names (persisted in localStorage)

**Dispatch Targets Cache:**
**File:** `/packages/admin/src/components/DispatchTargetSelect.tsx`

```typescript
export const cachedTargets = signal<any[]>([]);
export const refreshTargets = () => api.getDispatchTargets();
export const ensureTargetsLoaded = () => { /* calls refreshTargets if needed */ }
```

### Real-time Updates
- **Feedback events:** SSE at `/admin/feedback/events` (live new/updated feedback)
- **Machine status:** Every 10s refresh via `getMachines()`
- **Harness status:** Every 10s refresh via `getHarnessConfigs()` + `getHarnesses()`
- **Terminal sessions:** WebSocket-based (real-time)

---

## 9. SETUP ASSIST & MACHINE/HARNESS MANAGEMENT

**File:** `/packages/admin/src/components/SetupAssistButton.tsx`

**Setup Assist Flow:**
1. Button on machines/harnesses cards
2. Dispatches to Claude agent with context (existing configs, available machines, APIs)
3. Agent generates instructions for user
4. Can create/edit via API calls within agent session

**Context Provided:**
- Existing machines/harnesses/agents
- Available applications
- API endpoints (POST, PATCH paths)
- Field documentation
- Workflow guidance

---

## 10. DISPATCH & AGENT WORKFLOW

### Dispatch Endpoint
**File:** `/packages/server/src/routes/admin.ts` (lines 655-730)

```typescript
POST /admin/dispatch
Body: { 
  feedbackId: string,
  agentEndpointId: string,
  instructions?: string,
  launcherId?: string
}
Response: { 
  dispatched: boolean,
  sessionId?: string,
  status: number,
  response: string,
  existing?: boolean
}
```

**Flow:**
1. Validates feedback and agent endpoint exist
2. If agent mode is 'webhook': forwards to external URL
3. If mode is 'interactive'/'headless': launches local Claude session
4. Optionally targets specific launcher via `launcherId`
5. Session created with agent prompt and feedback context

---

## SUMMARY TABLE

| Component | Key Files | Purpose |
|-----------|-----------|---------|
| **Terminal Sidebar** | GlobalTerminalPanel.tsx | Manages open terminal tabs |
| **New Terminal Picker** | GlobalTerminalPanel.tsx (lines 184-263) | Select where to spawn terminal |
| **Machines Page** | MachinesPage.tsx | Register/manage remote machines |
| **Harnesses Page** | HarnessesPage.tsx | Create/manage harness configs |
| **Dispatch Targets** | admin.ts (lines 603-653) | List available launchers |
| **Launcher Registry** | launcher-registry.ts | Track live launcher connections |
| **Terminal Dispatch** | admin.ts (lines 1300-1319) | Create plain terminal session |
| **Tmux Attach** | admin.ts (lines 1328-1343) | Attach to existing tmux |
| **Harness Lifecycle** | harness-configs.ts | Start/stop/session manage harness |
| **State Management** | sessions.ts | UI state, persistence, focus |
| **API Client** | api.ts | Frontend API methods |

---

## COMPLETE ARCHITECTURE FLOW

```
User Interface (Admin SPA)
    ↓
GlobalTerminalPanel (UI Component)
    ├─ TabBar (Shows open sessions)
    ├─ "+" Button → NewTerminalPicker
    │   ├─ "Local terminal" → spawnTerminal()
    │   ├─ "Remote machine" → spawnTerminal(appId, launcherId)
    │   ├─ "Harness" → spawnTerminal(appId, launcherId)
    │   └─ "Attach tmux" → attachTmuxSession()
    │
    ├─ MachinesPage
    │   ├─ List machines (api.getMachines)
    │   ├─ Create/edit/delete machines
    │   └─ Show status from launcher registry
    │
    └─ HarnessesPage
        ├─ List harness configs (api.getHarnessConfigs)
        ├─ Create/edit/delete
        ├─ Start/stop harness (sends to launcher)
        └─ Launch session in harness
            
            ↓ API Calls ↓
            
Backend Routes (/api/v1/admin)
    ├─ /terminal (POST) → dispatchTerminalSession
    ├─ /terminal/attach-tmux (POST) → dispatchTmuxAttachSession
    ├─ /dispatch-targets (GET) → listLaunchers + running harnesses
    ├─ /machines* (CRUD) → machines table
    ├─ /harness-configs* (CRUD) → harness configs table
    │   ├─ /:id/start (POST) → send StartHarness to launcher
    │   ├─ /:id/stop (POST) → send StopHarness to launcher
    │   └─ /:id/session (POST) → dispatchHarnessSession
    └─ /dispatch (POST) → dispatchFeedbackToAgent
    
        ↓ (via Launcher WebSocket Connection) ↓
        
Remote Launchers
    ├─ Register on connect (machineId, harness metadata)
    ├─ Listen for start_harness / stop_harness messages
    ├─ Manage PTY for terminal sessions
    ├─ Report harness status back
    └─ Provide tmux session list
    
        ↓ (AgentTerminal WebSocket) ↓
        
Session Service
    ├─ Allocate PTY on launcher
    ├─ Bridge input/output sequenced protocol
    ├─ Manage reconnection logic
    └─ Handle terminal emulation (xterm.js)
```

