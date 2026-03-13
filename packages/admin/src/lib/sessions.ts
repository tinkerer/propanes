import { signal, effect } from '@preact/signals';
import { api } from './api.js';
import { autoNavigateToFeedback, autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, autoJumpLogs, autoCloseWaitingPanel, autoJumpHandleBounce } from './settings.js';
import { navigate, selectedAppId, applications } from './state.js';
import { timed } from './perf.js';
import type { ViewMode } from '../components/SessionViewToggle.js';
import type { TerminalPickerMode } from '../components/TerminalPicker.js';
import {
  layoutTree,
  findLeaf,
  findLeafWithTab,
  findCompanionSibling,
  addTabToLeaf,
  removeTabFromLeaf,
  splitLeaf,
  mergeLeaf,
  focusedLeafId,
  showSessionsLeaf,
  SESSIONS_LEAF_ID,
} from './pane-tree.js';

export const termPickerOpen = signal<TerminalPickerMode | null>(null);

export function buildTmuxAttachCmd(sessionId: string, session?: { isRemote?: boolean; launcherHostname?: string }): string {
  const base = `TMUX= tmux -L prompt-widget attach-session -t pw-${sessionId}`;
  if (session?.isRemote && session?.launcherHostname) {
    return `ssh -t ${session.launcherHostname} '${base}'`;
  }
  return base;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
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

// Seed pane tree from flat signals on first load (migration)
{
  const sessLeaf = findLeaf(layoutTree.value.root, SESSIONS_LEAF_ID);
  if (sessLeaf && sessLeaf.tabs.length === 0 && openTabs.value.length > 0) {
    for (const tab of openTabs.value) {
      addTabToLeaf(SESSIONS_LEAF_ID, tab, false);
    }
    if (activeTabId.value) {
      addTabToLeaf(SESSIONS_LEAF_ID, activeTabId.value, true);
    }
    showSessionsLeaf();
  }
}

export const controlBarMinimized = signal(loadJson('pw-control-bar-minimized', false));
export function toggleControlBarMinimized() {
  controlBarMinimized.value = !controlBarMinimized.value;
  localStorage.setItem('pw-control-bar-minimized', JSON.stringify(controlBarMinimized.value));
}

export const AUTOJUMP_PANEL_ID = 'p-autojump';

/** Set when user manually closes the autojump panel; prevents auto-reopen until user clicks handle */
export const autoJumpDismissed = signal(false);
/** Incremented to trigger a bounce animation on the autojump panel grab handle */
export const handleBounceCounter = signal(0);

export function triggerHandleBounce() {
  if (autoJumpHandleBounce.value) {
    handleBounceCounter.value++;
  }
}

export interface AutoJumpSessionDims {
  docked: boolean;
  dockedHeight: number;
  dockedWidth: number;
  dockedSide?: 'left' | 'right';
  dockedTopOffset?: number;
  floatingRect: { x: number; y: number; w: number; h: number };
  splitEnabled?: boolean;
  splitRatio?: number;
  rightPaneTabs?: string[];
  rightPaneActiveId?: string | null;
}

const autoJumpSessionDims = signal<Record<string, AutoJumpSessionDims>>(
  loadJson('pw-autojump-session-dims', {})
);

function persistAutoJumpDims() {
  localStorage.setItem('pw-autojump-session-dims', JSON.stringify(autoJumpSessionDims.value));
}

export function saveAutoJumpDimsForActiveSession() {
  const panel = popoutPanels.value.find((p) => p.id === AUTOJUMP_PANEL_ID);
  if (!panel) return;
  const sid = panel.activeSessionId;
  if (!sid) return;
  const dims: AutoJumpSessionDims = {
    docked: panel.docked,
    dockedHeight: panel.dockedHeight,
    dockedWidth: panel.dockedWidth,
    dockedSide: panel.dockedSide,
    dockedTopOffset: panel.dockedTopOffset,
    floatingRect: { ...panel.floatingRect },
    splitEnabled: panel.splitEnabled,
    splitRatio: panel.splitRatio,
    rightPaneTabs: panel.rightPaneTabs ? [...panel.rightPaneTabs] : undefined,
    rightPaneActiveId: panel.rightPaneActiveId,
  };
  autoJumpSessionDims.value = { ...autoJumpSessionDims.value, [sid]: dims };
  persistAutoJumpDims();
}

function applyAutoJumpDimsForSession(sessionId: string) {
  const saved = autoJumpSessionDims.value[sessionId];
  if (!saved) return;
  updatePanel(AUTOJUMP_PANEL_ID, {
    docked: saved.docked,
    dockedHeight: saved.dockedHeight,
    dockedWidth: saved.dockedWidth,
    dockedSide: saved.dockedSide,
    dockedTopOffset: saved.dockedTopOffset,
    floatingRect: { ...saved.floatingRect },
    splitEnabled: saved.splitEnabled,
    splitRatio: saved.splitRatio,
    rightPaneTabs: saved.rightPaneTabs ? [...saved.rightPaneTabs] : [],
    rightPaneActiveId: saved.rightPaneActiveId ?? null,
  });
}

/** Transfer companion split state from autojump panel dims to the global panel */
function transferAutoJumpToGlobalPanel(sessionId: string) {
  const panel = popoutPanels.value.find((p) => p.id === AUTOJUMP_PANEL_ID);
  const dims = panel
    ? {
        splitEnabled: panel.splitEnabled,
        splitRatio: panel.splitRatio,
        rightPaneTabs: panel.rightPaneTabs,
        rightPaneActiveId: panel.rightPaneActiveId,
      }
    : autoJumpSessionDims.value[sessionId];
  if (!dims) return;

  if (dims.splitEnabled && dims.rightPaneTabs && dims.rightPaneTabs.length > 0) {
    splitEnabled.value = true;
    rightPaneTabs.value = [...dims.rightPaneTabs];
    rightPaneActiveId.value = dims.rightPaneActiveId ?? dims.rightPaneTabs[0];
    splitRatio.value = dims.splitRatio ?? 0.5;
    // Ensure companion tabs exist in openTabs
    for (const tab of dims.rightPaneTabs) {
      if (!openTabs.value.includes(tab)) {
        openTabs.value = [...openTabs.value, tab];
      }
    }
    persistSplitState();
    persistTabs();
  }
  // Ensure the global panel is visible
  panelMinimized.value = false;
  persistPanelState();
}

export function switchAutoJumpActiveSession(panelId: string, newSessionId: string) {
  if (panelId !== AUTOJUMP_PANEL_ID) return false;
  saveAutoJumpDimsForActiveSession();
  updatePanel(panelId, { activeSessionId: newSessionId });
  applyAutoJumpDimsForSession(newSessionId);
  persistPopoutState();
  return true;
}

export interface PopoutPanelState {
  id: string;
  sessionIds: string[];
  activeSessionId: string;
  docked: boolean;
  visible: boolean;
  floatingRect: { x: number; y: number; w: number; h: number };
  dockedHeight: number;
  dockedWidth: number;
  dockedTopOffset?: number;
  minimized?: boolean;
  dockedSide?: 'left' | 'right';
  grabY?: number;
  alwaysOnTop?: boolean;
  splitEnabled?: boolean;
  splitRatio?: number;
  rightPaneTabs?: string[];
  rightPaneActiveId?: string | null;
  autoOpened?: boolean;
  maximized?: boolean;
  preMaximizeRect?: { x: number; y: number; w: number; h: number };
}

function migrateOldPopoutState(): PopoutPanelState[] {
  const oldIds = loadJson<string[]>('pw-popout-tab-ids', []);
  if (oldIds.length === 0) return loadJson<PopoutPanelState[]>('pw-popout-panels', []);
  const oldActive = loadJson<string | null>('pw-popout-active', null);
  const oldVisible = loadJson<boolean>('pw-popout-visible', true);
  const oldDocked = loadJson<boolean>('pw-popout-docked', true);
  const oldRect = loadJson('pw-popout-rect', { x: 200, y: 100, w: 700, h: 500 });
  const oldDockedRect = loadJson('pw-popout-docked-rect', { top: 60, height: 500, width: 500 });
  const panel: PopoutPanelState = {
    id: 'p-migrated',
    sessionIds: oldIds,
    activeSessionId: oldActive || oldIds[0],
    docked: oldDocked,
    visible: oldVisible,
    floatingRect: oldRect,
    dockedHeight: oldDockedRect.height,
    dockedWidth: oldDockedRect.width,
  };
  localStorage.removeItem('pw-popout-tab-ids');
  localStorage.removeItem('pw-popout-active');
  localStorage.removeItem('pw-popout-visible');
  localStorage.removeItem('pw-popout-rect');
  localStorage.removeItem('pw-popout-docked');
  localStorage.removeItem('pw-popout-docked-rect');
  localStorage.removeItem('pw-docked-panel-width');
  localStorage.setItem('pw-popout-panels', JSON.stringify([panel]));
  return [panel];
}

function ensurePanelWidth(panels: PopoutPanelState[]): PopoutPanelState[] {
  return panels.map((p) => p.dockedWidth ? p : { ...p, dockedWidth: 500 });
}

export const popoutPanels = signal<PopoutPanelState[]>(ensurePanelWidth(migrateOldPopoutState()));

export type DockedOrientation = 'vertical' | 'horizontal';
export const dockedOrientation = signal<DockedOrientation>(loadJson('pw-docked-orientation', 'vertical'));

export function toggleDockedOrientation() {
  dockedOrientation.value = dockedOrientation.value === 'vertical' ? 'horizontal' : 'vertical';
  localStorage.setItem('pw-docked-orientation', JSON.stringify(dockedOrientation.value));
  nudgeResize();
}

export const focusedPanelId = signal<string | null>(null);
let focusTimer: ReturnType<typeof setTimeout> | null = null;

export function setFocusedPanel(panelId: string | null) {
  if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
  focusedPanelId.value = panelId;
  if (panelId) {
    focusTimer = setTimeout(() => { focusedPanelId.value = null; }, 2000);
  }
}

let panelZCounter = 0;
export const panelZOrders = signal<Map<string, number>>(new Map());
export type PaneMruEntry = { type: 'tab'; sessionId: string } | { type: 'panel'; panelId: string };
export const paneMruHistory = signal<PaneMruEntry[]>(loadJson('pw-pane-mru', []));

export function pushPaneMru(entry: PaneMruEntry) {
  const key = entry.type === 'tab' ? `tab:${entry.sessionId}` : `panel:${entry.panelId}`;
  const prev = paneMruHistory.value;
  const next = [entry, ...prev.filter((e) => {
    const k = e.type === 'tab' ? `tab:${e.sessionId}` : `panel:${e.panelId}`;
    return k !== key;
  })].slice(0, 30);
  paneMruHistory.value = next;
  localStorage.setItem('pw-pane-mru', JSON.stringify(next));
}

effect(() => {
  const id = activeTabId.value;
  if (id) queueMicrotask(() => pushPaneMru({ type: 'tab', sessionId: id }));
});

export function bringToFront(panelId: string) {
  panelZCounter++;
  const map = new Map(panelZOrders.value);
  map.set(panelId, panelZCounter);
  panelZOrders.value = map;
  pushPaneMru({ type: 'panel', panelId });
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

export function getPanelZIndex(panelOrId: PopoutPanelState | string): number {
  const id = typeof panelOrId === 'string' ? panelOrId : panelOrId.id;
  const order = panelZOrders.value.get(id) || 0;
  const alwaysOnTop = typeof panelOrId === 'string' ? false : !!panelOrId.alwaysOnTop;
  // order*2 ensures most-recently-focused panel always wins;
  // alwaysOnTop adds +1 so it stays above same-age unfocused panels
  return 950 + order * 2 + (alwaysOnTop ? 1 : 0);
}

export function toggleAlwaysOnTop(panelId: string) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  updatePanel(panelId, { alwaysOnTop: !panel.alwaysOnTop });
  bringToFront(panelId);
  persistPopoutState();
}

export function cyclePanelFocus(direction: 1 | -1) {
  const panels: string[] = [];
  if (openTabs.value.length > 0) {
    if (splitEnabled.value) {
      panels.push('split-left', 'split-right');
    } else {
      panels.push('global');
    }
  }
  for (const p of popoutPanels.value) {
    if (p.visible) panels.push(p.id);
  }
  if (panels.length === 0) return;
  const currentIdx = focusedPanelId.value ? panels.indexOf(focusedPanelId.value) : -1;
  const nextIdx = currentIdx < 0 ? 0 : (currentIdx + direction + panels.length) % panels.length;
  const targetId = panels[nextIdx];
  setFocusedPanel(targetId);

  let container: Element | null = null;
  if (targetId === 'global') {
    container = document.querySelector('.global-terminal-panel');
  } else if (targetId === 'split-left' || targetId === 'split-right') {
    container = document.querySelector(`[data-split-pane="${targetId}"]`);
  } else {
    container = document.querySelector(`[data-panel-id="${targetId}"]`);
  }
  if (container) {
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLElement | null;
    if (textarea) textarea.focus();
  }
}

export function reorderTabInPanel(panelId: string, sessionId: string, insertBeforeId: string | null) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  const ids = panel.sessionIds.filter((id) => id !== sessionId);
  if (insertBeforeId) {
    const idx = ids.indexOf(insertBeforeId);
    if (idx >= 0) ids.splice(idx, 0, sessionId);
    else ids.push(sessionId);
  } else {
    ids.push(sessionId);
  }
  updatePanel(panelId, { sessionIds: ids });
  persistPopoutState();
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
  // Add to openTabs first so enableSplit sees >= 2 tabs
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

function persistSplitState() {
  localStorage.setItem('pw-split-enabled', JSON.stringify(splitEnabled.value));
  localStorage.setItem('pw-right-pane-tabs', JSON.stringify(rightPaneTabs.value));
  localStorage.setItem('pw-right-pane-active', JSON.stringify(rightPaneActiveId.value));
  localStorage.setItem('pw-split-ratio', JSON.stringify(splitRatio.value));
}

export function setSplitRatio(ratio: number) {
  splitRatio.value = Math.max(0.2, Math.min(0.8, ratio));
  persistSplitState();
}

export interface PanelPreset {
  name: string;
  openTabs: string[];
  activeTabId: string | null;
  panels: PopoutPanelState[];
  panelHeight: number;
  panelMinimized: boolean;
  dockedOrientation: DockedOrientation;
  splitEnabled?: boolean;
  rightPaneTabs?: string[];
  rightPaneActiveId?: string | null;
  splitRatio?: number;
  savedAt: string;
}

export const panelPresets = signal<PanelPreset[]>(loadJson('pw-panel-presets', []));

export function savePreset(name: string) {
  const preset: PanelPreset = {
    name,
    openTabs: openTabs.value,
    activeTabId: activeTabId.value,
    panels: popoutPanels.value,
    panelHeight: panelHeight.value,
    panelMinimized: panelMinimized.value,
    dockedOrientation: dockedOrientation.value,
    splitEnabled: splitEnabled.value,
    rightPaneTabs: rightPaneTabs.value,
    rightPaneActiveId: rightPaneActiveId.value,
    splitRatio: splitRatio.value,
    savedAt: new Date().toISOString(),
  };
  panelPresets.value = [...panelPresets.value.filter((p) => p.name !== name), preset];
  localStorage.setItem('pw-panel-presets', JSON.stringify(panelPresets.value));
}

export function restorePreset(name: string) {
  const preset = panelPresets.value.find((p) => p.name === name);
  if (!preset) return;
  openTabs.value = preset.openTabs;
  activeTabId.value = preset.activeTabId;
  popoutPanels.value = preset.panels;
  panelHeight.value = preset.panelHeight;
  panelMinimized.value = preset.panelMinimized;
  dockedOrientation.value = preset.dockedOrientation;
  splitEnabled.value = preset.splitEnabled ?? false;
  rightPaneTabs.value = preset.rightPaneTabs ?? [];
  rightPaneActiveId.value = preset.rightPaneActiveId ?? null;
  splitRatio.value = preset.splitRatio ?? 0.5;
  localStorage.setItem('pw-docked-orientation', JSON.stringify(preset.dockedOrientation));
  persistTabs();
  persistPopoutState();
  persistPanelState();
  persistSplitState();
  nudgeResize();
}

export function deletePreset(name: string) {
  panelPresets.value = panelPresets.value.filter((p) => p.name !== name);
  localStorage.setItem('pw-panel-presets', JSON.stringify(panelPresets.value));
}

export const snapGuides = signal<{ x?: number; y?: number }[]>([]);

export const viewModes = signal<Record<string, ViewMode>>({});

export function getViewMode(sessionId: string, permissionProfile?: string): ViewMode {
  if (viewModes.value[sessionId]) return viewModes.value[sessionId];
  if (permissionProfile === 'auto' || permissionProfile === 'yolo') return 'structured';
  return 'terminal';
}

export function setViewMode(sessionId: string, mode: ViewMode) {
  viewModes.value = { ...viewModes.value, [sessionId]: mode };
}

function persistTabs() {
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

export function persistPopoutState() {
  localStorage.setItem('pw-popout-panels', JSON.stringify(popoutPanels.value));
  saveAutoJumpDimsForActiveSession();
}

function nudgeResize() {
  for (const delay of [50, 150, 300]) {
    setTimeout(() => window.dispatchEvent(new Event('resize')), delay);
  }
}

// --- Per-panel split pane functions ---

const panelRightPaneMemory = new Map<string, { tabs: string[]; activeId: string | null }>();

export function panelLeftTabs(panel: PopoutPanelState): string[] {
  if (!panel.splitEnabled) return panel.sessionIds;
  const rightSet = new Set(panel.rightPaneTabs || []);
  return panel.sessionIds.filter((id) => !rightSet.has(id));
}

export function enablePanelSplit(panelId: string, tabId: string) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel || panel.splitEnabled) return;
  updatePanel(panelId, {
    splitEnabled: true,
    rightPaneTabs: [tabId],
    rightPaneActiveId: tabId,
    splitRatio: panel.splitRatio ?? 0.5,
  });
  persistPopoutState();
  nudgeResize();
}

