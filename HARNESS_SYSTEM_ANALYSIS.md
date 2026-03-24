# Harness Configuration System - Comprehensive Analysis

## 1. Harness Config Database Schema

**Table:** `harnessConfigs` (SQLite)

### Fields
```
id                  | PRIMARY KEY (ulid)
appId              | Foreign key → applications.id (set null on delete)
machineId          | Foreign key → machines.id (set null on delete)
name               | NOT NULL - Human-readable harness name
status             | DEFAULT 'stopped' - ('starting', 'running', 'stopped', 'error')
appImage           | Docker image name/tag (e.g., "my-org/my-app:latest")
appPort            | External port mapping for app
appInternalPort    | Container port for app
serverPort         | Port for pw-server in container (default 3001)
browserMcpPort     | Port for browser MCP server
targetAppUrl       | Full URL to reach app inside container (e.g., "http://pw-app:80")
composeDir         | Path to docker-compose directory on launcher machine
envVars            | JSON string → Record<string, string>
launcherId         | Which launcher is currently running this harness
lastStartedAt      | ISO timestamp
lastStoppedAt      | ISO timestamp
errorMessage       | Startup/runtime error from launcher
createdAt          | ISO timestamp
updatedAt          | ISO timestamp
```

### Key Notes
- All port fields are optional (can be null)
- `envVars` is stored as JSON string, parsed/stringified in routes
- `status` tracks harness lifecycle: stopped → starting → running (or error)
- `launcherId` is set by launcher-registry when a launcher picks up the harness
- No field for "host terminal access" exists yet


## 2. Harness Routes API (`packages/server/src/routes/harness-configs.ts`)

### GET `/` (List harnesses)
- Query param: `appId` (optional)
- Returns: Array of harness configs with `envVars` parsed from JSON

### POST `/` (Create harness)
- Body fields: all schema fields except id, createdAt, updatedAt, status
- Default status: 'stopped'
- Returns: created config (201)

### GET `/:id` (Get single harness)
- Returns: single harness config with parsed envVars
- 404 if not found

### PATCH `/:id` (Update harness)
- Accepts any subset of fields
- Updates: appId, machineId, name, appImage, all ports, targetAppUrl, composeDir, envVars
- Does NOT update: status, launcherId, lastStartedAt, lastStoppedAt, errorMessage
- These are managed by launcher-registry and daemon

### DELETE `/:id` (Delete harness)
- Soft or hard delete (implementation shows hard delete)
- Returns: {ok: true, id}

### POST `/:id/start` (Start harness)
1. Validates machine is assigned: `if (!config.machineId) return 400`
2. Finds launcher from machine: `launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1)`
3. Sends `StartHarness` message via WebSocket to launcher
4. Updates status to 'starting', sets lastStartedAt, clears errorMessage
5. Returns: {ok: true, status: 'starting'}

### POST `/:id/stop` (Stop harness)
1. Finds launcher by `config.launcherId` or `config.machineId`
2. Sends `StopHarness` message to launcher
3. Updates status to 'stopped', clears launcherId, sets lastStoppedAt
4. Returns: {ok: true, status: 'stopped'}

### POST `/:id/session` (Launch session in harness)
1. Validates harness status === 'running'
2. Finds launcher by config.launcherId or config.machineId
3. Body params: prompt, serviceName (default 'pw-server'), permissionProfile
4. Calls `dispatchHarnessSession()` in dispatch.ts
5. Returns: {ok: true, sessionId}
6. **NOTE:** This is where we'd need to add host terminal access


## 3. Launcher Daemon (`packages/server/src/launcher-daemon.ts`)

### Launcher Registration (lines 582-606)
- Registers with server via WebSocket
- Sends capabilities: maxSessions, hasTmux, hasClaudeCli, hasDocker
- Sets: LAUNCHER_ID, LAUNCHER_NAME, LAUNCHER_AUTH_TOKEN, MACHINE_ID (from env vars)

### Start Harness Handler (lines 419-458)
1. Validates `docker` is available
2. Builds env dict with all config vars + HARNESS_CONFIG_ID + COMPOSE_PROJECT_NAME
3. Sets CLAUDE_HOME if it exists
4. Runs: `docker compose up -d` in composeDir (with env vars prefixed)
5. Sends `HarnessStatusUpdate` back to server
6. On error: sends error message

### Stop Harness Handler (lines 461-477)
1. Constructs project name: `pw-${harnessConfigId}`.toLowerCase()
2. Runs: `docker compose -p <project> down`
3. Sends `HarnessStatusUpdate` with status 'stopped' or error

