import type { RefObject, JSX } from 'preact';
import { WindowMenu } from './PopoutPanelContent.js';
import { openCosExternally } from '../lib/tab-drag.js';
import { COS_PANE_TAB_ID } from '../lib/chief-of-staff.js';

/**
 * Drag-to-popout hamburger + close-panel + WindowMenu for the popout-mode
 * tab bar. Pane-mode skips the window controls — see ChiefOfStaffBubble's
 * `{!inPane && panel && ...}` guard.
 *
 * Load-bearing: the 40px drag threshold and the edge-vs-non-edge dispatch
 * decide between `openCosExternally('new-window')` (drop near a screen edge)
 * and `openCosExternally('new-tab')` (drop anywhere else). Click-only (no
 * drag) opens the WindowMenu instead — the drag handler installs a global
 * mousemove listener that escalates to popout once the drag distance crosses
 * the threshold, and tears the listeners down on mouseup before threshold.
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
    // Drag-to-popout: if the user drags the hamburger >40px, open
    // a standalone CoS window via ?embed=cos (chat-only, no admin
    // chrome) so the popped-out window matches what the
    // CosEmbedRoot renders. Click-only opens the menu instead.
    const startX = (e as MouseEvent).clientX;
    const startY = (e as MouseEvent).clientY;
    let dragged = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) > 40) {
        dragged = true;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        setMenuOpen(false);
        // Decide window vs tab based on drop position: near screen
        // edge → detached window, anywhere else → new tab.
        const nearEdge =
          ev.clientX < 20 ||
          ev.clientX > window.innerWidth - 20 ||
          ev.clientY < 20 ||
          ev.clientY > window.innerHeight - 20;
        openCosExternally(nearEdge ? 'new-window' : 'new-tab');
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
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
        title="Panel options (drag to pop out to new window/tab)"
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
