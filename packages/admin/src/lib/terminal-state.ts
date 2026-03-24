import { signal } from '@preact/signals';
import {
  openTabs,
  activeTabId,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  loadJson,
  nudgeResize,
  persistSplitState,
} from './session-state.js';
import {
  popoutPanels,
  findPanelForSession,
  updatePanel,
  persistPopoutState,
  togglePopoutVisibility,
  allNumberedSessions,
  bringToFront,
  AUTOJUMP_PANEL_ID,
} from './popout-state.js';

// --- Sidebar ---

export const SIDEBAR_WIDTH_COLLAPSED = 56;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 220;

export const sidebarCollapsed = signal(localStorage.getItem('pw-sidebar-collapsed') === 'true');
export const sidebarWidth = signal(
  sidebarCollapsed.value ? SIDEBAR_WIDTH_COLLAPSED : loadJson('pw-sidebar-width', SIDEBAR_DEFAULT_WIDTH)
);
export const sidebarAnimating = signal(false);

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

// --- Sessions Drawer ---

export const sessionsDrawerOpen = signal(localStorage.getItem('pw-sessions-drawer') !== 'false');
export const showResolvedSessions = signal(localStorage.getItem('pw-show-resolved') === 'true');
export const sessionSearchQuery = signal('');
export const sessionsHeight = signal(loadJson('pw-sessions-height', 300));

export function toggleSessionsDrawer() {
  sessionsDrawerOpen.value = !sessionsDrawerOpen.value;
  localStorage.setItem('pw-sessions-drawer', String(sessionsDrawerOpen.value));
}

export const sidebarStatusMenu = signal<{ sessionId: string; x: number; y: number } | null>(null);
export const sidebarItemMenu = signal<{ sessionId: string; x: number; y: number } | null>(null);

export function toggleShowResolved() {
  showResolvedSessions.value = !showResolvedSessions.value;
  localStorage.setItem('pw-show-resolved', String(showResolvedSessions.value));
}

export function setSessionsHeight(h: number) {
  const clamped = Math.max(80, Math.min(h, window.innerHeight - 200));
  sessionsHeight.value = clamped;
  localStorage.setItem('pw-sessions-height', JSON.stringify(clamped));
}

// --- Terminal Heights ---

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

// --- Control Bar ---

export const controlBarMinimized = signal(loadJson('pw-control-bar-minimized', false));

export function toggleControlBarMinimized() {
  controlBarMinimized.value = !controlBarMinimized.value;
  localStorage.setItem('pw-control-bar-minimized', JSON.stringify(controlBarMinimized.value));
}

// --- Hotkey Menu ---

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

// --- Tab Digit Navigation ---

export const pendingFirstDigit = signal<number | null>(null);
let pendingTabTimer: ReturnType<typeof setTimeout> | null = null;

function clearPending() {
  pendingFirstDigit.value = null;
  if (pendingTabTimer) { clearTimeout(pendingTabTimer); pendingTabTimer = null; }
}

// openSession is passed as a callback to avoid circular dependency
let _openSession: ((sessionId: string) => void) | null = null;

export function setOpenSessionCallback(fn: (sessionId: string) => void) {
  _openSession = fn;
}

function activateGlobalSession(all: string[], num: number) {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (num === 0) {
    togglePopoutVisibility();
    return;
  }
  const idx = num - 1;
  if (idx < 0 || idx >= all.length) return;
  const sid = all[idx];
  if (openTabs.value.includes(sid)) {
    _openSession?.(sid);
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
