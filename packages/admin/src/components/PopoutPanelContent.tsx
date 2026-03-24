import { type RefObject } from 'preact';
import { copyWithTooltip } from '../lib/clipboard.js';
import { PopupMenu } from './PopupMenu.js';
import {
  type PopoutPanelState,
  pendingFirstDigit,
  getSessionLabel,
  getTerminalCompanion,
  popBackIn,
  updatePanel,
  persistPopoutState,
  togglePanelCompanion,
  companionTabId,
  toggleAlwaysOnTop,
  buildTmuxAttachCmd,
  openUrlCompanion,
  termPickerOpen,
} from '../lib/sessions.js';
import { api } from '../lib/api.js';

export function PanelTabBadge({ tabNum }: { tabNum: number }) {
  const pending = pendingFirstDigit.value;
  const digits = String(tabNum);
  if (pending !== null) {
    const pendingStr = String(pending);
    if (!digits.startsWith(pendingStr)) {
      return <span class="tab-number-badge tab-badge-dimmed">{tabNum}</span>;
    }
    return (
      <span class="tab-number-badge tab-badge-pending">
        <span class="tab-badge-green">{pendingStr}</span>
        {digits.slice(pendingStr.length) || ''}
      </span>
    );
  }
  return <span class="tab-number-badge">{tabNum}</span>;
}

export function tabLabel(sid: string, sessionMap: Map<string, any>): string {
  if (sid === 'view:page') return 'Page';
  if (sid === 'view:controlbar') return 'Control Bar';
  if (sid === 'view:sessions-list') return 'Sessions';
  if (sid === 'view:terminals') return 'Terminals';
  if (sid === 'view:files') return 'Files';
  if (sid === 'view:nav') return 'Nav';
  if (sid === 'view:feedback') return 'Feedback';
  if (sid === 'view:aggregate') return 'Aggregate';
  if (sid === 'view:sessions-page') return 'Sessions';
  if (sid === 'view:live') return 'Live';
  if (sid.startsWith('view:files:')) return 'Files';
  if (sid.startsWith('view:git:')) return 'Git Changes';
  if (sid.startsWith('view:')) return sid.slice(5);
  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  const isFile = sid.startsWith('file:');
  const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile;
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const custom = getSessionLabel(sid);
  if (custom) return custom;
  const s = (isIsolate || isUrl || isFile) ? null : sessionMap.get(realSid);
  if (isJsonl) return `JSONL: ${s?.feedbackTitle || s?.agentName || realSid.slice(-6)}`;
  if (isFeedback) return `FB: ${s?.feedbackTitle || realSid.slice(-6)}`;
  if (isIframe) return `Page: ${realSid.slice(-6)}`;
  if (isTerminal) { const ts = getTerminalCompanion(realSid); if (ts === '__loading__') return 'Term: loading...'; const tSess = ts ? sessionMap.get(ts) : null; return `Term: ${tSess?.paneTitle || ts?.slice(-6) || realSid.slice(-6)}`; }
  if (isIsolate) return `Isolate: ${realSid}`;
  if (isUrl) { try { return `Iframe: ${new URL(realSid).hostname}`; } catch { return `Iframe: ${realSid.slice(0, 30)}`; } }
  if (isFile) { const parts = realSid.split('/'); return parts[parts.length - 1] || realSid.slice(-20); }
  const isPlainSess = s?.permissionProfile === 'plain';
  const plainLabel = s?.paneCommand
    ? `${s.paneCommand}:${s.panePath || ''} \u2014 ${s?.paneTitle || sid.slice(-6)}`
    : (s?.paneTitle || sid.slice(-6));
  return isPlainSess ? `\u{1F5A5}\uFE0F ${plainLabel}` : (s?.feedbackTitle || s?.agentName || `Session ${sid.slice(-6)}`);
}

export function companionCopyId(sid: string, sessionMap: Map<string, any>): string | null {
  if (sid.startsWith('terminal:')) {
    const realSid = sid.slice(sid.indexOf(':') + 1);
    const ts = getTerminalCompanion(realSid);
    return ts && ts !== '__loading__' ? ts : null;
  }
  if (sid.startsWith('jsonl:') || sid.startsWith('feedback:') || sid.startsWith('iframe:')) {
    return sid.slice(sid.indexOf(':') + 1);
  }
  return null;
}

