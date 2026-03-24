import {
  type PopoutPanelState,
  popoutPanels,
  updatePanel,
  persistPopoutState,
  getDockedPanelTop,
  snapGuides,
  sidebarWidth,
  sidebarCollapsed,
  setPanelSplitRatio,
} from './sessions.js';

export const SNAP_THRESHOLD = 20;
export const UNDOCK_THRESHOLD = 40;
export const MIN_W = 300;
export const MIN_H = 200;
export const EDGE_SNAP = 8;
export const CONTROL_BAR_BOTTOM = 40;
export const GRAB_HANDLE_H = 48;

export function snapPosition(x: number, y: number, w: number, h: number, selfId: string): { x: number; y: number; guides: { x?: number; y?: number }[] } {
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
    // left edge -> target left/right
    if (Math.abs(edges.left - t.left) < EDGE_SNAP) { sx = t.left; guides.push({ x: t.left }); }
    if (Math.abs(edges.left - t.right) < EDGE_SNAP) { sx = t.right; guides.push({ x: t.right }); }
    // right edge -> target left/right
    if (Math.abs(edges.right - t.left) < EDGE_SNAP) { sx = t.left - w; guides.push({ x: t.left }); }
    if (Math.abs(edges.right - t.right) < EDGE_SNAP) { sx = t.right - w; guides.push({ x: t.right }); }
    // top edge -> target top/bottom
    if (Math.abs(edges.top - t.top) < EDGE_SNAP) { sy = t.top; guides.push({ y: t.top }); }
    if (Math.abs(edges.top - t.bottom) < EDGE_SNAP) { sy = t.bottom; guides.push({ y: t.bottom }); }
    // bottom edge -> target top/bottom
    if (Math.abs(edges.bottom - t.top) < EDGE_SNAP) { sy = t.top - h; guides.push({ y: t.top }); }
    if (Math.abs(edges.bottom - t.bottom) < EDGE_SNAP) { sy = t.bottom - h; guides.push({ y: t.bottom }); }
  }

  return { x: sx, y: sy, guides };
}

export interface DragStartPos {
  mx: number;
  my: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dockedHeight: number;
  dockedTopOffset: number;
  dockedBaseTop: number;
}

export function handleDragMove(
  ev: MouseEvent,
  panelId: string,
  startPos: DragStartPos,
  dragMoved: { current: boolean },
) {
  const dx = ev.clientX - startPos.mx;
  const dy = ev.clientY - startPos.my;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.current = true;
  const currentPanel = popoutPanels.value.find((p) => p.id === panelId);
  if (!currentPanel) return;
  if (currentPanel.docked) {
    const isLeft = currentPanel.dockedSide === 'left';
    const undockThreshold = isLeft ? UNDOCK_THRESHOLD : -UNDOCK_THRESHOLD;
    if (isLeft ? dx > undockThreshold : dx < undockThreshold) {
      const w = currentPanel.dockedWidth;
      const h = typeof currentPanel.dockedHeight === 'number' ? currentPanel.dockedHeight : 500;
      updatePanel(panelId, {
        docked: false,
        floatingRect: { x: ev.clientX - w / 2, y: ev.clientY - 16, w, h },
      });
      startPos.mx = ev.clientX;
      startPos.my = ev.clientY;
      startPos.x = ev.clientX - w / 2;
      startPos.y = ev.clientY - 16;
      startPos.w = w;
      startPos.h = h;
      startPos.dockedHeight = h;
    } else {
      updatePanel(panelId, { dockedTopOffset: startPos.dockedTopOffset + dy });
    }
  } else {
    const rawX = Math.max(0, Math.min(startPos.x + dx, window.innerWidth - 100));
    const rawY = Math.max(0, Math.min(startPos.y + dy, window.innerHeight - 50));
    const fr = currentPanel.floatingRect;
    const snapped = snapPosition(rawX, rawY, fr.w, fr.h, panelId);
    snapGuides.value = snapped.guides;
    updatePanel(panelId, {
      floatingRect: { ...fr, x: snapped.x, y: snapped.y },
    });
    if (ev.clientX > window.innerWidth - SNAP_THRESHOLD) {
      updatePanel(panelId, {
        docked: true,
        dockedSide: 'right',
        dockedHeight: currentPanel.floatingRect.h,
        dockedWidth: currentPanel.floatingRect.w,
        dockedTopOffset: 0,
      });
    } else if (ev.clientX < sidebarWidth.value + SNAP_THRESHOLD) {
      updatePanel(panelId, {
        docked: true,
        dockedSide: 'left',
        dockedHeight: currentPanel.floatingRect.h,
        dockedWidth: currentPanel.floatingRect.w,
        dockedTopOffset: 0,
      });
    }
  }
}

