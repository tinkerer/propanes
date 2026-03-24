# Prompt Widget Codebase Analysis

## 1. Setup-Assist Route Handler (packages/server/src/routes/admin.ts)

### Location: Lines 957-1083

The `POST /setup-assist` endpoint provides AI-assisted setup for machines, harnesses, and agents.

**Handler Signature:**
```typescript
adminRoutes.post('/setup-assist', async (c) => {
  const body = await c.req.json();
  const { request, entityType, entityId } = body as {
    request?: string;
    entityType?: 'machine' | 'harness' | 'agent';
    entityId?: string;
  };
```

**Key Features:**
1. **Entity Lookup**: Retrieves the entity (machine/harness/agent) from DB if entityId provided
2. **Machine Detection**: For harness entities, also fetches the associated machine info
3. **Companion Terminal**: Spawns a companion terminal for machine entities with hostname/address
4. **Agent Dispatch**: Uses `dispatchAgentSession()` to spawn an AI assistant
5. **Linking**: Links companion terminal to agent session via `parentSessionId` and `companionSessionId`

**Workflow:**
1. Validates request text and entityType
2. Looks up entity (machine/harness/agent) from database
3. Finds default agent endpoint (or any available agent)
4. If entityType is 'machine', spawns companion terminal for interactive setup
5. Builds AI prompt based on entity type and current state
6. Creates feedback item with status='dispatched'
7. Dispatches to agent with interactive permission profile
8. Returns sessionId, feedbackId, and companionSessionId

**Database Operations:**
```typescript
// Entity lookup
db.select().from(schema.machines).where(eq(schema.machines.id, entityId)).get()
db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, entityId)).get()
db.select().from(schema.agentEndpoints).where(eq(schema.agentEndpoints.id, entityId)).get()

// Feedback creation
db.insert(schema.feedbackItems).values({ ... }).run()

// Session linking
db.update(schema.agentSessions)
  .set({ companionSessionId })
  .where(eq(schema.agentSessions.id, sessionId))
  .run()
```

---

## 2. Auto-Dispatch System (packages/server/src/auto-dispatch.ts)

**Full Implementation (29 lines):**

```typescript
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { feedbackEvents } from './events.js';
import { dispatchFeedbackToAgent } from './dispatch.js';

export function registerAutoDispatch() {
  feedbackEvents.on('new', (event: { id: string; appId: string | null; autoDispatch?: boolean; launcherId?: string }) => {
    handleAutoDispatch(event).catch((err) =>
      console.error(`[auto-dispatch] Error for feedback ${event.id}:`, err)
    );
  });
}

async function handleAutoDispatch(event: { id: string; appId: string | null; autoDispatch?: boolean; launcherId?: string }) {
  if (!event.appId || !event.autoDispatch) return;

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, event.appId)).get();
  if (!app || !app.autoDispatch) return;

  const agents = db.select().from(schema.agentEndpoints).all();
  const defaultAgent =
    agents.find((a) => a.isDefault && a.appId === event.appId) ||
    agents.find((a) => a.isDefault && !a.appId) ||
    agents[0];
  if (!defaultAgent) return;

  const result = await dispatchFeedbackToAgent({ feedbackId: event.id, agentEndpointId: defaultAgent.id, launcherId: event.launcherId });
  console.log(`[auto-dispatch] ${event.id} -> "${defaultAgent.name}": ${result.sessionId || 'webhook'}`);
}
```

**Key Behavior:**
1. Listens to 'new' feedback events
2. Filters by appId and autoDispatch flag
3. Checks application's autoDispatch setting
4. Agent selection priority:
   - App-specific default agent
   - Global default agent
   - First available agent
5. Supports launcherId passthrough for remote dispatch
6. Logs dispatch result (sessionId or 'webhook')

---

## 3. Harness Config Database Schema (packages/server/src/db/schema.ts)

**Table: harnessConfigs (Lines 143-164)**

