import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { navigate, isEmbedded } from '../lib/state.js';
import { allSessions, openSession, deleteSession, permanentlyDeleteSession, spawnTerminal, sessionInputStates, includeDeletedInPolling, termPickerOpen } from '../lib/sessions.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { cachedTargets, ensureTargetsLoaded } from '../components/DispatchTargetSelect.js';

const ALL_STATUSES = ['running', 'pending', 'completed', 'failed', 'killed', 'deleted'] as const;
const DEFAULT_STATUSES = new Set<string>(['running', 'pending', 'completed', 'failed', 'killed']);
const filterStatuses = signal<Set<string>>(new Set(DEFAULT_STATUSES));
const filterTargets = signal<Set<string>>(new Set<string>());
const searchQuery = signal('');
const feedbackMap = signal<Record<string, string>>({});
const agentMap = signal<Record<string, string>>({});
const agentAppMap = signal<Record<string, string | null>>({});
const mapsLoaded = signal(false);

async function loadMaps() {
  if (mapsLoaded.value) return;
  try {
    const [fbResult, agents] = await Promise.all([
      api.getFeedback({ limit: 200 }),
      api.getAgents(),
    ]);
    const fm: Record<string, string> = {};
    for (const fb of fbResult.items) {
      fm[fb.id] = fb.title || fb.id.slice(-8);
    }
    feedbackMap.value = fm;
    const am: Record<string, string> = {};
    const aam: Record<string, string | null> = {};
    for (const a of agents) {
      am[a.id] = a.name || a.id.slice(-8);
      aam[a.id] = a.appId || null;
    }
    agentMap.value = am;
    agentAppMap.value = aam;
    mapsLoaded.value = true;
  } catch {
    // ignore
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

async function permanentlyDelete(id: string) {
  await permanentlyDeleteSession(id);
  trackDeletion('sessions', id, `Session ${id.slice(-8)}`);
}

async function permanentlyDeleteAll(ids: string[]) {
  await Promise.all(ids.map((id) => permanentlyDeleteSession(id)));
  for (const id of ids) {
    trackDeletion('sessions', id, `Session ${id.slice(-8)}`);
  }
}

function toggleStatus(status: string) {
  const next = new Set(filterStatuses.value);
  if (next.has(status)) next.delete(status); else next.add(status);
  filterStatuses.value = next;
}

function toggleTarget(targetKey: string) {
  const next = new Set(filterTargets.value);
  if (next.has(targetKey)) next.delete(targetKey); else next.add(targetKey);
  filterTargets.value = next;
}

function getSessionTargetKey(s: any): string {
  if (s.harnessName) return `harness:${s.harnessName}`;
  if (s.spriteConfigId) return `sprite:${s.machineName || s.launcherName || 'sprite'}`;
  if (s.isRemote && s.machineName) return `machine:${s.machineName}`;
  if (s.isRemote && s.launcherName) return `machine:${s.launcherName}`;
  return 'local';
}

function getTargetLabel(key: string): string {
  if (key === 'local') return 'Local';
  const [type, name] = key.split(':', 2);
  return name || type;
}

function getTargetCategory(key: string): string {
  if (key === 'local') return '';
  const type = key.split(':')[0];
  if (type === 'harness') return 'Harness';
  if (type === 'sprite') return 'Sprite';
  if (type === 'machine') return 'Machine';
  return '';
}

export function SessionsPage({ appId }: { appId?: string | null }) {
  const autoTerminalDone = useRef(false);

  useEffect(() => {
    loadMaps();
    ensureTargetsLoaded();
    includeDeletedInPolling.value = true;
    return () => { includeDeletedInPolling.value = false; };
  }, []);

  const searchParams = new URLSearchParams(window.location.search);
  const isAutoTerminal = isEmbedded.value && searchParams.get('autoTerminal') === '1';
  const autoLauncherId = searchParams.get('launcherId') || undefined;

  useEffect(() => {
    if (autoTerminalDone.current) return;
    if (isAutoTerminal) {
      autoTerminalDone.current = true;
      spawnTerminal(appId ?? null, autoLauncherId);
    }
  }, [appId]);

  if (isAutoTerminal) {
    return <div />;
  }

  const sessions = allSessions.value;

  let appFiltered = sessions;
  if (appId && appId !== '__unlinked__') {
    const appAgentIds = new Set(
      Object.entries(agentAppMap.value)
        .filter(([, aid]) => aid === appId)
        .map(([id]) => id)
    );
    appFiltered = sessions.filter((s) =>
      s.appId === appId ||
      (s.agentEndpointId && appAgentIds.has(s.agentEndpointId))
    );
  }

  const activeStatuses = filterStatuses.value;
  let filtered = appFiltered.filter((s) => activeStatuses.has(s.status));

  // Target filter
  const activeTargets = filterTargets.value;
  if (activeTargets.size > 0) {
    filtered = filtered.filter((s) => activeTargets.has(getSessionTargetKey(s)));
  }

  // Search filter
  const q = searchQuery.value.toLowerCase();
  if (q) {
    filtered = filtered.filter((s) => {
      const agentLabel = s.permissionProfile === 'plain' ? 'Terminal' : (agentMap.value[s.agentEndpointId] || s.agentEndpointId?.slice(-8) || '');
      const feedbackTitle = feedbackMap.value[s.feedbackId] || '';
      const label = feedbackTitle || agentLabel || `Session ${s.id.slice(-8)}`;
      return label.toLowerCase().includes(q)
        || s.id.toLowerCase().includes(q)
        || (s.machineName || '').toLowerCase().includes(q)
        || (s.harnessName || '').toLowerCase().includes(q)
        || (s.launcherName || '').toLowerCase().includes(q)
        || s.status.toLowerCase().includes(q);
    });
  }

  const sorted = [...filtered].sort((a, b) => {
    const statusOrder = (s: string) =>
      s === 'running' ? 0 : s === 'pending' ? 1 : 2;
    const diff = statusOrder(a.status) - statusOrder(b.status);
    if (diff !== 0) return diff;
    return new Date(b.startedAt || b.createdAt || 0).getTime() -
      new Date(a.startedAt || a.createdAt || 0).getTime();
  });

  const statusCounts = appFiltered.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  // Build target options from sessions + dispatch targets
  const targetCounts: Record<string, number> = {};
  for (const s of appFiltered) {
    const key = getSessionTargetKey(s);
    targetCounts[key] = (targetCounts[key] || 0) + 1;
  }
  // Also include dispatch targets that may have no sessions yet
  const targets = cachedTargets.value;
  for (const t of targets) {
    let key: string;
    if (t.isHarness) key = `harness:${t.name}`;
    else if (t.isSprite) key = `sprite:${t.name}`;
    else key = `machine:${t.machineName || t.name}`;
    if (!(key in targetCounts)) targetCounts[key] = 0;
  }
  if (!('local' in targetCounts)) targetCounts['local'] = 0;
  const targetKeys = Object.keys(targetCounts).sort((a, b) => {
    if (a === 'local') return -1;
    if (b === 'local') return 1;
    return a.localeCompare(b);
  });

  const feedbackPath = appId ? `/app/${appId}/feedback` : '/feedback';

  const showPurge = activeStatuses.has('deleted') && activeStatuses.size === 1 && sorted.length > 0;

  return (
    <div>
      <div class="page-header">
        <h2>Sessions ({appFiltered.length})</h2>
        <button class="btn btn-sm" onClick={() => { termPickerOpen.value = { kind: 'new' }; }}>
          Open Terminal
        </button>
      </div>

      <div class="sessions-page-filters">
        <input
          type="text"
          class="sessions-search-input"
          placeholder="Search sessions..."
          value={searchQuery.value}
          onInput={(e) => { searchQuery.value = (e.target as HTMLInputElement).value; }}
        />
      </div>

      <div class="sessions-page-filters">
        <div class="sessions-filter-group">
          {ALL_STATUSES.map((status) => {
            const count = statusCounts[status] || 0;
            return (
              <label key={status} class="sessions-filter-checkbox">
                <input
                  type="checkbox"
                  checked={activeStatuses.has(status)}
                  onChange={() => toggleStatus(status)}
                />
                <span class={`session-status-dot ${status}`} style="position:relative;top:0" />
                {status} {count > 0 && <span class="sessions-filter-count">({count})</span>}
              </label>
            );
          })}
        </div>
        {targetKeys.length > 1 && (
          <div class="sessions-filter-group">
            {targetKeys.map((key) => {
              const count = targetCounts[key] || 0;
              const label = getTargetLabel(key);
              const cat = getTargetCategory(key);
              return (
                <label key={key} class="sessions-filter-checkbox">
                  <input
                    type="checkbox"
                    checked={activeTargets.has(key)}
                    onChange={() => toggleTarget(key)}
                  />
                  {cat && <span class="sessions-filter-badge">{cat}</span>}
                  {label} {count > 0 && <span class="sessions-filter-count">({count})</span>}
                </label>
              );
            })}
          </div>
        )}
        <span style={{ color: 'var(--pw-text-muted)', fontSize: '13px' }}>
          {sorted.length} shown
          {statusCounts.running ? ` \u00b7 ${statusCounts.running} running` : ''}
        </span>
        {showPurge && (
          <button
            class="btn btn-sm btn-danger"
            onClick={() => permanentlyDeleteAll(sorted.map((s) => s.id))}
          >
            Purge all ({sorted.length})
          </button>
        )}
      </div>

      <div class="session-card-list">
        {sorted.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--pw-text-faint)', padding: '24px' }}>No sessions found</div>
        )}
        {sorted.map((s) => {
          const agentLabel = s.permissionProfile === 'plain' ? 'Terminal' : (agentMap.value[s.agentEndpointId] || s.agentEndpointId?.slice(-8) || null);
          const feedbackTitle = feedbackMap.value[s.feedbackId];
          return (
            <div key={s.id} class={`session-card ${s.status}`} onClick={() => openSession(s.id)}>
              <div class="session-card-main">
                <span class={`session-status-dot ${s.status}${s.status === 'running' && sessionInputStates.value.has(s.id) ? ` ${sessionInputStates.value.get(s.id)}` : ''}`} />
                <span class="session-card-label">
                  {feedbackTitle || agentLabel || `Session ${s.id.slice(-8)}`}
                </span>
                <span class="session-card-id">{s.id.slice(-8)}</span>
                <span class={`session-card-status ${s.status}`}>{s.status}</span>
              </div>
              <div class="session-card-meta">
                {agentLabel && feedbackTitle && <span>{agentLabel}</span>}
                <span>{formatRelativeTime(s.startedAt || s.createdAt)}</span>
                <span>{formatDuration(s.startedAt, s.completedAt)}</span>
                {feedbackTitle && (
                  <span
                    class="session-feedback-link"
                    onClick={(e) => { e.stopPropagation(); navigate(`${feedbackPath}/${s.feedbackId}`); }}
                  >
                    feedback
                  </span>
                )}
              </div>
              <div class="session-card-actions" onClick={(e) => e.stopPropagation()}>
                {s.status !== 'deleted' && (
                  <>
                    <button class="btn btn-sm" onClick={() => openSession(s.id)}>
                      {s.status === 'running' ? 'Attach' : 'View'}
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      onClick={() => deleteSession(s.id)}
                      title="Archive session"
                    >
                      &times;
                    </button>
                  </>
                )}
                {s.status === 'deleted' && (
                  <button
                    class="btn btn-sm btn-danger"
                    onClick={() => permanentlyDelete(s.id)}
                    title="Permanently delete"
                  >
                    Delete forever
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <DeletedItemsPanel type="sessions" />
    </div>
  );
}
