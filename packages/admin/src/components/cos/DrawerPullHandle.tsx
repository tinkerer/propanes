import { useCallback, useRef, useState } from 'preact/hooks';
import { type ComponentChildren } from 'preact';
import { PopupMenu } from '../pickers/PopupMenu.js';

/**
 * Unified pull-handle for both pane-mode companion drawers (CosBubbleDrawers)
 * and cos popout-tree drawers (CosPopoutTreeView). Renders:
 *
 *   - A thin line/track along one edge of a host element.
 *   - A hamburger button positioned along that line. Clicking opens a popup
 *     menu of context-specific actions (provided by the parent).
 *
 * Gestures on the hamburger:
 *   - Click (no drag)      → open the popup menu.
 *   - Drag perpendicular   → resize via `onResize(deltaPerpendicularPx)`.
 *   - Drag parallel        → slide along the line via `onPositionChange(0..1)`.
 *   - Drag past host edge  → fire `onDragOutside()` once (parent decides what
 *                            "outside" means — for cos popout the leaf goes
 *                            external, for pane mode the drawer detaches
 *                            from the cos pane and floats in viewport space).
 *
 * Click on the line itself (not the hamburger) toggles the collapsed state
 * via `onClickCollapse()` so the operator can hide/show the drawer with a
 * single tap on a long, easy-to-hit edge.
 */
export type DrawerEdge = 'left' | 'right' | 'top' | 'bottom';

export interface DrawerPullHandleProps {
  /** Edge of the host where the line runs. Resize axis is perpendicular. */
  edge: DrawerEdge;
  /**
   * Bounding rect of the *host* (the cos popout, or the cos pane). The line
   * is drawn along the chosen edge of this rect. The line is what tracks the
   * host during drag/move/resize — its rect is computed from this in real
   * time by the parent (via rAF or signal).
   */
  hostRect: { top: number; left: number; width: number; height: number };
  /** Hamburger position along the edge, normalized 0..1. */
  hamburgerPos: number;
  /** Z-index applied to both line and hamburger (hamburger is +1). */
  zIndex: number;
  /** Drawer collapsed state — drives the line tooltip ("show" vs "hide"). */
  collapsed?: boolean;

  // -- Callbacks --
  /** Fired once at the start of a perpendicular drag — the parent should
   *  capture its current "size" state here so subsequent `onResize` deltas
   *  can be applied against a stable starting value. */
  onResizeStart?: () => void;
  /** Drag perpendicular to the line. `delta` is signed pixels relative to
   *  drag start; positive = toward the host's outer side. */
  onResize?: (deltaPerpendicularPx: number) => void;
  /** Click on the line (no drag) toggles the drawer hide/show. */
  onClickCollapse?: () => void;
  /** Hamburger slid along the edge. `pos` is normalized 0..1. */
  onPositionChange?: (pos: number) => void;
  /** Hamburger dragged past the host's perpendicular bounds by `OUTSIDE_THRESHOLD`. */
  onDragOutside?: () => void;

  /** Popup-menu contents — receives a close handler so items can dismiss it. */
  menuItems: (close: () => void) => ComponentChildren;
}

const HAMBURGER_SIZE = 24;
const LINE_THICKNESS = 4;
const HAMBURGER_OFFSET = 14; // px above the line, toward host interior
const DRAG_THRESHOLD = 4;
const OUTSIDE_THRESHOLD = 40;

function isHorizontalEdge(edge: DrawerEdge): boolean {
  return edge === 'top' || edge === 'bottom';
}

function lineRect(host: DrawerPullHandleProps['hostRect'], edge: DrawerEdge): { top: number; left: number; width: number; height: number } {
  if (edge === 'left') return { top: host.top, left: host.left - LINE_THICKNESS / 2, width: LINE_THICKNESS, height: host.height };
  if (edge === 'right') return { top: host.top, left: host.left + host.width - LINE_THICKNESS / 2, width: LINE_THICKNESS, height: host.height };
  if (edge === 'top') return { top: host.top - LINE_THICKNESS / 2, left: host.left, width: host.width, height: LINE_THICKNESS };
  return { top: host.top + host.height - LINE_THICKNESS / 2, left: host.left, width: host.width, height: LINE_THICKNESS };
}

function hamburgerXY(line: ReturnType<typeof lineRect>, edge: DrawerEdge, pos: number): { top: number; left: number } {
  // Hamburger sits slightly *inside* the host (offset toward host interior)
  // by HAMBURGER_OFFSET, centered perpendicular to the line. Position along
  // the line is `pos` (0..1) clamped to leave room for the button.
  const clampedPos = Math.max(0, Math.min(1, pos));
  if (isHorizontalEdge(edge)) {
    const x = line.left + clampedPos * Math.max(0, line.width - HAMBURGER_SIZE);
    const y = edge === 'top'
      ? line.top + LINE_THICKNESS // sit just below the top line
      : line.top - HAMBURGER_SIZE; // sit just above the bottom line
    // Apply HAMBURGER_OFFSET: shift toward host interior.
    const shifted = edge === 'top' ? y + HAMBURGER_OFFSET : y - HAMBURGER_OFFSET;
    return { top: shifted, left: x };
  }
  const y = line.top + clampedPos * Math.max(0, line.height - HAMBURGER_SIZE);
  const x = edge === 'left'
    ? line.left + LINE_THICKNESS
    : line.left - HAMBURGER_SIZE;
  const shifted = edge === 'left' ? x + HAMBURGER_OFFSET : x - HAMBURGER_OFFSET;
  return { top: y, left: shifted };
}