export function handleResizeMove(
  ev: MouseEvent,
  panelId: string,
  dir: string,
  startPos: DragStartPos,
  startDockedW: number,
) {
  const dx = ev.clientX - startPos.mx;
  const dy = ev.clientY - startPos.my;
  const cp = popoutPanels.value.find((p) => p.id === panelId);
  if (!cp) return;
  if (cp.docked) {
    let h = startPos.dockedHeight;
    let topOff = startPos.dockedTopOffset;
    if (dir.includes('n') || dir === 'top') {
      h = Math.max(MIN_H, startPos.dockedHeight - dy);
      const heightDelta = h - startPos.dockedHeight;
      topOff = startPos.dockedTopOffset - heightDelta;
      const minOffset = -startPos.dockedBaseTop;
      if (topOff < minOffset) {
        topOff = minOffset;
        h = startPos.dockedHeight + startPos.dockedTopOffset - topOff;
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
    updatePanel(panelId, { dockedHeight: h, dockedWidth: w, dockedTopOffset: topOff, grabY: clampedGrabY });
  } else {
    const s = startPos;
    let { x, y, w, h } = { x: s.x, y: s.y, w: s.w, h: s.h };
    if (dir.includes('e')) w = Math.max(MIN_W, s.w + dx);
    if (dir.includes('w')) { w = Math.max(MIN_W, s.w - dx); x = s.x + s.w - w; }
    if (dir.includes('s')) h = Math.max(MIN_H, s.h + dy);
    if (dir.includes('n')) { h = Math.max(MIN_H, s.h - dy); y = s.y + s.h - h; }
    updatePanel(panelId, { floatingRect: { x, y, w, h } });
  }
}

export function handleSplitDividerMove(
  ev: MouseEvent,
  panelId: string,
  containerRect: DOMRect,
) {
  const ratio = (ev.clientX - containerRect.left) / containerRect.width;
  setPanelSplitRatio(panelId, ratio);
}

export function handleGrabMove(
  ev: MouseEvent,
  panelId: string,
  grabStart: { mx: number; my: number; grabY: number },
  startW: number,
  startMx: number,
  isLeft: boolean,
  grabMoved: { current: boolean },
) {
  const dx = Math.abs(ev.clientX - grabStart.mx);
  const dy = Math.abs(ev.clientY - grabStart.my);
  if (dx > 3 || dy > 3) {
    grabMoved.current = true;
  }
  if (dx > 3) {
    const delta = ev.clientX - startMx;
    updatePanel(panelId, { dockedWidth: Math.max(MIN_W, isLeft ? startW + delta : startW - delta) });
  }
  if (dy > 3) {
    const dyMove = ev.clientY - grabStart.my;
    let newGrabY = grabStart.grabY + dyMove;
    const cp = popoutPanels.value.find((p) => p.id === panelId);
    if (cp?.visible) {
      const panelH = cp.dockedHeight;
      const topOff = cp.dockedTopOffset || 0;
      const baseTop = getDockedPanelTop(panelId) - topOff;
      const maxGrabY = panelH - GRAB_HANDLE_H;
      if (newGrabY < 0) {
        const overflow = -newGrabY;
        const newTopOff = topOff - overflow;
        const minTopOff = -(baseTop - 40);
        const clampedTopOff = Math.max(minTopOff, newTopOff);
        const actualGrow = topOff - clampedTopOff;
        updatePanel(panelId, {
          grabY: 0,
          dockedHeight: panelH + actualGrow,
          dockedTopOffset: clampedTopOff,
        });
      } else if (newGrabY > maxGrabY) {
        const overflow = newGrabY - maxGrabY;
        const maxH = window.innerHeight - (baseTop + topOff);
        const newH = Math.min(maxH, panelH + overflow);
        updatePanel(panelId, {
          grabY: newH - GRAB_HANDLE_H,
          dockedHeight: newH,
        });
      } else {
        updatePanel(panelId, { grabY: newGrabY });
      }
    } else {
      const minY = 40;
      const maxY = window.innerHeight - GRAB_HANDLE_H;
      const baseTop = getDockedPanelTop(panelId);
      newGrabY = Math.max(minY - baseTop, Math.min(newGrabY, maxY - baseTop));
      updatePanel(panelId, { grabY: newGrabY });
    }
  }
}
