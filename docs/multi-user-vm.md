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
     --slack-user U012AB3CD --slack-persona alicebot
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
- with `--slack-user`, links their Slack account to the shared Slack bot (see
  below).

The script also writes `~/setup-apps.sh` in the member's home, which clones
any app checkout that needed their credentials (it skips checkouts that
exist, so it is safe to re-run).

The member then opens a terminal in ProPanes. It now runs as `pp-<user>`, on
their launcher. From it they run `claude` to log in, then `codex login`,
`gh auth login`, and `bash ~/setup-apps.sh`. If they are linked to Slack, the
bot sends them these steps in a DM, with a link to a terminal already open on
their launcher (see below).

### Dev URLs

Several members can run dev servers side by side. Each one reserves a port and
a hostname with `POST /api/v1/admin/dev-routes` (agents can do it themselves
with their session's `PROPANES_TOKEN`; the Slack setup guide's suggested
request asks them to). The server proxies that hostname to the port, so the
edge only ever needs to reach the server's own port. Set `DEV_ROUTE_DOMAIN`,
and `DEV_ROUTE_HOOK` to a script that creates the hostname at your edge (see
`CLAUDE.md` → Dev URLs). Members share localhost, so a dev server bound to a
port outside its reservation can still collide with someone else's.

### Slack

One Slack app serves everyone. Link a member's Slack account to their ProPanes
user (Users page → ⋯ → **Link Slack…**, or `--slack-user`), and the bot then
works for them as that user:

- it acts with a short-lived token minted for them (2 days, renewed in the
  background), so it sees only what they can see, and their sessions run on
  their pinned launcher with their own agent logins;
- their threads and preferences live in their own state file;
- its replies to them can carry a display name ("Reply as", `--slack-persona`).
  That needs the `chat:write.customize` scope; without it, replies use the
  bot's own name;
- a thread belongs to whoever started it. Replies from anyone else are not
  forwarded to that person's agent. Mentioning the bot there gets a one-time
  explanation.

Once a linked user has their own launcher, the bot DMs them a setup guide
once: a link to a terminal opened in their home on that launcher, the sign-in
steps above, and a suggested request per app (`[app:<name>] set up this repo's
development environment…`) that an agent then carries out as them. If the
launcher is offline, the bot retries on its next identity refresh (every
minute). They can send `[setup]` any time for a fresh terminal and the steps.

The operator can also let a linked user run requests as the operator: tick
**May also run requests as you** in the Slack link form. That user then starts
a request with `[operator]` (e.g. `[operator, codex] check the deploy`) to run
it with the operator's apps, machines and agent subscriptions. The thread is
the operator's, but follow-ups from the user who started it keep reaching it
without repeating `[operator]`; nobody else's replies do. Without the
permission, `[operator]` is refused and nothing starts.

Slack members who are not linked act as the operator (the owner of the bot's
`PROPANES_TOKEN`), as before. Set `SLACK_REQUIRE_LINK=1` on the bot to refuse
them instead. Linking needs the bot's `PROPANES_TOKEN` to belong to the server
operator (an admin with no org); with any other token everyone acts as that
token's user.

`[models]` lists what the member's own CLI logins offer: the server asks their
pinned launcher (which runs as them) to read the Claude and Codex model lists.
A launcher older than this feature doesn't answer, and `[models]` says so.

"Continue in Slack" (the session menu in the admin UI) is available to every
linked user. The bot opens the session in their DM with it, acting as them;
the operator's own requests still go to `AMIROBOT_HANDOFF_CHANNEL`.

#### People in another Slack workspace

There is one bot in one workspace. Someone from another organisation can still
use it from a Slack Connect channel shared with your workspace (with the bot in
that channel): link their member id as usual. DMs and "Continue in Slack" need
them to be able to DM the bot, which a Slack Connect partner may not allow.

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
