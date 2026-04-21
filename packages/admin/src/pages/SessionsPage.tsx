import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { isEmbedded, applications } from '../lib/state.js';
import { allSessions, openSession, deleteSession, permanentlyDeleteSession, spawnTerminal, sessionInputStates, includeDeletedInPolling, termPickerOpen, openFeedbackItem } from '../lib/sessions.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { cachedTargets, ensureTargetsLoaded } from '../components/DispatchTargetSelect.js';
import { isMobile } from '../lib/viewport.js';

const ALL_STATUSES = ['running', 'pending', 'completed', 'failed', 'killed', 'deleted'] as const;
const DEFAULT_STATUSES = new Set<string>(['running', 'pending', 'completed', 'failed', 'killed']);
const UNLINKED_APP_KEY = '__unlinked__';

type SortMode = 'activity' | 'started';
const SORT_STORAGE_KEY = 'pw-sessions-sort-mode';
function loadSortMode(): SortMode {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw === 'started' || raw === 'activity') return raw;
  } catch { /* ignore */ }
  return 'activity';
}

function loadSetFromStorage(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveSetToStorage(key: string, set: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
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

function getSessionTargetKey(s: any): string {
  if (s.harnessName) return `harness:${s.harnessName}`;
  if (s.spriteConfigId) return `sprite:${s.machineName || s.launcherName || 'sprite'}`;
  if (s.isRemote && s.machineName) return `machine:${s.machineName}`;
  if (s.isRemote && s.launcherName) return `machine:${s.launcherName}`;
  return 'local';
}

function getTargetLabel(key: string): string {
  if (key === 'local') return 'Local';
  const [, name] = key.split(':', 2);
  return name || key.split(':')[0];
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
  const filterStatuses = useSignal<Set<string>>(new Set(DEFAULT_STATUSES));
  const filterTargets = useSignal<Set<string>>(new Set<string>());
  const filterApps = useSignal<Set<string>>(new Set<string>());
  const searchQuery = useSignal('');
  const feedbackMap = useSignal<Record<string, string>>({});
  const agentMap = useSignal<Record<string, string>>({});
  const agentAppMap = useSignal<Record<string, string | null>>({});
  const metaWiggumAgentIds = useSignal<Set<string>>(new Set());
  const mapsLoaded = useSignal(false);
  // Maps a session (or its feedbackId) to its originating Chief-of-Staff thread.
  // `sessionToCos` is the precise link (parsed from dispatch result); `feedbackToCos`
  // is the fallback used when the result couldn't be parsed. Most-recent dispatch wins.
  type CosLink = { threadId: string; name: string; agentId: string; createdAt: number };
  const sessionToCos = useSignal<Map<string, CosLink>>(new Map());
  const feedbackToCos = useSignal<Map<string, CosLink>>(new Map());
  const expandedSwarms = useSignal<Set<string>>(loadSetFromStorage('pw-sessions-expanded-swarms'));
  const collapsedApps = useSignal<Set<string>>(loadSetFromStorage('pw-sessions-collapsed-apps'));
  const filtersCollapsed = useSignal(
    (() => {
      try {
        const raw = localStorage.getItem('pw-sessions-filters-collapsed');
        if (raw === 'true') return true;
        if (raw === 'false') return false;
      } catch { /* ignore */ }
      return isMobile.value;
    })(),
  );
  const sortMode = useSignal<SortMode>(loadSortMode());
  function setSortMode(mode: SortMode) {
    sortMode.value = mode;
    try { localStorage.setItem(SORT_STORAGE_KEY, mode); } catch { /* ignore */ }
  }
  function toggleFiltersCollapsed() {
    const next = !filtersCollapsed.value;
    filtersCollapsed.value = next;
    try { localStorage.setItem('pw-sessions-filters-collapsed', String(next)); } catch { /* ignore */ }
  }

  function toggleSwarm(orchId: string) {
    const next = new Set(expandedSwarms.value);
    if (next.has(orchId)) next.delete(orchId); else next.add(orchId);
    expandedSwarms.value = next;
    saveSetToStorage('pw-sessions-expanded-swarms', next);
  }

  function toggleAppSection(appKey: string) {
    const next = new Set(collapsedApps.value);
    if (next.has(appKey)) next.delete(appKey); else next.add(appKey);
    collapsedApps.value = next;
    saveSetToStorage('pw-sessions-collapsed-apps', next);
  }

  function toggleAppFilter(appKey: string) {
    const next = new Set(filterApps.value);
    if (next.has(appKey)) next.delete(appKey); else next.add(appKey);
    filterApps.value = next;
  }

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
      const mwIds = new Set<string>();
      for (const a of agents) {
        am[a.id] = a.name || a.id.slice(-8);
        aam[a.id] = a.appId || null;
        if (a.promptTemplate && a.promptTemplate.includes('meta-wiggum orchestrator')) {
          mwIds.add(a.id);
        }
      }
      agentMap.value = am;
      agentAppMap.value = aam;
      metaWiggumAgentIds.value = mwIds;
      mapsLoaded.value = true;
    } catch {
      // ignore
    }
  }

  async function loadCosDispatches() {
    try {
      const { dispatches } = await api.getCosDispatches();
      // Endpoint orders dispatches newest-first, so the *last* write to each
      // map key wins — flip iteration so the newest dispatch ends up persisted.
      const sMap = new Map<string, CosLink>();
      const fMap = new Map<string, CosLink>();
      for (let i = dispatches.length - 1; i >= 0; i--) {
        const d = dispatches[i];
        const link: CosLink = {
          threadId: d.cosThreadId,
          name: d.cosThreadName,
          agentId: d.cosAgentId,
          createdAt: d.createdAt,
        };
        if (d.sessionId) sMap.set(d.sessionId, link);
        fMap.set(d.feedbackId, link);
      }
      sessionToCos.value = sMap;
      feedbackToCos.value = fMap;
    } catch {
      // ignore — sessions still render flat
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

  useEffect(() => {
    loadMaps();
    loadCosDispatches();
    ensureTargetsLoaded();
    includeDeletedInPolling.value = true;
    // Poll CoS dispatches periodically so sessions launched while this page is
    // open get nested under their thread without a full reload.
    const cosTimer = window.setInterval(() => { loadCosDispatches(); }, 30_000);
    return () => {
      includeDeletedInPolling.value = false;
      window.clearInterval(cosTimer);
    };
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

  // Resolve effective appId for each session — prefer session.appId, fall back
  // to the agent endpoint's appId. Returns UNLINKED_APP_KEY when there is none.
  const resolveAppId = (s: any): string => {
    if (s.appId) return s.appId;
    if (s.agentEndpointId && agentAppMap.value[s.agentEndpointId]) {
      return agentAppMap.value[s.agentEndpointId] as string;
    }
    return UNLINKED_APP_KEY;
  };

  // If the user has explicitly chosen apps via the in-page filter, that
  // overrides the route's appId scope (so users can widen the view past one
  // app without leaving the page). Otherwise the route's appId scopes the list.
  const activeApps = filterApps.value;
  let appFiltered: any[];
  if (activeApps.size > 0) {
    appFiltered = sessions.filter((s) => activeApps.has(resolveAppId(s)));
  } else if (appId && appId !== UNLINKED_APP_KEY) {
    appFiltered = sessions.filter((s) => resolveAppId(s) === appId);
  } else if (appId === UNLINKED_APP_KEY) {
    appFiltered = sessions.filter((s) => resolveAppId(s) === UNLINKED_APP_KEY);
  } else {
    appFiltered = sessions;
  }

  const activeStatuses = filterStatuses.value;
  let filtered = appFiltered.filter((s) => activeStatuses.has(s.status));

  const activeTargets = filterTargets.value;
  if (activeTargets.size > 0) {
    filtered = filtered.filter((s) => activeTargets.has(getSessionTargetKey(s)));
  }

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

  // Most recent meaningful timestamp for "last activity":
  // lastActivityAt (PTY output / input) → completedAt → startedAt → createdAt.
  const activityTime = (s: any): number => {
    const candidate = s.lastActivityAt || s.completedAt || s.startedAt || s.createdAt;
    return candidate ? new Date(candidate).getTime() : 0;
  };
  const startedTime = (s: any): number => {
    const candidate = s.startedAt || s.createdAt;
    return candidate ? new Date(candidate).getTime() : 0;
  };
  const sortBySelected = (a: any, b: any) => {
    const statusOrder = (s: string) => s === 'running' ? 0 : s === 'pending' ? 1 : 2;
    const diff = statusOrder(a.status) - statusOrder(b.status);
    if (diff !== 0) return diff;
    const score = sortMode.value === 'activity' ? activityTime : startedTime;
    return score(b) - score(a);
  };

  // Build swarm hierarchy using server-provided swarmId/wiggumRunId linkage
  // AND the legacy parentSessionId chain approach.
  const sessionById = new Map<string, any>(sessions.map((s: any) => [s.id, s]));
  const isOrchestrator = (s: any): boolean =>
    !!(s && s.agentEndpointId && metaWiggumAgentIds.value.has(s.agentEndpointId));

  // IDs in the filtered (visible) set. We only create groups when the header is
  // itself visible — a group whose parent is filtered out would be confusing.
  const filteredIds = new Set<string>(filtered.map((s: any) => s.id));

  // Any session that is referenced as a parent by at least one *visible* session.
  // Used to decide whether a session should become a parent-group header.
  const parentOfVisible = new Set<string>();
  for (const s of filtered) {
    if (s.parentSessionId) parentOfVisible.add(s.parentSessionId);
  }

  // Walk the parent chain (with cycle guard) and return the topmost orchestrator
  // ancestor, or null if the session is standalone.
  const findSwarmRoot = (s: any): any | null => {
    let root: any | null = isOrchestrator(s) ? s : null;
    let cur: any = s;
    const seen = new Set<string>();
    while (cur && cur.parentSessionId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = sessionById.get(cur.parentSessionId);
      if (!parent) break;
      if (isOrchestrator(parent)) root = parent;
      cur = parent;
    }
    return root;
  };

  // Walk the parent chain and return the topmost *visible* ancestor. If the session
  // itself is a parent of another visible session and has no visible ancestor of
  // its own, it becomes its own group header.
  const findParentRoot = (s: any): any | null => {
    let topmost: any | null = parentOfVisible.has(s.id) ? s : null;
    let cur: any = s;
    const seen = new Set<string>();
    while (cur && cur.parentSessionId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = sessionById.get(cur.parentSessionId);
      if (!parent) break;
      if (filteredIds.has(parent.id)) topmost = parent;
      cur = parent;
    }
    return topmost;
  };

  // Determine grouping key for a session:
  // 1. swarmId → group under swarm (FAFO sessions)
  // 2. wiggumRunId (no swarm) → group under wiggum run
  // 3. dispatched by Chief of Staff → group under CoS thread
  // 4. parentSessionId orchestrator chain → legacy meta-wiggum grouping
  // 5. parentSessionId chain (non-orchestrator) → generic parent/child group
  // 6. null → standalone
  type GroupKey = { type: 'swarm'; id: string; name: string }
    | { type: 'wiggum'; runId: string }
    | { type: 'cos'; threadId: string; name: string; agentId: string }
    | { type: 'orchestrator'; session: any }
    | { type: 'parent'; session: any }
    | null;

  // Sessions linked to a CoS thread either by sessionId (precise) or
  // feedbackId (fallback when the dispatch result wasn't captured).
  const cosLinkFor = (s: any): CosLink | null => {
    const bySession = sessionToCos.value.get(s.id);
    if (bySession) return bySession;
    if (s.feedbackId) return feedbackToCos.value.get(s.feedbackId) || null;
    return null;
  };

  const getGroupKey = (s: any): GroupKey => {
    if (s.swarmId) return { type: 'swarm', id: s.swarmId, name: s.swarmName || `Swarm ${s.swarmId.slice(-8)}` };
    if (s.wiggumRunId) return { type: 'wiggum', runId: s.wiggumRunId };
    const cos = cosLinkFor(s);
    if (cos) return { type: 'cos', threadId: cos.threadId, name: cos.name, agentId: cos.agentId };
    const root = findSwarmRoot(s);
    if (root) return { type: 'orchestrator', session: root };
    const parentRoot = findParentRoot(s);
    if (parentRoot) return { type: 'parent', session: parentRoot };
    return null;
  };

  // Group entries: key is "swarm:<id>" | "wiggum:<runId>" | "cos:<threadId>" | "orch:<sessionId>" | "parent:<sessionId>"
  type SwarmEntry = { label: string; type: 'swarm' | 'wiggum' | 'cos' | 'orchestrator' | 'parent'; refId: string; orchestrator: any | null; children: any[]; cosAgentId?: string };
  type AppGroup = {
    appKey: string;
    swarms: Map<string, SwarmEntry>;
    standalone: any[];
    visibleCount: number;
  };
  const appGroups = new Map<string, AppGroup>();
  const ensureGroup = (appKey: string): AppGroup => {
    let g = appGroups.get(appKey);
    if (!g) {
      g = { appKey, swarms: new Map(), standalone: [], visibleCount: 0 };
      appGroups.set(appKey, g);
    }
    return g;
  };

  for (const s of filtered) {
    const appKey = resolveAppId(s);
    const group = ensureGroup(appKey);
    const gk = getGroupKey(s);
    if (gk) {
      let mapKey: string;
      let entry: SwarmEntry | undefined;
      if (gk.type === 'swarm') {
        mapKey = `swarm:${gk.id}`;
        entry = group.swarms.get(mapKey);
        if (!entry) {
          entry = { label: `\uD83E\uDDEC ${gk.name}`, type: 'swarm', refId: gk.id, orchestrator: null, children: [] };
          group.swarms.set(mapKey, entry);
        }
      } else if (gk.type === 'wiggum') {
        mapKey = `wiggum:${gk.runId}`;
        entry = group.swarms.get(mapKey);
        if (!entry) {
          entry = { label: `\uD83D\uDD04 Wiggum ${gk.runId.slice(-8)}`, type: 'wiggum', refId: gk.runId, orchestrator: null, children: [] };
          group.swarms.set(mapKey, entry);
        }
      } else if (gk.type === 'cos') {
        mapKey = `cos:${gk.threadId}`;
        entry = group.swarms.get(mapKey);
        if (!entry) {
          entry = { label: gk.name, type: 'cos', refId: gk.threadId, orchestrator: null, children: [], cosAgentId: gk.agentId };
          group.swarms.set(mapKey, entry);
        }
      } else if (gk.type === 'orchestrator') {
        mapKey = `orch:${gk.session.id}`;
        entry = group.swarms.get(mapKey);
        if (!entry) {
          entry = { label: '', type: 'orchestrator', refId: gk.session.id, orchestrator: gk.session, children: [] };
          group.swarms.set(mapKey, entry);
        }
      } else {
        // generic parent/child
        mapKey = `parent:${gk.session.id}`;
        entry = group.swarms.get(mapKey);
        if (!entry) {
          entry = { label: '', type: 'parent', refId: gk.session.id, orchestrator: gk.session, children: [] };
          group.swarms.set(mapKey, entry);
        }
      }
      entry.children.push(s);
    } else {
      group.standalone.push(s);
    }
    group.visibleCount += 1;
  }

  // Sort children inside each swarm and standalone lists
  for (const group of appGroups.values()) {
    group.standalone.sort(sortBySelected);
    for (const entry of group.swarms.values()) {
      entry.children.sort(sortBySelected);
    }
  }

  // Sort the apps so the route's appId comes first, "unlinked" last,
  // others alphabetically by name.
  const appNameByKey = (k: string): string => {
    if (k === UNLINKED_APP_KEY) return 'Unlinked';
    return applications.value.find((a: any) => a.id === k)?.name || k.slice(-8);
  };
  const orderedAppGroups = [...appGroups.values()].sort((a, b) => {
    if (a.appKey === appId) return -1;
    if (b.appKey === appId) return 1;
    if (a.appKey === UNLINKED_APP_KEY) return 1;
    if (b.appKey === UNLINKED_APP_KEY) return -1;
    return appNameByKey(a.appKey).localeCompare(appNameByKey(b.appKey));
  });

  const sorted = filtered; // back-compat for the count line below
  const totalVisible = filtered.length;

  const statusCounts = appFiltered.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  // App counts (used by the in-page app filter chip group). These reflect the
  // full session list — the chip group lets users widen scope past the route's appId.
  const appCounts: Record<string, number> = {};
  for (const s of sessions) {
    const k = resolveAppId(s);
    appCounts[k] = (appCounts[k] || 0) + 1;
  }
  const appKeysForFilter = [
    ...applications.value.map((a: any) => a.id as string),
    UNLINKED_APP_KEY,
  ].filter((k) => (appCounts[k] || 0) > 0);

  const targetCounts: Record<string, number> = {};
  for (const s of appFiltered) {
    const key = getSessionTargetKey(s);
    targetCounts[key] = (targetCounts[key] || 0) + 1;
  }
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

  const showPurge = activeStatuses.has('deleted') && activeStatuses.size === 1 && totalVisible > 0;

  // Count how many filter categories are non-default for the badge on the
  // "Filters" toggle button. Status defaults to DEFAULT_STATUSES, so only a
  // deliberate deviation counts.
  const statusIsDefault = activeStatuses.size === DEFAULT_STATUSES.size
    && [...DEFAULT_STATUSES].every((s) => activeStatuses.has(s));
  const activeFilterCount =
    (statusIsDefault ? 0 : 1) +
    (activeTargets.size > 0 ? 1 : 0) +
    (activeApps.size > 0 ? 1 : 0) +
    (searchQuery.value ? 1 : 0);

  // Whether to show app section headers. We section by app whenever the user
  // is looking at more than one app worth of results (either no route appId,
  // or the in-page app filter has widened scope).
  const showAppSections = orderedAppGroups.length > 1;

  // -------- Inline session row renderer --------
  const renderSessionRow = (s: any, opts: { indent?: boolean; isOrchestrator?: boolean; headerBadge?: string; isExpanded?: boolean; onToggleExpand?: () => void; childCount?: number } = {}) => {
    const agentLabel = s.permissionProfile === 'plain' ? 'Terminal' : (agentMap.value[s.agentEndpointId] || s.agentEndpointId?.slice(-8) || null);
    const feedbackTitle = feedbackMap.value[s.feedbackId];
    const inputState = sessionInputStates.value.get(s.id);
    const badge = opts.isOrchestrator ? (opts.headerBadge ?? 'orchestrator') : null;
    return (
      <div
        key={s.id}
        class={`session-card ${s.status}${opts.indent ? ' session-card-indent' : ''}${opts.isOrchestrator ? ' session-card-orchestrator' : ''}`}
        onClick={() => openSession(s.id)}
      >
        <div class="session-card-main">
          {opts.isOrchestrator && (
            <button
              class="session-swarm-toggle"
              onClick={(e) => { e.stopPropagation(); opts.onToggleExpand?.(); }}
              title={opts.isExpanded ? 'Collapse' : 'Expand'}
            >
              {opts.isExpanded ? '\u25be' : '\u25b8'}
            </button>
          )}
          <span class={`session-status-dot ${s.status}${s.status === 'running' && inputState ? ` ${inputState}` : ''}`} />
          {badge && (
            <span class={`session-orchestrator-badge${badge === 'parent' ? ' session-parent-badge' : ''}`}>{badge}</span>
          )}
          <span class="session-card-label">
            {feedbackTitle || agentLabel || `Session ${s.id.slice(-8)}`}
          </span>
          <span class="session-card-id">{s.id.slice(-8)}</span>
          <span class={`session-card-status ${s.status}`}>{s.status}</span>
          {opts.isOrchestrator && opts.childCount !== undefined && opts.childCount > 0 && (
            <span class="session-swarm-count">{opts.childCount} child{opts.childCount === 1 ? '' : 'ren'}</span>
          )}
        </div>
        <div class="session-card-meta">
          {agentLabel && feedbackTitle && <span>{agentLabel}</span>}
          {sortMode.value === 'activity' && s.lastActivityAt ? (
            <>
              <span title={`Last activity: ${new Date(s.lastActivityAt).toLocaleString()}`}>
                active {formatRelativeTime(s.lastActivityAt)}
              </span>
              <span title={`Started: ${new Date(s.startedAt || s.createdAt || 0).toLocaleString()}`}>
                started {formatRelativeTime(s.startedAt || s.createdAt)}
              </span>
            </>
          ) : (
            <span>{formatRelativeTime(s.startedAt || s.createdAt)}</span>
          )}
          <span>{formatDuration(s.startedAt, s.completedAt)}</span>
          {feedbackTitle && (
            <span
              class="session-feedback-link"
              onClick={(e) => { e.stopPropagation(); openFeedbackItem(s.feedbackId); }}
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
  };

  const renderGroupBody = (group: AppGroup) => {
    // Sort groups: newest first by their first child's start time
    const swarmEntries = [...group.swarms.values()].sort((a, b) => {
      const aFirst = a.orchestrator || a.children[0];
      const bFirst = b.orchestrator || b.children[0];
      return sortBySelected(aFirst, bFirst);
    });
    return (
      <>
        {swarmEntries.map((entry) => {
          const groupKey = `${entry.type}:${entry.refId}`;
          const expanded = expandedSwarms.value.has(groupKey);

          if ((entry.type === 'orchestrator' || entry.type === 'parent') && entry.orchestrator) {
            // Parent session as header. 'orchestrator' keeps the legacy badge for
            // meta-wiggum; 'parent' uses a lighter "parent" badge.
            const isParent = entry.type === 'parent';
            const headerBadge = isParent ? 'parent' : 'orchestrator';
            return (
              <div key={`swarm-${groupKey}`} class={`session-swarm-group${isParent ? ' session-parent-group' : ''}`}>
                {renderSessionRow(entry.orchestrator, {
                  isOrchestrator: true,
                  headerBadge,
                  isExpanded: expanded,
                  onToggleExpand: () => toggleSwarm(groupKey),
                  childCount: entry.children.filter(c => c.id !== entry.orchestrator.id).length,
                })}
                {expanded && entry.children
                  .filter(c => c.id !== entry.orchestrator.id)
                  .map((c) => renderSessionRow(c, { indent: true }))}
              </div>
            );
          }

          // FAFO swarm, wiggum run, or CoS thread group — custom header row
          const activeCount = entry.children.filter((c: any) => c.status === 'running').length;
          const badgeText = entry.type === 'swarm' ? 'FAFO' : entry.type === 'wiggum' ? 'wiggum' : 'CoS';
          const isCos = entry.type === 'cos';
          return (
            <div key={`swarm-${groupKey}`} class={`session-swarm-group${isCos ? ' session-cos-group' : ''}`}>
              <div
                class="session-card session-card-orchestrator"
                onClick={() => toggleSwarm(groupKey)}
                style={{ cursor: 'pointer' }}
              >
                <div class="session-card-main">
                  <button
                    class="session-swarm-toggle"
                    onClick={(e) => { e.stopPropagation(); toggleSwarm(groupKey); }}
                  >
                    {expanded ? '\u25be' : '\u25b8'}
                  </button>
                  <span class={`session-orchestrator-badge${isCos ? ' session-cos-badge' : ''}`}>{badgeText}</span>
                  <span class="session-card-label">{entry.label}</span>
                  <span class="session-swarm-count">
                    {entry.children.length} session{entry.children.length === 1 ? '' : 's'}
                    {activeCount > 0 ? ` \u00b7 ${activeCount} running` : ''}
                  </span>
                </div>
              </div>
              {expanded && entry.children.map((c) => renderSessionRow(c, { indent: true }))}
            </div>
          );
        })}
        {group.standalone.map((s) => renderSessionRow(s))}
      </>
    );
  };

  return (
    <div>
      <div class="page-header">
        <h2>Sessions ({appFiltered.length})</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            class="btn-filter-toggle"
            onClick={toggleFiltersCollapsed}
            title={filtersCollapsed.value ? 'Show filters' : 'Hide filters'}
          >
            Filters
            {activeFilterCount > 0 && <span class="filter-count">{activeFilterCount}</span>}
            <span class={`filter-toggle-chevron ${filtersCollapsed.value ? 'collapsed' : ''}`}>&#9662;</span>
          </button>
          <button class="btn btn-sm" onClick={() => { termPickerOpen.value = { kind: 'new' }; }}>
            Open Terminal
          </button>
        </div>
      </div>

      {!filtersCollapsed.value && (
        <div class="sessions-filters-panel">
          <input
            type="text"
            class="sessions-search-input"
            placeholder="Search sessions..."
            value={searchQuery.value}
            onInput={(e) => { searchQuery.value = (e.target as HTMLInputElement).value; }}
          />

          <div class="sessions-filter-row">
            <span class="sessions-filter-label">Sort</span>
            <div class="sessions-filter-group">
              <button
                type="button"
                class={`sessions-filter-pill${sortMode.value === 'activity' ? ' active' : ''}`}
                onClick={() => setSortMode('activity')}
                title="Most recently active first"
              >
                Recent activity
              </button>
              <button
                type="button"
                class={`sessions-filter-pill${sortMode.value === 'started' ? ' active' : ''}`}
                onClick={() => setSortMode('started')}
                title="Most recently started first"
              >
                Started
              </button>
            </div>
          </div>

          <div class="sessions-filter-row">
            <span class="sessions-filter-label">Status</span>
            <div class="sessions-filter-group">
              {ALL_STATUSES.map((status) => {
                const count = statusCounts[status] || 0;
                const active = activeStatuses.has(status);
                return (
                  <button
                    key={status}
                    type="button"
                    class={`sessions-filter-pill${active ? ' active' : ''}`}
                    onClick={() => toggleStatus(status)}
                  >
                    <span class={`session-status-dot ${status}`} style="position:relative;top:0" />
                    {status} {count > 0 && <span class="sessions-filter-count">({count})</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {targetKeys.length > 1 && (
            <div class="sessions-filter-row">
              <span class="sessions-filter-label">Where</span>
              <div class="sessions-filter-group">
                {targetKeys.map((key) => {
                  const count = targetCounts[key] || 0;
                  const label = getTargetLabel(key);
                  const cat = getTargetCategory(key);
                  const active = activeTargets.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      class={`sessions-filter-pill${active ? ' active' : ''}`}
                      onClick={() => toggleTarget(key)}
                    >
                      {cat && <span class="sessions-filter-badge">{cat}</span>}
                      {label} {count > 0 && <span class="sessions-filter-count">({count})</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {appKeysForFilter.length > 1 && (
            <div class="sessions-filter-row">
              <span class="sessions-filter-label">Apps</span>
              <div class="sessions-filter-group">
                {appKeysForFilter.map((key) => {
                  const count = appCounts[key] || 0;
                  const active = activeApps.has(key);
                  return (
                    <button
                      key={`app-${key}`}
                      type="button"
                      class={`sessions-filter-pill${active ? ' active' : ''}`}
                      onClick={() => toggleAppFilter(key)}
                    >
                      {appNameByKey(key)} {count > 0 && <span class="sessions-filter-count">({count})</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div class="sessions-filter-summary">
            <span>
              {totalVisible} shown
              {statusCounts.running ? ` \u00b7 ${statusCounts.running} running` : ''}
            </span>
            {showPurge && (
              <button
                class="btn btn-sm btn-danger"
                onClick={() => permanentlyDeleteAll(filtered.map((s) => s.id))}
              >
                Purge all ({totalVisible})
              </button>
            )}
          </div>
        </div>
      )}

      <div class="session-card-list">
        {totalVisible === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--pw-text-faint)', padding: '24px' }}>No sessions found</div>
        )}
        {showAppSections
          ? orderedAppGroups.map((group) => {
              const collapsed = collapsedApps.value.has(group.appKey);
              return (
                <div key={`appsec-${group.appKey}`} class="session-app-section">
                  <div class="session-app-section-header" onClick={() => toggleAppSection(group.appKey)}>
                    <span class="session-app-section-chevron">{collapsed ? '\u25b8' : '\u25be'}</span>
                    <span class="session-app-section-name">{appNameByKey(group.appKey)}</span>
                    <span class="session-app-section-count">{group.visibleCount}</span>
                  </div>
                  {!collapsed && (
                    <div class="session-app-section-body">
                      {renderGroupBody(group)}
                    </div>
                  )}
                </div>
              );
            })
          : orderedAppGroups.map((group) => renderGroupBody(group))}
      </div>
      <DeletedItemsPanel type="sessions" />
    </div>
  );
}
