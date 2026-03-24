import { signal } from '@preact/signals';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { trackDeletion } from '../components/DeletedItemsPanel.js';
import { cachedTargets } from '../components/DispatchTargetSelect.js';
import { spawnTerminal } from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';
import {
  machines, harnessConfigs, applications, launchers,
  loading, error, expandedMachines, loadAll, closeAllForms,
  getAppName, getRepoName, getAppsForMachine, getHarnessUrl,
  harnessStatusColor, AppLink, SharedRepoBadge,
} from '../pages/InfrastructurePage.js';
import { HarnessSubCard, openAddHarness } from './HarnessSection.js';

// Machine form state
export const showMachineForm = signal(false);
const machineEditingId = signal<string | null>(null);
const mFormName = signal('');
const mFormHostname = signal('');
const mFormAddress = signal('');
const mFormType = signal<'local' | 'remote' | 'cloud'>('remote');
const mFormTags = signal('');
const mFormAdminUrl = signal('');
const mFormLoading = signal(false);
const mFormError = signal('');

// Admin health state
const adminHealthStatus = signal<Record<string, 'checking' | 'alive' | 'dead'>>({});
const adminActionLoading = signal<Record<string, boolean>>({});

export async function probeAdminUrls() {
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

export function openAddMachine() {
  resetMachineForm();
  closeAllForms();
  showMachineForm.value = true;
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

function toggleExpanded(machineId: string) {
  const next = new Set(expandedMachines.value);
  if (next.has(machineId)) next.delete(machineId);
  else next.add(machineId);
  expandedMachines.value = next;
}

export function MachineForm() {
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

export function MachineCard({ m }: { m: any }) {
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
