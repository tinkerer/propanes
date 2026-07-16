// Phase 4 — self-service provisioning automation.
//
// Turns the manual `helm install ./charts/propanes-agent` flow (see
// charts/propanes-agent/) into an in-cluster API call so the admin UI can
// spin up (and tear down) a per-user launcher pod with one click. We do NOT
// pull in @kubernetes/client-node — the surface we need is tiny, so we talk
// to the API server directly over the in-cluster ServiceAccount token using
// node:https. The manifests below mirror the chart templates one-for-one:
//   - Secret  <fullname>-launcher-token   (launcherAuthSecret)
//   - Secret  propanes-agent-auth-<user>  (agentAuthSecret, optional seed)
//   - PVC     agent-home-<user>           (private credential disk)
//   - ServiceAccount <fullname>
//   - Deployment <fullname>               (launcher-only pod)
//   - Service <fullname>                  (noVNC + playwright-mcp)
//
// The RBAC that lets this pod's ServiceAccount create the above lives in the
// chart's autoprovision-rbac.yaml (must be applied once, cluster-side).

import { readFileSync, mkdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface ProvisionConfig {
  namespace: string;
  image: string;
  centralWsUrl: string;
  storageClassName: string;
  agentHomeSize: string;
  maxSessions: number;
  nfs: { server: string; path: string; mountPath: string; readOnly: boolean; perUser: boolean; localMount: string };
  vnc: { secretName: string; passwordKey: string };
  // Token baked into the per-user launcher secret. Under the current
  // single-token model (index.ts checks the global LAUNCHER_AUTH_TOKEN), the
  // per-user pod must present that same value, so we default to it. A future
  // phase can mint genuinely per-user tokens once the server verifies them
  // per launcher.
  launcherToken: string;
}

export function loadProvisionConfig(): ProvisionConfig {
  return {
    namespace: process.env.PROPANES_K8S_NAMESPACE || readNamespace() || 'platform',
    image: process.env.PROPANES_AGENT_IMAGE || 'wbacr2a63719e.azurecr.io/propanes-server:latest',
    centralWsUrl: process.env.PROPANES_CENTRAL_WS_URL || 'ws://propanes.platform.svc:3001/ws/launcher',
    storageClassName: process.env.PROPANES_AGENT_STORAGE_CLASS || 'managed-csi',
    agentHomeSize: process.env.PROPANES_AGENT_HOME_SIZE || '20Gi',
    maxSessions: Number(process.env.PROPANES_AGENT_MAX_SESSIONS || '3') || 3,
    nfs: {
      server: process.env.PROPANES_NFS_SERVER || 'mwbctnfs305622.file.core.windows.net',
      path: process.env.PROPANES_NFS_PATH || '/mwbctnfs305622/stage-src',
      mountPath: process.env.PROPANES_NFS_MOUNT || '/mnt/stage-nfs-src',
      readOnly: process.env.PROPANES_NFS_READONLY === '1',
      // Give each user an isolated subdirectory of the share instead of the
      // shared root, so no two operators share a working tree. Default on.
      perUser: process.env.PROPANES_NFS_PER_USER !== '0',
      // Where the control-plane itself mounts the share, so it can pre-create
      // the per-user subdir before the launcher pod mounts it (an nfs volume
      // pointed at a non-existent subpath fails to mount).
      localMount: process.env.PROPANES_NFS_LOCAL_MOUNT || '/mnt/stage-nfs-src',
    },
    vnc: {
      secretName: process.env.PROPANES_VNC_SECRET || 'propanes-secrets',
      passwordKey: process.env.PROPANES_VNC_PASSWORD_KEY || 'VNC_PASSWORD',
    },
    launcherToken: process.env.LAUNCHER_AUTH_TOKEN || '',
  };
}

function readNamespace(): string | null {
  try {
    return readFileSync(`${SA_DIR}/namespace`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** True when we're running inside a cluster with a mounted ServiceAccount. */
export function isProvisioningAvailable(): boolean {
  try {
    readFileSync(`${SA_DIR}/token`, 'utf8');
    return !!process.env.KUBERNETES_SERVICE_HOST;
  } catch {
    return false;
  }
}

// --- Name helpers: mirror charts/propanes-agent/templates/_helpers.tpl ---

export function sanitizeUsername(username: string): string {
  const slug = username.toLowerCase().replace(/_/g, '-').slice(0, 40).replace(/-+$/g, '');
  return slug;
}

export function fullName(username: string): string {
  return `propanes-agent-${sanitizeUsername(username)}`.slice(0, 63).replace(/-+$/g, '');
}

export function launcherIdFor(username: string): string {
  return `agent-${sanitizeUsername(username)}`;
}

// Per-user isolated NFS subpath, or the shared root when isolation is off.
export function nfsPathForUser(username: string, cfg: ProvisionConfig): string {
  const base = cfg.nfs.path.replace(/\/$/, '');
  return cfg.nfs.perUser ? `${base}/${sanitizeUsername(username)}` : base;
}

// Pre-create the per-user subdir on the share via the control-plane's own NFS
// mount, so the launcher pod's nfs volume (pointed at that subpath) can mount.
// No-op when isolation is off. Best-effort — logs and continues on failure.
export function ensureUserNfsDir(username: string, cfg: ProvisionConfig = loadProvisionConfig()): void {
  if (!cfg.nfs.perUser) return;
  const dir = `${cfg.nfs.localMount.replace(/\/$/, '')}/${sanitizeUsername(username)}`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`[provision] could not pre-create NFS dir ${dir}:`, err instanceof Error ? err.message : err);
  }
}

function pvcName(username: string): string {
  return `agent-home-${sanitizeUsername(username)}`;
}

function launcherTokenSecretName(username: string): string {
  return `${fullName(username)}-launcher-token`;
}

function agentAuthSecretName(username: string): string {
  return `propanes-agent-auth-${sanitizeUsername(username)}`;
}

function sessionTokenSecretName(username: string): string {
  return `${fullName(username)}-session-api`;
}

// The HTTP base agents inside the pod use to reach the propanes API — derived
// from the launcher WS URL (ws://host:port/ws/launcher -> http://host:port).
export function apiUrlFromWsUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws\/launcher\/?$/, '');
}

