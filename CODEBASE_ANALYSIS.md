# Prompt Widget — Codebase Analysis & Improvement Roadmap

**Date:** 2026-02-20
**Codebase Size:** ~20,700 LOC across 4 packages
**Stack:** Preact + Hono + SQLite + xterm.js + node-pty + tmux

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser                                   │
│  ┌──────────────┐  ┌───────────────────────────────────────┐    │
│  │ Widget (IIFE) │  │ Admin SPA (Preact)                    │    │
│  │ - feedback UI │  │ - feedback mgmt    - terminal tabs    │    │
│  │ - screenshot  │  │ - agent dispatch   - popout panels    │    │
│  │ - element pick│  │ - structured view  - spotlight search │    │
│  │ - session WS  │  │ - xterm.js PTY     - keyboard nav    │    │
│  └──────┬───────┘  └──────────┬────────────────────────────┘    │
│         │ WS                  │ HTTP + WS                        │
└─────────┼─────────────────────┼──────────────────────────────────┘
          │                     │
┌─────────┴─────────────────────┴──────────────────────────────────┐
│                    Server (Hono, port 3001)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │ Feedback  │ │ Admin    │ │ Agent    │ │ Aggregate/Plans  │    │
│  │ Routes    │ │ Routes   │ │ Routes   │ │ Routes           │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │ Dispatch  │ │ Sessions │ │ Launcher │ │ Message Buffer   │    │
│  │ System    │ │ Bridge   │ │ Registry │ │ (seq protocol)   │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘    │
│       │              │                                            │
│  ┌────┴──────────────┴──────────────────────┐                    │
│  │ SQLite (Drizzle ORM) — WAL mode          │                    │
│  │ Tables: apps, feedback, sessions,         │                    │
│  │         agents, plans, tmux_configs       │                    │
│  └──────────────────────────────────────────┘                    │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTP
┌──────────────────────────┴───────────────────────────────────────┐
│              Session Service (port 3002)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ PTY Spawner  │  │ Output Buffer│  │ Tmux Integration   │     │
│  │ (node-pty)   │  │ (500KB cap)  │  │ (-L prompt-widget) │     │
│  └──────────────┘  └──────────────┘  └────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
                           │
               ┌───────────┴───────────┐
               │ tmux server           │
               │ (prompt-widget socket)│
               │ pw-{sessionId} sessions│
               └───────────────────────┘
