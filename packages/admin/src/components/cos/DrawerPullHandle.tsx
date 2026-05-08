import { useCallback, useRef } from 'preact/hooks';
import { type ComponentChildren, type RefObject } from 'preact';

/**
 * Unified drawer pull-handle — a single popout-grab-tab–shaped container
 * (20×72px) with a nested ☰ button at the top and a ┃ grip indicator below.
 *
 * **Tab body** (┃ grip area):
 *   - Click → toggle collapse (hide/show drawer).
 *   - Drag perpendicular → resize the drawer.
 *   - Drag parallel → slide the handle along the edge (like popout grabY).
 *   - Drag past `flipRect` boundary → fire `onDragOutside` (parent flips
 *     internal↔external); drag continues seamlessly from the new position.
 *
 * **☰ hamburger** (nested button):
 *   - All behavior owned by parent via `onHamburgerMouseDown`.
 */
export type DrawerEdge = 'left' | 'right' | 'top' | 'bottom';

export interface DrawerPullHandleProps {
  edge: DrawerEdge;
  drawerRect: { top: number; left: number; width: number; height: number };
  handlePos: number;
  zIndex: number;
  collapsed?: boolean;

  // -- Tab (┃) callbacks --
  onResizeStart?: () => void;
  onResize?: (deltaPerpendicularPx: number) => void;
  onClickCollapse?: () => void;
  /** Slide the handle along the edge (normalized 0..1). */
  onPositionChange?: (pos: number) => void;

  // -- Edge-crossing flip --
  /** Rect + edge defining the boundary for the overlay↔external flip.
   *  When the cursor is dragged past `flipRect`'s `flipEdge` by
   *  OUTSIDE_THRESHOLD px in the direction selected by `flipDirection`,
   *  `onDragOutside` fires. The drag continues seamlessly — startX/startY
   *  are re-anchored, outwardSign is inverted, and onResizeStart re-arms. */
  flipRect?: { top: number; left: number; width: number; height: number };
  flipEdge?: DrawerEdge;
  flipDirection?: 'outward' | 'inward';
  onDragOutside?: (ev: MouseEvent) => void;

  // -- Hamburger (☰) --
  hamburgerRef?: RefObject<HTMLButtonElement>;
  onHamburgerMouseDown?: (e: MouseEvent) => void;

  children?: ComponentChildren;
}

const TAB_WIDTH = 20;
const TAB_HEIGHT = 72;
const DRAG_THRESHOLD = 4;
const OUTSIDE_THRESHOLD = 40;

function isHorizontalEdge(edge: DrawerEdge): boolean {
  return edge === 'top' || edge === 'bottom';
}

/** Tab bar rect — sits outside the drawer, flush against the chosen edge. */
export function tabRect(
  host: DrawerPullHandleProps['drawerRect'],
  edge: DrawerEdge,
  pos: number,
): { top: number; left: number; width: number; height: number } {
  const p = Math.max(0, Math.min(1, pos));
  if (edge === 'left') return { top: host.top + p * Math.max(0, host.height - TAB_HEIGHT), left: host.left - TAB_WIDTH, width: TAB_WIDTH, height: TAB_HEIGHT };
  if (edge === 'right') return { top: host.top + p * Math.max(0, host.height - TAB_HEIGHT), left: host.left + host.width, width: TAB_WIDTH, height: TAB_HEIGHT };
  if (edge === 'top') return { top: host.top - TAB_WIDTH, left: host.left + p * Math.max(0, host.width - TAB_HEIGHT), width: TAB_HEIGHT, height: TAB_WIDTH };
  return { top: host.top + host.height, left: host.left + p * Math.max(0, host.width - TAB_HEIGHT), width: TAB_HEIGHT, height: TAB_WIDTH };
}

