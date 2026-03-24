import { signal } from '@preact/signals';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { trackDeletion } from '../components/DeletedItemsPanel.js';
import {
  machines, harnessConfigs, applications, launchers,
  loading, error, loadAll, closeAllForms,
  getAppName, harnessStatusColor, getHarnessUrl, formatBytes, formatUptime,
} from '../pages/InfrastructurePage.js';

// Harness form state
export const showHarnessForm = signal(false);
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

// Harness health / auth / setup state
const healthResults = signal<Record<string, any>>({});
const authCheckResults = signal<Record<string, any>>({});
const containerCheckResults = signal<Record<string, any>>({});
const containerCheckLoading = signal<Record<string, boolean>>({});
const expandedHealth = signal<string | null>(null);
const expandedSetupWizard = signal<string | null>(null);

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

export function openAddHarness(machineId?: string) {
  resetHarnessForm();
  closeAllForms();
  if (machineId) hFormMachineId.value = machineId;
  showHarnessForm.value = true;
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

export function HarnessForm() {
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

export function HarnessSubCard({ h }: { h: any }) {
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