```

### Package Breakdown

| Package | LOC | Files | Purpose |
|---------|-----|-------|---------|
| **admin** | ~8,500 | 32 | Preact SPA — pages, components, lib utils, CSS |
| **server** | ~5,500 | 23 | Hono API, session service, dispatch, DB |
| **widget** | ~2,500 | 10 | Embeddable overlay, session bridge, virtual input |
| **shared** | ~740 | 6 | Types, Zod schemas, protocols, constants |

---

## 2. What Works Well

### Architecture
- **Clean package separation** — widget, server, admin, shared are independent
- **Shared types/schemas** — single source of truth for validation and interfaces
- **Sequenced protocol** — reliable message delivery across reconnects
- **Tmux persistence** — sessions survive server restarts, late attach recovery works
- **Dual dispatch** — local PTY or remote launcher with automatic fallback

### Admin UI
- **Rich terminal experience** — multi-tab, popout panels, split view, structured view
- **Keyboard-first** — 20+ shortcuts, spotlight search, sequence bindings (g f, g a)
- **Real-time** — SSE for feedback, WebSocket for terminals, polling for sessions
- **Preact Signals** — fine-grained reactivity without heavy framework overhead

### Widget
- **Shadow DOM encapsulation** — no CSS conflicts with host pages
- **Context collection** — console logs, network errors, performance timing, environment
- **Agent bridge** — virtual mouse/keyboard, DOM introspection, a11y tree, screenshots

### Server
- **Session recovery** — tmux check, pane capture, reattach on late connect
- **Orphan cleanup** — marks stale sessions as failed on startup
- **Launcher system** — ready for distributed session spawning
- **Message buffer** — in-memory + SQLite dual storage for reliability

---

## 3. Current Issues & Technical Debt

### Critical — Impacts Reliability

| Issue | Location | Impact |
|-------|----------|--------|
| **No tests** | Entire codebase | Zero unit/integration/e2e tests |
| **No CI/CD** | Project root | No automated quality gates |
| **No error boundaries** | Admin UI | Uncaught errors crash entire SPA |
| **Hardcoded secrets** | auth.ts | `JWT_SECRET` defaults to `'dev-secret-change-me'` |
| **CORS wide open** | app.ts | `origin: '*'` — no restriction |
| **No rate limiting** | All routes | Feedback submission, dispatch, commands unthrottled |

### High — Impacts Maintainability

| Issue | Location | Impact |
|-------|----------|--------|
| **admin.ts is 897 LOC** | server/routes | Feedback, agents, dispatch, tmux all in one file |
| **Layout.tsx is 730 LOC** | admin/components | Sidebar, shortcuts, panels, navigation mixed |
| **FeedbackDetailPage is 586 LOC** | admin/pages | Display, edit, dispatch, sessions all inline |
| **sessions.ts is 642 LOC** | admin/lib | Tabs, panels, polling, persistence, filters mixed |
| **app.css is 4,054 LOC** | admin/src | Single monolithic CSS file |
| **N+1 queries** | feedback list | Tags + screenshots fetched per item in loop |
| **No proper router** | admin/App.tsx | Manual regex parsing of hash routes |
| **DB migrations inline** | db/index.ts | All ALTER TABLEs in single function, no versioning |
| **`any` types pervasive** | admin/lib | API responses untyped, signals use `any` |

### Medium — Impacts Developer Experience

| Issue | Location | Impact |
|-------|----------|--------|
| **No Docker** | Project root | Can't run in containers, no reproducible env |
| **No linting** | Project root | No ESLint/Prettier enforcement |
| **No .env.example** | Project root | Unclear what env vars are needed |
| **Duplicated form patterns** | Agents, Apps pages | Same modal CRUD pattern repeated |
| **Date formatting scattered** | Multiple pages | Helper functions redefined locally |
| **No logging framework** | Server | Just console.log/error |

---

## 4. Refactoring Recommendations

### Phase 1 — Split Large Files (Low Risk, High Impact)

**server/routes/admin.ts → 4 files:**
```
routes/admin/feedback.ts    — Feedback CRUD + batch ops + SSE
routes/admin/agents.ts      — Agent endpoint CRUD
routes/admin/dispatch.ts    — Dispatch logic + prompt rendering
routes/admin/tmux.ts        — Tmux config management
routes/admin/index.ts       — Re-export combined routes
```

**admin/components/Layout.tsx → 3 files:**
```
components/Sidebar.tsx          — App nav, session drawer, filters
components/ShortcutManager.tsx  — Shortcut registration (hook)
components/Layout.tsx           — Shell composition only
```

**admin/lib/sessions.ts → 3 files:**
```
lib/tab-manager.ts    — Tab state, open/close/reorder
lib/panel-manager.ts  — Popout panels, docking, floating
lib/session-polling.ts — WebSocket subscriptions, polling
```

**admin/src/app.css → modular CSS:**
```
styles/variables.css    — Theme tokens
styles/layout.css       — Grid, sidebar, main
styles/terminal.css     — Tab bar, panels, popouts
styles/pages.css        — Cards, tables, forms
styles/components.css   — Badges, tooltips, modals
```

### Phase 2 — Type Safety & Validation (Medium Risk, High Impact)

- Type all signal values (replace `any` with shared interfaces)
- Add Zod validation to API response parsing in `api.ts`
- Add error boundaries around page components
- Create shared utility module for date formatting, badge rendering

### Phase 3 — Infrastructure (Medium Risk, High Impact)

- Add Vitest for unit tests (shared schemas, output parser, session logic)
- Add Playwright for e2e tests (feedback flow, terminal interaction)
- Add ESLint + Prettier with pre-commit hooks
- Create `.env.example` with all required variables
- Add proper DB migration versioning (drizzle-kit generate/migrate)

### Phase 4 — Performance & DX

- Fix N+1 queries (JOIN tags/screenshots in feedback list query)
- Add request deduplication in API client
- Install proper router (preact-router is already a dependency)
- Extract reusable form/modal components
- Add structured logging (pino or similar)

---

## 5. Containerization Strategy

### Why Containerize

1. **Agent isolation** — each dispatched agent runs in its own container with controlled filesystem access
2. **Reproducibility** — git branch checkout + analysis in clean environment
3. **Resource limits** — CPU/memory caps per agent session
4. **Security** — agents can't access host filesystem beyond mounted project dir
5. **Parallelism** — multiple agents on different branches simultaneously
6. **Cleanup** — containers destroyed after session, no leftover state

### Current Blockers

| Blocker | Why It Matters | What to Change |
|---------|---------------|----------------|
| **tmux on host** | Sessions tied to host tmux socket | Container gets its own tmux |
| **node-pty on host** | PTY spawned in server process | PTY spawns inside container |
| **SQLite on host** | Single file DB, no concurrent access | Keep DB on host, API for containers |
| **File uploads on host** | Screenshots stored in `uploads/` dir | Shared volume or object storage |
| **Session service co-located** | Port 3002 on localhost | Container network or sidecar |

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Host Machine                              │
│                                                              │
│  ┌────────────────────────────────────────────────────┐     │
│  │ Prompt Widget Server (port 3001)                    │     │
│  │ - REST API, WebSocket, Admin SPA                    │     │
│  │ - SQLite DB (host filesystem)                       │     │
│  │ - Dispatch orchestrator                             │     │
│  │ - Container lifecycle manager                       │     │
│  └────────────────────┬───────────────────────────────┘     │
│                       │                                      │
│          ┌────────────┼────────────┐                        │
│          │            │            │                         │
│  ┌───────▼──────┐ ┌──▼─────────┐ ┌▼──────────────┐        │
│  │ Container A  │ │ Container B │ │ Container C   │        │
│  │ Agent Session│ │ Agent Sess. │ │ Analysis Job  │        │
│  │              │ │             │ │               │        │
│  │ - claude cli │ │ - claude cli│ │ - git checkout│        │
│  │ - tmux       │ │ - tmux      │ │ - analysis    │        │
│  │ - node-pty   │ │ - node-pty  │ │ - report gen  │        │
│  │ - project vol│ │ - project v │ │ - branch vol  │        │
│  └──────────────┘ └────────────┘ └───────────────┘        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Implementation Plan

#### Step 1: Agent Container Image

Create a base Docker image with everything an agent needs:

```dockerfile
FROM node:20-slim

