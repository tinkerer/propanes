// sessions.ts — cross-cutting session functions + barrel re-exports
//
// This module contains functions that depend on multiple sub-modules
// (session-state, popout-state, companion-state, terminal-state).
// It also re-exports everything for backwards compatibility.

import { signal } from '@preact/signals';
import { api } from './api.js';
import { subscribeAdmin } from './admin-ws.js';
import { autoNavigateToFeedback, autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, autoJumpLogs, localBridgeUrl, sshConfigs } from './settings.js';
import { navigate, selectedAppId, isEmbedded } from './state.js';
import { isMobile } from './viewport.js';
import { timed } from './perf.js';
import {
  findLeafWithTab,
  addTabToLeaf,
  removeTabFromLeaf,
  replaceTabInLeaf,
  ensureSessionsLeaf,
  showSessionsLeaf,
  setActiveTab,
  setFocusedLeaf,
  batch as batchTreeOps,
} from './pane-tree.js';

import {
  openTabs,
  activeTabId,
  previousTabId,
  panelMinimized,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  exitedSessions,
  allSessions,
  sessionsLoading,
  sessionInputStates,
  quickDispatchState,
  cachedAgents,
  includeDeletedInPolling,
  lastTerminalInput,
  persistTabs,
  persistPanelState,
  persistSplitState,
  nudgeResize,
  leftPaneTabs,
  showActionToast,
} from './session-state.js';

import {
  getTerminalCompanion,
  setTerminalCompanion,
  getCompanions,
  toggleCompanion,
  syncCompanionsToRightPane,
} from './companion-state.js';

import {
  popoutPanels,
  findPanelForSession,
  updatePanel,
  removePanel,
  bringToFront,
  persistPopoutState,
  AUTOJUMP_PANEL_ID,
  saveAutoJumpDimsForActiveSession,
  syncAutoJumpPanel,
  type PopoutPanelState,
} from './popout-state.js';

import { setOpenSessionCallback } from './terminal-state.js';

// --- Focus Session Terminal ---

