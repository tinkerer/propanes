# Spec Backbone — Propanes Admin

The durable surface. Read this when you need to remember **what the system is**, not what last changed.

Last regenerated 2026-10-19. Sections 2.12–2.19 and §6 (development contract) were added for the June–October 2026 era; earlier sections were kept and corrected where the system moved on.

## 1. System map

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser app (any) — embeds the widget                                   │
│  └─ prompt-widget.js → POST /api/v1/feedback (manual or programmatic)    │
└──────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Propanes server (packages/server, Hono + SQLite, port 3001)             │
│   ├─ /api/v1/* REST                                                      │
│   ├─ /ws/* WebSocket (admin live, launcher control, CoS streams)         │
│   ├─ session-service (port 3002) — PTY/tmux session host                 │
│   └─ launcher-daemon — runs on remote machines for off-VM sessions       │
└──────────────────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
   Admin SPA (/admin)   CoS Bubble/Pane    Tauri desktop tray (Mac/Win)
   • feedback queues    • chat with "Ops"   • spotlight feedback popup
   • sessions / JSONL   • dispatches        • global hotkey (rdev)
   • panes / popouts    • channels per app  • nspanel tray
   • spec wiki          • voice / mic /     • cf packages/tauri-*
                          screenshot
```

Nine workspace packages now: `widget` (embeddable JS overlay), `server` (Hono API + SQLite + session-service + launcher-daemon), `admin` (Preact SPA dashboard), `shared` (types/schemas), `cli` (`propanes` command, `propanes://` handler, SSH/kubectl terminal bridge), `desktop` (Tauri tray), `e2e` (Playwright suite), `harness` (Docker test stacks), `slack-bot` (amirobot). The server also hosts per-user AKS pods (`charts/`, `docker-launcher-entrypoint.sh`) and can run from an NFS checkout — see §2.14.

## 2. Primary surfaces (the things that must keep working)

### 2.1 Feedback queue
- Tickets enter via the widget, programmatic API, error reports, Slack (`amirobot`), or the CoS itself.
- A ticket is a **draft thread**: opening a ticket lands you in an inline thread; dispatching is sending the first turn (commit `cf9f3e6`: "Tickets render as draft threads: ticket detail = inline thread").
- Three lifecycle states matter operationally: `new` → `dispatched` → `resolved` (plus `reviewed`, `archived`). Filter pills must persist (ticket `01KRSFA2MM`).
- Aggregate view groups duplicate beads by a normalized key; minimal repeat count is exposed as `?minCount=` on `/api/v1/admin/aggregate`.
- **Update Spec** converts tickets, CoS threads, and JSONL agent inputs into the durable spec wiki. The Update Spec composer launches like any other dispatch composer (ticket `01KRT5ZY3D`) and defaults to YOLO.

### 2.2 Agent sessions & dispatch
- Every session has a `permissionProfile` of `<mode>-<perms>` (see `CLAUDE.md` for the full table). Profiles compose two orthogonal axes:
  - **I/O mode:** `interactive` (TTY/tmux) / `headless` (one-shot pipe) / `headless-stream` (bidirectional JSON stream).
  - **Permissions:** `yolo` (skip prompts) / `require` (ask the operator).
- The YOLO button in the widget and admin (`pickYoloAgent` in `QuickDispatchPopup` / `widget.ts`) prefers `interactive-yolo` then falls back to `headless-yolo` / `headless-stream-yolo`. Named "yolo" / "codex-yolo" endpoints were migrated to `interactive-yolo` at startup (`db/index.ts` migration step 3).
- "do it" → renamed to **YOLO** in the operator UI (ticket `01KRKQXM69`). The vocabulary is durable.
- Resume must inherit the parent's permission flags. When resuming a session previously launched as YOLO, the resumed run must also pass `--dangerously-skip-permissions` — there's a persistent class of bugs around this and the session-service silently dropping the flag on renamed profiles ([[reference_session_service_restart]]).
- Yolo/headless sessions exit when their turn ends; instead of resume-by-hand the operator can enqueue **follow-ups** on a parent (`/api/v1/admin/agent-sessions/SESSION_ID/followup`) that dispatch on terminal status (handled by `dispatchPendingFollowups` in `routes/admin/session-followups.ts`).
- Auto-restart of closed interactive-YOLO sessions to keep generating tickets has been requested (`01KQCZQJJ0` / `01KQCZPCV5`) but is not yet implemented.
- A session's `tmuxId` for an interactive session is `pw-<sessionId>` — the copy-id action should include the `pw-` prefix so the id can be found in tmux (`01KRRYNKV3`).
- **Waiting-for-input is a first-class state** (`01KVYP3GMY`, `01KW0CEC6G`, 2026-06-25): sessions whose PTY is blocked on a prompt (permission prompt, Claude's first-run "trust this folder" prompt, AskUserQuestion) are pinned in a separate list above the sidebar (`75fe58d`, `bf9115d`). Detection tolerates Ink's collapsed spaces and is gated to startup for the trust prompt (`d822751`, [[project_ink_strips_spaces]]). The indicator must clear when the prompt is answered — stale "waiting" was ticket `01M33KPXDG` (PR #15, `067eb53`). `inputState` flaps on every keystroke, so waiting-triggered effects go through `focus-guard.ts` ([[project_input_state_keystroke_flap]]).
- **Resume promotes headless to interactive** (`01KYK9E700`, `cba4211`): a user-facing Resume on a `headless-*` session spawns `interactive-yolo` with a "continue" message, never another one-shot headless run. The restore-queue path (§2.13) keeps the parent's profile.
- **Agent sessions get API credentials** (`da9a094`, `8f4014c`, PR #21, PR #32): every spawned session, local or launcher, receives `PROPANES_TOKEN` (owner-scoped bearer) and `PROPANES_API_URL`. Codex TUI runs with `--no-daemon` so the env reaches the agent. Smoke-test bead: `01KXMNWGFX` ("token-env smoke test — reply DONE and exit").
- **Runtime badge**: every session row, card, and terminal header shows which runtime (claude / codex) runs it (`0c21673`, `4fee65a`, `cd7c9b0`; ticket `01KXGPQ3CP`).
- **Titles**: the dispatch prompt no longer repeats an auto-derived title above the feedback text (`c7b6e63`, ticket `01KVREVZYN`); the session top bar shows the ticket title with a link back to the feedback (`9709a46`, ticket `01KVRA1J1A`), and the title stays visible ahead of badges with a minimum truncated width (`8336199`, ticket `01M33RM8BJ`). Double-click on a sidebar label renames (`0956f0d`, PR #19).
- **Monorepo sub-apps** (`393d6da`, PR #2): an app may declare `subApps[]` (`name`, `dir`, `subdomain`); feedback carries `sub_app`, and `resolveSubApp` in `dispatch.ts` runs the agent in `<projectDir>/<dir>`. No Propanes Admin feedback uses it yet (`sub_app` is NULL on all 484 rows) — it exists for monorepo apps.
- **Bail-out recovery dispatch** (`01KRWH7TGZ`, 2026-05-18): when a parent session matches the bail-out heuristic (`status=completed`, `exitCode=0`, `outputBytes<5000`, `completedAt − startedAt < 2s`) — or the operator manually says "this session died, do what it was supposed to" — the CoS Ops agent re-reads the parent's `output_log` + first user prompt + originating `feedback_items` row, summarizes what the parent was supposed to do, and fans out a fresh implementation session with the same prompt envelope. The recovery session must link back to the dead parent via `agent_sessions.parent_session_id`. This is a CoS-side action; do not auto-fire from the server reconciliation path (operator gesture only).
- **Machine display name** (`01KRWHAT4S`, 2026-05-18): dispatch / launcher / harness / target pickers must show a human-readable name for the local launcher (e.g. `local — propanes-vm` or the hostname) when listing alongside named remote machines. Showing a bare `local` next to named remotes is ambiguous to the operator; resolve from `os.hostname()` and the machines table's display column.

### 2.2a Session ↔ thread unification

Active 2026-05-17 direction (`01KRVTR7Q3`): **every agent session shows up as a CoS thread**, in the dedicated `sessions` channel. Tickets, threads, and sessions stop being three parallel lists and converge on a single "thread" abstraction surfaced through CoS.

- Implementation surface: a `sessions` channel auto-populates one thread per `agent_sessions` row (434 mirrored at snapshot). The thread name is `Session <prefix>`.
- The thread carries `agent_session_id`; the JSONL companion / structured view is the same pane the CoS bubble would show for a normal thread.
- **Composer-always-feedback-and-session invariant** (`01KRYPA6XY`, 2026-05-18): every composer submission — widget, CoS, ticket-detail UnifiedComposer — must produce **both** a `feedback_items` row **and** an `agent_sessions` row, linked by `cos_threads.feedback_id` and `agent_sessions.feedback_id`. A thread that ends up with no feedback row and no agent replies is the bug shape ("standalone CoS thread"). Fix anchored in `packages/server/src/cos-inbox.ts::mintFeedbackThread` + `dispatchFeedbackToAgent` — every minted thread already creates the anchor user message; ensure the dispatch path always fires and the resulting assistant turns are attached to the same thread so the "All threads" view renders replies inline.
- Open question (`01KRVWS4V3VFM7` / regression `01KRWK14649ZVCRYE91PHAJW8W`): clicking a session-thread in the channel list should jump to the session's chat view, not open a sub-panel that hides the main chat. As of 2026-05-18 the tap still closes the chat instead of jumping; reopening from the button does not restore state. Tie this back to the channel-tap rule in §2.3.
- Sub-direction `01KRZ7WMZ8` (2026-05-19): when the thread points at a **terminal companion** (a `pw-<sessionId>` PTY session), tapping it should render the terminal as a *term screen in the chat*, not navigate away — the chat is the host, the terminal is just another companion type.
- Same direction (`01KQ___`) shows up around ticket lists: a ticket is a draft thread (`cf9f3e6`), so the ticket queue and the CoS thread list are the same data sorted differently.
- Voice / brainstorm captures (`voice-captured` tags) become threads too — they go into the `inbox` channel by default and the `brainstorm-voice` channel if categorized.
- Style consequence: the CoS bubble rendering, the structured-JSONL bubble rendering, and the slack-style channel-thread rendering must all share one renderer pipeline (already partly the case — `01KR4CKB6Z`).

### 2.2b CoS message lifecycle audit

Tickets `01KRVV09PCN031`, `01KQGVQ8N9MCY9`, `01KQDC1B43N3J6` flag the same class of bug: the message lifecycle states leak. The operator sees a "Sending…" spinner on a message they're certain was sent; queued messages still claim sending; drafts shadow real messages.

The states must be unambiguous and observable:

| State | Meaning | Visible cue |
|---|---|---|
| `draft` | Operator-typed, not yet submitted. Lives in localStorage per-thread, syncs across windows. | Italic text in the composer; yellow underline. |
| `queued` | Operator submitted but the parent agent session hasn't accepted the turn yet (followup queue, or session is mid-turn). | "Queued" pill on the message row; editable until dispatch fires. |
| `sending` | Turn is in-flight — submitted to the agent session, waiting for first response token. | Spinner; non-editable. |
| `sent` | First assistant token has been received (or the message is the operator's only contribution to a closed turn). | Plain row, no pill. |

**Invariants:**
- A `sending` spinner clears when the stream parser ingests the first matching `<cos-reply>` (or the turn ends with no text — and the followup dispatcher fires the next grouped queued message anyway, per `01KQN83H7T`).
- Stale `sending` is a bug — usually the spawn-resume path writing completion fields without clearing prior (`01KQGWKF0R`, `session-service.ts:459-467`).
- Queued messages should appear in the same list as drafts so the operator can edit them before dispatch (`01KQ5GADDD` family).
- Multi-window sync: a draft typed in window A appears in window B within ~1s — currently broken (`01KQDDJR3B`).

This whole subsection is an active audit, not a fixed spec — when fixing here, also update `packages/server/src/routes/admin/chief-of-staff.ts` followup logic and `cos_messages.derivation` semantics.

### 2.3 Chief of Staff (CoS / "Ops")
- Per-app, persistent chat that talks to a long-lived agent session. The system prompt names the agent **Ops** with a terse-bullet style; the user-facing chrome calls it **Chief of Staff**. The user-visible name needs to be unified (`01KQ2VMRA5` — "you show up as Ops on desktop but Chief of Staff on mobile").
- Threads live in workspaces; channels organize threads per app. Channels became real in commit `23b7a3b` and were made responsive across mobile/tablet in `155c483`. Tickets and threads should sort into channels (`01KR4Z71Q3`, `01KRACMHC3`, `01KQB4E785`).
- **Channel UX rules** (from `01KRACMHC3` + `01KRA1QGHC22JA`, this regeneration):
  - Tapping a channel **reloads the main chat view** to that channel's threads — not a child sub-panel that hides the chat.
  - The channel list is a toggleable left companion of the CoS pane; mobile must collapse it by default.
  - Threads are sorted into channels server-side via auto-organize proposals (`cos-channel-organize.ts`); operator can move threads between channels.
  - A **CoS workspace** spans all apps and is the default when no app is selected. Each app gets its own channel set plus this shared workspace.
  - Agents are **DMs**, not parallel tabs alongside channels — the channel list contains channels and agent-DMs in one stream (`01KRA1QGHC22JA`).
- The CoS bubble exposes drawers for: thread rail, channel list, artifacts/companions, voice, screenshot, element picker, search. The bubble was carved up into hooks (`useCosVoice` / `useCosScreenshot` / `useCosElementPicker` / `useCosSearch`) in commit `8169106`.
- Drafts persist per thread and across windows (`01KQ87JWAG`, `01KQ8F18DY`). Multi-window draft sync is a recurring pain point (`01KQDDJR3B` — "we don't have good multi-way sync").
- The CoS composer is a `UnifiedComposer` — same component everywhere (admin InterruptBar, widget, ticket detail). Commits `505ba81` and `8b3276c` extracted it. Any pop-up modal composer must use it (`01KR4ABCD9`, `01KRC5D754`).
- The composer should be **persistent** — survive close, survive refresh (`01KR5M1C0B`, `01KQ8F18DY`). The "this composer just opened on page load" behavior is a bug.
- `<cos-reply>` tagged text from the assistant is auto-persisted via the stream parser; **do not curl-POST a `<cos-reply>` to `/messages`** ([[feedback_no_curl_post_replies]]) — that double-writes and causes "messages twice."
- Long assistant replies can be dropped because tmux wraps stream-json at 120 cols and fragments fail to parse ([[project_cos_long_reply_drop]]). Verify via JSONL recording, not the wire.
- CoS followup dispatcher must fire grouped queued messages even when an assistant turn ends with no text (`01KQN83H7T`).
- **Thread visibility recovery** (`01KRVVGJGRDGRS`, 2026-05-17): when an operator drags a thread out as an outside companion on an `?embed=cos` standalone window, the thread can disappear from the main CoS view and become unreachable. Fix shape: allow the docked thread → outside companion transition, but shrink the main chat view so the thread + main chat fit the window together. Never let a CoS thread reach a state where the operator can't bring it back without a refresh.
- **Default overlay mode for threads** (`01KRT6EKC3AKM7`, `01KRKQWQRQ`): opening a thread defaults to **overlay** (drawer that overlays the main CoS chat with a drag handle), **not** a split panel that hides the chat. Regression history is on this server specifically.

### 2.3a CoS channels (durable structure)

Channels are the primary organizing axis inside CoS, per-app. They are durable in the DB (`cos_channels`), are referenced by `cos_threads.channel_id`, and are gated by a `policy_json` blob with `classification ∈ {prod, staging, exploratory}`, `allowedProfiles`, `allowedAgentIds`, `requireApproval`, `pathGuards`, and `powwow`.

**Current channel set for this app (post 2026-05-17 regeneration):**

| Channel | Kind | Theme | Sourced ticket families |
|---|---|---|---|
| `inbox` | exploratory | Auto-routed widget feedback / triage queue | all manual widget submissions land here first |
| `sessions` | exploratory | Every agent session as a thread | mirror of `agent_sessions` (434 threads at snapshot) |
| `cos-chat` | staging | CoS panel rendering, message styling, chat interactions | `01KQ2VMRA5`, `01KQB4QXGK`, `01KRA1QGHC22JA` |
| `thread-panes` | staging | Thread panel, companions, artifacts, scroll | `01KQN8S67B`, `01KQQVCHPY`, `01KRJDHV3R`, `01KRTA5ZK5WB63` |
| `mobile-ux` | staging | Mobile layout, touch, responsive | `01KRA5W61X`, `01KQ3HDYMB`, `01KRSH1917`, `01KRVENA03Q23F` |
| `composer-drafts` | staging | Composer input persistence, drafts, send-state | `01KR5M1C0B`, `01KQ87JWAG`, `01KQDDJR3B`, `01KRVV09PCN031` |
| `session-ops` | staging | Session lifecycle, status, cleanup | `01KQCZQJJ0`, `01KQGWKF0R`, `01KRBZMXVS` |
| `general-ops` | exploratory | Workspace meta-planning, agent swarm experiments | `01KR1V3FNNN9NS`, `01KQ___` (admin reorg) |
| `brainstorm-voice` | exploratory | Brainstorm pane + mic bridge + screen capture + voice transcripts | `01KQ5AQH6`, `01KQ58Y…`, `01KQ9DH52M`, `01KQ3AEJQD`, `01KQ0YZSYP` |
| `spec-wiki` | staging | Update Spec flow, /spec page, beads vocabulary | `01KRQKVAY6`, `01KRT55AG2`, `01KRVESWPQXFTA`, `01KRVEN9ZZ` |
| `tauri-desktop` | staging | nspanel tray, rdev hotkey, native build | `01KQT618FKMEC8`, `01KRRZREQBGETB`, `docs/native-plan.md` |
| `slack-amirobot` | staging | Slack-launched sessions, status queries, dispatch failures | `01KPWDHJ0A`, `01KPWCXCDEXXNC`, `01KPWCWBY41BQQ` |
| `fafo-swarm` | exploratory | FAFO setup, wiggum runs, multi-agent | `01KP2GF9TS` ×4, `01KP2V7H0S…`, meta-wiggum evolution |

**Routing rules:**

- New widget feedback → `inbox` (unless `cos_channel_org_proposals` already routes a similar bead elsewhere).
- A new agent session → auto-mirrors to `sessions`.
- An operator-created thread with no explicit channel → goes to **unsorted** (`channel_id IS NULL`). The CoS pane shows unsorted threads in a virtual "Inbox" overflow.
- Channel-creation policy: new themes only — don't fork a channel for a one-off ticket. If a single ticket can't find a home in the existing channels, it stays unsorted until a pattern emerges.
- **`kind` choice:** prod = approval-required, locked-down profiles; staging = default, all profiles allowed; exploratory = YOLO-allowed, powwow-enabled, no path guards.
- Channels are durable through reboots; archiving is soft (`archived_at`); deletion cascades to `cos_channel_members` and sets `cos_threads.channel_id = NULL`.

### 2.4 Panes, popouts, companions
- A pane tree (`packages/admin/src/lib/pane-tree.ts`) holds leaf panes with tabs. Mutations go through `commitTree()`, which RAF-debounces signal updates ([[CLAUDE.md UI Conventions]]).
- Only the **active tab** per container is mounted — never `display:none` siblings. Each `AgentTerminal` is an xterm + WebSocket + resize observers; mounting multiple freezes Chrome (CLAUDE.md rule).
- A pane can be:
  - **docked** as a split sibling,
  - **overlay companion** — a drawer that overlays the parent with a drag handle,
  - **popped out** to a new browser tab/window (state must mirror the in-app dropdown menus per `01KQ___` — popout and tab menus must be uniform).
- Drag-the-hamburger (☰) on a CoS companion converts between docked-external and overlay-internal. This handle behavior has a long bug history (`01KRMYB54Z`, `01KQRKM4PF`, `01KR4N78WP`, `01KQSZKXC2`). When the companion is on the right as an overlay, the handle is on its left edge; when external, the handle position must continue tracking the cursor mid-drag if not released.
- Close-panel "X" should remove the docked panel entirely, not just close the drawer (`01KQQVCHPY`). "Close Pane" should not also be in the hamburger menu (single-source-of-truth for close).
- Reset Layout should also reset the CoS chat (`01KQ___`).
- Z-index across resize bars and popouts must keep Ops/Chief-of-Staff to-front (`01KQ0Y87X3`).
- **Drawer-pull z-index rule** (`01KRYRFKHQ`, 2026-05-19): in popout mode the internal overlay companion and its pull handle must both layer on top of the host panel. The in-pane path (`ChiefOfStaffBubble`) already anchors the drawer's `z-index` to `getPanelZIndex(panel) + 2`; `CosPopoutTreeView` / `FloatingCompanionSplit` must apply the same rule instead of hardcoding `1000` / `1100`. The visual symptom of getting this wrong: handle visible, drawer body hidden behind the popout because `getPanelZIndex = 950 + order*2` climbed past `1000`.
- **Pane-split-divider applies to in-pane splits too** (`01KRZ84ASD`, 2026-05-19): the moveable divider used between leaf panes should also separate **channel list ↔ DM list** inside the CoS pane, and any other intra-pane split the operator can resize. The handle component is durable; reuse it everywhere — don't hand-roll a sticky 50/50 split.
- Floating overlays (menus, dropdowns, popovers, popups inside `.cos-popout`) **must** use opaque background, hardcoded `#1e293b`, not `var(--pw-bg-surface)` ([[feedback_floating_overlay_opaque]]). Full-viewport modals/lightboxes use `#0b1220` and **must** be portaled to `document.body` via `createPortal` — local rendering inside the component tree gets clipped by ancestor `transform`/`filter`/`backdrop-filter`. See [[style-guide]] for the full rule set and palette.
- Companion types are defined in `CompanionType` union (`packages/admin/src/lib/sessions.ts`): `jsonl:` / `feedback:` / `iframe:` / `terminal:` / `isolate:` / `url:`. Adding a new type needs updates in 6 places — see CLAUDE.md "Companion Tabs."

### 2.4a PTY sizing and focus rules

The shared-PTY bug family (June–October 2026) produced these rules. They are the spec; the commits are the evidence.

- **One PTY, many viewers; the PTY sizes to the largest viewer per axis** (`efeb115`, `13d30b3` for launchers; [[project_pty_largest_viewer]]). Panes never fight over the grid — each viewer mirrors the server's size instead of pushing its own (`ef21b11`, PR #17). Smaller viewers must not move the cursor (`eb19ca5`).
- **Stream profiles use `STREAM_PROFILE_PTY_COLS`** from `shared`; tmux caps windows at 10 000 cols and fills wider clients with `·` ([[project_tmux_stream_pty_width]]).
- **Reload must not flicker or scroll**: history replay RIS-replaces the screen and resize bounces are gated on a truncated snapshot at unchanged size (`775f8d2`, `d84e661`; [[project_pty_reload_flicker]]). Hidden tabs drain output so returning to a tab doesn't replay (`566c37e`). Overlay viewers that attach after an idle animation get the complete screen restored (`754435c`, PR #11).
- **Cursor**: no blinking during TUI output (`03a4859`, PR #34).
- **Focus**: the PTY takes focus on activation only when no other input is focused (`0aade8b`); the structured-view input bar must never steal focus from the PTY when it auto-focuses (`e144100`, PR #35, ticket `01M52T831A`). Per-leaf popups (status-dot menu) render only on the owning leaf (`758ac38`; [[project_multi_pane_shared_signal_popups]]).
- **Typability**: a pane is typable even before its PTY is live (`e846799`); a dead terminal socket is noticed and reconnected instead of waiting for a reload (`da0b6c1`, ticket `01M2EV3Q9J`); un-acked input is **not** replayed on WS reconnect (`15e5730`).
- **Copy**: selection + Cmd-C works via tmux `set-clipboard on` + OSC 52 handler + clipboard-wipe guard (`4676fc0`, ticket `01KXEHJE7J`; [[project_pty_clipboard_osc52]]).
- **Locale**: tmux sessions force a UTF-8 locale so TUI glyphs render (`da0e71e`).
- **Split companions**: selecting a session from the list must not auto-split an extra "Conversation" structured pane — the split view is already the host (`7f0ffa6`, ticket `01KYRNPRC7`). The Attach action on the standalone feedback page opens the session in a split (`955c234`, PR #33). The split's structured half must track the same session as the PTY half (`645f648`, ticket `01KVB70BXE`; [[project_codex_jsonl_resolution]] — resolve codex rollouts by `startedAt`, never newest-by-cwd).

### 2.5 JSONL / structured / split view
- The session view renders the live conversation in three modes: **Terminal** (raw), **Structured** (parsed bubbles), **Split** (side-by-side). Toggle: `SessionViewToggle.tsx`.
- Default mode for live sessions should be Structured ("we're defaulting to struct vs term, that option should only be there for [certain] sessions" — operator tickets) — but **Show full message** should also be on by default (`01KQN83K0P`).
- Live tail must not collapse expanded tools or scroll the viewport when new entries arrive (`01KQT0CB78`).
- The structured view must support filter pills that persist (`01KRSFA2MM`) and a scroll-down button (`01KRJDHV3R`).
- The structured view must be usable in a small footprint (mobile) and should collapse densely (`01KQ___` — "our jsonl view needs to collapse down more").
- A mobile structured view needs an inline composer + stop button so the operator can talk to the live session (`01KRSH1917`).
- Structured view rendering is the same fundamental component as the CoS bubble — minor style differences (bubble vs irc/slack) — and unifying them is an explicit direction (`01KR4CKB6Z`).
- **CoS thread companions and interactive threads default to structured view**, with a dropdown to switch to the PTY next to the session-view button (`9a96ada`, ticket `01KWNTJEDQ`). The toggle is still shown for every session; the operator's earlier "only for certain sessions" wish stands as a preference, not an invariant.
- **Thinking messages are hidden by default** in the conversation filter — "it doesn't add much since there are no traces" (`e4901cb`, ticket `01KXFJNBQT`).
- **Markdown fidelity**: `cat -n` line-number prefixes are stripped before rendering tool output (`6db7829`, ticket `01KXGXYPKV`); user bubbles keep their newlines (`8f2af76`, ticket `01KY5TW8X5`); markdown URLs render in-pane (`0006cad`). A companion iframe pointing at an `.md` file should render the markdown, and the pane resizer must keep tracking the mouse over the iframe (`0006cad`, ticket `01M2G953K1`).
- **Live tail survives `/clear` and compaction** (`c5504fb`, `5c5ec0e`; tickets `01KZC77Q11`, `01KZ6WMJX3`). Transcript views must not spin forever on plain terminal sessions (`328e88d`) and remote launcher transcripts stream the same way as local ones (`cd9e930`, `274bac2`).
- **Transport**: the JSONL companion fetches **differential** updates with a per-file byte-offset cursor + ETag (`beff883`, ticket `01KTVRBY9K` — "insane amount of bandwidth"). Long sessions exceed header limits on GET, so the client POSTs the cursor set and falls back to GET when the server lacks the POST route (`1ec1f8c`, `e7d8430`, PR #18; tickets `01M22627X7`, `01M2P8CW8J` — "HTTP 431… we shouldn't show an error like this"). Missing-JSONL differential polls answer `200 pending`, not 404/400 (`4599ad6`, ticket `01KYJNPAMN`). Polls pause while `navigator.onLine` is false (`666c385`).
- **Mobile**: images attached to a session must render in the mobile structured view (`01KTT5JBW1`); both killed and active sessions need a complete structured view on mobile (`01KWG904XG`, `9417e0e`).

### 2.6 Mobile admin
- The admin SPA is mobile-responsive. Common regressions: CoS lane not opening on mobile (`01KR___`), composer scrolling off-bottom (`01KRA5W61X`), horizontal scroll on CoS chat (`01KQ3HDYMB`), widget ends up in bottom-left corner when brainstorm mode is on, dragging window behind a popped-out CoS (`01KQ3HF8PH`).
- Mobile CoS should show the Stop on bottom-right because the operator can always submit from anywhere (`01KQ1FM7Z1`).
- The Tauri tray app uses `tauri-nspanel` to render the feedback widget as a spotlight popup on macOS; rdev provides global hotkey + Esc override (`docs/tauri-nspanel-research.md`, `docs/native-plan.md`, commits `420caf1` / `39a05ff`).
- Auth: when sessions fail to sync because the operator's session expired, the app should redirect to sign-in automatically rather than requiring a refresh (`01KRT4SNGT`). Member-role users must **not** be auto-logged-out (`464f3fb`, ticket `01KXGY222N`), and admin auth sessions are long-lived (`e95a74c`). A valid-but-forbidden token is 403, never 401 ([[project_401_logout_convention]]).
- Mobile session view: the session-id popup menu carries Resolve / Kill (`5325700`, ticket `01KVT9X6J0`); the top bar shows the ticket title + feedback link (`9709a46`); the mobile fallback renders the structured view (`9417e0e`).
- Document title shows the location host for environment disambiguation — `ProPanes <user> <host>` (`38abc93`, `19e8691`; tickets `01KVBJVW4V`, `01KY5T8BJR`).

### 2.7 Brainstorm mode + microphone input

Brainstorm mode is **microphone-first** — typing is a fallback, not the default surface. The operator launches it from the widget's mic icon (or the equivalent "record" icon on the pill overlay) and speaks; the mic bridge captures audio, the transcripts route into the CoS queue, and chunks become threads/tickets the CoS can fan out from.

**Activation:**
- The brainstorm pill (`.pw-cc-toggle-bar`) **is only visible when brainstorm/listen mode is on**. Pre-2026-04-28 it rendered unconditionally and was a recurring confusion source (`01KQB43NSJ`). The pill carries the active mic indicator while listening.
- Brainstorm starts on a **deliberate gesture** — pressing the mic icon in the widget, or the mic-icon "record" button on the pill overlay. It does **not** start automatically when a checkbox is ticked (`01KQ57A0BJ`).

**Mic bridge (the secure-context workaround):**
- `getUserMedia({ audio: true })` requires a secure context. Most propanes instances are served over plain HTTP for local dev, and an iframe-hosted widget on an insecure parent can't get the mic either. The fix is to `window.open` a localhost bridge URL — a same-origin secure-context popup that does the capture and `postMessage`s audio chunks back to the widget ([[project_mic_bridge_popup]]).
- The bridge is its own URL surface and own popup. Closing the popup ends the recording.
- A specific class of bug: the mic bridge fails to start and produces **no debug output** because the popup closes before logs flush (`01KQ3AEJQD`). Mitigation: log to a server endpoint, not console-only; or keep the popup alive with a "session keep-alive" toggle.
- A mic-select dropdown is required so the operator can pick the right device when multiple are present (`01KQ7Y0HR6`).
- The bridge must support **screen capture** as a co-equal channel (`01KQ9DH52M`, `01KQ9DGJSJ`). The brainstorm flow has the operator describing what they see; capturing the screen alongside the audio makes the transcript usable without extra context.
- "Why can't we serve through HTTPS?" — Cloudflare-fronted instances can; local dev can't. The popup bridge is the durable answer; HTTPS termination only solves the production path (`01KPQ0BPXP`).

**Brainstorm UI (the pane):**
- The brainstorm pane must be **movable and consistent with other panes** — same drag/dock/popout behavior, not a special-cased fixed corner (`01KQ5B3S55`).
- Brainstorm widget must not end up bottom-left of the admin screen (`01KQ57A0BJ`, `01KQ5AT3WH`).
- Pasting screenshots directly into the brainstorm view replaces the manual path-sharing flow (`01KQ5AT3WH`).
- Gesture-based region selection — "draw an oval, crop to it" — is a brainstorm-specific affordance the operator wants for screenshots (`01KQ5B2BC4`).
- Brainstorm sessions need **hierarchical categorization** in the admin session list, not a flat dump (`01KQ5AWH40`).
- A processing/thinking indicator must show when the brainstorm engine is chunking → developing a plan → analyzing feedback (`01KQ5AY0EB`). Otherwise the operator can't tell if the system is working.

**Logging verbosity:**
- Brainstorm + mic bridge produces a lot of debug output. A checkbox/toggle to gate verbosity is requested twice (`01KQ58YSBY`, `01KQ58Z32C`, `01KQ58YYPG`). Default off (terse); operator can enable for debugging.
- Logs from the bridge popup should reach the server (so they survive the popup closing) — pair this with the verbosity toggle.

**Mic input inside the CoS view (not just brainstorm):**
- Mic input should work **directly in the CoS view** without forcing the operator to switch into brainstorm pane first (`01KQ5AQH6`, `01KQ5APJPV`). The CoS composer has a mic affordance that uses the same bridge.
- Voice-captured tickets carry tag `voice-captured` and may have missing punctuation / run-on phrasing — treat that as a feature, not a transcription bug.

**Traceability:**
- When brainstorm fan-out creates feedback + dispatches, the dispatch flow should show (1) the feedback being created, (2) the dispatch steps, (3) which tools the chunker chose (`01KQ5AZA1H`). This is the "show your work" requirement for the brainstorm-to-CoS path.

### 2.8 Widget
- Embedded on the admin page itself. Submits via `POST /api/v1/feedback` (manual) and `/api/v1/feedback/programmatic` (error reports / analytics).
- `pickYoloAgent` in `widget.ts` must agree with the admin button — both prefer interactive-yolo. The class of bug "mobile widget launches yolo dispatches that are not skipping permissions" recurs (4 dupes in `groupKey=mobile widget is launching yolo dispatches…`).
- The screenshot capture is **html-to-image** in the page; it misses canvas, cross-origin iframes, transforms, and arbitrary CSS. **Only** use it when persisting evidence into a feedback row; never as ground truth for verifying UI work ([[feedback_use_playwright_screenshots]], CLAUDE.md "Screenshots / Visual Testing").
- The widget's element-picker must support selecting elements *inside* the CoS pane (`01KQ___` "using the CoS DOM selector should not exclude the CoS pane").
- DOM elements selected by the picker should render inline in the textarea (clickable chip), not as the literal `[Element 1]` text (`01KQSZXB5B`). The `[Element 1]` `[Image 1]` placeholder text in submitted feedback is **the bead** — preserve it when reading tickets. Since mid-2026 the dispatch prompt expands those placeholders into literal selectors and `/tmp/<ULID>.png` paths (see [[agent-jsonl-inputs#shape-a--do-feedback-item]]).
- **Widget identity**: the real embed is `/widget/propanes.js` with `data-app-key`; the server resolves the key to an app id so the agent list shows app-scoped endpoints (`fbfbec8`, ticket `01KY0GS27D`) and widget feedback on the admin page files into Propanes Admin, not an arbitrary app (`2b2ef47`, PR #7). Key lookup never happens unauthenticated (`2a0fb66`).
- **Agent picker**: the widget must always offer the full agent list including YOLO (`3165b65`, `72fc26a`, `0220232`; tickets `01KX7MGNEG`, `01KX2EANAT` "being dispatched to Codex instead", `01KY0GS27D`). The agent-settings link deep-links to `#/agents`.
- **Send menu**: "Open session" option loads the dispatched session in an app-scoped sessions view with a loading state (`cf0fc0b`, `74d161f`, `116d512`; tickets `01KY5W34TR`, `01KZW68WNQ`). Auto-dispatch stays sticky when sending from the menu (`4cbce07`, PR #13, with e2e coverage). Persisted YOLO mode is honored on plain submits (`b2af82a`).
- **Submit reliability**: duplicate submits are blocked with an in-flight spinner (`eddb403`); the typed prompt survives until the server confirms the row (`ccc9b4c`); description/instructions caps are 100k and zod details surface in the widget error (`c9fee39`, ticket `01KYJMFZ6J` "Validation failed"). Path prefixes are preserved when deriving API/admin URLs (`cc65bd4`, PR #1).
- The widget Settings button and the Ops entry are gated behind the alpha preference (`292cf35`, PR #12).

### 2.9 Spec wiki
- The page at `/admin/#/app/APP_ID/spec` (`packages/admin/src/pages/SpecWikiPage.tsx`) loads markdown from `<projectDir>/docs/spec-wiki/<appId>/` via `api.getSpec(appId, file)`.
- "Update Spec" button calls `launchSpecUpdate(appId)` which prefers a YOLO agent. The fallback path creates a `programmatic` feedback row tagged `spec-wiki` and dispatches it with the canonical instructions block.
- The Update Spec composer launches like any other dispatch composer so the operator can add direction before dispatch (`01KRT5ZY3D`).
- A click on "view spec" must actually load the spec (`01KRT55AG2`).
- The wiki must consume tickets, CoS thread inputs, AND JSONL prompt histories — not just the ticket list (`01KRQKVAY6`).
- **Spec content must reflect current truth.** Statements like "the Aggregate button is being repurposed" are wrong if the rename has happened — the spec should say "Aggregate has been renamed to Update Spec" with the past tense (`01KRVESWPQXFTA`). Wiki regenerators should rewrite past-future-tense fragments into present-tense statements of the system as it stands.
- **Mobile readability**: the spec page must be **collapsible** so the sections fit on a phone (`01KRVEN9ZZ5H8Q`, `01KRVENA03Q23F`). Implementation: each H2 section is a `<details>` element collapsed by default on viewports < 768px, with the TOC pinned at top.
- **Scroll behavior**: new messages arriving in the CoS chat embedded above the spec page must not scroll the spec to the top (`01KRTA5ZK5WB63`). The chat and the spec body scroll independently.
- **Regeneration is a PR**, not a direct write to `master`: the Update Spec session now runs under the development contract (§6), so each regeneration lands as a reviewed PR on `docs/spec-wiki-<date>`.

### 2.10 Slack / amirobot
- An `amirobot` Slack bot can drop tickets into the queue and ask status questions ("how many sessions are we running now," "status of the product admin console"). Slack-originated sessions should launch as headless-YOLO and be linkable back to the propanes session (`01KQ___` "Slack: When we launch a session via slack can we link to the session in propanes").
- Known failure mode: `Failed to dispatch: Propanes /api/v1/admin/feedback/<id>` from amirobot — see Slack-tagged tickets.

### 2.11 Infrastructure & CLI health

The session-service is only as healthy as its host environment. Three classes of upstream failure show up regularly as propanes "bugs":

- **Disk pressure.** Long-running JSONL recordings (50 MB+ per heavy session), SQLite WAL backlog (370 MB at this snapshot), Docker images, and historical CoS attachments accumulate. The 2026-05-17 freeze incident (DOM fragment *"we ran out of disk space and everything froze"* captured in JSONL `ed44f872-…`) was a hard-stop the system should have refused before it became a hang. Spec: monitor `statfs('/')` every 60 s, refuse new spawns at ≥ 95 %, expose a one-click cleanup modal at ≥ 90 %. Full thresholds + remediation recipes in [[infra-onboarding#2-infrastructure-health-surface]].
- **CLI absent / outdated / not logged in.** `claude` and `codex` are external dependencies that the operator installs and authenticates themselves. The existing `claude-auth-detect.ts` only handles the claude login pattern — it must be generalized cross-runtime (ticket `01KRWHGWN0`, *"our session manaer needs to monitor for situations like when we need to login to claude. we should have a better automatic approach that detects this and loads a pty session for the login flow"*). The detection truth table per runtime / binary-present / logged-in / version-ok lives in [[infra-onboarding#31-detection-truth-table]].
- **Reboot reconciliation.** `agent_sessions.status='running'` rows survive reboots even though the processes don't (ticket `01KRBZMXVS`). `cleanupOrphanedSessions()` in `packages/server/src/agent-sessions.ts` runs 10 s after boot from `index.ts:114`. The invariant: any `running` row not present in the session-service registry **and** with no live tmux socket within 30 s of boot becomes `killed` with `outputLog` preserved. See [[infra-onboarding#25-reboot-reconciliation]].

Surface: `GET /api/v1/admin/system/health` (to be added) returns a structured per-check status used by the CoS bubble's status pill and a new `infra:health` companion drawer. The pill is green / amber / red on `all ok / any warn / any error`. The drawer exposes per-check one-click remediations (claude install, codex update, disk cleanup recipes, gh auth).

Onboarding is a sub-spec of the same surface: a contributor with a fresh box should reach "propanes admin running locally + can open a PR back to `tinkerer/propanes`" via a single `scripts/bootstrap.sh` plus a first-run `OnboardingPage`. The recurring *commit-and-push* dispatch pattern (`01KRMWWSG9`, `01KR5KHBQK`, `01KR4QT3GF`, `01KQRKHFAX`, `01KQXAM8BD`, `01KP70SP1P`, `01KP6TXF4V`, `01KPKNE6RW`, `01KPH78A1R`) collapses into a `/push` CoS slash command; `/pr` opens the PR via `gh pr create`. Full contributor flow in [[infra-onboarding#4-contributor-onboarding]].

The work list (what's missing today vs the existing primitives) is itemized in [[infra-onboarding#5-open-work-the-spec-deltas]].

### 2.12 Session → PR pipeline

The June–October 2026 direction: a dispatched session is not done when it edits files — it is done when its PR is merged.

- **Detection**: PR URLs are detected from the session transcript (JSONL), not only the PTY (`ae75035`, PR #4), and stored in `agent_sessions.pr_urls`; cursor-forward skips never fabricate URLs and stored fabrications were scrubbed (`800257e`). 203 sessions carry PR URLs at this snapshot.
- **Display**: a PR badge shows in the sidebar session row, the sessions page card, the pane/terminal header, and in Cmd-K search (`2a72f6d`, `abbe16e`, PR #5). Badges **collapse** behind the title in the pane header the same way as in the sessions list, so the title stays clickable to open the feedback ticket (`7d68020`, PR #24, ticket `01M4CZ28P8`). Badges live on the thread divider, right side, so they don't shift on hover (`a458502`, ticket `01KY3BD6CD`). Session menu lets the operator add / remove / hide badges by hand (`154e57f`, PR #20; `pr_urls_added`, `pr_urls_hidden`).
- **Review**: the session menu has "Review PR", which opens a quick-dispatch composer pre-filled with `review PR <n>` on a YOLO profile, defaulting to the **other** runtime (claude reviews codex work and vice-versa) with the agent dropdown still editable (`cd7c9b0`, ticket `01KXGPQ3CP`). The operator also files `review PR <n> as <account> and approve if all looks good` beads for the product repo (`01KX6QCK0D`, `01KYRMVSSV`, `01KZRCAVST`, `01M3AW8254`, `01M3G370P7`, `01M15TZNGC`).
- **Contract**: the dispatch hint appended to every prompt (`COS_REPLY_DISPATCH_HINT` in `dispatch.ts`) tells the agent to run CI-equivalent checks locally, open a PR, and keep monitoring CI, conflicts, and review requests until approval (`d8c29cf`, `f744578`, `fadf72c`, PR #23). Full text in §6.
- **Approvals**: `cos_dispatch_approvals` + the Approval Queue page exist for channel-policy `requireApproval`, gated behind alpha features (`da4cff2`, PR #10).

### 2.13 Restart / restore workflow

`propanes.service` restarts used to SIGKILL every detached tmux session underneath it (fixed by `KillMode=process`, PR #27). The recovery surface is durable:

- `cleanupOrphanedSessions()` marks rows whose process tree is gone as `status='failed', failure_reason='orphaned_restart'`. A row confirmed alive on a later check is self-healed back to `running` (`unmarkFalseOrphan` in `restore-queue.ts`).
- The **Restore Queue** page (`RestoreQueuePage.tsx`, `806ae9b`, PR #29) lists orphaned conversations (collapsing historical rows of the same `claude_session_id`), lets the operator resume one or all, and disables per-item actions while a bulk restore runs (`741e805`). `restore_dismissed_at` hides items the operator chose not to restore.
- Resume uses `resumeAgentSession()` with `DEFAULT_RESTORE_PROMPT`: *"This conversation was interrupted by a propanes service restart, not by you finishing or giving up. Before doing anything else, check the current state of your task… If the task is already fully complete, say so briefly and stop… If it is partially done, resume precisely from the interruption point… If it was never started, proceed normally."* The queue tells a genuine recovery apart from a resumed session that immediately hit a usage/billing wall.
- A session whose tmux is still alive but whose PTY reattach is racing is **not** an orphan (`session-recovery.ts`, `tryRecoverSession()`); it is recovered by reattach, never queued. Session-service restarts are `systemd`-managed ([[reference_session_service_restart]]).
- Operator beads behind this: `01KT7RGPPJ` ("i came back after an evening and my sessions all seemed to be ended"), `01M2EV3Q9J` ("after reload I have to refresh to type"), `01M3MV86GW` (all WebSockets failing — a cert expiry, see [[reference_wildcard_cert_renewal]]), the 2026-10-12 ~18:45 UTC unplanned restart that interrupted session `01M4RRBY07…` mid-task (JSONL `7fae0026-…`).
- The admin SPA detects a **stale bundle** after a deploy and shows a reload banner (`ddbe7db`).

### 2.14 Multi-user hosting, tenancy, and path-prefixed mounts

Propanes Admin runs as a shared service and as per-user pods:

- **Users and orgs**: multi-user login (`865d82c`), org-scoped admins where only org-less admins see everything (`2f888d0`), `owner_user_id` / `org_id` stamped on feedback and sessions so members can see widget feedback (`82dd29a`, `57e7cbb`). The seeded `env-admin` user row keeps admin-route writes valid under tenancy FKs (`fd571c9`, verify beads `01KX46DP7C`, thread `01KX46KBHP`). Users page errors (`01KWGHE88A` "Failed to load users (500)") are the regression shape.
- **Per-user isolated workspaces** — own org, apps, NFS paths (`409e64d`); **self-service per-user AKS pod provisioning** (`0551cf1`, `d1c1d6d` chart) with `DB_PATH` set on provisioned pods (`1bfc300`); **per-session isolates & metering** (`53993ba`, `agent_sessions.isolation` / `isolate_id`, `session_usage`). All 1,739 local sessions are `isolation='shared'`; isolates are a pod feature.
- **NFS run mode**: pods opt in via `/data/propanes-run-from-nfs` and run server, session-service, and launcher from the NFS checkout with a fast-exit fallback (`4db7f9c`, `88ec365`, `274bac2`); see CLAUDE.md "Per-user pods: running from NFS" and [[reference_maksym_stage]].
- **Path-prefixed mounts**: `PROPANES_BASE_PATH` makes every shell work under a prefix (`8a4e6d6`); the admin SPA (`f667eea`, `ab418b3`, `af5bb9f`), widget (`cc65bd4`), and CLI (`006a3ce`) preserve the prefix; the manifest loads credentialed behind an SSO gate (`8d35be9`); an env-driven IP allowlist lets a prefix mount drop the SSO gate (`281ac43`); direct local agent API requests are allowed (`0d545d1`, PR #26).
- **Launcher auth**: launcher pods seed `~/.claude/settings.json` from `propanes-agent-auth` as defaults, not policy (`cb12abc`, `a3786b6`, PR #3), run with writable credentials (`6694c1d`), and support in-session `claude update` via a user-local native-install shim (`ee0aaf5`).
- **Bootstrap**: `pnpm setup` / `scripts/setup.sh` is the one-command bootstrap from a bare machine; `pnpm doctor` checks it; migrations run in session-service so first boot works on a fresh DB (`6a524b0`, `d580bdb`, `f2a11db`, `63438ee`). The first-run `GettingStartedPage` ships a hot-reloading starter and guided prompts (`474934f`).
- **Hostnames are not spec**: internal hostnames must not appear in code comments or git history (`eac6eb9`, tickets `01KX2KX51N`, `01M12GRQQS`, `01KX72VDVP`). Use "the staging VM", "the shared VM", or a `<host>` placeholder in docs.

### 2.15 Theme: light mode and PTY colors

- 2026-09-19 refresh: neutral surfaces with restrained brand accents (`c291052`), light sidebar and session contrast fixed (`7186f3b`), conversation themes unified across structured view, CoS, and JSONL (`414baac`). The flame palette rule in `AGENTS.md` / `DESIGN_SPEC.md` still applies — category differentiation by shade, label, or icon, never by hue outside black/grey/blue/red/orange/yellow.
- **PTY and structured view follow the app's light/dark mode** (`a053973`, PR #22, ticket `01M3T444MA`), with independent PTY color preferences the operator can override (`7186f3b`).
- Dispatch composer textarea has sufficient contrast in dark theme (`470d7f9`).
- Text selection is disabled on pane tabs, feedback title links, and session tags (`18b3108`, `b9b88ac`, PRs #8/#9).
- The activity ring must read as progress, not as broken; white sidebar spinners are gone (`8ef339f`, PR #14).
- Favicon is the propane-tank icon from the desktop build, re-centered from `.VolumeIcon.icns` (`1288b94`, ticket `01KV6CGPY4`); the tray icon is a plain white circle (`b6cf069`).

### 2.16 Attachments and file transfer

- **Composer uploads**: files dragged into any composer are persisted via `uploads` and exposed as `/api/v1/uploads/<id>` with a copy-path action; the dispatch prompt lists them under `Attached files (read from these local paths if you are on the server host)` (`90c50e5`, ticket `01KV681WZN`).
- **Session panes accept drops**: images and files can be dragged onto the PTY or the structured view; images are pasted into the PTY the way Claude natively supports, other files land in `/tmp` and their path is typed into the command line, and a warning is shown before uploading very large files (`2845e05`, `44ce21a`, ticket `01KXESFWZ9`).
- **Paths must exist where the agent runs**: composer-attached images are symlinked into `/tmp` so prompt paths resolve (`734034a`, `bbc6d4f`), remote attachment copies align with the healed prompt paths (`e5b2e62`), and feedback screenshots/attachments are shipped to remote launchers before launch (`c6eeab8`, `e0815fa`). Tickets `01M21FRY2Y` ("tmp directory files that do not exist") and `01M21N9YPS` ("testing if we can see this attached screenshot") are the regression tests.
- Widget screenshot capture remains html-to-image and remains lossy — see §2.8.

### 2.17 Flatter upstream sync

Flatter is the feature-import workflow the operator specified in ticket `01KX1SZ2PV`: *monitor upstream projects, rank new commits/features as critical / nice-to-have / skip, present a dashboard the operator can annotate, scope and re-rank against our repo, then do the work in lanes.*

- Tables: `flatter_monitors`, `flatter_runs`, `flatter_items`, `flatter_plans`, `flatter_reports`. Page: `FlatterPage.tsx` at `#/app/<appId>/flatter`. Commits: monitor dashboard (`b260a5f`), plan run flow + plan document (`711907c`, `0b9bc0b`), accept/re-open + ask-the-planner composer (`7e54a17`), non-git sources + assist composer (`2538451`), input reliability + parser classification (`0169397`), outbox failures surfaced (`607f695`).
- **Lanes** dispatch as ordinary feedback items titled `[Flatter/Plan]`, `[Flatter/PR]`, `[Flatter/Review]`, `[Flatter/Verify]` (`01KX41EZDE`, `01KX6F82VE`, `01KX6F82VG`, `01KX6F82VH`) whose description is the plan body — so the same session/PR pipeline applies.
- Direction still open (`01KX7KZ60Q`): a "setup assist" composer to describe *how* Flatter should pull features, plus computer-use/Playwright to examine features in another web app and emulate them. The first upstream was `meawoppl/agent-portal`, which the structured view was originally based on (`01KTTEQB2Z`, `01KZC77Q11`).

### 2.18 `propanes` CLI and terminal access

- `packages/cli`: `propanes login` (portal SSO device flow `ccb1855`, browser-assisted `--web` for SSO-gated hosts `9aeed13`), `propanes feedback` (`ee0f670`), `propanes sessions` / `attach` with auto-tunnel over the SSH gateway (`7325832`), `propanes://` protocol handler (`148fac1`, macOS install fix `9722e38`), edge-SSO redirects surfaced clearly (`cf07012`), portal session preserved across app-token logins (`dfcd3c2`).
- Terminal bridge: SSH gateway, plus a kubectl-exec mode for K8s pods that needs no sshd (`0654b6f`). The pod image carries dev/agent tooling, `linear-cli`, `xz-utils`, `feh` (`38fed57`, `bcbf1e4`, `d8e0fd0`, `0a29836`; ticket `01KYB5RCRV` — the build failed until `xz` was present).

### 2.19 Alpha gating and defaults

- `pw-alpha-features` (localStorage, `settings.ts`) gates: Ops / Chief-of-Staff chat, Review approvals / Approval Queue, the widget's Ops entry, Flatter page entry points (`da4cff2`, `292cf35`; PRs #10/#12). Default **off**. Consequence: the CoS surfaces in §2.3 are dormant on fresh installs and no new `cos_messages` have been written since 2026-06-11.
- Quick Dispatch panel: anchored to the `[+]` button (`643c98c`), resizable (`da6545a`, PR #6), remembers the last-used agent globally and keeps agent settings sticky between runs — same for the widget (`a7fb101`, ticket `01KVBX4Y0E`). It must survive duplicated sessions panes (`125ba95`) and never fail with `Agent endpoint has mode "webhook" but no URL configured` (`3f035d5`, ticket `01KTVQS9YD`). Operator smoke beads `01KX467AZX`, `01KX401GE1` ("quick dispatch buttons stopped working").
- Sidebar: app filters and "Group by application" default to checked (`d5b0282`); CoS sidebar groups split by app (`b4139c1`, ticket `01KV68F499` "all of our sessions end up under the CoS Inbox and show up as sessions of one app").
- Service root `/` redirects to `/admin` (`4dff9da`, ticket `01KVSBTQFC`).
- Resolve is optimistic and bounded; session pushes must not resurrect an optimistic kill/resolve (`8988909`, `e47f5f3`; ticket `01KYR5HW1B` "hitting resolve but it is not resolving").
- CoS overlay drawers start just below the thin toolbar so the X / hamburger stay visible (`05c48c0`, ticket `01KYR5PN18`).
- "Close other tabs" must work (`01KXS2ZC6T`).

## 3. Data flow rules

- **All UI state that survives refresh** belongs in localStorage (composer drafts, QDP-panel entries `01KRQKBNAJ`, filter pills, dispatch type + agent selection `commit 50bf6d3`).
- **All cross-window state** (multi-tab admin, popped-out panes) must round-trip through the server WebSocket — local state diverges otherwise.
- **Pane tree mutations** must go through `commitTree()` (RAF-debounced). Never assign `layoutTree.value` directly outside `commitTree` or `batch`.
- **Tab mounting** is strict-active-only per container in `LeafPane` / `GlobalTerminalPanel` / `PopoutPanel`.
- **Floating overlays** are always opaque (`#1e293b` for popups, `#0b1220` for full-viewport modals/lightboxes) — never `var(--pw-bg-surface)`. Full-viewport overlays portal to `document.body`. See [[style-guide]].
- **Never** use `window.prompt` / `alert` / `confirm` — use modals or the `TerminalPicker` spotlight (`packages/admin/src/components/TerminalPicker.tsx`).
- **CoS-only dispatch rule** applies to *Ops chat*; dispatched implementation agents (dispatch-shaped prompt; ex-`[AGENT NOTE]` preamble, removed 2026-06-11) act directly ([[feedback_dispatch_only]]).
- **Don't curl-POST `<cos-reply>`** — stream output is auto-persisted ([[feedback_no_curl_post_replies]]).
- **JSONL transport is differential** (byte-offset cursor + ETag, POST with GET fallback). Never fetch a whole transcript on a poll.
- **Attachment paths are healed server-side**: anything the prompt references under `/tmp` must exist on the host where the agent runs (local symlink or launcher transfer) before spawn.
- **Secrets and hostnames** never go into code comments, docs, or commit messages. `PROPANES_TOKEN` is injected into the session env, never pasted into prompts.
- **Status transitions are optimistic in the UI and reconciled by the server**; a server push must not undo an optimistic kill/resolve.

## 4. Agents and permission profiles

Registered endpoints (app-scoped or global) seen in this instance:

| Endpoint ID | Name | Mode | Profile |
|---|---|---|---|
| `01KNR6KMPE…` | Claude Code (headless) | headless | `interactive-require` |
| `01KNR6KMQW…` | Claude Code (headless) | webhook | `headless-yolo` |
| `01KNRD4VPK…` | Claude Code (full auto) | headless | `headless-yolo` |
| `01KNRG6Z14…` | yolo | interactive | `interactive-yolo` |
| `01KPS040Y7…` | codex-yolo | interactive | `interactive-yolo` |
| `01KPS040Y9…` | codex | interactive | `interactive-require` |
| `01M21MQRNE…` | Claude Interactive | interactive | `interactive-require` (added 2026-09-08) |

Selecting which endpoint to use:
- **YOLO button → `pickYoloAgent`** prefers interactive-yolo, then headless-yolo, then headless-stream-yolo.
- **Picker default** is the app's default endpoint, falling back to global default.
- **Headless-stream-require** is the only profile that combines stream-json + permission gating (approval prompts come back as JSON events). Claude only; codex exec has no approval back-channel yet.
- **Observed usage since June 2026** for this app: 135 `headless-stream-yolo`, 42 `plain` (operator-opened terminals named `propanes-admin-XXXXXX` / `build-admin-XXXXXX`), 14 `interactive-require`, 1 `interactive-yolo`. The YOLO quick-dispatch default is `headless-stream-yolo` in practice; the seeded `yolo` / `codex-yolo` endpoints remain `interactive-yolo`.
- Codex TUI sessions run with `--no-daemon` so the per-session env (`PROPANES_TOKEN`) reaches the agent (PR #32).

## 5. Persistent invariants (do not regress)

- Ticket detail = inline thread; dispatching = sending the first turn.
- One CoS thread per conversation; each thread has a `claudeSessionId` and an `agentSessionId`.
- Every agent session also appears as a thread in the `sessions` channel (auto-mirrored).
- **Every composer submission creates both a feedback row and an agent session** — a thread that mints with no `feedback_id` and no agent replies is a bug (`01KRYPA6XY`).
- Resume preserves `--dangerously-skip-permissions` if the parent had it.
- Stream output auto-persists `<cos-reply>` text — no curl-POST.
- A session whose tmux id is `pw-<sessionId>` is the source of truth for live PTY state.
- Tab mounting is strict-active-only; tree mutations go through `commitTree`.
- Floating overlays are opaque; never `var(--pw-bg-surface)` in dark scopes. Full-viewport overlays portal to `document.body` — see [[style-guide]].
- Image lightbox uses `#0b1220` backdrop, not `rgba(0,0,0,…)` — caught again 2026-05-17 (`01KRVV32EKABX5`).
- For UI verification, ground truth is `pw screenshot` (or `pw-vnc`) — not the widget's html-to-image.
- A CoS thread can always be brought back to view from any state. Dragging it to an `?embed=cos` outside-companion must not orphan it.
- Channel-tap reloads the main chat to that channel — never opens a sub-panel that hides the chat.
- Brainstorm starts on a deliberate gesture (mic icon click), not by toggling a checkbox.
- A spawn must refuse cleanly when the host can't support it: disk ≥ 95 % full → HTTP 503 with remediation actions; `claude`/`codex` binary missing → 503 with an install card. See [[infra-onboarding#24-hard-stop-on-disk-pressure]].
- Detected login-required state spawns a sibling `interactive-require` companion session; the parent pauses until login completes. Generalize cross-runtime; do not silently fail the parent.
- A session is **done when its PR is merged**, not when the diff exists. PR URLs come from the transcript; badges collapse behind the title; Review PR dispatches to the other runtime.
- A service restart never silently loses work: orphaned rows become `failed / orphaned_restart`, appear in the Restore Queue, and resume with `DEFAULT_RESTORE_PROMPT`.
- One PTY, many viewers: the PTY sizes to the largest viewer per axis, reload never flickers, input is never replayed, and nothing steals focus from the PTY.
- Structured view is the default for thread companions, hides Thinking, survives `/clear` and compaction, and never surfaces transport errors (431/404) to the operator.
- Every spawned session has `PROPANES_TOKEN` + `PROPANES_API_URL`.
- Every path the prompt references exists on the host where the agent runs.
- Light mode is honored everywhere, including PTY and structured view.
- Hostnames and secrets never enter source, comments, docs, or history.
- Alpha features are off by default; nothing on the default path depends on the CoS chat being enabled.

## 6. Development contract (what every dispatched agent must do)

This is the literal contract appended to every dispatch prompt (`COS_REPLY_DISPATCH_HINT`, `packages/server/src/dispatch.ts`, PR #23), restated as a checklist. It applies to Update Spec runs too.

1. **Implement directly.** A dispatch-shaped prompt means you are the implementation agent, not the CoS ([[feedback_dispatch_only]]). Don't ask whether to proceed; build it ([[feedback_implement_dont_ask]]).
2. **Before committing**, inspect repository instructions (`CLAUDE.md`, `AGENTS.md`, `DESIGN_SPEC.md`) and CI configuration. This repo has **no `.github/workflows`** and `master` is **not branch-protected** (checked 2026-10-19), so the CI-equivalent checks are the local ones:
   ```bash
   pnpm lint      # turbo lint (depends on ^build)
   pnpm build     # turbo build — server: tsc; admin: vite build; launcher: esbuild
   pnpm test      # node --test in packages/server and packages/admin
   pnpm test:e2e  # Playwright suite in packages/e2e (needs a running server)
   ```
   Run the ones relevant to the change; fix failures before pushing. If a check cannot run locally, say which and why — never claim it passed.
3. **Verify UI with Playwright**, not the widget's capture (`pw goto` + `pw screenshot`, [[feedback_use_playwright_screenshots]]).
4. **Commit on a branch and open a PR** against `tinkerer/propanes` `master` with `gh pr create`. Commit messages end with the Claude co-author trailer; PR bodies end with the Claude Code attribution line. Never force-push (see the product repo's PR auto-fix bot notes).
5. **Monitor the PR** for CI results, merge conflicts, reviewer comments, and change requests; fix and re-push; re-check after every push. With no CI here, the gate is reviewer approval or the operator saying "merge it" (seen in JSONL `eac99d3c-…`, PR #35). Opening a PR does not complete the task.
6. **Report honestly**: if blocked on CI that doesn't exist or on a pending review, say so with the PR URL rather than claiming completion.
7. **Reply through `<cos-reply>…</cos-reply>`** with a 1–4 sentence summary (changed files/commits, what was verified, follow-ups). Only wrapped text reaches the Inbox thread; never curl-POST it ([[feedback_no_curl_post_replies]]).
8. **Respect the repo rules**: flame palette only; no `window.prompt/alert/confirm`; strict lazy tab mounting; `commitTree()` for layout mutations; opaque floating overlays; no hostnames in comments or history.

## 7. Cross-references

- `CLAUDE.md` (project root) — the operator manual: API examples, agent mouse/keyboard API, session lifecycle, permission profiles.
- `docs/native-plan.md` / `docs/tauri-nspanel-research.md` — Tauri tray design.
- `docs/performance-profiling.md` — how to profile the admin.
- `docs/session-service-boot-race.md`, `docs/terminal-access.md`, `docs/onboarding-review.md`, `docs/design-review.md` — era-2 design notes that back §2.13, §2.18, §2.14, §2.15.
- `scripts/setup.sh`, `scripts/seed-local.mjs` — bootstrap and seed.
- `packages/server/src/restore-queue.ts`, `packages/server/src/dispatch.ts` (`DEFAULT_PROMPT_TEMPLATE`, `COS_REPLY_DISPATCH_HINT`, `resolveSubApp`), `packages/admin/src/lib/settings.ts` (`alphaFeaturesEnabled`).
- `packages/admin/CLAUDE.md` / sub-package CLAUDE.md files — per-dir notes.
- `[[tickets]]` — full deduped catalogue.
- `[[operator-inputs]]` — operator vocabulary and preferences.
- `[[agent-jsonl-inputs]]` — how dispatched agents actually get driven.
- `[[infra-onboarding]]` — infrastructure health checks + contributor onboarding flow.
