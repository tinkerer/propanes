import { signal, effect } from '@preact/signals';
import { autoJumpWaiting, autoJumpLogs, autoCloseWaitingPanel, autoJumpHandleBounce } from './settings.js';
import {
  openTabs,
  activeTabId,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  splitRatio,
  panelMinimized,
  panelHeight,
  exitedSessions,
  popInPickerSessionId,
  persistTabs,
  persistPanelState,
  persistSplitState,
  nudgeResize,
  leftPaneTabs,
  disableSplit,
  openSessionInRightPane,
  loadJson,
  panelMaximized,
  allSessions,
  sessionInputStates,
} from './session-state.js';
import {
  getCompanions,
  companionTabId,
  extractCompanionType,
  sessionCompanions,
  persistCompanions,
  getTerminalCompanion,
} from './companion-state.js';
import {
  findLeafWithTab,
  addTabToLeaf,
  removeTabFromLeaf,
  splitLeaf,
  mergeLeaf,
  ensureSessionsLeaf,
  SESSIONS_LEAF_ID,
  showSessionsLeaf,
  batch as batchTreeOps,
} from './pane-tree.js';

// --- Autojump Constants ---

export const AUTOJUMP_PANEL_ID = 'p-autojump';
export const COS_PANEL_ID = 'p-cos';
export const autoJumpDismissed = signal(false);
export const handleBounceCounter = signal(0);

export function triggerHandleBounce() {
  if (autoJumpHandleBounce.value) {
    handleBounceCounter.value++;
  }
}

// --- Autojump Session Dims ---

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

export function transferAutoJumpToGlobalPanel(sessionId: string) {
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
    for (const tab of dims.rightPaneTabs) {
      if (!openTabs.value.includes(tab)) {
        openTabs.value = [...openTabs.value, tab];
      }
    }
    persistSplitState();
    persistTabs();
  }
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

// --- Popout Panel State ---

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

