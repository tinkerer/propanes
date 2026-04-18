import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { cachedTargets, ensureTargetsLoaded } from '../components/DispatchTargetSelect.js';
import { spawnTerminal } from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';

type FilterMode = 'all' | 'machines' | 'sprites';

const filter = signal<FilterMode>('all');
const machines = signal<any[]>([]);
const harnessConfigs = signal<any[]>([]);
const liveHarnesses = signal<any[]>([]);
const spriteConfigs = signal<any[]>([]);
const applications = signal<any[]>([]);
const launchers = signal<any[]>([]);
const loading = signal(true);
const error = signal('');
const expandedMachines = signal<Set<string>>(new Set());

// Machine form state
const showMachineForm = signal(false);
const machineEditingId = signal<string | null>(null);
const mFormName = signal('');
const mFormHostname = signal('');
const mFormAddress = signal('');
const mFormType = signal<'local' | 'remote' | 'cloud'>('remote');
const mFormTags = signal('');
const mFormAdminUrl = signal('');
const mFormLoading = signal(false);
const mFormError = signal('');

// Harness form state
const showHarnessForm = signal(false);
const harnessEditingId = signal<string | null>(null);
const hFormName = signal('');
const hFormAppId = signal('');
const hFormMachineId = signal('');
const hFormAppImage = signal('');
const hFormAppPort = signal('');
const hFormAppInternalPort = signal('');
const hFormServerPort = signal('');
const hFormBrowserMcpPort = signal('');
const hFormTargetAppUrl = signal('');
const hFormComposeDir = signal('');
const hFormEnvVars = signal('');
const hFormHostTerminalAccess = signal(false);
const hFormClaudeHomePath = signal('');
const hFormAnthropicApiKey = signal('');
const hFormLoading = signal(false);
const hFormError = signal('');

// Sprite form state
const showSpriteForm = signal(false);
const spriteEditingId = signal<string | null>(null);
const sFormName = signal('');
const sFormSpriteName = signal('');
const sFormToken = signal('');
const sFormMaxSessions = signal('3');
const sFormDefaultCwd = signal('');
const sFormAppId = signal('');
const sFormProvisionNow = signal(true);
const sFormLoading = signal(false);
const sFormError = signal('');

// Admin URL health state: machineId -> 'checking' | 'alive' | 'dead'
const adminHealthStatus = signal<Record<string, 'checking' | 'alive' | 'dead'>>({});
const adminActionLoading = signal<Record<string, boolean>>({});

// Harness health / auth / setup state
const healthResults = signal<Record<string, any>>({});
const authCheckResults = signal<Record<string, any>>({});
const containerCheckResults = signal<Record<string, any>>({});
const containerCheckLoading = signal<Record<string, boolean>>({});
const expandedHealth = signal<string | null>(null);
const expandedSetupWizard = signal<string | null>(null);

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [machineList, configs, live, sprites, appList, launcherList] = await Promise.all([
      api.getMachines().catch(() => []),
      api.getHarnessConfigs().catch(() => []),
      api.getHarnesses().then(r => r.harnesses).catch(() => []),
      api.getSpriteConfigs().catch(() => []),
      api.getApplications().catch(() => []),
      api.getLaunchers().then(r => r.launchers).catch(() => []),
    ]);
    machines.value = machineList;
    harnessConfigs.value = configs;
    liveHarnesses.value = live;
    spriteConfigs.value = sprites;
    applications.value = appList;
    launchers.value = launcherList;
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }

  // Probe admin URLs in parallel
  probeAdminUrls();
}

async function probeAdminUrls() {
  const withAdmin = machines.value.filter(m => m.adminUrl);
  if (!withAdmin.length) return;
  const statuses = { ...adminHealthStatus.value };
  for (const m of withAdmin) statuses[m.id] = 'checking';
  adminHealthStatus.value = statuses;

  await Promise.all(withAdmin.map(async (m) => {
    try {
      const result = await api.checkMachineAdminHealth(m.id);
      adminHealthStatus.value = { ...adminHealthStatus.value, [m.id]: result.alive ? 'alive' : 'dead' };
    } catch {
      adminHealthStatus.value = { ...adminHealthStatus.value, [m.id]: 'dead' };
    }
  }));
}

async function handleAdminStart(machineId: string) {
  adminActionLoading.value = { ...adminActionLoading.value, [machineId]: true };
  try {
    await api.startMachineAdmin(machineId);
    // Wait a few seconds for the server to come up, then re-probe
    setTimeout(() => {
      probeAdminUrls();
      adminActionLoading.value = { ...adminActionLoading.value, [machineId]: false };
    }, 5000);
  } catch {
    adminActionLoading.value = { ...adminActionLoading.value, [machineId]: false };
  }
}

async function handleAdminStop(machineId: string) {
  adminActionLoading.value = { ...adminActionLoading.value, [machineId]: true };
  try {
    await api.stopMachineAdmin(machineId);
    setTimeout(() => {
      probeAdminUrls();
      adminActionLoading.value = { ...adminActionLoading.value, [machineId]: false };
    }, 3000);
  } catch {
    adminActionLoading.value = { ...adminActionLoading.value, [machineId]: false };
  }
}

// ----- Machine helpers -----
function resetMachineForm() {
  mFormName.value = '';
  mFormHostname.value = '';
  mFormAddress.value = '';
  mFormType.value = 'remote';
  mFormTags.value = '';
  mFormAdminUrl.value = '';
  mFormError.value = '';
  machineEditingId.value = null;
}

function openAddMachine() {
  resetMachineForm();
  showMachineForm.value = true;
  showHarnessForm.value = false;
  showSpriteForm.value = false;
}

function openEditMachine(m: any) {
  machineEditingId.value = m.id;
  mFormName.value = m.name;
  mFormHostname.value = m.hostname || '';
  mFormAddress.value = m.address || '';
  mFormType.value = m.type || 'remote';
  mFormTags.value = (m.tags || []).join(', ');
  mFormAdminUrl.value = m.adminUrl || '';
  mFormError.value = '';
  showMachineForm.value = true;
}

async function handleMachineSubmit() {
  if (!mFormName.value.trim()) { mFormError.value = 'Name is required'; return; }
  mFormLoading.value = true;
  mFormError.value = '';
  try {
    const data: Record<string, unknown> = {
      name: mFormName.value.trim(),
      hostname: mFormHostname.value.trim() || null,
      address: mFormAddress.value.trim() || null,
      type: mFormType.value,
      tags: mFormTags.value.split(',').map(t => t.trim()).filter(Boolean),
      adminUrl: mFormAdminUrl.value.trim() || null,
    };
    if (machineEditingId.value) {
      await api.updateMachine(machineEditingId.value, data);
    } else {
      await api.createMachine(data);
    }
    showMachineForm.value = false;
    resetMachineForm();
    await loadAll();
  } catch (err: any) {
    mFormError.value = err.message;
  } finally {
    mFormLoading.value = false;
  }
}

