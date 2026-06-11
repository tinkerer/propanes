# Operator Inputs — Vocabulary, Patterns, Preferences

Distilled from CoS thread inputs, ticket descriptions, and JSONL session preambles. This is *how the operator talks about the system* — keep it consistent.

## Vocabulary (use these terms, in this sense)

| Term | Meaning |
|---|---|
| **YOLO** | A permission profile that passes `--dangerously-skip-permissions` (claude) / `--dangerously-bypass-approvals-and-sandbox` (codex). The operator-facing button label is **YOLO**, not "do it" (ticket `01KRKQXM69`). |
| **Bead** | A single ticket or CoS thread. Comes from Steve Yegge's "Beads for agent orchestration." The operator literally said: "I think of our Tickets/Threads (CoS chat inputs) like beads…" (ticket `01KRQKVAY6`). |
| **Spec** | The durable string of beads (this wiki). The Aggregate button becomes Update Spec — converting beads to spec. |
| **Companion** | A pane attached to another pane as a drawer overlay or sibling split. Six types: jsonl/feedback/iframe/terminal/isolate/url. |
| **Drawer** | Overlay-style companion with a grab handle. Hamburger (☰) on the right edge converts docked-external ↔ overlay-internal. |
| **Popout** | A pane opened in a new browser tab/window. State must mirror the source pane. |
| **Channel** | A workspace bucket for CoS threads, per-app. Slack-shaped. |
| **Ops / Chief of Staff** | The same agent. System-prompt name is **Ops**; user-facing chrome should also say Ops (mobile shows Chief of Staff — needs unifying). |
| **CoS bubble** | The floating chat puck that expands into the CoS conversation surface. |
| **bail-out / silent crash** | Heuristic: `status=completed`, `exitCode=0`, `outputBytes<5000`, `completedAt − startedAt < 2s`. Ops should detect and offer to rerun. |
| **brainstorm mode** | A **microphone-first** mode of the widget. Operator presses the mic icon (or the pill-overlay "record" button), speaks, and the audio is routed through the mic bridge into the CoS queue as chunks/threads. Screen capture is a co-equal channel. Has its own logging-verbosity issues. Default activation is a deliberate gesture — *not* a checkbox tick. |
| **mic bridge** | A `window.open` popup that hosts a secure-context `getUserMedia()` capture and `postMessage`s audio back to the widget. Workaround for non-HTTPS dev / cross-origin iframe contexts. See [[project_mic_bridge_popup]]. |
| **FAFO** | The multi-agent swarm orchestrator. Fan-out / Aggregate / Filter / Optimize. Has its own setup assistant and per-app swarm page. |
| **the widget** | `prompt-widget.js`, the embeddable JS feedback overlay. Embedded on the admin page itself for dogfooding. |
| **[Element N] / [Image N] / [Image 1]** | Placeholders in ticket bodies for attached DOM selections / pasted images. These are **part of the ticket data**, not noise to strip. |

## Install / login vocabulary

The operator's mental model for environment failures and contributor setup:

| Term | Meaning |
|---|---|
| **"need to login"** | A CLI (`claude` / `codex` / `gh`) has lost its auth and the next spawn will hit an interactive prompt. Spec answer: detect via PTY output regex and spawn a sibling `interactive-require` login companion. See [[infra-onboarding#33-login-terminal-lifecycle]]. |
| **"session manaer"** (sic) | The operator's term for the propanes session-service + dispatch path. When they say "the session manaer should monitor X," they mean **infra-side detection wired into the spawn/stream loops**, not a separate UI page. |
| **"commit and push" / "pull and merge and push"** | A recurring dispatch the operator fires when wrapping a session — usually expects the agent to handle the staged + unstaged diff, write a sensible message, and `git push`. Collapses into the `/push` CoS slash command per [[infra-onboarding#43-pushing-prs-back-to-upstream]]. |
| **"the box" / "my computer" / "azstaging" / "azstaging2"** | The operator works across multiple machines; each is its own checkout. Code moves between them via git, never via DB sync. See [[infra-onboarding#44-multi-machine-handoff]]. |
| **"YOLO terminal"** | A tmux session the operator opens themselves and hands the agent (`pw-<sessionId>`) so the agent can run privileged installs (sudo, az login, codex login) without propanes mediating. Pattern from `01KPRZTK45`, `01KRRYPDJT`, `01KNW7R9XP`. |
| **"ran out of disk"** | Literal disk-pressure incident. The 2026-05-17 freeze was the trigger for the hard-stop @ 95 % spec ([[infra-onboarding#24-hard-stop-on-disk-pressure]]). |
| **"our session here died, investigate and do what it was supposed to do"** | The bail-out recovery dispatch (`01KRWH7TGZ`, 2026-05-18). The operator points at a dead parent session; CoS Ops should read the parent's `output_log` + originating ticket, restate the goal, and fan out a fresh implementation session linked via `parent_session_id`. See [[spec-backbone#22-agent-sessions--dispatch]]. |
| **"show name for local"** | The local launcher row in dispatch/launcher/harness pickers must carry a human-readable label alongside named remote machines (`01KRWHAT4S`). When the operator says "local" they mean the labelled propanes VM, not an opaque sentinel. |
| **"clean up" / "purge"** | The cleanup recipes in [[infra-onboarding#64-cleanup-recipes-called-from-the-disk-pressure-modal]] — JSONL trim, SQLite WAL checkpoint, docker prune. None should auto-fire; surface them as one-click buttons in the disk-pressure modal. |
| **"propanes setup"** | Synonym for the bootstrap path in [[infra-onboarding#41-one-shot-bootstrap-script]]. Operator-facing artifact: `scripts/bootstrap.sh`. |

## Recurring instructions to agents

These came up repeatedly in the operator's prompts; they are the operating manual the operator wants agents to follow.

### "Don't ask, build"
- "How do I get you to just implement stuff and not ask questions? I'd be happy to…" (`01KQB4QXGK`).
- Preference: build 2–3 versions in parallel worktrees and let the operator pick from working code instead of presenting options up-front ([[feedback_implement_dont_ask]]).
- For dispatch from CoS: "When the operator's intent is clearly to act ('fix X', 'rerun Y', 'restart bailouts', 'take care of it', 'go ahead'), dispatch — don't ask for a second round of confirmation. Only pause when the request is genuinely ambiguous or would fan out 5+ sessions at once." (Ops system prompt.)

### "Don't speculate from thin signal"
- Truncated title + no screenshot is not a bug report; investigate the session or report back ([[feedback_thin_signal]]).

### "Don't narrate tool calls"
- No "Bash ok" preamble. Just run them ([[feedback_no_bash_ok]]).

### "Use Playwright for UI verification"
- Widget html-to-image lies; `pw screenshot` / `pw-vnc screenshot` is ground truth ([[feedback_use_playwright_screenshots]]).

### "Rename scope = admin UI + hash routes only"
- "Rename X throughout propanes" doesn't include API or DB or widget contracts ([[feedback_rename_scope]]).

### "Implementation agents act; CoS chat dispatches"
- A dispatch-shaped prompt (feedback template + trailing `<cos-reply>` hint) overrides the dispatch-only rule for implementation agents ([[feedback_dispatch_only]]); the old `[AGENT NOTE]` preamble was removed 2026-06-11.

## Feedback patterns to expect

Most submitted tickets fall into one of these shapes:

1. **DOM-attached UX bug.** Title starts with `[Element 1]`, ends with a fix preference. Example: `[Element 1] this dialog is bad, don't present options like these buttons.`
2. **Image-attached visual bug.** Title has `[Image 1]`. Image at `/tmp/cos-attach-<ULID>/image.png` referenced in the JSONL preamble.
3. **Recurring spec wish.** Operator restates an invariant — composer-must-persist, channel-list-as-companion, Ops-name-unification. Treat as confirmation of an existing spec line, not a new request.
4. **Long-form direction.** Multi-paragraph thread input describing an architectural shift (e.g., "propanes needs to be a more unified system… jsonl/struct view are equivalent to CoS rendering"). These are the genuinely-new direction; quote them in the relevant `spec-backbone` section.
5. **Status query from Slack.** "How many sessions are we running now," "what's the status of the workbench admin console." Route via `amirobot` → CoS Ops, which queries the API.
6. **Programmatic error report.** From the widget or another app's instrumentation. Auto-dispatched per app's `autoDispatch` flag.
7. **Voice-captured.** Tags include `voice-captured`. Text was transcribed from mic-bridge; expect missing punctuation and run-on phrasing.

## Recurring complaints to expect

These are signals that **a known invariant has regressed** — go check the relevant section of [[spec-backbone]] before opening a new investigation:

- "Composer is bad / glitches / disappears / pops up unexpectedly" → UnifiedComposer regression.
- "Drawer / overlay / handle / popout is broken" → pane state-machine regression.
- "Mobile is broken" → composer-offscreen / horizontal-scroll / widget-position.
- "Yolo isn't actually skipping permissions" → `pickYoloAgent` or session-service flag-passing regression ([[reference_session_service_restart]]).
- "Sending… is stuck" / "messages twice" → CoS turn lifecycle or stream-output double-write ([[feedback_no_curl_post_replies]], [[project_cos_long_reply_drop]]).
- "Sessions show wrong status after reboot" → session-status reconciliation.
- "Mic doesn't work" → secure-context / iframe issue, use the popup bridge ([[project_mic_bridge_popup]]).
- "Mic bridge closes before logging anything" → popup is dying before logs flush; route bridge logs to a server endpoint and add a session keep-alive toggle.
- "Channels don't actually work / tapping a channel doesn't reload the chat" → channel-tap reloads main chat (not a sub-panel). Verify `cos_threads.channel_id` is being read by the main chat view.
- "Sessions and threads are confusingly separate" → unify via the `sessions` channel that mirrors `agent_sessions` rows.
- "Spec wiki is unreadable on mobile" → each H2 must be collapsible (`<details>` element), TOC pinned at top under 768px.
- "Image lightbox is see-through" → `.sm-lightbox` backdrop must be `#0b1220`, portaled to `document.body`. See [[style-guide]].
- "Claude/Codex stopped working" / "session died with no output" → check `claude --version` / `codex --version` and the auth-detection wire ([[infra-onboarding#3-cli-lifecycle-install-login-update]]). The session may need login, not a code fix.
- "Disk is full" / "everything is frozen" → the host crossed the disk-pressure threshold. Check `df -h /`, run the cleanup recipes; the spec answer is the hard-stop in [[infra-onboarding#24-hard-stop-on-disk-pressure]].
- "How do I get propanes running on a new box" → see [[infra-onboarding#41-one-shot-bootstrap-script]]; do not improvise install instructions.
- "Push back to upstream" / "open a PR" → `/push` and `/pr` CoS slash commands; the fork-and-PR flow is in [[infra-onboarding#43-pushing-prs-back-to-upstream]].
- "Tapping the thread closes the chat" / "doesn't reload when I close and reopen" → channel/thread-tap rule regression — must reload main chat to that thread's view (`01KRVWS4V3VFM7`, regression `01KRWK14649ZVCRYE91PHAJW8W`).
- "Composer didn't create a ticket / no replies in All threads" → composer-always-feedback-and-session invariant broken; check `cos-inbox.ts::mintFeedbackThread` linkage (`01KRYPA6XY`).
- "Drawer pull is floating but the overlay isn't visible" → popout z-index regression; anchor drawer z to `getPanelZIndex(panel)+2` (`01KRYRFKHQ`).
- "Local" shown alone in the machine picker → use the human-readable display name for the local launcher (`01KRWHAT4S`).
- "Our session here died, investigate and do what it was supposed to" → bail-out recovery dispatch; CoS Ops re-reads parent and fans out a fresh child session (`01KRWH7TGZ`).

## Persistent operator preferences

- **Floating overlays must be opaque.** Hardcoded `#1e293b`, not `--pw-bg-surface` ([[feedback_floating_overlay_opaque]]).
- **No `window.prompt/alert/confirm`.** Build proper modals or use the TerminalPicker spotlight.
- **Drafts everywhere.** Composer text persists per-thread, per-window, across refresh. Goes in localStorage; cross-window sync via WebSocket.
- **One source of truth per action.** "Close Pane" lives on the X, not also in the hamburger menu. Same for any duplicated action.
- **Lazy tab rendering is non-negotiable.** Multiple mounted `AgentTerminal` instances freeze Chrome.
- **Show full message by default.** Don't make the operator click "expand" for every assistant reply.
- **Structured view is default for live sessions.** Terminal is the escape hatch, not the default.
- **Commit and push frequently.** The operator often dispatches a session whose entire job is "commit and push" (e.g., `01KQRKHFAX`, `01KR4QT3GF`, `01KQXAM8BD`).

## Operator's local environment

- VM hostname: see CLAUDE.md ProPanes API section. Local dev runs at `http://localhost:3001` (admin) + `:3002` (session-service) + `:5174`/`:5175` (vite hosted apps with widget).
- The operator's MacBook Air can connect via remote launcher; certain bugs (struct/jsonl view failing on remote `01KR4R56D6`) are specific to that path.
- An `azstaging2` parallel staging VM exists for testing — see [[reference_azstaging2]] (ssh, tmux, tunnel ports).
- A shared Playwright browser daemon on the VM is used for UI verification — see [[reference_vnc_browser]].

## Tone

Operator writes short, terse, lowercase. Uses lots of `[Element 1]` placeholder shorthand from widget DOM-attach. Quotes specific selectors and tmux IDs when they matter. Will often hand you the literal failing console line. When the operator says "fix X," fix X — don't ask which X.
