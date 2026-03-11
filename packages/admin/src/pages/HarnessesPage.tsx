import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';

const harnessConfigs = signal<any[]>([]);
const liveHarnesses = signal<any[]>([]);
const machines = signal<any[]>([]);
const applications = signal<any[]>([]);
const launchers = signal<any[]>([]);
const loading = signal(true);
const error = signal('');
const healthResults = signal<Record<string, any>>({});
const authCheckResults = signal<Record<string, any>>({});
const containerCheckResults = signal<Record<string, any>>({});
const containerCheckLoading = signal<Record<string, boolean>>({});
const expandedHealth = signal<string | null>(null);
const expandedSetupWizard = signal<string | null>(null);
const showForm = signal(false);
const editingId = signal<string | null>(null);
const formName = signal('');
const formAppId = signal('');
const formMachineId = signal('');
const formAppImage = signal('');
const formAppPort = signal('');
const formAppInternalPort = signal('');
const formServerPort = signal('');
const formBrowserMcpPort = signal('');
const formTargetAppUrl = signal('');
const formComposeDir = signal('');
const formEnvVars = signal('');
const formHostTerminalAccess = signal(false);
const formClaudeHomePath = signal('');
const formAnthropicApiKey = signal('');
const formLoading = signal(false);
const formError = signal('');

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [configs, live, machineList, appList, launcherList] = await Promise.all([
      api.getHarnessConfigs(),
      api.getHarnesses().then(r => r.harnesses).catch(() => []),
      api.getMachines().catch(() => []),
      api.getApplications().catch(() => []),
      api.getLaunchers().then(r => r.launchers).catch(() => []),
    ]);
    harnessConfigs.value = configs;
    liveHarnesses.value = live;
    machines.value = machineList;
    applications.value = appList;
    launchers.value = launcherList;
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  formName.value = '';
  formAppId.value = '';
  formMachineId.value = '';
  formAppImage.value = '';
  formAppPort.value = '';
  formAppInternalPort.value = '';
  formServerPort.value = '';
  formBrowserMcpPort.value = '';
  formTargetAppUrl.value = '';
  formComposeDir.value = '';
  formEnvVars.value = '';
  formHostTerminalAccess.value = false;
  formClaudeHomePath.value = '';
  formAnthropicApiKey.value = '';
  formError.value = '';
  editingId.value = null;
}

function openAdd() {
  resetForm();
  showForm.value = true;
}

function openEdit(h: any) {
  editingId.value = h.id;
  formName.value = h.name;
  formAppId.value = h.appId || '';
  formMachineId.value = h.machineId || '';
  formAppImage.value = h.appImage || '';
  formAppPort.value = h.appPort ? String(h.appPort) : '';
  formAppInternalPort.value = h.appInternalPort ? String(h.appInternalPort) : '';
  formServerPort.value = h.serverPort ? String(h.serverPort) : '';
  formBrowserMcpPort.value = h.browserMcpPort ? String(h.browserMcpPort) : '';
  formTargetAppUrl.value = h.targetAppUrl || '';
  formComposeDir.value = h.composeDir || '';
  formEnvVars.value = h.envVars ? JSON.stringify(h.envVars, null, 2) : '';
  formHostTerminalAccess.value = h.hostTerminalAccess ?? false;
  formClaudeHomePath.value = h.claudeHomePath || '';
  formAnthropicApiKey.value = h.anthropicApiKey || '';
  formError.value = '';
  showForm.value = true;
}

