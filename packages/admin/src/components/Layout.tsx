import { useEffect, useRef, useState } from 'preact/hooks';
import { currentRoute, navigate, selectedAppId, applications, addAppModalOpen, spotlightOpen, closeSpotlight, toggleSpotlight } from '../lib/state.js';
import { api } from '../lib/api.js';
import { idMenuOpen } from './LeafPane.js';
import { PopoutPanel, popoutIdMenuOpen, popoutWindowMenuOpen } from './PopoutPanel.js';
import { PaneTree } from './PaneTree.js';
import { layoutTree, focusedLeafId, splitLeaf, mergeLeaf, getAllLeaves, setFocusedLeaf, findLeaf, findLeafWithTab, SESSIONS_LEAF_ID } from '../lib/pane-tree.js';
import { PerfOverlay } from './PerfOverlay.js';
import { copyText } from '../lib/clipboard.js';
import { FileViewerOverlay } from './FileViewerPanel.js';
import { ShortcutHelpModal } from './ShortcutHelpModal.js';
import { SpotlightSearch } from './SpotlightSearch.js';
import { AddAppModal } from './AddAppModal.js';
import { HintToast } from './HintToast.js';
import { AutoFixToast } from './AutoFixToast.js';
import { NotificationCenter } from './NotificationCenter.js';
import { SshSetupDialog } from './SshSetupDialog.js';
import { TerminalPicker } from './TerminalPicker.js';
import { ControlBar } from './ControlBar.js';
import { MobileNav } from './MobileNav.js';
import { MobilePageView } from './MobilePageView.js';
import { isMobile } from '../lib/viewport.js';
import { registerShortcut, ctrlShiftHeld } from '../lib/shortcuts.js';
import { toggleTheme, arrowTabSwitching, showHotkeyHints } from '../lib/settings.js';
import { openPageView, openSettingsPanel } from '../lib/companion-state.js';
import {
  openTabs,
  activeTabId,
  panelMinimized,
  persistPanelState,
  sidebarCollapsed,
  sidebarWidth,
  toggleSidebar,
  allSessions,
  exitedSessions,
  startSessionPolling,
  openSession,
  deleteSession,
  killSession,
  resumeSession,
  closeTab,
  actionToast,
  showActionToast,
  hotkeyMenuOpen,
  spawnTerminal,
  handleTabDigit0to9,
  togglePopOutActive,
  popoutPanels,
  findPanelForSession,
  updatePanel,
  persistPopoutState,
  cyclePanelFocus,
  toggleDockedOrientation,
  sessionInputStates,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  leftPaneTabs,
  enableSplit,
  disableSplit,
  focusedPanelId,
  goToPreviousTab,
  autoJumpCountdown,
  cancelAutoJump,
  popOutTab,
  getSessionColor,
  setSessionColor,
  SESSION_COLOR_PRESETS,
  toggleAutoJumpPanel,
  resolveSession,
  activePanelId,
  termPickerOpen,
  sidebarStatusMenu,
  sidebarItemMenu,
  popInPickerSessionId,
  cycleWaitingSession,
  bringAllPanelsToFront,
  openFeedbackItem,
  feedbackTitleCache,
} from '../lib/sessions.js';

