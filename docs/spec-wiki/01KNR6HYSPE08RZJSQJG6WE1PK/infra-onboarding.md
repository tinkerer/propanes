# Infrastructure & Onboarding

Propanes runs as a long-lived process tree on the operator's VM (or a contributor's laptop) and depends on two external CLIs (`claude` and `codex`) plus the local SQLite DB, npm package state, tmux, and adequate free disk. Most "the system mysteriously stopped working" incidents are not bugs in propanes — they're upstream environment regressions that propanes failed to detect early enough.

This page covers two related themes the operator has explicitly asked for:

1. **Infrastructure health checks** — disk space, CLI availability, login state, version freshness. Detected proactively, surfaced in CoS, and (where safe) auto-remediated.
2. **Contributor onboarding** — a deterministic path from "fresh box with git clone" to "running propanes, hacking on the admin UI, and pushing a PR back to the upstream repo." Recoverable from the same checks as theme 1.

> Cross-references: `CLAUDE.md` (project root), [[spec-backbone#2.11-infrastructure--cli-health]], [[tickets#infrastructure--onboarding]], [[operator-inputs#install--login-vocabulary]], [[reference_session_service_restart]], [[reference_azstaging2]].

---

## 1. Why this page exists

Recent operator signals (last week of 2026-05) that drove this section:

- **2026-05-18 / `01KRWHGWN0W9CT1KV3AY4H0PRN`** — *"our session manaer needs to monitor for situations like when we need to login to claude. we should have a better automatic approach that detects this and loads a pty session for the login flow"*
- **2026-05-17 / DOM-text capture in `ed44f872-…jsonl`** — operator was viewing a thread whose body started *"we ran out of disk space and everything froze. how do we p…"*. The host filesystem was at 89% used (`/dev/root 109G/123G` at this regeneration) when the incident was reported; large JSONL recordings (some > 50 MB) and 200+ MB SQLite WAL files are the dominant growth.
- **2026-05-16 / `01KRRYPDJT715REKKV4AABKSJ7`** — *"use tmux session pw-… and install the az cli"* — installing missing CLIs on a live VM via the operator's tmux is a recurring pattern.
- **2026-05-15 / `01KRMWWSG966WXFSHYH27AWN1G`** — *"lets commit and push our current propanes setup, i think my computer has a better version… i'll fix that up then push there too"* — multi-machine contributor flow.
- **2026-05-11 / thread `01KRBZMXVS7537RXQPKS3PW5QE`** — *"we just recovered from a reboot, the propanes sessions' status are all wrong"* — boot-time reconciliation gap.
- **2026-05-04 / thread `01KQT66F041HE3`** — *"having issues updating codex with npm update -g @openai/codex"* → root-cause was npm prefix permission (`EACCES /usr/lib/node_modules/@openai/codex`). The assistant's guidance (switch to `~/.npm-global` prefix or use sudo) is durable advice.
- **2026-04-21 / `01KPRZTK457DGGW1NVTDK2G6PH`** — *"add codex agent options for our dispatch. i have a tmux pw-… which you can send the install command and i can login"*.
- **2026-04-10 / `01KNW7R9XP0236MVYMFV4KAJXN`** — *"install linear mcp, on this machine so we can connect our agents to the linear tickets"*.

The pattern is consistent: the operator wants the **system** to notice the failure mode and either fix it or hand back a single button that does, rather than the operator diagnosing it from console logs.

---

## 2. Infrastructure health surface

### 2.1 What is monitored

| Check | How it's measured | Default cadence | Threshold |
|---|---|---|---|
| **Disk space — root partition** | `statfs('/')` via Node `fs.statfsSync` (Node 19+). Fallback: parse `df -P /`. | 60s, plus on session spawn | warn @ ≥ 80 %, error @ ≥ 90 %, **hard-stop new sessions @ ≥ 95 %** |
| **Disk space — `~/.claude/projects` + `~/.codex/sessions` + DB dir** | per-directory `du -sb` (cached 5 min) | 5 min | warn if any dir > 5 GB or total > 20 GB |
| **SQLite size + WAL backlog** | `PRAGMA wal_checkpoint;` + `stat propanes.db propanes.db-wal` | 60s | warn if WAL > 500 MB |
| **`claude --version`** | `execSync('claude --version', { timeout: 5_000 })` | on launcher register + on session spawn | error if not found; warn if older than `MIN_CLAUDE_VERSION` (env, default unset = no warn) |
| **`codex --version`** | `execSync('codex --version', { timeout: 5_000 })` | on launcher register + on session spawn (codex runtime only) | same shape as above |
| **Claude login state** | `detectClaudeAuthRequired()` over recent PTY output (already wired in `claude-auth-detect.ts`) | streaming, every chunk | spawn `interactive-require` companion session for the operator to log in |
| **Codex login state** | Pattern match on `codex` output (`Please run codex login`, `Not signed in`, `authenticate`) — **not yet implemented**; see ticket `01KRWHGWN0` and the cross-runtime generalization below | streaming | same shape as Claude |
| **Node / npm version** | `node --version`, `npm --version` | once per server boot | error if `node < 20` |
| **tmux version + socket** | `tmux -V`; `tmux list-sessions` | once per boot + on session spawn | error if missing; warn if version unparseable |
| **Git remote reachable + auth** | `git ls-remote --heads origin HEAD` against each registered app's `projectDir` | manual + every 30 min for the propanes repo itself | warn on auth failure (so the contributor doesn't only learn at push time) |
| **GitHub `gh` CLI auth** | `gh auth status` | once per boot, again on PR-create attempts | warn if not authed |

These checks are **observations**, not actions, unless explicitly flagged hard-stop. The hard-stops are limited to two cases:

- Disk ≥ 95 % full: **refuse new session spawns** (return 503 from `/api/v1/admin/dispatch`, surface a CoS system message, light the status pill red). New sessions on a full disk is the regression that caused the 2026-05-17 freeze incident.
- `claude` / `codex` binary missing for a requested `runtime`: refuse the spawn with a structured error that the admin UI turns into an **Install** button (see §3.2).

### 2.2 Where the result lives

A single endpoint surfaces the consolidated status. New, to be added at:

```
GET /api/v1/admin/system/health
→ {
    "ok": false,
    "checks": [
      { "id": "disk-root",       "status": "warn",  "value": "109G/123G (89%)", "message": "…" },
      { "id": "claude-cli",      "status": "ok",    "value": "1.2.3" },
      { "id": "codex-cli",       "status": "error", "value": null, "message": "codex: command not found" },
      { "id": "claude-login",    "status": "warn",  "message": "session 01KR… requires login" },
      { "id": "sqlite-wal",      "status": "ok",    "value": "12MB" },
      { "id": "node-version",    "status": "ok",    "value": "v20.11.1" },
      { "id": "git-origin",      "status": "ok" },
      { "id": "gh-auth",         "status": "warn",  "message": "not logged in to gh" }
    ],
    "checkedAt": "2026-05-18T03:30:00.000Z"
  }
```

The CoS bubble already surfaces a small status pill — the health endpoint feeds it. Red pill = at least one `error`; amber = at least one `warn`; green = all `ok`. Clicking the pill opens an **Infra** drawer (a new pane companion type, `infra:health`) that lists each check and exposes a one-click remediation where one is safe.

### 2.3 Existing primitives we already have

| Primitive | What it does today | Where |
|---|---|---|
| `claude-auth-detect.ts` | 8 regex patterns over the last ~8 KB of PTY output → returns `true` when claude is asking for login | `packages/server/src/claude-auth-detect.ts` |
| `maybeOpenClaudeLoginCompanion(proc)` | Wire from the session-service: on auth required, spawn a sibling `interactive-require` session, attach as `companionSessionId`, broadcast `login_required` to admin sockets | `packages/server/src/session-service.ts:535` |
| `maybeOpenLauncherClaudeLoginCompanion(sessionId, data)` | Same wire for remote launcher-hosted sessions | `packages/server/src/index.ts:53` |
| `claude --version` capability probe on the launcher | `result.capabilities.hasClaudeCli`, `result.claudeCliVersion` reported back to the server on launcher registration | `packages/server/src/launcher-daemon.ts:691` |
| Machine setup-assist route | `POST /api/v1/admin/system/setup-assist` returns step-by-step shell snippets for installing claude / docker / node on a remote machine | `packages/server/src/routes/admin/system.ts:232` |
| Login-companion session title | New sessions are titled `Claude login XXXXXX` so they're identifiable in the session list | `packages/server/src/session-service.ts:571`, `packages/server/src/index.ts:83` |

This page's spec **extends** these primitives rather than replacing them. The work is:

1. Generalize `claude-auth-detect.ts` to a cross-runtime `detectAuthRequired(runtime, output)` that handles both `claude` and `codex` patterns (today only claude is detected, despite codex sessions hitting the same wall).
2. Add disk-space / SQLite-WAL / git-auth checks to a new `infra-health.ts` poller, run on a 60s interval from `index.ts` startup.
3. Add the `/api/v1/admin/system/health` aggregator + the admin Infra drawer companion.

### 2.4 Hard-stop on disk pressure (the 2026-05-17 incident)

When the root filesystem crosses **95 %**, `/api/v1/admin/dispatch` and the launcher `launch_session` handler must refuse new spawns with HTTP 503 + a structured error:

```json
{
  "error": "disk_pressure",
  "message": "Refusing to spawn new session: / is 96% full (118G/123G).",
  "remediation": [
    { "id": "purge-jsonl",  "label": "Trim old JSONL recordings (> 30 days)" },
    { "id": "checkpoint-wal", "label": "Checkpoint SQLite WAL" },
    { "id": "docker-prune", "label": "docker system prune -af" }
  ]
}
```

The admin UI renders the error as a modal with three remediation buttons. Each remediation is a server-side script that runs synchronously and reports bytes reclaimed; nothing is irreversible without an explicit "I understand" confirmation. The `purge-jsonl` action only touches files older than the cutoff that have a corresponding `agent_sessions.status IN ('completed','failed','killed')` and no recent `cos_messages.source_session_id` reference.

The hard-stop threshold and the cleanup cutoffs are env-tunable:

```
PROPANES_DISK_WARN_PCT=80
PROPANES_DISK_ERROR_PCT=90
PROPANES_DISK_HARDSTOP_PCT=95
PROPANES_JSONL_PURGE_DAYS=30
PROPANES_WAL_CHECKPOINT_BYTES=500_000_000
```

### 2.5 Reboot reconciliation

After a host reboot, `agent_sessions.status` reflects the pre-reboot belief — most rows say `running` even though no process exists. Ticket `01KRBZMXVS` calls this out. The startup sequence already has `cleanupOrphanedSessions()` (`packages/server/src/agent-sessions.ts:297`, called after a 10s delay from `index.ts:114`). The spec invariant is:

- Any session row with `status='running'` that is **not** present in `session-service`'s in-memory registry **and** has no live tmux socket (`tmux has-session -t pw-<sessionId>`) within 30 s of boot is reconciled to `status='killed'` with `exitCode = null` and `outputLog` left intact for post-mortem.
- The session-service is restarted with its own watchdog; if it doesn't checkpoint a heartbeat within 60 s the main server marks it unhealthy and bubbles that into `/system/health`.
- See [[reference_session_service_restart]] for the stale-flag failure mode this prevents.

---

## 3. CLI lifecycle (install, login, update)

### 3.1 Detection truth table

Per-runtime per-state matrix the system must distinguish:

| Runtime | Binary present | Logged in | Version OK | What to do |
|---|---|---|---|---|
| claude | no | — | — | Show **Install Claude** card. Provide one-click install via `npm install -g @anthropic-ai/claude-code` (or the project-pinned installer). |
| claude | yes | no | yes | Auto-spawn `interactive-require` login companion (already wired). |
| claude | yes | yes | stale | Show **Update Claude** banner; do not block sessions. Update via the same install command. |
| claude | yes | yes | ok | No action. |
| codex | no | — | — | Show **Install Codex** card; install via `npm install -g @openai/codex@latest`. See `01KQT66F04` for the npm prefix permission gotcha. |
| codex | yes | no | yes | Auto-spawn `interactive-require` login companion (**new — currently missing**). |
| codex | yes | yes | stale | Show **Update Codex** banner. |
| codex | yes | yes | ok | No action. |

"Stale" is determined by comparing `<cli> --version` against `MIN_CLAUDE_VERSION` / `MIN_CODEX_VERSION` env vars; unset = never warn.

### 3.2 Install / Update cards

Surfaced both in the admin Infra drawer and as inline CoS system messages when a spawn fails for a binary-missing reason. The card includes:

- the exact command (`npm install -g @anthropic-ai/claude-code`)
- a **Run in a new login terminal** button that spawns a `plain`-profile tmux session in `~/` with the command pre-typed (operator hits Enter once they've checked the command)
- the recovered npm-prefix advice for `EACCES` (the durable guidance from `01KQT66F04`):

  ```bash
  # Option A — sudo (system prefix needs root)
  sudo npm install -g @openai/codex@latest

  # Option B — user-local npm prefix (no sudo thereafter)
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
  source ~/.bashrc
  npm install -g @openai/codex@latest
  ```

The card never auto-runs sudo. The operator is the last gate for anything that escalates.

### 3.3 Login terminal lifecycle

When a runtime needs login:

1. The existing `maybeOpenClaudeLoginCompanion` spawns a sibling session, `permissionProfile='interactive-require'`, parented via `parentSessionId` + `companionSessionId`.
2. `broadcastToLauncherSessionAdmins(...)` emits `{ type: 'login_required', sessionId, companionSessionId }` on the admin WebSocket so the UI can auto-open the login companion as a drawer.
3. The original session pauses input (`applyInputState(proc, 'waiting')`) and shows a `Waiting for claude login` chip.
4. On successful login (next `claude --version` succeeds + no detection regex matches the latest output), the login companion can be closed; the parent session is auto-resumed with `Continue from where you left off.` if a follow-up is queued, otherwise it stays paused until the operator un-pauses.

The cross-runtime generalization (codex) follows the same lifecycle — only the detection patterns differ. New patterns to add:

```ts
const CODEX_AUTH_PATTERNS: RegExp[] = [
  /please\s+(?:run\s+)?codex\s+login/i,
  /not\s+signed\s+in\s+to\s+(?:codex|openai)/i,
  /authentication\s+required.*codex/i,
  /invalid\s+(?:api\s+)?key.*openai/i,
];
```

These belong alongside the existing claude patterns in `claude-auth-detect.ts`; rename the module to `auth-detect.ts` and export `detectAuthRequired(runtime, output)`.

---

## 4. Contributor onboarding

The goal is: a contributor with a Mac/Linux/WSL box, `git`, `node ≥ 20`, and a GitHub account can get to "propanes admin UI running locally, I can hack on it, and I can open a PR back to `tinkerer/propanes`" in under 15 minutes, without reading code first.

### 4.1 One-shot bootstrap script

A single shell entry point — `scripts/bootstrap.sh` (to be added at repo root) — performs the deterministic install. It is idempotent: re-running it after a failure picks up where it left off.

```bash
curl -fsSL https://raw.githubusercontent.com/tinkerer/propanes/master/scripts/bootstrap.sh | bash
```

What it does, in order:

1. Verify prereqs: `node --version` (≥ 20), `npm --version`, `git --version`, `tmux --version`. Fail with a concrete install hint per missing tool (`brew install tmux`, `apt-get install -y tmux`, etc).
2. Detect whether `claude` and `codex` are on `$PATH`. If not, print the install commands but **do not run them automatically** — the operator's box, the operator's package manager.
3. Clone or update `~/code/propanes` (or `$PROPANES_DIR` if set). Default branch: `master`. Detect existing checkout and `git pull --ff-only` instead of failing.
4. `npm install` at the repo root (workspaces install everything).
5. `npm run build --workspaces`.
6. Seed the SQLite DB if `packages/server/propanes.db` doesn't exist (the server creates it on first run; nothing to do).
7. Print the next steps:
   - `cd packages/server && npm run dev`
   - Open `http://localhost:3001/admin/`
   - Default admin login: `admin` / `admin`. **Change this** before exposing the port beyond localhost.

The bootstrap script is committed to the repo so it can be inspected before piping into bash. Both forms are supported:

```bash
# direct (auditable)
git clone git@github.com:tinkerer/propanes.git
cd propanes
./scripts/bootstrap.sh
```

### 4.2 First-run admin UI walkthrough

After `npm run dev` succeeds, the admin UI's first page should be an **onboarding card** (new — to be added at `packages/admin/src/pages/OnboardingPage.tsx`) that the SPA defaults to when:

- there are zero applications in the DB **or**
- `localStorage['propanes.onboarding.dismissed'] !== 'true'`

The card walks through:

1. **Register the propanes-admin app itself.** Pre-filled form: name `Propanes Admin`, project dir `<repo root>`, server URL `http://localhost:3001`. One click → `POST /api/v1/admin/applications`.
2. **Pick a permission profile.** Default = `interactive-yolo`. The card explains the YOLO vocabulary (cross-ref [[operator-inputs#vocabulary]]).
3. **Embed the widget on your app.** Show the `<script>` snippet from `getting-started.ts` with the app's API key substituted in. Copy button.
4. **Run a smoke-test dispatch.** Pre-built ticket "hello" that dispatches a YOLO session against `echo "propanes onboarding OK"`; success closes the card and dismisses the onboarding state.

### 4.3 Pushing PRs back to upstream

The contributor's machine and the upstream repo are linked through the standard fork-and-PR workflow. Propanes does not replace it — it surfaces enough state in the admin UI that the contributor doesn't have to leave it.

**Setup (one-time, per contributor):**

```bash
# fork on GitHub first, then:
git remote add upstream git@github.com:tinkerer/propanes.git
git fetch upstream
git branch --set-upstream-to=upstream/master master
```

**Per-PR flow:**

1. `git checkout -b feat/my-thing`
2. Hack. Use the admin UI normally; dispatched sessions write to your branch.
3. The recurring operator dispatch *"commit and push"* (`01KRMWWSG9`, `01KR5KHBQK`, `01KR4QT3GF`, `01KQRKHFAX`, `01KQXAM8BD`, `01KP70SP1P`, etc.) maps to a single CoS shortcut: typing `/push` in any CoS thread runs (in the project dir) `git add -A && git commit -m "<auto message from staged diff>" && git push -u origin HEAD`.
4. To open a PR: `/pr` in CoS runs `gh pr create --base master --head <branch> --title "<auto from commits>" --body "<auto>"` against the **fork**, and prints the URL back into the thread.
5. The CoS Infra drawer's `gh-auth` row warns ahead of time if `gh auth status` is failing, so the `/pr` shortcut doesn't crater at the last step.

**For maintainers (push to `tinkerer/propanes` directly):** the contributor's fork doesn't apply; `origin` points to the canonical repo, and `/push` pushes there. The admin UI shows the active remote next to the `/push` button as a sanity check.

### 4.4 Multi-machine handoff

The operator works across at least two machines (Azure VM `azstaging` / `azstaging2`, plus a MacBook Air — see ticket `01KRMWWSG9` *"my computer has a better version of the CoS companion thread logic, and i'll fix that up then push there too"* and [[reference_azstaging2]]). The supported pattern is:

- Each machine is its own checkout with its own `propanes.db` + JSONL history. Nothing is shared except git.
- The propanes server on each machine registers as a **launcher** against a primary admin instance via `SERVER_WS_URL`. This is how the Mac connects to the Azure VM, and vice versa.
- Sessions can be transferred between launchers via `transferSession()` (`packages/server/src/dispatch.ts`) — exports JSONL + artifacts, re-imports on target.
- `git pull --rebase upstream master` + push is the only mechanism that moves code between machines; do not try to sync the DB.

### 4.5 What's deliberately NOT in scope

- **No telemetry to a hosted upstream.** Every health check is local; no contributor's environment phones home.
- **No auto-update of the propanes repo.** `git pull` is the contributor's call.
- **No sudo escalation by propanes itself.** Anything that needs root is surfaced as a copy-pasteable command, not run.
- **No managed authentication.** Login flows for `claude` / `codex` / `gh` always land in a real terminal the operator drives — propanes only detects the need and opens the door.

---

## 5. Open work (the spec deltas)

Mapped to current state in the code so contributors know exactly what's missing.

| Item | State | Where to add |
|---|---|---|
| Generalize `claude-auth-detect.ts` → cross-runtime `auth-detect.ts` with codex patterns | not started | `packages/server/src/claude-auth-detect.ts` → rename, expand |
| `maybeOpenCodexLoginCompanion` mirror of the claude wire | not started | `packages/server/src/session-service.ts` near line 535 |
| `infra-health.ts` poller (disk / WAL / git / gh) | not started | `packages/server/src/infra-health.ts` (new) |
| `/api/v1/admin/system/health` aggregator endpoint | not started | `packages/server/src/routes/admin/system.ts` |
| Admin **Infra drawer** companion (`infra:health` companion type) | not started | `packages/admin/src/lib/sessions.ts` (CompanionType union) + new component |
| Disk hard-stop in `/dispatch` + launcher `launch_session` handler | not started | `packages/server/src/routes/admin/feedback.ts` dispatch + `launcher-daemon.ts` |
| `scripts/bootstrap.sh` repo-root bootstrap | not started | repo root |
| `packages/admin/src/pages/OnboardingPage.tsx` first-run walkthrough | not started | new page + route under `/admin/#/onboarding` |
| `/push` and `/pr` CoS slash commands | not started | `packages/admin/src/components/cos/CosComposer*.tsx` + `packages/server/src/routes/admin/chief-of-staff.ts` |
| Status pill → Infra drawer wiring | not started | `packages/admin/src/components/cos/ChiefOfStaffBubble.tsx` |
| Codex `EACCES` remediation surfaced inline on a failed `npm install -g @openai/codex` | not started | the Install Codex card (§3.2) |

Each item lands as its own ticket when work starts. The first three (cross-runtime auth detection, the poller, the aggregator) unblock all UI work — do them first.

---

## 6. Reference snippets

### 6.1 Disk usage probe (Node, no external deps)

```ts
import { statfsSync } from 'node:fs';

export function diskUsage(path = '/'): { total: number; free: number; pct: number } {
  const s = statfsSync(path);
  const total = Number(s.blocks) * Number(s.bsize);
  const free  = Number(s.bavail) * Number(s.bsize);
  return { total, free, pct: 1 - free / total };
}
```

### 6.2 Cross-runtime auth detection sketch

```ts
const PATTERNS: Record<'claude' | 'codex', RegExp[]> = {
  claude: [ /* the existing 8 patterns */ ],
  codex: [
    /please\s+(?:run\s+)?codex\s+login/i,
    /not\s+signed\s+in\s+to\s+(?:codex|openai)/i,
    /authentication\s+required.*codex/i,
    /invalid\s+(?:api\s+)?key.*openai/i,
  ],
};

export function detectAuthRequired(runtime: 'claude' | 'codex', output: string): boolean {
  const visible = stripTerminalControl(output).slice(-8000);
  return PATTERNS[runtime].some((re) => re.test(visible));
}
```

### 6.3 Bootstrap script skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1 — install via: $2"; exit 1; }
}
require git "your package manager"
require node "https://nodejs.org/  (need >= 20)"
require npm  "ships with node"
require tmux "brew install tmux  /  apt-get install -y tmux"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $NODE_MAJOR is too old; need >= 20"; exit 1; }

PROPANES_DIR="${PROPANES_DIR:-$HOME/code/propanes}"
if [ -d "$PROPANES_DIR/.git" ]; then
  git -C "$PROPANES_DIR" pull --ff-only
else
  git clone https://github.com/tinkerer/propanes.git "$PROPANES_DIR"
fi
cd "$PROPANES_DIR"

npm install
npm run build --workspaces

echo "Done. Next:"
echo "  cd $PROPANES_DIR/packages/server && npm run dev"
echo "  open http://localhost:3001/admin/"
echo
echo "Claude / Codex installation (optional, runtime-dependent):"
echo "  npm install -g @anthropic-ai/claude-code"
echo "  npm install -g @openai/codex@latest"
```

### 6.4 Cleanup recipes (called from the disk-pressure modal)

```bash
# JSONL recordings older than N days for completed/failed/killed sessions
find ~/.claude/projects -type f -name '*.jsonl' -mtime +30 -print

# SQLite WAL checkpoint (no data loss; merges WAL into main)
sqlite3 propanes.db 'PRAGMA wal_checkpoint(TRUNCATE);'

# Docker image / container / volume / build-cache prune
docker system prune -af
docker volume prune -f
docker builder prune -af
```

Wire these as the three default remediation actions in the §2.4 modal. None of them deletes operator code; all are reversible in effect (the JSONL purge is rsynced to `/tmp/propanes-purge-<ts>/` for 24 h before unlinking).
