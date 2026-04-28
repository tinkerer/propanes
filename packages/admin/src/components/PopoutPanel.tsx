import { useRef, useCallback, useEffect } from 'preact/hooks';
import { copyText } from '../lib/clipboard.js';
import {
  type PopoutPanelState,
  popoutPanels,
  allSessions,
  sessionMapComputed,
  exitedSessions,
  popBackIn,
  updatePanel,
  persistPopoutState,
  killSession,
  resumeSession,
  getViewMode,
  setViewMode,
  closeTab,
  getDockedPanelTop,
  allNumberedSessions,
  pendingFirstDigit,
  focusedPanelId,
  activePanelId,
  snapGuides,
  dockedOrientation,
  sessionInputStates,
  getSessionLabel,
  setSessionLabel,
  getSessionColor,
  togglePanelCompanion,
  panelLeftTabs,
  syncPanelCompanions,
  companionTabId,
  sidebarWidth,
  sidebarCollapsed,
  AUTOJUMP_PANEL_ID,
  COS_PANEL_ID,
  resolveSession,
  bringToFront,
  getPanelZIndex,
  panelZOrders,
  toggleAlwaysOnTop,
  switchAutoJumpActiveSession,
  getTerminalCompanion,
  focusSessionTerminal,
  termPickerOpen,
} from '../lib/sessions.js';
import { startTabDrag, startPanelDrag, detectExternalZone, openPanelExternally, applyExternalGhostHint } from '../lib/tab-drag.js';
import { ctrlShiftHeld, stickyModeActive } from '../lib/shortcuts.js';
import { selectedAppId } from '../lib/state.js';
import { showHotkeyHints } from '../lib/settings.js';
import { api } from '../lib/api.js';
import { renderTabContent } from './PaneContent.js';
import { setFocusedLeaf } from '../lib/pane-tree.js';
import {
  handleDragMove, handleResizeMove, handleSplitDividerMove,
} from '../lib/popout-physics.js';
import { PanelTabBadge, tabLabel, companionCopyId, IdDropdownMenu, WindowMenu } from './PopoutPanelContent.js';
import { DockedPanelGrabHandle } from './PopoutGrabHandle.js';
import { PopoutResizeHandles } from './PopoutResizeHandles.js';
import { PopoutStatusMenu, PopoutHotkeyMenu } from './PopoutPanelMenus.js';
import { PopoutSingletonBar } from './PopoutSingletonBar.js';
import { PopoutMultiTabBar } from './PopoutMultiTabBar.js';
import { PopoutSplitPane } from './PopoutSplitPane.js';

import {
  popoutIdMenuOpen,
  popoutWindowMenuOpen,
  popoutStatusMenuOpen,
  popoutHotkeyMenuOpen,
  renamingSessionId,
  renameValue,
  companionMenuOpen,
} from './popout-signals.js';

// Re-export the menu signals consumed by Layout.tsx so callers don't need to
// know we moved the storage out of this file.
export { popoutIdMenuOpen, popoutWindowMenuOpen };

function scrollActiveTabIntoView(container: HTMLDivElement | null, selector: string) {
  if (!container) return;
  const el = container.querySelector(selector) as HTMLElement | null;
  if (el) el.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
}