export function Layout() {
  const route = currentRoute.value;
  const collapsed = sidebarCollapsed.value;
  const width = sidebarWidth.value;
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const showSpotlight = spotlightOpen.value;
  const showShortcutHelpRef = useRef(false);
  const showSpotlightRef = useRef(false);
  showShortcutHelpRef.current = showShortcutHelp;
  showSpotlightRef.current = showSpotlight;

  useEffect(() => {
    let stopSessionPolling: (() => void) | null = null;
    const deferTimer = setTimeout(() => {
      stopSessionPolling = startSessionPolling();
    }, 100);
    return () => {
      clearTimeout(deferTimer);
      if (stopSessionPolling) stopSessionPolling();
    };
  }, []);

  // Intercept feedback detail routes and open them as separate pane tabs
  // (desktop only — mobile renders the detail page via MobilePageView and keeps the URL).
  useEffect(() => {
    if (isMobile.value) return;
    const detailMatch = route.match(/^\/app\/([^/]+)\/feedback\/(.+)$/);
    if (detailMatch) {
      const [, appId, feedbackId] = detailMatch;
      openFeedbackItem(feedbackId);
      navigate(`/app/${appId}/feedback`);
    }
  }, [route]);

  useEffect(() => {
    if (!sidebarStatusMenu.value) return;
    const close = () => { sidebarStatusMenu.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [sidebarStatusMenu.value]);

  useEffect(() => {
    if (!sidebarItemMenu.value) return;
    const close = () => { sidebarItemMenu.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [sidebarItemMenu.value]);

  function getActivePanelSession(): string | null {
    // Check focused tree leaf first
    const leafId = focusedLeafId.value;
    if (leafId) {
      const leaf = findLeaf(layoutTree.value.root, leafId);
      if (leaf && leaf.activeTabId && !leaf.activeTabId.includes(':')) {
        return leaf.activeTabId;
      }
    }
    const ap = activePanelId.value;
    if (!ap || ap === 'global' || ap === 'split-left' || ap === 'split-right') {
      return activeTabId.value;
    }
    const panel = popoutPanels.value.find((p) => p.id === ap);
    return panel ? (panel.activeSessionId || panel.sessionIds[0] || null) : null;
  }

  function isPopoutFocused(): boolean {
    const ap = activePanelId.value;
    return !!ap && ap !== 'global' && ap !== 'split-left' && ap !== 'split-right';
  }

  useEffect(() => {
    const cleanups = [
      registerShortcut({
        key: '?',
        code: 'Slash',
        modifiers: { ctrl: true, shift: true },
        label: 'Show keyboard shortcuts',
        category: 'General',
        action: () => setShowShortcutHelp(true),
      }),
      registerShortcut({
        key: 'T',
        code: 'KeyT',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle theme',
        category: 'General',
        action: toggleTheme,
      }),
      registerShortcut({
        key: 'Escape',
        label: 'Close modal',
        category: 'General',
        action: () => { setShowShortcutHelp(false); closeSpotlight(); popInPickerSessionId.value = null; },
      }),
      registerShortcut({
        key: ' ',
        code: 'Space',
        modifiers: { ctrl: true, shift: true },
        label: 'Spotlight search',
        category: 'General',
        action: () => toggleSpotlight(),
      }),
      registerShortcut({
        key: 'k',
        modifiers: { meta: true },
        label: 'Spotlight search',
        category: 'General',
        action: () => toggleSpotlight(),
      }),
      registerShortcut({
        key: '\\',
        modifiers: { ctrl: true },
        label: 'Toggle sidebar',
        category: 'Panels',
        action: toggleSidebar,
      }),
      registerShortcut({
        key: '~',
        code: 'Backquote',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle terminal panel',
        category: 'Panels',
        action: () => {
          if (openTabs.value.length > 0) {
            panelMinimized.value = !panelMinimized.value;
            persistPanelState();
          }
        },
      }),
      registerShortcut({
        sequence: 'g f',
        key: 'f',
        label: 'Go to Feedback',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/feedback`);
        },
      }),
      registerShortcut({
        sequence: 'g a',
        key: 'a',
        label: 'Go to Agents',
        category: 'Navigation',
        action: () => openSettingsPanel('agents'),
      }),
      registerShortcut({
        sequence: 'g g',
        key: 'g',
        label: 'Go to Files',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) openPageView(`view:files:${appId}`);
        },
      }),
      registerShortcut({
        sequence: 'g s',
        key: 's',
        label: 'Go to Sessions',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/sessions`);
        },
      }),
      registerShortcut({
        sequence: 'g l',
        key: 'l',
        label: 'Go to Live',
        category: 'Navigation',
        action: () => {
          const appId = selectedAppId.value || applications.value[0]?.id;
          if (appId) navigate(`/app/${appId}/live`);
        },
      }),
      registerShortcut({
        sequence: 'g p',
        key: 'p',
        label: 'Go to Preferences',
        category: 'Navigation',
        action: () => navigate('/settings/preferences'),
      }),
      registerShortcut({
        key: 'ArrowUp',
        modifiers: { ctrl: true, shift: true },
        label: 'Previous page',
        category: 'Navigation',
        action: () => { if (arrowTabSwitching.value) cycleNav(-1); },
      }),
      registerShortcut({
        key: 'ArrowDown',
        modifiers: { ctrl: true, shift: true },
        label: 'Next page',
        category: 'Navigation',
        action: () => { if (arrowTabSwitching.value) cycleNav(1); },
      }),
      registerShortcut({
        key: 'ArrowLeft',
        modifiers: { ctrl: true, shift: true },
        label: 'Previous session tab',
        category: 'Panels',
        action: () => { if (arrowTabSwitching.value) cycleSessionTab(-1); },
      }),
      registerShortcut({
        key: 'ArrowRight',
        modifiers: { ctrl: true, shift: true },
        label: 'Next session tab',
        category: 'Panels',
        action: () => { if (arrowTabSwitching.value) cycleSessionTab(1); },
      }),
      registerShortcut({
        key: 'P',
        code: 'KeyP',
        modifiers: { ctrl: true, shift: true },
        label: 'Session menu',
        category: 'Panels',
        action: () => {
          if (isPopoutFocused()) {
            const sid = getActivePanelSession();
            popoutIdMenuOpen.value = popoutIdMenuOpen.value ? null : (sid || null);
          } else {
            idMenuOpen.value = idMenuOpen.value ? null : (activeTabId.value || null);
          }
        },
      }),
      registerShortcut({
        key: 'B',
        code: 'KeyB',
        modifiers: { ctrl: true, shift: true },
        label: 'Back to previous tab',
        category: 'Panels',
        action: () => {
          goToPreviousTab();
          showActionToast('B', 'Back', 'var(--pw-accent)');
        },
      }),
      registerShortcut({
        sequence: 'g w',
        key: 'w',
        label: 'Go to waiting session',
        category: 'Navigation',
        action: () => {
          const waiting = allSessions.value.find((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting');
          if (waiting) {
            openSession(waiting.id);
            showActionToast('w', 'Waiting', 'var(--pw-success)');
          }
        },
      }),
      registerShortcut({
        key: 'A',
        code: 'KeyA',
        modifiers: { ctrl: true, shift: true },
        label: 'Cycle waiting sessions',
        category: 'Panels',
        action: () => {
          cycleWaitingSession();
          showActionToast('A', 'Next waiting', 'var(--pw-success)');
        },
      }),
      registerShortcut({
        sequence: 'g t',
        key: 't',
        label: 'New terminal',
        category: 'Panels',
        action: () => spawnTerminal(selectedAppId.value),
      }),
      registerShortcut({
        sequence: 'g c',
        key: 'c',
        label: 'New Claude session',
        category: 'Panels',
        action: () => spawnTerminal(selectedAppId.value, undefined, undefined, 'interactive'),
      }),
      // Ctrl+Shift+0-9: tab switching (0 = toggle pop-out, 1-9 = tab by index)
      ...Array.from({ length: 10 }, (_, i) => registerShortcut({
        key: String(i),
        code: `Digit${i}`,
        modifiers: { ctrl: true, shift: true },
        label: `Switch to tab ${i}`,
        category: 'Panels',
        action: () => handleTabDigit0to9(i),
      })),
      registerShortcut({
        key: 'W',
        code: 'KeyW',
        modifiers: { ctrl: true, shift: true },
        label: 'Close popup / tab',
        category: 'Panels',
        action: () => {
          if (showSpotlightRef.current) { closeSpotlight(); return; }
          if (showShortcutHelpRef.current) { setShowShortcutHelp(false); return; }
          if (hotkeyMenuOpen.value) { hotkeyMenuOpen.value = null; }
          if (isPopoutFocused()) {
            const ap = activePanelId.value;
            const panel = popoutPanels.value.find((p) => p.id === ap && p.visible);
            if (panel) {
              const sid = panel.activeSessionId || panel.sessionIds[0];
              if (sid) {
                showActionToast('W', 'Close tab', 'var(--pw-text-muted)');
                closeTab(sid);
              }
              return;
            }
          }
          const visiblePanels = popoutPanels.value.filter((p) => p.visible);
          if (visiblePanels.length > 0) {
            const panel = visiblePanels[visiblePanels.length - 1];
            updatePanel(panel.id, { visible: false });
            persistPopoutState();
            return;
          }
          if (activeTabId.value) {
            showActionToast('W', 'Close tab', 'var(--pw-text-muted)');
            closeTab(activeTabId.value);
          }
        },
      }),
      registerShortcut({
        key: '_',
        code: 'Minus',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle pop out / dock',
        category: 'Panels',
        action: togglePopOutActive,
      }),
      registerShortcut({
        key: '+',
        code: 'Equal',
        modifiers: { ctrl: true, shift: true },
        label: 'New terminal',
        category: 'Panels',
        action: () => spawnTerminal(selectedAppId.value),
      }),
      registerShortcut({
        key: 'Tab',
        modifiers: { ctrl: true, shift: true },
        label: 'Cycle panel focus',
        category: 'Panels',
        action: () => {
          const leaves = getAllLeaves(layoutTree.value.root).filter(l => l.panelType === 'tabs' && l.tabs.length > 0);
          if (leaves.length > 1) {
            const curIdx = leaves.findIndex(l => l.id === focusedLeafId.value);
            const nextIdx = (curIdx + 1) % leaves.length;
            setFocusedLeaf(leaves[nextIdx].id);
          } else {
            cyclePanelFocus(1);
          }
        },
      }),
      registerShortcut({
        key: '|',
        code: 'Backslash',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle docked orientation',
        category: 'Panels',
        action: toggleDockedOrientation,
      }),
      registerShortcut({
        key: '"',
        code: 'Quote',
        modifiers: { ctrl: true, shift: true },
        label: 'Split pane horizontal',
        category: 'Panels',
        action: () => {
          const leafId = focusedLeafId.value || SESSIONS_LEAF_ID;
          splitLeaf(leafId, 'horizontal', 'second', [], 0.5, true);
        },
      }),
      registerShortcut({
        key: '-',
        code: 'Minus',
        modifiers: { ctrl: true, shift: true },
        label: 'Split pane vertical',
        category: 'Panels',
        action: () => {
          const leafId = focusedLeafId.value || SESSIONS_LEAF_ID;
          splitLeaf(leafId, 'vertical', 'second', [], 0.5, true);
        },
      }),
      registerShortcut({
        key: 'Backspace',
        modifiers: { ctrl: true, shift: true },
        label: 'Merge/close pane',
        category: 'Panels',
        action: () => {
          const leafId = focusedLeafId.value;
          if (leafId) mergeLeaf(leafId);
        },
      }),
      registerShortcut({
        key: 'R',
        code: 'KeyR',
        modifiers: { ctrl: true, shift: true },
        label: 'Resolve active session',
        category: 'Panels',
        action: () => {
          const sid = getActivePanelSession();
          if (!sid) return;
          const sess = allSessions.value.find((s: any) => s.id === sid);
          if (!sess || !sess.feedbackId) return;
          hotkeyMenuOpen.value = null;
          showActionToast('R', 'Resolve', 'var(--pw-success)');
          resolveSession(sid, sess.feedbackId);
        },
      }),
      registerShortcut({
        key: 'K',
        code: 'KeyK',
        modifiers: { ctrl: true, shift: true },
        label: 'Kill active session',
        category: 'Panels',
        action: () => {
          const sid = getActivePanelSession();
          if (!sid || exitedSessions.value.has(sid)) return;
          hotkeyMenuOpen.value = null;
          showActionToast('K', 'Kill', 'var(--pw-danger)');
          killSession(sid);
        },
      }),
      registerShortcut({
        key: 'E',
        code: 'KeyE',
        modifiers: { ctrl: true, shift: true },
        label: 'Window menu (popout)',
        category: 'Panels',
        action: () => {
          if (!isPopoutFocused()) return;
          const ap = activePanelId.value;
          popoutWindowMenuOpen.value = popoutWindowMenuOpen.value ? null : (ap || null);
        },
      }),
      registerShortcut({
        key: 'X',
        code: 'KeyX',
        modifiers: { ctrl: true, shift: true },
        label: 'Cancel auto-jump',
        category: 'Panels',
        action: cancelAutoJump,
      }),
      registerShortcut({
        key: 'J',
        code: 'KeyJ',
        modifiers: { ctrl: true, shift: true },
        label: 'Toggle jump panel',
        category: 'Panels',
        action: toggleAutoJumpPanel,
      }),
      registerShortcut({
        key: 'O',
        code: 'KeyO',
        modifiers: { ctrl: true, shift: true },
        label: 'Bring all panels to front',
        category: 'Panels',
        action: () => {
          bringAllPanelsToFront();
          showActionToast('O', 'All panels', 'var(--pw-accent)');
        },
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== 'pw-companion-shortcut') return;
      if (e.data.key === 'cmd+k' || e.data.key === 'ctrl+shift+space') {
        toggleSpotlight();
      } else if (e.data.key === 'escape') {
        setShowShortcutHelp(false);
        closeSpotlight();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const appSubTabs = ['feedback', 'sessions', 'live', 'settings'];
  const settingsTabs = ['/settings/agents', '/settings/infrastructure', '/settings/user-guide', '/settings/getting-started', '/settings/preferences'];

  function cycleNav(dir: number) {
    const r = currentRoute.value;
    const appId = selectedAppId.value;
    if (appId && r.startsWith(`/app/${appId}/`)) {
      const segment = r.replace(`/app/${appId}/`, '').split('/')[0];
      const idx = appSubTabs.indexOf(segment);
      if (idx >= 0) {
        const next = appSubTabs[(idx + dir + appSubTabs.length) % appSubTabs.length];
        navigate(`/app/${appId}/${next}`);
      }
    } else if (r.startsWith('/settings/')) {
      const idx = settingsTabs.indexOf(r);
      if (idx >= 0) {
        const next = settingsTabs[(idx + dir + settingsTabs.length) % settingsTabs.length];
        const key = next.replace('/settings/', '');
        openSettingsPanel(key);
      }
    }
  }

  function cycleSessionTab(dir: number) {
    if (splitEnabled.value && focusedPanelId.value === 'split-right') {
      const rTabs = rightPaneTabs.value;
      if (rTabs.length === 0) return;
      const current = rightPaneActiveId.value;
      const idx = current ? rTabs.indexOf(current) : -1;
      const next = rTabs[(idx + dir + rTabs.length) % rTabs.length];
      rightPaneActiveId.value = next;
      return;
    }
    if (splitEnabled.value) {
      const lTabs = leftPaneTabs();
      if (lTabs.length === 0) return;
      const current = activeTabId.value;
      const idx = current ? lTabs.indexOf(current) : -1;
      const next = lTabs[(idx + dir + lTabs.length) % lTabs.length];
      openSession(next);
      return;
    }
    const tabs = openTabs.value;
    if (tabs.length === 0) return;
    const current = activeTabId.value;
    const idx = current ? tabs.indexOf(current) : -1;
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    openSession(next);
  }

  const mobile = isMobile.value;

  return (
    <div class={`layout${mobile ? ' layout-mobile' : ''}`}>
      <ControlBar />
      {mobile ? (
        <MobilePageView />
      ) : (
        <PaneTree
          node={layoutTree.value.root}
        />
      )}
      {!mobile && <PopoutPanel />}
      {mobile && <MobileNav />}
      {termPickerOpen.value && (
        <TerminalPicker
          mode={termPickerOpen.value}
          onClose={() => { termPickerOpen.value = null; }}
        />
      )}
      <FileViewerOverlay />
      {showShortcutHelp && <ShortcutHelpModal onClose={() => setShowShortcutHelp(false)} />}
      {showSpotlight && <SpotlightSearch onClose={() => closeSpotlight()} />}
      {addAppModalOpen.value && <AddAppModal onClose={() => { addAppModalOpen.value = false; }} />}
      {actionToast.value && (
        <div class="action-toast">
          <span class="action-toast-key" style={{ background: actionToast.value.color }}>{actionToast.value.key}</span>
          <span class="action-toast-label">{actionToast.value.label}</span>
        </div>
      )}
      {autoJumpCountdown.value > 0 && (
        <div class="action-toast auto-jump-toast">
          <span class="action-toast-key" style={{ background: 'var(--pw-warning, #f59e0b)' }}>
            {autoJumpCountdown.value}
          </span>
          <span class="action-toast-label">
            Jumping in {autoJumpCountdown.value}s
            {' '}<kbd onClick={cancelAutoJump} style={{ cursor: 'pointer' }}>{'\u2303\u21E7'}X</kbd>
          </span>
        </div>
      )}
      <PerfOverlay />
      <HintToast />
      <AutoFixToast />
      <NotificationCenter />
      <SshSetupDialog />
      {sidebarStatusMenu.value && (() => {
        const menuSid = sidebarStatusMenu.value!.sessionId;
        const menuSess = allSessions.value.find((s: any) => s.id === menuSid);
        const menuExited = exitedSessions.value.has(menuSid);
        const isRunning = menuSess?.status === 'running';
        return (
          <div
            class="status-dot-menu"
            style={{ left: `${sidebarStatusMenu.value!.x}px`, top: `${sidebarStatusMenu.value!.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {isRunning && !menuExited && (
              <button onClick={() => { sidebarStatusMenu.value = null; killSession(menuSid); }}>Kill {showHotkeyHints.value && <kbd>⌃⇧K</kbd>}</button>
            )}
            {isRunning && menuSess?.feedbackId && (
              <button onClick={() => { sidebarStatusMenu.value = null; resolveSession(menuSid, menuSess.feedbackId); }}>Resolve {showHotkeyHints.value && <kbd>⌃⇧R</kbd>}</button>
            )}
            {menuExited && (
              <button onClick={() => { sidebarStatusMenu.value = null; resumeSession(menuSid); }}>Resume</button>
            )}
            <button onClick={() => { closeTab(menuSid); sidebarStatusMenu.value = null; }}>Close tab {showHotkeyHints.value && <kbd>⌃⇧W</kbd>}</button>
            <button onClick={() => { sidebarStatusMenu.value = null; deleteSession(menuSid); }}>Archive</button>
          </div>
        );
      })()}
      {sidebarItemMenu.value && (() => {
        const menuSid = sidebarItemMenu.value!.sessionId;
        const menuHeight = 176;
        const flipUp = sidebarItemMenu.value!.y + menuHeight > window.innerHeight;
        const menuStyle = flipUp
          ? { left: `${sidebarItemMenu.value!.x}px`, bottom: `${window.innerHeight - sidebarItemMenu.value!.y - 20}px` }
          : { left: `${sidebarItemMenu.value!.x}px`, top: `${sidebarItemMenu.value!.y}px` };
        return (
          <div
            class="status-dot-menu"
            style={menuStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => {
              sidebarItemMenu.value = null;
              copyText(`${location.origin}${location.pathname}#/session/${menuSid}`);
              showActionToast('\u{1F517}', 'Link copied', 'var(--pw-accent, var(--pw-primary))');
            }}>Copy link</button>
            <button onClick={() => { sidebarItemMenu.value = null; popOutTab(menuSid); }}>Open in panel</button>
            <button onClick={() => {
              sidebarItemMenu.value = null;
              window.open(`${location.pathname}#/session/${menuSid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
            }}>Open in window</button>
            <button onClick={() => {
              sidebarItemMenu.value = null;
              window.open(`${location.pathname}#/session/${menuSid}`, '_blank');
            }}>Open in tab</button>
            <button onClick={() => {
              sidebarItemMenu.value = null;
              const leaf = findLeafWithTab(menuSid);
              if (leaf) {
                splitLeaf(leaf.id, 'horizontal', 'second', [], 0.5);
              } else {
                enableSplit(menuSid);
              }
            }}>Split pane</button>
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
    </div>
  );
}