export function disablePanelSplit(panelId: string) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel || !panel.splitEnabled) return;
  updatePanel(panelId, {
    splitEnabled: false,
    rightPaneTabs: [],
    rightPaneActiveId: null,
  });
  persistPopoutState();
  nudgeResize();
}

export function setPanelSplitRatio(panelId: string, ratio: number) {
  updatePanel(panelId, { splitRatio: Math.max(0.2, Math.min(0.8, ratio)) });
  persistPopoutState();
}

export function togglePanelCompanion(panelId: string, sessionId: string, type: CompanionType) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  const tabId = companionTabId(sessionId, type);
  const rightTabs = panel.rightPaneTabs || [];
  const isVisible = rightTabs.includes(tabId) && panel.splitEnabled;

  const current = getCompanions(sessionId);

  if (current.includes(type) && isVisible) {
    // Toggle OFF
    const next = current.filter((t) => t !== type);
    if (next.length === 0) {
      const { [sessionId]: _, ...rest } = sessionCompanions.value;
      sessionCompanions.value = rest;
    } else {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: next };
    }
    persistCompanions();

    const remaining = rightTabs.filter((id) => id !== tabId);
    if (remaining.length === 0) {
      disablePanelSplit(panelId);
    } else {
      updatePanel(panelId, {
        rightPaneTabs: remaining,
        rightPaneActiveId: panel.rightPaneActiveId === tabId
          ? remaining[remaining.length - 1]
          : panel.rightPaneActiveId,
      });
      persistPopoutState();
    }
  } else {
    // Toggle ON
    if (!current.includes(type)) {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: [...current, type] };
      persistCompanions();
    }
    const newRight = rightTabs.includes(tabId) ? rightTabs : [...rightTabs, tabId];
    updatePanel(panelId, {
      splitEnabled: true,
      rightPaneTabs: newRight,
      rightPaneActiveId: tabId,
      splitRatio: panel.splitRatio ?? 0.5,
    });
    persistPopoutState();
    nudgeResize();
  }
}