async function handleMachineDelete(id: string, name: string) {
  try {
    await api.deleteMachine(id);
    trackDeletion('machines', id, name);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

// ----- Harness helpers -----
function resetHarnessForm() {
  hFormName.value = '';
  hFormAppId.value = '';
  hFormMachineId.value = '';
  hFormAppImage.value = '';
  hFormAppPort.value = '';
  hFormAppInternalPort.value = '';
  hFormServerPort.value = '';
  hFormBrowserMcpPort.value = '';
  hFormTargetAppUrl.value = '';
  hFormComposeDir.value = '';
  hFormEnvVars.value = '';
  hFormHostTerminalAccess.value = false;
  hFormClaudeHomePath.value = '';
  hFormAnthropicApiKey.value = '';
  hFormError.value = '';
  harnessEditingId.value = null;
}

function openAddHarness(machineId?: string) {
  resetHarnessForm();
  if (machineId) hFormMachineId.value = machineId;
  showHarnessForm.value = true;
  showMachineForm.value = false;
  showSpriteForm.value = false;
}

function openEditHarness(h: any) {
  harnessEditingId.value = h.id;
  hFormName.value = h.name;
  hFormAppId.value = h.appId || '';
  hFormMachineId.value = h.machineId || '';
  hFormAppImage.value = h.appImage || '';
  hFormAppPort.value = h.appPort ? String(h.appPort) : '';
  hFormAppInternalPort.value = h.appInternalPort ? String(h.appInternalPort) : '';
  hFormServerPort.value = h.serverPort ? String(h.serverPort) : '';
  hFormBrowserMcpPort.value = h.browserMcpPort ? String(h.browserMcpPort) : '';
  hFormTargetAppUrl.value = h.targetAppUrl || '';
  hFormComposeDir.value = h.composeDir || '';
  hFormEnvVars.value = h.envVars ? JSON.stringify(h.envVars, null, 2) : '';
  hFormHostTerminalAccess.value = h.hostTerminalAccess ?? false;
  hFormClaudeHomePath.value = h.claudeHomePath || '';
  hFormAnthropicApiKey.value = h.anthropicApiKey || '';
  hFormError.value = '';
  showHarnessForm.value = true;
}

async function handleHarnessSubmit() {
  if (!hFormName.value.trim()) { hFormError.value = 'Name is required'; return; }
  hFormLoading.value = true;
  hFormError.value = '';
  try {
    let envVars = null;
    if (hFormEnvVars.value.trim()) {
      try { envVars = JSON.parse(hFormEnvVars.value); } catch { hFormError.value = 'Invalid JSON for env vars'; hFormLoading.value = false; return; }
    }
    const data: Record<string, unknown> = {
      name: hFormName.value.trim(),
      appId: hFormAppId.value || null,
      machineId: hFormMachineId.value || null,
      appImage: hFormAppImage.value.trim() || null,
      appPort: hFormAppPort.value ? parseInt(hFormAppPort.value) : null,
      appInternalPort: hFormAppInternalPort.value ? parseInt(hFormAppInternalPort.value) : null,
      serverPort: hFormServerPort.value ? parseInt(hFormServerPort.value) : null,
      browserMcpPort: hFormBrowserMcpPort.value ? parseInt(hFormBrowserMcpPort.value) : null,
      targetAppUrl: hFormTargetAppUrl.value.trim() || null,
      composeDir: hFormComposeDir.value.trim() || null,
      envVars,
      hostTerminalAccess: hFormHostTerminalAccess.value,
      claudeHomePath: hFormClaudeHomePath.value.trim() || null,
      anthropicApiKey: hFormAnthropicApiKey.value.trim() || null,
    };
    if (harnessEditingId.value) {
      await api.updateHarnessConfig(harnessEditingId.value, data);
    } else {
      await api.createHarnessConfig(data);
    }
    showHarnessForm.value = false;
    resetHarnessForm();
    await loadAll();
  } catch (err: any) {
    hFormError.value = err.message;
  } finally {
    hFormLoading.value = false;
  }
}

async function handleHarnessDelete(id: string, name: string) {
  try {
    await api.deleteHarnessConfig(id);
    trackDeletion('harnesses', id, name);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleHarnessStart(id: string) {
  try { await api.startHarness(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleHarnessStop(id: string) {
  try { await api.stopHarness(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleLaunchHarnessSession(id: string) {
  try {
    const result = await api.launchHarnessSession(id, { permissionProfile: 'yolo' });
    if (result.sessionId) window.location.hash = '#/sessions';
  } catch (err: any) { error.value = err.message; }
}

async function handleSpawnTerminal(harnessConfigId: string, launcherId: string) {
  try {
    const result = await api.spawnTerminal({ harnessConfigId, launcherId });
    if (result.sessionId) window.location.hash = '#/sessions';
  } catch (err: any) { error.value = err.message; }
}

async function handleSpawnHostTerminal(launcherId: string) {
  try {
    const result = await api.spawnTerminal({ launcherId });
    if (result.sessionId) window.location.hash = '#/sessions';
  } catch (err: any) { error.value = err.message; }
}

function getLauncherForHarness(h: any): any | null {
  if (h.launcherId) return launchers.value.find(l => l.id === h.launcherId) || null;
  if (h.machineId) return launchers.value.find(l => l.machineId === h.machineId && l.online) || null;
  return null;
}

async function handleRestartLauncher(launcherId: string) {
  try { await api.restartLauncher(launcherId); error.value = ''; } catch (err: any) { error.value = err.message; }
}

async function handleHealthCheck(launcherId: string, harnessId: string) {
  try {
    const result = await api.getLauncherHealth(launcherId);
    healthResults.value = { ...healthResults.value, [harnessId]: result };
    expandedHealth.value = harnessId;
  } catch (err: any) {
    healthResults.value = { ...healthResults.value, [harnessId]: { error: err.message } };
    expandedHealth.value = harnessId;
  }
}

async function handleCheckContainerClaude(harnessId: string) {
  containerCheckLoading.value = { ...containerCheckLoading.value, [harnessId]: true };
  try {
    const result = await api.checkContainerClaude(harnessId);
    containerCheckResults.value = { ...containerCheckResults.value, [harnessId]: result };
  } catch (err: any) {
    containerCheckResults.value = { ...containerCheckResults.value, [harnessId]: { error: err.message } };
  } finally {
    containerCheckLoading.value = { ...containerCheckLoading.value, [harnessId]: false };
  }
}

async function handleCheckAuth(harnessId: string) {
  try {
    const result = await api.checkClaudeAuth(harnessId);
    authCheckResults.value = { ...authCheckResults.value, [harnessId]: result };
  } catch (err: any) {
    authCheckResults.value = { ...authCheckResults.value, [harnessId]: { error: err.message } };
  }
}

// ----- Sprite helpers -----
function resetSpriteForm() {
  sFormName.value = '';
  sFormSpriteName.value = '';
  sFormToken.value = '';
  sFormMaxSessions.value = '3';
  sFormDefaultCwd.value = '';
  sFormAppId.value = '';
  sFormProvisionNow.value = true;
  sFormError.value = '';
  spriteEditingId.value = null;
}

function openAddSprite() {
  resetSpriteForm();
  showSpriteForm.value = true;
  showMachineForm.value = false;
  showHarnessForm.value = false;
}

function openEditSprite(s: any) {
  spriteEditingId.value = s.id;
  sFormName.value = s.name;
  sFormSpriteName.value = s.spriteName;
  sFormToken.value = s.token || '';
  sFormMaxSessions.value = String(s.maxSessions);
  sFormDefaultCwd.value = s.defaultCwd || '';
  sFormAppId.value = s.appId || '';
  sFormProvisionNow.value = false;
  sFormError.value = '';
  showSpriteForm.value = true;
}

async function handleSpriteSubmit() {
  if (!sFormName.value.trim()) { sFormError.value = 'Name is required'; return; }
  sFormLoading.value = true;
  sFormError.value = '';
  try {
    const data: Record<string, unknown> = {
      name: sFormName.value.trim(),
      spriteName: sFormSpriteName.value.trim() || undefined,
      token: sFormToken.value.trim() || null,
      maxSessions: parseInt(sFormMaxSessions.value) || 3,
      defaultCwd: sFormDefaultCwd.value.trim() || null,
      appId: sFormAppId.value || null,
    };
    if (spriteEditingId.value) {
      await api.updateSpriteConfig(spriteEditingId.value, data);
    } else {
      data.provisionNow = sFormProvisionNow.value;
      await api.createSpriteConfig(data);
    }
    showSpriteForm.value = false;
    resetSpriteForm();
    await loadAll();
  } catch (err: any) {
    sFormError.value = err.message;
  } finally {
    sFormLoading.value = false;
  }
}

async function handleSpriteDelete(id: string, name: string) {
  try { await api.deleteSpriteConfig(id); trackDeletion('sprites', id, name); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteProvision(id: string) {
  try { await api.provisionSprite(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteDestroy(id: string) {
  try { await api.destroySprite(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteCheckStatus(id: string) {
  try { await api.checkSpriteStatus(id); await loadAll(); } catch (err: any) { error.value = err.message; }
}

async function handleSpriteLaunchSession(id: string) {
  try {
    const result = await api.launchSpriteSession(id, { permissionProfile: 'interactive' });
    if (result.sessionId) window.location.hash = '#/sessions';
  } catch (err: any) { error.value = err.message; }
}

// ----- Utility -----
function harnessStatusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--pw-success, #22c55e)';
    case 'starting': return 'var(--pw-warning, #eab308)';
    case 'error': return 'var(--pw-danger, #ef4444)';
    default: return 'var(--pw-text-faint)';
  }
}

function spriteStatusColor(status: string): string {
  switch (status) {
    case 'running': case 'warm': return 'var(--pw-success, #22c55e)';
    case 'cold': return 'var(--pw-primary, #3b82f6)';
    case 'error': return 'var(--pw-danger, #ef4444)';
    case 'destroyed': return 'var(--pw-text-faint)';
    default: return 'var(--pw-text-muted)';
  }
}

function getAppName(appId: string | null): string {
  if (!appId) return '';
  const app = applications.value.find(a => a.id === appId);
  return app?.name || appId.slice(0, 8);
}

function getMachineName(machineId: string | null): string {
  if (!machineId) return 'Unassigned';
  const m = machines.value.find(x => x.id === machineId);
  return m?.name || machineId.slice(0, 8);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function getHarnessUrl(h: any): string | null {
  if (h.status !== 'running') return null;
  const machine = machines.value.find(m => m.id === h.machineId);
  if (!machine?.address) return null;
  const port = h.serverPort || 3001;
  return `http://${machine.address}:${port}/admin/`;
}

function toggleExpanded(machineId: string) {
  const next = new Set(expandedMachines.value);
  if (next.has(machineId)) next.delete(machineId);
  else next.add(machineId);
  expandedMachines.value = next;
}

function getAppsForMachine(machineId: string): any[] {
  const appIds = new Set<string>();
  for (const h of harnessConfigs.value) {
    if (h.machineId === machineId && h.appId) appIds.add(h.appId);
  }
  return applications.value.filter(a => appIds.has(a.id));
}

function getRepoName(projectDir: string | null | undefined): string {
  if (!projectDir) return '';
  const parts = projectDir.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/');
}

type RepoEntry = { app: any; infraType: 'machine' | 'sprite'; infraId: string; infraName: string };

function buildRepoMap(): Map<string, RepoEntry[]> {
  const map = new Map<string, RepoEntry[]>();
  for (const m of machines.value) {
    for (const app of getAppsForMachine(m.id)) {
      const key = app.projectDir || app.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ app, infraType: 'machine', infraId: m.id, infraName: m.name });
    }
  }
  for (const s of spriteConfigs.value) {
    if (s.appId) {
      const app = applications.value.find(a => a.id === s.appId);
      if (app) {
        const key = app.projectDir || app.id;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ app, infraType: 'sprite', infraId: s.id, infraName: s.name });
      }
    }
  }
  return map;
}

function getUnassociatedApps(): any[] {
  const assignedIds = new Set<string>();
  for (const h of harnessConfigs.value) {
    if (h.appId) assignedIds.add(h.appId);
  }
  for (const s of spriteConfigs.value) {
    if (s.appId) assignedIds.add(s.appId);
  }
  return applications.value.filter(a => !assignedIds.has(a.id));
}

function AppLink({ app }: { app: any }) {
  return (
    <a href={`#/app/${app.id}/feedback`} style="color:var(--pw-primary);text-decoration:none;font-weight:500">
      {app.name}
    </a>
  );
}

function SharedRepoBadge({ repoKey, currentInfraId }: { repoKey: string; currentInfraId: string }) {
  const repoMap = buildRepoMap();
  const entries = repoMap.get(repoKey) || [];
  const others = entries.filter(e => e.infraId !== currentInfraId);
  if (others.length === 0) return null;
  const names = others.map(e => e.infraName).join(', ');
  return (
    <span
      title={`Also on: ${names}`}
      style="font-size:10px;padding:1px 5px;border-radius:3px;background:var(--pw-warning, #f59e0b)20;color:var(--pw-warning, #f59e0b);margin-left:4px;cursor:help"
    >
      shared: {names}
    </span>
  );
}

// ----- Sub-components -----

function MachineForm() {
  return (
    <div class="agent-form" style="margin-bottom:20px">
      <h3 style="margin-top:0">{machineEditingId.value ? 'Edit Machine' : 'Add Machine'}</h3>
      {mFormError.value && <div class="error-msg">{mFormError.value}</div>}
      <div class="form-group">
        <label>Name</label>
        <input class="form-input" value={mFormName.value} onInput={(e) => mFormName.value = (e.target as HTMLInputElement).value} placeholder="Mac Mini Lab" />
      </div>
      <div class="form-group">
        <label>Hostname</label>
        <input class="form-input" value={mFormHostname.value} onInput={(e) => mFormHostname.value = (e.target as HTMLInputElement).value} placeholder="lab-mini.local" />
      </div>
      <div class="form-group">
        <label>Address</label>
        <input class="form-input" value={mFormAddress.value} onInput={(e) => mFormAddress.value = (e.target as HTMLInputElement).value} placeholder="10.0.0.5 or lab.tailnet" />
      </div>
      <div class="form-group">
        <label>Type</label>
        <select class="form-input" value={mFormType.value} onChange={(e) => mFormType.value = (e.target as HTMLSelectElement).value as any}>
          <option value="local">Local</option>
          <option value="remote">Remote</option>
          <option value="cloud">Cloud</option>
        </select>
      </div>
      <div class="form-group">
        <label>Admin URL</label>
        <input class="form-input" value={mFormAdminUrl.value} onInput={(e) => mFormAdminUrl.value = (e.target as HTMLInputElement).value} placeholder="http://dl:3001/admin/" />
      </div>
      <div class="form-group">
        <label>Tags (comma-separated)</label>
        <input class="form-input" value={mFormTags.value} onInput={(e) => mFormTags.value = (e.target as HTMLInputElement).value} placeholder="gpu, arm64, staging" />
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" onClick={handleMachineSubmit} disabled={mFormLoading.value}>
          {mFormLoading.value ? 'Saving...' : machineEditingId.value ? 'Update' : 'Create'}
        </button>
        <button class="btn" onClick={() => { showMachineForm.value = false; resetMachineForm(); }}>Cancel</button>
      </div>
    </div>
  );
}

function HarnessForm() {
  return (
    <div class="agent-form" style="margin-bottom:20px">
      <h3 style="margin-top:0">{harnessEditingId.value ? 'Edit Harness' : 'Create Harness'}</h3>
      {hFormError.value && <div class="error-msg">{hFormError.value}</div>}
      <div class="form-group">
        <label>Name</label>
        <input class="form-input" value={hFormName.value} onInput={(e) => hFormName.value = (e.target as HTMLInputElement).value} placeholder="My App Harness" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Application</label>
          <select class="form-input" value={hFormAppId.value} onChange={(e) => hFormAppId.value = (e.target as HTMLSelectElement).value}>
            <option value="">-- None --</option>
            {applications.value.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div class="form-group">
          <label>Machine</label>
          <select class="form-input" value={hFormMachineId.value} onChange={(e) => hFormMachineId.value = (e.target as HTMLSelectElement).value}>
            <option value="">-- Unassigned --</option>
            {machines.value.map(m => <option key={m.id} value={m.id}>{m.name} ({m.status})</option>)}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>App Image</label>
        <input class="form-input" value={hFormAppImage.value} onInput={(e) => hFormAppImage.value = (e.target as HTMLInputElement).value} placeholder="my-org/my-app:latest" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
        <div class="form-group">
          <label>App Port</label>
          <input class="form-input" type="number" value={hFormAppPort.value} onInput={(e) => hFormAppPort.value = (e.target as HTMLInputElement).value} placeholder="8080" />
        </div>
        <div class="form-group">
          <label>Internal Port</label>
          <input class="form-input" type="number" value={hFormAppInternalPort.value} onInput={(e) => hFormAppInternalPort.value = (e.target as HTMLInputElement).value} placeholder="80" />
        </div>
        <div class="form-group">
          <label>Server Port</label>
          <input class="form-input" type="number" value={hFormServerPort.value} onInput={(e) => hFormServerPort.value = (e.target as HTMLInputElement).value} placeholder="3001" />
        </div>
        <div class="form-group">
          <label>Browser MCP Port</label>
          <input class="form-input" type="number" value={hFormBrowserMcpPort.value} onInput={(e) => hFormBrowserMcpPort.value = (e.target as HTMLInputElement).value} placeholder="8931" />
        </div>
      </div>
      <div class="form-group">
        <label>Target App URL</label>
        <input class="form-input" value={hFormTargetAppUrl.value} onInput={(e) => hFormTargetAppUrl.value = (e.target as HTMLInputElement).value} placeholder="http://pw-app:80" />
      </div>
      <div class="form-group">
        <label>Compose Dir</label>
        <input class="form-input" value={hFormComposeDir.value} onInput={(e) => hFormComposeDir.value = (e.target as HTMLInputElement).value} placeholder="/path/to/docker-compose-dir" />
      </div>
      <div class="form-group">
        <label>Env Vars (JSON)</label>
        <textarea class="form-input" value={hFormEnvVars.value} onInput={(e) => hFormEnvVars.value = (e.target as HTMLTextAreaElement).value} placeholder='{"KEY": "value"}' rows={3} style="font-family:monospace;font-size:12px" />
      </div>
      <div style="margin-top:12px;padding:10px;border:1px solid var(--pw-border);border-radius:6px">
        <div style="font-weight:600;font-size:12px;margin-bottom:8px;color:var(--pw-text-muted)">Claude Auth</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label>Claude Home Path</label>
            <input class="form-input" value={hFormClaudeHomePath.value} onInput={(e) => hFormClaudeHomePath.value = (e.target as HTMLInputElement).value} placeholder="~/.claude" />
          </div>
          <div class="form-group">
            <label>Anthropic API Key</label>
            <input class="form-input" type="password" value={hFormAnthropicApiKey.value} onInput={(e) => hFormAnthropicApiKey.value = (e.target as HTMLInputElement).value} placeholder="sk-ant-..." />
          </div>
        </div>
      </div>
      <div class="form-group" style="margin-top:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" checked={hFormHostTerminalAccess.value} onChange={(e) => hFormHostTerminalAccess.value = (e.target as HTMLInputElement).checked} />
          Host terminal access
          <span style="font-size:11px;color:var(--pw-text-muted)">(allow opening shells on the host machine)</span>
        </label>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" onClick={handleHarnessSubmit} disabled={hFormLoading.value}>
          {hFormLoading.value ? 'Saving...' : harnessEditingId.value ? 'Update' : 'Create'}
        </button>
        <button class="btn" onClick={() => { showHarnessForm.value = false; resetHarnessForm(); }}>Cancel</button>
      </div>
    </div>
  );
}

function SpriteForm() {
  return (
    <div class="agent-form" style="margin-bottom:20px">
      <h3 style="margin-top:0">{spriteEditingId.value ? 'Edit Sprite' : 'Create Sprite'}</h3>
      {sFormError.value && <div class="error-msg">{sFormError.value}</div>}
      <div class="form-group">
        <label>Display Name</label>
        <input class="form-input" value={sFormName.value} onInput={(e) => sFormName.value = (e.target as HTMLInputElement).value} placeholder="My Sprite" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Sprite Name <span style="font-size:11px;color:var(--pw-text-muted)">(API identifier)</span></label>
          <input class="form-input" value={sFormSpriteName.value} onInput={(e) => sFormSpriteName.value = (e.target as HTMLInputElement).value} placeholder="my-sprite" />
        </div>
        <div class="form-group">
          <label>Application</label>
          <select class="form-input" value={sFormAppId.value} onChange={(e) => sFormAppId.value = (e.target as HTMLSelectElement).value}>
            <option value="">-- None --</option>
            {applications.value.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Token <span style="font-size:11px;color:var(--pw-text-muted)">(optional)</span></label>
        <input class="form-input" type="password" value={sFormToken.value} onInput={(e) => sFormToken.value = (e.target as HTMLInputElement).value} placeholder="sprites_..." />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label>Max Sessions</label>
          <input class="form-input" type="number" value={sFormMaxSessions.value} onInput={(e) => sFormMaxSessions.value = (e.target as HTMLInputElement).value} placeholder="3" />
        </div>
        <div class="form-group">
          <label>Default CWD</label>
          <input class="form-input" value={sFormDefaultCwd.value} onInput={(e) => sFormDefaultCwd.value = (e.target as HTMLInputElement).value} placeholder="/home/user/project" />
        </div>
      </div>
      {!spriteEditingId.value && (
        <div class="form-group" style="margin-top:8px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" checked={sFormProvisionNow.value} onChange={(e) => sFormProvisionNow.value = (e.target as HTMLInputElement).checked} />
            Provision now
            <span style="font-size:11px;color:var(--pw-text-muted)">(create via Fly.io API immediately)</span>
          </label>
        </div>
      )}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" onClick={handleSpriteSubmit} disabled={sFormLoading.value}>
          {sFormLoading.value ? 'Saving...' : spriteEditingId.value ? 'Update' : 'Create'}
        </button>
        <button class="btn" onClick={() => { showSpriteForm.value = false; resetSpriteForm(); }}>Cancel</button>
      </div>
    </div>
  );
}

function HarnessSubCard({ h }: { h: any }) {
  const launcher = getLauncherForHarness(h);
  const caps = launcher?.capabilities;
  const health = healthResults.value[h.id];
  const authCheck = authCheckResults.value[h.id];
  const isHealthExpanded = expandedHealth.value === h.id;

  return (
    <div class="agent-card" style="margin:0">
      <div class="agent-card-body">
        <div class="agent-card-top">
          <div class="agent-card-name">
            {h.name}
            <span class="agent-badge" style={`background:${harnessStatusColor(h.status)};color:#fff;margin-left:8px`}>
              {h.status.toUpperCase()}
            </span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <SetupAssistButton entityType="harness" entityId={h.id} entityLabel={h.name} />
            {h.status === 'stopped' || h.status === 'error' ? (
              <button class="btn btn-sm btn-primary" onClick={() => handleHarnessStart(h.id)} disabled={!h.machineId}>Start</button>
            ) : (
              <>
                <button class="btn btn-sm" onClick={() => handleLaunchHarnessSession(h.id)}>Session</button>
                {h.launcherId && <button class="btn btn-sm" onClick={() => handleSpawnTerminal(h.id, h.launcherId)}>Terminal</button>}
                {h.hostTerminalAccess && h.launcherId && <button class="btn btn-sm" onClick={() => handleSpawnHostTerminal(h.launcherId)}>Host Terminal</button>}
                <button
                  class="btn btn-sm"
                  style={expandedSetupWizard.value === h.id ? 'background:var(--pw-primary);color:#fff' : ''}
                  onClick={() => expandedSetupWizard.value = expandedSetupWizard.value === h.id ? null : h.id}
                >Setup</button>
                <button class="btn btn-sm" onClick={() => handleHarnessStop(h.id)}>Stop</button>
              </>
            )}
            {launcher && <button class="btn btn-sm" onClick={() => handleHealthCheck(launcher.id, h.id)}>Health</button>}
            {launcher && <button class="btn btn-sm" onClick={() => handleCheckAuth(h.id)}>Check Auth</button>}
            {launcher && <button class="btn btn-sm" onClick={() => handleRestartLauncher(launcher.id)}>Restart</button>}
            <button class="btn btn-sm" onClick={() => openEditHarness(h)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick={() => handleHarnessDelete(h.id, h.name)}>Delete</button>
          </div>
        </div>
        <div class="agent-card-meta">
          {h.appId && <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">{getAppName(h.appId)}</span>}
          {h.appImage && <span class="agent-meta-tag">{h.appImage}</span>}
          {(h.claudeHomePath || h.anthropicApiKey) && (
            <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">
              {'\u{1F511}'} Auth
            </span>
          )}
          {launcher?.version && <span class="agent-meta-tag">v{launcher.version}</span>}
          {caps && !caps.hasDocker && <span class="agent-meta-tag" style="border-color:var(--pw-warning, #eab308)40;color:var(--pw-warning, #eab308)">No Docker</span>}
          {caps && !caps.hasTmux && <span class="agent-meta-tag" style="border-color:var(--pw-warning, #eab308)40;color:var(--pw-warning, #eab308)">No tmux</span>}
          {caps && !caps.hasClaudeCli && <span class="agent-meta-tag" style="border-color:var(--pw-warning, #eab308)40;color:var(--pw-warning, #eab308)">No Claude CLI</span>}
        </div>
        {authCheck && (
          <div style={`margin-top:6px;font-size:12px;padding:4px 8px;border-radius:4px;${authCheck.error ? 'color:var(--pw-danger, #ef4444);background:var(--pw-danger, #ef4444)10' : authCheck.hasCredentials ? 'color:var(--pw-success, #22c55e);background:var(--pw-success, #22c55e)10' : 'color:var(--pw-warning, #eab308);background:var(--pw-warning, #eab308)10'}`}>
            {authCheck.error
              ? `Auth check failed: ${authCheck.error}`
              : `Claude dir: ${authCheck.hasClaudeDir ? 'found' : 'missing'} | Credentials: ${authCheck.hasCredentials ? 'found' : 'missing'}${authCheck.claudeVersion ? ` | ${authCheck.claudeVersion}` : ''}`
            }
          </div>
        )}
        {expandedSetupWizard.value === h.id && h.status === 'running' && (() => {
          const cc = containerCheckResults.value[h.id];
          const ccLoading = containerCheckLoading.value[h.id];
          return (
            <div style="margin-top:8px;padding:10px;border:1px solid var(--pw-border);border-radius:6px;font-size:12px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span style="font-weight:600;color:var(--pw-text)">Setup Wizard</span>
                <button class="btn btn-sm" style="font-size:10px;padding:1px 6px" onClick={() => expandedSetupWizard.value = null}>{'\u2715'}</button>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <span style={`width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:${cc?.hasClaudeCli ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-muted)'}`}>1</span>
                <span style="font-weight:500;color:var(--pw-text)">Claude Code in container</span>
                <button class="btn btn-sm" style="font-size:11px;padding:1px 8px;margin-left:auto" disabled={ccLoading} onClick={() => handleCheckContainerClaude(h.id)}>
                  {ccLoading ? 'Checking...' : cc ? 'Re-check' : 'Check'}
                </button>
              </div>
              {cc && (
                <div style={`margin-left:26px;margin-bottom:8px;padding:4px 8px;border-radius:4px;${cc.error ? 'color:var(--pw-danger, #ef4444);background:var(--pw-danger, #ef4444)10' : cc.hasClaudeCli ? 'color:var(--pw-success, #22c55e);background:var(--pw-success, #22c55e)10' : 'color:var(--pw-warning, #eab308);background:var(--pw-warning, #eab308)10'}`}>
                  {cc.error ? `Check failed: ${cc.error}` : cc.hasClaudeCli ? `Installed: ${cc.claudeVersion || 'yes'}` : 'Claude Code not found in container.'}
                </div>
              )}
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <span style={`width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:${cc?.hasCredentials ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-muted)'}`}>2</span>
                <span style="font-weight:500;color:var(--pw-text)">Authentication</span>
              </div>
              {cc?.hasClaudeCli && !cc.hasCredentials && (
                <div style="margin-left:26px;margin-bottom:8px">
                  <div style="margin-bottom:6px;color:var(--pw-warning, #eab308)">No credentials found in container.</div>
                  {h.launcherId && (
                    <button class="btn btn-sm btn-primary" style="font-size:11px" onClick={() => handleSpawnTerminal(h.id, h.launcherId)}>Open Auth Terminal</button>
                  )}
                </div>
              )}
              {cc?.hasClaudeCli && cc.hasCredentials && (
                <div style="margin-left:26px;margin-bottom:8px;padding:4px 8px;border-radius:4px;color:var(--pw-success, #22c55e);background:var(--pw-success, #22c55e)10">
                  Credentials found. Claude Code is ready.
                </div>
              )}
              {!cc && (
                <div style="margin-left:26px;font-size:11px;color:var(--pw-text-muted)">Run step 1 first.</div>
              )}
            </div>
          );
        })()}
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--pw-text-muted)">
          {(() => {
            const extUrl = getHarnessUrl(h);
            return (
              <>
                {extUrl && (
                  <div>
                    <span style="font-weight:500;color:var(--pw-text)">URL: </span>
                    <a href={extUrl} target="_blank" rel="noopener" style="color:var(--pw-primary)">{extUrl}</a>
                  </div>
                )}
                {h.targetAppUrl && (
                  <div>
                    <span style="font-weight:500;color:var(--pw-text)">{extUrl ? 'Internal: ' : 'App URL: '}</span>
                    <span>{h.targetAppUrl}</span>
                  </div>
                )}
              </>
            );
          })()}
          {(h.appPort || h.serverPort || h.browserMcpPort) && (
            <div>
              <span style="font-weight:500;color:var(--pw-text)">Ports: </span>
              {[h.appPort && `app:${h.appPort}`, h.serverPort && `srv:${h.serverPort}`, h.browserMcpPort && `mcp:${h.browserMcpPort}`].filter(Boolean).join(' / ')}
            </div>
          )}
        </div>
        {isHealthExpanded && health && (
          <div style="margin-top:8px;padding:8px;border:1px solid var(--pw-border);border-radius:6px;font-size:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-weight:600;color:var(--pw-text)">Launcher Health</span>
              <button class="btn btn-sm" style="font-size:10px;padding:1px 6px" onClick={() => expandedHealth.value = null}>{'\u2715'}</button>
            </div>
            {health.error ? (
              <div style="color:var(--pw-danger, #ef4444)">{health.error}</div>
            ) : (
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;color:var(--pw-text-muted)">
                <div><span style="color:var(--pw-text)">Uptime:</span> {formatUptime(health.uptime)}</div>
                <div><span style="color:var(--pw-text)">Node:</span> {health.nodeVersion}</div>
                <div><span style="color:var(--pw-text)">Version:</span> {health.launcherVersion}</div>
                <div><span style="color:var(--pw-text)">Platform:</span> {health.platform}/{health.arch}</div>
                <div><span style="color:var(--pw-text)">Memory:</span> {formatBytes(health.memory?.free)} free / {formatBytes(health.memory?.total)}</div>
                <div><span style="color:var(--pw-text)">Sessions:</span> {health.activeSessions}</div>
                {health.dockerVersion && <div><span style="color:var(--pw-text)">Docker:</span> {health.dockerVersion}</div>}
                {health.tmuxVersion && <div><span style="color:var(--pw-text)">tmux:</span> {health.tmuxVersion}</div>}
                {health.claudeCliVersion && <div><span style="color:var(--pw-text)">Claude:</span> {health.claudeCliVersion}</div>}
              </div>
            )}
          </div>
        )}
        {h.errorMessage && (
          <div style="margin-top:6px;font-size:12px;color:var(--pw-danger, #ef4444);background:var(--pw-danger, #ef4444)10;padding:4px 8px;border-radius:4px">
            {h.errorMessage}
          </div>
        )}
        <div style="margin-top:6px;font-size:11px;color:var(--pw-text-faint)">
          Created {new Date(h.createdAt).toLocaleString()}
          {h.lastStartedAt && <span> &middot; Last started {new Date(h.lastStartedAt).toLocaleString()}</span>}
        </div>
      </div>
    </div>
  );
}

function SpriteCard({ s }: { s: any }) {
  return (
    <div class="agent-card" key={s.id}>
      <div class="agent-card-body">
        <div class="agent-card-top">
          <div class="agent-card-name">
            {s.name}
            <span class="agent-badge" style={`background:${spriteStatusColor(s.status)};color:#fff;margin-left:8px`}>
              {s.status.toUpperCase()}
            </span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            {(s.status === 'unknown' || s.status === 'destroyed' || s.status === 'error') && (
              <button class="btn btn-sm btn-primary" onClick={() => handleSpriteProvision(s.id)}>Provision</button>
            )}
            {s.status !== 'unknown' && s.status !== 'destroyed' && s.status !== 'error' && (
              <>
                <button class="btn btn-sm btn-primary" onClick={() => handleSpriteLaunchSession(s.id)}>Launch Session</button>
                <button class="btn btn-sm" onClick={() => handleSpriteDestroy(s.id)}>Destroy</button>
              </>
            )}
            <button class="btn btn-sm" onClick={() => handleSpriteCheckStatus(s.id)}>Check Status</button>
            <SetupAssistButton entityType="sprite" entityId={s.id} entityLabel={s.name} />
            <button class="btn btn-sm" onClick={() => openEditSprite(s)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick={() => handleSpriteDelete(s.id, s.name)}>Delete</button>
          </div>
        </div>
        <div class="agent-card-meta">
          <span class="agent-meta-tag">{s.spriteName}</span>
          {s.appId && (() => {
            const app = applications.value.find(a => a.id === s.appId);
            return app ? (
              <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">
                <AppLink app={app} />
              </span>
            ) : (
              <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">{s.appId.slice(0, 8)}</span>
            );
          })()}
          {s.activeSessions > 0 && (
            <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">
              {s.activeSessions}/{s.maxSessions} sessions
            </span>
          )}
          {s.token && <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)">Token set</span>}
        </div>
        {s.appId && (() => {
          const app = applications.value.find(a => a.id === s.appId);
          if (!app?.projectDir) return null;
          return (
            <div style="margin-top:6px;font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="color:var(--pw-text-faint);font-size:11px">{getRepoName(app.projectDir)}</span>
              <SharedRepoBadge repoKey={app.projectDir} currentInfraId={s.id} />
            </div>
          );
        })()}
        {s.spriteUrl && (
          <div style="margin-top:8px;font-size:12px;color:var(--pw-text-muted)">
            <span style="font-weight:500;color:var(--pw-text)">URL: </span>
            <a href={s.spriteUrl} target="_blank" rel="noopener" style="color:var(--pw-primary)">{s.spriteUrl}</a>
          </div>
        )}
        {s.errorMessage && (
          <div style="margin-top:6px;font-size:12px;color:var(--pw-danger, #ef4444);background:var(--pw-danger, #ef4444)10;padding:4px 8px;border-radius:4px">
            {s.errorMessage}
          </div>
        )}
        <div style="margin-top:6px;font-size:11px;color:var(--pw-text-faint)">
          Created {new Date(s.createdAt).toLocaleString()}
          {s.lastCheckedAt && <span> &middot; Last checked {new Date(s.lastCheckedAt).toLocaleString()}</span>}
        </div>
      </div>
    </div>
  );
}

function MachineCard({ m }: { m: any }) {
  const isExpanded = expandedMachines.value.has(m.id);
  const machineHarnesses = harnessConfigs.value.filter(h => h.machineId === m.id);
  const harnessCount = machineHarnesses.length;

  return (
    <div class="agent-card" key={m.id}>
      <div class="agent-card-body">
        <div class="agent-card-top">
          <div class="agent-card-name">
            {m.name}
            <span
              class="agent-badge"
              style={`background:${m.status === 'online' ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-faint)'};color:#fff;margin-left:8px`}
            >
              {m.status === 'online' ? 'ONLINE' : 'OFFLINE'}
            </span>
            <span class="agent-badge" style="background:var(--pw-bg-hover);color:var(--pw-text-muted);margin-left:4px">
              {m.type}
            </span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            {(() => {
              const target = cachedTargets.value.find(t => t.machineId === m.id && !t.isHarness);
              return target ? (
                <button class="btn btn-sm" onClick={() => spawnTerminal(selectedAppId.value, target.launcherId)} title={`Open terminal on ${m.name}`}>Terminal</button>
              ) : null;
            })()}
            <button class="btn btn-sm" onClick={() => openAddHarness(m.id)}>Add Harness</button>
            <SetupAssistButton entityType="machine" entityId={m.id} entityLabel={m.name} />
            <button class="btn btn-sm" onClick={() => openEditMachine(m)}>Edit</button>
            <button class="btn btn-sm btn-danger" onClick={() => handleMachineDelete(m.id, m.name)}>Delete</button>
          </div>
        </div>
        <div class="agent-card-meta">
          {m.hostname && <span class="agent-meta-tag">{m.hostname}</span>}
          {m.address && <span class="agent-meta-tag">{m.address}</span>}
          {m.capabilities?.hasDocker && <span class="agent-meta-tag">Docker</span>}
          {m.capabilities?.hasTmux && <span class="agent-meta-tag">tmux</span>}
          {m.capabilities?.hasClaudeCli && <span class="agent-meta-tag">Claude CLI</span>}
        </div>
        {m.adminUrl && (() => {
          const health = adminHealthStatus.value[m.id];
          const actionLoading = adminActionLoading.value[m.id];
          const dotColor = health === 'alive' ? '#22c55e' : health === 'dead' ? '#ef4444' : 'var(--pw-text-faint)';
          const dotTitle = health === 'alive' ? 'Admin is live' : health === 'dead' ? 'Admin is down' : 'Checking...';
          const hasLauncher = cachedTargets.value.some(t => t.machineId === m.id && !t.isHarness);
          return (
            <div style="margin-top:6px;font-size:12px;display:flex;align-items:center;gap:6px">
              <span
                style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0;${health === 'checking' ? 'animation:pulse 1s infinite' : ''}`}
                title={dotTitle}
              />
              <span style="font-weight:500;color:var(--pw-text)">Admin: </span>
              <a href={m.adminUrl} target="_blank" rel="noopener" style="color:var(--pw-primary)">{m.adminUrl}</a>
              {health === 'dead' && hasLauncher && (
                <button
                  class="btn btn-sm"
                  style="font-size:10px;padding:1px 6px;margin-left:4px"
                  disabled={actionLoading}
                  onClick={() => handleAdminStart(m.id)}
                >
                  {actionLoading ? 'Starting...' : 'Start'}
                </button>
              )}
              {health === 'alive' && hasLauncher && (
                <button
                  class="btn btn-sm"
                  style="font-size:10px;padding:1px 6px;margin-left:4px"
                  disabled={actionLoading}
                  onClick={() => handleAdminStop(m.id)}
                >
                  {actionLoading ? 'Stopping...' : 'Stop'}
                </button>
              )}
              <button
                class="btn btn-sm"
                style="font-size:10px;padding:1px 4px;margin-left:2px;opacity:0.6"
                onClick={() => probeAdminUrls()}
                title="Re-check"
              >
                {'\u21BB'}
              </button>
            </div>
          );
        })()}
        {m.tags?.length > 0 && (
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
            {m.tags.map((tag: string) => (
              <span key={tag} style="font-size:11px;padding:1px 6px;border-radius:3px;background:var(--pw-primary)20;color:var(--pw-primary)">
                {tag}
              </span>
            ))}
          </div>
        )}
        {m.lastSeenAt && (
          <div style="margin-top:6px;font-size:11px;color:var(--pw-text-faint)">
            Last seen: {new Date(m.lastSeenAt).toLocaleString()}
          </div>
        )}

        {(() => {
          const apps = getAppsForMachine(m.id);
          if (apps.length === 0) return null;
          return (
            <div style="margin-top:8px;font-size:12px">
              <div style="font-weight:500;color:var(--pw-text);margin-bottom:4px">Apps</div>
              {apps.map(app => (
                <div key={app.id} style="display:flex;align-items:center;gap:6px;padding:2px 0;flex-wrap:wrap">
                  <AppLink app={app} />
                  {app.projectDir && (
                    <span style="color:var(--pw-text-faint);font-size:11px">{getRepoName(app.projectDir)}</span>
                  )}
                  {app.projectDir && <SharedRepoBadge repoKey={app.projectDir} currentInfraId={m.id} />}
                </div>
              ))}
            </div>
          );
        })()}

        {harnessCount > 0 && (
          <div style="margin-top:8px">
            <button
              class="btn btn-sm"
              style="font-size:11px;padding:2px 8px"
              onClick={() => toggleExpanded(m.id)}
            >
              {isExpanded ? '\u25BC' : '\u25B6'} {harnessCount} harness{harnessCount !== 1 ? 'es' : ''}
            </button>
            {isExpanded && (
              <div class="infra-nested-harnesses">
                {machineHarnesses.map(h => <HarnessSubCard key={h.id} h={h} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ----- Main page -----

export function InfrastructurePage() {
  useEffect(() => {
    loadAll();
    ensureTargetsLoaded();
    const interval = setInterval(() => { loadAll(); ensureTargetsLoaded(); }, 10_000);
    return () => clearInterval(interval);
  }, []);

  const showMachines = filter.value === 'all' || filter.value === 'machines';
  const showSprites = filter.value === 'all' || filter.value === 'sprites';

  const unassignedHarnesses = harnessConfigs.value.filter(h => !h.machineId);
  const unmanagedHarnesses = liveHarnesses.value.filter(h => !h.harnessConfigId);

  return (
    <div style="max-width:900px">
      <div class="page-header">
        <div>
          <h2>Infrastructure</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Machines, Docker harnesses, and Fly.io sprites.
          </p>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <SetupAssistButton entityType={showSprites ? 'sprite' : 'machine'} entityLabel="Infrastructure" />
          {showMachines && <button class="btn btn-primary" onClick={openAddMachine}>Add Machine</button>}
          {showMachines && <button class="btn btn-primary" onClick={() => openAddHarness()}>Create Harness</button>}
          {showSprites && <button class="btn btn-primary" onClick={openAddSprite}>Create Sprite</button>}
        </div>
      </div>

      {/* Filter bar */}
      <div class="infra-filter-bar">
        {(['all', 'machines', 'sprites'] as FilterMode[]).map(f => (
          <button
            key={f}
            class={`infra-tag${filter.value === f ? ' active' : ''}`}
            onClick={() => filter.value = f}
          >
            {f === 'all' ? 'All' : f === 'machines' ? 'Machines & Harnesses' : 'Sprites'}
          </button>
        ))}
      </div>

      {error.value && <div class="error-msg">{error.value}</div>}

      {/* Forms */}
      {showMachineForm.value && <MachineForm />}
      {showHarnessForm.value && <HarnessForm />}
      {showSpriteForm.value && <SpriteForm />}

      {/* Machines section */}
      {showMachines && (
        <>
          <div class="infra-section-title">Machines</div>
          <div class="agent-list">
            {machines.value.map(m => <MachineCard key={m.id} m={m} />)}
            {machines.value.length === 0 && !loading.value && (
              <div class="agent-empty">
                <div class="agent-empty-icon">{'\u{1F5A5}'}</div>
                <div class="agent-empty-title">No machines registered</div>
                <div class="agent-empty-desc">Add a machine to start deploying harnesses remotely.</div>
              </div>
            )}
          </div>
          <DeletedItemsPanel type="machines" />

          {/* Unassigned harnesses */}
          {unassignedHarnesses.length > 0 && (
            <>
              <div class="infra-section-title" style="margin-top:24px">Unassigned Harnesses</div>
              <div class="agent-list">
                {unassignedHarnesses.map(h => <HarnessSubCard key={h.id} h={h} />)}
              </div>
            </>
          )}
          <DeletedItemsPanel type="harnesses" />

          {/* Unmanaged live harnesses */}
          {unmanagedHarnesses.length > 0 && (
            <>
              <div class="infra-section-title" style="margin-top:24px">Live Unmanaged Harnesses</div>
              <div class="agent-list">
                {unmanagedHarnesses.map(h => (
                  <div class="agent-card" key={h.id}>
                    <div class="agent-card-body">
                      <div class="agent-card-top">
                        <div class="agent-card-name">
                          {h.name}
                          <span class="agent-badge" style={`background:${h.online ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-faint)'};color:#fff;margin-left:8px`}>
                            {h.online ? 'ONLINE' : 'OFFLINE'}
                          </span>
                        </div>
                      </div>
                      <div class="agent-card-meta">
                        <span class="agent-meta-tag">{h.id}</span>
                        <span class="agent-meta-tag">{h.hostname}</span>
                      </div>
                      {h.harness && (
                        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--pw-text-muted)">
                          <div>
                            <span style="font-weight:500;color:var(--pw-text)">App URL: </span>
                            <a href={h.harness.targetAppUrl} target="_blank" rel="noopener" style="color:var(--pw-primary)">{h.harness.targetAppUrl}</a>
                          </div>
                          {h.harness.appImage && (
                            <div>
                              <span style="font-weight:500;color:var(--pw-text)">Image: </span>
                              <code style="font-size:11px">{h.harness.appImage}</code>
                            </div>
                          )}
                        </div>
                      )}
                      <div style="margin-top:6px;font-size:11px;color:var(--pw-text-faint)">
                        Connected {h.connectedAt}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Sprites section */}
      {showSprites && (
        <>
          <div class="infra-section-title" style={showMachines ? 'margin-top:32px' : ''}>Sprites</div>
          <div class="agent-list">
            {spriteConfigs.value.map(s => <SpriteCard key={s.id} s={s} />)}
            {spriteConfigs.value.length === 0 && !loading.value && (
              <div class="agent-empty">
                <div class="agent-empty-icon">{'\u2601\uFE0F'}</div>
                <div class="agent-empty-title">No sprite configs</div>
                <div class="agent-empty-desc">Create a sprite to deploy stateful cloud VMs on Fly.io.</div>
              </div>
            )}
          </div>
          <DeletedItemsPanel type="sprites" />
        </>
      )}

      {/* Applications section */}
      {applications.value.length > 0 && (() => {
        const repoMap = buildRepoMap();
        const sharedRepos = [...repoMap.entries()].filter(([, entries]) => {
          const uniqueInfra = new Set(entries.map(e => e.infraId));
          return uniqueInfra.size > 1;
        });
        const unassociated = getUnassociatedApps();

        if (sharedRepos.length === 0 && unassociated.length === 0) return null;

        return (
          <>
            <div class="infra-section-title" style="margin-top:32px">Applications</div>

            {sharedRepos.length > 0 && (
              <div style="margin-bottom:16px">
                <div style="font-size:12px;font-weight:500;color:var(--pw-text);margin-bottom:8px">Shared Repos</div>
                {sharedRepos.map(([repoKey, entries]) => (
                  <div key={repoKey} class="agent-card" style="margin-bottom:8px">
                    <div class="agent-card-body" style="padding:10px 14px">
                      <div style="font-size:12px;font-weight:500;color:var(--pw-text);margin-bottom:4px">
                        {getRepoName(repoKey)}
                      </div>
                      <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px">
                        {entries.map(e => (
                          <span key={e.infraId + e.app.id} style="display:inline-flex;align-items:center;gap:4px;color:var(--pw-text-muted)">
                            <AppLink app={e.app} />
                            <span style="font-size:10px;padding:1px 4px;border-radius:3px;background:var(--pw-bg-hover);color:var(--pw-text-faint)">
                              {e.infraType === 'machine' ? '\u{1F5A5}' : '\u2601\uFE0F'} {e.infraName}
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {unassociated.length > 0 && (
              <div>
                <div style="font-size:12px;font-weight:500;color:var(--pw-text);margin-bottom:8px">Unassociated Apps</div>
                <div class="agent-list">
                  {unassociated.map(app => (
                    <div key={app.id} class="agent-card">
                      <div class="agent-card-body" style="padding:10px 14px">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                          <AppLink app={app} />
                          {app.projectDir && (
                            <span style="color:var(--pw-text-faint);font-size:11px">{getRepoName(app.projectDir)}</span>
                          )}
                          {app.serverUrl && (
                            <a href={app.serverUrl} target="_blank" rel="noopener" style="font-size:11px;color:var(--pw-primary)">{app.serverUrl}</a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
