# Agent JSONL Inputs — How Dispatched Agents Get Driven

Observations from the JSONL session files under `/home/azureuser/.claude/projects/-home-azureuser-propanes/` and the Codex rollouts under `~/.codex/sessions/`. This page is for engineers debugging the dispatch path or designing new prompt shapes — it describes **what arrives at the agent**, not what the agent produces.

Last regenerated 2026-10-19. Since the June regeneration the dispatch prompt changed shape twice (`DEFAULT_PROMPT_TEMPLATE` with API-access line and inline attachments; the trailing hint grew into the full development contract), and two new envelopes appeared (the restore-queue prompt and the "You are resuming a task" continuation).

## Where the JSONL lives

- Claude Code records every session as a JSONL file at `~/.claude/projects/<slugified-cwd>/<claude-session-id>.jsonl`.
- For this project: `/home/azureuser/.claude/projects/-home-azureuser-propanes/`.
- Companion JSONL tab in the admin (`jsonl:<sessionId>`) tails that file via the server, with a 3s poll (`JsonlView.tsx`).
- **19 files (43 MB) at the 2026-10-19 regeneration**, down from 795 files / 592 MB in May — the purge recipe in [[infra-onboarding#24-hard-stop-on-disk-pressure]] has been applied, so only September–October sessions survive locally. The largest is 10 MB (`4294954c-…`, the HTTP 431 investigation). Historical prompts for June–August are recoverable only through `agent_sessions.output_log` and the Codex rollouts.
- `jsonl_continuations` (server table) maps a session to its continuation files when claude rolls over; the launcher scans continuations without the control-plane DB (`274bac2`).

### Codex rollouts

Codex sessions write rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. They have a different shape from Claude — line types include `session_meta` (with `payload.cwd`, `cli_version`, `base_instructions`), `event_msg`, `response_item`, `turn_context`, `token_count`. The first user prompt for a Codex session uses the same `do feedback item …` envelope as Claude (the dispatcher emits identical text; the legacy `[AGENT NOTE]` preamble was removed 2026-06-11 and the last rollouts carrying it are dated that day), but the surrounding system prompt embeds the Codex personality + the project's `AGENTS.md` instructions verbatim (palette rules, no `window.prompt`, lazy tab rendering, `pw screenshot` ground-truth).

265 rollouts were written since 2026-06-11 (26 Jun / 137 Jul / 15 Aug / 41 Sep / 46 Oct); only **16** have `cwd=/home/azureuser/propanes` — the rest are workbench and dashboard work. The 16 propanes rollouts map to the `codex-yolo` dispatches in [[tickets#era-2-2026-06-11--2026-10-19]] (favicon, `/` → `/admin` redirect, agent-portal/Flatter, hostname scrub, review PR 815, structured view after `/clear`, stale waiting indicator). Codex TUI now runs with `--no-daemon` so `PROPANES_TOKEN` reaches it (PR #32).

### Other line types in Claude JSONL

Beyond `user` / `assistant` / `system`, the recent corpus also contains:

- `queue-operation` — the operator's queued turn while a parent session was mid-stream. The body is the same text that arrives as the next `user` line; treat the duplicate as expected (don't dedup or you lose the timing record).
- `permission-mode` — a permission profile transition; emitted on session start and on `/profile` slash command.
- `file-history-snapshot` — claude internal; can be ignored when summarizing the session.
- `attachment` — wraps the inline DOM-selection or image-attach payload that the `user` line references.
- `ai-title` — claude's auto-generated short title for the session.

When pulling the operator's first instruction, scan for the first `user` (or `queue-operation`) line whose `content` matches one of the three dispatch shapes; everything before it is preamble.

When debugging a dispatch path, check both `~/.claude/projects/.../<sessionId>.jsonl` and `~/.codex/sessions/...` — `agent_sessions.runtime` tells you which to expect.

**Auth-detection caveat:** the existing `claude-auth-detect.ts` only handles claude login output. Codex sessions today silently fail when the user isn't logged in; the spec answer is to generalize cross-runtime — see [[infra-onboarding#32-install--update-cards]] and [[infra-onboarding#62-cross-runtime-auth-detection-sketch]].

## Three dispatch shapes

Every prompt sent to an agent fits one of three shapes. Recognizing the shape tells you what subsystem queued it.

### Shape A — "do feedback item" (queue dispatch; the dominant shape)

Current form (`DEFAULT_PROMPT_TEMPLATE` in `packages/server/src/dispatch.ts`, as seen in every September–October JSONL):

```
do feedback item <FEEDBACK_ID>

`div.xterm-screen:nth-of-type(1)` `input.conv-input-bar-input` <description text> /tmp/<ULID>.png
URL: https://<host>/admin

App: Propanes Admin
Project dir: /home/azureuser/propanes
App description: The propanes admin dashboard itself. Full-stack feedback overlay + agent session bridge with Preact SPA dashboard.

(Implement directly. If this task generates code or docs changes: … <development contract> … wrap a 1–4 sentence summary … in <cos-reply>…</cos-reply> tags; only wrapped text reaches the Inbox thread.)
```

What changed since June:

- The `Title:` line that duplicated the description is gone (`c7b6e63`, ticket `01KVREVZYN`).
- `[Element N]` placeholders are expanded **inline** to back-ticked CSS selectors; `[Image N]` placeholders become `/tmp/<ULID>.png` paths you can `Read` directly. Composer uploads appear under `Attachments:` / `Attached files (read from these local paths if you are on the server host):` with a download URL fallback.
- Depending on the dispatch path the prompt may start with `Feedback: <url>` and an `API access:` line that spells out the `PROPANES_TOKEN` / `PROPANES_API_URL` curl; both env vars are preset in the session either way.
- `Sub-app:` appears when the app declares monorepo sub-apps (`resolveSubApp`); the cwd is then `<projectDir>/<dir>`.
- The trailing parenthetical is `COS_REPLY_DISPATCH_HINT` — now the full development contract (§6 of [[spec-backbone]]), appended once; the server never double-appends it.
- Emitted by the quick-dispatch popup, the widget's send menu, auto-dispatch (`autoDispatch: true`), Flatter lanes, and the Update Spec fallback.

### Shape B — `[TURN requestId=…]` envelope (CoS-originated dispatch)

```
[TURN requestId=<uuid>]

<operator text or selected DOM elements summary>
```

Variants observed:

- **Plain text:** `[TURN requestId=…] What's the status of all our running agent sessions?`
- **DOM-attached:** `[TURN requestId=…] Selected DOM elements (from the operator's browser): [1] <button> .cos-scroll-down-btn selector="…" rect={x,y,w,h} [2] <div> …` followed by free-text instruction.
- **Image-attached:** `[TURN requestId=…] Attached images from the operator (use the Read tool on these absolute paths to view them): [1] /tmp/cos-attach-<ULID>/image.png  ---  <text>`.

This is the standard envelope when a turn fires from the CoS composer or from the widget pointing at a CoS thread. The `requestId` matches `cosThreads.turnRequestId` and is used by `/threads/:id/events` to demux replies.

### Shape C — "You are working on <App>" (feedback-template dispatch)

```
You are working on <App Name>.

App description: <desc>

The user reported feedback from their browser session at <URL> (viewport <wxh>).

Title: <title>
Description: <desc>
Console logs: …
Network errors: …
Custom data: …
Tags: …

Additional instructions:
<instructions>

The prompt-widget server is at <URL>. The browser session may still be live — you can interact with it via the agent API.

Available hooks the app exposes: [...]

(Implement directly. When done, wrap a 1–4 sentence summary — changed files/commits, what you verified, follow-ups — in <cos-reply>…</cos-reply> tags; only wrapped text reaches the Inbox thread.)
```

- Still emitted by some paths (seen 2026-09-14 → 09-22 for `01M2EV3Q9J`, `01M2PYR7VX`, `01M2P8CW8J`, `01M33RM8BJ`), with empty `Console logs:` / `Network errors:` / `Custom data:` / `Tags:` blocks when the ticket came from a bare composer. Treat it as Shape A with a different preamble.
- The `[AGENT NOTE]` preamble was removed 2026-06-11 (ticket `01KRRX5QX1`): the dispatcher appends only the trailing `COS_REPLY_DISPATCH_HINT` (`dispatch.ts`), preserving the `<cos-reply>` protocol. Historical JSONL/threads still contain the old block; the admin UI strips both formats via `lib/dispatch-boilerplate.ts`.
- This regeneration's own prompt (JSONL `e71c6179-…`) is the Update Spec variant: "Create or update the spec wiki for application Propanes Admin (…)" + required files + sources to inspect + the contract.

### Shape D — Restore-queue resume (new, PR #29)

```
This conversation was interrupted by a propanes service restart, not by you finishing or giving up.
Before doing anything else, check the current state of your task (git status/log, open PRs, deployed services, whatever applies) to find out what actually happened while you were down.
- If the task is already fully complete, say so briefly and stop. Do not redo finished work.
- If it is partially done, resume precisely from the interruption point, re-verifying any step that was in flight when you were killed.
- If it was never started, proceed normally.
```

- Sent through `resumeAgentSession()` with `--resume <claudeSessionId>`; the parent's permission profile is kept. The operator-edited variant seen in `7fae0026-…` on 2026-10-12 named the restart time ("~18:45 UTC") and listed concrete things to check.
- A session that answers with a usage/billing wall is **not** a successful restore; the queue tells them apart.

### Shape E — "You are resuming a task that a previous agent session worked on but did not fully complete" (Codex continuation)

- Seen in Codex rollouts on 2026-07-02 and 2026-08-07. The body is the **previous session's PTY output**, truncated and full of ANSI escapes (`[K`, `[38;5;231m`), followed by "The user wants you to continue making progress." Strip control sequences before reasoning about it; the real instruction is in the operator's next line (e.g. "still seems like an issue after a claude compaction").

## Resume / continuation envelopes

- `Continue from where you left off.` — sent by the resume path when the parent session exited and the operator restarted it without new text (still present, e.g. `454b0a79-…` 2026-09-22).
- `continue` (lowercase) — sometimes sent inside a `[TURN]` envelope or bare; same intent. User-facing Resume on a headless parent now spawns `interactive-yolo` with this message (`cba4211`).
- Shape D (restore queue) and Shape E (Codex "resuming a task") above are the restart-specific variants.
- Tool-result-heavy resumes will start mid-stream; treat the absence of a user prompt as a normal continuation, not a missing field.

## In-session follow-ups the operator actually types

From the 19 local JSONL files and the 16 propanes Codex rollouts. These arrive as plain `user` lines mid-session and are the operator's real acceptance criteria:

| Follow-up | Meaning for the agent |
|---|---|
| `commit and push` / `commit and push to master` / `commit and push to main` / `awesome commit this change … and lets push all the changes too` | Land it now. Since PR #23 the expected form is branch + PR; if the operator explicitly says "to master", do what they say and note it. |
| `did we commit and push to master?` | The operator checks; answer with the commit hash or PR URL. |
| `merge it` | Approval granted on the PR you opened (seen for PR #35). Merge via `gh pr merge` and confirm. |
| `fix the defect` (after a review dispatch) | The reviewer found something; switch from reviewing to fixing in the same session. |
| `now handle the remote launcher case too` | The local fix is accepted; extend it to the launcher path before closing. |
| `do i need to restart the server for this to take effect or will it work now?` | Say exactly which process must restart (`propanes-sessions.service` vs main server vs admin dist) — see [[reference_session_service_restart]]. |
| `pull master, rebuild admin` / `rebuild admin` | Deploy on the host the ticket URL names. |
| `ok fetch and reset hard plz` | The operator fixed the branch elsewhere; discard local state. |
| `can the SHA be found publicly` / `completely remove these refs from our git history please` | History-scrub questions; answer factually about `git log --all`, reflogs, and the public remote before rewriting anything. |
| `i built admin and clicked on Flatter but nothing happened` / `now the dropdown doesn't work` | Regression report on your own change; reproduce with Playwright before answering. |
| `set up alerting for cert-manager renewal failures, anyway to make this automatic?` | Scope expansion inside an incident; acceptable, deliver it in the same PR or a linked one and say which. |
| `why " Greetings, fellow tinkerer."` | The operator noticed an odd greeting from the Codex personality; cosmetic, answer briefly. |
| `<task-notification> … Monitor event: "CI checks on workbench PR #1491" … </task-notification>` | Harness-generated lines from `Monitor` / background tasks, not operator text. Act on them only if the event changes what you'd do next. |
| `[Image: original 3024x1702, displayed at 2000x1126 …]` | The harness echo of an image you `Read`; not an instruction. |

## Slash commands seen in CoS turns

Defined in the CoS composer (`packages/admin/src/components/cos/CosComposer*.tsx`, dispatch logic merged in commit `4506db7`):

- `/dispatch <…>` — explicitly dispatch a new session from a CoS turn.
- `/profile <name>` — pick a permission profile for the turn's dispatch.
- `/powwow <…>` — multi-agent fanout from a single turn.
- `/screenshot` — capture via the widget's html-to-image (cf [[feedback_use_playwright_screenshots]] — lossy, not ground truth).

The CoS composer is behind `pw-alpha-features` since 2026-09-20, so these commands are rarely seen in the recent corpus; the quick-dispatch composer (Shape A) is the live path.

`@mention` autocomplete is in the same composer (commit `47a1783`) — `@<endpoint>` to target a specific agent endpoint when dispatching.

## DOM-element payload shape

Two generations coexist in the corpus.

**Current (Shape A, since mid-2026):** the selectors are inlined into the description as back-ticked CSS paths in the order the operator picked them, e.g.

```
`div.pane-leaf.pane-leaf-focused > div.terminal-active-header:nth-of-type(2)` collapse the badges in the header …
`span.iframe-companion-url` `iframe.iframe-companion-frame` when loading a companion iframe that is an md file …
```

Use them directly with `document.querySelector` via `pw eval`; `:nth-of-type` qualifiers are literal.

**Legacy (`[TURN]` envelopes and 2026-04/05 tickets):** the widget's element picker yields entries with this structure inside the prompt:

```
[N] <tagName> .className selector="<full CSS path>" rect={x:…,y:…,w:…,h:…} text="…"
```

- `selector` is a literal CSS selector with `:nth-of-type(…)` qualifiers — usable directly in `document.querySelector`.
- `rect` is the bounding-client-rect at capture time.
- Multiple elements are numbered `[1]`, `[2]` — the same numbers appear in the ticket title as `[Element 1]`, `[Element 2]`. Tickets that say "[Element 1] do X" mean "do X to the element described as [Element 1]" — the title placeholders refer to the payload.
- A planned improvement renders these inline in the textarea as chips (ticket `01KQSZXB5B`).

## Image / file attachment payload shape

**Current (Shape A):** `[Image N]` placeholders are replaced inline by `/tmp/<ULID>.png` (one ULID per image, e.g. `/tmp/01M4CZ28PAX0PX07SY9RCE496W.png`), and composer uploads are listed as

```
Attachments:
/tmp/01M21FRYG2RP3JRW87CBWWGPCP.png: /tmp/01M21FRYG2RP3JRW87CBWWGPCP.png
```
or
```
---
Attached files (read from these local paths if you are on the server host):
- /tmp/<ULID>-<original name> (download: https://<host>/api/v1/uploads/<ULID>)
```

- The server symlinks composer uploads into `/tmp` (`734034a`) and ships them to remote launchers before launch (`e0815fa`, `e5b2e62`), so the path should exist wherever you run. If it doesn't, that is itself a bug class (ticket `01M21FRY2Y`); fall back to the download URL with `PROPANES_TOKEN`.
- Use `Read` on the path to view it; the harness echoes `[Image: original WxH, displayed at …]` afterwards.

**Legacy (`[TURN]` envelopes):**

```
Attached images from the operator (use the Read tool on these absolute paths to view them):
[1] /tmp/cos-attach-<ULID>/image.png

---

<free text>
```

- Pasted at `/tmp/cos-attach-<ULID>/image.png` (one ULID per attachment batch); the ticket title carries `[Image 1]`, `[Image 2]`, etc.

## What the agent should do per shape

| Shape | Default action |
|---|---|
| A (do feedback item) | Read the ticket via `curl /api/v1/admin/feedback/<id>`, follow the description, fix code, run the relevant tests / `pw screenshot` to verify, then optionally `PATCH …/feedback/<id>` to mark resolved (don't assume — confirm with the operator unless the ticket is unambiguous). |
| B (TURN envelope) | Reply with `<cos-reply>…</cos-reply>` text. If the operator's intent is clearly to act, dispatch a child session via `/api/v1/admin/feedback/<id>` + dispatch — don't ask twice. |
| C (implementation agent) | Act. Don't delegate. Use Playwright for UI verification. A dispatch-shaped prompt (feedback template + trailing `<cos-reply>` hint) overrides the dispatch-only memory rule. |
| D (restore queue) | Inspect state first (`git status`, `gh pr list`, deployed services), then stop / resume / start as the prompt says. Never redo finished work. |
| E (Codex continuation) | Strip ANSI from the quoted output, find the original ticket via `agent_sessions.feedback_id`, continue. |

For every shape since PR #23: finish with a PR, monitor it, and report the PR URL in the `<cos-reply>`.

## Common attachments seen in implementation prompts

- Project root: `/home/azureuser/propanes`.
- The operator often references specific session IDs (`01KQT642A8`, `01KR2395YS`, `01KQGVFKK2`) — these are valid for `curl /api/v1/admin/agent-sessions/<id>` and indicate the operator wants you to inspect that session, not invent one.
- Tmux session id for an interactive session is `pw-<sessionId>` — useful for `tmux attach -t pw-<id>` and for `tmux capture-pane -p -t pw-<id>`.

## Long-reply handling

- Tmux PTY width is 120 cols by default. Long stream-json fragments wrap and can fail `JSON.parse`, which is the cause of the long-reply drop ([[project_cos_long_reply_drop]]).
- When verifying CoS output, prefer the JSONL recording at `~/.claude/projects/.../<claudeSessionId>.jsonl` over the wire log — the JSONL has the un-wrapped content.

## Notable artifacts observed in this corpus

### Disk-space incident captured as DOM text

The first-user prompt in `~/.claude/projects/-home-azureuser-propanes/ed44f872-f6f2-4afd-be45-e7aa66169523.jsonl` (2026-05-17) contains a DOM-selection payload where the captured `text="…"` reads:

> `we ran out of disk space and everything froze. how do we p…`

The operator was looking at a previous CoS thread describing the freeze when they grabbed the DOM for the current ticket ("add the option to the thread toolbar to load the session view"). The fragment is the only record of that incident — no dedicated feedback row exists, because the box was unusable at the time. The incident motivates the disk-pressure spec in [[infra-onboarding#24-hard-stop-on-disk-pressure]].

### Service-restart interruption (2026-10-12)

`7fae0026-…` (ticket `01M3T444MA`, light-mode PTY) was interrupted by an unplanned `propanes.service` restart at ~18:45 UTC and resumed with a Shape D prompt. The resumed session found its PR #22 already merged and reported that instead of redoing the work — the behavior the restore prompt is written to produce.

### Focus-guard repro recipe (2026-10-19)

`182ce1ad-…` is a throwaway session (`01M52TCQ9C`) whose whole prompt is: call `AskUserQuestion` once with a free-text question, wait, then again with options. It exists to reproduce the "typing in the PTY jumps to the structured input" bug (`01M52T831A`) and the `inputState` keystroke flap ([[project_input_state_keystroke_flap]]). Keep it as the canonical repro when touching auto-focus.

### HTTP 431 investigation

`4294954c-…` (10 MB, the largest local file) is the `01M2P8CW8J` session: the structured view's GET carried the whole cursor set in headers for a very long session. Outcome: POST cursors (`1ec1f8c`) with GET fallback (`e7d8430`). The file is a good example of a transport bug presenting as a rendering bug.

### Codex session preamble

Every codex session in `~/.codex/sessions/` begins by injecting the project's `AGENTS.md` verbatim into the system prompt (visible as the leading `# AGENTS.md instructions for /home/azureuser/propanes` block in every rollout). This means codex sessions enforce the palette / lazy-tab / `pw screenshot` rules without the dispatcher having to repeat them; if you need to change the rules for codex, edit `/home/azureuser/propanes/AGENTS.md`, not the dispatch prompt.

Claude sessions do not get the same automatic injection — claude reads `CLAUDE.md` from the cwd when the cwd-aware Read tool is used, but the system prompt itself does not embed it. The dispatch path's trailing `COS_REPLY_DISPATCH_HINT` line is the only dispatcher-forced instruction in CLAUDE-side context (the old `[AGENT NOTE]` block was removed 2026-06-11).

## How this wiki page was generated

Source material:

- All 19 JSONL files in `~/.claude/projects/-home-azureuser-propanes/` at 2026-10-19 (43 MB; first three `user` / `queue-operation` lines of each inspected).
- All 265 rollout files under `~/.codex/sessions/` newer than 2026-06-11, filtered to the 16 with `cwd=/home/azureuser/propanes`.
- `agent_sessions` rows since 2026-06-11 (192 for this app) for titles, profiles, `pr_urls`, and launcher ids; `feedback_items` descriptions for the pre-expansion form of each prompt.
- Earlier corpora (May 2026) as summarized in the previous regeneration; shapes A–C were confirmed still present, D and E are new.
- Cross-referenced with the dispatch helpers in:
  - `packages/admin/src/lib/spec-update.ts` (Shape C: `buildFallbackInstructions`)
  - `packages/admin/src/components/dispatch/QuickDispatchPopup.tsx` (Shape A: ticket auto-dispatch)
  - `packages/server/src/routes/admin/chief-of-staff.ts` (Shape B: TURN envelope)
  - `packages/server/src/dispatch.ts` (`DEFAULT_PROMPT_TEMPLATE`, `COS_REPLY_DISPATCH_HINT`) and `packages/server/src/restore-queue.ts` (`DEFAULT_RESTORE_PROMPT`)

When the prompt shapes change, re-run Update Spec on this app to regenerate this page.
