# amirobot Slack listener

`packages/slack-bot` turns a Slack thread into a conversational interface to a
ProPanes agent session. Slack Bolt opens an outbound WebSocket using Socket Mode
(`SLACK_APP_TOKEN` with `connections:write`, plus `SLACK_BOT_TOKEN`); no public
event webhook is needed. Requests use the existing ProPanes feedback / dispatch /
session APIs with an authorized bearer token — there is no LLM inside the Slack
process.

## Commands

| Message | Effect |
|---|---|
| `@amirobot review PR 2013` | New session with the remembered agent (the ProPanes default the first time) |
| `@amirobot [claude] review PR 2013` | Explicitly use Claude |
| `@amirobot [codex] review PR 2013` | Explicitly use Codex |
| `@amirobot [help]` | Threaded help: commands, defaults, output modes, examples. Never creates a session |
| `@amirobot [status]` | The thread's session link, agent, state (working / waiting / idle / completed…) and history. Never creates, interrupts or resumes anything |
| reply `stop` (also `cancel`, `halt`, `kill`) | Kills the thread's running session (preserved from the previous bot). A later reply resumes it |

Leading bracket options are case-insensitive, comma separated and may be split
across groups: `[claude, verbose, images]` ≡ `[Claude] [VERBOSE] [images]`.
Unknown options, `[claude, codex]`, `[verbose, quiet]` and `[help]`/`[status]`
combined with anything else get a threaded explanation and nothing is created or
changed.

### Agent selection

- An explicit `[claude]` / `[codex]` wins. Otherwise a new session uses the agent
  remembered for that Slack workspace + user (persisted, survives restarts); with
  no memory, the runtime of the ProPanes default endpoint (app default, then
  global default, else Claude).
- Endpoints are resolved through `GET /api/v1/admin/agents?appId=…`: the
  requested runtime's endpoint with a skip-permissions profile
  (`interactive-yolo` preferred, then `headless-stream-yolo`, `headless-yolo`).
  Sessions are dispatched as `interactive-yolo`: a live TTY nobody has to answer
  permission prompts for, so thread replies reach the same conversation.
- If the requested runtime has no usable endpoint the bot says so and does
  nothing; it never substitutes the other runtime. `AGENT_ENDPOINT_ID` forces a
  specific endpoint for its own runtime only.
- Inside a thread the session's agent is retained. An explicit different
  runtime (`[codex] try the other approach`) stops the live session if it is
  still running (mirrors the admin "Resume as…"), then resumes it with
  `runtime: codex` through `POST /:id/resume`: ProPanes creates a child session
  that inherits the feedback/task context (the context-dump continuation used
  whenever the runtime differs). The thread keeps every session in its history
  and the reply shows both the new and the previous link; `[status]` lists them.
  The user's remembered agent is updated to the new choice.

### Thread / session behaviour

1. Every accepted human request gets an 👀 reaction before work starts.
2. A request in a new thread creates a feedback item and dispatches a session
   (`POST /api/v1/admin/dispatch`), then replies with the public session link
   (`PROPANES_PUBLIC_URL/admin/#/session/<id>`), the agent and the output mode.
3. The workspace/channel/thread ↔ session mapping is persisted. Any later
   human reply in that thread — no mention needed — is sent with the same backend
   operations the admin structured view uses:
   - session `running`/`pending` → `POST /:id/send-keys` (the input bar's
     "send to running process"); multi-line Slack text is sent as one line
     (`⏎` between lines) because the TTY submits on newline;
   - session finished (`completed`/`failed`/`killed`) → `POST /:id/resume`
     with the text as `additionalPrompt` (the input bar's explicit Resume) and
     the bot's TTY profile (`interactive-yolo`) pinned. The server continues
     the agent's own conversation (`claude --resume <session>` /
     `codex resume <thread>`), so the agent keeps its full context instead of
     a re-typed task summary. The thread follows the new session; the reply
     links both.
   There is no blanket kill-and-resume. A `waiting` session (permission prompt,
   AskUserQuestion) is announced once in the thread with the pending tool; a
   reply answers it through the same send-keys path (`y`, `1`, free text).
   **Prompts typed outside Slack** — in the admin terminal, the structured
   view's input bar or a follow-up queue — appear in the transcript as user
   turns the bot never sent. They are echoed into the thread in every output
   mode as `👤 User asked outside Slack:` followed by the quoted prompt, so the
   replies that follow are attributable, and they open a turn like a Slack
   reply would (quiet mode delivers the final `<cos-reply>` for them too).
   The bot remembers the prompts it sent per session (`sentPrompts` in the
   delivery checkpoint) and matches transcript user turns against them, verbatim
   or embedded in the server's dispatch/resume wrapper; harness-written user
   envelopes (`<system-reminder>`, slash-command output, codex
   `<environment_context>`, "Request interrupted") are never announced.
