# Prompt Widget Codebase Section Analysis Report
**Date:** 2026-03-01  
**Status:** Read-only exploration task complete

---

## 1. Server Routes: `/admin/dispatch` Handler

**File:** `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/admin.ts`  
**Lines:** 580-654

### Handler Definition
```typescript
adminRoutes.post('/dispatch', async (c) => {
  const body = await c.req.json();
  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { feedbackId, agentEndpointId, instructions } = parsed.data;
  // ... dispatch logic
  const result = await dispatchFeedbackToAgent({ feedbackId, agentEndpointId, instructions });
  return c.json(result);
});
```

### Current Implementation Details
- **Input validation:** Uses `dispatchSchema.safeParse()` from shared schemas
- **Parameters extracted:** `feedbackId`, `agentEndpointId`, `instructions`
- **Pre-dispatch checks:** Detects and kills stuck sessions for non-webhook agents (30+ seconds old)
- **Dispatch execution:** Calls `dispatchFeedbackToAgent()` function from dispatch module
- **Error handling:** Catches SessionServiceError (503), returns 404 for not found, 500 for general errors
- **Response format:** Returns object with `dispatched`, `sessionId`, `status`, `response`, and optional `existing` flag

### Key Observation
**Does NOT currently pass launcherId** - The dispatch schema and function parameters need to be extended to support specifying which launcher should handle the dispatch.

---

## 2. Server Routes: `/admin/terminal` Handler

**File:** `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/admin.ts`  
**Lines:** 1224-1243

### Handler Definition
```typescript
adminRoutes.post('/terminal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cwd, appId } = body as { cwd?: string; appId?: string };

  let resolvedCwd = cwd || process.cwd();
  if (!cwd && appId) {
    const app = await db.query.applications.findFirst({
      where: eq(schema.applications.id, appId),
    });
    if (app?.projectDir) resolvedCwd = app.projectDir;
  }

  try {
    const { sessionId } = await dispatchTerminalSession({ cwd: resolvedCwd, appId });
    return c.json({ sessionId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});
```

### Current Implementation Details
- **Parameters:** `cwd` (optional), `appId` (optional)
- **CWD resolution:** Uses provided `cwd` or resolves from app's `projectDir`
- **Dispatch:** Calls `dispatchTerminalSession()` with resolved `cwd` and `appId`
- **Response:** Returns `{ sessionId }`
- **Error handling:** 500 status with error message

### Key Observation
**Does NOT currently pass launcherId** - Terminal spawning needs to support targeting specific launchers.

---

## 3. Server Routes: Import Section

**File:** `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/admin.ts`  
**Lines:** 1-31

### Critical Imports
```typescript
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq, desc, asc, like, and, or, isNull, sql, inArray, ne } from 'drizzle-orm';
import {
  feedbackListSchema,
  feedbackUpdateSchema,
  adminFeedbackCreateSchema,
  batchOperationSchema,
  agentEndpointSchema,
  dispatchSchema,  // <-- KEY: Dispatch validation schema
} from '@prompt-widget/shared';
import { db, schema } from '../db/index.js';
import {
  dispatchTerminalSession,
  dispatchTmuxAttachSession,
  dispatchAgentSession,
  dispatchCompanionTerminal,
  hydrateFeedback,
  DEFAULT_PROMPT_TEMPLATE,
  dispatchFeedbackToAgent,  // <-- KEY: Dispatch function
} from '../dispatch.js';
import { inputSessionRemote, getSessionStatus, SessionServiceError } from '../session-service-client.js';
import { killSession } from '../agent-sessions.js';
import { feedbackEvents } from '../events.js';
import { verifyAdminToken } from '../auth.js';
```

### Key Imports for Dispatch System
- `dispatchSchema` - Validates dispatch request payload
- `dispatchFeedbackToAgent()` - Executes feedback dispatch
- `dispatchTerminalSession()` - Spawns terminal sessions
- `SessionServiceError` - For error handling

---

## 4. Launcher Registry

**File:** `/Users/amir/work/github.com/prompt-widget/packages/server/src/launcher-registry.ts`  
**Lines:** 1-175

### LauncherInfo Interface
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