export function moveToPanelRightPane(panelId: string, tabId: string) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  const rightTabs = panel.rightPaneTabs || [];
  if (rightTabs.includes(tabId)) return;
  if (!panel.splitEnabled) {
    enablePanelSplit(panelId, tabId);
  } else {
    updatePanel(panelId, {
      rightPaneTabs: [...rightTabs, tabId],
      rightPaneActiveId: tabId,
    });
    persistPopoutState();
  }
}

export function moveToPanelLeftPane(panelId: string, tabId: string) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  const rightTabs = panel.rightPaneTabs || [];
  if (!rightTabs.includes(tabId)) return;
  const remaining = rightTabs.filter((id) => id !== tabId);
  if (remaining.length === 0) {
    disablePanelSplit(panelId);
  } else {
    updatePanel(panelId, {
      rightPaneTabs: remaining,
      rightPaneActiveId: panel.rightPaneActiveId === tabId
        ? remaining[remaining.length - 1]
        : panel.rightPaneActiveId,
    });
    persistPopoutState();
  }
}

export function syncPanelCompanions(panelId: string, newSessionId: string, oldSessionId?: string | null) {
  if (extractCompanionType(newSessionId)) return;

  const memKey = (sid: string) => `${panelId}:${sid}`;
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;

  // Snapshot current right pane state for the old session
  if (oldSessionId && !extractCompanionType(oldSessionId)) {
    panelRightPaneMemory.set(memKey(oldSessionId), {
      tabs: [...(panel.rightPaneTabs || [])],
      activeId: panel.rightPaneActiveId ?? null,
    });
  }

  const companions = getCompanions(newSessionId);
  const memory = panelRightPaneMemory.get(memKey(newSessionId));

  if (memory) {
    updatePanel(panelId, {
      splitEnabled: memory.tabs.length > 0,
      rightPaneTabs: memory.tabs,
      rightPaneActiveId: memory.activeId,
    });
    persistPopoutState();
    return;
  }

  if (companions.length > 0) {
    const companionTabs = companions.map((t) => companionTabId(newSessionId, t));
    updatePanel(panelId, {
      splitEnabled: true,
      rightPaneTabs: companionTabs,
      rightPaneActiveId: companionTabs[0],
      splitRatio: panel.splitRatio ?? 0.5,
    });
    persistPopoutState();
  } else if (panel.splitEnabled) {
    const allCompanion = (panel.rightPaneTabs || []).every((t) => extractCompanionType(t) !== null);
    if (allCompanion) {
      updatePanel(panelId, {
        splitEnabled: false,
        rightPaneTabs: [],
        rightPaneActiveId: null,
      });
      persistPopoutState();
    }
  }
}

export function allNumberedSessions(): string[] {
  const result = [...openTabs.value];
  for (const panel of popoutPanels.value) {
    for (const sid of panel.sessionIds) {
      if (!result.includes(sid)) result.push(sid);
    }
  }
  return result;
}

export function findPanelForSession(sessionId: string): PopoutPanelState | undefined {
  return popoutPanels.value.find((p) => p.sessionIds.includes(sessionId));
}

export function updatePanel(panelId: string, updates: Partial<PopoutPanelState>) {
  popoutPanels.value = popoutPanels.value.map((p) =>
    p.id === panelId ? { ...p, ...updates } : p
  );
}

export function removePanel(panelId: string) {
  popoutPanels.value = popoutPanels.value.filter((p) => p.id !== panelId);
}

export function reorderDockedPanel(panelId: string, beforePanelId: string | null) {
  const panels = [...popoutPanels.value];
  const idx = panels.findIndex((p) => p.id === panelId);
  if (idx < 0) return;
  const [panel] = panels.splice(idx, 1);
  if (beforePanelId === null) {
    panels.push(panel);
  } else {
    const targetIdx = panels.findIndex((p) => p.id === beforePanelId);
    if (targetIdx < 0) {
      panels.push(panel);
    } else {
      panels.splice(targetIdx, 0, panel);
    }
  }
  popoutPanels.value = panels;
}

export function getDockedPanels(): PopoutPanelState[] {
  return popoutPanels.value.filter((p) => p.docked && p.visible);
}

const COLLAPSED_HANDLE_H = 48;

export function getDockedPanelTop(panelId: string): number {
  const target = popoutPanels.value.find((p) => p.id === panelId);
  const side = target?.dockedSide || 'right';
  const docked = popoutPanels.value.filter((p) => p.docked && (p.dockedSide || 'right') === side);
  let top = 40;
  for (const p of docked) {
    if (p.id === panelId) return top + (p.visible ? (p.dockedTopOffset || 0) : 0);
    if (p.visible) {
      top += p.dockedHeight + (p.dockedTopOffset || 0) + 4;
    } else {
      top += COLLAPSED_HANDLE_H + 4;
    }
  }
  return top;
}