async function handleSubmit() {
  if (!formName.value.trim()) {
    formError.value = 'Name is required';
    return;
  }
  formLoading.value = true;
  formError.value = '';
  try {
    let envVars = null;
    if (formEnvVars.value.trim()) {
      try { envVars = JSON.parse(formEnvVars.value); } catch { formError.value = 'Invalid JSON for env vars'; formLoading.value = false; return; }
    }
    const data: Record<string, unknown> = {
      name: formName.value.trim(),
      appId: formAppId.value || null,
      machineId: formMachineId.value || null,
      appImage: formAppImage.value.trim() || null,
      appPort: formAppPort.value ? parseInt(formAppPort.value) : null,
      appInternalPort: formAppInternalPort.value ? parseInt(formAppInternalPort.value) : null,
      serverPort: formServerPort.value ? parseInt(formServerPort.value) : null,
      browserMcpPort: formBrowserMcpPort.value ? parseInt(formBrowserMcpPort.value) : null,
      targetAppUrl: formTargetAppUrl.value.trim() || null,
      composeDir: formComposeDir.value.trim() || null,
      envVars,
      hostTerminalAccess: formHostTerminalAccess.value,
      claudeHomePath: formClaudeHomePath.value.trim() || null,
      anthropicApiKey: formAnthropicApiKey.value.trim() || null,
    };
    if (editingId.value) {
      await api.updateHarnessConfig(editingId.value, data);
    } else {
      await api.createHarnessConfig(data);
    }
    showForm.value = false;
    resetForm();
    await loadAll();
  } catch (err: any) {
    formError.value = err.message;
  } finally {
    formLoading.value = false;
  }
}

