# ProPanes per-user agent pods

This chart installs one launcher-only ProPanes pod for one user. The central
`propanes` Deployment and SQLite database stay single-instance; this pod only
seeds that user's agent home, starts the headed browser/noVNC/Playwright MCP
stack, and connects `launcher-daemon` back to the central server over
`/ws/launcher`.

## Isolation model

- `agent-home-<user>` is a private ReadWriteOnce PVC mounted at `/data`. It
  holds that user's `.claude`, `.codex`, and related agent state.
- `/mnt/stage-nfs-src` is the org shared Azure Files NFS tree. Source code is
  shared at the org level while credentials are not.
- `propanes-agent-auth-<user>` is an optional seed Secret. Empty seed files are
  valid; the user can log in interactively through their pod's noVNC session.
- `LAUNCHER_AUTH_TOKEN` must be unique per user. The central server should bind
  each launcher id (`agent-<user>`) to `users.launcher_id` and reject cross-owner
  dispatch.

## Install

Create or choose a unique launcher token, then render or install:

```bash
helm template propanes-agent-maksym ./charts/propanes-agent \
  -n platform \
  -f ./charts/propanes-agent/examples/maksym.values.yaml

helm upgrade --install propanes-agent-maksym ./charts/propanes-agent \
  -n platform \
  -f ./charts/propanes-agent/examples/maksym.values.yaml \
  --set launcherAuthSecret.token="$LAUNCHER_AUTH_TOKEN" \
  --set image.tag="<current-propanes-server-tag>"
```

Then set the user's `launcher_id` in ProPanes to `agent-maksym`.

## Credentials

For an empty seed, leave the four `agentAuthSecret.data` values as empty
strings. To seed credentials, either edit a private values file or pre-create
the Secret and set:

```yaml
agentAuthSecret:
  create: false
  name: propanes-agent-auth-maksym
```

The expected Secret keys are:

- `claude-credentials.json`
- `claude-config.json`
- `codex-auth.json`
- `codex-config.toml`

## noVNC access

The Service exposes `novnc` on port `6080` inside the cluster. Ingress is off by
default. If enabling per-user noVNC routes, set `ingress.enabled=true`,
`ingress.host`, and secure it at the ingress/auth layer. The pod reads
`VNC_PASSWORD` from `vnc.secretName` and `vnc.passwordKey`.

## Optional server auto-provisioning RBAC

Manual or GitOps installs are the default. If the central ProPanes server later
creates/deletes agent pods through the Kubernetes API, install the optional RBAC:

```yaml
autoprovisionRbac:
  enabled: true
  serviceAccountName: propanes-autoprovisioner
```

This grants create/update/delete on Deployments, PVCs, Secrets, Services,
Ingresses, and ServiceAccounts in the release namespace. Do not bind it to the
central server until the provisioning code exists and validates user ownership.

## Teardown

```bash
helm uninstall propanes-agent-maksym -n platform
kubectl -n platform delete pvc agent-home-maksym
```

Deleting the PVC removes that user's local agent credentials and state. The NFS
source tree is shared and is not removed.

## Cost notes

Each user pod has its own managed disk and browser/VNC workload. Tune
`resources` and `launcher.maxSessions` per user. For idle users, scale the
Deployment to zero or uninstall the release and keep/delete the PVC based on
whether their local credentials should persist.