function PanelView({ panel }: { panel: PopoutPanelState }) {
  const ids = panel.sessionIds;
  const activeId = panel.activeSessionId || ids[0];
  const sessionMap = sessionMapComputed.value;
  const session = sessionMap.get(activeId);
  const isExited = activeId ? exitedSessions.value.has(activeId) : false;
  const viewMode = activeId ? getViewMode(activeId) : 'terminal';
  const docked = panel.docked;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  const resizing = useRef<string | null>(null);
  const splitDragging = useRef(false);
  const prevActiveRef = useRef<string | null>(null);
  const startPos = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, dockedHeight: 0, dockedTopOffset: 0, dockedBaseTop: 0 });

  // Sync companions when active session changes
  useEffect(() => {
    if (activeId && prevActiveRef.current !== activeId) {
      syncPanelCompanions(panel.id, activeId, prevActiveRef.current);
      prevActiveRef.current = activeId;
    }
  }, [activeId, panel.id]);

  const isSplit = !!panel.splitEnabled;
  const panelRightTabs = panel.rightPaneTabs || [];
  const panelRightActive = panel.rightPaneActiveId || null;
  const leftTabs = isSplit ? panelLeftTabs(panel) : ids;

  const hasTabs = ids.length > 1;
  const panelTop = docked ? getDockedPanelTop(panel.id) : undefined;
  const isMinimized = !docked && !!panel.minimized;
  const orientation = dockedOrientation.value;
  const isFocused = focusedPanelId.value === panel.id;
  const isActive = activePanelId.value === panel.id;

  const isLeftDocked = docked && panel.dockedSide === 'left';
  const _zOrders = panelZOrders.value;  // subscribe to signal
  const panelZIdx = getPanelZIndex(panel);
  const panelStyle = docked
    ? isLeftDocked
      ? { position: 'fixed' as const, left: sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3), top: panelTop, width: panel.dockedWidth, height: panel.dockedHeight, zIndex: panelZIdx }
      : orientation === 'horizontal'
        ? (() => {
            const dockedPanels = popoutPanels.value.filter((p) => p.docked && p.visible && p.dockedSide !== 'left');
            const idx = dockedPanels.findIndex((p) => p.id === panel.id);
            const count = dockedPanels.length;
            const topStart = 40;
            const availH = window.innerHeight - topStart;
            const perPanel = count > 0 ? availH / count : availH;
            return { position: 'fixed' as const, right: 0, top: topStart + idx * perPanel, width: panel.dockedWidth, height: perPanel, zIndex: panelZIdx };
          })()
        : { position: 'fixed' as const, right: 0, top: panelTop, width: panel.dockedWidth, height: panel.dockedHeight, zIndex: panelZIdx }
    : { position: 'fixed' as const, left: panel.floatingRect.x, top: panel.floatingRect.y, width: panel.floatingRect.w, height: isMinimized ? 34 : panel.floatingRect.h, zIndex: panelZIdx };

  const onHeaderDragStart = useCallback((e: MouseEvent, force?: boolean) => {
    if (!force && (e.target as HTMLElement).closest('button, select, a, .id-dropdown-wrapper, .session-status-dot, .session-id-label')) return;
    e.preventDefault();
    dragging.current = true;
    dragMoved.current = false;
    wrapperRef.current?.classList.add('popout-dragging');
    const cp = popoutPanels.value.find((p) => p.id === panel.id);
    if (!cp) return;
    const fr = cp.floatingRect;
    startPos.current = { mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h, dockedHeight: cp.dockedHeight, dockedTopOffset: cp.dockedTopOffset || 0, dockedBaseTop: cp.docked ? (e.clientY - getDockedPanelTop(panel.id)) : 0 };
    const ghostLabel = `Panel: ${ids.length} tab${ids.length === 1 ? '' : 's'}`;
    let ghost: HTMLElement | null = null;
    const ensureGhost = () => {
      if (ghost) return;
      ghost = document.createElement('div');
      ghost.className = 'tab-drag-ghost pane-drag-ghost';
      ghost.textContent = ghostLabel;
      document.body.appendChild(ghost);
    };
    const removeGhost = () => {
      if (ghost) { ghost.remove(); ghost = null; }
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      handleDragMove(ev, panel.id, startPos.current, dragMoved);
      if (detectExternalZone(ev.clientX, ev.clientY)) {
        ensureGhost();
        applyExternalGhostHint(ghost, ghostLabel, ev.clientX, ev.clientY);
      } else {
        removeGhost();
      }
    };
    const onUp = (ev: MouseEvent) => {
      dragging.current = false;
      wrapperRef.current?.classList.remove('popout-dragging');
      snapGuides.value = [];
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      removeGhost();

      const externalZone = detectExternalZone(ev.clientX, ev.clientY);
      if (externalZone && dragMoved.current) {
        const src = popoutPanels.value.find((p) => p.id === panel.id);
        if (src) {
          const sessionIds = [...src.sessionIds];
          if (sessionIds.length > 0) {
            openPanelExternally({
              sessionIds,
              activeId: src.activeSessionId,
              rightIds: src.splitEnabled ? src.rightPaneTabs : undefined,
              ratio: src.splitRatio,
            }, externalZone);
            for (const sid of sessionIds) closeTab(sid);
            return;
          }
        }
      }
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panel.id, ids.length]);

  const onResizeStart = useCallback((edge: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = edge;
    wrapperRef.current?.classList.add('popout-dragging');
    const currentPanel = popoutPanels.value.find((p) => p.id === panel.id);
    if (!currentPanel) return;
    const fr = currentPanel.floatingRect;
    const curOffset = currentPanel.dockedTopOffset || 0;
    const curTop = getDockedPanelTop(panel.id);
    const baseTop = curTop - curOffset;
    startPos.current = { mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h, dockedHeight: currentPanel.dockedHeight, dockedTopOffset: curOffset, dockedBaseTop: baseTop };
    const startDockedW = currentPanel.dockedWidth;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      handleResizeMove(ev, panel.id, resizing.current, startPos.current, startDockedW);
    };
    const onUp = () => {
      resizing.current = null;
      wrapperRef.current?.classList.remove('popout-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panel.id]);

  const onSplitDividerMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    container.classList.add('dragging');
    const containerRect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      if (!splitDragging.current) return;
      handleSplitDividerMove(ev, panel.id, containerRect);
    };
    const onUp = () => {
      splitDragging.current = false;
      container.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panel.id]);

  // Collapsed-handle: click expands. Drag across the split axis resizes
  // (and expands); drag parallel to the edge slides the handle's offset.
  const onPopoutCollapsedHandleMouseDown = useCallback((e: MouseEvent, p: PopoutPanelState) => {
    e.preventDefault();
    e.stopPropagation();
    const container = (e.currentTarget as HTMLElement).closest('.popout-split-container') as HTMLElement | null;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const edge: 'N' | 'S' | 'E' | 'W' = p.splitEdge || 'E';
    const isHoriz = edge === 'E' || edge === 'W';
    const startX = e.clientX;
    const startY = e.clientY;
    const startOffset = p.splitCollapsedOffset || 0;
    const DRAG_THRESHOLD = 4;
    let moved = false;
    let axis: 'along' | 'cross' | null = null;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        const crossMag = isHoriz ? Math.abs(dx) : Math.abs(dy);
        const alongMag = isHoriz ? Math.abs(dy) : Math.abs(dx);
        axis = crossMag > alongMag ? 'cross' : 'along';
        if (axis === 'cross') container.classList.add('dragging');
      }
      if (!moved || !axis) return;
      if (axis === 'along') {
        const delta = isHoriz ? dy : dx;
        updatePanel(p.id, { splitCollapsedOffset: startOffset + delta });
      } else {
        // Cross-axis resize. ratio = main-pane proportion regardless of edge.
        let ratio: number;
        if (edge === 'E') ratio = (ev.clientX - rect.left) / rect.width;
        else if (edge === 'W') ratio = 1 - (ev.clientX - rect.left) / rect.width;
        else if (edge === 'S') ratio = (ev.clientY - rect.top) / rect.height;
        else ratio = 1 - (ev.clientY - rect.top) / rect.height; // N
        updatePanel(p.id, { splitRatio: Math.max(0.1, Math.min(0.9, ratio)) });
      }
    };
    const onUp = () => {
      container.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!moved || axis === 'cross') {
        updatePanel(p.id, { splitCollapsed: false });
      }
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const globalSessions = allNumberedSessions();
  const inputSt = activeId ? (sessionInputStates.value.get(activeId) || null) : null;
  const tabsRef = useRef<HTMLDivElement>(null);
  const leftSplitTabsRef = useRef<HTMLDivElement>(null);
  const rightSplitTabsRef = useRef<HTMLDivElement>(null);

  const tl = (sid: string) => tabLabel(sid, sessionMap);
  const ccid = (sid: string) => companionCopyId(sid, sessionMap);

  function globalNum(sid: string): number | null {
    const idx = globalSessions.indexOf(sid);
    return idx >= 0 ? idx + 1 : null;
  }

  const showBadges = ctrlShiftHeld.value;
  const activeGlobalNum = activeId ? globalNum(activeId) : null;
  const isPlain = session?.permissionProfile === 'plain';
  const appId = selectedAppId.value;
  const feedbackPath = session?.feedbackId
    ? appId ? `/app/${appId}/tickets/${session.feedbackId}` : `/tickets/${session.feedbackId}`
    : null;
  const showIdMenu = popoutIdMenuOpen.value === activeId;

  useEffect(() => {
    requestAnimationFrame(() => {
      scrollActiveTabIntoView(tabsRef.current, '.popout-tab.active');
    });
  }, [panel.id, activeId, ids.length]);

  useEffect(() => {
    if (!isSplit) return;
    requestAnimationFrame(() => {
      scrollActiveTabIntoView(leftSplitTabsRef.current, '.popout-tab.active');
    });
  }, [panel.id, isSplit, activeId, leftTabs.length]);

  useEffect(() => {
    if (!isSplit) return;
    requestAnimationFrame(() => {
      scrollActiveTabIntoView(rightSplitTabsRef.current, '.popout-tab.active');
    });
  }, [panel.id, isSplit, panelRightActive, panelRightTabs.length]);

  return (
    <>
      {showBadges && !docked && activeGlobalNum !== null && (
        <div
          class="popout-floating-badge"
          style={{ left: panel.floatingRect.x - 10, top: panel.floatingRect.y - 10 }}
        >
          <PanelTabBadge tabNum={activeGlobalNum} />
        </div>
      )}
      <div
        ref={wrapperRef}
        class={`${docked ? `popout-docked${isLeftDocked ? ' docked-left' : ''}` : 'popout-floating'}${isMinimized ? ' minimized' : ''}${isFocused ? ' panel-focused' : ''}${isActive ? ' panel-active' : ''}${panel.alwaysOnTop ? ' always-on-top' : ''}${stickyModeActive.value ? ' move-mode' : ''}`}
        style={panelStyle}
        data-panel-id={panel.id}
        onMouseDown={(e) => {
          activePanelId.value = panel.id; bringToFront(panel.id); setFocusedLeaf(null);
          if (panel.activeSessionId) focusSessionTerminal(panel.activeSessionId);
          if (stickyModeActive.value) {
            e.stopPropagation();
            onHeaderDragStart(e as any, true);
          }
        }}
      >
      {stickyModeActive.value && (
        <div class="move-mode-overlay" onMouseDown={(e) => { e.stopPropagation(); onHeaderDragStart(e as any, true); }} />
      )}
      {ids.length === 1 ? (
        <PopoutSingletonBar
          panel={panel}
          activeId={activeId}
          session={session}
          feedbackPath={feedbackPath}
          isExited={isExited}
          isPlain={isPlain}
          viewMode={viewMode}
          showIdMenu={showIdMenu}
          ids={ids}
          docked={docked}
          isLeftDocked={isLeftDocked}
          isMinimized={isMinimized}
          onHeaderDragStart={onHeaderDragStart}
          dragMoved={dragMoved}
          tl={tl}
        />
      ) : (
        <PopoutMultiTabBar
          panel={panel}
          ids={ids}
          activeId={activeId}
          session={session}
          sessionMap={sessionMap}
          isExited={isExited}
          viewMode={viewMode}
          feedbackPath={feedbackPath}
          showIdMenu={showIdMenu}
          docked={docked}
          isLeftDocked={isLeftDocked}
          isMinimized={isMinimized}
          onHeaderDragStart={onHeaderDragStart}
          dragMoved={dragMoved}
          tabsRef={tabsRef}
          tl={tl}
          globalNum={globalNum}
        />
      )}
      {!isMinimized && !isSplit && (
        <div class="popout-body">
          {activeId && renderTabContent(activeId, true, sessionMap)}
        </div>
      )}
      {!isMinimized && isSplit && (
        <PopoutSplitPane
          panel={panel}
          activeId={activeId}
          sessionMap={sessionMap}
          hasTabs={hasTabs}
          leftTabs={leftTabs}
          panelRightTabs={panelRightTabs}
          panelRightActive={panelRightActive}
          leftSplitTabsRef={leftSplitTabsRef}
          rightSplitTabsRef={rightSplitTabsRef}
          onSplitDividerMouseDown={onSplitDividerMouseDown}
          onPopoutCollapsedHandleMouseDown={onPopoutCollapsedHandleMouseDown}
          tl={tl}
          ccid={ccid}
        />
      )}
      {!isMinimized && (
        <PopoutResizeHandles docked={docked} isLeftDocked={isLeftDocked} onResizeStart={onResizeStart} />
      )}
    </div>
    </>
  );
}

export function PopoutPanel() {
  const panels = popoutPanels.value;
  const guides = snapGuides.value;

  useEffect(() => {
    if (!popoutIdMenuOpen.value) return;
    const close = () => { popoutIdMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [popoutIdMenuOpen.value]);

  useEffect(() => {
    if (!popoutStatusMenuOpen.value) return;
    const close = () => { popoutStatusMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [popoutStatusMenuOpen.value]);

  useEffect(() => {
    if (!companionMenuOpen.value) return;
    const close = () => { companionMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [companionMenuOpen.value]);

  // Note: PopupMenu handles click-outside close via its own mousedown listener.
  // We intentionally don't add a document-level click listener here — doing so
  // would tear the menu down before nested submenu buttons can handle their
  // click (e.g. Pop Out Panel / Pop Out Tab submenus).

  // Keyboard shortcuts for the ID dropdown menu (matches bottom panel)
  useEffect(() => {
    const menuSessionId = popoutIdMenuOpen.value;
    if (!menuSessionId) return;
    const sMap = sessionMapComputed.value;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === 'c') {
        copyText(menuSessionId);
      } else if (key === 'p') {
        popBackIn(menuSessionId);
      } else if (key === 'w') {
        window.open(`#/session/${menuSessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
      } else if (key === 'b') {
        window.open(`#/session/${menuSessionId}`, '_blank');
      } else if (key === 'j') {
        const s = sMap.get(menuSessionId);
        if (s?.jsonlPath) copyText(s.jsonlPath);
      } else if (key === 'l') {
        const s = sMap.get(menuSessionId);
        if (s?.jsonlPath) {
          const ownerPanel = panels.find((p) => p.sessionIds.includes(menuSessionId));
          if (ownerPanel) togglePanelCompanion(ownerPanel.id, menuSessionId, 'jsonl');
        }
      } else if (key === 'y') {
        const s = sMap.get(menuSessionId);
        if (s?.jsonlPath) {
          const ownerPanel = panels.find((p) => p.sessionIds.includes(menuSessionId));
          if (ownerPanel) togglePanelCompanion(ownerPanel.id, menuSessionId, 'summary');
        }
      } else if (key === 'f') {
        const s = sMap.get(menuSessionId);
        if (s?.feedbackId) {
          const ownerPanel = panels.find((p) => p.sessionIds.includes(menuSessionId));
          if (ownerPanel) togglePanelCompanion(ownerPanel.id, menuSessionId, 'feedback');
        }
      } else if (key === 'i') {
        const s = sMap.get(menuSessionId);
        if (s?.url) {
          const ownerPanel = panels.find((p) => p.sessionIds.includes(menuSessionId));
          if (ownerPanel) togglePanelCompanion(ownerPanel.id, menuSessionId, 'iframe');
        }
      } else if (key === 'm') {
        const ownerPanel = panels.find((p) => p.sessionIds.includes(menuSessionId));
        if (ownerPanel) {
          const panelRight = ownerPanel.rightPaneTabs || [];
          const termActive = panelRight.includes(companionTabId(menuSessionId, 'terminal')) && ownerPanel.splitEnabled;
          if (termActive) {
            togglePanelCompanion(ownerPanel.id, menuSessionId, 'terminal');
          } else {
            termPickerOpen.value = { kind: 'companion', sessionId: menuSessionId, panelId: ownerPanel.id };
          }
        }
      } else if (key === 'escape') {
        // just close
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        popoutIdMenuOpen.value = null;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [popoutIdMenuOpen.value]);

  // Keyboard shortcuts for the window menu
  useEffect(() => {
    const menuPanelId = popoutWindowMenuOpen.value;
    if (!menuPanelId) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      let handled = true;
      const panel = panels.find((p) => p.id === menuPanelId);
      if (!panel) { popoutWindowMenuOpen.value = null; return; }
      const activeId = panel.activeSessionId || panel.sessionIds[0];
      if (key === 's' && activeId) {
        popBackIn(activeId);
      } else if (key === 'w') {
        toggleAlwaysOnTop(panel.id);
      } else if (key === 'a') {
        const isLeftDocked = panel.docked && panel.dockedSide === 'left';
        if (isLeftDocked) {
          updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
        } else {
          updatePanel(panel.id, { docked: true, dockedSide: 'left', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: panel.docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: panel.docked ? panel.dockedWidth : panel.floatingRect.w });
        }
        persistPopoutState();
        window.dispatchEvent(new Event('resize'));
      } else if (key === 'd') {
        const isRightDocked = panel.docked && panel.dockedSide !== 'left';
        if (isRightDocked) {
          updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
        } else {
          updatePanel(panel.id, { docked: true, dockedSide: 'right', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: panel.docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: panel.docked ? panel.dockedWidth : panel.floatingRect.w });
        }
        persistPopoutState();
        window.dispatchEvent(new Event('resize'));
      } else if (key === ' ' && !panel.docked) {
        updatePanel(panel.id, { minimized: !panel.minimized });
        persistPopoutState();
      } else if (key === 'm' && !panel.docked) {
        if (panel.maximized) {
          if (panel.preMaximizeRect) {
            updatePanel(panel.id, { maximized: false, floatingRect: panel.preMaximizeRect, preMaximizeRect: undefined });
          } else {
            updatePanel(panel.id, { maximized: false });
          }
        } else {
          updatePanel(panel.id, {
            maximized: true,
            minimized: false,
            preMaximizeRect: { ...panel.floatingRect },
            floatingRect: { x: 0, y: 40, w: window.innerWidth, h: window.innerHeight - 40 },
          });
        }
        persistPopoutState();
      } else if (key === 'escape') {
        // just close
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        popoutWindowMenuOpen.value = null;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [popoutWindowMenuOpen.value]);

  // Ctrl+Shift hotkey helper menu for the focused popout panel
  useEffect(() => {
    const held = ctrlShiftHeld.value;
    if (!held || !showHotkeyHints.value) {
      popoutHotkeyMenuOpen.value = null;
      return;
    }
    // Find the focused/active popout panel
    const focusedId = activePanelId.value;
    const panel = panels.find((p) => p.id === focusedId && p.visible);
    if (!panel) {
      popoutHotkeyMenuOpen.value = null;
      return;
    }
    const activeSessionId = panel.activeSessionId || panel.sessionIds[0];
    if (!activeSessionId) {
      popoutHotkeyMenuOpen.value = null;
      return;
    }

    function updatePos() {
      const panelEl = document.querySelector(`[data-panel-id="${panel!.id}"]`);
      const dot = panelEl?.querySelector('.popout-tab.active .status-dot, .popout-tab .status-dot') as HTMLElement | null;
      const scrollBox = panelEl?.querySelector('.popout-tab-scroll') as HTMLElement | null;
      if (!dot) {
        popoutHotkeyMenuOpen.value = null;
        return;
      }
      const dotRect = dot.getBoundingClientRect();
      if (scrollBox) {
        const scrollRect = scrollBox.getBoundingClientRect();
        if (dotRect.right < scrollRect.left || dotRect.left > scrollRect.right) {
          popoutHotkeyMenuOpen.value = null;
          return;
        }
      }
      const x = dotRect.left;
      const y = dotRect.bottom + 4;
      popoutHotkeyMenuOpen.value = { sessionId: activeSessionId!, panelId: panel!.id, x, y };
    }

    updatePos();
    const panelEl = document.querySelector(`[data-panel-id="${panel.id}"]`);
    const scrollEl = panelEl?.querySelector('.popout-tab-scroll');
    scrollEl?.addEventListener('scroll', updatePos, { passive: true });
    return () => scrollEl?.removeEventListener('scroll', updatePos);
  }, [ctrlShiftHeld.value, activePanelId.value]);

  if (panels.length === 0 && guides.length === 0) return null;

  return (
    <>
      {panels.map((p) => {
        if (p.id === COS_PANEL_ID) return null; // rendered by ChiefOfStaffBubble
        if (p.docked) {
          return (
            <span key={`g-${p.id}`}>
              <DockedPanelGrabHandle panel={p} />
              {p.visible && <PanelView key={p.id} panel={p} />}
            </span>
          );
        }
        if (!p.visible) return null;
        return <PanelView key={p.id} panel={p} />;
      })}
      <PopoutStatusMenu />
      <PopoutHotkeyMenu />
      {guides.map((g, i) => (
        <div
          key={`guide-${i}`}
          class="snap-guide"
          style={g.x !== undefined
            ? { left: g.x, top: 0, width: 1, height: '100vh' }
            : { left: 0, top: g.y, width: '100vw', height: 1 }
          }
        />
      ))}
    </>
  );
}
