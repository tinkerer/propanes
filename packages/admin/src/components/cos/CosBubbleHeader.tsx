import type { RefObject, JSX } from 'preact';
import { WindowMenu } from '../panes/PopoutPanelContent.js';
import {
  openCosExternally,
  detectExternalZone,
  applyExternalGhostHint,
  computeLeafZone,
  dragOverLeafZone,
  type LeafDropZone,
} from '../../lib/tab-drag.js';
import { COS_PANE_TAB_ID, dockCosToLeaf } from '../../lib/chief-of-staff.js';

/**
 * Drag-to-dock hamburger + close-panel + WindowMenu for the popout-mode tab
 * bar. Pane-mode skips the window controls — see ChiefOfStaffBubble's
 * `{!inPane && panel && ...}` guard.
 *
 * The hamburger acts like the tab/leaf-drag handles elsewhere in the app:
 *  - click only → open the WindowMenu
 *  - drag onto a `[data-leaf-id]` leaf → dock the CoS panel into that leaf
 *    using the hovered drop zone (tab bar / h-split / v-split)
 *  - drag past the viewport edge → open in a new browser tab/window via
 *    `openCosExternally`
 *  - drag with no target → leave the floating popout where it is
 *
 * Previously any drag past 40px popped the panel out into a new browser
 * tab/window (heuristic: near edge → window, else tab) — confusing because
 * the operator had no way to dock the panel without using the menu.
 */
export function CosBubbleWindowControls({
  panel,
  isDocked,
  isLeftDocked,
  isMinimized,
  menuOpen,
  setMenuOpen,
  menuButtonRef,
  onClosePanel,
}: {
  panel: any;
  isDocked: boolean;
  isLeftDocked: boolean;
  isMinimized: boolean;
  menuOpen: boolean;
  setMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  menuButtonRef: RefObject<HTMLButtonElement>;
  onClosePanel: () => void;
}) {
  function onHamburgerMouseDown(e: JSX.TargetedMouseEvent<HTMLButtonElement>) {
    const startX = (e as MouseEvent).clientX;
    const startY = (e as MouseEvent).clientY;
    const DRAG_THRESHOLD = 6;
    const ghostLabel = 'Ops chat';

    let dragging = false;
    let ghost: HTMLElement | null = null;
    let dropTarget: { leafId: string; zone: LeafDropZone } | null = null;
    let lastHighlighted: Element | null = null;

    function createGhost() {
      ghost = document.createElement('div');
      ghost.className = 'tab-drag-ghost pane-drag-ghost';
      ghost.textContent = ghostLabel;
      document.body.appendChild(ghost);
    }
    function updateGhost(x: number, y: number) {
      if (!ghost) return;
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y - 12}px`;
    }
    function clearHighlight() {
      if (lastHighlighted) {
        lastHighlighted.classList.remove('drop-target');
        lastHighlighted = null;
      }
      dragOverLeafZone.value = null;
    }
    function detectLeafTarget(x: number, y: number): { leafId: string; zone: LeafDropZone } | null {
      const els = document.elementsFromPoint(x, y);
      for (const el of els) {
        if (el === ghost) continue;
        const leafEl = (el as HTMLElement).closest?.('[data-leaf-id]') as HTMLElement | null;
        if (!leafEl) continue;
        const leafId = leafEl.dataset.leafId!;
        const zone = computeLeafZone(x, y, leafEl);
        if (zone === 'self-popout') return null;
        return { leafId, zone };
      }
      return null;
    }
    function highlight(target: { leafId: string; zone: LeafDropZone } | null) {
      clearHighlight();
      if (!target) {
        ghost?.classList.remove('will-drop');
        return;
      }
      ghost?.classList.add('will-drop');
      dragOverLeafZone.value = { leafId: target.leafId, zone: target.zone };
      if (target.zone === 'tab') {
        const el = document.querySelector(`[data-leaf-id="${target.leafId}"]`);
        if (el) {
          el.classList.add('drop-target');
          lastHighlighted = el;
        }
      }
    }

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        dragging = true;
        setMenuOpen(false);
        createGhost();
      }
      if (!dragging) return;
      updateGhost(ev.clientX, ev.clientY);

      const ext = applyExternalGhostHint(ghost, ghostLabel, ev.clientX, ev.clientY);
      if (ext) {
        dropTarget = null;
        clearHighlight();
        ghost?.classList.remove('will-drop');
        return;
      }
      dropTarget = detectLeafTarget(ev.clientX, ev.clientY);
      highlight(dropTarget);
    };

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      clearHighlight();
      if (ghost) {
        ghost.remove();
        ghost = null;
      }

      // Click-only (no drag): the onClick handler on the button toggles the
      // WindowMenu — don't interfere.
      if (!dragging) return;

      const ext = detectExternalZone(ev.clientX, ev.clientY);
      if (ext) {
        openCosExternally(ext);
        return;
      }
      if (dropTarget) {
        const zone = dropTarget.zone === 'self-popout' ? 'tab' : dropTarget.zone;
        dockCosToLeaf(dropTarget.leafId, zone);
        return;
      }
      // Drag ended over empty space — leave the floating popout in place.
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <div class="popout-window-controls">
      <button
        ref={menuButtonRef}
        class="btn-close-panel cos-hamburger-draggable"
        onClick={() => setMenuOpen((v) => !v)}
        onMouseDown={onHamburgerMouseDown}
        title="Panel options (drag onto a pane to dock, or off-screen for a new window/tab)"
        aria-haspopup="true"
        aria-expanded={menuOpen}
      >{'☰'}</button>
      <button class="btn-close-panel" onClick={onClosePanel} title="Hide panel">&times;</button>
      {menuOpen && (
        <WindowMenu
          panel={panel}
          activeId={COS_PANE_TAB_ID}
          docked={isDocked}
          isLeftDocked={isLeftDocked}
          isMinimized={isMinimized}
          anchorRef={menuButtonRef}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