# Install tmux, git, build tools
RUN apt-get update && apt-get install -y \
    tmux git build-essential python3 curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Session service runs inside the container
COPY packages/server/src/session-service.ts /opt/pw/
COPY packages/server/src/tmux-pty.ts /opt/pw/
COPY packages/server/tmux-pw.conf /opt/pw/

WORKDIR /workspace
EXPOSE 3002

ENTRYPOINT ["node", "/opt/pw/session-service.js"]
```

#### Step 2: Container Lifecycle in Dispatch

Replace `spawnAgentSession` with container spawn:

```
dispatchAgentSession(params)
  1. Create agentSessions DB record (status: pending)
  2. docker run --name pw-{sessionId} \
       -v {projectDir}:/workspace \
       -e ANTHROPIC_API_KEY=... \
       -p 0:3002 \              # random host port
       pw-agent-session
  3. Wait for container health check (session-service /health)
  4. POST /spawn to container's session-service
  5. Store container ID + mapped port in DB
  6. Bridge WebSocket from admin → container:port/ws
```

#### Step 3: Container Manager Module

New server module `container-manager.ts`:

```typescript
interface ContainerInfo {
  containerId: string;
  sessionId: string;
  hostPort: number;
  status: 'starting' | 'running' | 'stopped';
  createdAt: string;
}