function labels(username: string, org?: string | null): Record<string, string> {
  const l: Record<string, string> = {
    'app.kubernetes.io/name': 'propanes-agent',
    'app.kubernetes.io/component': 'launcher',
    'app.kubernetes.io/managed-by': 'propanes-server',
    'propanes.io/user': sanitizeUsername(username),
  };
  if (org) l['propanes.io/org'] = org;
  return l;
}

// --- Manifest builders (pure — unit-testable without a cluster) ---

export function buildManifests(
  username: string,
  cfg: ProvisionConfig,
  opts: { org?: string | null; sessionToken?: string | null } = {},
): Record<string, unknown>[] {
  const user = sanitizeUsername(username);
  const name = fullName(username);
  const lbl = labels(username, opts.org);
  const selector = {
    'app.kubernetes.io/name': 'propanes-agent',
    'propanes.io/user': user,
  };

  const launcherSecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: launcherTokenSecretName(username), namespace: cfg.namespace, labels: lbl },
    type: 'Opaque',
    stringData: { token: cfg.launcherToken },
  };

  const agentAuthSecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: agentAuthSecretName(username), namespace: cfg.namespace, labels: lbl },
    type: 'Opaque',
    // Empty seed — the user logs into their own Claude/Codex account
    // interactively via noVNC; the token lands on their private PVC.
    stringData: {
      'claude-credentials.json': '',
      'claude-config.json': '',
      'codex-auth.json': '',
      'codex-config.toml': '',
    },
  };

  // Bearer token agent sessions use against the propanes API (PROPANES_TOKEN).
  // Minted for the pod's owner, so the org scoping applies to agents exactly
  // as it does to the user in the admin UI.
  const sessionTokenSecret = opts.sessionToken
    ? {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: sessionTokenSecretName(username), namespace: cfg.namespace, labels: lbl },
        type: 'Opaque',
        stringData: { token: opts.sessionToken },
      }
    : null;

  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName(username), namespace: cfg.namespace, labels: lbl },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: cfg.storageClassName,
      resources: { requests: { storage: cfg.agentHomeSize } },
    },
  };

  const serviceAccount = {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name, namespace: cfg.namespace, labels: lbl },
  };

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: cfg.namespace, labels: lbl },
    spec: {
      replicas: 1,
      // agent-home is an RWO disk: a RollingUpdate deadlocks on Multi-Attach
      // (the new pod can't mount while the old one holds the volume). Recreate
      // trades a few seconds of downtime for rolls that actually complete.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: lbl },
        spec: {
          serviceAccountName: name,
          containers: [
            {
              name: 'launcher',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              env: [
                { name: 'PROPANES_ROLE', value: 'launcher' },
                { name: 'SERVER_WS_URL', value: cfg.centralWsUrl },
                { name: 'LAUNCHER_ID', value: launcherIdFor(username) },
                { name: 'LAUNCHER_NAME', value: launcherIdFor(username) },
                {
                  name: 'LAUNCHER_AUTH_TOKEN',
                  valueFrom: { secretKeyRef: { name: launcherTokenSecretName(username), key: 'token' } },
                },
                { name: 'MAX_SESSIONS', value: String(cfg.maxSessions) },
                { name: 'DISPLAY', value: ':99' },
                { name: 'IS_SANDBOX', value: '1' },
                { name: 'AGENT_USER', value: 'propanes' },
                { name: 'AGENT_HOME', value: '/data/agent-home' },
                { name: 'AGENT_AUTH_SEED_DIR', value: '/var/run/propanes-agent-auth' },
                // The launcher entrypoint eagerly imports db/index.js, which
                // opens a SQLite handle at module load. Point it at a path on
                // the agent's own writable disk (the entrypoint creates +
                // chowns /data/agent-home to the propanes user) — the default
                // relative path lands in root-owned /app and crashes the
                // launcher (which runs as propanes) with SQLITE_CANTOPEN.
                { name: 'DB_PATH', value: '/data/agent-home/launcher.db' },
                {
                  name: 'VNC_PASSWORD',
                  valueFrom: { secretKeyRef: { name: cfg.vnc.secretName, key: cfg.vnc.passwordKey } },
                },
                // Agent-facing propanes API access: sessions inherit the pod
                // env, so every agent on this pod can call the feedback/session
                // API as this pod's owner.
                { name: 'PROPANES_API_URL', value: apiUrlFromWsUrl(cfg.centralWsUrl) },
                {
                  name: 'PROPANES_TOKEN',
                  valueFrom: {
                    secretKeyRef: { name: sessionTokenSecretName(username), key: 'token', optional: true },
                  },
                },
              ],
              ports: [
                { name: 'novnc', containerPort: 6080 },
                { name: 'playwright-mcp', containerPort: 8931 },
              ],
              volumeMounts: [
                { name: 'agent-home', mountPath: '/data' },
                { name: 'agent-auth', mountPath: '/var/run/propanes-agent-auth', readOnly: true },
                { name: 'stage-nfs-src', mountPath: cfg.nfs.mountPath, readOnly: cfg.nfs.readOnly },
              ],
              resources: {
                requests: { cpu: '500m', memory: '1Gi' },
                limits: { cpu: '2', memory: '4Gi' },
              },
            },
          ],
          volumes: [
            { name: 'agent-home', persistentVolumeClaim: { claimName: pvcName(username) } },
            { name: 'agent-auth', secret: { secretName: agentAuthSecretName(username), optional: true } },
            {
              name: 'stage-nfs-src',
              nfs: { server: cfg.nfs.server, path: nfsPathForUser(username, cfg), readOnly: cfg.nfs.readOnly },
            },
          ],
        },
      },
    },
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: cfg.namespace, labels: lbl },
    spec: {
      type: 'ClusterIP',
      selector,
      ports: [
        { name: 'novnc', port: 6080, targetPort: 'novnc' },
        { name: 'playwright-mcp', port: 8931, targetPort: 'playwright-mcp' },
      ],
    },
  };

  // Order matters for create: secrets + PVC + SA before the Deployment that
  // references them.
  return [
    launcherSecret,
    agentAuthSecret,
    ...(sessionTokenSecret ? [sessionTokenSecret] : []),
    pvc,
    serviceAccount,
    deployment,
    service,
  ];
}