### Launch Harness Session Handler (lines 491-572)
1. Builds `docker compose exec` command
2. Uses TTY flags based on permissionProfile:
   - Interactive/plain: needs TTY → no -T flag
   - Auto/yolo: no TTY → adds -T flag
3. Spawns via tmux or direct PTY
4. Sends session started/output/ended messages to server


## 4. Launcher Registry (`packages/server/src/launcher-registry.ts`)

### LauncherInfo Interface
```typescript
interface LauncherInfo {
  id: string;
  name: string;
  hostname: string;
  ws: WebSocket;
  connectedAt: string;
  lastHeartbeat: string;
  activeSessions: Set<string>;
  capabilities: LauncherCapabilities;
  harness?: HarnessMetadata;        // For harness launchers
  isLocal?: boolean;
  machineId?: string;               // Links to machines table
  harnessConfigId?: string;         // Links to harnessConfigs table
}
```

### Register Launcher (lines 25-54)
- If machine registered: updates machine status to 'online'
- If harness launcher: updates harnessConfig status to 'running', sets launcherId

### Unregister Launcher (lines 56-88)
- If machine had other launchers: only then marks offline
- If harness launcher: sets harnessConfig status to 'stopped', clears launcherId


## 5. Dispatch System (`packages/server/src/dispatch.ts`)

### dispatchHarnessSession() (lines 819-874)
```typescript
async function dispatchHarnessSession(params: {
  harnessConfigId: string;
  launcherId: string;
  prompt: string;
  composeDir?: string;
  serviceName?: string;           // default 'pw-server'
  permissionProfile: PermissionProfile;
}): Promise<{ sessionId: string }>
```

Flow:
1. Creates agentSession record (feedbackId: null, agentEndpointId: null)
2. Validates launcher is connected
3. Sends `LaunchHarnessSession` message to launcher
4. Returns sessionId

**Key insight:** Currently only launches Claude CLI sessions inside containers.
- No option for "host terminal access"
- The serviceName parameter determines which container service gets the command


## 6. Shared Protocols (`packages/shared/src/launcher-protocol.ts`)

### StartHarness Message
```typescript
interface StartHarness {
  type: 'start_harness';
  harnessConfigId: string;
  appImage?: string;
  appPort?: number;
  appInternalPort?: number;
  serverPort?: number;
  browserMcpPort?: number;
  targetAppUrl?: string;
  composeDir?: string;
  envVars?: Record<string, string>;
}
```

### StopHarness Message
```typescript
interface StopHarness {
  type: 'stop_harness';
  harnessConfigId: string;
  composeDir?: string;
}
```

### LaunchHarnessSession Message
```typescript
interface LaunchHarnessSession {
  type: 'launch_harness_session';
  sessionId: string;
  harnessConfigId: string;
  prompt: string;
  composeDir?: string;
  serviceName?: string;
  permissionProfile: PermissionProfile;
  cols: number;
  rows: number;
}
```

### HarnessMetadata (for live harnesses)
```typescript
interface HarnessMetadata {
  targetAppUrl: string;
  browserMcpUrl: string;
  composeProject?: string;
  appImage?: string;
  appPort?: number;
  serverPort?: number;
}
```


## 7. Admin UI Harness Management (`packages/admin/src/pages/HarnessesPage.tsx`)

### Form Fields
- name, appId, machineId, appImage, appPort, appInternalPort, serverPort, browserMcpPort
- targetAppUrl, composeDir, envVars (JSON editor)

### Key Functions
1. `loadAll()` - Fetches harness configs + live harnesses + machines + apps
2. `openAdd()` / `openEdit()` - Form management
3. `handleSubmit()` - POST/PATCH via api.createHarnessConfig() or api.updateHarnessConfig()
4. `handleStart()` / `handleStop()` - Control harness lifecycle
5. `handleLaunchSession()` - Launches Claude session with 'yolo' profile
6. `handleSpawnTerminal()` - Currently routes to api.spawnTerminal()
7. `getHarnessUrl()` - Constructs external admin URL

### UI Sections
- Managed harness configs (from DB)
- Unmanaged live harnesses (connected launchers with harness metadata)
- Status badges, timestamps, error messages

### Notes
- Form does NOT have a "host terminal access" toggle
- `handleSpawnTerminal()` calls `api.spawnTerminal({ harnessConfigId, launcherId })`
  (appears to be a separate, existing feature for plain terminal spawning)


## 8. What Would Change for "Host Terminal Access" Feature

### Database Schema (harnessConfigs table)
Add new field:
```
allowHostTerminalAccess | boolean | DEFAULT false
```

### Harness Routes (harness-configs.ts)
1. PATCH endpoint: add field to updateable list
2. POST `/:id/host-terminal` (new endpoint):
   - Find launcher for harness
   - Determine host launcher (not container launcher)
   - Launch session with special handling
   - Return sessionId

