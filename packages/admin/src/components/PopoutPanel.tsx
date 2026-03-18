import { useRef, useCallback, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { copyText, copyWithTooltip } from '../lib/clipboard.js';
import { SessionViewToggle, type ViewMode } from './SessionViewToggle.js';
import { PopupMenu } from './PopupMenu.js';
import {
  type PopoutPanelState,
  type CompanionType,
  popoutPanels,
  allSessions,
  sessionMapComputed,
  exitedSessions,
  popBackIn,
  updatePanel,
  persistPopoutState,
  killSession,
  resumeSession,
  markSessionExited,
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
  setSessionInputState,
  sessionInputStates,
  getSessionLabel,
  setSessionLabel,
  getSessionColor,
  setSessionColor,
  SESSION_COLOR_PRESETS,
  getCompanions,
  togglePanelCompanion,
  panelLeftTabs,
  setPanelSplitRatio,
  disablePanelSplit,
  syncPanelCompanions,
  companionTabId,
  sidebarWidth,
  sidebarCollapsed,
  AUTOJUMP_PANEL_ID,
  popOutTab,
  resolveSession,
  bringToFront,
  getPanelZIndex,
  panelZOrders,
  toggleAlwaysOnTop,
  switchAutoJumpActiveSession,
  getTerminalCompanion,
  terminalCompanionMap,
  focusSessionTerminal,
  buildTmuxAttachCmd,
  openUrlCompanion,
  autoJumpDismissed,
  handleBounceCounter,
  reorderDockedPanel,
  termPickerOpen,
} from '../lib/sessions.js';
import { startTabDrag } from '../lib/tab-drag.js';
import { ctrlShiftHeld, stickyModeActive } from '../lib/shortcuts.js';
import { navigate, selectedAppId } from '../lib/state.js';
import { showHotkeyHints } from '../lib/settings.js';
import { api } from '../lib/api.js';
import { renderTabContent } from './PaneContent.js';
import { setFocusedLeaf } from '../lib/pane-tree.js';

export const popoutIdMenuOpen = signal<string | null>(null);
const popoutStatusMenuOpen = signal<{ sessionId: string; panelId: string; x: number; y: number } | null>(null);
const popoutHotkeyMenuOpen = signal<{ sessionId: string; panelId: string; x: number; y: number } | null>(null);
export const popoutWindowMenuOpen = signal<string | null>(null);
const renamingSessionId = signal<string | null>(null);
const renameValue = signal('');
const reorderDragOffset = signal<{ panelId: string; offsetY: number } | null>(null);
const companionMenuOpen = signal<string | null>(null);

const SNAP_THRESHOLD = 20;
const UNDOCK_THRESHOLD = 40;
const MIN_W = 300;
const MIN_H = 200;
const EDGE_SNAP = 8;
const CONTROL_BAR_BOTTOM = 40;
const GRAB_HANDLE_H = 48;

function snapPosition(x: number, y: number, w: number, h: number, selfId: string): { x: number; y: number; guides: { x?: number; y?: number }[] } {
  const guides: { x?: number; y?: number }[] = [];
  let sx = x, sy = y;

  const edges = { left: x, right: x + w, top: y, bottom: y + h };
  const targets: { left: number; right: number; top: number; bottom: number }[] = [
    { left: 0, right: 0, top: 0, bottom: 0 },
    { left: window.innerWidth, right: window.innerWidth, top: window.innerHeight, bottom: window.innerHeight },
    { left: 0, right: window.innerWidth, top: CONTROL_BAR_BOTTOM, bottom: CONTROL_BAR_BOTTOM },
  ];

  for (const p of popoutPanels.value) {
    if (p.id === selfId || p.docked || !p.visible) continue;
    const r = p.floatingRect;
    targets.push({ left: r.x, right: r.x + r.w, top: r.y, bottom: r.y + r.h });
  }

  for (const t of targets) {
    // left edge → target left/right
    if (Math.abs(edges.left - t.left) < EDGE_SNAP) { sx = t.left; guides.push({ x: t.left }); }
    if (Math.abs(edges.left - t.right) < EDGE_SNAP) { sx = t.right; guides.push({ x: t.right }); }
    // right edge → target left/right
    if (Math.abs(edges.right - t.left) < EDGE_SNAP) { sx = t.left - w; guides.push({ x: t.left }); }
    if (Math.abs(edges.right - t.right) < EDGE_SNAP) { sx = t.right - w; guides.push({ x: t.right }); }
    // top edge → target top/bottom
    if (Math.abs(edges.top - t.top) < EDGE_SNAP) { sy = t.top; guides.push({ y: t.top }); }
    if (Math.abs(edges.top - t.bottom) < EDGE_SNAP) { sy = t.bottom; guides.push({ y: t.bottom }); }
    // bottom edge → target top/bottom
    if (Math.abs(edges.bottom - t.top) < EDGE_SNAP) { sy = t.top - h; guides.push({ y: t.top }); }
    if (Math.abs(edges.bottom - t.bottom) < EDGE_SNAP) { sy = t.bottom - h; guides.push({ y: t.bottom }); }
  }

  return { x: sx, y: sy, guides };
}

function PanelTabBadge({ tabNum }: { tabNum: number }) {
  const pending = pendingFirstDigit.value;
  const digits = String(tabNum);
  if (pending !== null) {
    const pendingStr = String(pending);
    if (!digits.startsWith(pendingStr)) {
      return <span class="tab-number-badge tab-badge-dimmed">{tabNum}</span>;
    }
    return (
      <span class="tab-number-badge tab-badge-pending">
        <span class="tab-badge-green">{pendingStr}</span>
        {digits.slice(pendingStr.length) || ''}
      </span>
    );
  }
  return <span class="tab-number-badge">{tabNum}</span>;
}



function PanelView({ panel }: { panel: PopoutPanelState }) {
  const ids = panel.sessionIds;
  const activeId = panel.activeSessionId || ids[0];
  const sessionMap = sessionMapComputed.value;
  const session = sessionMap.get(activeId);
  const isExited = activeId ? exitedSessions.value.has(activeId) : false;
  const viewMode = activeId ? getViewMode(activeId, session?.permissionProfile) : 'terminal';
  const docked = panel.docked;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  const resizing = useRef<string | null>(null);
  const splitDragging = useRef(false);
  const prevActiveRef = useRef<string | null>(null);
  const startPos = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, dockedHeight: 0, dockedTopOffset: 0, dockedBaseTop: 0 });
  const idMenuBtnRef = useRef<HTMLSpanElement>(null);
  const idMenuBtnRef2 = useRef<HTMLSpanElement>(null);
  const windowMenuBtnRef = useRef<HTMLButtonElement>(null);
  const windowMenuBtnRef2 = useRef<HTMLButtonElement>(null);
  const companionMenuBtnRef = useRef<HTMLButtonElement>(null);

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
    if (!force && (e.target as HTMLElement).closest('button, select, a, .id-dropdown-wrapper, .session-status-dot')) return;
    e.preventDefault();
    dragging.current = true;
    dragMoved.current = false;
    wrapperRef.current?.classList.add('popout-dragging');
    const cp = popoutPanels.value.find((p) => p.id === panel.id);
    if (!cp) return;
    const fr = cp.floatingRect;
    startPos.current = { mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h, dockedHeight: cp.dockedHeight, dockedTopOffset: cp.dockedTopOffset || 0, dockedBaseTop: cp.docked ? (e.clientY - getDockedPanelTop(panel.id)) : 0 };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - startPos.current.mx;
      const dy = ev.clientY - startPos.current.my;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.current = true;
      const currentPanel = popoutPanels.value.find((p) => p.id === panel.id);
      if (!currentPanel) return;
      if (currentPanel.docked) {
        const isLeft = currentPanel.dockedSide === 'left';
        const undockThreshold = isLeft ? UNDOCK_THRESHOLD : -UNDOCK_THRESHOLD;
        if (isLeft ? dx > undockThreshold : dx < undockThreshold) {
          const w = currentPanel.dockedWidth;
          const h = typeof currentPanel.dockedHeight === 'number' ? currentPanel.dockedHeight : 500;
          updatePanel(panel.id, {
            docked: false,
            floatingRect: { x: ev.clientX - w / 2, y: ev.clientY - 16, w, h },
          });
          startPos.current = { ...startPos.current, mx: ev.clientX, my: ev.clientY, x: ev.clientX - w / 2, y: ev.clientY - 16, w, h, dockedHeight: h };

        } else {
          // Vertical drag: move panel up/down by adjusting dockedTopOffset
          updatePanel(panel.id, { dockedTopOffset: startPos.current.dockedTopOffset + dy });
        }
      } else {
        const rawX = Math.max(0, Math.min(startPos.current.x + dx, window.innerWidth - 100));
        const rawY = Math.max(0, Math.min(startPos.current.y + dy, window.innerHeight - 50));
        const fr = currentPanel.floatingRect;
        const snapped = snapPosition(rawX, rawY, fr.w, fr.h, panel.id);
        snapGuides.value = snapped.guides;
        updatePanel(panel.id, {
          floatingRect: { ...fr, x: snapped.x, y: snapped.y },
        });
        if (ev.clientX > window.innerWidth - SNAP_THRESHOLD) {
          updatePanel(panel.id, {
            docked: true,
            dockedSide: 'right',
            dockedHeight: currentPanel.floatingRect.h,
            dockedWidth: currentPanel.floatingRect.w,
            dockedTopOffset: 0,
          });
        } else if (ev.clientX < sidebarWidth.value + SNAP_THRESHOLD) {
          updatePanel(panel.id, {
            docked: true,
            dockedSide: 'left',
            dockedHeight: currentPanel.floatingRect.h,
            dockedWidth: currentPanel.floatingRect.w,
            dockedTopOffset: 0,
          });
        }
      }
    };
    const onUp = () => {
      dragging.current = false;
      wrapperRef.current?.classList.remove('popout-dragging');
      snapGuides.value = [];
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panel.id]);

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
      const dx = ev.clientX - startPos.current.mx;
      const dy = ev.clientY - startPos.current.my;
      const dir = resizing.current;
      const cp = popoutPanels.value.find((p) => p.id === panel.id);
      if (!cp) return;
      if (cp.docked) {
        let h = startPos.current.dockedHeight;
        let topOff = startPos.current.dockedTopOffset;
        if (dir.includes('n') || dir === 'top') {
          h = Math.max(MIN_H, startPos.current.dockedHeight - dy);
          const heightDelta = h - startPos.current.dockedHeight;
          topOff = startPos.current.dockedTopOffset - heightDelta;
          const minOffset = -startPos.current.dockedBaseTop;
          if (topOff < minOffset) {
            topOff = minOffset;
            h = startPos.current.dockedHeight + startPos.current.dockedTopOffset - topOff;
          }
        }
        if (dir.includes('s') || dir === 'bottom') h = Math.max(MIN_H, h + dy);
        let w = startDockedW;
        if (dir.includes('e') && cp.dockedSide === 'left') {
          w = Math.max(MIN_W, startDockedW + dx);
        } else if (dir.includes('w') || dir === 'left') {
          w = Math.max(MIN_W, startDockedW - dx);
        }
        const currentGrabY = cp.grabY ?? 0;
        const clampedGrabY = Math.max(0, Math.min(currentGrabY, h - GRAB_HANDLE_H));
        updatePanel(panel.id, { dockedHeight: h, dockedWidth: w, dockedTopOffset: topOff, grabY: clampedGrabY });
      } else {
        const s = startPos.current;
        let { x, y, w, h } = { x: s.x, y: s.y, w: s.w, h: s.h };
        if (dir.includes('e')) w = Math.max(MIN_W, s.w + dx);
        if (dir.includes('w')) { w = Math.max(MIN_W, s.w - dx); x = s.x + s.w - w; }
        if (dir.includes('s')) h = Math.max(MIN_H, s.h + dy);
        if (dir.includes('n')) { h = Math.max(MIN_H, s.h - dy); y = s.y + s.h - h; }
        updatePanel(panel.id, { floatingRect: { x, y, w, h } });
      }
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
      const ratio = (ev.clientX - containerRect.left) / containerRect.width;
      setPanelSplitRatio(panel.id, ratio);
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

  const globalSessions = allNumberedSessions();
  const inputSt = activeId ? (sessionInputStates.value.get(activeId) || null) : null;
  const tabsRef = useRef<HTMLDivElement>(null);

  function tabLabel(sid: string) {
    if (sid === 'view:page') return 'Page';
    if (sid === 'view:controlbar') return 'Control Bar';
    if (sid === 'view:sessions-list') return 'Sessions';
    if (sid === 'view:terminals') return 'Terminals';
    if (sid === 'view:files') return 'Files';
    if (sid === 'view:nav') return 'Nav';
    if (sid === 'view:feedback') return 'Feedback';
    if (sid === 'view:aggregate') return 'Aggregate';
    if (sid === 'view:sessions-page') return 'Sessions';
    if (sid === 'view:live') return 'Live';
    if (sid.startsWith('view:files:')) return 'Files';
    if (sid.startsWith('view:git:')) return 'Git Changes';
    if (sid.startsWith('view:')) return sid.slice(5);
    const isJsonl = sid.startsWith('jsonl:');
    const isFeedback = sid.startsWith('feedback:');
    const isIframe = sid.startsWith('iframe:');
    const isTerminal = sid.startsWith('terminal:');
    const isIsolate = sid.startsWith('isolate:');
    const isUrl = sid.startsWith('url:');
    const isFile = sid.startsWith('file:');
    const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile;
    const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
    const custom = getSessionLabel(sid);
    if (custom) return custom;
    const s = (isIsolate || isUrl || isFile) ? null : sessionMap.get(realSid);
    if (isJsonl) return `JSONL: ${s?.feedbackTitle || s?.agentName || realSid.slice(-6)}`;
    if (isFeedback) return `FB: ${s?.feedbackTitle || realSid.slice(-6)}`;
    if (isIframe) return `Page: ${realSid.slice(-6)}`;
    if (isTerminal) { const ts = getTerminalCompanion(realSid); if (ts === '__loading__') return 'Term: loading...'; const tSess = ts ? sessionMap.get(ts) : null; return `Term: ${tSess?.paneTitle || ts?.slice(-6) || realSid.slice(-6)}`; }
    if (isIsolate) return `Isolate: ${realSid}`;
    if (isUrl) { try { return `Iframe: ${new URL(realSid).hostname}`; } catch { return `Iframe: ${realSid.slice(0, 30)}`; } }
    if (isFile) { const parts = realSid.split('/'); return parts[parts.length - 1] || realSid.slice(-20); }
    const isPlainSess = s?.permissionProfile === 'plain';
    const plainLabel = s?.paneCommand
      ? `${s.paneCommand}:${s.panePath || ''} \u2014 ${s?.paneTitle || sid.slice(-6)}`
      : (s?.paneTitle || sid.slice(-6));
    return isPlainSess ? `\u{1F5A5}\uFE0F ${plainLabel}` : (s?.feedbackTitle || s?.agentName || `Session ${sid.slice(-6)}`);
  }

  function companionCopyId(sid: string): string | null {
    if (sid.startsWith('terminal:')) {
      const realSid = sid.slice(sid.indexOf(':') + 1);
      const ts = getTerminalCompanion(realSid);
      return ts && ts !== '__loading__' ? ts : null;
    }
    if (sid.startsWith('jsonl:') || sid.startsWith('feedback:') || sid.startsWith('iframe:')) {
      return sid.slice(sid.indexOf(':') + 1);
    }
    return null;
  }

  function globalNum(sid: string): number | null {
    const idx = globalSessions.indexOf(sid);
    return idx >= 0 ? idx + 1 : null;
  }

  const showBadges = ctrlShiftHeld.value;
  const activeGlobalNum = activeId ? globalNum(activeId) : null;
  const isPlain = session?.permissionProfile === 'plain';
  const appId = selectedAppId.value;
  const feedbackPath = session?.feedbackId
    ? appId ? `/app/${appId}/feedback/${session.feedbackId}` : `/feedback/${session.feedbackId}`
    : null;
  const showIdMenu = popoutIdMenuOpen.value === activeId;

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
      <div class="popout-tab-bar popout-singleton-bar" onMouseDown={onHeaderDragStart} onDblClick={() => {
        if (!docked) { updatePanel(panel.id, { minimized: !panel.minimized }); persistPopoutState(); }
      }}>
        {activeId && !activeId.startsWith('view:') && (
          <span
            class={`status-dot${isExited ? ' exited' : ''}${isPlain ? ' plain' : ''}${!isExited ? ` ${sessionInputStates.value.get(activeId) || ''}` : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              popoutStatusMenuOpen.value = { sessionId: activeId, panelId: panel.id, x: rect.left, y: rect.bottom + 4 };
            }}
          />
        )}
        {activeId && activeId.startsWith('view:') && (
          <span class="singleton-label" style="font-weight:600;font-size:12px;margin:0 8px;white-space:nowrap">{tabLabel(activeId)}</span>
        )}
        {activeId && !activeId.startsWith('view:') && (
          <>
            <span
              ref={idMenuBtnRef}
              class="tmux-id-label"
              onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = showIdMenu ? null : activeId; }}
            >
              pw-{activeId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
            </span>
            {showIdMenu && (
              <PopupMenu anchorRef={idMenuBtnRef} onClose={() => { popoutIdMenuOpen.value = null; }} className="id-dropdown-menu">
                <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = null; copyWithTooltip(activeId, e as any); }}>
                  Copy {activeId} <kbd>C</kbd>
                </button>
                <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = null; copyWithTooltip(buildTmuxAttachCmd(activeId, sessionMap.get(activeId)), e as any); }}>
                  Copy tmux command <kbd>T</kbd>
                </button>
                {session?.jsonlPath && (
                  <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = null; copyWithTooltip(session.jsonlPath, e as any); }}>
                    Copy JSONL path <kbd>J</kbd>
                  </button>
                )}
                {session?.jsonlPath && (() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const jsonlActive = panelRight.includes(companionTabId(activeId, 'jsonl')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; togglePanelCompanion(panel.id, activeId, 'jsonl'); }}>
                      {jsonlActive ? '\u2713 ' : ''}JSONL companion <kbd>L</kbd>
                    </button>
                  );
                })()}
                {session?.feedbackId && (() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const fbActive = panelRight.includes(companionTabId(activeId, 'feedback')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; togglePanelCompanion(panel.id, activeId, 'feedback'); }}>
                      {fbActive ? '\u2713 ' : ''}Feedback companion <kbd>F</kbd>
                    </button>
                  );
                })()}
                {session?.url && (() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const iframeActive = panelRight.includes(companionTabId(activeId, 'iframe')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; togglePanelCompanion(panel.id, activeId, 'iframe'); }}>
                      {iframeActive ? '\u2713 ' : ''}Page iframe <kbd>I</kbd>
                    </button>
                  );
                })()}
                {(() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const termActive = panelRight.includes(companionTabId(activeId, 'terminal')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={(e: any) => {
                      e.stopPropagation();
                      popoutIdMenuOpen.value = null;
                      if (termActive) {
                        togglePanelCompanion(panel.id, activeId, 'terminal');
                      } else {
                        termPickerOpen.value = { kind: 'companion', sessionId: activeId, panelId: panel.id };
                      }
                    }}>
                      {termActive ? '\u2713 ' : ''}Terminal companion <kbd>M</kbd>
                    </button>
                  );
                })()}
                {session?.isHarness && session?.harnessAppPort && (
                  <button class="popup-menu-item" onClick={() => {
                    const host = session.isRemote && session.launcherHostname ? session.launcherHostname : 'localhost';
                    openUrlCompanion(`http://${host}:${session.harnessAppPort}`);
                    popoutIdMenuOpen.value = null;
                  }}>
                    Open App <kbd>O</kbd>
                  </button>
                )}
                <div class="popup-menu-divider" />
                <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; popBackIn(activeId); }}>Pop back to tab bar <kbd>P</kbd></button>
                <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; window.open(`#/session/${activeId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no'); }}>Open in window <kbd>W</kbd></button>
                <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; window.open(`#/session/${activeId}`, '_blank'); }}>Open in browser tab <kbd>B</kbd></button>
                {!isExited && (
                  <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; api.openSessionInTerminal(activeId).catch(() => {}); }}>Open in Terminal.app <kbd>A</kbd></button>
                )}
              </PopupMenu>
            )}
          </>
        )}
        {feedbackPath && (
          <a
            href={`#${feedbackPath}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!dragMoved.current) navigate(feedbackPath); }}
            class="feedback-title-link"
            title={session?.feedbackTitle || 'View feedback'}
          >
            {session?.feedbackTitle || 'View feedback'}
          </a>
        )}
        <span style="flex:1" />
        <div class="popout-header-actions">
          {activeId && (session?.permissionProfile === 'auto' || session?.permissionProfile === 'yolo') && (
            <select
              class="view-mode-select"
              value={viewMode}
              onChange={(e) => setViewMode(activeId, (e.target as HTMLSelectElement).value as ViewMode)}
            >
              <option value="terminal">Term</option>
              <option value="structured">Struct</option>
              <option value="split">Split</option>
            </select>
          )}
          {activeId && session?.feedbackId && (
            <button class="btn-resolve" onClick={() => resolveSession(activeId, session.feedbackId)} title="Resolve">Resolve</button>
          )}
          {activeId && !activeId.startsWith('view:') && (isExited ? (
            <button onClick={() => resumeSession(activeId)} title="Resume">Resume</button>
          ) : (
            <button class="btn-kill" onClick={() => killSession(activeId)} title="Kill">Kill</button>
          ))}
        </div>
        <div class="popout-window-controls">
          <button
            ref={windowMenuBtnRef}
            class="btn-window-menu"
            onClick={(e) => { e.stopPropagation(); popoutWindowMenuOpen.value = popoutWindowMenuOpen.value === panel.id ? null : panel.id; }}
            title="Window options"
          >
            {'\u2261'}
          </button>
          {popoutWindowMenuOpen.value === panel.id && (
            <PopupMenu anchorRef={windowMenuBtnRef} onClose={() => { popoutWindowMenuOpen.value = null; }} className="window-menu" align="right">
              {activeId && (
                <button class="popup-menu-item" onClick={() => { popoutWindowMenuOpen.value = null; popBackIn(activeId); }}>
                  {'\u2B05'} Pop in <kbd>S</kbd>
                </button>
              )}
              <button class="popup-menu-item" onClick={() => { popoutWindowMenuOpen.value = null; toggleAlwaysOnTop(panel.id); }}>
                {panel.alwaysOnTop ? '\u2713 ' : ''}{'\u{1F4CC}'} Pin on top <kbd>W</kbd>
              </button>
              {!docked && (
                <button class="popup-menu-item" onClick={() => { popoutWindowMenuOpen.value = null; updatePanel(panel.id, { minimized: !panel.minimized }); persistPopoutState(); }}>
                  {isMinimized ? '\u25A1 Restore' : '\u2212 Minimize'} <kbd>Space</kbd>
                </button>
              )}
              {!docked && (
                <button class="popup-menu-item" onClick={() => {
                  popoutWindowMenuOpen.value = null;
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
                }}>
                  {panel.maximized ? '\u25A3 Restore size' : '\u25A1 Maximize'} <kbd>M</kbd>
                </button>
              )}
              <div class="window-menu-separator" />
              <div class="window-menu-dock-row">
                <button
                  class={isLeftDocked ? 'dock-active' : ''}
                  onClick={() => {
                    popoutWindowMenuOpen.value = null;
                    if (isLeftDocked) {
                      updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
                    } else {
                      updatePanel(panel.id, { docked: true, dockedSide: 'left', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: docked ? panel.dockedWidth : panel.floatingRect.w });
                    }
                    persistPopoutState();
                    window.dispatchEvent(new Event('resize'));
                  }}
                >
                  {'\u25C0'} Left <kbd>A</kbd>
                </button>
                <button
                  class={docked && !isLeftDocked ? 'dock-active' : ''}
                  onClick={() => {
                    popoutWindowMenuOpen.value = null;
                    if (docked && !isLeftDocked) {
                      updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
                    } else {
                      updatePanel(panel.id, { docked: true, dockedSide: 'right', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: docked ? panel.dockedWidth : panel.floatingRect.w });
                    }
                    persistPopoutState();
                    window.dispatchEvent(new Event('resize'));
                  }}
                >
                  Right {'\u25B6'} <kbd>D</kbd>
                </button>
              </div>
            </PopupMenu>
          )}
          <button class="btn-close-panel" onClick={() => { updatePanel(panel.id, { visible: false }); persistPopoutState(); }} title="Hide panel">&times;</button>
        </div>
      </div>
      ) : (
      <>
      <div class="popout-tab-bar" onMouseDown={onHeaderDragStart} onDblClick={() => {
        if (!docked) {
          updatePanel(panel.id, { minimized: !panel.minimized });
          persistPopoutState();
        }
      }}>
        <div ref={tabsRef} class="popout-tab-scroll" onWheel={(e: WheelEvent) => { const delta = (e as any).deltaX || (e as any).deltaY; if (delta) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += delta; } }}>
          {ids.map((sid) => {
            const gn = globalNum(sid);
            const tabSess = sessionMap.get(sid);
            const tabExited = exitedSessions.value.has(sid);
            const tabIsCompanion = sid.startsWith('jsonl:') || sid.startsWith('feedback:') || sid.startsWith('iframe:') || sid.startsWith('terminal:');
            const tabInputState = !tabExited && !tabIsCompanion ? (sessionInputStates.value.get(sid) || null) : null;
            const tabIsPlain = tabSess?.permissionProfile === 'plain';
            const isActiveTab = sid === activeId;
            return (
              <button
                key={sid}
                class={`popout-tab ${isActiveTab ? 'active' : ''}`}
                style={getSessionColor(sid) ? { boxShadow: `inset 0 -2px 0 ${getSessionColor(sid)}` } : undefined}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  startTabDrag(e, {
                    sessionId: sid,
                    source: { panelId: panel.id },
                    label: tabLabel(sid),
                    onClickFallback: () => {
                      if (!switchAutoJumpActiveSession(panel.id, sid)) {
                        updatePanel(panel.id, { activeSessionId: sid });
                        persistPopoutState();
                      }
                    },
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !renamingSessionId.value) {
                    e.preventDefault();
                    if (!switchAutoJumpActiveSession(panel.id, sid)) {
                      updatePanel(panel.id, { activeSessionId: sid });
                      persistPopoutState();
                    }
                  }
                }}
                title={tabSess?.feedbackTitle || sid}
                onDblClick={(e) => {
                  e.stopPropagation();
                  renameValue.value = getSessionLabel(sid) || '';
                  renamingSessionId.value = sid;
                }}
              >
                {!tabIsCompanion && <span
                  class={`status-dot${tabExited ? ' exited' : ''}${tabIsPlain ? ' plain' : ''}${tabInputState ? ` ${tabInputState}` : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    popoutStatusMenuOpen.value = { sessionId: sid, panelId: panel.id, x: rect.left, y: rect.bottom + 4 };
                  }}
                >
                  {ctrlShiftHeld.value && gn !== null && <PanelTabBadge tabNum={gn} />}
                </span>}
                {renamingSessionId.value === sid ? (
                  <input
                    type="text"
                    value={renameValue.value}
                    onInput={(e) => { renameValue.value = (e.target as HTMLInputElement).value; }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { setSessionLabel(sid, renameValue.value); renamingSessionId.value = null; }
                      if (e.key === 'Escape') { renamingSessionId.value = null; }
                    }}
                    onBlur={() => { setSessionLabel(sid, renameValue.value); renamingSessionId.value = null; }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    style="font-size:11px;padding:1px 4px;border:1px solid var(--pw-accent);border-radius:3px;background:var(--pw-input-bg);color:var(--pw-primary-text);width:120px;outline:none"
                    ref={(el) => el?.focus()}
                  />
                ) : (
                  <span class="popout-tab-label">{tabLabel(sid)}</span>
                )}
                <span class="popout-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(sid); }}>&times;</span>
              </button>
            );
          })}
        </div>
      </div>
      <div class="popout-header" onMouseDown={onHeaderDragStart} onDblClick={() => {
        if (!docked) {
          updatePanel(panel.id, { minimized: !panel.minimized });
          persistPopoutState();
        }
      }}>
        {activeId && (
          <>
            <span
              ref={idMenuBtnRef2}
              class="tmux-id-label"
              onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = showIdMenu ? null : activeId; }}
            >
              pw-{activeId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
            </span>
            {showIdMenu && (
              <PopupMenu anchorRef={idMenuBtnRef2} onClose={() => { popoutIdMenuOpen.value = null; }} className="id-dropdown-menu">
                <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = null; copyWithTooltip(activeId, e as any); }}>
                  Copy {activeId} <kbd>C</kbd>
                </button>
                <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = null; copyWithTooltip(buildTmuxAttachCmd(activeId, sessionMap.get(activeId)), e as any); }}>
                  Copy tmux command <kbd>T</kbd>
                </button>
                {session?.jsonlPath && (
                  <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = null; copyWithTooltip(session.jsonlPath, e as any); }}>
                    Copy JSONL path <kbd>J</kbd>
                  </button>
                )}
                {session?.jsonlPath && (() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const jsonlActive = panelRight.includes(companionTabId(activeId, 'jsonl')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; togglePanelCompanion(panel.id, activeId, 'jsonl'); }}>
                      {jsonlActive ? '\u2713 ' : ''}JSONL companion <kbd>L</kbd>
                    </button>
                  );
                })()}
                {session?.feedbackId && (() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const fbActive = panelRight.includes(companionTabId(activeId, 'feedback')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; togglePanelCompanion(panel.id, activeId, 'feedback'); }}>
                      {fbActive ? '\u2713 ' : ''}Feedback companion <kbd>F</kbd>
                    </button>
                  );
                })()}
                {session?.url && (() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const iframeActive = panelRight.includes(companionTabId(activeId, 'iframe')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; togglePanelCompanion(panel.id, activeId, 'iframe'); }}>
                      {iframeActive ? '\u2713 ' : ''}Page iframe <kbd>I</kbd>
                    </button>
                  );
                })()}
                {(() => {
                  const panelRight = panel.rightPaneTabs || [];
                  const termActive = panelRight.includes(companionTabId(activeId, 'terminal')) && panel.splitEnabled;
                  return (
                    <button class="popup-menu-item" onClick={(e: any) => {
                      e.stopPropagation();
                      popoutIdMenuOpen.value = null;
                      if (termActive) {
                        togglePanelCompanion(panel.id, activeId, 'terminal');
                      } else {
                        termPickerOpen.value = { kind: 'companion', sessionId: activeId, panelId: panel.id };
                      }
                    }}>
                      {termActive ? '\u2713 ' : ''}Terminal companion <kbd>M</kbd>
                    </button>
                  );
                })()}
                {session?.isHarness && session?.harnessAppPort && (
                  <button class="popup-menu-item" onClick={() => {
                    const host = session.isRemote && session.launcherHostname ? session.launcherHostname : 'localhost';
                    openUrlCompanion(`http://${host}:${session.harnessAppPort}`);
                    popoutIdMenuOpen.value = null;
                  }}>
                    Open App <kbd>O</kbd>
                  </button>
                )}
                <div class="popup-menu-divider" />
                <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; popBackIn(activeId); }}>Pop back to tab bar <kbd>P</kbd></button>
                <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; window.open(`#/session/${activeId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no'); }}>Open in window <kbd>W</kbd></button>
                <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; window.open(`#/session/${activeId}`, '_blank'); }}>Open in browser tab <kbd>B</kbd></button>
                {!isExited && (
                  <button class="popup-menu-item" onClick={() => { popoutIdMenuOpen.value = null; api.openSessionInTerminal(activeId).catch(() => {}); }}>Open in Terminal.app <kbd>A</kbd></button>
                )}
              </PopupMenu>
            )}
          </>
        )}
        {feedbackPath && (
          <a
            href={`#${feedbackPath}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!dragMoved.current) navigate(feedbackPath); }}
            class="feedback-title-link"
            title={session?.feedbackTitle || 'View feedback'}
          >
            {session?.feedbackTitle || 'View feedback'}
          </a>
        )}
        <span style="flex:1" />
        <div class="popout-header-actions">
          {activeId && (session?.permissionProfile === 'auto' || session?.permissionProfile === 'yolo') && (
            <select
              class="view-mode-select"
              value={viewMode}
              onChange={(e) => setViewMode(activeId, (e.target as HTMLSelectElement).value as ViewMode)}
            >
              <option value="terminal">Term</option>
              <option value="structured">Struct</option>
              <option value="split">Split</option>
            </select>
          )}
          {activeId && session?.feedbackId && (
            <button class="btn-resolve" onClick={() => resolveSession(activeId, session.feedbackId)} title="Resolve">Resolve</button>
          )}
          {activeId && !activeId.startsWith('view:') && (isExited ? (
            <button onClick={() => resumeSession(activeId)} title="Resume">Resume</button>
          ) : (
            <button class="btn-kill" onClick={() => killSession(activeId)} title="Kill">Kill</button>
          ))}
        </div>
        <div class="popout-window-controls">
          <button
            ref={windowMenuBtnRef2}
            class="btn-window-menu"
            onClick={(e) => { e.stopPropagation(); popoutWindowMenuOpen.value = popoutWindowMenuOpen.value === panel.id ? null : panel.id; }}
            title="Window options"
          >
            {'\u2261'}
          </button>
          {popoutWindowMenuOpen.value === panel.id && (
            <PopupMenu anchorRef={windowMenuBtnRef2} onClose={() => { popoutWindowMenuOpen.value = null; }} className="window-menu" align="right">
              {activeId && (
                <button class="popup-menu-item" onClick={() => { popoutWindowMenuOpen.value = null; popBackIn(activeId); }}>
                  {'\u2B05'} Pop in <kbd>S</kbd>
                </button>
              )}
              <button class="popup-menu-item" onClick={() => { popoutWindowMenuOpen.value = null; toggleAlwaysOnTop(panel.id); }}>
                {panel.alwaysOnTop ? '\u2713 ' : ''}{'\u{1F4CC}'} Pin on top <kbd>W</kbd>
              </button>
              {!docked && (
                <button class="popup-menu-item" onClick={() => { popoutWindowMenuOpen.value = null; updatePanel(panel.id, { minimized: !panel.minimized }); persistPopoutState(); }}>
                  {isMinimized ? '\u25A1 Restore' : '\u2212 Minimize'} <kbd>Space</kbd>
                </button>
              )}
              {!docked && (
                <button class="popup-menu-item" onClick={() => {
                  popoutWindowMenuOpen.value = null;
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
                }}>
                  {panel.maximized ? '\u25A3 Restore size' : '\u25A1 Maximize'} <kbd>M</kbd>
                </button>
              )}
              <div class="window-menu-separator" />
              <div class="window-menu-dock-row">
                <button
                  class={isLeftDocked ? 'dock-active' : ''}
                  onClick={() => {
                    popoutWindowMenuOpen.value = null;
                    if (isLeftDocked) {
                      updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
                    } else {
                      updatePanel(panel.id, { docked: true, dockedSide: 'left', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: docked ? panel.dockedWidth : panel.floatingRect.w });
                    }
                    persistPopoutState();
                    window.dispatchEvent(new Event('resize'));
                  }}
                >
                  {'\u25C0'} Left <kbd>A</kbd>
                </button>
                <button
                  class={docked && !isLeftDocked ? 'dock-active' : ''}
                  onClick={() => {
                    popoutWindowMenuOpen.value = null;
                    if (docked && !isLeftDocked) {
                      updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
                    } else {
                      updatePanel(panel.id, { docked: true, dockedSide: 'right', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: docked ? panel.dockedWidth : panel.floatingRect.w });
                    }
                    persistPopoutState();
                    window.dispatchEvent(new Event('resize'));
                  }}
                >
                  Right {'\u25B6'} <kbd>D</kbd>
                </button>
              </div>
            </PopupMenu>
          )}
          <button class="btn-close-panel" onClick={() => { updatePanel(panel.id, { visible: false }); persistPopoutState(); }} title="Hide panel">&times;</button>
        </div>
      </div>
      </>
      )}
      {!isMinimized && !isSplit && (
        <div class="popout-body">
          {activeId && renderTabContent(activeId, true, sessionMap)}
        </div>
      )}
      {!isMinimized && isSplit && (
        <div class="popout-split-container">
          <div
            class="popout-split-pane"
            data-popout-split-pane={`${panel.id}:left`}
            style={{ flex: panel.splitRatio ?? 0.5 }}
          >
            {hasTabs && leftTabs.length > 1 && (
              <div class="split-pane-tab-bar">
                <div class="popout-tab-scroll">
                  {leftTabs.map((sid) => (
                    <button
                      key={sid}
                      class={`popout-tab ${sid === activeId ? 'active' : ''}`}
                      style={getSessionColor(sid) ? { boxShadow: `inset 0 -2px 0 ${getSessionColor(sid)}` } : undefined}
                      onClick={() => {
                        if (!switchAutoJumpActiveSession(panel.id, sid)) {
                          updatePanel(panel.id, { activeSessionId: sid });
                          persistPopoutState();
                        }
                      }}
                    >
                      <span class="popout-tab-label">{tabLabel(sid)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div class="popout-body">
              {leftTabs.map((sid) => renderTabContent(sid, sid === activeId, sessionMap))}
            </div>
          </div>
          <div class="popout-split-divider" onMouseDown={onSplitDividerMouseDown} />
          <div
            class="popout-split-pane"
            data-popout-split-pane={`${panel.id}:right`}
            style={{ flex: 1 - (panel.splitRatio ?? 0.5) }}
          >
            {(() => {
              const activeSid = panelRightActive || panelRightTabs[0];
              const activeTermId = activeSid ? companionCopyId(activeSid) : null;
              const showCompMenu = companionMenuOpen.value === activeSid;
              const termSess = activeTermId ? sessionMap.get(activeTermId) : null;
              return (
                <div class="split-pane-tab-bar">
                  <div class="popout-tab-scroll">
                    {panelRightTabs.map((sid) => {
                      const isActive = sid === activeSid;
                      const hasCopyId = !!companionCopyId(sid);
                      return (
                        <button
                          key={sid}
                          ref={isActive && hasCopyId ? companionMenuBtnRef : undefined}
                          class={`popout-tab ${isActive ? 'active' : ''}`}
                          onClick={() => {
                            if (isActive && hasCopyId) {
                              companionMenuOpen.value = showCompMenu ? null : sid;
                            } else {
                              companionMenuOpen.value = null;
                              updatePanel(panel.id, { rightPaneActiveId: sid });
                              persistPopoutState();
                            }
                          }}
                        >
                          <span class="popout-tab-label">{tabLabel(sid)}{hasCopyId && isActive ? ` ${'\u25BE'}` : ''}</span>
                        </button>
                      );
                    })}
                  </div>
                  {showCompMenu && activeTermId && (
                    <PopupMenu anchorRef={companionMenuBtnRef} onClose={() => { companionMenuOpen.value = null; }} className="companion-dropdown">
                      <button class="popup-menu-item" onClick={(e: any) => { e.stopPropagation(); companionMenuOpen.value = null; copyWithTooltip(activeTermId, e); }}>
                        Copy ID: {activeTermId.slice(-8)}
                      </button>
                      <button class="popup-menu-item" onClick={(e: any) => { e.stopPropagation(); companionMenuOpen.value = null; copyWithTooltip(buildTmuxAttachCmd(activeTermId, termSess), e); }}>
                        Copy tmux command
                      </button>
                      <button class="popup-menu-item" onClick={() => { companionMenuOpen.value = null; api.openSessionInTerminal(activeTermId).catch(() => {}); }}>
                        Open in Terminal.app
                      </button>
                    </PopupMenu>
                  )}
                  <button
                    class="split-pane-unsplit-btn"
                    onClick={() => disablePanelSplit(panel.id)}
                    title="Close split pane"
                  >
                    &times;
                  </button>
                </div>
              );
            })()}
            <div class="popout-body">
              {panelRightTabs.map((sid) => renderTabContent(sid, sid === panelRightActive, sessionMap))}
            </div>
          </div>
        </div>
      )}
      {!isMinimized && (docked ? (
        <>
          <div class="popout-resize-n" onMouseDown={(e) => onResizeStart('n', e)} />
          <div class="popout-resize-s" onMouseDown={(e) => onResizeStart('s', e)} />
          {isLeftDocked ? (
            <>
              <div class="popout-resize-e" onMouseDown={(e) => onResizeStart('e', e)} />
              <div class="popout-resize-ne" onMouseDown={(e) => onResizeStart('ne', e)} />
              <div class="popout-resize-se" onMouseDown={(e) => onResizeStart('se', e)} />
            </>
          ) : (
            <>
              <div class="popout-resize-w" onMouseDown={(e) => onResizeStart('w', e)} />
              <div class="popout-resize-nw" onMouseDown={(e) => onResizeStart('nw', e)} />
              <div class="popout-resize-sw" onMouseDown={(e) => onResizeStart('sw', e)} />
            </>
          )}
        </>
      ) : (
        <>
          <div class="popout-resize-n" onMouseDown={(e) => onResizeStart('n', e)} />
          <div class="popout-resize-s" onMouseDown={(e) => onResizeStart('s', e)} />
          <div class="popout-resize-e" onMouseDown={(e) => onResizeStart('e', e)} />
          <div class="popout-resize-w" onMouseDown={(e) => onResizeStart('w', e)} />
          <div class="popout-resize-ne" onMouseDown={(e) => onResizeStart('ne', e)} />
          <div class="popout-resize-nw" onMouseDown={(e) => onResizeStart('nw', e)} />
          <div class="popout-resize-se" onMouseDown={(e) => onResizeStart('se', e)} />
          <div class="popout-resize-sw" onMouseDown={(e) => onResizeStart('sw', e)} />
        </>
      ))}
    </div>
    </>
  );
}

function DockedPanelGrabHandle({ panel }: { panel: PopoutPanelState }) {
  const grabStart = useRef({ mx: 0, my: 0, grabY: 0, time: 0 });
  const grabMoved = useRef(false);
  const grabRef = useRef<HTMLDivElement>(null);
  const lastBounce = useRef(0);
  const orientation = dockedOrientation.value;

  // Watch for bounce triggers on the autojump panel handle
  const bounceCount = handleBounceCounter.value;
  useEffect(() => {
    if (panel.id !== AUTOJUMP_PANEL_ID || bounceCount === 0) return;
    if (bounceCount === lastBounce.current) return;
    lastBounce.current = bounceCount;
    const el = grabRef.current;
    if (!el) return;
    el.classList.remove('grab-bounce');
    void el.offsetWidth; // force reflow
    el.classList.add('grab-bounce');
    const onEnd = () => el.classList.remove('grab-bounce');
    el.addEventListener('animationend', onEnd, { once: true });
  }, [bounceCount, panel.id]);

  const isLeft = panel.dockedSide === 'left';

  const onGrabMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const currentGrabY = panel.grabY ?? 0;
    grabStart.current = { mx: e.clientX, my: e.clientY, grabY: currentGrabY, time: Date.now() };
    grabMoved.current = false;
    const startW = panel.dockedWidth;
    const startMx = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const dx = Math.abs(ev.clientX - grabStart.current.mx);
      const dy = Math.abs(ev.clientY - grabStart.current.my);
      if (dx > 3 || dy > 3) {
        grabMoved.current = true;
      }
      // Horizontal drag = resize width
      if (dx > 3) {
        const delta = ev.clientX - startMx;
        updatePanel(panel.id, { dockedWidth: Math.max(MIN_W, isLeft ? startW + delta : startW - delta) });
      }
      // Vertical drag = move grab handle, resize panel if beyond bounds
      if (dy > 3) {
        const dyMove = ev.clientY - grabStart.current.my;
        let newGrabY = grabStart.current.grabY + dyMove;
        const cp = popoutPanels.value.find((p) => p.id === panel.id);
        if (cp?.visible) {
          const panelH = cp.dockedHeight;
          const topOff = cp.dockedTopOffset || 0;
          const baseTop = getDockedPanelTop(panel.id) - topOff;
          const maxGrabY = panelH - GRAB_HANDLE_H;
          if (newGrabY < 0) {
            // Dragging above top: grow panel upward
            const overflow = -newGrabY;
            const newTopOff = topOff - overflow;
            const minTopOff = -(baseTop - 40);
            const clampedTopOff = Math.max(minTopOff, newTopOff);
            const actualGrow = topOff - clampedTopOff;
            updatePanel(panel.id, {
              grabY: 0,
              dockedHeight: panelH + actualGrow,
              dockedTopOffset: clampedTopOff,
            });
          } else if (newGrabY > maxGrabY) {
            // Dragging below bottom: grow panel downward
            const overflow = newGrabY - maxGrabY;
            const maxH = window.innerHeight - (baseTop + topOff);
            const newH = Math.min(maxH, panelH + overflow);
            updatePanel(panel.id, {
              grabY: newH - GRAB_HANDLE_H,
              dockedHeight: newH,
            });
          } else {
            updatePanel(panel.id, { grabY: newGrabY });
          }
        } else {
          const minY = 40;
          const maxY = window.innerHeight - GRAB_HANDLE_H;
          const baseTop = getDockedPanelTop(panel.id);
          newGrabY = Math.max(minY - baseTop, Math.min(newGrabY, maxY - baseTop));
          updatePanel(panel.id, { grabY: newGrabY });
        }
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!grabMoved.current && Date.now() - grabStart.current.time < 200) {
        const nowVisible = !panel.visible;
        updatePanel(panel.id, { visible: nowVisible });
        if (panel.id === AUTOJUMP_PANEL_ID) {
          autoJumpDismissed.value = !nowVisible;
        }
      }
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panel.id, panel.visible, panel.dockedWidth, panel.grabY]);

  const showBadge = ctrlShiftHeld.value;
  const globalSessions = allNumberedSessions();
  const activeId = panel.activeSessionId || panel.sessionIds[0];
  const globalIdx = globalSessions.indexOf(activeId);
  const rawGrabY = panel.grabY ?? 0;
  const grabY = panel.visible ? Math.max(0, Math.min(rawGrabY, panel.dockedHeight - GRAB_HANDLE_H)) : rawGrabY;
  const _zOrders = panelZOrders.value;  // subscribe to signal
  const grabZIndex = getPanelZIndex(panel) + 1;

  if (isLeft) {
    const leftPos = sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3) + (panel.visible ? panel.dockedWidth : 0);
    const panelTop = getDockedPanelTop(panel.id);
    return (
      <div
        ref={grabRef}
        class="popout-grab-tab popout-grab-tab-left"
        style={{
          left: leftPos,
          right: 'auto',
          top: panelTop + grabY,
          height: GRAB_HANDLE_H,
          zIndex: grabZIndex,
        }}
        onMouseDown={onGrabMouseDown}
        title="Drag to resize/reposition, click to toggle"
      >
        {showBadge && globalIdx >= 0
          ? <PanelTabBadge tabNum={globalIdx + 1} />
          : <span class="grab-indicator">{'\u2503'}</span>
        }
      </div>
    );
  }

  if (orientation === 'horizontal') {
    const dockedPanels = popoutPanels.value.filter((p) => p.docked && p.dockedSide !== 'left');
    const idx = dockedPanels.findIndex((p) => p.id === panel.id);
    const count = dockedPanels.filter((p) => p.visible).length || 1;
    const topStart = 40;
    const availH = window.innerHeight - topStart;
    const perPanel = availH / count;
    const visibleIdx = dockedPanels.filter((p) => p.visible).findIndex((p) => p.id === panel.id);
    const panelTopH = topStart + (visibleIdx >= 0 ? visibleIdx : idx) * perPanel;
    const rightPos = panel.visible ? panel.dockedWidth : 0;

    return (
      <div
        ref={grabRef}
        class="popout-grab-tab popout-grab-tab-horiz"
        style={{
          right: rightPos,
          top: panelTopH + grabY,
          height: GRAB_HANDLE_H,
          zIndex: grabZIndex,
        }}
        onMouseDown={onGrabMouseDown}
        title="Drag to resize/reposition, click to toggle"
      >
        {showBadge && globalIdx >= 0
          ? <PanelTabBadge tabNum={globalIdx + 1} />
          : <span class="grab-indicator">{'\u2503'}</span>
        }
      </div>
    );
  }

  const panelTop = getDockedPanelTop(panel.id);
  const rightPos = panel.visible ? panel.dockedWidth : 0;

  return (
    <div
      ref={grabRef}
      class="popout-grab-tab"
      style={{
        right: rightPos,
        top: panelTop + grabY,
        height: GRAB_HANDLE_H,
        zIndex: grabZIndex,
      }}
      onMouseDown={onGrabMouseDown}
      title="Drag to resize/reposition, click to toggle"
    >
      {showBadge && globalIdx >= 0
        ? <PanelTabBadge tabNum={globalIdx + 1} />
        : <span class="grab-indicator">{'\u2503'}</span>
      }
    </div>
  );
}

export function PopoutPanel() {
  const panels = popoutPanels.value;
  const guides = snapGuides.value;
  const statusMenu = popoutStatusMenuOpen.value;
  const hotkeyMenu = popoutHotkeyMenuOpen.value;
  const sessions = allSessions.value;  // needed for find() calls below
  const exited = exitedSessions.value;

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

  useEffect(() => {
    if (!popoutWindowMenuOpen.value) return;
    const close = () => { popoutWindowMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [popoutWindowMenuOpen.value]);

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
      } else if (key === 't') {
        copyText(buildTmuxAttachCmd(menuSessionId, sMap.get(menuSessionId)));
      } else if (key === 'p') {
        popBackIn(menuSessionId);
      } else if (key === 'w') {
        window.open(`#/session/${menuSessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
      } else if (key === 'b') {
        window.open(`#/session/${menuSessionId}`, '_blank');
      } else if (key === 'a' && !exited.has(menuSessionId)) {
        api.openSessionInTerminal(menuSessionId);
      } else if (key === 'j') {
        const s = sMap.get(menuSessionId);
        if (s?.jsonlPath) copyText(s.jsonlPath);
      } else if (key === 'l') {
        const s = sMap.get(menuSessionId);
        if (s?.jsonlPath) {
          const ownerPanel = panels.find((p) => p.sessionIds.includes(menuSessionId));
          if (ownerPanel) togglePanelCompanion(ownerPanel.id, menuSessionId, 'jsonl');
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
      {statusMenu && (() => {
        const menuSid = statusMenu.sessionId;
        const menuSess = sessions.find((s: any) => s.id === menuSid);
        const menuExited = exited.has(menuSid);
        return (
          <div
            class="status-dot-menu"
            style={{ left: `${statusMenu.x}px`, top: `${statusMenu.y}px`, zIndex: 1100 }}
            onClick={(e) => e.stopPropagation()}
          >
            {!menuExited && (
              <button onClick={() => { popoutStatusMenuOpen.value = null; killSession(menuSid); }}>
                Kill {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}K</kbd>}
              </button>
            )}
            {menuSess?.feedbackId && (
              <button onClick={() => { popoutStatusMenuOpen.value = null; resolveSession(menuSid, menuSess.feedbackId); }}>
                Resolve {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}R</kbd>}
              </button>
            )}
            {!menuExited && (
              <button onClick={() => { popoutStatusMenuOpen.value = null; popBackIn(menuSid); }}>
                Pop back in
              </button>
            )}
            {menuExited && (
              <button onClick={() => { popoutStatusMenuOpen.value = null; resumeSession(menuSid); }}>Resume</button>
            )}
            <button onClick={() => {
              popoutStatusMenuOpen.value = null;
              renameValue.value = getSessionLabel(menuSid) || '';
              renamingSessionId.value = menuSid;
            }}>
              Rename
            </button>
            {getSessionLabel(menuSid) && (
              <button onClick={() => { popoutStatusMenuOpen.value = null; setSessionLabel(menuSid, ''); }}>
                Clear name
              </button>
            )}
            <button onClick={() => { popoutStatusMenuOpen.value = null; closeTab(menuSid); }}>
              Close tab {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}W</kbd>}
            </button>
            <div style="display:flex;gap:4px;padding:4px 8px;align-items:center">
              {SESSION_COLOR_PRESETS.map((c) => (
                <span
                  key={c}
                  onClick={() => { setSessionColor(menuSid, getSessionColor(menuSid) === c ? '' : c); }}
                  style={{
                    width: '14px', height: '14px', borderRadius: '50%', background: c, cursor: 'pointer',
                    border: getSessionColor(menuSid) === c ? '2px solid #fff' : '2px solid transparent',
                    boxSizing: 'border-box',
                  }}
                />
              ))}
              {getSessionColor(menuSid) && (
                <span
                  onClick={() => setSessionColor(menuSid, '')}
                  style={{ cursor: 'pointer', fontSize: '12px', opacity: 0.7, marginLeft: '2px' }}
                  title="Clear color"
                >{'\u00D7'}</span>
              )}
            </div>
          </div>
        );
      })()}
      {hotkeyMenu && !statusMenu && (() => {
        const hkSid = hotkeyMenu.sessionId;
        const hkSess = sessions.find((s: any) => s.id === hkSid);
        const hkExited = exited.has(hkSid);
        return (
          <div
            class="status-dot-menu"
            style={{ left: `${hotkeyMenu.x}px`, top: `${hotkeyMenu.y}px`, zIndex: 1100 }}
            onClick={(e) => e.stopPropagation()}
          >
            {!hkExited && (
              <button onClick={() => killSession(hkSid)}>
                Kill <kbd>K</kbd>
              </button>
            )}
            {hkSess?.feedbackId && (
              <button onClick={() => resolveSession(hkSid, hkSess.feedbackId)}>
                Resolve <kbd>R</kbd>
              </button>
            )}
            <button onClick={() => { popoutIdMenuOpen.value = popoutIdMenuOpen.value ? null : hkSid; }}>
              Session menu <kbd>P</kbd>
            </button>
            <button onClick={() => { popoutWindowMenuOpen.value = popoutWindowMenuOpen.value ? null : hotkeyMenu.panelId; }}>
              Window menu <kbd>E</kbd>
            </button>
            {hkExited && (
              <button onClick={() => resumeSession(hkSid)}>Resume</button>
            )}
            <button onClick={() => closeTab(hkSid)}>
              Close tab <kbd>W</kbd>
            </button>
          </div>
        );
      })()}
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
