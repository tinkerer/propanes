import { useEffect } from 'preact/hooks';
import {
  type PopoutPanelState,
  popBackIn,
  updatePanel,
  persistPopoutState,
  togglePanelCompanion,
  toggleAlwaysOnTop,
  sessionMapComputed,
  companionTabId,
  termPickerOpen,
  activePanelId,
} from '../lib/sessions.js';
import { copyText } from '../lib/clipboard.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { showHotkeyHints } from '../lib/settings.js';
import {
  popoutIdMenuOpen,
  popoutWindowMenuOpen,
  popoutStatusMenuOpen,
  popoutHotkeyMenuOpen,
  companionMenuOpen,
} from './popout-signals.js';

// Wires up keyboard shortcuts and click-outside listeners for every menu the
// popout panel can open. Split out of `PopoutPanel` so the shell stays small.
//
// Hotkey responsibilities:
// - id-menu (popoutIdMenuOpen): C/P/W/B/J/L/Y/F/I/M/Esc — copy / pop / open
//   in window or browser / copy jsonl / toggle companion variants / open
//   terminal picker
// - window-menu (popoutWindowMenuOpen): S/W/A/D/Space/M/Esc — pop back in,
//   always-on-top, dock left/right, minimize/maximize
// - ctrl-shift overlay (popoutHotkeyMenuOpen): position-tracks the active
//   tab's status dot while Ctrl+Shift is held
export function usePopoutPanelHotkeys(panels: PopoutPanelState[]) {
  // Click-outside close for id menu
  useEffect(() => {
    if (!popoutIdMenuOpen.value) return;
    const close = () => { popoutIdMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [popoutIdMenuOpen.value]);

  // Click-outside close for status menu
  useEffect(() => {
    if (!popoutStatusMenuOpen.value) return;
    const close = () => { popoutStatusMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [popoutStatusMenuOpen.value]);

  // Click-outside close for companion menu
  useEffect(() => {
    if (!companionMenuOpen.value) return;
    const close = () => { companionMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [companionMenuOpen.value]);

  // Note: PopupMenu handles click-outside close via its own mousedown listener.
  // We intentionally don't add a document-level click listener for window menu —
  // doing so would tear the menu down before nested submenu buttons can handle
  // their click (e.g. Pop Out Panel / Pop Out Tab submenus).

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
}
