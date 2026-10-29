# Propanes Admin — Spec Wiki

**App ID:** `01KNR6HYSPE08RZJSQJG6WE1PK`
**Project dir:** `/home/azureuser/propanes`
**Server:** `http://localhost:3001` (admin at `/admin/`, widget embedded on the admin page itself)
**Wiki dir:** `/home/azureuser/propanes/docs/spec-wiki/01KNR6HYSPE08RZJSQJG6WE1PK`
**Last regeneration:** 2026-10-19 (previous: 2026-06-11, 2026-05-19, 2026-05-17)

This wiki is the durable specification distilled from tickets, CoS thread inputs, and agent JSONL histories. It is the **bead → spec** companion to the live ticket queue — tickets are the beads, this is the rolled string.

## What Propanes Admin is

The Preact SPA dashboard at `packages/admin/` that drives the propanes operator workflow:

- Triage incoming **feedback** (manual widget submissions, programmatic error reports, voice captures, Slack/amirobot, Flatter lanes).
- Run **agent sessions** (Claude Code / Codex, interactive TUI or headless stream-json) against a registered application's project directory, locally, on remote launcher machines, or in per-user AKS pods.
- Follow each session through to a **merged PR**: PR URLs are detected from the transcript, shown as badges, and the dispatch contract tells the agent to keep working until CI is green and the PR is approved.
- Inspect live conversations as PTY / structured / split views, type into the PTY, drag files and images into the session, and intervene mid-turn.
- Recover from host restarts: orphaned sessions land in a **restore queue** and are resumed with a prompt that tells the agent to re-check state before redoing work.
- Stay in dialog with a **Chief of Staff (CoS / "Ops")** agent that knows the queue and can dispatch on the operator's behalf (now an **alpha feature**, off by default).
- Pop panes out into separate windows, dock companions, and drive everything from a phone-sized viewport when needed.
- Run **multi-user**: org-scoped admins, per-user isolated workspaces, path-prefixed mounts behind an SSO gate, and a `propanes` CLI with `propanes://` handler and SSH gateway for terminal access.

## Wiki pages