### Key Functions
```typescript
export function listLaunchers(): LauncherInfo[] {
  return Array.from(launchers.values());
}

export function getLauncher(id: string): LauncherInfo | undefined {
  return launchers.get(id);
}

export function findAvailableLauncher(): LauncherInfo | undefined {
  // Finds best launcher by load (excluding local, checking readiness)
}

export function serializeLauncher(l: LauncherInfo) {
  return {
    id: l.id,
    name: l.name,
    hostname: l.hostname,
    connectedAt: l.connectedAt,
    lastHeartbeat: l.lastHeartbeat,
    activeSessions: Array.from(l.activeSessions),
    capabilities: l.capabilities,
    online: l.isLocal ? true : l.ws?.readyState === 1,
    isHarness: !!l.harness,
    harness: l.harness || null,
    machineId: l.machineId || null,
    harnessConfigId: l.harnessConfigId || null,
  };
}
```

### Important Notes
- **Serialization:** `serializeLauncher()` returns launcher data suitable for API responses
- **Load balancing:** `findAvailableLauncher()` uses session count vs capabilities.maxSessions
- **Local launchers:** Skipped by `findAvailableLauncher()` (line 102)
- **Harnesses:** Separate list via `listHarnesses()` (line 172-174)

---

## 5. Admin API Client Methods

**File:** `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/api.ts`  
**Lines:** 94-104, 100-104

### dispatch() Method
```typescript
dispatch: (data: { feedbackId: string; agentEndpointId: string; instructions?: string }) =>
  request<{ dispatched: boolean; sessionId?: string; status: number; response: string }>('/admin/dispatch', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
```

### spawnTerminal() Method
```typescript
spawnTerminal: (data?: { cwd?: string; appId?: string }) =>
  request<{ sessionId: string }>('/admin/terminal', {
    method: 'POST',
    body: JSON.stringify(data || {}),
  }),
```

### Key Observation
**Neither method currently supports launcherId parameter** - This needs to be extended in both the API client and server handlers.

---

## 6. Admin Sessions Library

**File:** `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/sessions.ts`  
**Lines:** 1266-1278

### spawnTerminal() Function
```typescript
export async function spawnTerminal(appId?: string | null) {
  try {
    const data: { appId?: string } = {};
    if (appId && appId !== '__unlinked__') data.appId = appId;
    const { sessionId } = await api.spawnTerminal(data);
    openSession(sessionId);
    loadAllSessions();
    return sessionId;
  } catch (err: any) {
    console.error('Spawn terminal failed:', err.message);
    return null;
  }
}
```

### Related Function: attachTmuxSession()
```typescript
export async function attachTmuxSession(tmuxTarget: string, appId?: string | null) {
  try {
    const data: { tmuxTarget: string; appId?: string } = { tmuxTarget };
    if (appId && appId !== '__unlinked__') data.appId = appId;
    const { sessionId } = await api.attachTmuxSession(data);
    openSession(sessionId);
    loadAllSessions();
    return sessionId;
  } catch (err: any) {
    console.error('Attach tmux session failed:', err.message);
    return null;
  }
}
```

### Key Observation
**No launcherId parameter** - Both functions only accept `appId`. Need to extend to support `launcherId`.

---

## 7. FeedbackDetailPage - Dispatch Bar

**File:** `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/FeedbackDetailPage.tsx`  
**Lines:** 246-278

### Dispatch Bar JSX
```typescript
{agents.value.length > 0 && (
  <div class="dispatch-bar dispatch-bar-styled">
    <div class="dispatch-bar-label">Dispatch</div>
    <div class="dispatch-bar-controls">
      <select
        class="dispatch-bar-select"
        value={dispatchAgentId.value}
        onChange={(e) => (dispatchAgentId.value = (e.target as HTMLSelectElement).value)}
      >
        {agents.value.map((a) => (
          <option value={a.id}>
            {a.name}{a.isDefault && a.appId ? ' (app default)' : a.isDefault ? ' (default)' : ''}{!a.appId ? '' : ''}
          </option>
        ))}
      </select>
      <input
        class="dispatch-bar-input"
        type="text"
        placeholder="Instructions (optional)..."
        value={dispatchInstructions.value}
        onInput={(e) => (dispatchInstructions.value = (e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') doDispatch(); }}
      />
      <button
        class="btn btn-primary dispatch-bar-btn"
        disabled={!dispatchAgentId.value || dispatchLoading.value}
        onClick={doDispatch}
      >
        {dispatchLoading.value ? 'Dispatching...' : 'Dispatch'}
      </button>
    </div>
  </div>
)}
```

### doDispatch() Function (Lines 143-183)
```typescript
async function doDispatch() {
  const fb = feedback.value;
  if (!fb || !dispatchAgentId.value) return;
  dispatchLoading.value = true;
  try {
    const selectedAgent = agents.value.find((a) => a.id === dispatchAgentId.value);
    const result = await api.dispatch({
      feedbackId: fb.id,
      agentEndpointId: dispatchAgentId.value,
      instructions: dispatchInstructions.value || undefined,
    });
    // ... update UI state
  } catch (err: any) {
    // ... error handling
  } finally {
    dispatchLoading.value = false;
  }
}
```

