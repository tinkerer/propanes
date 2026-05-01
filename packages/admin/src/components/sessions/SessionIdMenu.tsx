import { type RefObject } from 'preact';
import { useState, useLayoutEffect } from 'preact/hooks';
import { PopupMenu } from './PopupMenu.js';
import { copyWithTooltip } from '../lib/clipboard.js';
import { RUNTIME_INFO } from '../lib/agent-constants.js';
import { PROFILE_MATRIX, DISPATCHABLE_PROFILES } from '../lib/agent-matrix.js';
import {
  getCompanions,
  toggleCompanion,
  togglePanelCompanion,
  companionTabId,
  popBackIn,
  popOutTab,
  removeSessionFromPanel,
  resumeSession,
  openLocalTerminal,
  openUrlCompanion,
  termPickerOpen,
  type CompanionType,
  type PopoutPanelState,
} from '../lib/sessions.js';

const RUNTIME_OPTIONS = ['claude', 'codex'] as const;

export type SessionIdMenuContext =
  | { mode: 'tab'; canSplit?: boolean; enableSplit?: () => void }
  | { mode: 'popout'; panel: PopoutPanelState }
  | { mode: 'standalone' };

export function SessionIdMenu({
  sessionId,
  sess,
  isExited,
  anchorRef,
  onClose,
  context,
}: {
  sessionId: string;
  sess: any;
  isExited: boolean;
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  context: SessionIdMenuContext;
}) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [flipSubmenus, setFlipSubmenus] = useState(false);
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const SUBMENU_WIDTH = 220;
    // If opening the main menu at the anchor position would leave <220px to
    // the right of the viewport, submenus would overflow the right edge —
    // flip them to the left side instead.
    setFlipSubmenus(window.innerWidth - rect.left < 200 + SUBMENU_WIDTH);
  }, [anchorRef]);
  const toggleSubmenu = (key: string) => setOpenSubmenu((s) => {
    if (s === key) {
      const parent = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : null;
      return parent;
    }
    return key;
  });
  const submenuClass = (key: string) => {
    const isOpen = !!openSubmenu && (openSubmenu === key || openSubmenu.startsWith(key + '.'));
    return `id-submenu-group${isOpen ? ' open' : ''}`;
  };

  const isCompanionActive = (type: CompanionType): boolean => {
    if (context.mode === 'popout') {
      const panel = context.panel;
      const panelRight = panel.rightPaneTabs || [];
      return panelRight.includes(companionTabId(sessionId, type)) && !!panel.splitEnabled;
    }
    return getCompanions(sessionId).includes(type);
  };

  const toggle = (type: CompanionType) => {
    if (context.mode === 'popout') {
      togglePanelCompanion(context.panel.id, sessionId, type);
    } else {
      toggleCompanion(sessionId, type);
    }
  };

  const openTerminalCompanion = () => {
    if (isCompanionActive('terminal')) {
      toggle('terminal');
      return;
    }
    termPickerOpen.value = context.mode === 'popout'
      ? { kind: 'companion', sessionId, panelId: context.panel.id }
      : { kind: 'companion', sessionId };
  };

  const panelAction = () => {
    if (context.mode === 'popout') {
      popBackIn(sessionId);
    } else if (context.mode === 'tab') {
      popOutTab(sessionId);
    } else {
      // standalone (mobile): no panel action; fall back to opening in a new tab
      window.open(`#/session/${sessionId}`, '_blank');
    }
  };
  const panelLabel = context.mode === 'popout' ? 'Pop back to tab bar' : 'Panel';

  const canShowSplit = context.mode === 'tab' && context.canSplit && context.enableSplit;

  return (
    <PopupMenu anchorRef={anchorRef as any} onClose={onClose} className={`id-dropdown-menu${flipSubmenus ? ' flip-submenus' : ''}`}>
      <div class={submenuClass('copy')} onClick={(e: any) => e.stopPropagation()}>
        <button type="button" class="id-submenu-trigger" onClick={() => toggleSubmenu('copy')}>Copy</button>
        <div class="id-submenu">
          <button class="popup-menu-item" onClick={(e) => { onClose(); copyWithTooltip(sessionId, e as any); }}>
            Session ID <kbd>C</kbd>
          </button>
          {sess?.jsonlPath && (
            <button class="popup-menu-item" onClick={(e) => { onClose(); copyWithTooltip(sess.jsonlPath, e as any); }}>
              JSONL path <kbd>J</kbd>
            </button>
          )}
          {sess?.feedbackId && (
            <button class="popup-menu-item" onClick={(e) => { onClose(); copyWithTooltip(sess.feedbackId, e as any); }}>
              Feedback ID <kbd>D</kbd>
            </button>
          )}
        </div>
      </div>
      <div class={submenuClass('companion')} onClick={(e: any) => e.stopPropagation()}>
        <button type="button" class="id-submenu-trigger" onClick={() => toggleSubmenu('companion')}>Companion</button>
        <div class="id-submenu">
          {sess?.jsonlPath && (
            <button class="popup-menu-item" onClick={() => { onClose(); toggle('jsonl'); }}>
              {isCompanionActive('jsonl') ? '\u2713 ' : ''}JSONL <kbd>L</kbd>
            </button>
          )}
          {sess?.jsonlPath && (
            <button class="popup-menu-item" onClick={() => { onClose(); toggle('summary'); }}>
              {isCompanionActive('summary') ? '\u2713 ' : ''}Summary <kbd>Y</kbd>
            </button>
          )}
          {sess?.feedbackId && (
            <button class="popup-menu-item" onClick={() => { onClose(); toggle('feedback'); }}>
              {isCompanionActive('feedback') ? '\u2713 ' : ''}Ticket <kbd>F</kbd>
            </button>
          )}
          {sess?.url && (
            <button class="popup-menu-item" onClick={() => { onClose(); toggle('iframe'); }}>
              {isCompanionActive('iframe') ? '\u2713 ' : ''}Page iframe <kbd>I</kbd>
            </button>
          )}
          <button class="popup-menu-item" onClick={() => { onClose(); openTerminalCompanion(); }}>
            {isCompanionActive('terminal') ? '\u2713 ' : ''}Terminal <kbd>M</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); toggle('wiggum-runs'); }}>
            {isCompanionActive('wiggum-runs') ? '\u2713 ' : ''}Wiggum Runs <kbd>W</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); termPickerOpen.value = { kind: 'url' }; }}>
            Iframe... <kbd>U</kbd>
          </button>
          {sess?.isHarness && sess?.harnessAppPort && (
            <button class="popup-menu-item" onClick={() => {
              const host = sess.isRemote && sess.launcherHostname ? sess.launcherHostname : 'localhost';
              openUrlCompanion(`http://${host}:${sess.harnessAppPort}`);
              onClose();
            }}>
              Open App <kbd>O</kbd>
            </button>
          )}
        </div>
      </div>
      <div class={submenuClass('open-in')} onClick={(e: any) => e.stopPropagation()}>
        <button type="button" class="id-submenu-trigger" onClick={() => toggleSubmenu('open-in')}>Open In</button>
        <div class="id-submenu">
          <button class="popup-menu-item" onClick={() => { onClose(); panelAction(); }}>
            {panelLabel} <kbd>P</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => {
            onClose();
            const win = window.open(`#/session/${sessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
            if (win && context.mode === 'popout') removeSessionFromPanel(sessionId);
          }}>
            Window <kbd>W</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => {
            onClose();
            const win = window.open(`#/session/${sessionId}`, '_blank');
            if (win && context.mode === 'popout') removeSessionFromPanel(sessionId);
          }}>
            Browser Tab <kbd>B</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); openLocalTerminal(sessionId); }}>
            Terminal.app <kbd>T</kbd>
          </button>
          {canShowSplit && (
            <button class="popup-menu-item" onClick={() => { onClose(); (context as { enableSplit: () => void }).enableSplit(); }}>
              {'\u2AFF'} Split Panes <kbd>S</kbd>
            </button>
          )}
        </div>
      </div>
      <div class={submenuClass('restart')} onClick={(e: any) => e.stopPropagation()}>
        <button type="button" class="id-submenu-trigger" onClick={() => toggleSubmenu('restart')}>{isExited ? 'Resume as...' : 'Restart as...'}</button>
        <div class="id-submenu">
          {RUNTIME_OPTIONS.map((runtime) => {
            const rt = RUNTIME_INFO[runtime] || RUNTIME_INFO.claude;
            const runtimeActive = (sess?.runtime || 'claude') === runtime;
            const rtKey = `restart.${runtime}`;
            return (
              <div class={submenuClass(rtKey)} key={runtime}>
                <button type="button" class="id-submenu-trigger" onClick={() => toggleSubmenu(rtKey)}>
                  {runtimeActive ? '\u2713 ' : ''}{rt.icon} {rt.label}
                </button>
                <div class="id-submenu">
                  {DISPATCHABLE_PROFILES.map((profile) => {
                    const pd = PROFILE_MATRIX[profile];
                    const isActive = runtimeActive && sess?.permissionProfile === profile;
                    return (
                      <button
                        key={`${runtime}-${profile}`}
                        class="popup-menu-item"
                        onClick={() => { onClose(); resumeSession(sessionId, { runtime, permissionProfile: profile }); }}
                        title={`${rt.label} · ${pd.desc}`}
                      >
                        {isActive ? '\u2713 ' : ''}{pd.icon} {pd.longLabel}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PopupMenu>
  );
}
