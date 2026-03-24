import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { api } from '../lib/api.js';
import { SetupAssistButton } from '../components/SetupAssistButton.js';
import { DeletedItemsPanel } from '../components/DeletedItemsPanel.js';
import { ensureTargetsLoaded } from '../components/DispatchTargetSelect.js';
import { MachineForm, MachineCard, showMachineForm, openAddMachine, probeAdminUrls } from './MachineSection.js';
import { HarnessForm, HarnessSubCard, showHarnessForm, openAddHarness } from './HarnessSection.js';
import { SpriteForm, SpriteCard, showSpriteForm, openAddSprite } from './SpriteSection.js';

export function closeAllForms() {
  showMachineForm.value = false;
  showHarnessForm.value = false;
  showSpriteForm.value = false;
}

type FilterMode = 'all' | 'machines' | 'sprites';

export const filter = signal<FilterMode>('all');
export const machines = signal<any[]>([]);
export const harnessConfigs = signal<any[]>([]);
export const liveHarnesses = signal<any[]>([]);
export const spriteConfigs = signal<any[]>([]);
export const applications = signal<any[]>([]);
export const launchers = signal<any[]>([]);
export const loading = signal(true);
export const error = signal('');
export const expandedMachines = signal<Set<string>>(new Set());

export async function loadAll() {
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

  probeAdminUrls();
}

// ----- Utility -----
export function harnessStatusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--pw-success, #22c55e)';
    case 'starting': return 'var(--pw-warning, #eab308)';
    case 'error': return 'var(--pw-danger, #ef4444)';
    default: return 'var(--pw-text-faint)';
  }
}

export function spriteStatusColor(status: string): string {
  switch (status) {
    case 'running': case 'warm': return 'var(--pw-success, #22c55e)';
    case 'cold': return 'var(--pw-primary, #3b82f6)';
    case 'error': return 'var(--pw-danger, #ef4444)';
    case 'destroyed': return 'var(--pw-text-faint)';
    default: return 'var(--pw-text-muted)';
  }
}

export function getAppName(appId: string | null): string {
  if (!appId) return '';
  const app = applications.value.find(a => a.id === appId);
  return app?.name || appId.slice(0, 8);
}

export function getMachineName(machineId: string | null): string {
  if (!machineId) return 'Unassigned';
  const m = machines.value.find(x => x.id === machineId);
  return m?.name || machineId.slice(0, 8);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function getHarnessUrl(h: any): string | null {
  if (h.status !== 'running') return null;
  const machine = machines.value.find(m => m.id === h.machineId);
  if (!machine?.address) return null;
  const port = h.serverPort || 3001;
  return `http://${machine.address}:${port}/admin/`;
}

export function getAppsForMachine(machineId: string): any[] {
  const appIds = new Set<string>();
  for (const h of harnessConfigs.value) {
    if (h.machineId === machineId && h.appId) appIds.add(h.appId);
  }
  return applications.value.filter(a => appIds.has(a.id));
}

export function getRepoName(projectDir: string | null | undefined): string {
  if (!projectDir) return '';
  const parts = projectDir.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/');
}

export type RepoEntry = { app: any; infraType: 'machine' | 'sprite'; infraId: string; infraName: string };

export function buildRepoMap(): Map<string, RepoEntry[]> {
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

export function getUnassociatedApps(): any[] {
  const assignedIds = new Set<string>();
  for (const h of harnessConfigs.value) {
    if (h.appId) assignedIds.add(h.appId);
  }
  for (const s of spriteConfigs.value) {
    if (s.appId) assignedIds.add(s.appId);
  }
  return applications.value.filter(a => !assignedIds.has(a.id));
}

export function AppLink({ app }: { app: any }) {
  return (
    <a href={`#/app/${app.id}/feedback`} style="color:var(--pw-primary);text-decoration:none;font-weight:500">
      {app.name}
    </a>
  );
}

export function SharedRepoBadge({ repoKey, currentInfraId }: { repoKey: string; currentInfraId: string }) {
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
