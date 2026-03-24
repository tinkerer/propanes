import { signal, computed } from '@preact/signals';
import { applications } from './state.js';
import type { ViewMode } from '../components/SessionViewToggle.js';
import type { TerminalPickerMode } from '../components/TerminalPicker.js';
import {
  layoutTree,
  findLeaf,
  addTabToLeaf,
  ensureSessionsLeaf,
  showSessionsLeaf,
  batch as batchTreeOps,
} from './pane-tree.js';

// --- Utility ---

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// --- Core Signals ---

export const termPickerOpen = signal<TerminalPickerMode | null>(null);

export function buildTmuxAttachCmd(sessionId: string, session?: { isRemote?: boolean; launcherHostname?: string }): string {
  const base = `TMUX= tmux -L prompt-widget attach-session -t pw-${sessionId}`;
  if (session?.isRemote && session?.launcherHostname) {
    return `ssh -t ${session.launcherHostname} '${base}'`;
  }
  return base;
}

export const openTabs = signal<string[]>(loadJson('pw-open-tabs', []));
export const activeTabId = signal<string | null>(loadJson('pw-active-tab', null));
export const previousTabId = signal<string | null>(null);
export const panelMinimized = signal(loadJson('pw-panel-minimized', false));
export const panelMaximized = signal(loadJson('pw-panel-maximized', false));
export const panelHeight = signal(loadJson('pw-panel-height', 400));
export const exitedSessions = signal<Set<string>>(new Set(loadJson<string[]>('pw-exited-sessions', [])));

export const splitEnabled = signal<boolean>(loadJson('pw-split-enabled', false));
export const rightPaneTabs = signal<string[]>(loadJson('pw-right-pane-tabs', []));
export const rightPaneActiveId = signal<string | null>(loadJson('pw-right-pane-active', null));
export const splitRatio = signal<number>(loadJson('pw-split-ratio', 0.5));
export const activePanelId = signal<string | null>('split-left');
export const popInPickerSessionId = signal<string | null>(null);

// Seed pane tree from flat signals on first load (migration)
{
  const leafId = ensureSessionsLeaf();
  const sessLeaf = findLeaf(layoutTree.value.root, leafId);
  if (sessLeaf && sessLeaf.tabs.length === 0 && openTabs.value.length > 0) {
    batchTreeOps(() => {
      for (const tab of openTabs.value) {
        addTabToLeaf(leafId, tab, false);
      }
      if (activeTabId.value) {
        addTabToLeaf(leafId, activeTabId.value, true);
      }
      showSessionsLeaf();
    });
  }
}

// --- Persistence ---

export function persistTabs() {
  localStorage.setItem('pw-open-tabs', JSON.stringify(openTabs.value));
  localStorage.setItem('pw-active-tab', JSON.stringify(activeTabId.value));
  localStorage.setItem('pw-panel-minimized', JSON.stringify(panelMinimized.value));
  localStorage.setItem('pw-exited-sessions', JSON.stringify([...exitedSessions.value]));
}

export function persistPanelState() {
  localStorage.setItem('pw-panel-height', JSON.stringify(panelHeight.value));
  localStorage.setItem('pw-panel-minimized', JSON.stringify(panelMinimized.value));
  localStorage.setItem('pw-panel-maximized', JSON.stringify(panelMaximized.value));
}

export function persistSplitState() {
  localStorage.setItem('pw-split-enabled', JSON.stringify(splitEnabled.value));
  localStorage.setItem('pw-right-pane-tabs', JSON.stringify(rightPaneTabs.value));
  localStorage.setItem('pw-right-pane-active', JSON.stringify(rightPaneActiveId.value));
  localStorage.setItem('pw-split-ratio', JSON.stringify(splitRatio.value));
}

export function nudgeResize() {
  for (const delay of [50, 150, 300]) {
    setTimeout(() => window.dispatchEvent(new Event('resize')), delay);
  }
}

// --- View Modes ---

export const viewModes = signal<Record<string, ViewMode>>({});

