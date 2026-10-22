# amirobot Slack listener

The interactive bot runs from ProPanes `packages/slack-bot`. Slack Bolt opens an
outbound WebSocket using Socket Mode, `SLACK_APP_TOKEN` (`connections:write`) and
`SLACK_BOT_TOKEN`. No public event webhook is needed. Subscribe the Slack app to
`app_mention`; the bot needs `app_mentions:read`, `chat:write` and `reactions:write`.
Invite it to the channel where it should answer. Existing DM handling additionally
needs its message subscription and DM scopes.

A human `@amirobot <request>` gets an `eyes` reaction on that exact message before
work starts. A root mention opens a reply thread; a mention inside an existing
thread keeps replies under that thread's root. Initial acknowledgement, session
updates and the final answer all use that thread. A reaction failure does not
suppress the reply. Bot echoes and empty mentions are ignored.

Requests use the existing ProPanes feedback/agent-dispatch API, not an LLM inside
the Slack process. The existing dispatcher selects a skip-permissions agent;
channel membership should reflect who is allowed to launch that work. Ordinary
channel messages without a mention are not dispatched. Mention again inside the
thread for follow-ups. Active session tracking is in memory: restarting the
listener does not stop running agents or recover its polling state.

Separate backup/monitoring alert senders post through plain `chat.postMessage`
with the same Slack bot identity. Seeing alerts does not prove this Socket Mode
listener is running.

## Build, test and run on the shared VM

Keep credentials only in the ignored `packages/slack-bot/.env` (mode `0600`),
never in the unit, repository or logs. Configure `PROPANES_URL` for the local API,
`PROPANES_PUBLIC_URL` for operator-visible session links, and `PROPANES_APP_ID`
for the existing application. Set `PROPANES_TOKEN` to an authorized ProPanes
bearer token for that application and agent. Admin API calls require it; the
listener verifies API authentication and agent selection before opening its socket.
Track the token expiry and replace it before expiration. Never use a Slack token
as the ProPanes credential. Existing Slack token scopes already include reactions.
If changing Slack app scopes, reinstall/reauthorize the app in Slack first.

From the checkout holding the code being deployed:

```bash
pnpm --filter @propanes/slack-bot types:check
pnpm --filter @propanes/slack-bot test
pnpm --filter @propanes/slack-bot build
```

The VM-specific unit assumes the main checkout at `/home/azureuser/propanes`.
Install the built `dist/index.js` there before starting the unit. Keep a protected
rollback copy if replacing an existing build. The build leaves `@slack/bolt`
external, so the main checkout's installed dependencies must remain available.

```bash
sudo install -m 0644 packages/slack-bot/amirobot.service /etc/systemd/system/amirobot.service
sudo systemctl daemon-reload
sudo systemctl enable --now amirobot.service
sudo systemctl status amirobot.service --no-pager
sudo journalctl -u amirobot.service --since '5 minutes ago' --no-pager
```

Do not run a second listener manually alongside systemd. Confirm the journal says
`amirobot connected via Socket Mode`; this verifies transport, not a full reply.
For acceptance, send `@amirobot hello` in the intended channel and verify eyes
appears on the message, followed by a reply in its thread. Repeat the mention in
an existing thread and verify no new top-level message is posted. Synthetic tests
cover ordering/thread routing without sending Slack messages or launching agents.

To deploy an updated build, install it and restart only `amirobot.service`.
To disable this listener, `sudo systemctl disable --now amirobot.service`;
backup alerts continue through their independent path.