export function setFocusedPanel(panelId: string | null) {
  focusedPanelId.value = panelId;
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

// Track active tab changes in MRU history
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
  bringToFront(targetId === 'global' || targetId === 'split-left' || targetId === 'split-right' ? 'global-panel' : targetId);

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

// --- Panel CRUD ---

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

export function persistPopoutState() {
  localStorage.setItem('pw-popout-panels', JSON.stringify(popoutPanels.value));
  saveAutoJumpDimsForActiveSession();
}

// --- Pop Out / Pop Back ---

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

  const treeLeaf = findLeafWithTab(sessionId);
  if (treeLeaf) removeTabFromLeaf(treeLeaf.id, sessionId);

  const existing = findPanelForSession(sessionId);
  if (existing) {
    updatePanel(existing.id, { activeSessionId: sessionId, visible: true });
    persistTabs();
    persistPopoutState();
    nudgeResize();
    return;
  }
  const companions = getCompanions(sessionId);
  const companionTabs = companions.map((t) => companionTabId(sessionId, t));

  if (companionTabs.length > 0) {
    batchTreeOps(() => {
      for (const ct of companionTabs) {
        const ctLeaf = findLeafWithTab(ct);
        if (ctLeaf) removeTabFromLeaf(ctLeaf.id, ct);
      }
    });
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
  popInPickerSessionId.value = sessionId;
}

export function popBackInToLeaf(sessionId: string, leafId: string) {
  if (!sessionId) return;
  const panel = findPanelForSession(sessionId);
  const isAutoJump = panel?.id === AUTOJUMP_PANEL_ID;
  if (isAutoJump) saveAutoJumpDimsForActiveSession();
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
  if (isAutoJump) transferAutoJumpToGlobalPanel(sessionId);

  batchTreeOps(() => {
    addTabToLeaf(leafId, sessionId, true);
    if (leafId === SESSIONS_LEAF_ID) showSessionsLeaf();
  });

  persistTabs();
  persistPopoutState();
  persistPanelState();
  nudgeResize();
}

export function popBackInToLeafWithSplit(sessionId: string, leafId: string, direction: 'horizontal' | 'vertical') {
  if (!sessionId) return;
  const panel = findPanelForSession(sessionId);
  const isAutoJump = panel?.id === AUTOJUMP_PANEL_ID;
  if (isAutoJump) saveAutoJumpDimsForActiveSession();
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
  if (isAutoJump) transferAutoJumpToGlobalPanel(sessionId);

  splitLeaf(leafId, direction, 'second', [sessionId]);

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

  batchTreeOps(() => {
    const leafId = ensureSessionsLeaf();
    for (const sid of allIds) {
      addTabToLeaf(leafId, sid, false);
    }
    if (allIds.length > 0) {
      addTabToLeaf(leafId, allIds[allIds.length - 1], true);
      showSessionsLeaf();
    }
  });

  persistTabs();
  persistPopoutState();
  persistPanelState();
  nudgeResize();
}

export function moveSessionToPanel(sessionId: string, targetPanelId: string) {
  if (openTabs.value.includes(sessionId)) {
    openTabs.value = openTabs.value.filter((id) => id !== sessionId);
    if (activeTabId.value === sessionId) {
      activeTabId.value = openTabs.value.length > 0 ? openTabs.value[openTabs.value.length - 1] : null;
    }
  }
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

export function bringAllPanelsToFront() {
  if (popoutPanels.value.length === 0) return;
  popoutPanels.value = popoutPanels.value.map((p) => ({ ...p, visible: true }));
  for (const p of popoutPanels.value) bringToFront(p.id);
  persistPopoutState();
  nudgeResize();
}

// --- Panel Presets ---

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

// --- Per-Panel Split ---

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

export function togglePanelCompanion(panelId: string, sessionId: string, type: import('./companion-state.js').CompanionType) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  const tabId = companionTabId(sessionId, type);
  const rightTabs = panel.rightPaneTabs || [];
  const isVisible = rightTabs.includes(tabId) && panel.splitEnabled;

  const current = getCompanions(sessionId);

  if (current.includes(type) && isVisible) {
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

// --- Autojump Panel Sync ---

function isAutojumpPanelFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const panelEl = document.querySelector(`[data-panel-id="${AUTOJUMP_PANEL_ID}"]`);
  return !!panelEl?.contains(el);
}

// Minimum time (ms) before the auto-jump panel can be removed after creation.
// Prevents rapid create/destroy cycles when input state oscillates, which causes
// terminal content to blink (remount → "Connecting..." → content → remount).
const AUTOJUMP_PANEL_MIN_LIFETIME_MS = 10_000;
let autojumpPanelCreatedAt = 0;

export function syncAutoJumpPanel() {
  const existing = popoutPanels.value.find((p) => p.id === AUTOJUMP_PANEL_ID);

  const waiting = allSessions.value.filter(
    (s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'
  );
  const waitingIds = waiting.map((s: any) => s.id);

  if (existing && isAutojumpPanelFocused()) return;

  if (existing) {
    const stillWaiting = existing.sessionIds.filter((id) => waitingIds.includes(id));
    if (stillWaiting.length === 0 && autoCloseWaitingPanel.value) {
      // Don't destroy the panel too quickly — prevents terminal remount blinking
      if (Date.now() - autojumpPanelCreatedAt < AUTOJUMP_PANEL_MIN_LIFETIME_MS) return;
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

  if (!autoJumpWaiting.value) {
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
    autojumpPanelCreatedAt = Date.now();
    popoutPanels.value = [panel, ...popoutPanels.value];
    if (!dismissed) queueMicrotask(() => bringToFront(AUTOJUMP_PANEL_ID));
    if (dismissed) queueMicrotask(() => triggerHandleBounce());
    persistPopoutState();
    return;
  }

  const currentIds = existing.sessionIds;
  const merged = [...currentIds];
  for (const id of waitingIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  const idsChanged = merged.length !== currentIds.length || merged.some((id, i) => id !== currentIds[i]);
  const activeStillPresent = merged.includes(existing.activeSessionId);

  const visibleInTab = activeTabId.value && waitingIds.includes(activeTabId.value);
  const allVisibleElsewhere = visibleInTab && waitingIds.length === 1;
  const shouldShow = !existing.visible && !allVisibleElsewhere;

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

// Console helper
(window as any).pwAutoJump = (enable?: boolean) => {
  autoJumpLogs.value = enable ?? !autoJumpLogs.value;
  console.log(`[auto-jump] console logging ${autoJumpLogs.value ? 'ON' : 'OFF'}`);
  return autoJumpLogs.value;
};
