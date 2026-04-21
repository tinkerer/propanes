import { type RefObject } from 'preact';
import { PopupMenu } from './PopupMenu.js';
import { copyWithTooltip } from '../lib/clipboard.js';
import {
  getCompanions,
  toggleCompanion,
  togglePanelCompanion,
  companionTabId,
  popBackIn,
  popOutTab,
  resumeSession,
  openLocalTerminal,
  openUrlCompanion,
  termPickerOpen,
  type CompanionType,
  type PopoutPanelState,
} from '../lib/sessions.js';

export type SessionIdMenuContext =
  | { mode: 'tab'; canSplit?: boolean; enableSplit?: () => void }
  | { mode: 'popout'; panel: PopoutPanelState };

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
  const isCompanionActive = (type: CompanionType): boolean => {
    if (context.mode === 'tab') {
      return getCompanions(sessionId).includes(type);
    }
    const panel = context.panel;
    const panelRight = panel.rightPaneTabs || [];
    return panelRight.includes(companionTabId(sessionId, type)) && !!panel.splitEnabled;
  };

  const toggle = (type: CompanionType) => {
    if (context.mode === 'tab') {
      toggleCompanion(sessionId, type);
    } else {
      togglePanelCompanion(context.panel.id, sessionId, type);
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
    } else {
      popOutTab(sessionId);
    }
  };
  const panelLabel = context.mode === 'popout' ? 'Pop back to tab bar' : 'Panel';

  const canShowSplit = context.mode === 'tab' && context.canSplit && context.enableSplit;

  return (
    <PopupMenu anchorRef={anchorRef as any} onClose={onClose} className="id-dropdown-menu">
      <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
        <div class="id-submenu-trigger">Copy</div>
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
      <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
        <div class="id-submenu-trigger">Companion</div>
        <div class="id-submenu">
          {sess?.jsonlPath && (
            <button class="popup-menu-item" onClick={() => { onClose(); toggle('jsonl'); }}>
              {isCompanionActive('jsonl') ? '\u2713 ' : ''}JSONL <kbd>L</kbd>
            </button>
          )}
          {sess?.feedbackId && (
            <button class="popup-menu-item" onClick={() => { onClose(); toggle('feedback'); }}>
              {isCompanionActive('feedback') ? '\u2713 ' : ''}Feedback <kbd>F</kbd>
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
      <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
        <div class="id-submenu-trigger">Open In</div>
        <div class="id-submenu">
          <button class="popup-menu-item" onClick={() => { onClose(); panelAction(); }}>
            {panelLabel} <kbd>P</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); window.open(`#/session/${sessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no'); }}>
            Window <kbd>W</kbd>
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); window.open(`#/session/${sessionId}`, '_blank'); }}>
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
      <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
        <div class="id-submenu-trigger">{isExited ? 'Resume as...' : 'Restart as...'}</div>
        <div class="id-submenu">
          <button class="popup-menu-item" onClick={() => { onClose(); resumeSession(sessionId, { permissionProfile: 'interactive' }); }}>
            {sess?.permissionProfile === 'interactive' ? '\u2713 ' : ''}{'\uD83D\uDC41'} Interactive (supervised)
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); resumeSession(sessionId, { permissionProfile: 'interactive-yolo' }); }}>
            {sess?.permissionProfile === 'interactive-yolo' ? '\u2713 ' : ''}{'\u26A1'}{'\uD83D\uDC41'} Interactive YOLO
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); resumeSession(sessionId, { permissionProfile: 'auto' }); }}>
            {sess?.permissionProfile === 'auto' ? '\u2713 ' : ''}{'\uD83E\uDD16'} Headless (autonomous)
          </button>
          <button class="popup-menu-item" onClick={() => { onClose(); resumeSession(sessionId, { permissionProfile: 'yolo' }); }}>
            {sess?.permissionProfile === 'yolo' ? '\u2713 ' : ''}{'\u26A1'} Headless YOLO (skip permissions)
          </button>
        </div>
      </div>
    </PopupMenu>
  );
}