export function getViewMode(sessionId: string, permissionProfile?: string): ViewMode {
  if (viewModes.value[sessionId]) return viewModes.value[sessionId];
  if (permissionProfile === 'auto' || permissionProfile === 'yolo') return 'structured';
  return 'terminal';
}

export function setViewMode(sessionId: string, mode: ViewMode) {
  viewModes.value = { ...viewModes.value, [sessionId]: mode };
}

// --- Global Split Pane ---

export function leftPaneTabs(): string[] {
  if (!splitEnabled.value) return openTabs.value;
  const rightSet = new Set(rightPaneTabs.value);
  return openTabs.value.filter((id) => !rightSet.has(id));
}

export function enableSplit(sessionId?: string) {
  if (splitEnabled.value) return;
  const tabs = openTabs.value;
  if (tabs.length < 2) return;
  const target = sessionId || activeTabId.value;
  if (!target || !tabs.includes(target)) return;
  splitEnabled.value = true;
  rightPaneTabs.value = [target];
  rightPaneActiveId.value = target;
  if (activeTabId.value === target) {
    const remaining = tabs.filter((id) => id !== target);
    activeTabId.value = remaining[remaining.length - 1] || null;
  }
  persistSplitState();
  persistTabs();
  nudgeResize();
}

export function disableSplit() {
  if (!splitEnabled.value) return;
  const rightActive = rightPaneActiveId.value;
  splitEnabled.value = false;
  rightPaneTabs.value = [];
  rightPaneActiveId.value = null;
  if (rightActive && openTabs.value.includes(rightActive)) {
    activeTabId.value = rightActive;
  }
  persistSplitState();
  persistTabs();
  nudgeResize();
}

export function moveToRightPane(sessionId: string) {
  if (!splitEnabled.value) return;
  if (!openTabs.value.includes(sessionId)) return;
  if (rightPaneTabs.value.includes(sessionId)) return;
  rightPaneTabs.value = [...rightPaneTabs.value, sessionId];
  rightPaneActiveId.value = sessionId;
  if (activeTabId.value === sessionId) {
    const left = leftPaneTabs();
    activeTabId.value = left.length > 0 ? left[left.length - 1] : null;
  }
  persistSplitState();
  persistTabs();
  nudgeResize();
}