// Core functions:
spawnContainer(sessionId, projectDir, env) → ContainerInfo
killContainer(sessionId) → void
getContainerStatus(sessionId) → ContainerInfo | null
listContainers() → ContainerInfo[]
cleanupStaleContainers() → void
```

#### Step 4: Analysis Jobs

For the "spin up Docker with branch and produce analysis" use case:

```
POST /api/v1/admin/analyze-branch
  body: { appId, branch, analysisType }

1. git worktree add /tmp/pw-analysis-{id} {branch}
2. docker run --name pw-analysis-{id} \
     -v /tmp/pw-analysis-{id}:/workspace:ro \
     pw-agent-session \
     --analysis-mode
3. Agent runs codebase analysis, writes report
4. Report stored in DB or returned via API
5. Container + worktree cleaned up
```

### Codebase Changes Required for Containerization

| Change | Files Affected | Effort |
|--------|---------------|--------|
| Extract session-service into standalone package | session-service.ts, tmux-pty.ts | Medium |
| Make session-service configurable (DB URL, auth) | session-service.ts | Low |
| Add container manager module | New: container-manager.ts | High |
| Update dispatch to support container targets | dispatch.ts | Medium |
| WebSocket proxy for container sessions | agent-sessions.ts, index.ts | Medium |
| Add Docker image build to project | New: Dockerfile, docker-compose | Medium |
| Container health checks + cleanup | container-manager.ts | Medium |
| Environment variable documentation | New: .env.example | Low |
| Volume mounting for project dirs | container-manager.ts | Low |
| Port allocation and tracking | container-manager.ts, db/schema.ts | Medium |

### Migration Path

1. **Phase A** — Containerize session-service (keep everything else on host)
   - Smallest change, biggest isolation win
   - Server talks to container via HTTP/WS instead of localhost:3002
   - Existing launcher protocol already supports remote sessions

2. **Phase B** — One container per agent session
   - Each dispatch creates a new container
   - Container runs session-service + tmux + claude cli
   - Auto-cleanup on session end

3. **Phase C** — Analysis containers
   - Git worktree checkout into temp dir
   - Read-only mount into container
   - Structured analysis output → stored in DB
   - Multiple analyses can run in parallel

---

## 6. Quick Wins (Do This Week)

1. **Add `.env.example`** — document all env vars
2. **Add error boundaries** — wrap page components in Preact error boundary
3. **Split admin.ts** — extract feedback/agents/dispatch/tmux routes (mechanical refactor)
4. **Fix N+1** — JOIN tags/screenshots in feedback list query
5. **Add Vitest** — start with output-parser.ts and shared schemas (pure logic, no DOM)
6. **Create Dockerfile** — even if not used yet, document what the container needs

---

## 7. File-Level Statistics

### Server Package (5,500 LOC)

| File | LOC | Concern |
|------|-----|---------|
| routes/admin.ts | 897 | Admin API (needs split) |
| session-service.ts | 708 | PTY management |
| routes/aggregate.ts | 559 | Clustering + analysis |
| routes/agent.ts | 272 | Widget commands |
| agent-sessions.ts | 270 | Session bridging |
| index.ts | 274 | Server bootstrap |
| db/index.ts | 265 | Migrations |
| dispatch.ts | 262 | Dispatch orchestration |
| routes/feedback.ts | 150 | Feedback submission |
| routes/agent-sessions.ts | 151 | Session CRUD |
| message-buffer.ts | 145 | Replay buffer |
| tmux-pty.ts | 138 | Tmux utilities |
| sessions.ts | 138 | Widget sessions |
| db/schema.ts | 128 | Table definitions |
| routes/applications.ts | 128 | App CRUD |
| launcher-registry.ts | 108 | Launcher tracking |
| session-service-client.ts | 66 | HTTP client |
| app.ts | 60 | Hono setup |
| auth.ts | 15 | JWT verify |

### Admin Package (8,500 LOC)

| File | LOC | Concern |
|------|-----|---------|
| app.css | 4,054 | All styles |
| components/Layout.tsx | 730 | Main shell (needs split) |
| lib/sessions.ts | 642 | Session state (needs split) |
| pages/FeedbackDetailPage.tsx | 586 | Feedback detail |
| components/MessageRenderer.tsx | 582 | Message rendering |
| lib/output-parser.ts | 512 | JSON stream parser |
| pages/AggregatePage.tsx | 494 | Clustering UI |
| pages/FeedbackListPage.tsx | 443 | Feedback list |
| pages/SettingsPage.tsx | 410 | Settings |
| components/PopoutPanel.tsx | 397 | Floating panels |
| components/AgentTerminal.tsx | 396 | xterm.js terminal |
| pages/AgentsPage.tsx | 384 | Agent config |
| lib/api.ts | 282 | REST client |
| components/SpotlightSearch.tsx | 216 | Command palette |
| components/App.tsx | 97 | Router |
| lib/settings.ts | 79 | Preferences |
| lib/shortcuts.ts | 150 | Keyboard shortcuts |
| lib/tab-drag.ts | 132 | Tab drag-drop |

### Widget Package (2,500 LOC)

| File | LOC | Concern |
|------|-----|---------|
| widget.ts | 665 | Main UI component |
| styles.ts | 462 | Widget CSS |
| session.ts | 375 | WebSocket bridge |
| input-events.ts | 331 | Virtual mouse/keyboard |
| element-picker.ts | 201 | Element selection |
| collectors.ts | 104 | Context collection |
| screenshot.ts | 47 | Page capture |

### Shared Package (740 LOC)

| File | LOC | Concern |
|------|-----|---------|
| types.ts | 240 | TypeScript interfaces |
| schemas.ts | 167 | Zod validation |
| protocol.ts | 159 | Session protocol |
| launcher-protocol.ts | 108 | Launcher protocol |
| constants.ts | 50 | Constants |

---

## 8. Dependency Graph

```
@prompt-widget/shared (no deps)
       ↑
       ├──── @prompt-widget/widget
       │       └─ html-to-image
       │
       ├──── @prompt-widget/server
       │       ├─ hono, @hono/node-server
       │       ├─ drizzle-orm, better-sqlite3
       │       ├─ node-pty
       │       ├─ ws, jose, ulidx, zod
       │       └─ marked
       │
       └──── @prompt-widget/admin
               ├─ preact, @preact/signals
               ├─ xterm, @xterm/addon-fit
               └─ marked