- **[spec-backbone.md](spec-backbone.md)** — the durable product surface: invariants, primary surfaces, data flow rules, UI conventions, and the **development contract** every dispatched agent must follow. Read this first when picking up new work.
- **[style-guide.md](style-guide.md)** — color tokens, opacity rules for floating overlays, portal/containing-block rules, palette, and a checklist for any new popup/modal/lightbox. Read this before touching anything that floats over other content. The 2026-09-19 neutral-surface refresh and light-mode parity work extend it (see [[spec-backbone#215-theme-light-mode-and-pty-colors]]).
- **[infra-onboarding.md](infra-onboarding.md)** — infrastructure health checks (disk, CLI presence, login state, version drift) and the contributor onboarding path (fresh box → running propanes → PR back to upstream). `scripts/setup.sh` (one-command bootstrap, 2026-09-03) and the first-run `GettingStartedPage` now implement the bootstrap half.
- **[tickets.md](tickets.md)** — deduplicated catalogue of operator tickets grouped by theme and era, with status and ULIDs preserved.
- **[operator-inputs.md](operator-inputs.md)** — recurring operator preferences, vocabulary, and recurring patterns of feedback (what the operator keeps asking for and why).
- **[agent-jsonl-inputs.md](agent-jsonl-inputs.md)** — how dispatched agents actually get driven: the current `DEFAULT_PROMPT_TEMPLATE`, the trailing dispatch contract, the restore-queue prompt, `[TURN requestId=…]` envelopes, attachment payloads, and the follow-up patterns seen in JSONL and Codex rollouts.

## Snapshot of the queue (at wiki generation, 2026-10-19)

- **Feedback rows for this app:** 484 total — 306 `resolved` (275 manual + 10 programmatic + 21 request), 127 `dispatched`, 39 `new`, 10 `archived`, 1 `reviewed`, 1 `deleted`. 100 rows were created since the 2026-06-11 regeneration; 28 of those are throwaway repro/smoke rows (see [[tickets#noise-rows-to-ignore]]).
- **Open items worth action:** of the 39 `new`, only 3 are real and recent (`01M22627X7` HTTP 431 structured view — since fixed by `1ec1f8c`; `01M3AW8254` / `01M3G370P7` PR-review requests for the product repo). The remaining `new` rows are April–May beads (brainstorm/mic, FAFO, Slack) that have aged out of the active themes. `dispatched` rows whose session is `killed` are usually done; the status just never got flipped.
- **CoS threads:** 917 total — 628 auto-mirrored in `sessions`, 138 in `inbox`, 62 **unsorted** (none new since 2026-05-25), the rest spread over the theme channels. 167 threads were created since 2026-06-11, all of them either `inbox` tickets or `sessions` mirrors. **No new assistant replies** have been persisted to `cos_messages` since 2026-06-11 — the CoS chat was gated behind the alpha-features preference on 2026-09-20 and is effectively dormant.
- **CoS messages:** 1,155 stored across all threads for this app (107 since 2026-06-11, all `user` role).
- **Agent sessions on this server:** 1,739 total — 1,506 `claude` (437 completed / 581 killed / 279 failed / 153 deleted / 46 idle / 10 running), 233 `codex` (18 completed / 166 killed / 37 failed / 7 deleted / 5 running). 631 created since 2026-06-11; 192 of those are tied to this app (135 `headless-stream-yolo`, 42 `plain` terminals, 14 `interactive-require`, 1 `interactive-yolo`). 203 sessions carry detected `pr_urls`.
- **Registered endpoints:** 9 (see [[spec-backbone#4-agents-and-permission-profiles]]); new since June: `Claude Interactive` (`01M21MQRNEBZ9QNR85D5Z52D6N`, `interactive-require`).
- **Machines:** a shared dev VM, a staging VM, a laptop launcher, and a hosted deployment.
- **Local JSONL session files:** 19 under `/home/azureuser/.claude/projects/-home-azureuser-propanes/` (43 MB) — the JSONL purge recipe from [[infra-onboarding]] has run; 795 files / 592 MB were here in May. 265 codex rollouts under `~/.codex/sessions/` since 2026-06-11, 16 of them with `cwd=/home/azureuser/propanes`.
- **Host disk:** `/` is **463G / 495G (94 % used)** on a larger disk than in May. Still inside the amber band per [[infra-onboarding#24-hard-stop-on-disk-pressure]]; the DB file alone is 582 MB.
- **Upstream repo:** `git@github.com:tinkerer/propanes.git`, 36 PRs merged (#1 on 2026-06-21 → #36 "Add MIT license" on 2026-10-17). **No GitHub Actions workflows exist in the repo and `master` is not branch-protected**, so "CI" for this app is the local `pnpm lint` / `pnpm build` / `pnpm test` trio.

## How to regenerate this wiki

```bash
# From the admin UI: open the Spec Wiki page for this app, click "Update Spec".
# Or, equivalently, POST a programmatic feedback row tagged spec-wiki and dispatch it.
```

The dispatch helper lives at `packages/admin/src/lib/spec-update.ts::launchSpecUpdate`. It calls `api.updateSpec` first and falls back to creating a `programmatic` feedback row + dispatch with `buildFallbackInstructions`. It prefers a YOLO profile (`interactive-yolo` → `headless-yolo` → `headless-stream-yolo`). This regeneration ran as session `01M590XNV0WD23…` on `interactive-yolo` from feedback `01M590XNTY4N4P50MEA6T83ABW`.

## Active themes (at this regeneration)

The June–October 2026 era shifted the product from "CoS chat + panes" toward **sessions-as-PR-pipeline, multi-user hosting, and resilience**. See [[spec-backbone]] for the durable definitions and [[tickets#era-2-2026-06-11--2026-10-19]] for the beads.

1. **Session → PR pipeline** — every dispatched session is expected to end in a reviewed, merged PR. PR URLs are detected from the transcript (`ae75035`), shown as collapsible badges in the sidebar, pane header, and Cmd-K search; badges can be added/removed by hand (`154e57f`); a "Review PR" quick-dispatch spawns a cross-runtime reviewer (`cd7c9b0`). The dispatch hint now carries the full **development contract** (run CI-equivalent checks locally, open a PR, monitor CI/reviews until approved — `f744578`, `d8c29cf`, `fadf72c`). Anchor tickets `01KXFK5MBC`, `01KXGPQ3CP`, `01M33RM8BJ`, `01M4CZ28P8`.
2. **Restart / restore resilience** — sessions orphaned by a `propanes.service` restart are marked `failed / orphaned_restart`, surfaced on a **Restore Queue** page, and resumed with `DEFAULT_RESTORE_PROMPT` (`806ae9b`, PR #29). Pairs with the stale-waiting-indicator fix (`067eb53`), dead-socket detection (`da0b6c1`), and "keep a pane typable when its PTY is not live yet" (`e846799`). Anchor tickets `01M2EV3Q9J`, `01M33KPXDG`, `01KT7RGPPJ`.
3. **PTY correctness in shared/multi-viewer panes** — the longest-running bug family this era: flicker on reload (`775f8d2`), laggy resize (`d84e661`), size negotiation across viewers (`ef21b11`, `13d30b3`, `efeb115`), cursor jump in smaller viewers (`eb19ca5`), overlay redraw after idle (`754435c`), cursor blink during TUI output (`03a4859`), input-bar focus steal (`e144100`, PR #35), OSC 52 copy (`4676fc0`). Spec answer in [[spec-backbone#24a-pty-sizing-and-focus-rules]].
4. **Structured view parity** — default view for CoS thread companions and interactive threads (`9a96ada`), markdown fixes (`6db7829`, `8f2af76`), hide Thinking by default (`e4901cb`), survive `/clear` and compaction (`c5504fb`, `5c5ec0e`), HTTP 431 on long sessions fixed by POST + GET fallback (`1ec1f8c`, `e7d8430`), light-mode parity (`a053973`, PR #22). Anchor tickets `01KWNTJEDQ`, `01KXGXYPKV`, `01KZC77Q11`, `01M2P8CW8J`, `01M3T444MA`.
5. **Multi-user hosting** — multi-user login + org scoping (`865d82c`, `2f888d0`), per-user isolated workspaces and self-service AKS pods (`409e64d`, `0551cf1`), per-session isolates & metering (`53993ba`), `PROPANES_BASE_PATH` + path-prefixed admin/widget (`8a4e6d6`, `f667eea`, `af5bb9f`), IP allowlist to drop the SSO gate (`281ac43`), env-admin seeding so FK-guarded writes survive (`fd571c9`), NFS run mode for pods (`4db7f9c`, `88ec365`). Anchor tickets `01KX2E97BF` (phase prompts on NFS), `01KXGY222N`, `01KX9N2C1M`.
6. **Attachments everywhere** — composer file uploads with copy-path (`90c50e5`), drag-and-drop onto PTY and structured panes (`2845e05`), paste images into session panes + remote-launcher file transfer (`44ce21a`, `e0815fa`), `/tmp` symlinks so dispatch paths always exist (`734034a`, `e5b2e62`). Anchor tickets `01KV681WZN`, `01KXESFWZ9`, `01M21FRY2Y`.
7. **Flatter upstream sync** — a monitor → plan → implement → review → verify lane system for pulling features from upstream repos such as `meawoppl/agent-portal` (`b260a5f`, `711907c`, `0169397`, `2538451`). One run, three plans, one monitor exist in the DB. Anchor tickets `01KX1SZ2PV`, `01KX41EZDE`, `01KX6F82VE/VG/VH`, `01KX7KZ60Q`.
8. **CLI + terminal access** — `propanes` CLI with `propanes://` handler, SSH gateway, kubectl-exec bridge, portal SSO device-flow login, browser-assisted login, auto-tunnel (`148fac1`, `0654b6f`, `ccb1855`, `9aeed13`, `7325832`, `ee0f670`).
9. **Alpha gating and quieter defaults** — Ops chat and Review approvals sit behind `pw-alpha-features` (`da4cff2`, `292cf35`); widget Auto-dispatch is sticky (`4cbce07`); Thinking hidden by default; Quick Dispatch panel resizable (`da6545a`) and anchored to the `[+]` button; sidebar app filters default on (`d5b0282`).
10. **Security hygiene** — container CVE sweeps (`857881a`, `4c709e8`, `4c5cc6c`, `d3752eb`), Node 22 pin (`2c3fabc`), scrubbing internal hostnames from comments/history (`01KX2KX51N`, `01M12GRQQS`, `01M1N12TX9` — the `amca` orphan commit is deferred; see [[project_propanes_amca_orphan_commit]]).

Themes carried forward from the previous era that remain valid but are **no longer actively moving**: session ↔ thread unification, channels, CoS message lifecycle audit, brainstorm/mic, Tauri desktop, Slack/amirobot, FAFO swarm. Their spec text stays in [[spec-backbone]]; their open beads are listed under [[tickets#era-1-2026-04-09--2026-06-10]].