```typescript
export const harnessConfigs = sqliteTable('harness_configs', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => applications.id, { onDelete: 'set null' }),
  machineId: text('machine_id').references(() => machines.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('stopped'),
  appImage: text('app_image'),
  appPort: integer('app_port'),
  appInternalPort: integer('app_internal_port'),
  serverPort: integer('server_port'),
  browserMcpPort: integer('browser_mcp_port'),
  targetAppUrl: text('target_app_url'),
  composeDir: text('compose_dir'),
  envVars: text('env_vars'),
  hostTerminalAccess: integer('host_terminal_access', { mode: 'boolean' }).notNull().default(false),
  launcherId: text('launcher_id'),
  lastStartedAt: text('last_started_at'),
  lastStoppedAt: text('last_stopped_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

**Column Details:**
- **id**: Primary key (ULID)
- **appId**: Optional reference to applications table
- **machineId**: Required reference to machines table (for Docker execution)
- **name**: Harness display name
- **status**: 'stopped' | 'starting' | 'running' | 'error'
- **appImage**: Docker image name (e.g., "my-app:latest")
- **appPort**: External port mapping
- **appInternalPort**: Internal container port
- **serverPort**: Server (proxy) port
- **browserMcpPort**: Browser MCP service port
- **targetAppUrl**: URL to access the running app
- **composeDir**: Directory containing docker-compose.yml
- **envVars**: JSON object of environment variables
- **hostTerminalAccess**: Boolean flag for host terminal access
- **launcherId**: Connected launcher that's running this harness
- **lastStartedAt**: Timestamp of last start
- **lastStoppedAt**: Timestamp of last stop
- **errorMessage**: Last error (if failed)
- **createdAt/updatedAt**: Timestamps

---

## 4. Launcher Registry (packages/server/src/launcher-registry.ts)

**Core Data Structure:**
```typescript
export interface LauncherInfo {
  id: string;
  name: string;
  hostname: string;
  ws: WebSocket;
  connectedAt: string;
  lastHeartbeat: string;
  activeSessions: Set<string>;
  capabilities: LauncherCapabilities;
  harness?: HarnessMetadata;
  isLocal?: boolean;
  machineId?: string;
  harnessConfigId?: string;
}
```

**Key Functions:**

1. **registerLauncher(info)**: 
   - Registers launcher in in-memory map
   - Updates machine status to 'online'
   - Updates harness config status to 'running' if harnessConfigId present
   - Closes any existing connection with same ID

2. **unregisterLauncher(id)**:
   - Removes launcher from registry
   - Updates machine status to 'offline' (if no other launchers from same machine)
   - Sets harness config status to 'stopped'

3. **getLauncher(id)**: Returns launcher by ID

4. **listLaunchers()**: Returns all registered launchers

5. **findAvailableLauncher()**: 
   - Returns launcher with lowest load
   - Skips local launchers
   - Checks WebSocket is OPEN (readyState === 1)
   - Respects maxSessions limit

6. **serializeLauncher(l)**: 
   - Converts LauncherInfo to JSON-serializable object
   - Includes: id, name, hostname, connectedAt, lastHeartbeat, activeSessions, capabilities, online status, harness flag, machineId, harnessConfigId

7. **listHarnesses()**: Returns only harness-type launchers

8. **sendAndWait(launcherId, message, responseType, timeoutMs)**:
   - Request/response mechanism with timeout
   - Returns Promise<LauncherToServerMessage>
   - Timeout default: 60 seconds
   - Key pattern: `${sessionId}:${responseType}`

9. **resolveLauncherResponse(msg)**: 
   - Resolves pending request by response type
   - Clears timeout
   - Called by launcher-daemon.ts when response arrives

10. **Heartbeat Management**:
    - updateHeartbeat(id, activeSessions): Updates lastHeartbeat and activeSessions
    - pruneStaleLaunchers(): Removes launchers inactive for 90+ seconds
    - startPruneTimer()/stopPruneTimer(): Manages pruning interval (30s check)

---

## 5. Launcher Daemon (packages/server/src/launcher-daemon.ts)

**Overview:** Remote process running on target machines, spawns Claude sessions via Docker/PTY.

**Key Features:**

### A. Environment Configuration
```typescript
const SERVER_WS_URL = process.env.SERVER_WS_URL || 'ws://localhost:3001/ws/launcher';
const LAUNCHER_ID = process.env.LAUNCHER_ID || `launcher-${os.hostname()}`;
const LAUNCHER_NAME = process.env.LAUNCHER_NAME || os.hostname();
const LAUNCHER_AUTH_TOKEN = process.env.LAUNCHER_AUTH_TOKEN || '';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);
const MACHINE_ID = process.env.MACHINE_ID || undefined;
const MAX_OUTPUT_LOG = 500 * 1024;
```

### B. Session Spawning (`spawnSession`)
- Supports three launch modes:
  1. **Tmux Attach**: Attach to existing tmux session (`tmuxTarget` param)
  2. **Tmux Spawn**: Spawn in tmux if available
  3. **PTY Direct**: Fallback to direct PTY spawn

- Claude command variations based on permission profile:
  - `interactive`: Full Claude CLI with --session-id, --allowedTools
  - `auto`: Headless mode with `-p` prompt flag
  - `yolo`: Skip permissions with `--dangerously-skip-permissions`
  - `plain`: Raw shell

- Session resume: When `resumeSessionId` provided, uses `--resume` instead of `--session-id`

### C. File Operations
- **Import**: `handleImportSessionFiles()` - writes JSONL + artifact files
- **Export**: `handleExportSessionFiles()` - exports JSONL + artifacts to target machine
- **Sync Codebase**: `handleSyncCodebase()` - git fetch + checkout via launcher

### D. Harness Commands
- **start_harness**: 
  ```typescript
  case 'start_harness': {
    env.HARNESS_CONFIG_ID = msg.harnessConfigId;
    env.COMPOSE_PROJECT_NAME = `pw-${msg.harnessConfigId}`.toLowerCase();
    execSync(`${envStr} docker compose up -d`, { cwd: msg.composeDir });
  }
  ```
  - Sets env vars from harnessConfig
  - Runs `docker compose up -d` in composeDir
  - Sends HarnessStatusUpdate to server

- **stop_harness**:
  ```typescript
  case 'stop_harness': {
    const projectName = `pw-${msg.harnessConfigId}`.toLowerCase();
    execSync(`docker compose -p ${projectName} down`, { cwd: msg.composeDir });
  }
  ```
  - Runs `docker compose down` with project name

- **launch_harness_session**:
  - Spawns Claude inside running harness container
  - Uses `docker compose exec` instead of PTY
  - Respects TTY requirements per permission profile

### E. Tmux Session Management
- Lists default tmux sessions via `listDefaultTmuxSessions()`
- Returns via `ListTmuxSessionsResult`
- Accessible via `/harness-configs/:id/host-tmux-sessions` route

### F. WebSocket Communication
- Registers with server on 'open'
- Sends LauncherRegister with capabilities (maxSessions, hasTmux, hasClaudeCli, hasDocker)
- Heartbeat every 30 seconds with active sessions list
- Handles 'close' with exponential backoff reconnect (max 30s delay)
- Graceful shutdown on SIGTERM/SIGINT

---

## 6. Existing Restart/Deploy Functionality

### A. Harness Start/Stop Routes (packages/server/src/routes/harness-configs.ts)

**POST /:id/start (Lines 101-143)**
```typescript
app.post('/:id/start', (c) => {
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  if (!config.machineId) return c.json({ error: 'No machine assigned' }, 400);

  const machineLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  if (!machineLauncher) return c.json({ error: 'Machine is offline' }, 400);

  const msg: StartHarness = {
    type: 'start_harness',
    harnessConfigId: id,
    appImage: config.appImage || undefined,
    appPort: config.appPort || undefined,
    appInternalPort: config.appInternalPort || undefined,
    serverPort: config.serverPort || undefined,
    browserMcpPort: config.browserMcpPort || undefined,
    targetAppUrl: config.targetAppUrl || undefined,
    composeDir: config.composeDir || undefined,
    envVars: config.envVars ? JSON.parse(config.envVars) : undefined,
  };

  machineLauncher.ws.send(JSON.stringify(msg));
  
  db.update(schema.harnessConfigs)
    .set({ status: 'starting', lastStartedAt: now, errorMessage: null, updatedAt: now })
    .where(eq(schema.harnessConfigs.id, id))
    .run();

  return c.json({ ok: true, status: 'starting' });
});
```

**POST /:id/stop (Lines 145-178)**
```typescript
app.post('/:id/stop', (c) => {
  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, id)).get();
  
  let targetLauncher;
  if (config.launcherId) {
    targetLauncher = getLauncher(config.launcherId);
  }
  if (!targetLauncher && config.machineId) {
    targetLauncher = launchers.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }

  if (targetLauncher && targetLauncher.ws?.readyState === 1) {
    const msg: StopHarness = {
      type: 'stop_harness',
      harnessConfigId: id,
      composeDir: config.composeDir || undefined,
    };
    targetLauncher.ws.send(JSON.stringify(msg));
  }

  db.update(schema.harnessConfigs)
    .set({ status: 'stopped', launcherId: null, lastStoppedAt: now, updatedAt: now })
    .where(eq(schema.harnessConfigs.id, id))
    .run();

  return c.json({ ok: true, status: 'stopped' });
});
```

### B. Status Update Mechanism
Harness status is updated via `HarnessStatusUpdate` messages from launcher:
```typescript
type HarnessStatusUpdate = {
  type: 'harness_status';
  harnessConfigId: string;
  status: 'running' | 'stopped' | 'error';
  errorMessage?: string;
};
```

Updates are processed in launcher-daemon.ts and sent to server, which updates DB records.

### C. Launcher Lifecycle
- **Registry Updates**: When launcher registers, harness config status → 'running', launcherId set
- **Deregistration**: When launcher disconnects, harness config status → 'stopped', launcherId cleared
- **Health**: Launchers tracked via WebSocket readyState === 1 (OPEN)

---

## Summary

**Setup-Assist**: AI-driven interactive setup for infrastructure entities, spawning companion terminals and dispatching to agents.

**Auto-Dispatch**: Automatic agent assignment for feedback, respecting app and global defaults.

**Harness Configs**: Docker Compose-based isolated test environments with port mapping and environment configuration.

**Launchers**: Remote daemons that execute sessions on target machines via WebSocket protocol, with heartbeat monitoring and load balancing.

**Restart/Deploy**: Existing `/start` and `/stop` routes send WebSocket messages to launchers, which execute `docker compose up/down` in configured directories.