### Key Observation
**Only agent selection exists** - No launcher/dispatch-target selector. Need to add dropdown for launcher selection before or after agent selection.

---

## 8. SessionsPage - Terminal Opening

**File:** `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/SessionsPage.tsx`  
**Lines:** 77-142

### Auto-Spawn Logic (Lines 77-94)
```typescript
export function SessionsPage({ appId }: { appId?: string | null }) {
  const autoTerminalDone = useRef(false);

  useEffect(() => {
    loadMaps();
    includeDeletedInPolling.value = true;
    return () => { includeDeletedInPolling.value = false; };
  }, []);

  const isAutoTerminal = isEmbedded.value && new URLSearchParams(window.location.search).get('autoTerminal') === '1';

  useEffect(() => {
    if (autoTerminalDone.current) return;
    if (isAutoTerminal) {
      autoTerminalDone.current = true;
      spawnTerminal(appId ?? null);
    }
  }, [appId]);
```

### "Open Terminal" Button (Lines 137-142)
```typescript
<div class="page-header">
  <h2>Sessions ({appFiltered.length})</h2>
  <button class="btn btn-sm" onClick={() => spawnTerminal(appId)}>
    Open Terminal
  </button>
</div>
```

### Key Observations
- **Auto-spawn:** Via `autoTerminal=1` URL param in embed mode
- **Manual spawn:** Simple button that calls `spawnTerminal(appId)`
- **No launcher selection:** Currently no way to specify which launcher to use

---

## 9. Widget: Overlay Panel Opening

**File:** `/Users/amir/work/github.com/prompt-widget/packages/widget/src/overlay-panels.ts`  
**Lines:** 66-93

### openPanel() Method
```typescript
openPanel(type: PanelType, opts?: { param?: string; appId?: string }): string {
  this.injectStyles();

  const id = `pw-panel-${++panelCounter}`;
  const config = PANEL_CONFIGS[type];
  const appId = opts?.appId || this.appId;
  const hashRoute = config.path(appId, opts?.param);
  const autoTerminal = type === 'terminal' ? '&autoTerminal=1' : '';
  const iframeUrl = `${this.adminBaseUrl}?embed=true&appId=${encodeURIComponent(appId)}${autoTerminal}#${hashRoute}`;
  
  // ... create panel DOM, add to shadow root
  return id;
}
```

### Panel Configs (Lines 13-20)
```typescript
const PANEL_CONFIGS: Record<PanelType, PanelConfig> = {
  feedback: { icon: '\u{1F4CB}', title: 'Feedback', path: (a) => `/app/${a}/feedback`, width: 650, height: 500 },
  detail: { icon: '\u{1F4CB}', title: 'Feedback Detail', path: (a, p) => `/app/${a}/feedback/${p}`, width: 650, height: 600 },
  sessions: { icon: '\u26A1', title: 'Sessions', path: (a) => `/app/${a}/sessions`, width: 650, height: 500 },
  aggregate: { icon: '\u{1F4CA}', title: 'Aggregate', path: (a) => `/app/${a}/aggregate`, width: 650, height: 500 },
  settings: { icon: '\u2699', title: 'Settings', path: () => '/settings/applications', width: 550, height: 500 },
  terminal: { icon: '\u{1F4BB}', title: 'Terminal', path: (a) => `/app/${a}/sessions`, width: 750, height: 500 },
};
```

### Key Observations
- **Terminal opening:** Uses `autoTerminal=1` query param (line 73)
- **Route construction:** Builds full iframe URL with `appId` and hash route
- **No launcher targeting:** `openPanel()` only accepts `appId` and `param`, not launcher selection

---

## 10. Widget: Admin Options Panel

**File:** `/Users/amir/work/github.com/prompt-widget/packages/widget/src/widget.ts`  
**Lines:** 631-661, 734-779

### Admin Options Panel Creation (Lines 631-661)
```typescript
private showAdminOptions() {
  const existing = this.shadow.querySelector('.pw-admin-options');
  if (existing) { existing.remove(); }
  if (!this.overlayManager) return;

  const options = document.createElement('div');
  options.className = 'pw-admin-options';
  options.innerHTML = `<div class="pw-admin-options-content"></div>`;

  const content = options.querySelector('.pw-admin-options-content') as HTMLDivElement;
  const items = [
    { icon: '\u{1F4CB}', label: 'Feedback', type: 'feedback' as PanelType },
    { icon: '\u{1F4CA}', label: 'Aggregate', type: 'aggregate' as PanelType },
    { icon: '\u26A1', label: 'Sessions', type: 'sessions' as PanelType },
    { icon: '\u{1F4BB}', label: 'Terminal', type: 'terminal' as PanelType },
  ];

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'pw-admin-option';
    btn.innerHTML = `<span class="pw-admin-option-icon">${item.icon}</span>`;
    btn.title = item.label;
    btn.addEventListener('click', () => {
      if (this.overlayManager) {
        this.overlayManager.openPanel(item.type);
        // ...
      }
    });
    content.appendChild(btn);
  }
  // ...
}
```

### Admin Button HTML (Lines 734-736)
```html
<div class="pw-admin-group">
  <button class="pw-admin-btn" id="pw-admin-btn" title="Admin panels"><!-- SVG gear icon --></button>
  <button class="pw-admin-dropdown-toggle" id="pw-admin-dropdown" title="Admin options"><!-- SVG dropdown icon --></button>
