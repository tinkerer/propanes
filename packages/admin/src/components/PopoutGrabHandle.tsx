import { useCallback, useEffect, useRef } from 'preact/hooks';
import {
  type PopoutPanelState,
  popoutPanels,
  updatePanel,
  persistPopoutState,
  getDockedPanelTop,
  allNumberedSessions,
  dockedOrientation,
  sidebarWidth,
  sidebarCollapsed,
  AUTOJUMP_PANEL_ID,
  getPanelZIndex,
  panelZOrders,
  autoJumpDismissed,
  handleBounceCounter,
} from '../lib/sessions.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { GRAB_HANDLE_H, handleGrabMove } from '../lib/popout-physics.js';
import { PanelTabBadge } from './PopoutPanelContent.js';

export function DockedPanelGrabHandle({ panel }: { panel: PopoutPanelState }) {
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
      handleGrabMove(ev, panel.id, grabStart.current, startW, startMx, isLeft, grabMoved);
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
          : <span class="grab-indicator">{'┃'}</span>
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
          : <span class="grab-indicator">{'┃'}</span>
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
        : <span class="grab-indicator">{'┃'}</span>
      }
    </div>
  );
}
