# Tickets — Deduplicated Bead Catalogue

Distilled from the **484** feedback rows for app `01KNR6HYSPE08RZJSQJG6WE1PK` plus the 917 CoS threads (62 still unsorted, none newer than 2026-05-25). Items are grouped by **theme** (matching [[spec-backbone]] sections) and split into two eras. IDs are the first 10–14 chars of each ULID — full IDs at `GET /api/v1/admin/feedback/<id>`.

Legend: `[N]` new · `[D]` dispatched · `[R]` resolved · `[Rv]` reviewed · `[A]` archived. A commit hash after a bead means the fix landed on `master`.

## Era 2: 2026-06-11 → 2026-10-19

100 rows were created in this window. 28 are repro/smoke noise (listed at the end). The remaining 72 collapse into the themes below. Nearly all were dispatched to `yolo` (claude) or `codex-yolo` as `headless-stream-yolo` sessions; a `killed` session status on a resolved ticket means the operator closed the PTY after the work landed, not that the work failed.

### Session → PR pipeline (spec §2.12)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KXFK5MBC` | 07-14 | "can we programmatically detect when a github pr is opened and add a tag to the sessions in the session list and in the session view and session header" → `2a72f6d`, `ae75035`, `800257e`. |
| [R] | `01KXGPQ3CP` | 07-14 | runtime badge (claude / codex) + "review PR <n>" quick-dispatch defaulting to the other runtime, agent still selectable → `cd7c9b0`, `0c21673`, `4fee65a`. |
| [R] | `01KY3BD6CD` | 07-21 | badges move on hover to make room for dropdown/kill → move to the thread divider, right side → `a458502`. |
| [D] | `01M33RM8BJ` | 09-22 | "show a minimum truncated section of the session title and don't bury it behind tags" → `8336199` (PR #16). Session `01M33RM8BP…` also carried PRs #306/#1301/#1258 (product repo). |
| [R] | `01M4CZ28P8` | 10-08 | collapse badges in the pane header like the sessions list so the title is clickable → `7d68020` (PR #24). |
| [R] | `01KX6QCK0D` / `01KYRMVSSV` / [N] `01KZRCAVST` / [R] `01M15TZNGC` / [N] `01M3AW8254` / [N] `01M3G370P7` | 07-10 → 09-27 | "review PR 733 / 815 / 1024 / 1108 / 1466 / 1471 [as tinkerer / zzaacckk] and approve if all looks good" — PR-review dispatches against the product repo. The three still `new` were never dispatched; treat as stale unless the operator re-raises. |
| meta | PRs #23, #21, #32 | 09-16 → 10-15 | "Require PR follow-through in initial dispatch prompts", "Require local quality checks before dispatch agents push", "Give locally spawned agent sessions an API token", codex `--no-daemon` — the contract in [[spec-backbone#6-development-contract-what-every-dispatched-agent-must-do]]. Smoke bead `01KXMNWGFX` (token-env). |

### Restart / restore and session liveness (spec §2.13, §2.2)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [D] | `01KT7RGPPJ` | 06-03 | "i came back after an evening and my sessions all seemed to be ended… this is the second time" → root cause: service restart SIGKILLing tmux; fixed by KillMode (PR #27) + Restore Queue (`806ae9b`, PR #29). |
| [D] | `01M2EV3Q9J` | 09-14 | "when we reload our computer and open propanes, we seem to have to refresh in order to type into a session" → `da0b6c1`, `e846799`. |
| [R] | `01M33KPXDG` | 09-22 | "claims session … is waiting for input, but it is not" → `067eb53` (PR #15). |
| [R] | `01KVYP3GMY` | 06-25 | waiting-for-input sessions pinned at the top in a separate list → `75fe58d`. |
| [R] | `01KW0CEC6G` | 06-25 | first spin-up in an app asks for permissions (trust prompt) and should show as waiting-for-input → `bf9115d`, `d822751`. |
| [R] | `01KYK9E700` | 07-28 | mobile "resume" spins up headless sessions; should default to yolo with a continue message → `cba4211`. |
| [R] | `01KYR5HW1B` | 07-30 | resolve button slow / not resolving → optimistic resolve + bounded kill fetch (`8988909`, `e47f5f3`). Verification beads `01KYR60AZT`, `01KYR64Z2N`, `01KYTNADK9`. |
| [R] | `01M3MV86GW` | 09-28 | all sessions unable to connect (WSS failing) → expired origin cert; alerting added via product-repo PR #1491 ([[reference_wildcard_cert_renewal]]). Follow-on idle beads: six `cert-manager: …` programmatic rows on 09-30. |
| [R] | `01KTVQCWXV` | 06-11 | `Failed to find wrapped line in text` from the claude TUI → upstream CLI bug; CLI upgraded + NFC-normalized injected input ([[project_wrapped_line_tui_crash]]). |

### PTY correctness (spec §2.4a)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KV603CP7` | 06-15 | "our pty still looks messed up, we've tried addressing this twice… properly investigate which changes caused this" → size-to-largest-viewer (`efeb115`, `13d30b3`). |
| [R] | `01KVB70BXE` | 06-17 | split view out of sync (structured view of a *different* session next to the PTY); sometimes must switch tabs to type → `645f648` ([[project_codex_jsonl_resolution]]), `0aade8b`. |
| [R] | `01KX3YC3RJ` | 07-09 | PTY doesn't size to the entire div frame → `efeb115`, later `ef21b11` (PR #17). |
| [R] | `01KXEHJE7J` | 07-13 | Cmd-C copy from PTY regressed → `4676fc0` ([[project_pty_clipboard_osc52]]). |
| [R] | `01KXFGTZQA` | 07-14 | PTY flickers / scrolls on window reload → `775f8d2`, `d84e661`, `566c37e`. |
| [D] | `01M52T831A` | 10-16 | typing in the PTY jumps focus to the structured-view input → `e144100` (PR #35, merged 10-16). Focus-guard repro bead `01M52TCQ9C` (AskUserQuestion free-text). |
| meta | PRs #11, #34 | 09-20, 10-16 | overlay redraw after idle (`754435c`), cursor blink during TUI output (`03a4859`). |

### Structured / JSONL view (spec §2.5)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KTVRBY9K` | 06-11 | "insane amount of bandwidth on the jsonl endpoint… differential updates" → `beff883`. |
| [R] | `01KTT5JBW1` | 06-11 | image reads not visible in mobile structured view. |
| [D] | `01KWG904XG` | 07-02 | no complete structured view for killed or active session on mobile → `9417e0e`. |
| [R] | `01KWNTJEDQ` | 07-04 | CoS thread companion should show structured view with a PTY dropdown → `9a96ada`. |
| [R] | `01KXFJNBQT` | 07-14 | disable Thinking by default → `e4901cb`. |
| [R] | `01KXGXYPKV` | 07-14 | markdown not rendering correctly → `6db7829`. |
| [R] | `01KY5TW8X5` | 07-22 | user bubble loses newlines → `8f2af76`. |
| [R] | `01KYRNPRC7` | 07-30 | selecting from the session list auto-splits an extra Conversation pane → `7f0ffa6`. |
| [R] | `01KZ6WMJX3` / `01KZC77Q11` | 08-04 / 08-06 | structured view missing on the per-user pod / lost after `/clear` ("check what agent-portal does") → `c5504fb`, `5c5ec0e`, NFS-run verification. |
| [N] `01M22627X7` / [D] `01M2P8CW8J` | 09-09 / 09-16 | HTTP 431 in structured view for session `01M0G23NGP…` ("we shouldn't show an error like this") → `1ec1f8c`, `e7d8430` (PR #18). Both rows can be resolved. |
| [R] | `01KYJNPAMN` | 07-27 | console flood of `…/jsonl?cursor=init 404` → `4599ad6`. |
| [D] | `01M2G953K1` | 09-14 | md companion iframe should render markdown; pane resizer loses the mouse over iframes → `0006cad`. |
| [D] | `01M3T444MA` | 09-30 | PTY + structured view should be light mode when the app is → `a053973` (PR #22). |

### Widget, composer, quick dispatch (spec §2.8, §2.19, §2.16)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KTTDZNV2` | 06-11 | new-terminal composer closes on DOM selection; "unify all of our composers, lots of redundant code" (UnifiedComposer invariant restated). |
| [R] | `01KTVQS9YD` | 06-11 | `Agent endpoint has mode "webhook" but no URL configured` on quick dispatch → `3f035d5`. |
| [R] | `01KV681WZN` | 06-15 | drag files into the composer, store in `/tmp`, copy-path option → `90c50e5`. |
| [R] | `01KVBK02FG` | 06-17 | Admin Assist composer close button → `27e8a41`. |
| [R] | `01KVBX4Y0E` | 06-17 | remember agent settings in composer and widget between runs → `a7fb101`. |
| [R] | `01KVREVZYN` | 06-22 | prompt shows derived title then the text twice → `c7b6e63`. |
| [R] | `01KX2EANAT` | 07-09 | claude yolo request dispatched to Codex instead; then "the dropdown doesn't work" → `83309ce`, `0220232`, `72fc26a`. |
| [R] | `01KX401GE1` | 07-09 | quick dispatch buttons stopped working → `125ba95`, `fd571c9` (env-admin FK). Repro beads `01KX467AZX` [N], `01KX46DP7C` [A]. |
| [R] | `01KX7MGNEG` | 07-11 | widget lost the agent picker; `#/agents` link doesn't load → `3165b65`. |
| [R] | `01KXESFWZ9` | 07-13 | drag-and-drop images/files onto PTY or structured view; warn above ~10 MB → `2845e05`, `44ce21a`. |
| [R] | `01KXS2ZC6T` | 07-17 | "close other tabs" doesn't work. |
| [D] | `01KY0GS27D` | 07-20 | widget on another app didn't show the full agent list; got a permission-asking agent instead of yolo → `fbfbec8`, `b2af82a`. |
| [R] | `01KY5W34TR` | 07-22 | "Open Session" should load the specific session; widget session list filtered to the app → `74d161f`, `cf0fc0b`. |
| [D] | `01KZW68WNQ` | 08-12 | "Open Session" before deploy didn't open; needs a loading view; 401s on feedback GET → `116d512`. |
| [R] | `01KYJMFZ6J` | 07-27 | "Validation failed" submitting via the widget → `c9fee39`; repro beads `01KYJMK49P`, `01KYJMVC74`, `01KYJN4C7V`, `01KYJNBWS1`, `01KYJNCQM2` [A]. |
| [R] | `01M21FRY2Y` | 09-08 | pasted/attached files in the quick-launch composer point at `/tmp` files that don't exist → `734034a`, `e5b2e62`, `e0815fa`. Verify beads `01M21N9YPS` and threads `01M21FZF7V`, `01M21MH1SE`, `01M21MRG0D`, `01M21MTRQ7`. |
| [R] | `01KYR5PN18` | 07-30 | CoS drawers obscure the toolbar; overlay should start below it → `05c48c0`. |

### Multi-user hosting, tenancy, deploy (spec §2.14)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KX2E97BF` | 07-09 | "Use the shared NFS checkout. The Propanes next-phase prompts are here: /mnt/stage-nfs-src/propanes-plans/{README,phase-2-ui-data-scoping,per-user-aks-pod-manifests}.md" → tenancy scoping (`7919dd4`), per-user pods (`0551cf1`, `d1c1d6d`), isolates (`53993ba`). |
| [D] | `01KXGY222N` | 07-14 | member user auto-logged-out on the per-user pod → `464f3fb`. |
| [N] | `01KX9N2C1M` | 07-11 | new window on the staging host shows no apps or sessions → `cef82be` (re-hydrate user on bootstrap). Can be resolved. |
| [R] | `01KV68F499` | 06-15 | sessions all land under CoS Inbox as sessions of one app; organize by app → `b4139c1`, `2b2ef47` (PR #7). |
| [R] | `01KV9X9GZC` | 06-17 | open port 3443 with the az CLI for SSL access. |
| [R] | `01KVSBTQFC` | 06-23 | `/` should redirect to `/admin` → `4dff9da`. |
| [R] | `01KVBJVW4V` / `01KY5T8BJR` | 06-17 / 07-22 | document title should include the location host → `38abc93`, `19e8691`. |
| [D] | `01KYB5RCRV` | 07-24 | container build failing on `linear-cli` (missing `xz`) → `d8e0fd0`. |
| [R] | `01KX400NGX` / `01KX467ZCY` | 07-09 | build/deploy container images from the platform dashboard; deploy the product repo main to a host — product-repo work driven from this app ([[reference_platform_deploy_flow]]). |
| [R] | `01M2PYR7VX` | 09-17 | "pull master and rebuild" (recurring operator dispatch). |
| [R] | `01M387TG84` | 09-23 | Cloudflare DNS shows many CNAME records — investigation, no code change. |
| [D] | `01KTTEQB2Z` | 06-11 | show all apps and sessions per machine on the Infrastructure page (like agent-portal); session list per machine as a pane option. Partially landed (`InfrastructurePage`, `bb3131b`); still open as a direction. |
| [R] | `01KX2KX51N` / `01KX72VDVP` / `01M12GRQQS` / `01M1N12TX9` | 07-09 → 09-04 | scrub internal hostnames / `amca` from comments and git history → `eac6eb9`; the orphan commit is deferred ([[project_propanes_amca_orphan_commit]]). |
| [R] | `01KV6CGPY4` | 06-15 | favicon from `.VolumeIcon.icns` → `1288b94`. |

### Flatter upstream sync (spec §2.17)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KX1SZ2PV` | 07-08 | the Flatter spec: monitor upstream (`meawoppl/agent-portal`), rank, dashboard with operator feedback, scope, do the work → `b260a5f`, `711907c`, `0169397`. |
| [R] `01KX41EZDE` / [R] `01KX6F82VE` / [R] `01KX6F82VG` / [D] `01KX6F82VH` | 07-09 / 07-10 | `[Flatter/Plan]`, `[Flatter/PR]`, `[Flatter/Review]`, `[Flatter/Verify]` lanes for "Flatter plan: 24 accepted changes" (5 critical, 3 high-risk). |
| [R] | `01KX7KZ60Q` | 07-11 | "this ui is kinda bad" → setup-assist composer for Flatter + computer-use/Playwright to examine other apps → `2538451` (partial). |

### Mobile (spec §2.6)

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KVRA1J1A` | 06-22 | mobile: ticket title on the top bar with a link back to the feedback → `9709a46`. |
| [R] | `01KVT9X6J0` | 06-23 | mobile: resolve/kill in the session-id popup menu → `5325700`. |
| [D] | `01KWG904XG` | 07-02 | (see structured view) mobile structured view incomplete → `9417e0e`. |

### CoS / threads (spec §2.3) — dormant this era

| Status | ID | Date | Summary → outcome |
|---|---|---|---|
| [R] | `01KTVYS9SN` | 06-11 | clicking the "go to chat" text should switch to the right app + channel and open the thread reply companion. Last CoS-navigation bead before the alpha gate. |
| [R] | `01KRRX5QX1` | (05-16, closed 06-11) | "we don't need the text in the AGENT NOTE" → `8632338`. |
| meta | PR #10, #12 | 09-20 | Ops chat + approvals moved behind `pw-alpha-features`. No `cos_messages` written since. |

### Non-propanes beads filed on this app

`01KXM580WQ` (Project Orion BOM-format decision, tags `WOR-133`, `needs-human`, still `new`), `01KX400NGX` / `01KX467ZCY` (product deploys), `01M4RFVMF3` ("set NSN required to false for flybrix", idle session), the six `cert-manager: …` programmatic rows (09-30). They belong to other apps or to the operator's platform work; leave them but don't derive Propanes Admin spec from them.

### Noise rows to ignore

Repro / smoke / e2e rows created by agents verifying their own fixes. Safe to archive; most already are: `01KX467AZX`, `01KX46DP7C`, `01KX4D69ZR` ("test"), `01KXMNWGFX`, `01KYJMK49P`, `01KYJMVC74`, `01KYJN4C7V`, `01KYJNBWS1`, `01KYJNCQM2`, `01KYR60AZT`, `01KYR64Z2N`, `01KYTNADK9`, `01M21N9YPS`, `01M52TCQ9C`; threads `01KTVR65H6` (`__test dispatch fallback`), `01KX46KBHP`, `01M21FZF7V`, `01M21MH1SE`, `01M21MRG0D`, `01M21MTRQ7`; idle sessions titled `test`, `hi`, `boundary repro`, `verify path-prefix fix`, `3443 test`, `__proxy header test`, `[diag A] ignore`, `final smoke`.

### Era-2 repeat clusters

| Count | Theme | Resolution |
|---|---|---|
| 6 | "review PR <n> as <account> and approve if all looks good" | Review PR quick-dispatch (§2.12); three rows still `new`. |
| 5 | "Validation failed" + repro rows | `c9fee39`; one real bead. |
| 4 | Flatter lane rows for one plan | one plan run, four lanes — count as one. |
| 3 | PTY flicker / resize / sizing | §2.4a rule set. |
| 3 | attachment paths don't exist (`/tmp`) | `734034a`, `e5b2e62`, `e0815fa`. |
| 2 | HTTP 431 structured view | `1ec1f8c`; resolve both rows. |
| 2 | document title should show host | `38abc93`, `19e8691`. |
| 2 | "structured view lost after /clear" / "not working on the pod" | `c5504fb`, `5c5ec0e`. |

### Era-2 by theme → seed tickets

| Theme | Seed tickets |
|---|---|
| Session → PR pipeline | `01KXFK5MBC`, `01KXGPQ3CP`, `01M33RM8BJ`, `01M4CZ28P8`, PRs #20/#23/#24 |
| Restart / restore | `01KT7RGPPJ`, `01M2EV3Q9J`, `01M33KPXDG`, PR #29 |
| PTY correctness | `01KV603CP7`, `01KVB70BXE`, `01KXFGTZQA`, `01KXEHJE7J`, `01M52T831A` |
| Structured view parity | `01KWNTJEDQ`, `01KXGXYPKV`, `01KZC77Q11`, `01M2P8CW8J`, `01M3T444MA` |
| Multi-user hosting | `01KX2E97BF`, `01KXGY222N`, `01KX9N2C1M`, `01KV68F499` |
| Attachments | `01KV681WZN`, `01KXESFWZ9`, `01M21FRY2Y` |
| Flatter | `01KX1SZ2PV`, `01KX41EZDE`, `01KX7KZ60Q` |
| Widget agent picker / open session | `01KX2EANAT`, `01KX7MGNEG`, `01KY0GS27D`, `01KY5W34TR`, `01KZW68WNQ` |
| Hygiene | `01KX2KX51N`, `01M12GRQQS`, `01M1N12TX9` |

## Era 1: 2026-04-09 → 2026-06-10

The catalogue below is preserved from the 2026-05-19 / 2026-06-11 regenerations. Statuses were not re-verified row by row this time; counts referred to 373 rows and 718 threads at that snapshot. The 62 unsorted threads listed under "Unsorted threads" are unchanged — nothing new has been left unsorted since 2026-05-25. Still-`new` era-1 beads worth keeping in view: `01KRRZVJVB` (DOM-selection chip closes composer), `01KRRYNKV3` (`pw-` prefix on copied id), `01KRKQXM69` (YOLO label), `01KRKQWQRQ` (overlay default), `01KQCZQJJ0` (auto-restart YOLO), the brainstorm/mic family, and the Slack/amirobot family.

### Repeat clusters (≥2 occurrences)

| Count | Theme | Status | Tags |
|---|---|---|---|
| 4 | "mobile widget is launching YOLO dispatches but not skipping permissions, and I don't see the option in this widget" (`01KPW680GR`, `01KPW6805R`, `01KPW67Z7T`, `01KPW67Y26`) | dispatched | — |
| 4 | FAFO Setup Assistant — "Interactive assistant for creating and managing FAFO swarms and wiggum runs" (`01KP2GF9TS`, `01KP2GF7V6`, `01KP2GF6R9`, `01KP2GF60X`) | new | `fafo`, `assistant` |
| 3 | Update Spec Wiki — Propanes Admin (this generation: `01KRT5YS24`, `01KRT5Y0PP`, `01KRT50NS5`) | dispatched | `spec-wiki` |
| 2 | Auto-restart closed sessions in interactive-YOLO mode (`01KQCZQJJ0`, `01KQCZPCV5`) | new + dispatched | `auto-restart`, `automation`, `session-lifecycle`, `yolo-agents` |
| 2 | Fix microphone input in Chief of Staff view | new + dispatched | `mic-bridge`, `microphone`, `voice-captured` |
| 2 | Add logging verbosity control checkbox | new | `brainstorm-mode`, `logging` |
| 2 | Slack: "how many sessions are we running now" (status queries from `amirobot`) | new | `slack`, `amirobot` |

Dedup principle for repeat clusters: the 4 mobile-widget tickets are the **same submission fired four times** — count them as one report, not four data points.

### Feedback by surface

#### CoS / Chief of Staff

| Status | ID | Summary |
|---|---|---|
| [D] | `01KRWK14649ZVCRYE91PHAJW8W` | (2026-05-18) "instead of jumping to the thread in the chat it is closing the chat and it doesn't even reload when i close and reopen from the button" — regression of `01KRVWS4V3VFM7` thread-tap-jump rule. |
| [D] | `01KR4Z71Q3` | Channel list as left companion of the CoS panel; channels/agents/threads vary by selected app. |
| [D] | `01KRACMHC3` (thread) | "Let's make channels actually work. Per-app chat workspaces. Sort existing threads into channels. A CoS workspace spans all apps." Channel tap must reload main chat, not open a sub-panel. |
| `01KRA1QGHC22JA` (thread) | Toggle channel list open/close; mobile too cluttered. Agents are DMs in the channel list, not parallel tabs. |
| `01KRZ84ASD` (thread) | (2026-05-19) "Make the split between channels and direct message moveable like all our other panes." — apply the standard pane-split-divider handle to the channel-list ↔ DM split inside CoS. |
| `01KRZ7WMZ8` (thread) | (2026-05-19) Tapping a terminal-session thread in the CoS thread list should render the terminal as a term screen in-chat (not just navigate away). Extends the channel-tap rule to terminal companions. |
| `01KRYPA6XY` (thread) | (2026-05-18) "the tickets sessions when they are showing up in the 'All threads' chat view should also show the agent replies in a thread" + "our composers should always result in a feedback and a session." Anchor for the **composer-always-feedback-and-session** invariant; fix lives in `cos-inbox.ts::mintFeedbackThread` linking dispatched feedback + thread + replies. |
| [D] | `01KRT6EKC3AKM7` | CoS pane still doesn't enter overlay mode on this server — threads should default-load as overlay over the chat, not split. |
| [N] | `01KRKQWQRQ` | Regression: thread loads as split panel rather than overlay panel. Restore overlay behavior. Tags: `chief-of-staff`, `regression`, `ui-layout`. |
| [D] | `01KQN83H7T` | Fix CoS followup dispatcher: grouped queued messages never fire when assistant turn ends without parsable text. Tags: `bug`, `cos`, `followups`, `pending`. Targets thread `01KQGVQ8N9MCY9` + 6 others. |
| [D] | `01KQGWKF0R` | Stale agent-session `status='running'` after resume → CoS "Sending…" sticks. Root cause in `session-service.ts ~459-467` (spawn-resume writes completion fields without clearing prior). Tags: `bug`, `cos`, `session-lifecycle`. |
| [D] | `01KQRKM4PF` | Dragging the CoS hamburger `button.btn-close-panel.cos-hamburger-draggable` immediately pops the pane out. Should dock like any other pane. |
| [R] | `01KQQVCHPY` | Close panel X should remove floating docked panel, not just close the drawer (drawer handle already exists). |
| [D] | `01KQN8S67B` | Pop-out thread tabs AND artifacts. |
| [R] | `01KQN83K0P` | "Show full message" should be default in CoS. |
| [D] | (`01KRRZVJVB`) | Clicking items closes the composer — should not lose DOM selection. |
| (`01KRJDHV3R` thread) | scroll-down button in non-CoS views too. |
| `01KRVVGJGRDGRS` (thread) | Thread disappears when dragged out as outside companion on `?embed=cos` standalone window — cannot bring it back. Allow it, but shrink main chat so both fit. |
| `01KRVWS4V3VFM7` (thread) | Clicking a channel/session-thread item should jump to that thread in the chat. |
| `01KRVV9FJ2CT6T` (thread) | After refresh, first-load CoS chat takes too long to restore prior state. |
| `01KRVV09PCN031` (thread) | "Sending" spinner sticks though message was sent. Full audit of `queued`/`sending`/`draft`/`sent` states. |
| various | Composer drafts persist per-thread + survive refresh — `01KQ87JWAG`, `01KR4R8P58` (cross-machine dispatch), `01KQ8F18DY`. |
| (`01KQDDJR3B` thread) | Multi-way draft sync across windows. |
| (`01KQ2VMRA5` thread) | "Ops" (desktop) vs "Chief of Staff" (mobile) — unify the user-visible name. |

#### Dispatch / Composer

| Status | ID | Summary |
|---|---|---|
| [D] | `01KRT5ZY3D` | Update Spec button should launch a composer for additional direction and default to YOLO. |
| [N] | `01KRKQXM69` | Rename "do it" button to **YOLO** to align with the permission profile vocabulary. Tags: `dispatch`, `labeling`, `ui`, `voice-captured`, `yolo-button`. |
| [D] | `01KRC5D754` | Dispatch dialog is bad: don't present options as buttons; composer should match the prompt widget (model + mode separately). |
| [D] | `01KR5M1C0B` | New session composer must persist across close and survive refresh. |
| [D] | `01KRQKBNAJ` | `qdp-panel` entries don't persist; should survive restart. (Partially fixed by `50bf6d3` for dispatch type + agent selection.) |
| [R] | `01KR4ABCD9` | Modal widget for dispatch should match the same composer used in CoS + prompt widget (DOM and screenshot attachments). |
| [D] | `01KRRX5QX1` | "We don't need the text in the AGENT NOTE." |
| [R] | `01KR4R8P58` | Dispatching to a different machine must clarify the machine has the app and adjust the path in the prompt. |

#### Sessions / lifecycle

| Status | ID | Summary |
|---|---|---|
| [D] | `01KRWH7TGZ` | (2026-05-18) "our session here died can you investigate and then do what it was supposed to do" — anchor ticket for the **bail-out recovery dispatch** pattern. Ops should read the dead parent's input, fan out a fresh implementation session, report back. See [[operator-inputs#install--login-vocabulary]] *bail-out / silent crash*. |
| [D] | `01KRWHAT4S` | (2026-05-18) "we should show the name for local to avoid confusion" — local launcher row in machine/launcher pickers must show a human-readable name (e.g. "local — propanes-vm") next to named remote machines, not just `local`. |
| [N] | `01KQCZQJJ0` / [D] `01KQCZPCV5` | Auto-restart closed sessions in interactive-YOLO mode so output keeps generating new tickets without manual intervention. |
| [D] | `01KR26EW9D` | Branch a resumed session — option to distill learnings into an agent (e.g., distill sessions `01KQT642A8` + `01KR2395YS` into Nexar API / Document Explorer expert agents). |
| [D] | `01KRRYNKV3` | Copy-session-id action should include the `pw-` tmux prefix. |
| [R] | `01KR4R56D6` | Remote session on the operator's MacBook Air fails to deliver the structured / jsonl view. |
| (`01KRBZMXVS` thread) | Post-reboot, all session statuses are wrong; needs reconciliation. |
| (`01KR1V3FNNN9` thread) | Status-of-all-running-sessions query is a recurring CoS ask. |

#### Panes / popouts / companions

| Status | ID | Summary |
|---|---|---|
| `01KRYRFKHQ` (thread) | (2026-05-19) "our drawer pull is floating but the internal overlay companion isn't visible." Z-index regression in `CosPopoutTreeView`: overlay portaled at hardcoded `z-index: 1000`, but `getPanelZIndex = 950 + order*2` can climb past it; the in-pane `ChiefOfStaffBubble` already anchors to `getPanelZIndex(panel) + 2`. Apply the same pattern to popout/`FloatingCompanionSplit`. |
| (`01KRMYB54Z` thread) | Bug: dragging the drawer-pull hamburger on the right edge of a CoS companion no longer converts between docked-external and overlay-internal. |
| (`01KR4N78WP` thread) | Z-indexing of the companion overlay drawer + handle + resize bars throughout admin. |
| (`01KQSZKXC2` thread) | Companion drawer should be resizable; the handle should allow resize. |
| (`01KQ0Y87X3` thread) | Z-indexing broken on resize bars + popouts; Ops popout can't come to front. |
| (`01KQB2GXP3` thread) | Floating-drawer-handle ghost when closing the drawer. |
| (`01KQBPXYDF` thread) | Get rid of `cos-thread:main` tab. |
| various | Popout/tab dropdown menus must match. |

#### JSONL / Structured / Split

| Status | ID | Summary |
|---|---|---|
| [D] | `01KQT0CB78` | When struct mode has an open tool and JSONL updates, must not collapse open tools or scroll — just append. |
| (`01KQ___` thread) | We seem to default to `struct` vs `term`; the toggle should only be there for [certain] sessions. |
| (`01KQ___` thread) | Yolo session with structural output mislabeled "struct" at the top selector. |
| (`01KQ___` thread) | JSONL view needs to collapse down more and be viewable in a small footprint. |
| [R] | `01KRSFA2MM` | Persist filter pill settings on the structured view. |
| [D] | `01KRSH1917` | Mobile structured view needs an inline composer + stop button. |
| [R] | `01KR4CKB6Z` | Unify struct view ↔ CoS bubble — same component, different style; struct/split is "just a companion split panel" rendering the JSONL. |
| (`01KQB2NXDC` thread) | Clicking "see session log" should show struct view by default. |

#### Widget / element picker / DOM

| Status | ID | Summary |
|---|---|---|
| [D] | `01KQSZXB5B` | Selected DOM elements show as literal `[Element 1]` in textarea; should render inline as chips that expand on click (matching the CoS chat rendering). Opt-in mode for testing. |
| [N] | `01KRRZVJVB` | Clicking the DOM-selection chip closes the composer; should preserve selection. |
| (`01KQ___` thread) | CoS DOM selector should not exclude the CoS pane itself. |
| [R] | `01KRRZREQB` | Favicon → propane-tank icon from the Tauri build. |
| [R] | `01KRRF2DYV` | Large typing-to-display lag in PTY; browser session also freezes. |
| [R] | `01KRQH6YEX` | "Validation failed" from the feedback widget. |
| [R] | `01KRQFW2NJ` | Review PR #187; specifically question `deployment/docker_compose/docker-compose.box-dev.yml`. |
| [R] | `01KQDBMYMG` | New widget composer glitches and disappears on admin-options load; toolbar should be separate icons with dropdowns, not a popup expand. |

#### Mobile

| Status | ID | Summary |
|---|---|---|
| (`01KRA5W61X` thread) | Composer not visible on mobile; last message scrolls off the bottom. |
| (`01KR___` thread) | Chief of staff agent lane doesn't open on mobile anymore. |
| (`01KQ3HDYMB` thread) | On mobile, CoS chat scrolls horizontally — must not. |
| (`01KQ3HF8PH` thread) | On mobile, sometimes drag the window behind a popped-out CoS. |
| (`01KQ1FM7Z1` thread) | Mobile CoS Stop on bottom-right (operator can submit from anywhere). |
| (`01KQ5GADDD` thread) | Widget not visible on bottom-right of admin on mobile. |

#### Brainstorm mode + microphone input (channel: `brainstorm-voice`)

This is the active theme cluster — brainstorm is **microphone-first**, with screen capture as a co-equal channel and a verbosity gate so the bridge logs don't drown the operator.

| Status | ID | Summary |
|---|---|---|
| [N] | `01KQ5AQH6` | Fix microphone input in Chief of Staff view — should work in CoS without forcing operator into the brainstorm pane. |
| [D] | `01KQ5APJPV` | Add microphone input to Chief of Staff view (paired with `01KQ5AQH6`). |
| [D] | `01KQ3AEJQD` | "The mic bridge is failing. I can't see any debug messages because it closes and probably isn't logging anything." → log to server endpoint, not console-only. |
| [D] | `01KQ0YZSYP` | Mic-in-new-window via postMessage — "Mic requires HTTPS, this page is loaded over HTTP" still showing. Verify the bridge popup is reachable from this code path. |
| [N] | `01KQ9DH52M` | Add screen-capture capability to the mic bridge (alongside mic input). |
| [R] | `01KQ9DGJSJ` | Extend mic Bridge to also function as a screen-capture bridge (unified interface). |
| (`01KQ7Y0HR6` thread) | Mic bridge isn't selecting which mic to use → mic-select dropdown required. |
| [N] | `01KQ58YSBY` / `01KQ58YYPG` / [D] `01KQ58Z32C` | Add logging verbosity control checkbox for brainstorm mode. Default off; toggle for debugging. |
| [N] | `01KQ5B3S55` | Make brainstorm pane movable and consistent with other panes (no special-cased fixed corner). |
| [N] | `01KQ5B2BC4` | Gesture-based region selection (draw oval, crop) for brainstorm screenshots. |
| [D] | `01KQ5AWH40` | Categorize brainstorm sessions into hierarchy in the admin session list (not flat). |
| [D] | `01KQ5AY0EB` | Add thinking/processing indicator when brainstorm engine is chunking → developing a plan → analyzing. |
| [N] | `01KQ5AZA1H` | Show tool usage and feedback traceability in CoS dispatch flow: (1) feedback being created, (2) dispatch steps, (3) which tools the chunker chose. |
| [D] | `01KQ5AT3WH` | Three-in-one: widget visible in bottom-left when it shouldn't be; paste screenshots directly into brainstorm view; DOM-interaction tracking follow-up. |
| [Rv] | `01KQ57A0BJ` | Brainstorm should start on the mic icon press, **not** when the checkbox is ticked. Widget ends up bottom-left in brainstorm mode. |
| [D] | `01KQB43NSJ` | `.pw-cc-toggle-bar` (Brainstorm pill) renders unconditionally — should only show when brainstorm mode is on. Fix in `packages/widget/src/widget.ts:866` (renderBrainstormPill). |
| [R] | `01KPQ0BPXP` | "Why can't we serve through HTTPS?" — for mic mode. Cloudflare-fronted prod can; local dev uses the popup bridge ([[project_mic_bridge_popup]]). |
| (`01KQ7Y4SSZ` thread) | Continuous screenshots in live session — is there a toggle? |

#### Infrastructure & onboarding (channel: `general-ops` / `session-ops` / new `infra-onboarding` area)

See [[infra-onboarding]] for the full spec. These are the beads that motivate it.

| Status | ID | Summary |
|---|---|---|
| [D] | `01KRWHGWN0` | "our session manaer needs to monitor for situations like when we need to login to claude. we should have a better automatic approach that detects this and loads a pty session for the login flow." → generalize `claude-auth-detect.ts` cross-runtime (claude + codex). Anchor ticket for the infra theme. |
| ref | DOM fragment in `ed44f872-…jsonl` (2026-05-17) | *"we ran out of disk space and everything froze. how do we p…"* — incident that motivates the hard-stop @ 95 % disk + cleanup recipes ([[infra-onboarding#24-hard-stop-on-disk-pressure]]). |
| thread | `01KRBZMXVS` | "we just recovered from a reboot, the propanes sessions' status are all wrong" → reboot reconciliation invariant ([[infra-onboarding#25-reboot-reconciliation]]). |
| thread | `01KQT66F04` | "having issues updating codex with npm update -g @openai/codex" → assistant's durable EACCES advice (sudo vs `~/.npm-global` prefix) becomes the body of the **Install / Update Codex** card. |
| [R] | `01KPRZTK45` | "add codex agent options for our dispatch. i have a tmux pw-… which you can send the install command and i can login." Pattern: install + login through an operator-controlled tmux. |
| [R] | `01KRRYPDJT` | "use tmux session pw-… and install the az cli." Same pattern as above for an arbitrary CLI. |
| [R] | `01KNW7R9XP` | "install linear mcp, on this machine so we can connect our agents to the linear tickets." |
| [R] | `01KRT4SNGT` | Auto sign-out and redirect to sign-in when sessions fail to sync — don't require operator refresh. (Existing implementation; cross-referenced as the parent of the auth-detection theme.) |
| [R] | `01KRMWWSG9` | "lets commit and push our current propanes setup, i think my computer has a better version of the CoS companion thread logic, and i'll fix that up then push there too." → multi-machine handoff pattern. |
| [R] (×9) | `01KRMWWSG9`, `01KR5KHBQK`, `01KR4QT3GF`, `01KQXAM8BD`, `01KQRKHFAX`, `01KQ0SNPCJ`, `01KPKNE6RW`, `01KPH78A1R`, `01KP70SP1P`, `01KP6TXF4V` | "commit and push" / "pull and merge and push" — recurring dispatch pattern. Collapse into a `/push` CoS slash command. See [[infra-onboarding#43-pushing-prs-back-to-upstream]]. |
| [R] | `01KRQFW2NJ` | "review PR #187, suggest any improvements and changes, be thorough. firstly, i don't think we need this: deployment/docker_compose/docker-compose.box-dev.yml" — PR-review flow operator wants from CoS. |

#### Authentication / generic infra

| Status | ID | Summary |
|---|---|---|
| [D] | `01KRT4SNGT` | Auto sign-out and redirect to sign-in when sessions fail to sync — don't require operator refresh. (Also referenced above.) |
| (`01KQB2GXP3` thread) | Console errors batch — AgentTerminal errors, 404s, 143 errors in CoS sessions. |
| various | `prompt-widget.js:1574 POST .../api/admin/search 500` — investigate. |

#### Spec wiki itself (channel: `spec-wiki`)

| Status | ID | Summary |
|---|---|---|
| [D] | `01KRT55AG2` | "Clicking view spec doesn't seem to work." |
| [D] | `01KRT5ZY3D` | Update Spec button should launch a composer for additional direction and default to YOLO. |
| [D] | `01KRQKVAY6` | The Aggregate button becomes **Update Spec**: convert beads (tickets/threads) to a spec by consuming JSONL agent inputs that led to which fixes — durable artifact, not a dump. |
| [D] | `01KRVESWPQXFTA` | Spec content must reflect *current* truth — past-future-tense fragments ("Aggregate button is being repurposed") should read as completed statements when the rename has shipped. |
| [D] | `01KRVEN9ZZ` | Make the spec pages collapsible so they read well on mobile (each H2 a `<details>` element). |
| [D] | `01KRTA5ZK5WB63` | Don't scroll the spec to the top when a new CoS message arrives in the embedded chat above. Independent scroll containers. |

#### FAFO / swarm / multi-agent (related family, may be a separate app)

| Status | ID | Summary |
|---|---|---|
| repeat ×4 | FAFO Setup Assistant. |
| [D] | various | FAFO v2 (auto fan-out, aggregate-with-feedback, filter into wiki, meta-manager); per-app FAFO swarm page; tree count visibility; companion JSONL 404 for fafo run `01KP2V7H0SV7QF…`; meta-wiggum evolution into Fan-out / Aggregate / Filter / Optimize swarm orchestrator. |

#### Slack / amirobot

| Status | ID | Summary |
|---|---|---|
| repeat ×2 | "Slack: how many sessions are we running now." |
| various | Slack-launched sessions should auto-yolo; link back to propanes; status queries about other apps; recurring `Failed to dispatch: Propanes /api/v1/admin/feedback/<id>` from slackbot. |

### Dedup notes

- "Composer" complaints span widget, dispatch dialog, CoS, ticket detail — they all resolve to **the same UnifiedComposer must be used everywhere**. Treat new "composer is bad" tickets as instances of that one invariant.
- "Drawer / overlay / split / popout" complaints all stem from the pane state machine: docked-external ↔ overlay-internal ↔ popped-out window. Most tickets target one transition; the bug usually lives in the handle drag logic.
- Mobile regressions cluster on a few selectors: composer offscreen, horizontal scroll, widget position. Test those three on each mobile-affecting PR.
- The 4×4-ticket dupes in repeat clusters are mostly accidental multiple submits — count as one.

### Unsorted threads

53 CoS threads have no `channel_id` at this regeneration. The newest below are the active operator direction that hasn't been routed yet — most should land in `inbox` or one of the theme channels. Sorting them is a one-time clean-up.

| Thread ID | First line | Likely channel |
|---|---|---|
| `01KRZ84ASD` | "Make the split between channels and direct message moveable like all our other panes." | cos-chat |
| `01KRZ7WMZ8` | "when we try to load terminal session from the CoS threads list… should load as a term screen in the chat here." | cos-chat / thread-panes |
| `01KRYRFKHQ` | "our drawer pull is floating but the internal overlay companion isn't visible." (z-index in CosPopoutTreeView) | thread-panes |
| `01KRYPA6XY` | "ticket sessions in the All threads view should also show agent replies in a thread" + "composers should always result in a feedback and a session" | cos-chat |
| `01KRWC6EAE0CMY` | "The channel drawer hamburger should be inline with the tools / search options…" | cos-chat |
| `01KRWC68V10C93` | (dupe of above) | cos-chat |
| `01KRVZR96TF8J2` | "clicking on the thread divider should load the thread in CoS view" | cos-chat |
| `01KRVWS4V3VFM7` | "clicking on these should jump to that thread in the chat" | cos-chat |
| `01KRVVGJGRDGRS` | embed=cos thread disappear when moved to outside companion | cos-chat |
| `01KRVV9FJ2CT6T` | post-refresh CoS chat too slow to restore state | cos-chat |
| `01KRVV32EKABX5` | image lightbox has bad modal transparency — update style guide | spec-wiki |
| `01KRVV09PCN031` | "sending" spinner stuck; audit queued/sending/draft | composer-drafts |
| `01KRVTR7Q329FA` | All sessions should appear as threads in CoS pane | general-ops |
| `01KRMYB54Z` | drawer-pull hamburger drag broken on companion right edge | thread-panes |
| `01KRJDHV3R` | scroll-down button in other views | thread-panes |
| `01KRBZMXVS` | post-reboot session statuses all wrong | session-ops |
| `01KRACMHC3` | channels actually work; per-app workspaces; CoS workspace spans all | general-ops |
| `01KRA5W61X` | composer not visible on mobile, last message scrolls off bottom | mobile-ux |
| `01KRA1S9RA` | composer ghost overwrite | composer-drafts |
| `01KRA1QGHC22JA` | toggle channel list; mobile too cluttered; agents as DMs | mobile-ux |
| `01KR4N78WPSE3M` | z-indexing of companion overlay drawer + handle + resize bars | thread-panes |
| `01KR1V3FNNN9NS` | "what's the status of all our running agent sessions?" | session-ops |
| `01KQZDZ5WB` | "seems like we aren't loading admin correctly" | session-ops |
| `01KQT66F04` | trouble updating codex with npm | session-ops |
| `01KQT618FK` | Tauri spotlight popup for the widget | tauri-desktop |
| `01KQSZKXC2` | companion drawer should be resizable; handle should allow resize | thread-panes |
| `01KQGVQ8N9` | pending sending messages still hanging | composer-drafts |

### By theme

Quick map from active theme → primary channel → seed tickets. Use this when picking up work.

| Active theme (from [[index#active-themes]]) | Channel | Seed tickets |
|---|---|---|
| Infrastructure & onboarding | `general-ops` / `session-ops` (new `infra-onboarding`) | `01KRWHGWN0`, `01KQT66F04`, `01KRBZMXVS`, `01KRMWWSG9`, `01KRRYPDJT`, `01KPRZTK45`, `01KNW7R9XP` |
| Session ↔ thread unification | `general-ops` / `sessions` / `cos-chat` | `01KRVTR7Q3`, `01KRVWS4V3VFM7`, `01KRWK14649ZVCRYE91PHAJW8W`, `01KRYPA6XY`, `01KRZ7WMZ8` |
| Channels actually working | `general-ops` / `cos-chat` | `01KRACMHC3`, `01KRA1QGHC22JA`, `01KR4Z71Q3`, `01KRWC6EAE`, `01KRZ84ASD` |
| CoS message lifecycle audit | `composer-drafts` | `01KRVV09PCN031`, `01KQGVQ8N9`, `01KQGWKF0R`, `01KQDDJR3B` |
| Bail-out recovery dispatch | `session-ops` | `01KRWH7TGZ` |
| Brainstorm + mic | `brainstorm-voice` | `01KQ5AQH6`, `01KQ3AEJQD`, `01KQ9DH52M`, `01KQ58YSBY` |
| Spec wiki mobile + truth | `spec-wiki` | `01KRVEN9ZZ`, `01KRVESWPQXFTA`, `01KRTA5ZK5WB63`, `01KRT55AG2` |
| Style-guide / lightbox opacity | `spec-wiki` | `01KRVV32EKABX5` |
| Overlay-mode default / z-index | `thread-panes` / `cos-chat` | `01KRT6EKC3AKM7`, `01KRKQWQRQ`, `01KRYRFKHQ` |
| Machine display ("local" name) | `session-ops` | `01KRWHAT4S` |

### How this list is maintained

This file is regenerated by the Update Spec flow (`packages/admin/src/lib/spec-update.ts::launchSpecUpdate`). When a ticket appears here that's already fixed, prefer **resolving** the underlying ticket via `PATCH /api/v1/admin/feedback/<id>` rather than editing the wiki — the next regeneration will reflect the new status.