### Launcher Daemon (launcher-daemon.ts)
Add new message handler for `LaunchHostTerminal`:
```typescript
interface LaunchHostTerminal {
  type: 'launch_host_terminal';
  sessionId: string;
  harnessConfigId: string;
  prompt: string;
  cwd?: string;
  permissionProfile: PermissionProfile;
  cols: number;
  rows: number;
}
```

Flow:
- Similar to `launch_harness_session` but does NOT use `docker compose exec`
- Instead: spawns regular terminal process directly on host (not in container)
- Allows access to host filesystem, tools, processes
- Security implications: grants access outside container isolation

### Launcher Protocol (launcher-protocol.ts)
Add `LaunchHostTerminal` to `ServerToLauncherMessage` union
- Parallel to `LaunchHarnessSession` but without docker wrapper

### Dispatch (dispatch.ts)
Add `dispatchHostTerminalSession()`:
```typescript
async function dispatchHostTerminalSession(params: {
  harnessConfigId: string;
  launcherId: string;
  prompt: string;
  permissionProfile: PermissionProfile;
}): Promise<{ sessionId: string }>
```
- Similar to `dispatchHarnessSession()` but sends `LaunchHostTerminal` message

### Admin UI (HarnessesPage.tsx)
1. Add form field: `allowHostTerminalAccess` checkbox
2. Display on harness card: button to "Open Host Terminal" (if allowed + harness running)
3. New handler: `handleHostTerminal(id)` to call new API endpoint
4. Show different button/UI from "Session" vs "Host Terminal"

### Backend Configuration
Add to harness config: optional host cwd/working directory
- where host terminal should start
- security consideration: restrict to specific paths

### Security Considerations
- Host terminal access breaks container isolation
- Should require explicit per-harness opt-in flag
- May want audit logging of host terminal sessions
- Recommend warning in UI: "HOST TERMINAL GRANTS ACCESS TO HOST FILESYSTEM"


## 9. Session Architecture

### Session Types
1. **Agent Session** (dispatch.ts: dispatchAgentSession)
   - Runs Claude CLI with feedback context
   - Can be local or remote (via launcher)
   - Stores: feedbackId, agentEndpointId, claudeSessionId

2. **Harness Session** (dispatch.ts: dispatchHarnessSession)
   - Runs `docker compose exec` in harness container
   - New: could add harness + hostTerminal field

3. **Terminal Session** (dispatch.ts: dispatchTerminalSession)
   - Plain shell terminal, no Claude
   - Used for manual inspection

4. **Host Terminal Session** (hypothetical)
   - Plain shell on launcher host
   - No container isolation
   - Would add to schema + dispatch


### agentSessions Table Fields Relevant to Harness
```
id              | sessionId (ulid)
feedbackId      | null for harness sessions
agentEndpointId | null for harness sessions
permissionProfile | 'yolo' for harness typically
status          | 'pending' → 'running' → 'completed'/'failed'
outputLog       | Captured terminal output (500KB max)
launcherId      | Which launcher is running it
tmuxSessionName | If using tmux
createdAt       | ISO timestamp
```


## 10. Integration Points Summary

```
User creates/edits harness config
    ↓ (HarnessesPage.tsx)
Admin API: POST /api/v1/admin/harness-configs
    ↓ (harness-configs.ts route)
Database: INSERT/UPDATE harnessConfigs table
    ↓
User clicks "Start" button
    ↓ (handleStart in HarnessesPage.tsx)
Admin API: POST /api/v1/admin/harness-configs/:id/start
    ↓ (harness-configs.ts: /start route)
Find launcher: launchers.find(l => l.machineId === config.machineId)
    ↓
Send StartHarness message via WebSocket
    ↓ (launcher-daemon.ts: handleServerMessage)
Execute: `docker compose up -d` with env vars
    ↓
Send HarnessStatusUpdate back to server
    ↓ (launcher-registry.ts: updates DB status)
Update harnessConfigs.status → 'running'

---

User clicks "Session" button (existing)
    ↓ (handleLaunchSession in HarnessesPage.tsx)
Admin API: POST /api/v1/admin/harness-configs/:id/session
    ↓ (harness-configs.ts: /session route)
Call dispatchHarnessSession()
    ↓ (dispatch.ts)
Send LaunchHarnessSession message to launcher
    ↓ (launcher-daemon.ts)
Execute: `docker compose exec pw-server claude -p "...prompt..."`
    ↓
Spawn PTY in tmux, stream output back
    ↓
User sees session in /admin/#/sessions tab
```