export function popOutTab(sessionId: string) {
  openTabs.value = openTabs.value.filter((id) => id !== sessionId);
  if (activeTabId.value === sessionId) {
    const tabs = openTabs.value;
    activeTabId.value = tabs.length > 0 ? tabs[tabs.length - 1] : null;
  }
  if (rightPaneTabs.value.includes(sessionId)) {
    const remaining = rightPaneTabs.value.filter((id) => id !== sessionId);
    rightPaneTabs.value = remaining;
    if (rightPaneActiveId.value === sessionId) {
      rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    if (remaining.length === 0 && splitEnabled.value) {
      splitEnabled.value = false;
    }
    persistSplitState();
  }
  // If already in a panel, just make sure it's visible
  const existing = findPanelForSession(sessionId);
  if (existing) {
    updatePanel(existing.id, { activeSessionId: sessionId, visible: true });
    persistTabs();
    persistPopoutState();
    nudgeResize();
    return;
  }
  // Build panel with companions if any
  const companions = getCompanions(sessionId);
  const companionTabs = companions.map((t) => companionTabId(sessionId, t));

  // Remove companion tabs from bottom panel's openTabs / rightPaneTabs
  if (companionTabs.length > 0) {
    const companionSet = new Set(companionTabs);
    openTabs.value = openTabs.value.filter((id) => !companionSet.has(id));
    if (splitEnabled.value) {
      const remainingRight = rightPaneTabs.value.filter((id) => !companionSet.has(id));
      rightPaneTabs.value = remainingRight;
      if (rightPaneActiveId.value && companionSet.has(rightPaneActiveId.value)) {
        rightPaneActiveId.value = remainingRight.length > 0 ? remainingRight[remainingRight.length - 1] : null;
      }
      if (remainingRight.length === 0 && splitEnabled.value) {
        splitEnabled.value = false;
      }
      persistSplitState();
    }
  }

  const panel: PopoutPanelState = {
    id: 'p-' + Math.random().toString(36).slice(2, 8),
    sessionIds: [sessionId],
    activeSessionId: sessionId,
    docked: true,
    visible: true,
    floatingRect: { x: 200, y: 100, w: 700, h: 500 },
    dockedHeight: 400,
    dockedWidth: 500,
    splitEnabled: companionTabs.length > 0,
    splitRatio: 0.5,
    rightPaneTabs: companionTabs,
    rightPaneActiveId: companionTabs.length > 0 ? companionTabs[0] : null,
  };
  popoutPanels.value = [...popoutPanels.value, panel];
  persistTabs();
  persistPopoutState();
  nudgeResize();
}

export function popBackIn(sessionId: string) {
  if (!sessionId) return;
  const panel = findPanelForSession(sessionId);
  const isAutoJump = panel?.id === AUTOJUMP_PANEL_ID;
  if (isAutoJump) {
    saveAutoJumpDimsForActiveSession();
  }
  if (panel) {
    const remaining = panel.sessionIds.filter((id) => id !== sessionId);
    if (remaining.length === 0) {
      removePanel(panel.id);
    } else {
      updatePanel(panel.id, {
        sessionIds: remaining,
        activeSessionId: panel.activeSessionId === sessionId
          ? remaining[remaining.length - 1]
          : panel.activeSessionId,
      });
    }
  }
  if (!openTabs.value.includes(sessionId)) {
    openTabs.value = [...openTabs.value, sessionId];
  }
  activeTabId.value = sessionId;
  panelMinimized.value = false;
  if (isAutoJump) {
    transferAutoJumpToGlobalPanel(sessionId);
  }
  persistTabs();
  persistPopoutState();
  persistPanelState();
  nudgeResize();
}

export function popBackInAll() {
  const allIds: string[] = [];
  for (const panel of popoutPanels.value) {
    allIds.push(...panel.sessionIds);
  }
  popoutPanels.value = [];
  for (const sid of allIds) {
    if (!openTabs.value.includes(sid)) {
      openTabs.value = [...openTabs.value, sid];
    }
  }
  if (allIds.length > 0) activeTabId.value = allIds[allIds.length - 1];
  panelMinimized.value = false;
  persistTabs();
  persistPopoutState();
  persistPanelState();
  nudgeResize();
}

export function moveSessionToPanel(sessionId: string, targetPanelId: string) {
  // Remove from main tabs
  if (openTabs.value.includes(sessionId)) {
    openTabs.value = openTabs.value.filter((id) => id !== sessionId);
    if (activeTabId.value === sessionId) {
      activeTabId.value = openTabs.value.length > 0 ? openTabs.value[openTabs.value.length - 1] : null;
    }
  }
  // Remove from source panel
  const srcPanel = findPanelForSession(sessionId);
  if (srcPanel && srcPanel.id !== targetPanelId) {
    const remaining = srcPanel.sessionIds.filter((id) => id !== sessionId);
    if (remaining.length === 0) {
      removePanel(srcPanel.id);
    } else {
      updatePanel(srcPanel.id, {
        sessionIds: remaining,
        activeSessionId: srcPanel.activeSessionId === sessionId
          ? remaining[remaining.length - 1]
          : srcPanel.activeSessionId,
      });
    }
  }
  // Add to target panel
  const target = popoutPanels.value.find((p) => p.id === targetPanelId);
  if (target && !target.sessionIds.includes(sessionId)) {
    updatePanel(targetPanelId, {
      sessionIds: [...target.sessionIds, sessionId],
      activeSessionId: sessionId,
    });
  }
  persistTabs();
  persistPopoutState();
  nudgeResize();
}

export function splitFromPanel(sessionId: string) {
  const srcPanel = findPanelForSession(sessionId);
  if (!srcPanel) return;
  const remaining = srcPanel.sessionIds.filter((id) => id !== sessionId);
  if (remaining.length === 0) {
    removePanel(srcPanel.id);
  } else {
    updatePanel(srcPanel.id, {
      sessionIds: remaining,
      activeSessionId: srcPanel.activeSessionId === sessionId
        ? remaining[remaining.length - 1]
        : srcPanel.activeSessionId,
    });
  }
  const panel: PopoutPanelState = {
    id: 'p-' + Math.random().toString(36).slice(2, 8),
    sessionIds: [sessionId],
    activeSessionId: sessionId,
    docked: true,
    visible: true,
    floatingRect: { x: 200, y: 100, w: 700, h: 500 },
    dockedHeight: 400,
    dockedWidth: 500,
  };
  popoutPanels.value = [...popoutPanels.value, panel];
  persistPopoutState();
  nudgeResize();
}

export function togglePopoutVisibility() {
  if (popoutPanels.value.length === 0) {
    const active = activeTabId.value;
    if (active) popOutTab(active);
    return;
  }
  const anyVisible = popoutPanels.value.some((p) => p.visible);
  popoutPanels.value = popoutPanels.value.map((p) => ({ ...p, visible: !anyVisible }));
  persistPopoutState();
  if (!anyVisible) nudgeResize();
}

export function togglePopOutActive() {
  const active = activeTabId.value;
  if (active) popOutTab(active);
}

export const quickDispatchState = signal<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
export const cachedAgents = signal<any[]>([]);

export const SIDEBAR_WIDTH_COLLAPSED = 56;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 220;

export const sidebarCollapsed = signal(localStorage.getItem('pw-sidebar-collapsed') === 'true');
export const sidebarWidth = signal(
  sidebarCollapsed.value ? SIDEBAR_WIDTH_COLLAPSED : loadJson('pw-sidebar-width', SIDEBAR_DEFAULT_WIDTH)
);
export const sidebarAnimating = signal(false);

export const allSessions = signal<any[]>([]);
export const sessionsLoading = signal(false);
export const sessionsDrawerOpen = signal(localStorage.getItem('pw-sessions-drawer') !== 'false');
export const showResolvedSessions = signal(localStorage.getItem('pw-show-resolved') === 'true');
export const sessionSearchQuery = signal('');
export const sessionsHeight = signal(loadJson('pw-sessions-height', 300));

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

export function toggleSidebar() {
  sidebarAnimating.value = true;
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem('pw-sidebar-collapsed', String(sidebarCollapsed.value));
  sidebarWidth.value = sidebarCollapsed.value
    ? SIDEBAR_WIDTH_COLLAPSED
    : loadJson('pw-sidebar-width', SIDEBAR_DEFAULT_WIDTH);
  setTimeout(() => { sidebarAnimating.value = false; }, 220);
}

export function setSidebarWidth(w: number) {
  const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(w, SIDEBAR_MAX_WIDTH));
  sidebarWidth.value = clamped;
  localStorage.setItem('pw-sidebar-width', JSON.stringify(clamped));
}

export function toggleSessionsDrawer() {
  sessionsDrawerOpen.value = !sessionsDrawerOpen.value;
  localStorage.setItem('pw-sessions-drawer', String(sessionsDrawerOpen.value));
}

export function toggleShowResolved() {
  showResolvedSessions.value = !showResolvedSessions.value;
  localStorage.setItem('pw-show-resolved', String(showResolvedSessions.value));
}

export function setSessionsHeight(h: number) {
  const clamped = Math.max(80, Math.min(h, window.innerHeight - 200));
  sessionsHeight.value = clamped;
  localStorage.setItem('pw-sessions-height', JSON.stringify(clamped));
}

export const terminalsHeight = signal(loadJson('pw-terminals-height', 150));

export function setTerminalsHeight(h: number) {
  const clamped = Math.max(80, Math.min(h, window.innerHeight - 200));
  terminalsHeight.value = clamped;
  localStorage.setItem('pw-terminals-height', JSON.stringify(clamped));
}

export const sidebarSplitRatio = signal(loadJson('pw-sidebar-split-ratio', 0.7));

export function setSidebarSplitRatio(ratio: number) {
  const clamped = Math.max(0.15, Math.min(0.95, ratio));
  sidebarSplitRatio.value = clamped;
  localStorage.setItem('pw-sidebar-split-ratio', JSON.stringify(clamped));
}

export async function loadAllSessions(includeDeleted = false, isAutoPoll = false) {
  if (isAutoPoll && lastTerminalInput.value > 0 && Date.now() - lastTerminalInput.value < 2000) {
    return;
  }
  sessionsLoading.value = true;
  try {
    const tabs = [...openTabs.value];
    for (const panel of popoutPanels.value) {
      for (const sid of panel.sessionIds) {
        if (!tabs.includes(sid)) tabs.push(sid);
      }
    }
    const sessions = await timed('sessions:list', () => api.getAgentSessions(undefined, tabs.length > 0 ? tabs : undefined, includeDeleted));

    // Only update the signal if something actually changed — avoids unnecessary
    // Preact re-renders that cause keyboard lag during 5s polling.
    const prevSessions = allSessions.value;
    const sessionsChanged = sessions.length !== prevSessions.length || sessions.some((s, i) => {
      const p = prevSessions[i];
      return !p || s.id !== p.id || s.status !== p.status || s.inputState !== p.inputState
        || s.paneTitle !== p.paneTitle || s.paneCommand !== p.paneCommand;
    });
    if (sessionsChanged) {
      allSessions.value = sessions;
    }

    // Update input states from API for all sessions
    const prev = sessionInputStates.value;
    const next = new Map(prev);
    let changed = false;
    for (const s of sessions) {
      const had = prev.get(s.id);
      if (s.inputState && s.inputState !== 'active') {
        if (had !== s.inputState) { next.set(s.id, s.inputState); changed = true; }
      } else {
        if (had !== undefined) { next.delete(s.id); changed = true; }
      }
    }
    if (changed) sessionInputStates.value = next;
    syncAutoJumpPanel();
  } catch {
    // ignore
  } finally {
    sessionsLoading.value = false;
  }
}

export const includeDeletedInPolling = signal(false);

/** Updated by AgentTerminal on each keystroke; polling skips when recent. */
export const lastTerminalInput = signal(0);

