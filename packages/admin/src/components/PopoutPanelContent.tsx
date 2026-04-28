import { type RefObject } from 'preact';
import { PopupMenu } from './PopupMenu.js';
import { SessionIdMenu } from './SessionIdMenu.js';
import {
  type PopoutPanelState,
  pendingFirstDigit,
  getSessionLabel,
  getTerminalCompanion,
  popBackIn,
  popBackInPanel,
  splitFromPanel,
  removeSessionFromPanel,
  removePanel,
  updatePanel,
  persistPopoutState,
  toggleAlwaysOnTop,
} from '../lib/sessions.js';
import { type PopoutMode } from '../lib/settings.js';
import { cosArtifacts } from '../lib/cos-artifacts.js';

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
  if (sid === 'view:sessions-list') return 'Sessions';
  if (sid === 'view:terminals') return 'Terminals';
  if (sid === 'view:files') return 'Files';
  if (sid === 'view:nav') return 'Nav';
  if (sid === 'view:feedback') return 'Tickets';
  if (sid === 'view:sessions-page') return 'Sessions';
  if (sid === 'view:live') return 'Live';
  if (sid === 'view:app-settings') return 'Settings';
  if (sid.startsWith('view:files:')) return 'Files';
  if (sid.startsWith('view:git:')) return 'Git Changes';
  if (sid.startsWith('view:')) return sid.slice(5);
  const isJsonl = sid.startsWith('jsonl:');
  const isSummary = sid.startsWith('summary:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  const isFile = sid.startsWith('file:');
  const isWiggumRuns = sid.startsWith('wiggum-runs:');
  const isArtifact = sid.startsWith('artifact:');
  const isCompanion = isJsonl || isSummary || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile || isWiggumRuns || isArtifact;
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const custom = getSessionLabel(sid);
  if (custom) return custom;
  const s = (isIsolate || isUrl || isFile || isWiggumRuns || isArtifact) ? null : sessionMap.get(realSid);
  if (isJsonl) return `JSONL: ${s?.feedbackTitle || s?.agentName || realSid.slice(-6)}`;
  if (isSummary) return `Summary: ${s?.feedbackTitle || s?.agentName || realSid.slice(-6)}`;
  if (isFeedback) return `Ticket: ${s?.feedbackTitle || realSid.slice(-6)}`;
  if (isIframe) return `Page: ${realSid.slice(-6)}`;
  if (isTerminal) { const ts = getTerminalCompanion(realSid); if (ts === '__loading__') return 'Term: loading...'; const tSess = ts ? sessionMap.get(ts) : null; return `Term: ${tSess?.paneTitle || ts?.slice(-6) || realSid.slice(-6)}`; }
  if (isIsolate) return `Isolate: ${realSid}`;
  if (isUrl) { try { return `Iframe: ${new URL(realSid).hostname}`; } catch { return `Iframe: ${realSid.slice(0, 30)}`; } }
  if (isFile) { const parts = realSid.split('/'); return parts[parts.length - 1] || realSid.slice(-20); }
  if (isWiggumRuns) return `Wiggum: ${realSid.slice(-6)}`;
  if (isArtifact) {
    const art = cosArtifacts.value[realSid];
    const prefix = art ? (art.kind === 'code' ? 'Code' : art.kind === 'table' ? 'Table' : 'List') : 'Artifact';
    return `${prefix}: ${art?.label || realSid.slice(-6)}`;
  }
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
  if (sid.startsWith('jsonl:') || sid.startsWith('summary:') || sid.startsWith('feedback:') || sid.startsWith('iframe:')) {
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
  return (
    <SessionIdMenu
      sessionId={activeId}
      sess={session}
      isExited={isExited}
      anchorRef={anchorRef as RefObject<HTMLElement>}
      onClose={onClose}
      context={{ mode: 'popout', panel }}
    />
  );
}

function PanelPopOutSection({ label, onPopout, onClose, includePanel }: { label: string; onPopout: (mode: PopoutMode) => void; onClose: () => void; includePanel: boolean }) {
  return (
    <>
      <div class="window-menu-section-header">{label}</div>
      {includePanel && (
        <button
          class="popup-menu-item window-menu-submenu-child"
          onClick={() => { onClose(); onPopout('panel'); }}
          title="Move into a separate panel"
        >
          {'◻'} New Panel
        </button>
      )}
      <button
        class="popup-menu-item window-menu-submenu-child"
        onClick={() => { onClose(); onPopout('window'); }}
        title="Open in a new browser window"
      >
        {'⤢'} New Window
      </button>
      <button
        class="popup-menu-item window-menu-submenu-child"
        onClick={() => { onClose(); onPopout('tab'); }}
        title="Open in a new browser tab"
      >
        {'⇗'} New Tab
      </button>
    </>
  );
}

function executePanelPopOutTab(panel: PopoutPanelState, sessionId: string, mode: PopoutMode) {
  switch (mode) {
    case 'panel':
      // Already in a panel — split this tab out into its own new panel.
      splitFromPanel(sessionId);
      break;
    case 'window': {
      const win = window.open(`#/session/${sessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
      if (win) removeSessionFromPanel(sessionId);
      break;
    }
    case 'tab': {
      const win = window.open(`#/session/${sessionId}`, '_blank');
      if (win) removeSessionFromPanel(sessionId);
      break;
    }
  }
}

function executePanelPopOutPanel(panel: PopoutPanelState, mode: PopoutMode) {
  if (mode === 'panel') return;
  const target = panel.activeSessionId || panel.sessionIds[0];
  if (!target) return;
  const win = mode === 'window'
    ? window.open(`#/session/${target}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
    : window.open(`#/session/${target}`, '_blank');
  if (win) {
    removePanel(panel.id);
    persistPopoutState();
  }
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
  const singleTab = panel.sessionIds.length <= 1;
  return (
    <PopupMenu anchorRef={anchorRef as any} onClose={onClose} className="window-menu" align="right">
      {!singleTab && <div class="window-menu-section-header">Pop In</div>}
      {singleTab && activeId && (
        <button class="popup-menu-item" onClick={() => { onClose(); popBackIn(activeId); }} title="Move back to a main pane">
          {'\u2B05'} Pop In <kbd>S</kbd>
        </button>
      )}
      {!singleTab && activeId && (
        <button class="popup-menu-item window-menu-submenu-child" onClick={() => { onClose(); popBackIn(activeId); }} title="Move the active tab back to a main pane">
          {'⬅'} Tab <kbd>S</kbd>
        </button>
      )}
      {!singleTab && panel.sessionIds.length > 0 && (
        <button class="popup-menu-item window-menu-submenu-child" onClick={() => { onClose(); popBackInPanel(panel.id); }} title="Move the whole panel back to a main pane">
          {'\u2B05'} Panel
        </button>
      )}
      {singleTab && activeId && (
        <PanelPopOutSection
          label="Pop Out"
          includePanel={false}
          onPopout={(mode) => executePanelPopOutTab(panel, activeId, mode)}
          onClose={onClose}
        />
      )}
      {!singleTab && activeId && (
        <PanelPopOutSection
          label="Pop Out Tab"
          includePanel={true}
          onPopout={(mode) => executePanelPopOutTab(panel, activeId, mode)}
          onClose={onClose}
        />
      )}
      {!singleTab && panel.sessionIds.length > 0 && (
        <PanelPopOutSection
          label="Pop Out Panel"
          includePanel={false}
          onPopout={(mode) => executePanelPopOutPanel(panel, mode)}
          onClose={onClose}
        />
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
