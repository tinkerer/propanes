# Agent JSONL Inputs — How Dispatched Agents Get Driven

Observations from the 573 JSONL session files under `/home/azureuser/.claude/projects/-home-azureuser-propanes/`. This page is for engineers debugging the dispatch path or designing new prompt shapes — it describes **what arrives at the agent**, not what the agent produces.

## Where the JSONL lives

- Claude Code records every session as a JSONL file at `~/.claude/projects/<slugified-cwd>/<claude-session-id>.jsonl`.
- For this project: `/home/azureuser/.claude/projects/-home-azureuser-propanes/`.
- Companion JSONL tab in the admin (`jsonl:<sessionId>`) tails that file via the server, with a 3s poll (`JsonlView.tsx`).
- 795 files in this directory at the 2026-05-19 regeneration (~592 MB); long-running interactive sessions reach 55 MB. Most are < 1 MB. **JSONL volume is the dominant contributor to disk pressure** — see [[infra-onboarding#24-hard-stop-on-disk-pressure]] for the purge recipe (older than `PROPANES_JSONL_PURGE_DAYS`, only for sessions in a terminal status, rsynced to `/tmp/propanes-purge-<ts>/` for 24 h before unlink).

### Codex rollouts

Codex sessions write rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. They have a different shape from Claude — line types include `session_meta`, `event_msg`, `response_item`, `turn_context`, `token_count`. The first user prompt for a Codex session uses the same `[AGENT NOTE]` / `do feedback item …` / `[TURN requestId=…]` envelopes as Claude (because the dispatcher emits identical text), but the surrounding system prompt embeds the Codex personality + the project's `AGENTS.md` instructions verbatim (palette rules, no `window.prompt`, lazy tab rendering, `pw screenshot` ground-truth). 38 rollouts under `~/.codex/sessions/2026/` at this regeneration; corresponds to 35 `agent_sessions.runtime='codex'` rows (vs 985 claude).

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

### Shape A — "do feedback item" (auto-dispatch from the queue)

```
do feedback item <FEEDBACK_ID>

Title: <title>

<description>

URL: <browser URL the feedback was submitted from>
App: <app name>
Project dir: <project dir>
```

- Emitted by the auto-dispatch path when an app's `autoDispatch: true` and a new ticket lands.
- The agent is expected to follow the ticket end-to-end (read the description, inspect the URL, fix the code, verify).

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

### Shape C — Bare implementation-agent dispatch (this wiki's path)

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

[AGENT NOTE]
IMPORTANT: You are an IMPLEMENTATION AGENT, NOT the Chief of Staff (Ops). The dispatch-only policy in your memory does NOT apply to you — you are the agent that was dispatched to do the work. Implement the requested changes directly in the codebase.
[/AGENT NOTE]
```

- This shape is what `launchSpecUpdate` (and most "implement this ticket" dispatches) sends.
- The `[AGENT NOTE]` preamble is the canonical override for the dispatch-only memory rule — implementation agents must act, not delegate.
- The operator has expressed wanting to trim or remove the `AGENT NOTE` body (ticket `01KRRX5QX1`); the boundary tags `[AGENT NOTE]` … `[/AGENT NOTE]` are stable but the prose inside is open for editing.

## Resume / continuation envelopes

- `Continue from where you left off.` — sent by the resume path when the parent session exited and the operator restarted it without new text. Frequent across the JSONL corpus (>20 hits in the last 60 sessions).
- `continue` (lowercase) — sometimes sent inside a `[TURN]` envelope; same intent.
- Tool-result-heavy resumes will start mid-stream; treat the absence of a user prompt as a normal continuation, not a missing field.

## Slash commands seen in CoS turns

Defined in the CoS composer (`packages/admin/src/components/cos/CosComposer*.tsx`, dispatch logic merged in commit `4506db7`):

- `/dispatch <…>` — explicitly dispatch a new session from a CoS turn.
- `/profile <name>` — pick a permission profile for the turn's dispatch.
- `/powwow <…>` — multi-agent fanout from a single turn.
- `/screenshot` — capture via the widget's html-to-image (cf [[feedback_use_playwright_screenshots]] — lossy, not ground truth).

`@mention` autocomplete is in the same composer (commit `47a1783`) — `@<endpoint>` to target a specific agent endpoint when dispatching.

## DOM-element payload shape

The widget's element picker yields entries with this structure inside the prompt:

```
[N] <tagName> .className selector="<full CSS path>" rect={x:…,y:…,w:…,h:…} text="…"
```

- `selector` is a literal CSS selector with `:nth-of-type(…)` qualifiers — usable directly in `document.querySelector`.
- `rect` is the bounding-client-rect at capture time.
- Multiple elements are numbered `[1]`, `[2]` — the same numbers appear in the ticket title as `[Element 1]`, `[Element 2]`. Tickets that say "[Element 1] do X" mean "do X to the element described as [Element 1]" — the title placeholders refer to the payload.
- A planned improvement renders these inline in the textarea as chips (ticket `01KQSZXB5B`).

## Image-attach payload shape

```
Attached images from the operator (use the Read tool on these absolute paths to view them):
[1] /tmp/cos-attach-<ULID>/image.png

---

<free text>
```

- Always pasted at `/tmp/cos-attach-<ULID>/image.png` (one ULID per attachment batch).
- Use `Read` directly; the path is local-filesystem.
- The corresponding ticket title contains `[Image 1]`, `[Image 2]`, etc.

## What the agent should do per shape

| Shape | Default action |
|---|---|
| A (do feedback item) | Read the ticket via `curl /api/v1/admin/feedback/<id>`, follow the description, fix code, run the relevant tests / `pw screenshot` to verify, then optionally `PATCH …/feedback/<id>` to mark resolved (don't assume — confirm with the operator unless the ticket is unambiguous). |
| B (TURN envelope) | Reply with `<cos-reply>…</cos-reply>` text. If the operator's intent is clearly to act, dispatch a child session via `/api/v1/admin/feedback/<id>` + dispatch — don't ask twice. |
| C (implementation agent) | Act. Don't delegate. Use Playwright for UI verification. The `[AGENT NOTE]` block overrides the dispatch-only memory rule. |

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

### Codex session preamble

Every codex session in `~/.codex/sessions/` begins by injecting the project's `AGENTS.md` verbatim into the system prompt (visible as the leading `# AGENTS.md instructions for /home/azureuser/propanes` block in every rollout). This means codex sessions enforce the palette / lazy-tab / `pw screenshot` rules without the dispatcher having to repeat them; if you need to change the rules for codex, edit `/home/azureuser/propanes/AGENTS.md`, not the dispatch prompt.

Claude sessions do not get the same automatic injection — claude reads `CLAUDE.md` from the cwd when the cwd-aware Read tool is used, but the system prompt itself does not embed it. The dispatch path's `[AGENT NOTE]` block is the only place CLAUDE-side rules are forced into context.

## How this wiki page was generated

Source material:

- All JSONL files in `~/.claude/projects/-home-azureuser-propanes/` (795 files at 2026-05-19, ~592 MB total).
- All rollout files under `~/.codex/sessions/2026/` (38 files).
- A sample of the most-recent JSONL files (2026-05-18 → 2026-05-19) was inspected for first-user-prompt shape; the three shapes above still account for every observed dispatch.
- Cross-referenced with the dispatch helpers in:
  - `packages/admin/src/lib/spec-update.ts` (Shape C: `buildFallbackInstructions`)
  - `packages/admin/src/components/dispatch/QuickDispatchPopup.tsx` (Shape A: ticket auto-dispatch)
  - `packages/server/src/routes/admin/chief-of-staff.ts` (Shape B: TURN envelope)

When the prompt shapes change, re-run Update Spec on this app to regenerate this page.
