# Propanes Admin — Spec Wiki

**App ID:** `01KNR6HYSPE08RZJSQJG6WE1PK`
**Project dir:** `/home/azureuser/propanes`
**Server:** `http://localhost:3001` (admin at `/admin/`, widget embedded on the admin page itself)
**Wiki dir:** `/home/azureuser/propanes/docs/spec-wiki/01KNR6HYSPE08RZJSQJG6WE1PK`

This wiki is the durable specification distilled from tickets, CoS thread inputs, and agent JSONL histories. It is the **bead → spec** companion to the live `Aggregate` view — tickets are the beads, this is the rolled string.

## What Propanes Admin is

The Preact SPA dashboard at `packages/admin/` that drives the propanes operator workflow:

- Triage incoming **feedback** (manual widget submissions, programmatic error reports, voice captures).
- Run **agent sessions** (Claude Code / Codex, interactive TUI or headless stream-json) against a registered application's project directory, optionally on remote launcher machines.
- Stay in dialog with a **Chief of Staff (CoS / "Ops")** agent that knows the queue and can dispatch on the operator's behalf.
- Inspect live conversations as JSONL / structured / split views and intervene mid-turn.
- Pop panes out into separate windows, dock companions, and drive everything from a phone-sized viewport when needed.
- Brainstorm with the operator over **microphone input** (and, by extension, screen capture) when typing is the wrong shape.
- Stay healthy on the host: notice when **disk is full, claude/codex isn't installed, or login is expired** — and recover gracefully.

## Wiki pages

- **[spec-backbone.md](spec-backbone.md)** — the durable product surface: invariants, primary surfaces, data flow rules, UI conventions. Read this first when picking up new work.
- **[style-guide.md](style-guide.md)** — color tokens, opacity rules for floating overlays, portal/containing-block rules, palette, and a checklist for any new popup/modal/lightbox. Read this before touching anything that floats over other content.
- **[infra-onboarding.md](infra-onboarding.md)** — infrastructure health checks (disk, CLI presence, login state, version drift) and the contributor onboarding path (fresh box → running propanes → PR back to upstream). Read this before touching the session-service lifecycle, before adding new spawn paths, or when a contributor asks how to start.
- **[tickets.md](tickets.md)** — deduplicated catalogue of operator tickets grouped by surface, with status and ULIDs preserved.
- **[operator-inputs.md](operator-inputs.md)** — recurring operator preferences, vocabulary, and recurring patterns of feedback (what the operator keeps asking for and why).
- **[agent-jsonl-inputs.md](agent-jsonl-inputs.md)** — how dispatched agents actually get driven: prompt shapes, the `[AGENT NOTE]` preamble, `[TURN requestId=…]` envelopes, DOM-selection and image-attach payloads, common follow-up patterns.

## Snapshot of the queue (at wiki generation, 2026-05-19)

