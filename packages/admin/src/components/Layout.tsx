import { ComponentChildren } from 'preact';
import { useEffect, useRef, useCallback, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { currentRoute, clearToken, navigate, selectedAppId, applications, unlinkedCount, appFeedbackCounts, addAppModalOpen } from '../lib/state.js';
import { api } from '../lib/api.js';
import { timed } from '../lib/perf.js';
import { GlobalTerminalPanel, idMenuOpen } from './GlobalTerminalPanel.js';
import { PopoutPanel, popoutIdMenuOpen, popoutWindowMenuOpen } from './PopoutPanel.js';
import { PerfOverlay } from './PerfOverlay.js';
import { FileViewerOverlay } from './FileViewerPanel.js';
import { Tooltip } from './Tooltip.js';
import { ShortcutHelpModal } from './ShortcutHelpModal.js';
import { SpotlightSearch } from './SpotlightSearch.js';
import { AddAppModal } from './AddAppModal.js';
import { RequestPanel } from './RequestPanel.js';
import { ControlBar } from './ControlBar.js';
import { registerShortcut, ctrlShiftHeld } from '../lib/shortcuts.js';
import { toggleTheme, showTabs, arrowTabSwitching, showHotkeyHints, autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, autoJumpShowPopup, autoJumpLogs, autoCloseWaitingPanel, autoJumpHandleBounce } from '../lib/settings.js';
import {
  openTabs,
  activeTabId,
  panelHeight,
  panelMinimized,
  persistPanelState,
  sidebarCollapsed,
  sidebarWidth,
  toggleSidebar,
  allSessions,
  exitedSessions,
  startSessionPolling,
  openSession,
  focusOrDockSession,
  deleteSession,
  killSession,
  resumeSession,
  closeTab,
  actionToast,
  showActionToast,
  hotkeyMenuOpen,
  sessionsDrawerOpen,
  sessionSearchQuery,
  toggleSessionsDrawer,
  sessionsHeight,
  setSessionsHeight,
  terminalsHeight,
  setTerminalsHeight,
  setSidebarWidth,
  spawnTerminal,
  handleTabDigit0to9,
  togglePopOutActive,
  pendingFirstDigit,
  sessionStatusFilters,
  sessionFiltersOpen,
  toggleStatusFilter,
  toggleSessionFiltersOpen,
  sessionPassesFilters,
  allNumberedSessions,
  popoutPanels,
  findPanelForSession,
  sidebarAnimating,
  updatePanel,
  persistPopoutState,
  cyclePanelFocus,
  toggleDockedOrientation,
  sessionInputStates,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  leftPaneTabs,
  enableSplit,
  disableSplit,
  focusedPanelId,
  cycleWaitingSession,
  goToPreviousTab,
  pendingAutoJump,
  autoJumpCountdown,
  autoJumpPaused,
  cancelAutoJump,
  hideAutoJumpPopup,
  popOutTab,
  focusSessionTerminal,
  getSessionLabel,
  toggleAutoJumpPanel,
  resolveSession,
  activePanelId,
  bringToFront,
  termPickerOpen,
} from '../lib/sessions.js';

interface LiveConnection {
  sessionId: string;
  connectedAt: string;
  lastActivity: string;
  url: string | null;
  appId: string | null;
}
const liveConnections = signal<LiveConnection[]>([]);
const liveConnectionCounts = signal<Record<string, number>>({});
const totalLiveConnections = signal(0);
const liveSites = signal<{ origin: string; hostname: string; count: number }[]>([]);
const sidebarStatusMenu = signal<{ sessionId: string; x: number; y: number } | null>(null);
const sidebarItemMenu = signal<{ sessionId: string; x: number; y: number } | null>(null);

function highlightMatch(text: string, query: string) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span class="search-match">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}
const autoJumpMenuOpen = signal(false);