</div>
```

### Button Event Handlers (Lines 764-779)
```typescript
const adminBtn = panel.querySelector('#pw-admin-btn') as HTMLButtonElement | null;
const adminDropdownBtn = panel.querySelector('#pw-admin-dropdown') as HTMLButtonElement | null;
// ...
adminBtn?.addEventListener('click', () => this.toggleAdminOptions());
adminDropdownBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleAdminMenu(); });
```

### Related Dispatch Mode (Lines 52, 130-137, 142-147, 153-158, 216-221)
```typescript
private dispatchMode: 'off' | 'once' | 'auto' = 'off';

// In constructor (line 130-137):
const stored = localStorage.getItem('pw-dispatch-mode');
if (stored === 'auto') this.dispatchMode = 'auto';

// Toggle method (lines 142-158):
setAdminAlwaysShow(on: boolean) {
  this.adminAlwaysShow = on;
  if (on) {
    localStorage.setItem('pw-admin-always-show', '1');
  } else {
    localStorage.removeItem('pw-admin-always-show');
  }
}

setDispatchMode(mode: 'off' | 'once' | 'auto') {
  this.dispatchMode = mode;
  if (mode === 'auto') {
    localStorage.setItem('pw-dispatch-mode', 'auto');
  } else {
    localStorage.removeItem('pw-dispatch-mode');
  }
}
```

---

## Summary of Key Findings

### Current State
1. **Dispatch:** Validates and dispatches to agent endpoints via webhook
2. **Terminal:** Spawns terminal sessions in local or app-specific directories
3. **Launcher Registry:** Maintains list of connected launchers with serialization support
4. **Widget:** Has admin panel with Feedback, Aggregate, Sessions, and Terminal options

### Missing Pieces (For Dispatch Target Feature)
1. ❌ **LauncherId in dispatch schema** - `dispatchSchema` needs `launcherId` field
2. ❌ **Dispatch targets endpoint** - No `/admin/dispatch-targets` route
3. ❌ **LauncherId propagation** - Not passed through dispatch functions
4. ❌ **UI dispatch target selector** - FeedbackDetailPage needs launcher dropdown
5. ❌ **Terminal launcher selection** - No way to select launcher in SessionsPage
6. ❌ **Widget launcher targeting** - overlay-panels.ts doesn't support launcher targeting
7. ❌ **Launcher daemon plain profile** - Need to verify plain permission profile support

---

## File Locations (Absolute Paths)

| Section | File | Lines |
|---------|------|-------|
| Dispatch handler | `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/admin.ts` | 580-654 |
| Terminal handler | `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/admin.ts` | 1224-1243 |
| Imports | `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/admin.ts` | 1-31 |
| Launcher registry | `/Users/amir/work/github.com/prompt-widget/packages/server/src/launcher-registry.ts` | 1-175 |
| API dispatch method | `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/api.ts` | 94-98 |
| API terminal method | `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/api.ts` | 100-104 |
| Sessions spawnTerminal | `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/sessions.ts` | 1266-1278 |
| FeedbackDetailPage dispatch | `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/FeedbackDetailPage.tsx` | 246-278, 143-183 |
| SessionsPage terminal | `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/SessionsPage.tsx` | 77-142 |
| Overlay panel opening | `/Users/amir/work/github.com/prompt-widget/packages/widget/src/overlay-panels.ts` | 66-93, 13-20 |
| Widget admin options | `/Users/amir/work/github.com/prompt-widget/packages/widget/src/widget.ts` | 631-661, 734-779 |

---

**Report Generated:** 2026-03-01  
**Task Status:** ✅ Complete - All requested sections located and documented