- **Feedback rows for this app:** 373 total — 106 `dispatched` (96 manual + 2 error_report + 7 programmatic + 1 request), 231 `resolved` (200 manual + 10 programmatic + 21 request), 33 `new` (29 manual + 4 programmatic), 1 `reviewed`, 1 `archived`, 1 `deleted`. Manual is the dominant type.
- **CoS threads:** 718 total. 53 are still **unsorted** (no `channel_id`) — these are the highest-signal recent operator threads (sample list in [[tickets#unsorted-threads]]).
- **CoS messages:** 1,004 stored in `cos_messages` across all threads for this app.
- **Agent sessions on this server:** 1,020 total — 985 `claude` (401 completed / 284 killed / 151 failed / 132 deleted / 16 running / 1 idle), 35 `codex` (6 completed / 19 killed / 5 failed / 5 running). The `sessions` channel auto-mirrors every session as a thread.
- **CoS channels:** 13 active. See [[spec-backbone#23a-cos-channels-durable-structure]].
- **Local JSONL session files:** 795 under `/home/azureuser/.claude/projects/-home-azureuser-propanes/` (592 MB); 38 codex rollouts under `~/.codex/sessions/2026/`.
- **Host disk:** `/` is **103G / 123G (84 % used)** — eased back below the 89 % previous reading after cleanup; still inside the watchlist band per [[infra-onboarding#24-hard-stop-on-disk-pressure]].

## How to regenerate this wiki

```bash
# From the admin UI: open Spec Wiki page, click "Update Spec".
# Or, equivalently, POST a programmatic feedback row with tag spec-wiki and dispatch.
```

The dispatch helper lives at `packages/admin/src/lib/spec-update.ts::launchSpecUpdate`. It prefers a YOLO profile (`interactive-yolo` → `headless-yolo` → `headless-stream-yolo`) and falls back to manual feedback-create + dispatch when the server's `/spec/update` route isn't usable.

## Active themes (at this regeneration)

These are the **currently-moving** directions the operator pushed in the last week and that anchor most of the open tickets. See [[spec-backbone]] for the durable definitions and [[tickets#by-theme]] for the active beads.

1. **Infrastructure & onboarding** — auto-detect when `claude` / `codex` needs login, install, or update; refuse new sessions when disk is critically full; give a contributor a single bootstrap path to running propanes + opening a PR back to `tinkerer/propanes`. Anchor ticket `01KRWHGWN0` ("our session manaer needs to monitor for situations like when we need to login to claude…"). See [[infra-onboarding]] for the whole spec.
2. **Session ↔ thread unification** — "All of our sessions should appear as threads in the CoS pane. Unite our seemingly separate abstractions." Implemented as the `sessions` channel that auto-mirrors every `agent_sessions` row. New 2026-05-18 direction `01KRYPA6XY` extends this: **every composer submission must produce both a feedback row and an agent session** — a "standalone CoS thread" with no linked ticket and no replies is the bug shape. Open follow-ups: clicking a session-thread navigates to the session view (`01KRVWS4V3VFM7` / `01KRWK14649ZVCRYE91PHAJW8W`); a terminal-session thread tap should render the terminal in-chat (`01KRZ7WMZ8`); the Sessions page itself becomes a channel.
3. **Channels actually working** — channels are durable, per-app, browsable; tapping a channel reloads the chat to that channel's view; channel list toggleable; threads correctly sort into channels. Inbox is the default route for new widget submissions. Recent direction: the channel-drawer hamburger should sit inline with the tools/search controls, not on the title bar (`01KRWC6EAE0CMY`); the **channels ↔ DM split** inside the list should be a moveable pane handle like every other split (`01KRZ84ASD`); "All threads" view must always show agent replies under each thread block (`01KRYPA6XY`).
4. **CoS message lifecycle audit** — `draft` → `queued` → `sending` → `sent` / `resolved` / `archived` must be unambiguous. "Still shows a sending spinner, pretty sure it was sent" → audit `queued`, `sending`, `draft` states end-to-end. Companion direction `01KRWH7TGZ`: when a session **bails out / silently dies** the operator should be able to point at it and say "investigate and do what it was supposed to do" — the CoS Ops agent then re-reads the parent's input, fans out a fresh implementation session, and reports back. See [[operator-inputs#install--login-vocabulary]] *bail-out / silent crash*.
5. **Brainstorm mode = mic input front and center** — the brainstorm pane explicitly captures microphone audio and (planned) screen content. The mic-bridge popup is the secure-context workaround; brainstorm UI must surface mic-select, screen-capture, and verbosity controls.
6. **Spec wiki collapsibility + mobile** — the wiki must render well on the spec page including a mobile collapsible TOC; "view spec" link must navigate; spec content must reflect *live* state, not snapshots that age into lies.
7. **Style-guide enforcement** — image lightbox transparency regression caught (2026-05-17); confirms [[style-guide#opacity-rule]] and [[style-guide#lightboxes--full-viewport-modals-sm-lightbox]] need to be the canonical pre-merge checklist for any new floating element.
8. **Overlay-mode CoS pane** — threads should default-load as overlay over the main CoS chat, not as a split panel that hides the chat. Recurring regression on this server. The new sub-direction `01KRYRFKHQ` ("drawer pull is floating but the internal overlay companion isn't visible") is a z-index regression in the popout path: `CosPopoutTreeView` portals the overlay at hardcoded `z-index: 1000` but the popout's panel z-index (`getPanelZIndex = 950 + order*2`) can climb above it. Anchor all overlay-drawer z-indices to `getPanelZIndex(panel) + 2`, the same pattern the in-pane `ChiefOfStaffBubble` already uses.
9. **Machine display in pickers (new)** — `01KRWHAT4S` "we should show the name for local to avoid confusion": the local launcher's machine row in dispatch / launcher / harness pickers must show a human-readable name (e.g. "local — propanes-vm") rather than `local` / an opaque UUID alongside named remote machines.