export function DrawerPullHandle({
  edge,
  drawerRect,
  handlePos,
  zIndex,
  collapsed,
  onResizeStart,
  onResize,
  onClickCollapse,
  onPositionChange,
  flipRect,
  flipEdge,
  flipDirection,
  onDragOutside,
  hamburgerRef,
  onHamburgerMouseDown,
  children,
}: DrawerPullHandleProps) {
  const horizontal = isHorizontalEdge(edge);
  const tab = tabRect(drawerRect, edge, handlePos);

  // Flip-detection rect defaults.
  const fRect = flipRect ?? drawerRect;
  const fEdge: DrawerEdge = flipEdge ?? edge;
  const fSign = flipDirection === 'inward' ? -1 : 1;

  // Refs so the drag handler always calls the LATEST callback versions,
  // even though the closure was created at mousedown time. Without these,
  // a flip re-render produces new callbacks (with fresh isExternal etc.)
  // but the in-flight drag closure still holds the stale originals.
  const onResizeRef = useRef(onResize);         onResizeRef.current = onResize;
  const onResizeStartRef = useRef(onResizeStart); onResizeStartRef.current = onResizeStart;
  const onCollapseRef = useRef(onClickCollapse);  onCollapseRef.current = onClickCollapse;
  const onPosChangeRef = useRef(onPositionChange); onPosChangeRef.current = onPositionChange;
  const onFlipRef = useRef(onDragOutside);        onFlipRef.current = onDragOutside;

  // ---- Tab: click → collapse, drag → resize + slide + flip ----
  const onTabMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.drawer-pull-hamburger')) return;
      e.preventDefault();
      let startX = e.clientX;
      let startY = e.clientY;
      let startPos = handlePos;
      const parallelSpan = horizontal ? drawerRect.width : drawerRect.height;
      const parallelStart = horizontal ? drawerRect.top : drawerRect.left;
      let moved = false;
      let resizeArmed = false;
      let outwardSign: 1 | -1 = (edge === 'right' || edge === 'bottom') ? 1 : -1;
      let localFSign = fSign;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
        if (!moved) return;

        const dPerp = horizontal ? dy : dx;

        // -- Edge-crossing flip detection --
        if (onFlipRef.current) {
          const baseSigned = (() => {
            switch (fEdge) {
              case 'right': return ev.clientX - (fRect.left + fRect.width);
              case 'left':  return fRect.left - ev.clientX;
              case 'bottom':return ev.clientY - (fRect.top + fRect.height);
              case 'top':   return fRect.top - ev.clientY;
            }
          })();
          if (baseSigned * localFSign > OUTSIDE_THRESHOLD) {
            onFlipRef.current(ev);
            startX = ev.clientX;
            startY = ev.clientY;
            outwardSign = (outwardSign === 1 ? -1 : 1) as 1 | -1;
            localFSign = (localFSign === 1 ? -1 : 1) as 1 | -1;
            resizeArmed = false;
            if (parallelSpan > 0) {
              const cursorPar = horizontal ? ev.clientY : ev.clientX;
              startPos = Math.max(0, Math.min(1, (cursorPar - parallelStart) / parallelSpan));
            }
            return;
          }
        }

        // -- Perpendicular: resize --
        if (onResizeRef.current) {
          if (!resizeArmed) { resizeArmed = true; onResizeStartRef.current?.(); }
          onResizeRef.current(dPerp * outwardSign);
        }

        // -- Parallel: slide handle along edge --
        if (onPosChangeRef.current && parallelSpan > 0) {
          const dPar = horizontal ? dx : dy;
          const newPos = Math.max(0, Math.min(1, startPos + dPar / parallelSpan));
          onPosChangeRef.current(newPos);
        }
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!moved) onCollapseRef.current?.();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    // Stable deps — refs handle callback freshness; only geometry matters.
    [edge, horizontal, handlePos, drawerRect.width, drawerRect.height,
     drawerRect.top, drawerRect.left,
     fRect.left, fRect.top, fRect.width, fRect.height, fEdge, fSign],
  );

  const borderRadius = (() => {
    switch (edge) {
      case 'left':  return '8px 0 0 8px';
      case 'right': return '0 8px 8px 0';
      case 'top':   return '8px 8px 0 0';
      case 'bottom':return '0 0 8px 8px';
    }
  })();
  const borderNone = (() => {
    switch (edge) {
      case 'left':  return { borderRight: 'none' } as const;
      case 'right': return { borderLeft: 'none' } as const;
      case 'top':   return { borderBottom: 'none' } as const;
      case 'bottom':return { borderTop: 'none' } as const;
    }
  })();

  return (
    <div
      class={`drawer-pull-tab drawer-pull-tab-${edge}${collapsed ? ' drawer-pull-tab-collapsed' : ''}`}
      style={{
        position: 'fixed',
        top: tab.top,
        left: tab.left,
        width: tab.width,
        height: tab.height,
        zIndex,
        borderRadius,
        ...borderNone,
        cursor: horizontal ? 'ns-resize' : 'ew-resize',
      }}
      onMouseDown={onTabMouseDown}
      title={collapsed ? 'Click to show drawer · drag to resize' : 'Click to hide drawer · drag to resize/slide'}
      aria-label={collapsed ? 'Show drawer' : 'Hide drawer'}
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
    >
      <button
        ref={hamburgerRef}
        type="button"
        class="drawer-pull-hamburger"
        onMouseDown={onHamburgerMouseDown}
        title="Click for options · drag to move"
        aria-haspopup="true"
      >☰</button>
      <span class="drawer-pull-grip" aria-hidden="true">┃</span>
      {children}
    </div>
  );
}
