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

### Hosts behind a browser-SSO edge (e.g. workbench / Cloudflare Access)

Some deployments front the HTTP/WS ingress with an SSO proxy that redirects
every non-browser request to a login page — so direct `propanes login` and the
attach WebSocket can't get through. Two CLI-side answers, no edge change:

```bash
# Log in through the browser (which carries the SSO cookie) AND point the CLI
# at the SSH gateway so sessions/attach tunnel around the edge:
propanes login --web --server https://propanes.example.com --gateway <gateway-host>
```

With a gateway configured, `propanes sessions` and `propanes attach <id>` run
over SSH to the gateway (propanes-native auth on a raw TCP LoadBalancer the
edge never sees) instead of the SSO-gated HTTP/WS API. The stored JWT is used
as the SSH password automatically (via `SSH_ASKPASS`), so there's no second
prompt. Detach from an attached session with the SSH escape: Enter, then `~.`.

The cleaner long-term fix is to exempt `/api/v1/*` and `/ws/*` from the edge
SSO (Propanes enforces its own auth there); then no gateway is needed and the
plain WebSocket path works. See mode 2 below for enabling the gateway.

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