4. Bot messages, message edits/deletes and other subtypes are ignored; a
   message with attachments (subtype `file_share`) is a human request and is
   delivered with its attachments (see "Attachments from Slack"). Slack
   retries and duplicate deliveries are dropped by `event_id` (persisted).
   Replies in threads the bot does not know about are ignored. DMs work without
   a mention; a flat DM is one conversation.
5. **Idle pause.** A session with no activity for `IDLE_STOP_MS` (1 h) while
   no turn is open is stopped (`POST /:id/kill`) and the thread is told
   (`💤 Paused … Reply in this thread to resume it where it left off`). The
   transcript stays on disk, so the next reply resumes the same conversation
   through the native resume above; `[status]` shows `paused after 1 h idle —
   reply to resume`. A turn still in progress is never paused. `stop` behaves
   the same way on request (`stopped on request — reply to resume`).
6. Output is read only from the structured transcript
   (`POST /:id/jsonl` with a cursor, the structured view's differential poll),
   parsed with the admin's own `JsonOutputParser` / `CodexOutputParser`.
   Terminal output is never scraped.

### Output modes (remembered per thread; change with `[verbose]`, `[quiet]`, `[default]`)

| Mode | What reaches the thread |
|---|---|
| default | All assistant text from the main agent — progress, commentary and the final answer. No tool calls, tool results, thinking, subagent chatter or protocol noise. `<cos-reply>` tags are stripped, the text inside is kept |
| `[verbose]` | The full structured-view stream in original order: assistant text, 🔧 tool calls (input summary), ↩︎ tool results (truncated), 💭 thinking, system lines; subagent events prefixed `↳` |
| `[quiet]` | Only the initial link. When the turn finishes, the agent's final `<cos-reply>…</cos-reply>` block (the last *closed* block of the turn — an early acknowledgement or a half-written block is never used). If the session fails, is cancelled/killed, or finishes without the block, a one-line truthful status with the link is posted instead |

Verbose and quiet are mutually exclusive. The dispatch instructions tell the
agent to put its final answer in `<cos-reply>` (quiet mode: "only the last
complete block is shown, write it once at the end"); quiet-mode follow-ups carry
a one-line reminder. The server's `COS_REPLY_DISPATCH_HINT` is appended as usual.

A turn is considered finished when the session reaches a terminal status, or a
live TTY session reports `inputState: idle` on two consecutive polls with no
pending tool call. In default/verbose modes nothing extra is posted at idle (the
text already streamed); a terminal status posts `✅/⚠️ Session … <status>`.

Delivery is paced (≥1 s between posts per channel, Slack's retry-after honoured
by the SDK), consecutive pieces are coalesced into as few posts as possible, and
long text is chunked at ~3800 characters on paragraph boundaries with code
fences kept balanced. The server-side transcript redaction (elided image
payloads, elided MCP structured content) is preserved because the bot reads the
same endpoint as the admin UI; API error bodies are reduced to their `error`
field and Slack SDK errors to their error code.

### Images (`[images]`, combinable, e.g. `[quiet, images]`)

Every image the agent actually viewed is uploaded to the thread as a file.
"Viewed" means a `tool_result` image block (e.g. `Read` of a PNG): either the
inline base64 payload or the server's elided reference, which is fetched from
`GET /:id/jsonl-image/:uuid/:index` with the bot's credentials — the same
artifact endpoint the mobile structured view lazy-loads. Paths mentioned in
text are never uploaded. Rules:

- repeated reads of the same image upload once (verbose mode notes the repeat);
- `image/png|jpeg|gif|webp` up to 20 MB; others are skipped with a note;
- an inaccessible artifact (404, remote launcher offline) posts a note naming
  the read, not raw output;
- quiet mode still uploads images while intermediate text stays suppressed;
- uploads use `files.uploadV2`, which needs the `files:write` bot scope. If
  the installed app ever lacks it, the bot posts one explanation per thread
  and skips images instead of failing.

### Attachments from Slack

Files attached to a mention or a thread reply are passed to the session the
same way the admin composer passes dropped files, so the agent sees them
exactly as it would from the UI:

- Each file is downloaded from Slack with the bot token (`files:read` scope).
  PNG/JPEG/GIF/WebP count as screenshots; everything else is a file. Limit
  20 MB per file; Slack posts, snippets, external and deleted files are
  skipped with a note. Nothing is ever invented for a file that could not be
  fetched — the thread is told which ones were skipped and why.
- New request: screenshots are attached to the feedback item (`POST
  /api/v1/feedback` multipart), so the dispatcher renders them into the
  prompt and ships them to remote launchers; other files go through `POST
  /api/v1/uploads` and are listed under "Attached files (read from these local
  paths…)" with a download URL, exactly as the dispatch popup words it.
- Reply in a thread: screenshots go through `POST /api/v1/screenshots` and
  files through `POST /api/v1/uploads` for that session, and the paths/URLs are
  appended to the text — one line for a live session (send-keys), a block for
  a resume. An attachment with no text sends "See the attached file(s)."
- Missing `files:read`: the text is still delivered and the thread is told
  once that attachments cannot be read until the scope is added.

### Reliability

- State file (`$STATE_DIRECTORY/amirobot-state.json`, dev: `packages/slack-bot/state/`)
  holds thread mappings, per-user agent preferences, per-thread delivery
  checkpoints (transcript cursor, delivered event keys, open turn, uploaded
  image keys) and recent event ids. Writes are atomic (tmp + rename).
- Each thread has one watcher; cursors are checkpointed after every post and
  delivered-event keys (JSONL uuids / content hashes) guard the overlap, so a
  crash between post and checkpoint cannot double-post. On start the listener
  re-arms the watcher of every thread that was still being followed.
- Per-thread requests are serialised, so two quick replies never create two
  sessions. Socket Mode handlers hand the event to the bridge and return, so
  acknowledgements never wait on dispatch, polling or posting.
- Watchers poll every `POLL_MS` (4 s) while a turn is open, `IDLE_POLL_MS`
  (30 s) once idle — admin-side activity in the same session still reaches the
  thread — and after `IDLE_STOP_MS` (1 h) of idleness they stop the session
  and pause the thread (see "Idle pause"); the next Slack reply resumes it. If
  the stop itself fails the thread is told and only the watcher stops. After
  30 consecutive poll failures the thread is told and the watcher stops.
- Slack requests never bypass ProPanes access control: every call carries the
  listener's bearer token, so the bot sees and drives exactly what that user may.

## Slack app configuration

Socket Mode on; event subscriptions: `app_mention`, `message.channels`,
`message.groups`, `message.im`, `message.mpim` (thread replies without a
mention arrive as `message` events). Bot token scopes: `app_mentions:read`,
`chat:write`, `reactions:write`, `channels:history`, `groups:history`,
`im:history`, `mpim:history`, `files:write` for image uploads and
`files:read` to download attachments people share with the bot (all but
`files:read` installed on the deployed workspace as of 2026-10-22). Adding a scope later
requires reinstalling/reauthorizing the app in Slack, which only a workspace
admin can do. Invite the bot to the channels where it should answer; channel
membership decides who can launch work.

## Build, test and run on the shared VM

Keep credentials only in the ignored `packages/slack-bot/.env` (mode `0600`),
never in the unit, repository or logs. Configure `PROPANES_URL` for the local
API, `PROPANES_PUBLIC_URL` for operator-visible session links, `PROPANES_APP_ID`
for the application, and `PROPANES_TOKEN` (an authorized ProPanes bearer token;
track its expiry). Optional: `AGENT_ENDPOINT_ID`, `POLL_MS`, `IDLE_POLL_MS`,
`IDLE_STOP_MS`, `AMIROBOT_STATE_FILE`. The bot token also downloads Slack
attachments. The listener verifies API authentication
and lists which runtimes resolve before opening its socket.

```bash
pnpm --filter @propanes/slack-bot types:check
pnpm --filter @propanes/slack-bot test
pnpm --filter @propanes/slack-bot build
```

The unit assumes the main checkout at `/home/azureuser/propanes` and keeps the
state in `/var/lib/amirobot` (`StateDirectory=`); the home checkout stays
read-only. The build bundles the admin parsers and leaves `@slack/bolt` external,
so the checkout's installed dependencies must remain available.

```bash
sudo install -m 0644 packages/slack-bot/amirobot.service /etc/systemd/system/amirobot.service
sudo systemctl daemon-reload
sudo systemctl enable --now amirobot.service    # or: restart, after installing a new dist/index.js
sudo systemctl status amirobot.service --no-pager
sudo journalctl -u amirobot.service --since '5 minutes ago' --no-pager
```

Do not run a second listener manually alongside systemd (events would be
handled twice). The journal line `amirobot connected via Socket Mode` verifies
transport and startup checks, not a full reply. For acceptance, send a harmless
`@amirobot [help]` (no session) and then `@amirobot say hello and finish` in the
intended channel: expect 👀, a session link, the agent's text in the thread, and
`[status]` reporting the session. Synthetic tests cover option parsing, agent
selection and persistence, help/status, the initial link, send-keys vs resume,
runtime switches, default/verbose/quiet delivery, final-tag parsing and
fallbacks, image resolution/upload/scope errors, duplicates, concurrency and
restart recovery without sending Slack messages or launching agents.

Separate backup/monitoring alert senders post through plain `chat.postMessage`
with the same Slack bot identity; seeing alerts does not prove this listener is
running. To disable it, `sudo systemctl disable --now amirobot.service`.