```

**Build Tooling:** pnpm workspaces + Turbo v2.3 + TypeScript 5.7
**No runtime dependencies shared across browser/server** (clean split)

---

## 9. Prioritized Improvement Matrix

| Priority | Effort | Item | Category |
|----------|--------|------|----------|
| P0 | Low | `.env.example` + document env vars | DX |
| P0 | Low | Error boundaries in admin SPA | Reliability |
| P0 | Medium | Split admin.ts into 4 route files | Maintainability |
| P1 | Medium | Add Vitest + test output-parser, schemas | Quality |
| P1 | Medium | Fix N+1 queries in feedback list | Performance |
| P1 | Medium | Type all signals (remove `any`) | Type Safety |
| P1 | High | Split Layout.tsx, sessions.ts | Maintainability |
| P2 | Medium | Dockerfile for agent sessions | Containerization |
| P2 | Medium | Container manager module | Containerization |
| P2 | High | Split app.css into modules | Maintainability |
| P2 | Medium | Add ESLint + Prettier | Quality |
| P3 | High | Containerized dispatch (Phase B) | Containerization |
| P3 | High | Analysis containers (Phase C) | Feature |
| P3 | Medium | Proper DB migration versioning | Operations |
| P3 | Medium | Structured logging (pino) | Operations |
| P3 | Low | Rate limiting on API routes | Security |
