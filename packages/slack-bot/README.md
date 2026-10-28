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
| `@amirobot [app:storefront] add a toggle` | Run in that ProPanes application (project); combinable: `[claude, app:storefront]`. See "Applications" |
| `@amirobot [apps]` | The registered applications with their `[app:…]` option and the default. Never creates a session |
| `@amirobot [infra:laptop] build it` | Run the session on that connected machine/launcher instead of this server; combinable: `[codex, app:propanes, infra:laptop]`. See "Connected infrastructure" |
| `@amirobot [infra]` | Connected infrastructure (this server, machines, harnesses, sprites) with state, load and the `[infra:…]` option. Never creates a session |
| `@amirobot [terminal]` | Open a plain shell and reply with its session link |
| `@amirobot [infra:macbook terminal]` | Open a shell on that machine and reply with its session link |
| `@amirobot [sessions]` | Numbered list of all active agent sessions with clickable links, grouped beneath their app names. Reply with a number to continue that session in Slack |
| `@amirobot [app:propanes sessions]` | List active agent sessions for the matching application |
| `@amirobot [terminals]` | List all active plain terminals with clickable links |
| `@amirobot [help]` | Threaded help: commands, defaults, output modes, examples. Never creates a session |
| `@amirobot [status]` | The thread's session link, agent, state (working / waiting / idle / completed…) and history. Never creates, interrupts or resumes anything |
| reply `[session] try another approach` | Fork this agent conversation with full native history into a new Slack thread; leave the original running |
| reply `stop` (also `cancel`, `halt`, `kill`) | Kills the thread's running session (preserved from the previous bot). A later reply resumes it |

Leading bracket options are case-insensitive, comma separated and may be split
across groups: `[claude, verbose, images]` ≡ `[Claude] [VERBOSE] [images]`.
Spaces can separate options too: `[infra:macbook terminal]`. Multiword app and
infra names remain supported (`[app:Admin Console]`).
Unknown options, `[claude, codex]`, `[verbose, quiet]` and `[help]`/`[status]`
combined with anything else get a threaded explanation and nothing is created or
changed.

The short commands `[apps]`, `[infra]`, `[sessions]` and `[terminals]` are
preferred; the existing `[list-apps]`, `[list-infra]`, `[list-sessions]` and
`[list-terminals]` remain supported as aliases.

### Thread replies and session branches

After addressing the bot once, reply without another mention to use `[help]`,
`[infra]`, `[terminals]`, `[sessions]`, `[apps]` and their long aliases. The bot
remembers these conversations even when no session was started, including across
listener restarts. Lists and help stay in the requesting thread.

A new task in a thread with no session starts its own bot-rooted Slack thread.
`[terminal]` and infrastructure terminal buttons return a clickable terminal
session link in the requesting conversation without starting a new Slack thread.
Existing agent conversations retain their session mapping; otherwise replies
send shell input and `stop` closes the terminal.

Reply `[session] optional task` in an existing agent thread to branch its full
conversation into a separate Slack thread. With no task, the branch waits for
your next reply instead of sending a model turn. The branch inherits the agent, app,
machine and permission profile; output-mode options are allowed. Forks currently
require the same runtime/app/machine, so target-changing selectors are rejected.
Without an existing agent conversation, `[session] task` starts a fresh session
in its own thread. Plain replies continue the current conversation.

Forks use native CLI history: Claude `--resume … --fork-session --session-id …`,
and Codex `exec fork --json` without a prompt (a local copy with no model turn),
followed by `resume` of the new ID. Parent and branch have independent native
transcripts; old inherited output is filtered from Slack delivery. Missing
history, offline machines and older launchers fail explicitly, without resuming
or stopping the parent or falling back to another machine.

Deploy this change by rebuilding/restarting the Slack bot, main server and
session service. Remote fork support also requires rebuilding/restarting the
launcher on each target machine; launchers advertise `nativeForks` so old
versions cannot silently discard fork requests. There are no admin UI changes.

### Applications