// --- Kubernetes API plumbing ---

interface K8sResponse {
  status: number;
  body: any;
}

function apiHost(): { host: string; port: string } {
  return {
    host: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
    port: process.env.KUBERNETES_SERVICE_PORT || '443',
  };
}

function saToken(): string {
  return readFileSync(`${SA_DIR}/token`, 'utf8').trim();
}

function caCert(): Buffer | undefined {
  try {
    return readFileSync(`${SA_DIR}/ca.crt`);
  } catch {
    return undefined;
  }
}

function k8sFetch(method: string, path: string, body?: unknown): Promise<K8sResponse> {
  const { host, port } = apiHost();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host,
        port,
        path,
        method,
        ca: caCert(),
        headers: {
          Authorization: `Bearer ${saToken()}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Map a resource kind to its collection path under a namespace.
function collectionPath(kind: string, apiVersion: string, namespace: string): string {
  const base = apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`;
  const plural: Record<string, string> = {
    Secret: 'secrets',
    PersistentVolumeClaim: 'persistentvolumeclaims',
    ServiceAccount: 'serviceaccounts',
    Service: 'services',
    Deployment: 'deployments',
  };
  return `${base}/namespaces/${namespace}/${plural[kind]}`;
}

export interface ApplyResult {
  kind: string;
  name: string;
  action: 'created' | 'exists' | 'error';
  status: number;
  error?: string;
}

// Create-or-skip: POST the resource; a 409 means it already exists, which we
// treat as idempotent success. (Reprovisioning after a config change should
// deprovision first — Deployments/PVCs aren't updated in place here.)
async function createResource(manifest: Record<string, unknown>, namespace: string): Promise<ApplyResult> {
  const kind = String(manifest.kind);
  const apiVersion = String(manifest.apiVersion);
  const name = String((manifest.metadata as { name?: string })?.name || '');
  try {
    const res = await k8sFetch('POST', collectionPath(kind, apiVersion, namespace), manifest);
    if (res.status >= 200 && res.status < 300) return { kind, name, action: 'created', status: res.status };
    if (res.status === 409) return { kind, name, action: 'exists', status: res.status };
    return { kind, name, action: 'error', status: res.status, error: res.body?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { kind, name, action: 'error', status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function deleteResource(
  kind: string,
  apiVersion: string,
  name: string,
  namespace: string,
): Promise<ApplyResult> {
  try {
    const res = await k8sFetch('DELETE', `${collectionPath(kind, apiVersion, namespace)}/${name}`, {
      propagationPolicy: 'Foreground',
    });
    if (res.status >= 200 && res.status < 300) return { kind, name, action: 'created', status: res.status };
    if (res.status === 404) return { kind, name, action: 'exists', status: res.status };
    return { kind, name, action: 'error', status: res.status, error: res.body?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { kind, name, action: 'error', status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProvisionResult {
  ok: boolean;
  launcherId: string;
  namespace: string;
  resources: ApplyResult[];
}

export async function provisionUserPod(
  username: string,
  opts: { org?: string | null; sessionToken?: string | null } = {},
  cfg: ProvisionConfig = loadProvisionConfig(),
): Promise<ProvisionResult> {
  // Ensure the per-user NFS subdir exists before the pod tries to mount it.
  ensureUserNfsDir(username, cfg);
  const manifests = buildManifests(username, cfg, opts);
  const resources: ApplyResult[] = [];
  for (const m of manifests) {
    resources.push(await createResource(m, cfg.namespace));
  }
  const ok = resources.every((r) => r.action !== 'error');
  return { ok, launcherId: launcherIdFor(username), namespace: cfg.namespace, resources };
}

export async function deprovisionUserPod(
  username: string,
  opts: { deletePvc?: boolean } = {},
  cfg: ProvisionConfig = loadProvisionConfig(),
): Promise<ProvisionResult> {
  const name = fullName(username);
  const ns = cfg.namespace;
  const resources: ApplyResult[] = [];
  resources.push(await deleteResource('Deployment', 'apps/v1', name, ns));
  resources.push(await deleteResource('Service', 'v1', name, ns));
  resources.push(await deleteResource('ServiceAccount', 'v1', name, ns));
  resources.push(await deleteResource('Secret', 'v1', launcherTokenSecretName(username), ns));
  resources.push(await deleteResource('Secret', 'v1', agentAuthSecretName(username), ns));
  resources.push(await deleteResource('Secret', 'v1', sessionTokenSecretName(username), ns));
  // The PVC holds the user's private Claude/Codex login — keep it by default
  // so a redeploy doesn't force a re-login. Pass deletePvc to wipe it.
  if (opts.deletePvc) {
    resources.push(await deleteResource('PersistentVolumeClaim', 'v1', pvcName(username), ns));
  }
  const ok = resources.every((r) => r.action !== 'error');
  return { ok, launcherId: launcherIdFor(username), namespace: ns, resources };
}

export interface PodStatus {
  available: boolean;
  exists: boolean;
  replicas: number;
  readyReplicas: number;
  launcherId: string;
  message?: string;
}

export async function getUserPodStatus(
  username: string,
  cfg: ProvisionConfig = loadProvisionConfig(),
): Promise<PodStatus> {
  const base: PodStatus = {
    available: true,
    exists: false,
    replicas: 0,
    readyReplicas: 0,
    launcherId: launcherIdFor(username),
  };
  try {
    const res = await k8sFetch(
      'GET',
      `${collectionPath('Deployment', 'apps/v1', cfg.namespace)}/${fullName(username)}`,
    );
    if (res.status === 404) return base;
    if (res.status >= 200 && res.status < 300) {
      const status = res.body?.status || {};
      return {
        ...base,
        exists: true,
        replicas: status.replicas || 0,
        readyReplicas: status.readyReplicas || 0,
      };
    }
    return { ...base, message: res.body?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { ...base, message: err instanceof Error ? err.message : String(err) };
  }
}
