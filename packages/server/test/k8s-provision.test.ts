import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeUsername,
  fullName,
  launcherIdFor,
  buildManifests,
  type ProvisionConfig,
} from '../src/k8s-provision.ts';

const cfg: ProvisionConfig = {
  namespace: 'platform',
  image: 'registry.example/propanes-server:test',
  centralWsUrl: 'ws://propanes.platform.svc:3001/ws/launcher',
  storageClassName: 'managed-csi',
  agentHomeSize: '20Gi',
  maxSessions: 3,
  nfs: { server: 'nfs.example', path: '/share/stage-src', mountPath: '/mnt/stage-nfs-src', readOnly: false },
  vnc: { secretName: 'propanes-secrets', passwordKey: 'VNC_PASSWORD' },
  launcherToken: 'shared-token',
};

test('sanitizeUsername mirrors the helm _helpers.tpl rules', () => {
  assert.equal(sanitizeUsername('Maksym'), 'maksym');
  assert.equal(sanitizeUsername('foo_bar'), 'foo-bar');
  assert.equal(sanitizeUsername('trailing_'), 'trailing');
});

test('names derive from the sanitized username', () => {
  assert.equal(fullName('Maksym'), 'propanes-agent-maksym');
  assert.equal(launcherIdFor('Maksym'), 'agent-maksym');
});

test('buildManifests emits the full per-user resource set in dependency order', () => {
  const manifests = buildManifests('maksym', cfg, { org: 'default' });
  const kinds = manifests.map((m) => m.kind);
  assert.deepEqual(kinds, ['Secret', 'Secret', 'PersistentVolumeClaim', 'ServiceAccount', 'Deployment', 'Service']);
});

test('deployment wires the launcher identity, private disk, and shared NFS', () => {
  const manifests = buildManifests('maksym', cfg, { org: 'default' });
  const dep = manifests.find((m) => m.kind === 'Deployment') as any;
  const container = dep.spec.template.spec.containers[0];
  const env = Object.fromEntries(
    container.env.filter((e: any) => 'value' in e).map((e: any) => [e.name, e.value]),
  );
  assert.equal(env.LAUNCHER_ID, 'agent-maksym');
  assert.equal(env.PROPANES_ROLE, 'launcher');
  assert.equal(env.SERVER_WS_URL, cfg.centralWsUrl);
  assert.equal(env.AGENT_HOME, '/data/agent-home');
  // Launcher eagerly opens SQLite at import — must sit on a writable disk.
  assert.equal(env.DB_PATH, '/data/agent-home/launcher.db');

  // Launcher token comes from the per-user secret, not inline.
  const tokenEnv = container.env.find((e: any) => e.name === 'LAUNCHER_AUTH_TOKEN');
  assert.equal(tokenEnv.valueFrom.secretKeyRef.name, 'propanes-agent-maksym-launcher-token');

  // Private credential disk + shared org NFS.
  const vols = dep.spec.template.spec.volumes;
  const home = vols.find((v: any) => v.name === 'agent-home');
  assert.equal(home.persistentVolumeClaim.claimName, 'agent-home-maksym');
  const nfs = vols.find((v: any) => v.name === 'stage-nfs-src');
  assert.equal(nfs.nfs.server, 'nfs.example');
});

test('deployment and pvc carry the user/org labels for selection', () => {
  const manifests = buildManifests('maksym', cfg, { org: 'default' });
  const dep = manifests.find((m) => m.kind === 'Deployment') as any;
  assert.equal(dep.metadata.labels['propanes.io/user'], 'maksym');
  assert.equal(dep.metadata.labels['propanes.io/org'], 'default');
  assert.equal(dep.spec.selector.matchLabels['propanes.io/user'], 'maksym');
});

test('agent-auth seed secret ships empty (user logs in interactively)', () => {
  const manifests = buildManifests('maksym', cfg);
  const authSecret = manifests.filter((m) => m.kind === 'Secret')[1] as any;
  assert.equal(authSecret.metadata.name, 'propanes-agent-auth-maksym');
  assert.equal(authSecret.stringData['claude-credentials.json'], '');
});