Every session runs in one ProPanes application (its project directory). A new
request uses the default application — `PROPANES_DEFAULT_APP` by name or id,
falling back to `PROPANES_APP_ID` — unless it carries
`[app:<name>]` (`app=` works too; spaces are allowed, e.g.
`[app:reports staging]`). Resolution against `GET /api/v1/admin/applications`:

- an exact match on the name, id or project-directory name wins
  (`[app:reports]` → *Reports*, not *Reports Staging*);
- otherwise a single partial match is accepted (`[app:store]` → *Storefront*);
- if no partial matches exist, small typos (including swapped adjacent letters)
  are accepted against names and individual words;
- several matches get a clarifying list of the candidates and nothing is
  started; no match gets the full list. `[apps]` prints the
  same list with the default marked. Ambiguous replies include exact `[app:ID]`
  selectors; mention the bot again with the original request and a choice.

The application is fixed per thread (the session's working directory cannot
move): `[app:…]` in a later reply naming another app is refused and that message
is not sent. The first reply and `[status]` show `*app* <name>`; feedback items
and uploads are created under the thread's app, and agents are resolved for it
(`GET /admin/agents?appId=` includes global endpoints such as `yolo` /
`codex-yolo`). Threads created before app selection existed fall back to
`PROPANES_APP_ID`.

### Connected infrastructure

Sessions run on this server unless a new request carries `[infra:<name>]`
(`infra=` works too). Targets come from `GET /api/v1/admin/dispatch-targets`
— the dispatch popup's list: connected remote launchers, running harnesses,
sprites, machines marked online without a launcher, plus the server host
(`[infra:local]`, also `server` / `here` or its machine name). Resolution
matches the target name, machine name, hostname or launcher id: an exact match
wins, a single partial match is accepted (`[infra:laptop]` →
*dev-laptop*), then conservative typo matching is attempted. Several matches
get a clarifying list with exact `[infra:ID]` selectors to retry, and an
**offline** target is refused — the server would otherwise fall back to running
the session locally without saying so. `[infra]` (or `[machines]`) prints the list with state and `active/max` sessions.

The chosen launcher is passed as `launcherId` on `POST /admin/dispatch`; the
server pushes the application's project to the launcher and keeps the app's
working directory, so `[app:…]` and `[infra:…]` compose. The first reply and
`[status]` show `*infra* <name>` for remote targets. Infrastructure is fixed
per thread: continuations resume with the parent session's launcher
server-side, and `[infra:…]` naming another target in a later reply is refused
without sending the message.

The `[infra]` response includes an **Open terminal** button for this server and
each online remote machine. Clicking creates a plain terminal on that exact
infrastructure and replies in the current conversation with its clickable session
link. Existing agent conversations stay associated with their original sessions. The target is
rechecked at click time: removed/offline targets are refused, and harness/sprite
targets have no plain-terminal button. Duplicate Socket Mode delivery of the same
click creates only one terminal. Large lists are split below Slack's block limit.

### Listing active sessions and terminals

`[sessions]` lists all active agent sessions visible to the bot's bearer
token. `[app:propanes sessions]` restricts that list to the resolved app;
commas (`[app:propanes, sessions]`) and separate bracket groups work too.
App matching uses the same exact, partial and typo matching as dispatch.
Ambiguous or unknown app names receive the existing explanatory replies before
sessions are fetched. Without an app selector, the list covers every visible app,
including when requested inside a thread associated with a particular app.

`[terminals]` lists all active plain shell sessions. These commands treat
`running`, `pending` and `dispatching` sessions as active, including running
sessions waiting for input or idle. Completed, failed, killed and deleted items
are excluded. Agent sessions and plain terminals appear in their respective
lists, including sessions launched outside Slack.

Each entry links to the public admin session page and includes its title (or
feedback title/ID), ID, runtime or shell, status, and machine name when available.
Long lists are split into Slack-sized messages without truncating the result set.

### Continuing a ProPanes session in Slack

Agent sessions in `[sessions]` are numbered across app groups, and the list ends
with "Reply with the number to continue the session in Slack". For ten minutes
the requester's numeric reply in that conversation picks a session (any other
reply cancels the selection, so numeric answers to an agent still work). The
chosen session, started from Slack or not, gets its own bot-rooted thread:

- nothing is dispatched, resumed or forked; the thread is bound to the existing
  session, its app, machine, runtime and **its own permission profile** (a later
  resume keeps that profile instead of the bot's `interactive-yolo`);
- the transcript so far is read but not re-posted; the intro shows the latest
  assistant reply, and only output written after the move reaches Slack;
- replies send keys to a live session or resume a stopped one, exactly as in a
  Slack-started thread, including the one-hour idle pause;
- a session already bound to a thread is not moved twice: the reply links the
  existing thread.

The admin session menus (the sidebar status-dot menu and the session-ID menu in
the session header, which is the one used on mobile) have **Move to Slack** for
the global operator account. The server keeps an in-memory queue
(`/api/v1/admin/slack-handoffs`); the listener claims it every
`AMIROBOT_HANDOFF_POLL_MS` (default 3000) and reports each outcome, which the
admin shows as a toast. The thread opens in `AMIROBOT_HANDOFF_CHANNEL` (a
channel id, or a user id for a DM) and falls back to the conversation of the
most recent bot thread. If the listener has not polled for 30 s, the admin
request is refused with "listener is not connected". Queued requests do not
survive a server restart. Org admins and members do not get the item: the bot
posts in the operator's workspace.
An empty list explicitly says there are no active items. Listing is read-only:
it never creates, interrupts or resumes sessions, forwards text to them, changes
user preferences, or replaces the thread's current session mapping.

Only `[sessions]` accepts an optional app selector. Other agent, infra,
output, terminal options and prompt text are rejected for these list commands.

### Terminals

`[terminal]` creates a plain shell through `POST /api/v1/admin/terminal` and
returns its public session link, without feedback, agent dispatch or transcript
polling. Add optional app/infra selectors, including `[infra:macbook terminal]`
or `[app:propanes infra:laptop terminal]`. The same target resolution and
ambiguity/offline explanations apply. Plain terminals support local/remote
machines; harness and sprite targets receive an explanation instead of
opening a shell on the wrong host. Prompt text, attachments and agent/output
options cannot be combined with `[terminal]`.

An app supplies its project directory for local terminals; remote launchers
use the machine's configured default directory (home when unset). In a conversation
associated with a terminal, replies send shell input, `stop` closes the shell and
`[status]` reports its state. An ended shell requires another `[terminal]`
request. A terminal requested in an existing agent thread returns its link there,
leaving that thread's agent conversation intact. Terminal mappings survive
listener restarts without starting a transcript watcher.

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

### Model selection

Send `[models]` to see a numbered catalog, then reply with a number in the same
thread or DM within ten minutes (no new mention needed). Menus belong to the
requesting user; other users' numeric replies keep reaching their agent. A
normal non-selection reply closes your menu. `[models:opus]`, `[models:sonnet]`
and `[models:astra]` select directly, ignoring case and punctuation; exact names
and aliases win over partial names. Ambiguous queries show a numbered shortlist;
unknown names and invalid numbers never dispatch a task or change a preference.

Each choice confirms the model and saves a default per workspace, user and
provider, surviving listener restarts. It also remembers that model's runtime
for new tasks. Anthropic and OpenAI defaults remain independent. Explicit
`[claude]` and `[codex]` use their provider's saved default. New dispatches and
resumes pass the model to the CLI through `--model`, locally or on a launcher,
harness or sprite. Selecting a default does not interrupt ongoing work. Your next message in a
thread for that provider resumes the conversation with the selected model if
it differs from the running model. Use `[claude]` or `[codex]` with a task to
switch an existing thread to the other provider. Selection commands accept no prompt
or other bracket options.

The catalog is discovered from the signed-in CLIs on the bot host: Claude's
SDK initialization returns its model picker entries (including model versions
and resolved IDs), and Codex's app-server `model/list` returns its selectable
models. Every page is fetched; provider-hidden internal entries stay hidden,
matching the CLI picker. No user prompt, inference request or task session is
submitted. New releases and account-specific choices appear without editing a
model list in the bot.

Discovery is shared across concurrent requests and cached for 60 seconds.
Failures are reported per provider; healthy providers remain available. If a
previous successful list exists, it is shown with an explicit stale-list warning;
there is no fallback to a handpicked catalog. Large lists span multiple Slack
messages while retaining one stable numbered menu for selection. Models shown
are those of the bot host's CLI accounts; remote launchers use their own installed
CLI versions and credentials when a session is dispatched there.

`CLAUDE_BIN` and `CODEX_BIN` may select CLI executables. Native installations in
`~/.local/bin` are also found when systemd's PATH omits that directory. Both
commands are bounded by a 30-second discovery timeout; their subprocesses are
terminated after discovery. Claude initializes without session persistence or
project MCP servers. The systemd unit permits auth/cache refreshes only in
`/home/azureuser/.claude` and `/home/azureuser/.codex`; reinstall the unit and run
`systemctl daemon-reload` when deploying this change.

To add explicitly configured model options, set `AMIROBOT_MODELS_JSON` to a
non-empty JSON array, e.g.
`[{"provider":"Anthropic","runtime":"claude","id":"custom-model","label":"Custom model","aliases":["custom"]}]`.
These options supplement discovery; they no longer replace or hide discovered
models. New provider adapters register a provider label, runtime and discovery
function; a new CLI runtime still requires its launch adapter. Existing defaults
and remembered menu choices survive the discovery change.

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

## Several users, one bot

The operator links Slack members to ProPanes users (Users page → ⋯ → **Link
Slack…**). Each linked user gets their own bridge: requests run with a
short-lived token minted for them (`POST /api/v1/admin/slack-identities/:id/token`),
so sessions are theirs and run on their pinned launcher; their threads live in
`users/<userId>.json` next to the main state file. A thread belongs to whoever
started it; replies from anyone else are not forwarded to that person's agent.
Unlinked members act as the operator, unless `SLACK_REQUIRE_LINK=1`. Links
are re-read every minute, and immediately (at most every 15 s) when an unknown
member writes. This needs the operator's `PROPANES_TOKEN`; see
`docs/multi-user-vm.md`.

## Slack app configuration

Socket Mode and **Interactivity & Shortcuts** on (button actions arrive through
Socket Mode; no public interactivity request URL is needed); event subscriptions: `app_mention`, `message.channels`,
`message.groups`, `message.im`, `message.mpim` (thread replies without a
mention arrive as `message` events). Bot token scopes: `app_mentions:read`,
`chat:write`, `reactions:write`, `channels:history`, `groups:history`,
`im:history`, `mpim:history`, `files:write` for image uploads,
`files:read` to download attachments people share with the bot (all but
`files:read` installed on the deployed workspace as of 2026-10-22), and
optionally `chat:write.customize` so replies to linked users carry their
display name. Adding a scope later
requires reinstalling/reauthorizing the app in Slack, which only a workspace
admin can do. Invite the bot to the channels where it should answer; channel
membership decides who can launch work.

## Build, test and run on the shared VM

Keep credentials only in the ignored `packages/slack-bot/.env` (mode `0600`),
never in the unit, repository or logs. Configure `PROPANES_URL` for the local
API, `PROPANES_PUBLIC_URL` for operator-visible session links,
`PROPANES_DEFAULT_APP` for the default application by name (`PROPANES_APP_ID` is
the id fallback), and `PROPANES_TOKEN` (an authorized ProPanes bearer token;
track its expiry). Optional: `SLACK_BOT_NAME` (the handle used in help text,
hints, feedback tags and logs; default `amirobot` — set it when running another
user's bot, see `docs/multi-user-vm.md`), `AGENT_ENDPOINT_ID`, `POLL_MS`, `IDLE_POLL_MS`,
`IDLE_STOP_MS`, `AMIROBOT_STATE_FILE`, `AMIROBOT_HANDOFF_CHANNEL`,
`AMIROBOT_HANDOFF_POLL_MS`, `SLACK_REQUIRE_LINK`. The bot token also downloads Slack
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