export function IdDropdownMenu({ activeId, panel, session, isExited, anchorRef, onClose }: {
  activeId: string;
  panel: PopoutPanelState;
  session: any;
  isExited: boolean;
  anchorRef: RefObject<HTMLSpanElement>;
  onClose: () => void;
}) {
  const sessionMap = new Map(); // not needed for the menu items that use session directly
  return (
    <PopupMenu anchorRef={anchorRef as any} onClose={onClose} className="id-dropdown-menu">
      <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); onClose(); copyWithTooltip(activeId, e as any); }}>
        Copy {activeId} <kbd>C</kbd>
      </button>
      <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); onClose(); copyWithTooltip(buildTmuxAttachCmd(activeId, session), e as any); }}>
        Copy tmux command <kbd>T</kbd>
      </button>
      {session?.jsonlPath && (
        <button class="popup-menu-item" onClick={(e) => { e.stopPropagation(); onClose(); copyWithTooltip(session.jsonlPath, e as any); }}>
          Copy JSONL path <kbd>J</kbd>
        </button>
      )}
      {session?.jsonlPath && (() => {
        const panelRight = panel.rightPaneTabs || [];
        const jsonlActive = panelRight.includes(companionTabId(activeId, 'jsonl')) && panel.splitEnabled;
        return (
          <button class="popup-menu-item" onClick={() => { onClose(); togglePanelCompanion(panel.id, activeId, 'jsonl'); }}>
            {jsonlActive ? '\u2713 ' : ''}JSONL companion <kbd>L</kbd>
          </button>
        );
      })()}
      {session?.feedbackId && (() => {
        const panelRight = panel.rightPaneTabs || [];
        const fbActive = panelRight.includes(companionTabId(activeId, 'feedback')) && panel.splitEnabled;
        return (
          <button class="popup-menu-item" onClick={() => { onClose(); togglePanelCompanion(panel.id, activeId, 'feedback'); }}>
            {fbActive ? '\u2713 ' : ''}Feedback companion <kbd>F</kbd>
          </button>
        );
      })()}
      {session?.url && (() => {
        const panelRight = panel.rightPaneTabs || [];
        const iframeActive = panelRight.includes(companionTabId(activeId, 'iframe')) && panel.splitEnabled;
        return (
          <button class="popup-menu-item" onClick={() => { onClose(); togglePanelCompanion(panel.id, activeId, 'iframe'); }}>
            {iframeActive ? '\u2713 ' : ''}Page iframe <kbd>I</kbd>
          </button>
        );
      })()}
      {(() => {
        const panelRight = panel.rightPaneTabs || [];
        const termActive = panelRight.includes(companionTabId(activeId, 'terminal')) && panel.splitEnabled;
        return (
          <button class="popup-menu-item" onClick={(e: any) => {
            e.stopPropagation();
            onClose();
            if (termActive) {
              togglePanelCompanion(panel.id, activeId, 'terminal');
            } else {
              termPickerOpen.value = { kind: 'companion', sessionId: activeId, panelId: panel.id };
            }
          }}>
            {termActive ? '\u2713 ' : ''}Terminal companion <kbd>M</kbd>
          </button>
        );
      })()}
      {session?.isHarness && session?.harnessAppPort && (
        <button class="popup-menu-item" onClick={() => {
          const host = session.isRemote && session.launcherHostname ? session.launcherHostname : 'localhost';
          openUrlCompanion(`http://${host}:${session.harnessAppPort}`);
          onClose();
        }}>
          Open App <kbd>O</kbd>
        </button>
      )}
      <div class="popup-menu-divider" />
      <button class="popup-menu-item" onClick={() => { onClose(); popBackIn(activeId); }}>Pop back to tab bar <kbd>P</kbd></button>
      <button class="popup-menu-item" onClick={() => { onClose(); window.open(`#/session/${activeId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no'); }}>Open in window <kbd>W</kbd></button>
      <button class="popup-menu-item" onClick={() => { onClose(); window.open(`#/session/${activeId}`, '_blank'); }}>Open in browser tab <kbd>B</kbd></button>
      {!isExited && (
        <button class="popup-menu-item" onClick={() => { onClose(); api.openSessionInTerminal(activeId).catch(() => {}); }}>Open in Terminal.app <kbd>A</kbd></button>
      )}
    </PopupMenu>
  );
}

export function WindowMenu({ panel, activeId, docked, isLeftDocked, isMinimized, anchorRef, onClose }: {
  panel: PopoutPanelState;
  activeId: string | undefined;
  docked: boolean;
  isLeftDocked: boolean;
  isMinimized: boolean;
  anchorRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
}) {
  return (
    <PopupMenu anchorRef={anchorRef as any} onClose={onClose} className="window-menu" align="right">
      {activeId && (
        <button class="popup-menu-item" onClick={() => { onClose(); popBackIn(activeId); }}>
          {'\u2B05'} Pop in <kbd>S</kbd>
        </button>
      )}
      <button class="popup-menu-item" onClick={() => { onClose(); toggleAlwaysOnTop(panel.id); }}>
        {panel.alwaysOnTop ? '\u2713 ' : ''}{'\u{1F4CC}'} Pin on top <kbd>W</kbd>
      </button>
      {!docked && (
        <button class="popup-menu-item" onClick={() => { onClose(); updatePanel(panel.id, { minimized: !panel.minimized }); persistPopoutState(); }}>
          {isMinimized ? '\u25A1 Restore' : '\u2212 Minimize'} <kbd>Space</kbd>
        </button>
      )}
      {!docked && (
        <button class="popup-menu-item" onClick={() => {
          onClose();
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
        }}>
          {panel.maximized ? '\u25A3 Restore size' : '\u25A1 Maximize'} <kbd>M</kbd>
        </button>
      )}
      <div class="window-menu-separator" />
      <div class="window-menu-dock-row">
        <button
          class={isLeftDocked ? 'dock-active' : ''}
          onClick={() => {
            onClose();
            if (isLeftDocked) {
              updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
            } else {
              updatePanel(panel.id, { docked: true, dockedSide: 'left', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: docked ? panel.dockedWidth : panel.floatingRect.w });
            }
            persistPopoutState();
            window.dispatchEvent(new Event('resize'));
          }}
        >
          {'\u25C0'} Left <kbd>A</kbd>
        </button>
        <button
          class={docked && !isLeftDocked ? 'dock-active' : ''}
          onClick={() => {
            onClose();
            if (docked && !isLeftDocked) {
              updatePanel(panel.id, { docked: false, minimized: false, grabY: 0 });
            } else {
              updatePanel(panel.id, { docked: true, dockedSide: 'right', dockedTopOffset: 0, minimized: false, grabY: 0, dockedHeight: docked ? panel.dockedHeight : panel.floatingRect.h, dockedWidth: docked ? panel.dockedWidth : panel.floatingRect.w });
            }
            persistPopoutState();
            window.dispatchEvent(new Event('resize'));
          }}
        >
          Right {'\u25B6'} <kbd>D</kbd>
        </button>
      </div>
    </PopupMenu>
  );
}