export function focusSessionTerminal(sessionId: string) {
  requestAnimationFrame(() => {
    // Try to find the exact terminal container for this session first.
    // Each AgentTerminal renders a div with data-session-id, and xterm.js
    // creates its .xterm-helper-textarea inside it.
    const sessionContainer = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
    if (sessionContainer) {
      const textarea = sessionContainer.querySelector('.xterm-helper-textarea') as HTMLElement | null;
      if (textarea) { textarea.focus(); return; }
    }
    // Fallback: find the panel/pane container and grab the first textarea
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

// --- Open Session ---

export function openSession(sessionId: string) {
  autoJumpLogs.value && console.log(`[auto-jump] openSession: ${sessionId.slice(-6)}, currentActive=${activeTabId.value?.slice(-6) ?? 'null'}, alreadyOpen=${openTabs.value.includes(sessionId)}`);
  import('./autofix.js').then(({ trackSessionOpen }) => trackSessionOpen(sessionId));

  // Mobile: skip pane-tree and push a dedicated route that renders StandaloneSessionPage.
  if (isMobile.value) {
    navigate(`/session/${sessionId}`);
    return;
  }

  const panel = findPanelForSession(sessionId);
  if (panel) {
    updatePanel(panel.id, { activeSessionId: sessionId, visible: true });
    bringToFront(panel.id);
    persistPopoutState();
    focusSessionTerminal(sessionId);
    return;
  }

  const existingLeaf = findLeafWithTab(sessionId);
  if (existingLeaf) {
    setActiveTab(existingLeaf.id, sessionId);
    setFocusedLeaf(existingLeaf.id);
    showSessionsLeaf();
    focusSessionTerminal(sessionId);
    return;
  }

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

  batchTreeOps(() => {
    const leafId = ensureSessionsLeaf();
    addTabToLeaf(leafId, sessionId, true);
    showSessionsLeaf();
  });

  const sess = allSessions.value.find((s) => s.id === sessionId);
  if (sess?.companionSessionId && !getTerminalCompanion(sessionId)) {
    setTerminalCompanion(sessionId, sess.companionSessionId);
  }

  // Auto-open JSONL companion for headless sessions (raw JSON terminal is not useful)
  if (sess && sess.permissionProfile !== 'plain') {
    const companions = getCompanions(sessionId);
    if (!companions.includes('jsonl')) {
      toggleCompanion(sessionId, 'jsonl');
    }
  }

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

// Wire up the callback for terminal-state's tab digit navigation
setOpenSessionCallback(openSession);

// --- Focus or Dock Session ---

export function focusOrDockSession(sessionId: string) {
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
  if (splitEnabled.value && rightPaneTabs.value.includes(sessionId)) {
    rightPaneActiveId.value = sessionId;
    persistSplitState();
    focusSessionTerminal(sessionId);
    return;
  }
  if (openTabs.value.includes(sessionId)) {
    openSession(sessionId);
    focusSessionTerminal(sessionId);
    return;
  }
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

// --- Close Tab ---

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

  // Remove from every leaf that contains the tab. Defensive: normally a tab
  // lives in at most one leaf, but if stale state has duplicates, close all.
  let leaf = findLeafWithTab(sessionId);
  const visited = new Set<string>();
  while (leaf && !visited.has(leaf.id)) {
    visited.add(leaf.id);
    removeTabFromLeaf(leaf.id, sessionId);
    leaf = findLeafWithTab(sessionId);
  }
}

// --- Go To Previous Tab ---

export function goToPreviousTab() {
  const prev = previousTabId.value;
  if (!prev) return;
  if (openTabs.value.includes(prev)) {
    openSession(prev);
  }
}

// --- Session CRUD ---

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

export async function resumeSession(sessionId: string, opts?: { permissionProfile?: string }): Promise<string | null> {
  try {
    // Kill running session first before resuming with new profile
    const sess = allSessions.value.find((s) => s.id === sessionId);
    if (sess && (sess.status === 'running' || sess.status === 'pending')) {
      await api.killAgentSession(sessionId);
      allSessions.value = allSessions.value.map((s) =>
        s.id === sessionId ? { ...s, status: 'killed' } : s
      );
      markSessionExited(sessionId);
    }
    const { sessionId: newId } = await api.resumeAgentSession(sessionId, opts);
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
      const leaf = findLeafWithTab(sessionId);
      if (leaf) replaceTabInLeaf(leaf.id, sessionId, newId);
    }
    const next = new Set(exitedSessions.value);
    next.delete(sessionId);
    exitedSessions.value = next;
    persistTabs();
    openSession(newId);
    loadAllSessions();
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

// --- Quick Dispatch ---

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

// --- Session Loading & Polling ---

export async function loadAllSessions(includeDeleted = false, isAutoPoll = false) {
  if (isAutoPoll && lastTerminalInput.value > 0 && Date.now() - lastTerminalInput.value < 5000) {
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

    const prevSessions = allSessions.value;
    const sessionsChanged = sessions.length !== prevSessions.length || sessions.some((s, i) => {
      const p = prevSessions[i];
      return !p || s.id !== p.id || s.status !== p.status || s.inputState !== p.inputState
        || s.paneTitle !== p.paneTitle || s.paneCommand !== p.paneCommand;
    });
    if (sessionsChanged) {
      allSessions.value = sessions;
    }

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

export function startSessionPolling(): () => void {
  // Initial load via REST, then subscribe to WS push updates
  loadAllSessions(includeDeletedInPolling.value);

  const unsub = subscribeAdmin('sessions', (sessions: any[]) => {
    if (lastTerminalInput.value > 0 && Date.now() - lastTerminalInput.value < 5000) return;

    const prevSessions = allSessions.value;
    const sessionsChanged = sessions.length !== prevSessions.length || sessions.some((s, i) => {
      const p = prevSessions[i];
      return !p || s.id !== p.id || s.status !== p.status || s.inputState !== p.inputState
        || s.paneTitle !== p.paneTitle || s.paneCommand !== p.paneCommand;
    });
    if (sessionsChanged) {
      allSessions.value = sessions;
    }

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
  });

  return unsub;
}

// --- Autojump Execution ---

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

export function activateSessionInPlace(sessionId: string) {
  autoJumpLogs.value && console.log(`[auto-jump] activateSessionInPlace: ${sessionId.slice(-6)}, splitEnabled=${splitEnabled.value}, inRightPane=${rightPaneTabs.value.includes(sessionId)}`);

  const panel = findPanelForSession(sessionId);
  if (panel) {
    autoJumpLogs.value && console.log(`[auto-jump] session ${sessionId.slice(-6)} found in panel ${panel.id}, bringing to front`);
    if (panel.id === AUTOJUMP_PANEL_ID && panel.activeSessionId !== sessionId) {
      saveAutoJumpDimsForActiveSession();
      updatePanel(panel.id, { activeSessionId: sessionId, visible: true });
      // Apply dims inline to avoid importing from popout-state (the function is internal)
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

// --- Set Session Input State ---

export function setSessionInputState(sessionId: string, state: import('./session-state.js').InputState) {
  const prev = sessionInputStates.value;
  const prevState = prev.get(sessionId) || 'active';
  if (prevState === state) return;
  const wasWaiting = prevState === 'waiting';
  const next = new Map(prev);
  if (state === 'active') next.delete(sessionId);
  else next.set(sessionId, state);
  sessionInputStates.value = next;

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
    const delay = autoJumpInterrupt.value ? 100 : 500;
    autoJumpLogs.value && console.log(`[auto-jump] scheduling jump to ${targetId.slice(-6)} in ${delay}ms (interrupt=${autoJumpInterrupt.value})`);
    setTimeout(() => executePendingAutoJump(), delay);
  } else if (wasWaiting && state !== 'waiting') {
    autoJumpLogs.value && console.log(`[auto-jump] session left waiting but autoJumpWaiting is OFF`);
  } else if (state === 'waiting' && !wasWaiting && autoJumpWaiting.value) {
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

  // Notify widget parent about waiting session changes
  if (isEmbedded.value && window.parent !== window) {
    const waitingCount = Array.from(next.values()).filter(s => s === 'waiting').length;
    window.parent.postMessage({
      type: 'pw-embed-waiting',
      sessionId,
      state,
      waitingCount,
    }, '*');
  }
}

// --- Cycle Waiting Session ---

export function cycleWaitingSession() {
  const waiting = allSessions.value.filter(
    (s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'
  );
  if (waiting.length === 0) return;
  const current = splitEnabled.value
    ? (rightPaneActiveId.value && waiting.some((s: any) => s.id === rightPaneActiveId.value)
      ? rightPaneActiveId.value
      : activeTabId.value)
    : activeTabId.value;
  const currentIdx = waiting.findIndex((s: any) => s.id === current);
  const next = waiting[(currentIdx + 1) % waiting.length];
  activateSessionInPlace(next.id);
}

// --- Local Terminal Bridge ---

export const sshSetupDialog = signal<{ hostname: string; sessionId: string } | null>(null);

function openBridgeWindow(config: import('./settings.js').SshConfig, sessionId: string) {
  const bridgeUrl = localBridgeUrl.value;
  const params = encodeURIComponent(JSON.stringify({ ...config, sessionId }));
  window.open(`${bridgeUrl}/api/v1/local/bridge#${params}`, '_blank', 'width=400,height=200,menubar=no,toolbar=no');
}

export function openLocalTerminal(sessionId: string) {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  if (isLocal) {
    fetch('/api/v1/local/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch((err) => {
      console.error('[local-bridge] Failed to open terminal:', err.message);
      showActionToast('\u2715', 'Failed to open terminal', 'var(--pw-error)');
    });
  } else {
    const config = sshConfigs.value[location.hostname];
    if (!config) {
      sshSetupDialog.value = { hostname: location.hostname, sessionId };
      return;
    }
    openBridgeWindow(config, sessionId);
  }
}

export function completeSshSetup(hostname: string, config: import('./settings.js').SshConfig, sessionId: string) {
  sshConfigs.value = { ...sshConfigs.value, [hostname]: config };
  sshSetupDialog.value = null;
  openBridgeWindow(config, sessionId);
}

// --- Re-exports ---

export * from './session-state.js';
export * from './companion-state.js';
export * from './popout-state.js';
export * from './terminal-state.js';