async function pollLiveConnections() {
  try {
    const conns = await api.getLiveConnections();
    liveConnections.value = conns;
    totalLiveConnections.value = conns.length;
    const counts: Record<string, number> = {};
    const siteMap = new Map<string, number>();
    const serverOrigin = window.location.origin;
    for (const c of conns) {
      const key = c.appId || '__unlinked__';
      counts[key] = (counts[key] || 0) + 1;
      if (c.url) {
        try {
          const u = new URL(c.url);
          if (u.origin !== serverOrigin) {
            siteMap.set(u.origin, (siteMap.get(u.origin) || 0) + 1);
          }
        } catch { /* invalid url */ }
      }
    }
    liveConnectionCounts.value = counts;
    liveSites.value = [...siteMap.entries()]
      .map(([origin, count]) => ({ origin, hostname: new URL(origin).hostname, count }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
  } catch {
    // ignore
  }
}


function SidebarTabBadge({ tabNum }: { tabNum: number }) {
  const pending = pendingFirstDigit.value;
  const digits = String(tabNum);
  if (pending !== null) {
    const pendingStr = String(pending);
    if (!digits.startsWith(pendingStr)) {
      return <span class="sidebar-tab-badge tab-badge-dimmed">{tabNum}</span>;
    }
    return (
      <span class="sidebar-tab-badge tab-badge-pending">
        <span class="tab-badge-green">{pendingStr}</span>
        {digits.slice(pendingStr.length) || ''}
      </span>
    );
  }
  return <span class="sidebar-tab-badge">{tabNum}</span>;
}

export function Layout({ children }: { children: ComponentChildren }) {
  const route = currentRoute.value;
  const hasTabs = openTabs.value.length > 0;
  const minimizedHeight = showTabs.value ? 66 : 32;
  const bottomPad = hasTabs ? (panelMinimized.value ? minimizedHeight : panelHeight.value) : 0;
  const collapsed = sidebarCollapsed.value;
  const width = sidebarWidth.value;
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const showShortcutHelpRef = useRef(false);
  const showSpotlightRef = useRef(false);
  showShortcutHelpRef.current = showShortcutHelp;
  showSpotlightRef.current = showSpotlight;

  useEffect(() => {
    // Defer sidebar polling so visible page content loads first
    let liveInterval: ReturnType<typeof setInterval> | null = null;
    let stopSessionPolling: (() => void) | null = null;
    const deferTimer = setTimeout(() => {
      timed('liveConnections', () => pollLiveConnections());
      liveInterval = setInterval(pollLiveConnections, 5_000);
      stopSessionPolling = startSessionPolling();
    }, 100);
    return () => {
      clearTimeout(deferTimer);
      if (liveInterval) clearInterval(liveInterval);
      if (stopSessionPolling) stopSessionPolling();
    };
  }, []);

  useEffect(() => {
    if (!sidebarStatusMenu.value) return;
    const close = () => { sidebarStatusMenu.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [sidebarStatusMenu.value]);

  useEffect(() => {
    if (!sidebarItemMenu.value) return;
    const close = () => { sidebarItemMenu.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [sidebarItemMenu.value]);

  useEffect(() => {
    if (!autoJumpMenuOpen.value) return;
    const close = () => { autoJumpMenuOpen.value = false; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [autoJumpMenuOpen.value]);

  function getActivePanelSession(): string | null {
    const ap = activePanelId.value;
    if (!ap || ap === 'global' || ap === 'split-left' || ap === 'split-right') {
      return activeTabId.value;
    }
    const panel = popoutPanels.value.find((p) => p.id === ap);
    return panel ? (panel.activeSessionId || panel.sessionIds[0] || null) : null;
  }

  function isPopoutFocused(): boolean {
    const ap = activePanelId.value;
    return !!ap && ap !== 'global' && ap !== 'split-left' && ap !== 'split-right';
  }

  useEffect(() => {
    const cleanups = [
      registerShortcut({
        key: '?',
        label: 'Show keyboard shortcuts',
        category: 'General',
        action: () => setShowShortcutHelp(true),
      }),
      registerShortcut({
        key: 't',
        label: 'Toggle theme',
        category: 'General',
        action: toggleTheme,
      }),
      registerShortcut({
        key: 'Escape',
        label: 'Close modal',
        category: 'General',
        action: () => { setShowShortcutHelp(false); setShowSpotlight(false); },
      }),
      registerShortcut({
        key: ' ',
        code: 'Space',
        modifiers: { ctrl: true, shift: true },
        label: 'Spotlight search',
        category: 'General',
        action: () => setShowSpotlight((v) => !v),
      }),
      registerShortcut({
        key: 'k',
        modifiers: { meta: true },
        label: 'Spotlight search',
        category: 'General',
        action: () => setShowSpotlight((v) => !v),
      }),
      registerShortcut({
        key: '\\',
        modifiers: { ctrl: true },
        label: 'Toggle sidebar',
        category: 'Panels',
        action: toggleSidebar,
      }),
      registerShortcut({
        key: '`',
        label: 'Toggle terminal panel',
        category: 'Panels',
        action: () => {
          if (openTabs.value.length > 0) {
            panelMinimized.value = !panelMinimized.value;
            persistPanelState();
          }
        },
      }),
      registerShortcut({
        key: '~',
        code: 'Backquote',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle terminal panel',
        category: 'Panels',
        action: () => {
          if (openTabs.value.length > 0) {
            panelMinimized.value = !panelMinimized.value;
            persistPanelState();
          }
        },
      }),
      registerShortcut({
        sequence: 'g f',
        key: 'f',
        label: 'Go to Feedback',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/feedback`);
        },
      }),
      registerShortcut({
        sequence: 'g a',
        key: 'a',
        label: 'Go to Agents',
        category: 'Navigation',
        action: () => navigate('/settings/agents'),
      }),
      registerShortcut({
        sequence: 'g g',
        key: 'g',
        label: 'Go to Aggregate',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/aggregate`);
        },
      }),
      registerShortcut({
        sequence: 'g s',
        key: 's',
        label: 'Go to Sessions',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/sessions`);
        },
      }),
      registerShortcut({
        sequence: 'g l',
        key: 'l',
        label: 'Go to Live',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/live`);
        },
      }),
      registerShortcut({
        sequence: 'g p',
        key: 'p',
        label: 'Go to Preferences',
        category: 'Navigation',
        action: () => navigate('/settings/preferences'),
      }),
      registerShortcut({
        key: 'ArrowUp',
        modifiers: { ctrl: true, shift: true },
        label: 'Previous page',
        category: 'Navigation',
        action: () => { if (arrowTabSwitching.value) cycleNav(-1); },
      }),
      registerShortcut({
        key: 'ArrowDown',
        modifiers: { ctrl: true, shift: true },
        label: 'Next page',
        category: 'Navigation',
        action: () => { if (arrowTabSwitching.value) cycleNav(1); },
      }),
      registerShortcut({
        key: 'ArrowLeft',
        modifiers: { ctrl: true, shift: true },
        label: 'Previous session tab',
        category: 'Panels',
        action: () => { if (arrowTabSwitching.value) cycleSessionTab(-1); },
      }),
      registerShortcut({
        key: 'ArrowRight',
        modifiers: { ctrl: true, shift: true },
        label: 'Next session tab',
        category: 'Panels',
        action: () => { if (arrowTabSwitching.value) cycleSessionTab(1); },
      }),
      registerShortcut({
        key: 'P',
        code: 'KeyP',
        modifiers: { ctrl: true, shift: true },
        label: 'Session menu',
        category: 'Panels',
        action: () => {
          if (isPopoutFocused()) {
            const sid = getActivePanelSession();
            popoutIdMenuOpen.value = popoutIdMenuOpen.value ? null : (sid || null);
          } else {
            idMenuOpen.value = idMenuOpen.value ? null : (activeTabId.value || null);
          }
        },
      }),
      registerShortcut({
        key: 'B',
        code: 'KeyB',
        modifiers: { ctrl: true, shift: true },
        label: 'Back to previous tab',
        category: 'Panels',
        action: () => {
          goToPreviousTab();
          showActionToast('B', 'Back', 'var(--pw-accent)');
        },
      }),
      registerShortcut({
        sequence: 'g w',
        key: 'w',
        label: 'Go to waiting session',
        category: 'Navigation',
        action: () => {
          const waiting = allSessions.value.find((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting');
          if (waiting) {
            openSession(waiting.id);
            showActionToast('w', 'Waiting', 'var(--pw-success)');
          }
        },
      }),
      registerShortcut({
        key: 'A',
        code: 'KeyA',
        modifiers: { ctrl: true, shift: true },
        label: 'Cycle waiting sessions',
        category: 'Panels',
        action: () => {
          cycleWaitingSession();
          showActionToast('A', 'Next waiting', 'var(--pw-success)');
        },
      }),
      registerShortcut({
        sequence: 'g t',
        key: 't',
        label: 'New terminal',
        category: 'Panels',
        action: () => spawnTerminal(selectedAppId.value),
      }),
      registerShortcut({
        sequence: 'g c',
        key: 'c',
        label: 'New Claude session',
        category: 'Panels',
        action: () => spawnTerminal(selectedAppId.value, undefined, undefined, 'interactive'),
      }),
      // Ctrl+Shift+0-9: tab switching (0 = toggle pop-out, 1-9 = tab by index)
      ...Array.from({ length: 10 }, (_, i) => registerShortcut({
        key: String(i),
        code: `Digit${i}`,
        modifiers: { ctrl: true, shift: true },
        label: `Switch to tab ${i}`,
        category: 'Panels',
        action: () => handleTabDigit0to9(i),
      })),
      registerShortcut({
        key: 'W',
        code: 'KeyW',
        modifiers: { ctrl: true, shift: true },
        label: 'Close popup / tab',
        category: 'Panels',
        action: () => {
          if (showSpotlightRef.current) { setShowSpotlight(false); return; }
          if (showShortcutHelpRef.current) { setShowShortcutHelp(false); return; }
          if (hotkeyMenuOpen.value) { hotkeyMenuOpen.value = null; }
          if (isPopoutFocused()) {
            const ap = activePanelId.value;
            const panel = popoutPanels.value.find((p) => p.id === ap && p.visible);
            if (panel) {
              const sid = panel.activeSessionId || panel.sessionIds[0];
              if (sid) {
                showActionToast('W', 'Close tab', 'var(--pw-text-muted)');
                closeTab(sid);
              }
              return;
            }
          }
          const visiblePanels = popoutPanels.value.filter((p) => p.visible);
          if (visiblePanels.length > 0) {
            const panel = visiblePanels[visiblePanels.length - 1];
            updatePanel(panel.id, { visible: false });
            persistPopoutState();
            return;
          }
          if (activeTabId.value) {
            showActionToast('W', 'Close tab', 'var(--pw-text-muted)');
            closeTab(activeTabId.value);
          }
        },
      }),
      registerShortcut({
        key: '_',
        code: 'Minus',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle pop out / dock',
        category: 'Panels',
        action: togglePopOutActive,
      }),
      registerShortcut({
        key: '+',
        code: 'Equal',
        modifiers: { ctrl: true, shift: true },
        label: 'New terminal',
        category: 'Panels',
        action: () => spawnTerminal(selectedAppId.value),
      }),
      registerShortcut({
        key: 'Tab',
        modifiers: { ctrl: true, shift: true },
        label: 'Cycle panel focus',
        category: 'Panels',
        action: () => cyclePanelFocus(1),
      }),
      registerShortcut({
        key: '|',
        code: 'Backslash',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle docked orientation',
        category: 'Panels',
        action: toggleDockedOrientation,
      }),
      registerShortcut({
        key: '"',
        code: 'Quote',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle split pane',
        category: 'Panels',
        action: () => {
          if (splitEnabled.value) disableSplit();
          else enableSplit();
        },
      }),
      registerShortcut({
        key: 'R',
        code: 'KeyR',
        modifiers: { ctrl: true, shift: true },
        label: 'Resolve active session',
        category: 'Panels',
        action: () => {
          const sid = getActivePanelSession();
          if (!sid) return;
          const sess = allSessions.value.find((s: any) => s.id === sid);
          if (!sess || !sess.feedbackId) return;
          hotkeyMenuOpen.value = null;
          showActionToast('R', 'Resolve', 'var(--pw-success)');
          resolveSession(sid, sess.feedbackId);
        },
      }),
      registerShortcut({
        key: 'K',
        code: 'KeyK',
        modifiers: { ctrl: true, shift: true },
        label: 'Kill active session',
        category: 'Panels',
        action: () => {
          const sid = getActivePanelSession();
          if (!sid || exitedSessions.value.has(sid)) return;
          hotkeyMenuOpen.value = null;
          showActionToast('K', 'Kill', 'var(--pw-danger)');
          killSession(sid);
        },
      }),
      registerShortcut({
        key: 'E',
        code: 'KeyE',
        modifiers: { ctrl: true, shift: true },
        label: 'Window menu (popout)',
        category: 'Panels',
        action: () => {
          if (!isPopoutFocused()) return;
          const ap = activePanelId.value;
          popoutWindowMenuOpen.value = popoutWindowMenuOpen.value ? null : (ap || null);
        },
      }),
      registerShortcut({
        key: 'X',
        code: 'KeyX',
        modifiers: { ctrl: true, shift: true },
        label: 'Cancel auto-jump',
        category: 'Panels',
        action: cancelAutoJump,
      }),
      registerShortcut({
        key: 'J',
        code: 'KeyJ',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle jump panel',
        category: 'Panels',
        action: toggleAutoJumpPanel,
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== 'pw-companion-shortcut') return;
      if (e.data.key === 'cmd+k' || e.data.key === 'ctrl+shift+space') {
        setShowSpotlight((v) => !v);
      } else if (e.data.key === 'escape') {
        setShowShortcutHelp(false);
        setShowSpotlight(false);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const sessions = allSessions.value;
  const tabs = openTabs.value;
  const tabSet = new Set(tabs);
  for (const panel of popoutPanels.value) {
    for (const sid of panel.sessionIds) tabSet.add(sid);
  }
  const visibleSessions = sessions.filter((s: any) => sessionPassesFilters(s, tabSet));
  const recentSessions = [...visibleSessions]
    .sort((a, b) => {
      const aOpen = tabSet.has(a.id) ? 0 : 1;
      const bOpen = tabSet.has(b.id) ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      const statusOrder = (s: string) =>
        s === 'running' ? 0 : s === 'pending' ? 1 : 2;
      const diff = statusOrder(a.status) - statusOrder(b.status);
      if (diff !== 0) return diff;
      return new Date(b.startedAt || b.createdAt || 0).getTime() -
        new Date(a.startedAt || a.createdAt || 0).getTime();
    });

  const apps = applications.value;
  const selAppId = selectedAppId.value;
  const hasUnlinked = unlinkedCount.value > 0;
  const fbCounts = appFeedbackCounts.value;
  const runningSessions = sessions.filter((s: any) => s.status === 'running').length;
  const waitingCount = sessions.filter((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting').length;
  const nonDeletedSessions = sessions.filter((s: any) => s.status !== 'deleted');
  const statusCounts: Record<string, number> = {};
  for (const s of nonDeletedSessions) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }
  const filtersOpen = sessionFiltersOpen.value;
  const activeStatusFilters = sessionStatusFilters.value;
  const activeFilterCount = activeStatusFilters.size;

  function startDrag(
    e: MouseEvent,
    cursor: 'ew-resize' | 'ns-resize',
    onMove: (ev: MouseEvent) => void,
    handle?: HTMLElement,
  ) {
    e.preventDefault();
    const overlay = document.createElement('div');
    overlay.className = `resize-overlay ${cursor === 'ew-resize' ? 'ew' : 'ns'}`;
    document.body.appendChild(overlay);
    document.body.style.userSelect = 'none';
    if (handle) handle.classList.add('dragging');
    const move = (ev: MouseEvent) => onMove(ev);
    const up = () => {
      overlay.remove();
      document.body.style.userSelect = '';
      if (handle) handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  const appSubTabs = ['feedback', 'aggregate', 'sessions', 'live', 'settings'];
  const settingsTabs = ['/settings/agents', '/settings/machines', '/settings/harnesses', '/settings/sprites', '/settings/getting-started', '/settings/preferences'];

  function cycleNav(dir: number) {
    const r = currentRoute.value;
    const appId = selectedAppId.value;
    if (appId && r.startsWith(`/app/${appId}/`)) {
      const segment = r.replace(`/app/${appId}/`, '').split('/')[0];
      const idx = appSubTabs.indexOf(segment);
      if (idx >= 0) {
        const next = appSubTabs[(idx + dir + appSubTabs.length) % appSubTabs.length];
        navigate(`/app/${appId}/${next}`);
      }
    } else if (r.startsWith('/settings/')) {
      const idx = settingsTabs.indexOf(r);
      if (idx >= 0) {
        navigate(settingsTabs[(idx + dir + settingsTabs.length) % settingsTabs.length]);
      }
    }
  }

  function cycleSessionTab(dir: number) {
    if (splitEnabled.value && focusedPanelId.value === 'split-right') {
      const rTabs = rightPaneTabs.value;
      if (rTabs.length === 0) return;
      const current = rightPaneActiveId.value;
      const idx = current ? rTabs.indexOf(current) : -1;
      const next = rTabs[(idx + dir + rTabs.length) % rTabs.length];
      rightPaneActiveId.value = next;
      return;
    }
    if (splitEnabled.value) {
      const lTabs = leftPaneTabs();
      if (lTabs.length === 0) return;
      const current = activeTabId.value;
      const idx = current ? lTabs.indexOf(current) : -1;
      const next = lTabs[(idx + dir + lTabs.length) % lTabs.length];
      openSession(next);
      return;
    }
    const tabs = openTabs.value;
    if (tabs.length === 0) return;
    const current = activeTabId.value;
    const idx = current ? tabs.indexOf(current) : -1;
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    openSession(next);
  }

  const filtered = recentSessions.filter((s) => {
    if (!sessionSearchQuery.value) return true;
    const q = sessionSearchQuery.value.toLowerCase();
    const text = [getSessionLabel(s.id), s.feedbackTitle, s.agentName, s.id, s.paneTitle, s.paneCommand, s.panePath].filter(Boolean).join(' ').toLowerCase();
    return text.includes(q);
  });
  const terminals = filtered.filter((s: any) => s.permissionProfile === 'plain');
  const agents = filtered.filter((s: any) => s.permissionProfile !== 'plain');
  const waitingAgents = agents.filter((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting');
  const restAgents = agents.filter((s: any) => !(s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'));
  const globalSessions = allNumberedSessions();
  const visibleSet = new Set<string>();
  if (activeTabId.value) visibleSet.add(activeTabId.value);
  if (rightPaneActiveId.value) visibleSet.add(rightPaneActiveId.value);
  for (const p of popoutPanels.value) {
    if (p.visible && p.activeSessionId) visibleSet.add(p.activeSessionId);
  }
  const renderItem = (s: any) => {
    const isTabbed = tabSet.has(s.id);
    const isInPanel = !!findPanelForSession(s.id);
    const isVisible = visibleSet.has(s.id);
    const isNumbered = isTabbed || isInPanel;
    const inputSt = s.status === 'running' ? (sessionInputStates.value.get(s.id) || null) : null;
    const isPlain = s.permissionProfile === 'plain';
    const plainLabel = s.paneCommand
      ? `${s.paneCommand}:${s.panePath || ''} \u2014 ${s.paneTitle || s.id.slice(-6)}`
      : (s.paneTitle || s.id.slice(-6));
    const customLabel = getSessionLabel(s.id);
    const locationPrefix = s.isHarness ? '\u{1F4E6}' : s.isRemote ? '\u{1F310}' : '';
    const raw = customLabel || (isPlain ? `${locationPrefix || '\u{1F5A5}\uFE0F'} ${plainLabel}` : `${locationPrefix ? locationPrefix + ' ' : ''}${s.feedbackTitle || s.agentName || `Session ${s.id.slice(-6)}`}`);
    const tooltipParts: string[] = [];
    if (s.isHarness) tooltipParts.push(`Harness: ${s.harnessName || 'unknown'}`);
    else if (s.isRemote) tooltipParts.push(`Remote: ${s.machineName || s.launcherHostname || 'unknown'}`);
    if (s.paneCommand) tooltipParts.push(`Process: ${s.paneCommand}`);
    if (s.panePath) tooltipParts.push(`Path: ${s.panePath}`);
    tooltipParts.push(isPlain
      ? `Terminal \u2014 ${s.status}`
      : s.feedbackTitle
        ? `${s.feedbackTitle} \u2014 ${s.status}`
        : `${s.agentName || 'Session'} \u2014 ${s.status}`);
    const tooltip = tooltipParts.join('\n');
    const globalIdx = globalSessions.indexOf(s.id);
    const globalNum = globalIdx >= 0 ? globalIdx + 1 : null;
    const showPausedPopup = autoJumpPaused.value && pendingAutoJump.value === s.id && autoJumpShowPopup.value;
    return (
      <div key={s.id} class="sidebar-session-item-wrapper">
        <div
          class={`sidebar-session-item ${isTabbed ? 'tabbed' : ''} ${isInPanel ? 'in-panel' : ''} ${isVisible ? 'active' : ''}`}
          onClick={() => {
            if (inputSt === 'waiting') {
              focusOrDockSession(s.id);
            } else {
              const panel = findPanelForSession(s.id);
              if (panel) {
                updatePanel(panel.id, { activeSessionId: s.id, visible: true });
                bringToFront(panel.id);
                persistPopoutState();
                focusSessionTerminal(s.id);
              } else {
                openSession(s.id);
                focusSessionTerminal(s.id);
              }
            }
          }}
          title={tooltip}
        >
          <span class="sidebar-dot-wrapper">
            <span
              class={`session-status-dot ${s.status}${isPlain ? ' plain' : ''}${inputSt ? ` ${inputSt}` : ''}`}
              title={inputSt === 'waiting' ? 'waiting for input' : inputSt === 'idle' ? 'idle' : s.status}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                sidebarStatusMenu.value = { sessionId: s.id, x: rect.right + 4, y: rect.top };
              }}
            />
            {ctrlShiftHeld.value && inputSt === 'waiting' ? (
              <span class="sidebar-tab-badge sidebar-tab-badge-overlay tab-badge-waiting">A</span>
            ) : ctrlShiftHeld.value && isNumbered && globalNum !== null ? (
              <span class="sidebar-tab-badge-overlay"><SidebarTabBadge tabNum={globalNum} /></span>
            ) : null}
          </span>
          <span class="session-label">{sessionSearchQuery.value ? highlightMatch(raw, sessionSearchQuery.value) : raw}</span>
          <button
            class="sidebar-item-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              sidebarItemMenu.value = { sessionId: s.id, x: rect.right + 4, y: rect.top };
            }}
            title="Session actions"
          >
            {'\u25BE'}
          </button>
          <button
            class="session-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              deleteSession(s.id);
            }}
            title="Archive session"
          >
            {'\u00D7'}
          </button>
        </div>
        {showPausedPopup && (
          <div class="auto-jump-popup" onClick={(e) => e.stopPropagation()}>
            <span class="auto-jump-popup-text">Waiting for you to stop typing</span>
            <span class="auto-jump-popup-actions">
              <kbd onClick={() => { cycleWaitingSession(); cancelAutoJump(); }}>{'\u2303\u21E7'}A</kbd> jump
              {' '}<kbd onClick={cancelAutoJump}>{'\u2303\u21E7'}X</kbd> cancel
              {' '}<kbd onClick={hideAutoJumpPopup}>hide</kbd>
            </span>
          </div>
        )}
      </div>
    );
  };

  const settingsItems = [
    { path: '/settings/agents', label: 'Agents', icon: '\u{1F916}' },
    { path: '/settings/machines', label: 'Machines', icon: '\u{1F5A5}' },
    { path: '/settings/harnesses', label: 'Harnesses', icon: '\u{1F433}' },
    { path: '/settings/sprites', label: 'Sprites', icon: '\u{2601}\uFE0F' },
    { path: '/settings/getting-started', label: 'Getting Started', icon: '\u{1F4D6}' },
    { path: '/settings/preferences', label: 'Preferences', icon: '\u2699' },
  ];

  return (
    <div class="layout">
      <div class={`sidebar ${collapsed ? 'collapsed' : ''}${sidebarAnimating.value ? ' animating' : ''}`} style={{ width: `${width}px` }}>
        <div class="sidebar-header">
          <Tooltip text={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} shortcut="Ctrl+\" position="right">
            <button class="sidebar-toggle" onClick={toggleSidebar}>
              &#9776;
            </button>
          </Tooltip>
          <span class="sidebar-title">Prompt Widget</span>
          {!collapsed && (
            <a
              class="bookmarklet-link"
              href={`javascript:void((function(){var e=document.getElementById('pw-bookmarklet-frame');if(e){e.remove();return}var f=document.createElement('iframe');f.id='pw-bookmarklet-frame';f.src='${window.location.origin}/widget/bookmarklet.html?host='+encodeURIComponent(location.href);f.style.cssText='position:fixed;bottom:0;right:0;width:420px;height:100%;border:none;z-index:2147483647;pointer-events:none;';f.allow='clipboard-write';window.addEventListener('message',function(m){if(m.data&&m.data.type==='pw-bookmarklet-remove'){var el=document.getElementById('pw-bookmarklet-frame');if(el)el.remove()}});document.body.appendChild(f)})())`}
              title="Drag to bookmarks bar to load widget on any site"
              onClick={(e) => e.preventDefault()}
            >
              {'\u{1F516}'}
            </a>
          )}
        </div>
        <nav>
          {!collapsed && (
            <div class="sidebar-section-header">
              Apps
              <button
                class="sidebar-new-terminal-btn"
                onClick={(e) => { e.stopPropagation(); addAppModalOpen.value = true; }}
                title="Add app"
              >+</button>
            </div>
          )}
          {apps.map((app) => {
            const isSelected = selAppId === app.id;
            return (
              <div key={app.id}>
                <a
                  href={`#/app/${app.id}/feedback`}
                  class={`sidebar-app-item ${isSelected ? 'active' : ''}`}
                  onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/feedback`); }}
                  title={collapsed ? app.name : undefined}
                >
                  <span class="nav-icon">{'\u{1F4BB}'}</span>
                  <span class="nav-label">{app.name}</span>
                </a>
                {isSelected && !collapsed && (
                  <div class="sidebar-subnav">
                    <a
                      href={`#/app/${app.id}/feedback`}
                      class={route === `/app/${app.id}/feedback` || route.startsWith(`/app/${app.id}/feedback/`) ? 'active' : ''}
                      onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/feedback`); }}
                    >
                      {'\u{1F4CB}'} Feedback
                      {fbCounts[app.id] > 0 && <span class="sidebar-count">{fbCounts[app.id]}</span>}
                    </a>
                    <a
                      href={`#/app/${app.id}/aggregate`}
                      class={route === `/app/${app.id}/aggregate` ? 'active' : ''}
                      onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/aggregate`); }}
                    >
                      {'\u{1F4CA}'} Aggregate
                    </a>
                    <a
                      href={`#/app/${app.id}/sessions`}
                      class={route === `/app/${app.id}/sessions` ? 'active' : ''}
                      onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/sessions`); }}
                    >
                      {'\u26A1'} Sessions
                    </a>
                    <a
                      href={`#/app/${app.id}/live`}
                      class={route === `/app/${app.id}/live` ? 'active' : ''}
                      onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/live`); }}
                    >
                      {'\u{1F310}'} Live
                      {(liveConnectionCounts.value[app.id] || 0) > 0 && (
                        <span class="sidebar-count">{liveConnectionCounts.value[app.id]}</span>
                      )}
                    </a>
                    <a
                      href={`#/app/${app.id}/settings`}
                      class={route === `/app/${app.id}/settings` ? 'active' : ''}
                      onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/settings`); }}
                    >
                      {'\u2699'} Settings
                    </a>
                  </div>
                )}
              </div>
            );
          })}
          {hasUnlinked && (
            <div>
              <a
                href="#/app/__unlinked__/feedback"
                class={`sidebar-app-item ${selAppId === '__unlinked__' ? 'active' : ''}`}
                onClick={(e) => { e.preventDefault(); navigate('/app/__unlinked__/feedback'); }}
                title={collapsed ? 'Unlinked' : undefined}
              >
                <span class="nav-icon">{'\u{1F517}'}</span>
                <span class="nav-label">Unlinked</span>
                {!collapsed && unlinkedCount.value > 0 && <span class="sidebar-count">{unlinkedCount.value}</span>}
              </a>
              {selAppId === '__unlinked__' && !collapsed && (
                <div class="sidebar-subnav">
                  <a
                    href="#/app/__unlinked__/feedback"
                    class={route.startsWith('/app/__unlinked__/feedback') ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate('/app/__unlinked__/feedback'); }}
                  >
                    {'\u{1F4CB}'} Feedback
                  </a>
                </div>
              )}
            </div>
          )}

          {!collapsed && liveSites.value.length > 0 && (
            <>
              <div class="sidebar-divider" />
              <div class="sidebar-section-header">Sites</div>
              {liveSites.value.map((site) => (
                <div key={site.origin} class="sidebar-site-item" title={site.origin}>
                  <span class="nav-icon">{'\u{1F310}'}</span>
                  <span class="nav-label">{site.hostname}</span>
                  <span class="sidebar-count">{site.count}</span>
                </div>
              ))}
            </>
          )}

          <div class="sidebar-divider" />

          {!collapsed && (
            <div class="sidebar-section-header">Settings</div>
          )}
          {settingsItems.map((item) => (
            <a
              key={item.path}
              href={`#${item.path}`}
              class={route === item.path ? 'active' : ''}
              onClick={(e) => { e.preventDefault(); navigate(item.path); }}
              title={collapsed ? item.label : undefined}
            >
              <span class="nav-icon">{item.icon}</span>
              <span class="nav-label">{item.label}</span>
            </a>
          ))}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              clearToken();
              navigate('/login');
            }}
            title={collapsed ? 'Logout' : undefined}
          >
            <span class="nav-icon">{'\u21A9'}</span>
            <span class="nav-label">Logout</span>
          </a>
        </nav>
        {!collapsed && (
          <>
            <div
              class="sidebar-resize-handle"
              onMouseDown={(e) => {
                const startY = e.clientY;
                const startSH = sessionsHeight.value;
                const startTH = terminalsHeight.value;
                const total = startSH + startTH;
                const sRatio = total > 0 ? startSH / total : 0.5;
                const tRatio = total > 0 ? startTH / total : 0.5;
                startDrag(e, 'ns-resize', (ev) => {
                  const delta = -(ev.clientY - startY);
                  setSessionsHeight(startSH + delta * sRatio);
                  setTerminalsHeight(startTH + delta * tRatio);
                }, e.currentTarget as HTMLElement);
              }}
            />
            <div
              class={`sidebar-sessions ${sessionsDrawerOpen.value ? 'open' : 'closed'}`}
              style={sessionsDrawerOpen.value ? { height: `${sessionsHeight.value}px` } : undefined}
            >
              <div class="sidebar-sessions-header">
                <span class={`sessions-chevron ${sessionsDrawerOpen.value ? 'expanded' : ''}`} onClick={toggleSessionsDrawer}>{'\u25B8'}</span>
                Sessions ({visibleSessions.length})
                {runningSessions > 0 && <span class="sidebar-running-badge">{runningSessions} running</span>}
                {waitingCount > 0 && <span class="sidebar-waiting-badge">{waitingCount} waiting</span>}
                <div class="auto-jump-dropdown" onClick={(e) => e.stopPropagation()}>
                    <span
                      class={`auto-jump-trigger${autoJumpWaiting.value ? ' active' : ''}`}
                      onClick={() => { autoJumpMenuOpen.value = !autoJumpMenuOpen.value; }}
                    >
                      aj {autoJumpWaiting.value ? '\u25CF' : '\u25CB'} {'\u25BE'}
                    </span>
                    {autoJumpMenuOpen.value && (
                      <div class="auto-jump-menu" onClick={(e) => e.stopPropagation()}>
                        <label>
                          <input
                            type="checkbox"
                            checked={autoJumpWaiting.value}
                            onChange={(e) => { autoJumpWaiting.value = (e.target as HTMLInputElement).checked; }}
                          />
                          Enable Auto-Jump
                        </label>
                        <div class="id-dropdown-separator" />
                        <label>
                          <input
                            type="checkbox"
                            checked={autoJumpInterrupt.value}
                            onChange={(e) => { autoJumpInterrupt.value = (e.target as HTMLInputElement).checked; }}
                          />
                          Interrupt typing
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={autoJumpDelay.value}
                            onChange={(e) => { autoJumpDelay.value = (e.target as HTMLInputElement).checked; }}
                          />
                          3s delay <kbd>{'\u2303\u21E7'}X</kbd>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={autoJumpShowPopup.value}
                            onChange={(e) => { autoJumpShowPopup.value = (e.target as HTMLInputElement).checked; }}
                          />
                          Show paused popup
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={autoCloseWaitingPanel.value}
                            onChange={(e) => { autoCloseWaitingPanel.value = (e.target as HTMLInputElement).checked; }}
                          />
                          Auto-close panel
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={autoJumpHandleBounce.value}
                            onChange={(e) => { autoJumpHandleBounce.value = (e.target as HTMLInputElement).checked; }}
                          />
                          Handle bounce
                        </label>
                        <div class="id-dropdown-separator" />
                        <label>
                          <input
                            type="checkbox"
                            checked={autoJumpLogs.value}
                            onChange={(e) => { autoJumpLogs.value = (e.target as HTMLInputElement).checked; }}
                          />
                          Log to console
                        </label>
                      </div>
                    )}
                  </div>
                <button
                  class="sidebar-new-terminal-btn"
                  onClick={() => { termPickerOpen.value = { kind: 'claude' }; }}
                  title="New Claude session (g c)"
                >+</button>
              </div>
              {sessionsDrawerOpen.value && (
                <>
                  <div class="sidebar-sessions-filters">
                    <input
                      type="text"
                      placeholder="Search..."
                      value={sessionSearchQuery.value}
                      onInput={(e) => (sessionSearchQuery.value = (e.target as HTMLInputElement).value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      class={`sidebar-filter-toggle-btn ${filtersOpen ? 'active' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleSessionFiltersOpen(); }}
                      title="Filter options"
                    >
                      {'\u2630'}
                      {activeFilterCount < 5 && <span class="filter-active-dot" />}
                    </button>
                  </div>
                  {filtersOpen && (
                    <div class="sidebar-filter-panel" onClick={(e) => e.stopPropagation()}>
                      <div class="sidebar-filter-section">
                        <div class="sidebar-filter-section-label">Status</div>
                        <div class="sidebar-filter-checkboxes">
                          {(['running', 'pending', 'completed', 'failed', 'killed'] as const).map((status) => (
                            <label key={status} class="sidebar-filter-checkbox">
                              <input
                                type="checkbox"
                                checked={activeStatusFilters.has(status)}
                                onChange={() => toggleStatusFilter(status)}
                              />
                              <span class={`session-status-dot ${status}`} />
                              <span>{status}</span>
                              {(statusCounts[status] || 0) > 0 && (
                                <span class="sidebar-filter-count">{statusCounts[status]}</span>
                              )}
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  <div class="sidebar-sessions-list">
                    {waitingAgents.length > 0 && (
                      <>
                        <div class="sidebar-section-label waiting-section-label">
                          Waiting for input ({waitingAgents.length})
                        </div>
                        {waitingAgents.map(renderItem)}
                      </>
                    )}
                    {restAgents.length > 0 && (
                      <>
                        <div class="sidebar-section-label">Agent Sessions ({restAgents.length})</div>
                        {restAgents.map(renderItem)}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            {terminals.length > 0 && (
              <div
                class="sidebar-terminals-resize-handle"
                onMouseDown={(e) => {
                  const startY = e.clientY;
                  const startSH = sessionsHeight.value;
                  const startTH = terminalsHeight.value;
                  startDrag(e, 'ns-resize', (ev) => {
                    const delta = ev.clientY - startY;
                    setSessionsHeight(startSH + delta);
                    setTerminalsHeight(startTH - delta);
                  }, e.currentTarget as HTMLElement);
                }}
              />
            )}
            <div
              class="sidebar-terminals"
              style={terminals.length > 0 ? { height: `${terminalsHeight.value}px` } : undefined}
            >
              <div class="sidebar-terminals-header">
                Terminals ({terminals.length})
                <button
                  class="sidebar-new-terminal-btn"
                  onClick={() => { termPickerOpen.value = { kind: 'new' }; }}
                  title="New terminal (g t)"
                >+</button>
              </div>
              {terminals.length > 0 && (
                <div class="sidebar-terminals-list">
                  {terminals.map(renderItem)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {!collapsed && (
        <div
          class="sidebar-edge-handle"
          onMouseDown={(e) => {
            const startX = e.clientX;
            const startW = width;
            startDrag(e, 'ew-resize', (ev) => setSidebarWidth(startW + (ev.clientX - startX)), e.currentTarget as HTMLElement);
          }}
        />
      )}
      <div class="main-wrapper">
        <ControlBar />
        <div class="main" style={{
          paddingBottom: bottomPad ? `${bottomPad + 16}px` : undefined,
        }}>
          <RequestPanel />
          {children}
        </div>
      </div>
      <GlobalTerminalPanel />
      <PopoutPanel />
      <FileViewerOverlay />
      {showShortcutHelp && <ShortcutHelpModal onClose={() => setShowShortcutHelp(false)} />}
      {showSpotlight && <SpotlightSearch onClose={() => setShowSpotlight(false)} />}
      {addAppModalOpen.value && <AddAppModal onClose={() => { addAppModalOpen.value = false; }} />}
      {actionToast.value && (
        <div class="action-toast">
          <span class="action-toast-key" style={{ background: actionToast.value.color }}>{actionToast.value.key}</span>
          <span class="action-toast-label">{actionToast.value.label}</span>
        </div>
      )}
      {autoJumpCountdown.value > 0 && (
        <div class="action-toast auto-jump-toast">
          <span class="action-toast-key" style={{ background: 'var(--pw-warning, #f59e0b)' }}>
            {autoJumpCountdown.value}
          </span>
          <span class="action-toast-label">
            Jumping in {autoJumpCountdown.value}s
            {' '}<kbd onClick={cancelAutoJump} style={{ cursor: 'pointer' }}>{'\u2303\u21E7'}X</kbd>
          </span>
        </div>
      )}
      <PerfOverlay />
      {sidebarStatusMenu.value && (() => {
        const menuSid = sidebarStatusMenu.value!.sessionId;
        const menuSess = allSessions.value.find((s: any) => s.id === menuSid);
        const menuExited = exitedSessions.value.has(menuSid);
        const isRunning = menuSess?.status === 'running';
        return (
          <div
            class="status-dot-menu"
            style={{ left: `${sidebarStatusMenu.value!.x}px`, top: `${sidebarStatusMenu.value!.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {isRunning && !menuExited && (
              <button onClick={() => { sidebarStatusMenu.value = null; killSession(menuSid); }}>Kill {showHotkeyHints.value && <kbd>⌃⇧K</kbd>}</button>
            )}
            {isRunning && menuSess?.feedbackId && (
              <button onClick={() => { sidebarStatusMenu.value = null; resolveSession(menuSid, menuSess.feedbackId); }}>Resolve {showHotkeyHints.value && <kbd>⌃⇧R</kbd>}</button>
            )}
            {menuExited && (
              <button onClick={() => { sidebarStatusMenu.value = null; resumeSession(menuSid); }}>Resume</button>
            )}
            <button onClick={() => { sidebarStatusMenu.value = null; closeTab(menuSid); }}>Close tab {showHotkeyHints.value && <kbd>⌃⇧W</kbd>}</button>
            <button onClick={() => { sidebarStatusMenu.value = null; deleteSession(menuSid); }}>Archive</button>
          </div>
        );
      })()}
      {sidebarItemMenu.value && (() => {
        const menuSid = sidebarItemMenu.value!.sessionId;
        const menuHeight = 176;
        const flipUp = sidebarItemMenu.value!.y + menuHeight > window.innerHeight;
        const menuStyle = flipUp
          ? { left: `${sidebarItemMenu.value!.x}px`, bottom: `${window.innerHeight - sidebarItemMenu.value!.y - 20}px` }
          : { left: `${sidebarItemMenu.value!.x}px`, top: `${sidebarItemMenu.value!.y}px` };
        return (
          <div
            class="status-dot-menu"
            style={menuStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => {
              sidebarItemMenu.value = null;
              navigator.clipboard.writeText(`${location.origin}${location.pathname}#/session/${menuSid}`);
              showActionToast('\u{1F517}', 'Link copied', 'var(--pw-accent, var(--pw-primary))');
            }}>Copy link</button>
            <button onClick={() => { sidebarItemMenu.value = null; popOutTab(menuSid); }}>Open in panel</button>
            <button onClick={() => {
              sidebarItemMenu.value = null;
              window.open(`${location.pathname}#/session/${menuSid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
            }}>Open in window</button>
            <button onClick={() => {
              sidebarItemMenu.value = null;
              window.open(`${location.pathname}#/session/${menuSid}`, '_blank');
            }}>Open in tab</button>
            <button onClick={() => {
              sidebarItemMenu.value = null;
              api.openSessionInTerminal(menuSid).catch((err: any) => console.error('Open in terminal failed:', err.message));
            }}>Open in Terminal.app</button>
            <button onClick={() => { sidebarItemMenu.value = null; enableSplit(menuSid); }}>Split pane</button>
          </div>
        );
      })()}
    </div>
  );
}