export function startSessionPolling(): () => void {
  loadAllSessions(includeDeletedInPolling.value);
  let id = setInterval(() => loadAllSessions(includeDeletedInPolling.value, true), 5000);

  function onVisibilityChange() {
    clearInterval(id);
    if (document.hidden) {
      id = setInterval(() => loadAllSessions(includeDeletedInPolling.value, true), 30000);
    } else {
      loadAllSessions(includeDeletedInPolling.value);
      id = setInterval(() => loadAllSessions(includeDeletedInPolling.value, true), 5000);
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

export function goToPreviousTab() {
  const prev = previousTabId.value;
  if (!prev) return;
  if (openTabs.value.includes(prev)) {
    openSession(prev);
  }
}

export function focusSessionTerminal(sessionId: string) {
  requestAnimationFrame(() => {
    let container: Element | null = null;
    if (splitEnabled.value && rightPaneTabs.value.includes(sessionId)) {
      container = document.querySelector('[data-split-pane="split-right"]');
    } else {
      const panel = findPanelForSession(sessionId);
      if (panel) {
        container = document.querySelector(`[data-panel-id="${panel.id}"]`);
      } else {
        container = document.querySelector('.global-terminal-panel');
      }
    }
    if (container) {
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLElement | null;
      if (textarea) textarea.focus();
    }
  });
}

export function openSession(sessionId: string) {
  autoJumpLogs.value && console.log(`[auto-jump] openSession: ${sessionId.slice(-6)}, currentActive=${activeTabId.value?.slice(-6) ?? 'null'}, alreadyOpen=${openTabs.value.includes(sessionId)}`);
  import('./autofix.js').then(({ trackSessionOpen }) => trackSessionOpen(sessionId));
  if (!openTabs.value.includes(sessionId)) {
    openTabs.value = [...openTabs.value, sessionId];
  }
  const current = activeTabId.value;
  if (current && current !== sessionId) {
    previousTabId.value = current;
  }
  activeTabId.value = sessionId;
  panelMinimized.value = false;
  persistTabs();

  // Sync to pane tree
  addTabToLeaf(SESSIONS_LEAF_ID, sessionId, true);
  showSessionsLeaf();

  // Auto-seed terminal companion from server's companionSessionId if not already mapped
  const sess = allSessions.value.find((s) => s.id === sessionId);
  if (sess?.companionSessionId && !getTerminalCompanion(sessionId)) {
    setTerminalCompanion(sessionId, sess.companionSessionId);
  }

  // Sync companion pane when switching sessions
  syncCompanionsToRightPane(sessionId, current);

  if (autoNavigateToFeedback.value) {
    const session = allSessions.value.find((s) => s.id === sessionId);
    if (session?.feedbackId) {
      const appId = selectedAppId.value;
      const path = appId
        ? `/app/${appId}/feedback/${session.feedbackId}`
        : `/feedback/${session.feedbackId}`;
      navigate(path);
    }
  }
}

export function focusOrDockSession(sessionId: string) {
  // 1. Already in a popout panel → activate + focus it there
  const panel = findPanelForSession(sessionId);
  if (panel) {
    if (panel.activeSessionId === sessionId && panel.visible) {
      bringToFront(panel.id);
      focusSessionTerminal(sessionId);
      return;
    }
    updatePanel(panel.id, { activeSessionId: sessionId, visible: true, alwaysOnTop: true });
    bringToFront(panel.id);
    persistPopoutState();
    nudgeResize();
    focusSessionTerminal(sessionId);
    return;
  }
  // 2. Already visible in split right pane → activate there
  if (splitEnabled.value && rightPaneTabs.value.includes(sessionId)) {
    rightPaneActiveId.value = sessionId;
    persistSplitState();
    focusSessionTerminal(sessionId);
    return;
  }
  // 3. Already open in main panel → activate there
  if (openTabs.value.includes(sessionId)) {
    openSession(sessionId);
    focusSessionTerminal(sessionId);
    return;
  }
  // 4. Dock into the sidebar panel
  const ajPanel = popoutPanels.value.find((p) => p.id === AUTOJUMP_PANEL_ID);
  if (ajPanel) {
    const ids = ajPanel.sessionIds.includes(sessionId)
      ? ajPanel.sessionIds
      : [...ajPanel.sessionIds, sessionId];
    updatePanel(AUTOJUMP_PANEL_ID, {
      sessionIds: ids,
      activeSessionId: sessionId,
      visible: true,
      dockedSide: 'left',
      alwaysOnTop: true,
      autoOpened: false,
    });
  } else {
    const newPanel: PopoutPanelState = {
      id: AUTOJUMP_PANEL_ID,
      sessionIds: [sessionId],
      activeSessionId: sessionId,
      docked: true,
      visible: true,
      floatingRect: { x: 200, y: 100, w: 500, h: 500 },
      dockedHeight: 500,
      dockedWidth: 500,
      dockedSide: 'left',
      alwaysOnTop: true,
      autoOpened: false,
    };
    popoutPanels.value = [newPanel, ...popoutPanels.value];
  }
  bringToFront(AUTOJUMP_PANEL_ID);
  persistPopoutState();
  nudgeResize();
  focusSessionTerminal(sessionId);
}

export function closeTab(sessionId: string) {
  const panel = findPanelForSession(sessionId);
  if (panel) {
    const remaining = panel.sessionIds.filter((id) => id !== sessionId);
    if (remaining.length === 0) {
      removePanel(panel.id);
    } else {
      updatePanel(panel.id, {
        sessionIds: remaining,
        activeSessionId: panel.activeSessionId === sessionId
          ? remaining[remaining.length - 1]
          : panel.activeSessionId,
      });
    }
    persistPopoutState();
    return;
  }
  if (rightPaneTabs.value.includes(sessionId)) {
    const remaining = rightPaneTabs.value.filter((id) => id !== sessionId);
    rightPaneTabs.value = remaining;
    if (rightPaneActiveId.value === sessionId) {
      rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    if (remaining.length === 0 && splitEnabled.value) {
      splitEnabled.value = false;
    }
    persistSplitState();
  }
  const oldTabs = openTabs.value;
  const idx = oldTabs.indexOf(sessionId);
  const tabs = oldTabs.filter((id) => id !== sessionId);
  openTabs.value = tabs;
  if (activeTabId.value === sessionId) {
    const left = splitEnabled.value ? leftPaneTabs() : tabs;
    const neighbor = left[Math.min(idx, left.length - 1)] ?? null;
    activeTabId.value = neighbor;
  }
  persistTabs();

  // Sync to pane tree — find whichever leaf actually contains this tab
  const leaf = findLeafWithTab(sessionId);
  if (leaf) {
    removeTabFromLeaf(leaf.id, sessionId);
  }
}

export async function resolveSession(sessionId: string, feedbackId?: string) {
  const alreadyExited = exitedSessions.value.has(sessionId);
  if (!alreadyExited) {
    await killSession(sessionId);
  }
  if (feedbackId) {
    try {
      await api.updateFeedback(feedbackId, { status: 'resolved' });
    } catch (err: any) {
      console.error('Resolve feedback failed:', err.message);
    }
  }
  closeTab(sessionId);
}

export async function deleteSession(sessionId: string) {
  try {
    await api.archiveAgentSession(sessionId);
    allSessions.value = allSessions.value.map((s) =>
      s.id === sessionId ? { ...s, status: 'deleted' } : s
    );
    closeTab(sessionId);
  } catch (err: any) {
    console.error('Archive session failed:', err.message);
  }
}

export async function permanentlyDeleteSession(sessionId: string) {
  try {
    await api.deleteAgentSession(sessionId);
    allSessions.value = allSessions.value.filter((s) => s.id !== sessionId);
    closeTab(sessionId);
  } catch (err: any) {
    console.error('Delete session failed:', err.message);
  }
}

export async function killSession(sessionId: string) {
  try {
    await api.killAgentSession(sessionId);
    allSessions.value = allSessions.value.map((s) =>
      s.id === sessionId ? { ...s, status: 'killed' } : s
    );
    markSessionExited(sessionId);
    closeTab(sessionId);
  } catch (err: any) {
    console.error('Kill failed:', err.message);
  }
}

export function markSessionExited(sessionId: string, exitCode?: number, terminalText?: string) {
  const next = new Set(exitedSessions.value);
  next.add(sessionId);
  exitedSessions.value = next;
  persistTabs();
  if (exitCode !== undefined && exitCode !== 0 && terminalText) {
    import('./autofix.js').then(({ handleSessionExit }) => {
      handleSessionExit(sessionId, exitCode, terminalText);
    });
  }
}

export async function resumeSession(sessionId: string): Promise<string | null> {
  try {
    const { sessionId: newId } = await api.resumeAgentSession(sessionId);
    const panel = findPanelForSession(sessionId);
    if (panel) {
      updatePanel(panel.id, {
        sessionIds: panel.sessionIds.map((id) => id === sessionId ? newId : id),
        activeSessionId: panel.activeSessionId === sessionId ? newId : panel.activeSessionId,
      });
      persistPopoutState();
    } else {
      const tabs = openTabs.value.map((id) => (id === sessionId ? newId : id));
      openTabs.value = tabs;
      if (rightPaneTabs.value.includes(sessionId)) {
        rightPaneTabs.value = rightPaneTabs.value.map((id) => id === sessionId ? newId : id);
        if (rightPaneActiveId.value === sessionId) rightPaneActiveId.value = newId;
        persistSplitState();
      } else {
        activeTabId.value = newId;
      }
    }
    const next = new Set(exitedSessions.value);
    next.delete(sessionId);
    exitedSessions.value = next;
    persistTabs();
    return newId;
  } catch (err: any) {
    console.error('Resume failed:', err.message);
    return null;
  }
}

export async function spawnTerminal(appId?: string | null, launcherId?: string, harnessConfigId?: string, permissionProfile?: string, skipOpen?: boolean) {
  try {
    const data: { appId?: string; launcherId?: string; harnessConfigId?: string; permissionProfile?: string } = {};
    if (appId && appId !== '__unlinked__') data.appId = appId;
    if (launcherId) data.launcherId = launcherId;
    if (harnessConfigId) data.harnessConfigId = harnessConfigId;
    if (permissionProfile) data.permissionProfile = permissionProfile;
    const { sessionId } = await api.spawnTerminal(data);
    if (!skipOpen) openSession(sessionId);
    loadAllSessions();
    return sessionId;
  } catch (err: any) {
    console.error('Spawn terminal failed:', err.message);
    return null;
  }
}

export async function attachTmuxSession(tmuxTarget: string, appId?: string | null, skipOpen?: boolean, launcherId?: string) {
  try {
    const data: { tmuxTarget: string; appId?: string; launcherId?: string } = { tmuxTarget };
    if (appId && appId !== '__unlinked__') data.appId = appId;
    if (launcherId) data.launcherId = launcherId;
    const { sessionId } = await api.attachTmuxSession(data);
    if (!skipOpen) openSession(sessionId);
    loadAllSessions();
    return sessionId;
  } catch (err: any) {
    console.error('Attach tmux session failed:', err.message);
    return null;
  }
}

let agentsLoading: Promise<any[]> | null = null;

export async function ensureAgentsLoaded(): Promise<any[]> {
  if (cachedAgents.value.length > 0) return cachedAgents.value;
  if (agentsLoading) return agentsLoading;
  agentsLoading = api.getAgents().then((agents) => {
    cachedAgents.value = agents;
    agentsLoading = null;
    return agents;
  });
  return agentsLoading;
}

export async function quickDispatch(feedbackId: string, appId?: string | null) {
  quickDispatchState.value = { ...quickDispatchState.value, [feedbackId]: 'loading' };
  try {
    const agents = appId
      ? await api.getAgents(appId)
      : await ensureAgentsLoaded();
    const appDefault = appId ? agents.find((a: any) => a.isDefault && a.appId === appId) : null;
    const globalDefault = agents.find((a: any) => a.isDefault && !a.appId);
    const defaultAgent = appDefault || globalDefault || agents[0];
    if (!defaultAgent) {
      quickDispatchState.value = { ...quickDispatchState.value, [feedbackId]: 'error' };
      setTimeout(() => {
        quickDispatchState.value = { ...quickDispatchState.value, [feedbackId]: 'idle' };
      }, 2000);
      return;
    }
    const result = await api.dispatch({ feedbackId, agentEndpointId: defaultAgent.id });
    quickDispatchState.value = { ...quickDispatchState.value, [feedbackId]: 'success' };
    if (result.sessionId) {
      openSession(result.sessionId);
    }
  } catch {
    quickDispatchState.value = { ...quickDispatchState.value, [feedbackId]: 'error' };
  }
  setTimeout(() => {
    quickDispatchState.value = { ...quickDispatchState.value, [feedbackId]: 'idle' };
  }, 2000);
}

export async function batchQuickDispatch(feedbackIds: string[], appId?: string | null) {
  await Promise.all(feedbackIds.map((id) => quickDispatch(id, appId)));
}

export const actionToast = signal<{ key: string; label: string; color: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showActionToast(key: string, label: string, color = 'var(--pw-primary)') {
  if (toastTimer) clearTimeout(toastTimer);
  actionToast.value = { key, label, color };
  toastTimer = setTimeout(() => { actionToast.value = null; }, 1500);
}

export type InputState = 'active' | 'idle' | 'waiting';
export const sessionInputStates = signal<Map<string, InputState>>(new Map());

export const pendingAutoJump = signal<string | null>(null);
export const autoJumpCountdown = signal<number>(0);
export const autoJumpPaused = signal(false);
let autoJumpTimer: ReturnType<typeof setInterval> | null = null;

function clearAutoJumpTimer() {
  if (autoJumpTimer) { clearInterval(autoJumpTimer); autoJumpTimer = null; }
}

function isUserTyping(): boolean {
  let el: Element | null = document.activeElement;
  if (!el) return false;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable) return true;
  if (el.closest?.('.xterm')) return true;
  return false;
}

function executePendingAutoJump() {
  const targetId = pendingAutoJump.value;
  autoJumpLogs.value && console.log(`[auto-jump] executePendingAutoJump called, targetId=${targetId?.slice(-6) ?? 'null'}`);
  if (!targetId) return;

  if (!autoJumpInterrupt.value && isUserTyping()) {
    autoJumpLogs.value && console.log(`[auto-jump] user is typing, interrupt OFF — pausing auto-jump for ${targetId.slice(-6)}`);
    autoJumpPaused.value = true;
    return;
  }

  autoJumpPaused.value = false;

  if (autoJumpDelay.value) {
    autoJumpLogs.value && console.log(`[auto-jump] starting 3s countdown for ${targetId.slice(-6)}`);
    autoJumpCountdown.value = 3;
    clearAutoJumpTimer();
    autoJumpTimer = setInterval(() => {
      if (!autoJumpInterrupt.value && isUserTyping()) {
        autoJumpLogs.value && console.log(`[auto-jump] user started typing during countdown — pausing`);
        clearAutoJumpTimer();
        autoJumpCountdown.value = 0;
        autoJumpPaused.value = true;
        return;
      }
      const next = autoJumpCountdown.value - 1;
      autoJumpCountdown.value = next;
      if (next <= 0) {
        clearAutoJumpTimer();
        const id = pendingAutoJump.value;
        pendingAutoJump.value = null;
        autoJumpPaused.value = false;
        autoJumpLogs.value && console.log(`[auto-jump] countdown done, jumping to ${id?.slice(-6) ?? 'null'}`);
        if (id) activateSessionInPlace(id);
      }
    }, 1000);
  } else {
    autoJumpLogs.value && console.log(`[auto-jump] immediate jump to ${targetId.slice(-6)}`);
    pendingAutoJump.value = null;
    activateSessionInPlace(targetId);
  }
}

export function cancelAutoJump() {
  clearAutoJumpTimer();
  pendingAutoJump.value = null;
  autoJumpCountdown.value = 0;
  autoJumpPaused.value = false;
  showActionToast('\u2715', 'Auto-jump cancelled', 'var(--pw-text-muted)');
}

export function hideAutoJumpPopup() {
  autoJumpPaused.value = false;
  pendingAutoJump.value = null;
}

export function setSessionInputState(sessionId: string, state: InputState) {
  const prev = sessionInputStates.value;
  const prevState = prev.get(sessionId) || 'active';
  if (prevState === state) return;
  const wasWaiting = prevState === 'waiting';
  const next = new Map(prev);
  if (state === 'active') next.delete(sessionId);
  else next.set(sessionId, state);
  sessionInputStates.value = next;

  // If the pending auto-jump target left waiting, clear it
  if (wasWaiting && state !== 'waiting' && pendingAutoJump.value === sessionId) {
    clearAutoJumpTimer();
    pendingAutoJump.value = null;
    autoJumpCountdown.value = 0;
    autoJumpPaused.value = false;
  }

  autoJumpLogs.value && console.log(`[auto-jump] inputState changed: session=${sessionId.slice(-6)} ${prevState} → ${state} (wasWaiting=${wasWaiting})`, {
    allStates: Object.fromEntries(next),
    autoJumpEnabled: autoJumpWaiting.value,
    activeTab: activeTabId.value?.slice(-6),
  });

  if (wasWaiting && state !== 'waiting' && autoJumpWaiting.value) {
    const waitingSessions = allSessions.value.filter(
      (s: any) => s.id !== sessionId && s.status === 'running' && next.get(s.id) === 'waiting'
    );
    autoJumpLogs.value && console.log(`[auto-jump] session ${sessionId.slice(-6)} left waiting. Other waiting sessions:`, waitingSessions.map((s: any) => s.id.slice(-6)));
    if (waitingSessions.length === 0) {
      autoJumpLogs.value && console.log(`[auto-jump] no other waiting sessions, skipping auto-jump`);
      return;
    }
    const targetId = waitingSessions[0].id;
    pendingAutoJump.value = targetId;
    // interrupt ON → jump almost immediately; OFF → short grace period
    const delay = autoJumpInterrupt.value ? 100 : 500;
    autoJumpLogs.value && console.log(`[auto-jump] scheduling jump to ${targetId.slice(-6)} in ${delay}ms (interrupt=${autoJumpInterrupt.value})`);
    setTimeout(() => executePendingAutoJump(), delay);
  } else if (wasWaiting && state !== 'waiting') {
    autoJumpLogs.value && console.log(`[auto-jump] session left waiting but autoJumpWaiting is OFF`);
  } else if (state === 'waiting' && !wasWaiting && autoJumpWaiting.value) {
    // Session just entered waiting — jump to it if the active tab is not waiting
    const activeId = activeTabId.value;
    const activeState = activeId ? (next.get(activeId) || 'active') : 'active';
    if (activeId !== sessionId && activeState !== 'waiting') {
      autoJumpLogs.value && console.log(`[auto-jump] session ${sessionId.slice(-6)} entered waiting, active tab ${activeId?.slice(-6)} is ${activeState} — jumping`);
      pendingAutoJump.value = sessionId;
      const delay = autoJumpInterrupt.value ? 100 : 500;
      setTimeout(() => executePendingAutoJump(), delay);
    }
  }
  syncAutoJumpPanel();
}

export function cycleWaitingSession() {
  const waiting = allSessions.value.filter(
    (s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'
  );
  if (waiting.length === 0) return;
  // In split mode, consider both panes' active sessions
  const current = splitEnabled.value
    ? (rightPaneActiveId.value && waiting.some((s: any) => s.id === rightPaneActiveId.value)
      ? rightPaneActiveId.value
      : activeTabId.value)
    : activeTabId.value;
  const currentIdx = waiting.findIndex((s: any) => s.id === current);
  const next = waiting[(currentIdx + 1) % waiting.length];
  activateSessionInPlace(next.id);
}

export function activateSessionInPlace(sessionId: string) {
  autoJumpLogs.value && console.log(`[auto-jump] activateSessionInPlace: ${sessionId.slice(-6)}, splitEnabled=${splitEnabled.value}, inRightPane=${rightPaneTabs.value.includes(sessionId)}`);

  // Check if session is in a popout panel — bring to front + focus
  const panel = findPanelForSession(sessionId);
  if (panel) {
    autoJumpLogs.value && console.log(`[auto-jump] session ${sessionId.slice(-6)} found in panel ${panel.id}, bringing to front`);
    if (panel.id === AUTOJUMP_PANEL_ID && panel.activeSessionId !== sessionId) {
      saveAutoJumpDimsForActiveSession();
      updatePanel(panel.id, { activeSessionId: sessionId, visible: true });
      applyAutoJumpDimsForSession(sessionId);
    } else {
      updatePanel(panel.id, { activeSessionId: sessionId, visible: true });
    }
    bringToFront(panel.id);
    persistPopoutState();
    nudgeResize();
    focusSessionTerminal(sessionId);
    return;
  }

  if (splitEnabled.value && rightPaneTabs.value.includes(sessionId)) {
    rightPaneActiveId.value = sessionId;
    persistSplitState();
    autoJumpLogs.value && console.log(`[auto-jump] activated in right pane: ${sessionId.slice(-6)}`);
    return;
  }
  openSession(sessionId);
}

function isAutojumpPanelFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const panelEl = document.querySelector(`[data-panel-id="${AUTOJUMP_PANEL_ID}"]`);
  return !!panelEl?.contains(el);
}

export function syncAutoJumpPanel() {
  const existing = popoutPanels.value.find((p) => p.id === AUTOJUMP_PANEL_ID);

  const waiting = allSessions.value.filter(
    (s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'
  );
  const waitingIds = waiting.map((s: any) => s.id);

  // Don't close or prune the autojump panel while the user is typing in it
  if (existing && isAutojumpPanelFocused()) return;

  // Always prune non-waiting sessions from the autojump panel
  if (existing) {
    const stillWaiting = existing.sessionIds.filter((id) => waitingIds.includes(id));
    if (stillWaiting.length === 0 && autoCloseWaitingPanel.value) {
      saveAutoJumpDimsForActiveSession();
      const activeSession = existing.activeSessionId;
      removePanel(AUTOJUMP_PANEL_ID);
      autoJumpDismissed.value = false;
      if (activeSession && openTabs.value.includes(activeSession)) {
        transferAutoJumpToGlobalPanel(activeSession);
      }
      persistPopoutState();
      return;
    }
    if (stillWaiting.length < existing.sessionIds.length) {
      // Sessions leaving the autojump panel — transfer their companion state to global tabs
      const leaving = existing.sessionIds.filter((id) => !stillWaiting.includes(id));
      for (const sid of leaving) {
        if (openTabs.value.includes(sid) && sid === activeTabId.value) {
          transferAutoJumpToGlobalPanel(sid);
        }
      }
      const activeStill = stillWaiting.includes(existing.activeSessionId)
        ? existing.activeSessionId
        : stillWaiting[0] || existing.activeSessionId;
      const activeChanged = activeStill !== existing.activeSessionId;
      if (activeChanged) saveAutoJumpDimsForActiveSession();
      updatePanel(AUTOJUMP_PANEL_ID, {
        sessionIds: stillWaiting,
        activeSessionId: activeStill,
      });
      if (activeChanged) applyAutoJumpDimsForSession(activeStill);
      persistPopoutState();
    }
  }

  // Only auto-add waiting sessions when auto-jump is enabled
  if (!autoJumpWaiting.value) {
    // Even with auto-jump off, bounce the handle if the panel exists and has new waiting sessions
    if (existing && waitingIds.length > 0) {
      const newWaiting = waitingIds.filter((id) => !existing.sessionIds.includes(id));
      if (newWaiting.length > 0) {
        updatePanel(AUTOJUMP_PANEL_ID, { sessionIds: [...new Set([...existing.sessionIds, ...newWaiting])] });
        persistPopoutState();
        if (!existing.visible) triggerHandleBounce();
      }
    }
    return;
  }

  if (waitingIds.length === 0) return;

  if (!existing) {
    // Don't create the panel if all waiting sessions are already visible in tabs
    const allInTabs = waitingIds.every((id) => id === activeTabId.value);
    if (allInTabs) return;
    const dismissed = autoJumpDismissed.value;
    const saved = autoJumpSessionDims.value[waitingIds[0]];
    const panel: PopoutPanelState = {
      id: AUTOJUMP_PANEL_ID,
      sessionIds: waitingIds,
      activeSessionId: waitingIds[0],
      docked: saved?.docked ?? true,
      visible: !dismissed,
      floatingRect: saved?.floatingRect ?? { x: 200, y: 100, w: 500, h: 500 },
      dockedHeight: saved?.dockedHeight ?? 500,
      dockedWidth: saved?.dockedWidth ?? 500,
      dockedSide: saved?.dockedSide ?? 'left',
      dockedTopOffset: saved?.dockedTopOffset,
      splitEnabled: saved?.splitEnabled,
      splitRatio: saved?.splitRatio,
      rightPaneTabs: saved?.rightPaneTabs ? [...saved.rightPaneTabs] : [],
      rightPaneActiveId: saved?.rightPaneActiveId ?? null,
      autoOpened: true,
    };
    popoutPanels.value = [panel, ...popoutPanels.value];
    if (!dismissed) queueMicrotask(() => bringToFront(AUTOJUMP_PANEL_ID));
    if (dismissed) queueMicrotask(() => triggerHandleBounce());
    persistPopoutState();
    return;
  }

  // Merge waiting sessions into the panel without removing manually-added ones
  const currentIds = existing.sessionIds;
  const merged = [...currentIds];
  for (const id of waitingIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  const idsChanged = merged.length !== currentIds.length || merged.some((id, i) => id !== currentIds[i]);
  const activeStillPresent = merged.includes(existing.activeSessionId);

  // Only auto-show if there are waiting sessions not already visible in a tab
  const visibleInTab = activeTabId.value && waitingIds.includes(activeTabId.value);
  const allVisibleElsewhere = visibleInTab && waitingIds.length === 1;
  const shouldShow = !existing.visible && !allVisibleElsewhere;

  // If user dismissed the panel, don't reopen — bounce the handle instead
  const wantShow = shouldShow && !autoJumpDismissed.value;
  const wantBounce = shouldShow && autoJumpDismissed.value;

  if (idsChanged || wantShow) {
    const newActive = activeStillPresent ? existing.activeSessionId : merged[0];
    const activeChanged = newActive !== existing.activeSessionId;
    if (activeChanged) saveAutoJumpDimsForActiveSession();
    updatePanel(AUTOJUMP_PANEL_ID, {
      sessionIds: merged,
      activeSessionId: newActive,
      ...(wantShow ? { visible: true, autoOpened: true } : {}),
    });
    if (activeChanged) applyAutoJumpDimsForSession(newActive);
    if (wantShow) queueMicrotask(() => bringToFront(AUTOJUMP_PANEL_ID));
    persistPopoutState();
  }

  if (wantBounce) {
    triggerHandleBounce();
  }
}

export function toggleAutoJumpPanel() {
  const existing = popoutPanels.value.find((p) => p.id === AUTOJUMP_PANEL_ID);
  if (existing) {
    const nowVisible = !existing.visible;
    if (nowVisible) autoJumpDismissed.value = false;
    else autoJumpDismissed.value = true;
    updatePanel(AUTOJUMP_PANEL_ID, { visible: nowVisible, ...(nowVisible ? { autoOpened: false } : {}) });
    persistPopoutState();
  }
}

// Console helper: type `pwAutoJump()` or `pwAutoJump(true)` / `pwAutoJump(false)` to toggle auto-jump logs
(window as any).pwAutoJump = (enable?: boolean) => {
  autoJumpLogs.value = enable ?? !autoJumpLogs.value;
  console.log(`[auto-jump] console logging ${autoJumpLogs.value ? 'ON' : 'OFF'}`);
  return autoJumpLogs.value;
};

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

/** Returns a short worktree/cwd label if session's effective cwd differs from its app's projectDir. */
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

export const hotkeyMenuOpen = signal<{ sessionId: string; x: number; y: number } | null>(null);

export function openHotkeyMenu(sessionId: string) {
  const tab = document.querySelector(`.terminal-tab.active .status-dot`) as HTMLElement | null;
  if (tab) {
    const rect = tab.getBoundingClientRect();
    hotkeyMenuOpen.value = { sessionId, x: rect.left, y: rect.bottom + 4 };
  } else {
    hotkeyMenuOpen.value = { sessionId, x: window.innerWidth / 2 - 60, y: window.innerHeight - 200 };
  }
}

export const pendingFirstDigit = signal<number | null>(null);
let pendingTabTimer: ReturnType<typeof setTimeout> | null = null;

function clearPending() {
  pendingFirstDigit.value = null;
  if (pendingTabTimer) { clearTimeout(pendingTabTimer); pendingTabTimer = null; }
}

function activateGlobalSession(all: string[], num: number) {
  // Blur any focused input so the terminal can grab focus
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (num === 0) {
    togglePopoutVisibility();
    return;
  }
  const idx = num - 1;
  if (idx < 0 || idx >= all.length) return;
  const sid = all[idx];
  if (openTabs.value.includes(sid)) {
    openSession(sid);
    return;
  }
  const panel = findPanelForSession(sid);
  if (panel) {
    if (panel.activeSessionId === sid && panel.visible) {
      updatePanel(panel.id, { visible: false });
    } else {
      updatePanel(panel.id, { activeSessionId: sid, visible: true });
    }
    persistPopoutState();
    nudgeResize();
  }
}

export function handleTabDigit(digit: number) {
  const all = allNumberedSessions();

  if (pendingFirstDigit.value !== null) {
    const combined = pendingFirstDigit.value * 10 + digit;
    clearPending();
    activateGlobalSession(all, combined);
    return;
  }

  activateGlobalSession(all, digit);

  if (digit !== 0) {
    if (all.length >= digit * 10 + 1) {
      pendingFirstDigit.value = digit;
      pendingTabTimer = setTimeout(clearPending, 500);
    }
  }
}

export function handleTabDigit0to9(digit: number) {
  handleTabDigit(digit);
}

// --- Companion Pane System ---

export type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url' | 'file';

// Terminal companion: maps parent session ID → terminal session ID
export const terminalCompanionMap = signal<Record<string, string>>(
  loadJson('pw-terminal-companion-map', {})
);

function persistTerminalCompanionMap() {
  localStorage.setItem('pw-terminal-companion-map', JSON.stringify(terminalCompanionMap.value));
}

export function getTerminalCompanion(sessionId: string): string | undefined {
  return terminalCompanionMap.value[sessionId];
}

export function setTerminalCompanion(parentSessionId: string, termSessionId: string) {
  terminalCompanionMap.value = { ...terminalCompanionMap.value, [parentSessionId]: termSessionId };
  persistTerminalCompanionMap();
}

/** Store mapping + open companion in the global (bottom) panel right pane */
export function setTerminalCompanionAndOpen(parentSessionId: string, termSessionId: string) {
  setTerminalCompanion(parentSessionId, termSessionId);
  const current = getCompanions(parentSessionId);
  if (!current.includes('terminal')) {
    sessionCompanions.value = { ...sessionCompanions.value, [parentSessionId]: [...current, 'terminal'] };
    persistCompanions();
  }
  openSessionInRightPane(companionTabId(parentSessionId, 'terminal'));
  // Keep the parent session as the active left-pane tab
  if (activeTabId.value !== parentSessionId) {
    activeTabId.value = parentSessionId;
    persistTabs();
  }
}

export function removeTerminalCompanion(sessionId: string) {
  const { [sessionId]: _, ...rest } = terminalCompanionMap.value;
  terminalCompanionMap.value = rest;
  persistTerminalCompanionMap();
}

export const sessionCompanions = signal<Record<string, CompanionType[]>>(
  loadJson('pw-session-companions', {})
);

// Ephemeral per-session right pane memory (not persisted across reloads)
const rightPaneMemory = new Map<string, { tabs: string[]; activeId: string | null }>();

export function companionTabId(sessionId: string, type: CompanionType): string {
  return `${type}:${sessionId}`;
}

function extractSessionFromTab(tabId: string): string | null {
  const idx = tabId.indexOf(':');
  if (idx < 0) return null;
  return tabId.slice(idx + 1);
}

function extractCompanionType(tabId: string): CompanionType | null {
  const idx = tabId.indexOf(':');
  if (idx < 0) return null;
  const prefix = tabId.slice(0, idx);
  if (prefix === 'jsonl' || prefix === 'feedback' || prefix === 'iframe' || prefix === 'terminal' || prefix === 'isolate' || prefix === 'url' || prefix === 'file') return prefix;
  return null;
}

export function getCompanions(sessionId: string): CompanionType[] {
  return sessionCompanions.value[sessionId] || [];
}

function persistCompanions() {
  localStorage.setItem('pw-session-companions', JSON.stringify(sessionCompanions.value));
}

export function toggleCompanion(sessionId: string, type: CompanionType) {
  const current = getCompanions(sessionId);
  const tabId = companionTabId(sessionId, type);

  // Check if companion tab exists in the tree
  const existingLeaf = findLeafWithTab(tabId);
  const isVisibleInTree = !!existingLeaf;

  if (current.includes(type) && isVisibleInTree) {
    // Toggle OFF
    const next = current.filter((t) => t !== type);
    if (next.length === 0) {
      const { [sessionId]: _, ...rest } = sessionCompanions.value;
      sessionCompanions.value = rest;
    } else {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: next };
    }
    persistCompanions();

    if (type === 'terminal') {
      removeTerminalCompanion(sessionId);
    }

    // Remove from pane tree (auto-merges empty non-well-known leaves)
    removeTabFromLeaf(existingLeaf.id, tabId);

    // Keep legacy signals in sync
    if (rightPaneTabs.value.includes(tabId)) {
      const remaining = rightPaneTabs.value.filter((id) => id !== tabId);
      rightPaneTabs.value = remaining;
      if (rightPaneActiveId.value === tabId) {
        rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
      if (remaining.length === 0 && splitEnabled.value) {
        disableSplit();
        return;
      }
      persistSplitState();
    }
    if (openTabs.value.includes(tabId)) {
      openTabs.value = openTabs.value.filter((id) => id !== tabId);
      persistTabs();
    }
  } else {
    // Toggle ON (or re-open if registered but not visible)
    if (!current.includes(type)) {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: [...current, type] };
      persistCompanions();
    }

    // Place companion in the tree: find or create a sibling pane
    const sessionLeaf = findLeafWithTab(sessionId);
    if (sessionLeaf) {
      const sibling = findCompanionSibling(sessionLeaf.id, sessionId);
      if (sibling) {
        addTabToLeaf(sibling.id, tabId, true);
      } else {
        splitLeaf(sessionLeaf.id, 'horizontal', 'second', [tabId], 0.5);
      }
    } else {
      // Fallback: add to sessions leaf
      addTabToLeaf(SESSIONS_LEAF_ID, tabId, true);
    }

    // Keep legacy signals in sync
    openSessionInRightPane(tabId);
  }
}

export function openIsolateCompanion(componentName: string) {
  const tabId = `isolate:${componentName}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  openSessionInRightPane(tabId);

  // Place in tree: find focused session's leaf and split, or add to sessions leaf
  const focused = focusedLeafId.value;
  const focusedLeaf = focused ? findLeaf(layoutTree.value.root, focused) : null;
  if (focusedLeaf && focusedLeaf.panelType === 'tabs' && focusedLeaf.tabs.length > 0) {
    splitLeaf(focusedLeaf.id, 'horizontal', 'second', [tabId], 0.5);
  } else {
    addTabToLeaf(SESSIONS_LEAF_ID, tabId, true);
    showSessionsLeaf();
  }
}

export function openUrlCompanion(url: string) {
  let normalized = url.trim();
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  const tabId = `url:${normalized}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  openSessionInRightPane(tabId);

  // Place in tree: find focused session's leaf and split, or add to sessions leaf
  const focused = focusedLeafId.value;
  const focusedLeaf = focused ? findLeaf(layoutTree.value.root, focused) : null;
  if (focusedLeaf && focusedLeaf.panelType === 'tabs' && focusedLeaf.tabs.length > 0) {
    splitLeaf(focusedLeaf.id, 'horizontal', 'second', [tabId], 0.5);
  } else {
    addTabToLeaf(SESSIONS_LEAF_ID, tabId, true);
    showSessionsLeaf();
  }
}

export function openFileCompanion(filePath: string) {
  const tabId = `file:${filePath}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  addTabToLeaf(SESSIONS_LEAF_ID, tabId, true);
  showSessionsLeaf();
}

export function syncCompanionsToRightPane(newSessionId: string, oldSessionId?: string | null) {
  // Companion tabs are things like jsonl:xyz, feedback:xyz — skip if switching to one
  if (extractCompanionType(newSessionId)) return;

  // Snapshot current right pane state for the old session
  if (oldSessionId && !extractCompanionType(oldSessionId)) {
    rightPaneMemory.set(oldSessionId, {
      tabs: [...rightPaneTabs.value],
      activeId: rightPaneActiveId.value,
    });
  }

  const companions = getCompanions(newSessionId);

  // Check if we have a memory snapshot for the new session
  const memory = rightPaneMemory.get(newSessionId);

  if (memory) {
    // Restore from memory
    rightPaneTabs.value = memory.tabs;
    rightPaneActiveId.value = memory.activeId;
    if (memory.tabs.length > 0) {
      if (!splitEnabled.value) {
        splitEnabled.value = true;
      }
    } else if (splitEnabled.value) {
      splitEnabled.value = false;
    }
    // Ensure companion tabs are in openTabs
    for (const tab of memory.tabs) {
      if (!openTabs.value.includes(tab)) {
        openTabs.value = [...openTabs.value, tab];
      }
    }
    persistSplitState();
    persistTabs();
    return;
  }

  if (companions.length > 0) {
    // Build right pane from companion config
    const companionTabs = companions.map((type) => companionTabId(newSessionId, type));
    // Add to openTabs if needed
    for (const tab of companionTabs) {
      if (!openTabs.value.includes(tab)) {
        openTabs.value = [...openTabs.value, tab];
      }
    }
    rightPaneTabs.value = companionTabs;
    rightPaneActiveId.value = companionTabs[0];
    if (!splitEnabled.value) {
      splitEnabled.value = true;
    }
    persistSplitState();
    persistTabs();
  }
  // No companions and no memory for the new session — close the split
  // if it was only showing companion tabs (from the old session).
  if (splitEnabled.value) {
    const allCompanion = rightPaneTabs.value.every((t) => extractCompanionType(t) !== null);
    if (allCompanion) {
      // Remove old companion tabs from openTabs
      const companionSet = new Set(rightPaneTabs.value);
      openTabs.value = openTabs.value.filter((t) => !companionSet.has(t));
      rightPaneTabs.value = [];
      rightPaneActiveId.value = null;
      splitEnabled.value = false;
      persistSplitState();
      persistTabs();
    }
  }
}

// --- JSONL File Selection ---

export interface JsonlFileInfo {
  id: string;
  claudeSessionId: string;
  type: 'main' | 'continuation' | 'subagent';
  label: string;
  parentSessionId: string | null;
  agentId: string | null;
  order: number;
}

// Cache of JSONL file lists per agent session ID
export const jsonlFilesCache = signal<Map<string, { files: JsonlFileInfo[]; claudeSessionId: string }>>(new Map());

// Selected JSONL file per session (null = all merged)
export const jsonlSelectedFile = signal<Map<string, string | null>>(new Map());

// Whether the JSONL file dropdown is open, keyed by session ID
export const jsonlDropdownOpen = signal<string | null>(null);

export async function fetchJsonlFiles(sessionId: string, force = false): Promise<{ files: JsonlFileInfo[]; claudeSessionId: string }> {
  if (!force) {
    const cached = jsonlFilesCache.value.get(sessionId);
    if (cached) return cached;
  }

  const result = await api.getJsonlFiles(sessionId);
  const entry = { files: result.files, claudeSessionId: result.claudeSessionId };
  jsonlFilesCache.value = new Map([...jsonlFilesCache.value, [sessionId, entry]]);
  return entry;
}

export function getJsonlSelectedFile(sessionId: string): string | null {
  return jsonlSelectedFile.value.get(sessionId) ?? null;
}

export function setJsonlSelectedFile(sessionId: string, fileId: string | null) {
  const next = new Map(jsonlSelectedFile.value);
  if (fileId === null) {
    next.delete(sessionId);
  } else {
    next.set(sessionId, fileId);
  }
  jsonlSelectedFile.value = next;
}