export function moveToLeftPane(sessionId: string) {
  if (!rightPaneTabs.value.includes(sessionId)) return;
  const remaining = rightPaneTabs.value.filter((id) => id !== sessionId);
  rightPaneTabs.value = remaining;
  if (rightPaneActiveId.value === sessionId) {
    rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  activeTabId.value = sessionId;
  if (remaining.length === 0) {
    disableSplit();
    return;
  }
  persistSplitState();
  persistTabs();
  nudgeResize();
}

export function openSessionInRightPane(sessionId: string) {
  if (!openTabs.value.includes(sessionId)) {
    openTabs.value = [...openTabs.value, sessionId];
  }
  if (!splitEnabled.value) enableSplit(sessionId);
  if (!rightPaneTabs.value.includes(sessionId)) {
    rightPaneTabs.value = [...rightPaneTabs.value, sessionId];
  }
  rightPaneActiveId.value = sessionId;
  persistSplitState();
  persistTabs();
}

export function reorderRightPaneTab(sessionId: string, insertBeforeId: string | null) {
  const ids = rightPaneTabs.value.filter((id) => id !== sessionId);
  if (insertBeforeId) {
    const idx = ids.indexOf(insertBeforeId);
    if (idx >= 0) ids.splice(idx, 0, sessionId);
    else ids.push(sessionId);
  } else {
    ids.push(sessionId);
  }
  rightPaneTabs.value = ids;
  persistSplitState();
}

export function setSplitRatio(ratio: number) {
  splitRatio.value = Math.max(0.2, Math.min(0.8, ratio));
  persistSplitState();
}

export function reorderGlobalTab(sessionId: string, insertBeforeId: string | null) {
  const ids = openTabs.value.filter((id) => id !== sessionId);
  if (insertBeforeId) {
    const idx = ids.indexOf(insertBeforeId);
    if (idx >= 0) ids.splice(idx, 0, sessionId);
    else ids.push(sessionId);
  } else {
    ids.push(sessionId);
  }
  openTabs.value = ids;
  persistTabs();
}

// --- Session List ---

export const allSessions = signal<any[]>([]);
export const sessionMapComputed = computed(() => new Map(allSessions.value.map((s: any) => [s.id, s])));
export const sessionsLoading = signal(false);

// --- Session Status Filters ---

export type SessionStatusFilter = 'running' | 'pending' | 'completed' | 'failed' | 'killed';
const DEFAULT_STATUS_FILTERS: SessionStatusFilter[] = ['running', 'pending'];
export const sessionStatusFilters = signal<Set<SessionStatusFilter>>(
  new Set(loadJson<SessionStatusFilter[]>('pw-session-status-filters', DEFAULT_STATUS_FILTERS))
);
export const sessionFiltersOpen = signal(loadJson('pw-session-filters-open', false));

export function toggleStatusFilter(status: SessionStatusFilter) {
  const next = new Set(sessionStatusFilters.value);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  sessionStatusFilters.value = next;
  localStorage.setItem('pw-session-status-filters', JSON.stringify([...next]));
}

export function toggleSessionFiltersOpen() {
  sessionFiltersOpen.value = !sessionFiltersOpen.value;
  localStorage.setItem('pw-session-filters-open', JSON.stringify(sessionFiltersOpen.value));
}

export function sessionPassesFilters(s: any, tabSet: Set<string>): boolean {
  if (s.status === 'deleted') return false;
  if (tabSet.has(s.id)) return true;
  const statusFilters = sessionStatusFilters.value;
  if (!statusFilters.has(s.status)) return false;
  return true;
}

// --- Quick Dispatch ---

export const quickDispatchState = signal<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
export const cachedAgents = signal<any[]>([]);

// --- Action Toast ---

export const actionToast = signal<{ key: string; label: string; color: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showActionToast(key: string, label: string, color = 'var(--pw-primary)') {
  if (toastTimer) clearTimeout(toastTimer);
  actionToast.value = { key, label, color };
  toastTimer = setTimeout(() => { actionToast.value = null; }, 1500);
}

// --- Input States ---

export type InputState = 'active' | 'idle' | 'waiting';
export const sessionInputStates = signal<Map<string, InputState>>(new Map());

// --- Polling Helpers ---

export const includeDeletedInPolling = signal(false);
export const lastTerminalInput = signal(0);

// --- Session Labels & Colors ---

export const sessionLabels = signal<Record<string, string>>(loadJson('pw-session-labels', {}));

export function setSessionLabel(sessionId: string, label: string) {
  const next = { ...sessionLabels.value };
  if (label.trim()) next[sessionId] = label.trim();
  else delete next[sessionId];
  sessionLabels.value = next;
  localStorage.setItem('pw-session-labels', JSON.stringify(next));
}

export function getSessionLabel(sessionId: string): string | undefined {
  return sessionLabels.value[sessionId];
}

export function getWorktreeLabel(session: any): string | null {
  if (!session) return null;
  const effectiveCwd = session.panePath || session.cwd;
  if (!effectiveCwd) return null;
  const appId = session.appId;
  if (!appId) return null;
  const app = applications.value.find((a: any) => a.id === appId);
  if (!app?.projectDir) return null;
  if (effectiveCwd === app.projectDir) return null;
  const parts = effectiveCwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || null;
}

export const SESSION_COLOR_PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#a855f7', '#ec4899', '#06b6d4',
];

export const sessionColors = signal<Record<string, string>>(loadJson('pw-session-colors', {}));

export function setSessionColor(sessionId: string, color: string) {
  const next = { ...sessionColors.value };
  if (color) next[sessionId] = color;
  else delete next[sessionId];
  sessionColors.value = next;
  localStorage.setItem('pw-session-colors', JSON.stringify(next));
}

export function getSessionColor(sessionId: string): string | undefined {
  const direct = sessionColors.value[sessionId];
  if (direct) return direct;
  const colonIdx = sessionId.indexOf(':');
  if (colonIdx >= 0) {
    return sessionColors.value[sessionId.slice(colonIdx + 1)];
  }
  return undefined;
}