export function DrawerPullHandle({
  edge,
  hostRect,
  hamburgerPos,
  zIndex,
  collapsed,
  onResizeStart,
  onResize,
  onClickCollapse,
  onPositionChange,
  onDragOutside,
  menuItems,
}: DrawerPullHandleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const horizontal = isHorizontalEdge(edge);

  const line = lineRect(hostRect, edge);
  const ham = hamburgerXY(line, edge, hamburgerPos);

  // ---- Line click → collapse ----
  const onLineMouseDown = useCallback(
    (e: MouseEvent) => {
      // If press began on the hamburger (visual sibling), let it handle.
      if ((e.target as HTMLElement).closest('.drawer-pull-hamburger')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      let resizeArmed = false;
      const onMove = (ev: MouseEvent) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD) moved = true;
        if (moved && onResize) {
          if (!resizeArmed) {
            resizeArmed = true;
            onResizeStart?.();
          }
          // Drag along the line — treat as resize for ergonomics.
          const dPerp = horizontal ? (ev.clientY - startY) : (ev.clientX - startX);
          // Sign so that "outward" is positive: for right/bottom edges,
          // outward = positive; for left/top, outward = negative.
          const sign = (edge === 'right' || edge === 'bottom') ? 1 : -1;
          onResize(dPerp * sign);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!moved && onClickCollapse) onClickCollapse();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [edge, horizontal, onResize, onResizeStart, onClickCollapse],
  );

  // ---- Hamburger gestures: click=menu, perpendicular drag=resize,
  // parallel drag=slide, far perpendicular drag=outside. ----
  const onHamburgerMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startPos = hamburgerPos;
      // Compute the host's parallel span at drag start, used to translate
      // parallel drag delta into a normalized position delta.
      const parallelSpan = horizontal ? hostRect.width : hostRect.height;
      let dragged = false;
      let firedOutside = false;
      let resizeArmed = false;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD) dragged = true;
        if (!dragged) return;

        // Perpendicular = resize axis; parallel = slide axis.
        const dPerp = horizontal ? dy : dx;
        const dPar = horizontal ? dx : dy;
        const outwardSign = (edge === 'right' || edge === 'bottom') ? 1 : -1;
        const outward = dPerp * outwardSign;

        // -- Outside detection: cursor pulled past host edge by OUTSIDE_THRESHOLD. --
        if (!firedOutside && onDragOutside) {
          const outsideOutward = (() => {
            switch (edge) {
              case 'right': return ev.clientX - (hostRect.left + hostRect.width);
              case 'left':  return hostRect.left - ev.clientX;
              case 'bottom':return ev.clientY - (hostRect.top + hostRect.height);
              case 'top':   return hostRect.top - ev.clientY;
            }
          })();
          if (outsideOutward > OUTSIDE_THRESHOLD) {
            firedOutside = true;
            onDragOutside();
            // End the drag — let the parent decide what happens next.
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            return;
          }
        }

        // -- Resize (perpendicular delta in pixels). --
        if (onResize) {
          if (!resizeArmed) {
            resizeArmed = true;
            onResizeStart?.();
          }
          onResize(outward);
        }

        // -- Slide (parallel delta in normalized fraction). --
        if (onPositionChange && parallelSpan > 0) {
          const newPos = Math.max(0, Math.min(1, startPos + dPar / parallelSpan));
          if (newPos !== hamburgerPos) onPositionChange(newPos);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!dragged) setMenuOpen((v) => !v);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [edge, horizontal, hamburgerPos, hostRect.width, hostRect.height, hostRect.left, hostRect.top, onResize, onResizeStart, onPositionChange, onDragOutside],
  );

  return (
    <>
      <div
        class={`drawer-pull-line drawer-pull-line-${edge}${collapsed ? ' drawer-pull-line-collapsed' : ''}`}
        style={{
          position: 'fixed',
          top: line.top,
          left: line.left,
          width: line.width,
          height: line.height,
          zIndex,
          cursor: horizontal ? 'ns-resize' : 'ew-resize',
        }}
        onMouseDown={onLineMouseDown}
        title={collapsed ? 'Click to show drawer · drag to resize' : 'Click to hide drawer · drag to resize'}
        aria-label={collapsed ? 'Show drawer' : 'Hide drawer'}
        role="separator"
        aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      />
      <button
        ref={menuBtnRef}
        type="button"
        class={`drawer-pull-hamburger drawer-pull-hamburger-${edge}`}
        style={{
          position: 'fixed',
          top: ham.top,
          left: ham.left,
          width: HAMBURGER_SIZE,
          height: HAMBURGER_SIZE,
          zIndex: zIndex + 1,
        }}
        onMouseDown={onHamburgerMouseDown}
        title="Click for options · drag to resize/slide"
        aria-haspopup="true"
        aria-expanded={menuOpen}
      >☰</button>
      {menuOpen && (
        <PopupMenu anchorRef={menuBtnRef} onClose={() => setMenuOpen(false)}>
          {menuItems(() => setMenuOpen(false))}
        </PopupMenu>
      )}
    </>
  );
}