async function handleDelete(id: string, name: string) {
  try {
    await api.deleteHarnessConfig(id);
    trackDeletion('harnesses', id, name);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleStart(id: string) {
  try {
    await api.startHarness(id);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleStop(id: string) {
  try {
    await api.stopHarness(id);
    await loadAll();
  } catch (err: any) {
    error.value = err.message;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--pw-success, #22c55e)';
    case 'starting': return 'var(--pw-warning, #eab308)';
    case 'error': return 'var(--pw-danger, #ef4444)';
    default: return 'var(--pw-text-faint)';
  }
}

function getHarnessUrl(h: any): string | null {
  if (h.status !== 'running') return null;
  const machine = machines.value.find(m => m.id === h.machineId);
  if (!machine?.address) return null;
  const port = h.serverPort || 3001;
  return `http://${machine.address}:${port}/admin/`;
}

async function handleLaunchSession(id: string) {
  try {
    const result = await api.launchHarnessSession(id, { permissionProfile: 'yolo' });
    if (result.sessionId) {
      window.location.hash = '#/sessions';
    }
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleSpawnTerminal(harnessConfigId: string, launcherId: string) {
  try {
    const result = await api.spawnTerminal({ harnessConfigId, launcherId });
    if (result.sessionId) {
      window.location.hash = '#/sessions';
    }
  } catch (err: any) {
    error.value = err.message;
  }
}

async function handleSpawnHostTerminal(launcherId: string) {
  try {
    const result = await api.spawnTerminal({ launcherId });
    if (result.sessionId) {
      window.location.hash = '#/sessions';
    }
  } catch (err: any) {
    error.value = err.message;
  }
}

function getLauncherForHarness(h: any): any | null {
  if (h.launcherId) return launchers.value.find(l => l.id === h.launcherId) || null;
  if (h.machineId) return launchers.value.find(l => l.machineId === h.machineId && l.online) || null;
  return null;
}

async function handleRestartLauncher(launcherId: string) {
  try {
    await api.restartLauncher(launcherId);
    error.value = '';
  } catch (err: any) {
    error.value = err.message;
  }
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

export function HarnessesPage() {
  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Unmanaged live harnesses (launchers with harness metadata but no harnessConfigId)
  const unmanagedHarnesses = liveHarnesses.value.filter(
    h => !h.harnessConfigId
  );

  return (
    <div style="max-width:900px">
      <div class="page-header">
        <div>
          <h2>Harnesses</h2>
          <p style="font-size:13px;color:var(--pw-text-muted);margin-top:4px">
            Docker harness configs (pw-server + browser + app) for testing applications.
          </p>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <SetupAssistButton entityType="harness" entityLabel="Harnesses" />
          <button class="btn btn-primary" onClick={openAdd}>Create Harness</button>
        </div>
      </div>

      {error.value && <div class="error-msg">{error.value}</div>}

      {showForm.value && (
        <div class="agent-form" style="margin-bottom:20px">
          <h3 style="margin-top:0">{editingId.value ? 'Edit Harness' : 'Create Harness'}</h3>
          {formError.value && <div class="error-msg">{formError.value}</div>}
          <div class="form-group">
            <label>Name</label>
            <input
              class="form-input"
              value={formName.value}
              onInput={(e) => formName.value = (e.target as HTMLInputElement).value}
              placeholder="My App Harness"
            />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label>Application</label>
              <select
                class="form-input"
                value={formAppId.value}
                onChange={(e) => formAppId.value = (e.target as HTMLSelectElement).value}
              >
                <option value="">-- None --</option>
                {applications.value.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>Machine</label>
              <select
                class="form-input"
                value={formMachineId.value}
                onChange={(e) => formMachineId.value = (e.target as HTMLSelectElement).value}
              >
                <option value="">-- Unassigned --</option>
                {machines.value.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({m.status})</option>
                ))}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>App Image</label>
            <input
              class="form-input"
              value={formAppImage.value}
              onInput={(e) => formAppImage.value = (e.target as HTMLInputElement).value}
              placeholder="my-org/my-app:latest"
            />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
            <div class="form-group">
              <label>App Port</label>
              <input class="form-input" type="number" value={formAppPort.value} onInput={(e) => formAppPort.value = (e.target as HTMLInputElement).value} placeholder="8080" />
            </div>
            <div class="form-group">
              <label>Internal Port</label>
              <input class="form-input" type="number" value={formAppInternalPort.value} onInput={(e) => formAppInternalPort.value = (e.target as HTMLInputElement).value} placeholder="80" />
            </div>
            <div class="form-group">
              <label>Server Port</label>
              <input class="form-input" type="number" value={formServerPort.value} onInput={(e) => formServerPort.value = (e.target as HTMLInputElement).value} placeholder="3001" />
            </div>
            <div class="form-group">
              <label>Browser MCP Port</label>
              <input class="form-input" type="number" value={formBrowserMcpPort.value} onInput={(e) => formBrowserMcpPort.value = (e.target as HTMLInputElement).value} placeholder="8931" />
            </div>
          </div>
          <div class="form-group">
            <label>Target App URL</label>
            <input
              class="form-input"
              value={formTargetAppUrl.value}
              onInput={(e) => formTargetAppUrl.value = (e.target as HTMLInputElement).value}
              placeholder="http://pw-app:80"
            />
          </div>
          <div class="form-group">
            <label>Compose Dir</label>
            <input
              class="form-input"
              value={formComposeDir.value}
              onInput={(e) => formComposeDir.value = (e.target as HTMLInputElement).value}
              placeholder="/path/to/docker-compose-dir"
            />
          </div>
          <div class="form-group">
            <label>Env Vars (JSON)</label>
            <textarea
              class="form-input"
              value={formEnvVars.value}
              onInput={(e) => formEnvVars.value = (e.target as HTMLTextAreaElement).value}
              placeholder='{"KEY": "value"}'
              rows={3}
              style="font-family:monospace;font-size:12px"
            />
          </div>
          <div style="margin-top:12px;padding:10px;border:1px solid var(--pw-border);border-radius:6px">
            <div style="font-weight:600;font-size:12px;margin-bottom:8px;color:var(--pw-text-muted)">Claude Auth</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div class="form-group">
                <label>Claude Home Path</label>
                <input
                  class="form-input"
                  value={formClaudeHomePath.value}
                  onInput={(e) => formClaudeHomePath.value = (e.target as HTMLInputElement).value}
                  placeholder="~/.claude"
                />
              </div>
              <div class="form-group">
                <label>Anthropic API Key</label>
                <input
                  class="form-input"
                  type="password"
                  value={formAnthropicApiKey.value}
                  onInput={(e) => formAnthropicApiKey.value = (e.target as HTMLInputElement).value}
                  placeholder="sk-ant-..."
                />
              </div>
            </div>
          </div>
          <div class="form-group" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input
                type="checkbox"
                checked={formHostTerminalAccess.value}
                onChange={(e) => formHostTerminalAccess.value = (e.target as HTMLInputElement).checked}
              />
              Host terminal access
              <span style="font-size:11px;color:var(--pw-text-muted)">(allow opening shells on the host machine, not inside the container)</span>
            </label>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-primary" onClick={handleSubmit} disabled={formLoading.value}>
              {formLoading.value ? 'Saving...' : editingId.value ? 'Update' : 'Create'}
            </button>
            <button class="btn" onClick={() => { showForm.value = false; resetForm(); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Managed harness configs */}
      <div class="agent-list">
        {harnessConfigs.value.map((h) => {
          const launcher = getLauncherForHarness(h);
          const caps = launcher?.capabilities;
          const health = healthResults.value[h.id];
          const authCheck = authCheckResults.value[h.id];
          const isHealthExpanded = expandedHealth.value === h.id;

          return (
          <div class="agent-card" key={h.id}>
            <div class="agent-card-body">
              <div class="agent-card-top">
                <div class="agent-card-name">
                  {h.name}
                  <span
                    class="agent-badge"
                    style={`background:${statusColor(h.status)};color:#fff;margin-left:8px`}
                  >
                    {h.status.toUpperCase()}
                  </span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <SetupAssistButton entityType="harness" entityId={h.id} entityLabel={h.name} />
                  {h.status === 'stopped' || h.status === 'error' ? (
                    <button class="btn btn-sm btn-primary" onClick={() => handleStart(h.id)} disabled={!h.machineId}>
                      Start
                    </button>
                  ) : (
                    <>
                      <button class="btn btn-sm" onClick={() => handleLaunchSession(h.id)} title="Launch Claude session in container">Session</button>
                      {h.launcherId && <button class="btn btn-sm" onClick={() => handleSpawnTerminal(h.id, h.launcherId)} title="Open plain terminal in container">Terminal</button>}
                      {h.hostTerminalAccess && h.launcherId && <button class="btn btn-sm" onClick={() => handleSpawnHostTerminal(h.launcherId)} title="Open shell on the host machine">Host Terminal</button>}
                      <button
                        class="btn btn-sm"
                        style={expandedSetupWizard.value === h.id ? 'background:var(--pw-primary);color:#fff' : ''}
                        onClick={() => expandedSetupWizard.value = expandedSetupWizard.value === h.id ? null : h.id}
                        title="Setup wizard: check Claude Code installation and auth"
                      >Setup</button>
                      <button class="btn btn-sm" onClick={() => handleStop(h.id)}>Stop</button>
                    </>
                  )}
                  {launcher && <button class="btn btn-sm" onClick={() => handleHealthCheck(launcher.id, h.id)} title="Check launcher health">Health</button>}
                  {launcher && <button class="btn btn-sm" onClick={() => handleCheckAuth(h.id)} title="Check Claude auth on remote">Check Auth</button>}
                  {launcher && <button class="btn btn-sm" onClick={() => handleRestartLauncher(launcher.id)} title="Restart launcher daemon">Restart</button>}
                  <button class="btn btn-sm" onClick={() => openEdit(h)}>Edit</button>
                  <button class="btn btn-sm btn-danger" onClick={() => handleDelete(h.id, h.name)}>Delete</button>
                </div>
              </div>
              <div class="agent-card-meta">
                {h.appId && <span class="agent-meta-tag" style="border-color:var(--pw-primary)40;color:var(--pw-primary)">{getAppName(h.appId)}</span>}
                <span class="agent-meta-tag">{getMachineName(h.machineId)}</span>
                {h.appImage && <span class="agent-meta-tag">{h.appImage}</span>}
                {(h.claudeHomePath || h.anthropicApiKey) && (
                  <span class="agent-meta-tag" style="border-color:var(--pw-success, #22c55e)40;color:var(--pw-success, #22c55e)" title={[h.claudeHomePath && `Home: ${h.claudeHomePath}`, h.anthropicApiKey && 'API key set'].filter(Boolean).join(', ')}>
                    {'\u{1F511}'} Auth
                  </span>
                )}
                {launcher?.version && (
                  <span class="agent-meta-tag" title={`Launcher v${launcher.version}`}>v{launcher.version}</span>
                )}
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

                    {/* Step 1: Check Claude Code installation */}
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                      <span style={`width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:${cc?.hasClaudeCli ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-muted)'}`}>1</span>
                      <span style="font-weight:500;color:var(--pw-text)">Claude Code in container</span>
                      <button
                        class="btn btn-sm"
                        style="font-size:11px;padding:1px 8px;margin-left:auto"
                        disabled={ccLoading}
                        onClick={() => handleCheckContainerClaude(h.id)}
                      >
                        {ccLoading ? 'Checking...' : cc ? 'Re-check' : 'Check'}
                      </button>
                    </div>
                    {cc && (
                      <div style={`margin-left:26px;margin-bottom:8px;padding:4px 8px;border-radius:4px;${cc.error ? 'color:var(--pw-danger, #ef4444);background:var(--pw-danger, #ef4444)10' : cc.hasClaudeCli ? 'color:var(--pw-success, #22c55e);background:var(--pw-success, #22c55e)10' : 'color:var(--pw-warning, #eab308);background:var(--pw-warning, #eab308)10'}`}>
                        {cc.error
                          ? `Check failed: ${cc.error}`
                          : cc.hasClaudeCli
                            ? `Installed: ${cc.claudeVersion || 'yes'}`
                            : 'Claude Code not found in container. Rebuild the Docker image to include it.'}
                      </div>
                    )}
                    {cc && !cc.hasClaudeCli && !cc.error && (
                      <div style="margin-left:26px;margin-bottom:8px;font-size:11px;color:var(--pw-text-muted)">
                        The Dockerfile should include <code style="font-size:11px">npm install -g @anthropic-ai/claude-code</code>. Rebuild with <code style="font-size:11px">docker compose build</code>.
                      </div>
                    )}

                    {/* Step 2: Authentication */}
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                      <span style={`width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:${cc?.hasCredentials ? 'var(--pw-success, #22c55e)' : 'var(--pw-text-muted)'}`}>2</span>
                      <span style="font-weight:500;color:var(--pw-text)">Authentication</span>
                    </div>
                    {cc?.hasClaudeCli && !cc.hasCredentials && (
                      <div style="margin-left:26px;margin-bottom:8px">
                        <div style="margin-bottom:6px;color:var(--pw-warning, #eab308)">No credentials found in container. Open a terminal to authenticate.</div>
                        {h.launcherId && (
                          <button
                            class="btn btn-sm btn-primary"
                            style="font-size:11px"
                            onClick={() => handleSpawnTerminal(h.id, h.launcherId)}
                          >
                            Open Auth Terminal
                          </button>
                        )}
                        <div style="margin-top:4px;font-size:11px;color:var(--pw-text-muted)">
                          Run <code style="font-size:11px">claude login</code> in the terminal to authenticate.
                        </div>
                      </div>
                    )}
                    {cc?.hasClaudeCli && cc.hasCredentials && (
                      <div style="margin-left:26px;margin-bottom:8px;padding:4px 8px;border-radius:4px;color:var(--pw-success, #22c55e);background:var(--pw-success, #22c55e)10">
                        Credentials found. Claude Code is ready to use.
                      </div>
                    )}
                    {!cc && (
                      <div style="margin-left:26px;font-size:11px;color:var(--pw-text-muted)">
                        Run step 1 first to check Claude Code installation.
                      </div>
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
                    {[
                      h.appPort && `app:${h.appPort}`,
                      h.serverPort && `srv:${h.serverPort}`,
                      h.browserMcpPort && `mcp:${h.browserMcpPort}`,
                    ].filter(Boolean).join(' / ')}
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
                      <div><span style="color:var(--pw-text)">Claude Home:</span> {health.claudeHomeExists ? 'exists' : 'missing'}</div>
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
        })}
        {harnessConfigs.value.length === 0 && !loading.value && (
          <div class="agent-empty">
            <div class="agent-empty-icon">{'\u{1F433}'}</div>
            <div class="agent-empty-title">No harness configs</div>
            <div class="agent-empty-desc">
              Create a harness config to deploy a pw-server + browser + app stack on a machine.
            </div>
          </div>
        )}
      </div>
      <DeletedItemsPanel type="harnesses" />

      {/* Unmanaged live harnesses */}
      {unmanagedHarnesses.length > 0 && (
        <>
          <h3 style="margin-top:32px;margin-bottom:12px;font-size:14px;color:var(--pw-text-muted)">
            Live Unmanaged Harnesses
          </h3>
          <div class="agent-list">
            {unmanagedHarnesses.map((h) => (
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
    </div>
  );
}
