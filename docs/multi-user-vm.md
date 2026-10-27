# Multiple users on one VM

A ProPanes user account on its own gives a member a separate **view**: they see
only the apps, feedback and sessions they own (or their org owns). It does not
separate **execution**. Without a launcher pin, every session a member starts
runs on the server's local session-service — as the server's Linux account,
with its `~/.claude` / `~/.codex` logins, its git credentials, its database and
its `.env`. On a shared VM that is no isolation at all.

There are two ways to get real isolation:

| | Kubernetes (per-user pod) | Single VM (per-user Linux account) |
|---|---|---|
| Set up with | Users page → **Provision pod** | `scripts/onboard-user.sh` |
| Execution boundary | Separate pod + private `agent-home` PVC | Separate Linux account, home `0750` |
| Agent logins | In the pod's agent-home | In the member's home |
| Session routing | `users.launcher_id = agent-<user>` | `users.launcher_id = vm-<user>` |

Both use the same mechanism: a launcher daemon that runs as the member, and a
pin on the user row. Once pinned, the member's sessions run only on that
launcher. This includes sessions they start in the UI, terminals, resumes, and
dispatches that carry no launcher of their own, such as widget auto-dispatch on
their apps. If the launcher is offline, dispatch is refused. It does not fall
back to a local run.

## Onboarding a member on a VM

1. Create the user on the Users page (or `POST /api/v1/admin/users`).
2. Run the script as root with an admin token. Pass each app you suggest for
   them by its id; the member gets their **own** copy pointing at their own
   checkout, never yours:

   ```bash
   sudo -E scripts/onboard-user.sh --user alice \
     --app <APP_ID> --app <OTHER_APP_ID> \
     --slack-bot alicebot
   ```

   `--dry-run` prints every step without changing anything.
   `GET /api/v1/admin/users/<id>/onboarding` lists the apps you can suggest.

What it does, idempotently:

- creates the Linux account `pp-<user>` (home `0750`) and installs Claude Code
  into it (the native installer is per-user);
- installs the launcher bundle to `/opt/propanes/launcher` and starts
  `propanes-launcher@<user>`. That service runs as `pp-<user>` and reads its
  env from `/etc/propanes/users/<user>/launcher.env`. The env holds a
  member-scoped `PROPANES_TOKEN`, which their agent sessions inherit;
- clones each suggested app's git remote into the member's home, as the member.
  If the repo is private, the clone fails until the member signs in. The script
  then prints the command for them to run;
- calls `POST /api/v1/admin/users/<id>/onboard`, which creates the member's
  apps, an agent set on each one, a machine row for the launcher, and the
  launcher pin. The agent set is Claude, Claude YOLO, Codex and Codex YOLO,
  all interactive, with Claude as the default;
- with `--slack-bot`, installs the bot to `/opt/propanes/slack-bot` and writes a
  Slack app manifest and `slackbot.env`. The `propanes-slackbot@<user>` service
  starts once the Slack tokens are filled in.

The member then opens a terminal in ProPanes. It now runs as `pp-<user>`, on
their launcher. From it they run `claude` to log in, then `codex login`,
`gh auth login`, and any clone the script reported.

### Their Slack bot

Each bot is its own Slack app running the same code. Set it up like this:

1. Go to api.slack.com/apps → **Create New App** → **From a manifest**, and
   paste `/etc/propanes/users/<user>/slack-app-manifest.yml`. A workspace admin
   may need to approve the install.
2. Under **Basic Information → App-Level Tokens**, create a token with
   `connections:write`. This is `SLACK_APP_TOKEN` (`xapp-…`).
3. Under **Install App**, install it and copy the bot token. This is
   `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Put both tokens in `/etc/propanes/users/<user>/slackbot.env` and re-run the
   script, or run `systemctl enable --now propanes-slackbot@<user>`.
5. Invite the bot to the channels where it should answer.

The bot's ProPanes token is the member's own, so it sees and launches exactly
what they can. `SLACK_BOT_NAME` makes help text and hints use its handle.

## What is and isn't isolated

Isolated:

- agent credentials;
- git credentials and checkouts;
- files in either home directory;
- the ProPanes database and secrets;
- which apps, feedback and sessions each user can see.

Shared:

- CPU, memory and disk;
- `/tmp`;
- localhost ports. A member's dev server can collide with yours;
- the launcher WebSocket. With `LAUNCHER_AUTH_TOKEN` unset, any local process
  can register as a launcher. Even with it set, the token is global, so a member
  who can read their own `launcher.env` could register under another launcher's
  id. Members who don't trust each other on one VM need per-launcher tokens, or
  the Kubernetes path.

Check that the operator's home is not world-readable (`chmod o-rwx ~`). The
script warns when it is.
