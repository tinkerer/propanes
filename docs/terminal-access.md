# Native terminal access to agent sessions

The admin web terminal (xterm.js over `/ws/agent-session`) needs no setup and
is the default. For a native terminal there are three supported paths, in
order of preference:

## 1. propanes CLI (recommended)

Rides the same authenticated WebSocket as the web terminal, through the normal
HTTPS ingress. No local server, no cluster or host credentials.

```bash
npm install -g @propanes/cli
propanes login --server https://propanes.example.com
propanes attach <sessionId>        # detach with ctrl-]
propanes sessions                  # list your running sessions
```

One-time on macOS, to make the admin UI's "Open in Terminal.app" button work
via `propanes://` deep links:

```bash
propanes install-protocol
```

Then pick **propanes CLI** in the Terminal Bridge dialog. Security notes: the
token is stored per server origin in `~/.config/propanes/config.json` (0600);
`propanes://` links only ever use tokens for servers you have explicitly
logged into, so a web page cannot steer the CLI (or a token) to another host.

## 2. SSH gateway

For raw `ssh` interop (scripting, `-t`, jump hosts). A single in-process SSH
server on the control plane bridges to the same session plumbing — sshd never
runs on any pod, and users authenticate with their propanes account (password,
or an admin JWT pasted as the password):

```bash
ssh -p 2222 <user>@<gateway-host>                    # list your sessions
ssh -t -p 2222 <user>@<gateway-host> attach <id>     # attach
```

Enable by setting `SSH_GATEWAY_PORT=2222` on the server and exposing it with
`ops/ssh-gateway-service.yaml`. The host key persists next to the DB
(`ssh_host_ed25519_key`). Session visibility is scoped per workspace, same as
the admin API.

## 3. Local bridge (kubectl / ssh) — operator fallback

The original Terminal Bridge: a locally running propanes server osascripts
Terminal.app with `kubectl exec … tmux attach` (K8s deployments; requires
kubeconfig credentials with pods/exec) or `ssh user@host … tmux attach`
(machines with real sshd). Suitable for operators only — it hands the user
infrastructure credentials. Configured per admin hostname in the same dialog.
