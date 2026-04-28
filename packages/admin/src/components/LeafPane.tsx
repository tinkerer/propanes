import { useRef, useCallback, useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { type ViewMode } from './SessionViewToggle.js';
import type { LeafNode } from '../lib/pane-tree.js';
import { PopupMenu } from './PopupMenu.js';
import { SessionIdMenu } from './SessionIdMenu.js';
import {
  setActiveTab,
  setFocusedLeaf,
  focusedLeafId,
  reorderTabInLeaf,
  removeTabFromLeaf,
  splitLeaf,
  mergeLeaf,
  toggleLeafCollapsed,
  setLeafCollapsedOffset,
  collapseLeafToEdge,
  findParent,
  layoutTree,
  setSplitRatio,
  SIDEBAR_LEAF_ID,
  PAGE_LEAF_ID,
  SESSIONS_LEAF_ID,
} from '../lib/pane-tree.js';
import { renderTabContent } from './PaneContent.js';
import {
  allSessions,
  sessionMapComputed,
  exitedSessions,
  getSessionLabel,
  setSessionLabel,
  getSessionColor,
  setSessionColor,
  SESSION_COLOR_PRESETS,
  getTerminalCompanion,
  closeTab,
  openSession,
  killSession,
  resumeSession,
  markSessionExited,
  resolveSession,
  sessionInputStates,
  allNumberedSessions,
  pendingFirstDigit,
  popOutTab,
  popOutLeafAsPanel,
  getViewMode,
  setViewMode,
  toggleCompanion,
  getCompanions,
  termPickerOpen,
  openUrlCompanion,
  jsonlFilesCache,
  jsonlDropdownOpen,
  fetchJsonlFiles,
  getJsonlSelectedFile,
  setJsonlSelectedFile,
  type JsonlFileInfo,
  hotkeyMenuOpen,
  getWorktreeLabel,
  activePanelId,
  popInPickerSessionId,
  popInPickerPanelId,
  popBackInToLeaf,
  popBackInToLeafWithSplit,
  popBackInPanelToLeaf,
  popBackInPanelToLeafWithSplit,
  feedbackTitleCache,
  getSettingsLabel,
  openFeedbackItem,
  openLocalTerminal,
} from '../lib/sessions.js';
import { startTabDrag, startLeafDrag, dragOverLeafZone } from '../lib/tab-drag.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { showHotkeyHints, popoutMode, type PopoutMode } from '../lib/settings.js';
import { selectedAppId, applications, appFeedbackCounts } from '../lib/state.js';
import { copyWithTooltip } from '../lib/clipboard.js';
import { cosArtifacts } from '../lib/cos-artifacts.js';

// --- Shared signals (also used by Layout.tsx for keyboard shortcuts) ---
export const statusMenuOpen = signal<{ sessionId: string; x: number; y: number } | null>(null);
export const idMenuOpen = signal<string | null>(null);
const companionIdMenuOpen = signal<string | null>(null);
const renamingSessionId = signal<string | null>(null);
const renameValue = signal('');

// --- Helpers ---

function executePopout(sessionId: string, mode: PopoutMode) {
  switch (mode) {
    case 'panel':
      popOutTab(sessionId);
      break;
    case 'window':
      // Also move into a popout panel so the tab is still accessible in the
      // main admin while the separate window holds the same session view.
      popOutTab(sessionId);
      window.open(`#/session/${sessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
      break;
    case 'tab':
      popOutTab(sessionId);
      window.open(`#/session/${sessionId}`, '_blank');
      break;
  }
}

function executePanePopout(leaf: LeafNode, mode: PopoutMode) {
  // Always consolidate the whole leaf into a popout panel first so the tabs
  // remain visible in the admin, even when also opening external targets.
  const target = leaf.activeTabId || leaf.tabs[0];
  popOutLeafAsPanel(leaf.id);
  if (mode === 'panel' || !target) return;
  // Browser window / tab can only show one session at a time; open the active
  // one as a convenience anchor alongside the popout panel.
  if (mode === 'window') {
    window.open(`#/session/${target}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
  } else {
    window.open(`#/session/${target}`, '_blank');
  }
}

// --- Sub-components ---

function TabBadge({ tabNum }: { tabNum: number }) {
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

function JsonlFileDropdown({ sessionId, sess }: { sessionId: string; sess: any }) {
  const [files, setFiles] = useState<JsonlFileInfo[]>([]);
  const [claudeUuid, setClaudeUuid] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string>(sess?.runtime || 'claude');
  const triggerRef = useRef<HTMLSpanElement>(null);
  const isOpen = jsonlDropdownOpen.value === sessionId;
  const selectedFile = getJsonlSelectedFile(sessionId);

  useEffect(() => {
    const cached = jsonlFilesCache.value.get(sessionId);
    if (cached) {
      setFiles(cached.files);
      setClaudeUuid(cached.claudeSessionId);
      setRuntime(cached.runtime || sess?.runtime || 'claude');
    }
    const refresh = (force = false) => {
      fetchJsonlFiles(sessionId, force).then((result) => {
        setFiles(result.files);
        setClaudeUuid(result.claudeSessionId);
        setRuntime(result.runtime || sess?.runtime || 'claude');
      }).catch(() => {});
    };
    refresh();
    const interval = setInterval(() => { if (!document.hidden) refresh(true); }, 10_000);
    return () => clearInterval(interval);
  }, [sessionId, sess?.runtime]);

  const shortUuid = claudeUuid ? claudeUuid.slice(0, 8) : sessionId.slice(-6);
  const runtimeLabel = runtime === 'codex' ? 'Codex' : 'Claude';

  return (
    <div class="id-dropdown-wrapper jsonl-file-dropdown">
      <span
        ref={triggerRef}
        class="session-id-label"
        onClick={() => { jsonlDropdownOpen.value = isOpen ? null : sessionId; }}
        title={claudeUuid ? `${runtimeLabel} session: ${claudeUuid}` : undefined}
      >
        JSONL: {shortUuid} {files.length > 1 && <span class="id-dropdown-caret">{'\u25BE'}</span>}
      </span>
      {selectedFile && (
        <span class="jsonl-file-badge" title={files.find(f => f.id === selectedFile)?.label || selectedFile}>
          {files.find(f => f.id === selectedFile)?.type === 'subagent' ? 'sub' : 'file'}
        </span>
      )}
      {isOpen && files.length > 0 && (
        <PopupMenu anchorRef={triggerRef} onClose={() => { jsonlDropdownOpen.value = null; }} className="jsonl-file-menu">
          <button
            class={`popup-menu-item${!selectedFile ? ' active' : ''}`}
            onClick={() => { setJsonlSelectedFile(sessionId, null); jsonlDropdownOpen.value = null; }}
          >
            {!selectedFile ? '\u2713 ' : ''}All (merged) — {files.length} file{files.length !== 1 ? 's' : ''}
          </button>
          <div class="popup-menu-divider" />
          {files.map(f => (
            <button
              key={f.id}
              class={`popup-menu-item${selectedFile === f.id ? ' active' : ''}`}
              onClick={() => { setJsonlSelectedFile(sessionId, f.id); jsonlDropdownOpen.value = null; }}
              title={`${runtimeLabel} ${f.type}: ${f.claudeSessionId}`}
            >
              {selectedFile === f.id ? '\u2713 ' : ''}
              {f.type === 'main' && '\u{1F4C4} '}
              {f.type === 'continuation' && '\u{1F517} '}
              {f.type === 'subagent' && '\u{1F916} '}
              {f.label}
            </button>
          ))}
        </PopupMenu>
      )}
    </div>
  );
}

function PaneHeader({
  sessionId,
  sessionMap,
  exited,
  leafId,
}: {
  sessionId: string | null;
  sessionMap: Map<string, any>;
  exited: Set<string>;
  leafId: string;
}) {
  const idMenuTriggerRef = useRef<HTMLSpanElement>(null);
  const isJsonlTab = sessionId?.startsWith('jsonl:') || false;
  const isFeedbackTab = sessionId?.startsWith('feedback:') || false;
  const isIframeTab = sessionId?.startsWith('iframe:') || false;
  const isTerminalTab = sessionId?.startsWith('terminal:') || false;
  const isIsolateTab = sessionId?.startsWith('isolate:') || false;
  const isUrlTab = sessionId?.startsWith('url:') || false;
  const isCompanionTab = isJsonlTab || isFeedbackTab || isIframeTab || isTerminalTab || isIsolateTab || isUrlTab;
  const realSessionId = isCompanionTab && sessionId ? sessionId.slice(sessionId.indexOf(':') + 1) : sessionId;
  const sess = realSessionId ? sessionMap.get(realSessionId) : null;
  const appId = selectedAppId.value;
  const feedbackPath = sess?.feedbackId
    ? appId ? `/app/${appId}/tickets/${sess.feedbackId}` : `/tickets/${sess.feedbackId}`
    : null;
  const viewMode = realSessionId ? getViewMode(realSessionId) : 'terminal';
  const isExited = realSessionId ? exited.has(realSessionId) : false;

  return (
    <div class="terminal-active-header">
      {sessionId && isCompanionTab && (
        <>
          {isJsonlTab ? (
            <JsonlFileDropdown sessionId={realSessionId!} sess={sess} />
          ) : isTerminalTab ? (
            (() => {
              const termSid = getTerminalCompanion(realSessionId!);
              const isLoading = termSid === '__loading__';
              const termSess = termSid && !isLoading ? sessionMap.get(termSid) : null;
              const showMenu = companionIdMenuOpen.value === sessionId;
              return (
                <div class="id-dropdown-wrapper">
                  <span
                    class="session-id-label"
                    style="cursor:pointer"
                    onClick={() => { companionIdMenuOpen.value = showMenu ? null : sessionId!; }}
                  >
                    {isLoading ? 'Terminal: loading...' : `Terminal: pw-${termSid?.slice(-6) || realSessionId!.slice(-6)}`}
                    {!isLoading && <span class="id-dropdown-caret">{'\u25BE'}</span>}
                  </span>
                  {showMenu && termSid && !isLoading && (
                    <div class="id-dropdown-menu" onClick={() => { companionIdMenuOpen.value = null; }}>
                      <button onClick={(e: any) => { e.stopPropagation(); companionIdMenuOpen.value = null; copyWithTooltip(termSid, e); }}>
                        Copy ID: {termSid.slice(-8)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          ) : (
            (() => {
              const showMenu = companionIdMenuOpen.value === sessionId;
              const label = isFeedbackTab ? `Ticket: pw-${realSessionId!.slice(-6)}`
                : isIframeTab ? `Page: pw-${realSessionId!.slice(-6)}`
                : isIsolateTab ? `Isolate: ${realSessionId}`
                : isUrlTab ? (() => { try { return `Iframe: ${new URL(realSessionId!).hostname}`; } catch { return `Iframe: ${realSessionId!.slice(0, 30)}`; } })()
                : `pw-${realSessionId!.slice(-6)}`;
              return (
                <div class="id-dropdown-wrapper">
                  <span
                    class="session-id-label"
                    style="cursor:pointer"
                    onClick={() => { companionIdMenuOpen.value = showMenu ? null : sessionId!; }}
                  >
                    {label}
                    <span class="id-dropdown-caret">{'\u25BE'}</span>
                  </span>
                  {showMenu && (
                    <div class="id-dropdown-menu" onClick={() => { companionIdMenuOpen.value = null; }}>
                      <button onClick={(e: any) => { e.stopPropagation(); companionIdMenuOpen.value = null; copyWithTooltip(realSessionId!, e); }}>
                        Copy ID: {realSessionId!.slice(-8)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          )}
          {feedbackPath && (
            <a href={`#${feedbackPath}`} onClick={(e) => { e.preventDefault(); if (sess?.feedbackId) openFeedbackItem(sess.feedbackId); }} class="feedback-title-link" title={sess?.feedbackTitle || 'View ticket'}>{sess?.feedbackTitle || 'View ticket'}</a>
          )}
        </>
      )}
      {sessionId && !isCompanionTab && (
        <>
          <div class="id-dropdown-wrapper">
            <span
              ref={idMenuTriggerRef}
              class="session-id-label"
              onClick={() => { idMenuOpen.value = idMenuOpen.value === sessionId ? null : sessionId; }}
            >
              pw-{sessionId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
            </span>
            {idMenuOpen.value === sessionId && (
              <SessionIdMenu
                sessionId={sessionId}
                sess={sess}
                isExited={isExited}
                anchorRef={idMenuTriggerRef}
                onClose={() => { idMenuOpen.value = null; }}
                context={{ mode: 'tab' }}
              />
            )}
          </div>
          {feedbackPath && (
            <a
              href={`#${feedbackPath}`}
              onClick={(e) => { e.preventDefault(); if (sess?.feedbackId) openFeedbackItem(sess.feedbackId); }}
              class="feedback-title-link"
              title={sess?.feedbackTitle || 'View feedback'}
            >
              {sess?.feedbackTitle || 'View feedback'}
            </a>
          )}
        </>
      )}
      <span style="flex:1" />
      {sessionId && !isCompanionTab && (
        <>
          {sess?.jsonlPath && (
            <select
              class="view-mode-select"
              value={viewMode}
              onChange={(e) => setViewMode(sessionId, (e.target as HTMLSelectElement).value as ViewMode)}
            >
              <option value="terminal">Term</option>
              <option value="structured">Struct</option>
              <option value="split">Split</option>
            </select>
          )}
          {sess?.feedbackId && (
            <button class="resolve-btn" onClick={() => resolveSession(sessionId, sess.feedbackId)}>Resolve</button>
          )}
          {isExited ? (
            <button class="resume-btn" onClick={() => resumeSession(sessionId)}>Resume</button>
          ) : (
            <button class="kill-btn" onClick={() => killSession(sessionId)}>Kill</button>
          )}
        </>
      )}
    </div>
  );
}

// --- Singleton metadata registry ---

interface SingletonMeta {
  label: string;
  countSuffix?: () => string;
  extraBadges?: () => any;
  appPrefix?: () => string;
  plusKind: 'new' | 'claude' | 'url';
}

function getSingletonMeta(sid: string): SingletonMeta {
  const appId = selectedAppId.value;
  const app = appId ? applications.value.find((a: any) => a.id === appId) : null;

  switch (sid) {
    case 'view:sessions-list': {
      return {
        label: 'Sessions',
        plusKind: 'claude',
        countSuffix: () => {
          const allSess2 = allSessions.value;
          const agents = allSess2.filter((s: any) => s.permissionProfile !== 'plain' && s.status !== 'deleted');
          return ` (${agents.length})`;
        },
        extraBadges: () => {
          const allSess2 = allSessions.value;
          const running = allSess2.filter((s: any) => s.status === 'running' && s.permissionProfile !== 'plain').length;
          const waiting = allSess2.filter((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting').length;
          return (
            <>
              {running > 0 && <span class="sidebar-running-badge">{running} running</span>}
              {waiting > 0 && <span class="sidebar-waiting-badge">{waiting} waiting</span>}
            </>
          );
        },
      };
    }
    case 'view:terminals':
      return {
        label: 'Terminals',
        plusKind: 'new',
        countSuffix: () => {
          const terminals = allSessions.value.filter((s: any) => s.permissionProfile === 'plain' && s.status !== 'deleted');
          return ` (${terminals.length})`;
        },
      };
    case 'view:feedback':
      return {
        label: 'Tickets',
        plusKind: 'new',
        appPrefix: () => app ? `${app.name} \u2014 ` : '',
        countSuffix: () => {
          const counts = appId ? appFeedbackCounts.value[appId] : null;
          if (counts && counts.total > 0) {
            const parts: string[] = [];
            if (counts.new > 0) parts.push(`${counts.new} new`);
            if (counts.running > 0) parts.push(`${counts.running} running`);
            parts.push(`${counts.total} total`);
            return ` (${parts.join(', ')})`;
          }
          return '';
        },
      };
    case 'view:sessions-page':
      return {
        label: 'Sessions',
        plusKind: 'new',
        appPrefix: () => app ? `${app.name} \u2014 ` : '',
      };
    case 'view:live':
      return {
        label: 'Live',
        plusKind: 'new',
        appPrefix: () => app ? `${app.name} \u2014 ` : '',
      };
    case 'view:app-settings':
      return {
        label: 'Settings',
        plusKind: 'new',
        appPrefix: () => app ? `${app.name} \u2014 ` : '',
      };
    case 'view:nav':
      return { label: 'Applications', plusKind: 'new' };
    case 'view:files':
      return { label: 'Files', plusKind: 'new' };
    case 'view:page':
      return { label: 'Page', plusKind: 'new' };
    default:
      return { label: getTabLabel(sid, new Map()), plusKind: 'new' };
  }
}

function getSingletonLabel(sid: string): string {
  return getSingletonMeta(sid).label;
}

// --- Tab label helper ---

function getTabLabel(sid: string, sessionMap: Map<string, any>): string {
  // View tabs
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

  // Settings tabs
  if (sid.startsWith('settings:')) {
    return getSettingsLabel(sid.slice(9));
  }

  // Feedback item tabs
  if (sid.startsWith('fb:')) {
    const customLabel = getSessionLabel(sid);
    if (customLabel) return customLabel;
    const fbId = sid.slice(3);
    const cached = feedbackTitleCache.value[fbId];
    if (cached) {
      const truncated = cached.length > 30 ? cached.slice(0, 30) + '…' : cached;
      return truncated;
    }
    return `FB: ${fbId.slice(-6)}`;
  }

  // Chief of Staff pane tab — single well-known ID, label by active agent name
  if (sid.startsWith('cos:')) {
    const customLabel = getSessionLabel(sid);
    if (customLabel) return customLabel;
    return 'Ops';
  }

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
  const sess = (isIsolate || isUrl || isFile || isWiggumRuns || isArtifact) ? null : sessionMap.get(realSid);

  const customLabel = getSessionLabel(sid);
  if (customLabel) return customLabel;

  if (isJsonl) return `JSONL: ${sess?.feedbackTitle || sess?.agentName || realSid.slice(-6)}`;
  if (isSummary) return `Summary: ${sess?.feedbackTitle || sess?.agentName || realSid.slice(-6)}`;
  if (isFeedback) return `FB: ${sess?.feedbackTitle || realSid.slice(-6)}`;
  if (isIframe) return `Page: ${realSid.slice(-6)}`;
  if (isTerminal) {
    const ts = getTerminalCompanion(realSid);
    if (ts === '__loading__') return 'Term: loading...';
    const tSess = ts ? sessionMap.get(ts) : null;
    return `Term: ${tSess?.paneTitle || ts?.slice(-6) || realSid.slice(-6)}`;
  }
  if (isIsolate) return `Isolate: ${realSid}`;
  if (isUrl) { try { return `Iframe: ${new URL(realSid).hostname}`; } catch { return `Iframe: ${realSid.slice(0, 30)}`; } }
  if (isFile) { const parts = realSid.split('/'); return parts[parts.length - 1] || realSid.slice(-20); }
  if (isWiggumRuns) return `Wiggum: ${realSid.slice(-6)}`;
  if (isArtifact) {
    const art = cosArtifacts.value[realSid];
    const prefix = art ? (art.kind === 'code' ? 'Code' : art.kind === 'table' ? 'Table' : 'List') : 'Artifact';
    return `${prefix}: ${art?.label || realSid.slice(-6)}`;
  }

  const isPlain = sess?.permissionProfile === 'plain';
  if (isPlain) {
    const plainLabel = sess?.paneCommand
      ? `${sess.paneCommand}:${sess.panePath || ''} \u2014 ${sess?.paneTitle || realSid.slice(-6)}`
      : (sess?.paneTitle || realSid.slice(-6));
    return `${sess?.isHarness ? '\u{1F4E6}' : sess?.isRemote ? '\u{1F310}' : '\u{1F5A5}\uFE0F'} ${plainLabel}`;
  }
  const locationPrefix = sess?.isHarness ? '\u{1F4E6}' : sess?.isRemote ? '\u{1F310}' : '';
  return `${locationPrefix ? locationPrefix + ' ' : ''}${sess?.feedbackTitle || sess?.agentName || `Session ${sid.slice(-6)}`}`;
}

// --- Diagonal drop zone (shown during tab drag) ---

function SplitSubmenuItem({ leafId, closeMenu }: { leafId: string; closeMenu: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class="popup-menu-item pane-action-item pane-submenu-trigger"
        onClick={() => setOpen(!open)}
        title="Split this pane"
      >
        <span class="pane-action-icon">{'▣'}</span> Split Pane
        <span class="pane-submenu-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); splitLeaf(leafId, 'horizontal', 'first', [], 0.5, true); }}
          >
            <span class="pane-action-icon">{'│'}</span> Split Left
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); splitLeaf(leafId, 'horizontal', 'second', [], 0.5, true); }}
          >
            <span class="pane-action-icon">{'│'}</span> Split Right <kbd>{'⌃⇧'}"</kbd>
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); splitLeaf(leafId, 'vertical', 'first', [], 0.5, true); }}
          >
            <span class="pane-action-icon">{'─'}</span> Split Above
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); splitLeaf(leafId, 'vertical', 'second', [], 0.5, true); }}
          >
            <span class="pane-action-icon">{'─'}</span> Split Down <kbd>{'⌃⇧'}-</kbd>
          </button>
        </>
      )}
    </>
  );
}

function CollapseSubmenuItem({ leafId, collapsed, closeMenu }: { leafId: string; collapsed: boolean; closeMenu: () => void }) {
  const [open, setOpen] = useState(false);
  if (collapsed) {
    return (
      <button
        class="popup-menu-item pane-action-item"
        onClick={() => { closeMenu(); toggleLeafCollapsed(leafId); }}
      >
        <span class="pane-action-icon">{'▸'}</span> Expand Pane
      </button>
    );
  }
  return (
    <>
      <button
        class="popup-menu-item pane-action-item pane-submenu-trigger"
        onClick={() => setOpen(!open)}
        title="Collapse to an edge handle"
      >
        <span class="pane-action-icon">{'−'}</span> Collapse Pane
        <span class="pane-submenu-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); collapseLeafToEdge(leafId, 'W'); }}
          >
            <span class="pane-action-icon">{'◂'}</span> Collapse to Left
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); collapseLeafToEdge(leafId, 'E'); }}
          >
            <span class="pane-action-icon">{'▸'}</span> Collapse to Right
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); collapseLeafToEdge(leafId, 'N'); }}
          >
            <span class="pane-action-icon">{'▴'}</span> Collapse to Top
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); collapseLeafToEdge(leafId, 'S'); }}
          >
            <span class="pane-action-icon">{'▾'}</span> Collapse to Bottom
          </button>
        </>
      )}
    </>
  );
}

function PopOutSubmenuItem({ label, title, onPopout, closeMenu }: { label: string; title: string; onPopout: (mode: PopoutMode) => void; closeMenu: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class="popup-menu-item pane-action-item pane-submenu-trigger"
        onClick={() => setOpen(!open)}
        title={title}
      >
        <span class="pane-action-icon">{'⬆'}</span> {label}
        <span class="pane-submenu-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); onPopout('panel'); }}
            title="Pop out into a new docked panel"
          >
            <span class="pane-action-icon">{'◻'}</span> New Panel
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); onPopout('window'); }}
            title="Pop out into a new browser window"
          >
            <span class="pane-action-icon">{'⤢'}</span> New Window
          </button>
          <button
            class="popup-menu-item pane-action-item pane-submenu-child"
            onClick={() => { setOpen(false); closeMenu(); onPopout('tab'); }}
            title="Pop out into a new browser tab"
          >
            <span class="pane-action-icon">{'⇗'}</span> New Tab
          </button>
        </>
      )}
    </>
  );
}

function DiagonalDropZone({ leafId }: { leafId: string }) {
  const zone = dragOverLeafZone.value;
  if (!zone || zone.leafId !== leafId) return null;
  const activeZone = zone.zone;
  if (activeZone === 'tab') return null;
  if (activeZone === 'self-popout') {
    return (
      <div class="self-popout-zone" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 90 }}>
        <div class="self-popout-zone-inner active">
          <span class="self-popout-zone-label">{'⬆'} Drop to pop out</span>
        </div>
      </div>
    );
  }
  return (
    <div class="diagonal-drop-zone" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 90 }}>
      <div class={`diagonal-zone diagonal-zone-vsplit${activeZone === 'v-split' ? ' active' : ''}`}>
        <span class="diagonal-zone-label">{'\u2550'} Split Down</span>
      </div>
      <div class={`diagonal-zone diagonal-zone-hsplit${activeZone === 'h-split' ? ' active' : ''}`}>
        <span class="diagonal-zone-label">{'\u2551'} Split Right</span>
      </div>
      <div class="diagonal-line" />
    </div>
  );
}

// --- Pop-in picker overlay with diagonal zones ---

function PopInPickerOverlay({ leafId }: { leafId: string }) {
  const pickSid = popInPickerSessionId.value;
  const pickPanel = popInPickerPanelId.value;
  if (!pickSid && !pickPanel) return null;
  const tabLabel = pickPanel ? 'Add panel as Tabs' : 'Add as Tab';
  const handleTab = () => {
    if (pickPanel) {
      popInPickerPanelId.value = null;
      popBackInPanelToLeaf(pickPanel, leafId);
    } else if (pickSid) {
      popInPickerSessionId.value = null;
      popBackInToLeaf(pickSid, leafId);
    }
  };
  const handleVsplit = () => {
    if (pickPanel) {
      popInPickerPanelId.value = null;
      popBackInPanelToLeafWithSplit(pickPanel, leafId, 'vertical');
    } else if (pickSid) {
      popInPickerSessionId.value = null;
      popBackInToLeafWithSplit(pickSid, leafId, 'vertical');
    }
  };
  const handleHsplit = () => {
    if (pickPanel) {
      popInPickerPanelId.value = null;
      popBackInPanelToLeafWithSplit(pickPanel, leafId, 'horizontal');
    } else if (pickSid) {
      popInPickerSessionId.value = null;
      popBackInToLeafWithSplit(pickSid, leafId, 'horizontal');
    }
  };
  return (
    <div class="pop-in-picker-overlay pop-in-picker-zones" onClick={(e) => e.stopPropagation()}>
      <div
        class="pop-in-zone pop-in-zone-tab"
        onClick={handleTab}
      >
        <span class="pop-in-zone-label">{tabLabel}</span>
      </div>
      <div
        class="pop-in-zone pop-in-zone-vsplit"
        onClick={handleVsplit}
      >
        <span class="pop-in-zone-label">{'\u2550'} Split Down</span>
      </div>
      <div
        class="pop-in-zone pop-in-zone-hsplit"
        onClick={handleHsplit}
      >
        <span class="pop-in-zone-label">{'\u2551'} Split Right</span>
      </div>
    </div>
  );
}

// --- Main component ---

interface LeafPaneProps {
  leaf: LeafNode;
}

export function LeafPane({ leaf }: LeafPaneProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const [paneMenuOpen] = useState(() => signal(false));
  // Only subscribe to session signals if this leaf has non-view tabs
  const hasSessionTabs = leaf.tabs.some(t => !t.startsWith('view:'));
  const sessionMap = hasSessionTabs ? sessionMapComputed.value : new Map<string, any>();
  const exited = hasSessionTabs ? exitedSessions.value : new Set<string>();
  const isFocused = focusedLeafId.value === leaf.id;
  const globalSessions = hasSessionTabs ? allNumberedSessions() : [];
  const activeId = leaf.activeTabId;

  const handleActivate = useCallback((sid: string) => {
    setActiveTab(leaf.id, sid);
    setFocusedLeaf(leaf.id);
    if (!sid.startsWith('view:') && !sid.startsWith('cos:')) openSession(sid);
  }, [leaf.id]);

  const handleClose = useCallback((sid: string) => {
    if (sid.startsWith('view:') || sid.startsWith('cos:')) {
      removeTabFromLeaf(leaf.id, sid);
      return;
    }
    closeTab(sid);
  }, [leaf.id]);

  const handleMouseDown = useCallback(() => {
    if (focusedLeafId.value !== leaf.id) {
      setFocusedLeaf(leaf.id);
    }
    activePanelId.value = null;
  }, [leaf.id]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!activeId) return;
    requestAnimationFrame(() => {
      const container = tabsRef.current;
      if (!container) return;
      const el = container.querySelector('.pane-leaf-tab.active') as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    });
  }, [activeId, leaf.tabs.length]);

  // Outside-click handlers for menus
  useEffect(() => {
    if (!statusMenuOpen.value) return;
    const close = () => { statusMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [statusMenuOpen.value]);

  useEffect(() => {
    if (!companionIdMenuOpen.value) return;
    const close = () => { companionIdMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [companionIdMenuOpen.value]);

  // ID menu keyboard shortcuts
  useEffect(() => {
    const menuSessionId = idMenuOpen.value;
    if (!menuSessionId) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      let handled = true;
      const sess = sessionMap.get(menuSessionId);
      if (key === 'c') {
        navigator.clipboard.writeText(menuSessionId);
      } else if (key === 'p') {
        executePopout(menuSessionId, 'panel');
      } else if (key === 'w') {
        executePopout(menuSessionId, 'window');
      } else if (key === 'b') {
        executePopout(menuSessionId, 'tab');
      } else if (key === 'j') {
        if (sess?.jsonlPath) navigator.clipboard.writeText(sess.jsonlPath);
      } else if (key === 'd') {
        if (sess?.feedbackId) navigator.clipboard.writeText(sess.feedbackId);
      } else if (key === 'l') {
        if (sess?.jsonlPath) toggleCompanion(menuSessionId, 'jsonl');
      } else if (key === 'y') {
        if (sess?.jsonlPath) toggleCompanion(menuSessionId, 'summary');
      } else if (key === 'f') {
        if (sess?.feedbackId) toggleCompanion(menuSessionId, 'feedback');
      } else if (key === 'i') {
        if (sess?.url) toggleCompanion(menuSessionId, 'iframe');
      } else if (key === 'm') {
        const companions = getCompanions(menuSessionId);
        if (companions.includes('terminal')) {
          toggleCompanion(menuSessionId, 'terminal');
        } else {
          termPickerOpen.value = { kind: 'companion', sessionId: menuSessionId };
        }
      } else if (key === 'u') {
        termPickerOpen.value = { kind: 'url' };
      } else if (key === 'o') {
        if (sess?.isHarness && sess?.harnessAppPort) {
          const host = sess.isRemote && sess.launcherHostname ? sess.launcherHostname : 'localhost';
          openUrlCompanion(`http://${host}:${sess.harnessAppPort}`);
        }
      } else if (key === 'escape') {
        // just close
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        idMenuOpen.value = null;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [idMenuOpen.value]);

  // Hotkey hint menu (Ctrl+Shift) — also auto-opens pane hamburger menu
  useEffect(() => {
    const held = ctrlShiftHeld.value;
    if (!held || !activeId || !showHotkeyHints.value || !isFocused) {
      if (isFocused) {
        hotkeyMenuOpen.value = null;
        paneMenuOpen.value = false;
      }
      return;
    }

    paneMenuOpen.value = true;

    function updatePos() {
      const dot = tabsRef.current?.querySelector('.pane-leaf-tab.active .status-dot') as HTMLElement | null;
      const scrollBox = tabsRef.current;
      if (!dot || !scrollBox) { if (isFocused) hotkeyMenuOpen.value = null; return; }
      const dotRect = dot.getBoundingClientRect();
      const scrollRect = scrollBox.getBoundingClientRect();
      if (dotRect.right < scrollRect.left || dotRect.left > scrollRect.right) {
        hotkeyMenuOpen.value = null;
        return;
      }
      const x = Math.max(scrollRect.left, Math.min(dotRect.left, scrollRect.right - 120));
      const y = dotRect.bottom + 4;
      hotkeyMenuOpen.value = { sessionId: activeId!, x, y };
    }

    updatePos();
    const scrollEl = tabsRef.current;
    scrollEl?.addEventListener('scroll', updatePos, { passive: true });
    return () => scrollEl?.removeEventListener('scroll', updatePos);
  }, [ctrlShiftHeld.value, activeId, isFocused]);

  if (leaf.tabs.length === 0) {
    return (
      <div
        class={`pane-leaf pane-leaf-empty${isFocused ? ' pane-leaf-focused' : ''}`}
        data-leaf-id={leaf.id}
        onMouseDown={handleMouseDown}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', width: '100%', height: '100%' }}
      >
        <span
          style={{ opacity: 0.4, fontSize: '24px', cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); setFocusedLeaf(leaf.id); termPickerOpen.value = { kind: 'new' }; }}
          title="Add a tab"
        >+</span>
        <span
          style={{ opacity: 0.4, fontSize: '20px', cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); mergeLeaf(leaf.id); }}
          title="Close pane"
        >&times;</span>
        {(popInPickerSessionId.value || popInPickerPanelId.value) && (
          <PopInPickerOverlay leafId={leaf.id} />
        )}
      </div>
    );
  }

  if (leaf.tabs.length === 1 && (leaf.singleton || leaf.tabs[0].startsWith('view:'))) {
    const sid = leaf.tabs[0];
    const meta = getSingletonMeta(sid);
    const label = meta.label;
    const collapsed = !!leaf.collapsed;
    const countSuffix = meta.countSuffix?.() || '';
    const extraBadges = meta.extraBadges?.() || null;
    const appPrefix = meta.appPrefix?.() || '';

    const plusAction = () => {
      setFocusedLeaf(leaf.id);
      termPickerOpen.value = { kind: meta.plusKind };
    };

    return (
      <div
        class={`pane-leaf pane-leaf-singleton${isFocused ? ' pane-leaf-focused' : ''}${collapsed ? ' pane-leaf-collapsed' : ''}`}
        data-leaf-id={leaf.id}
        onMouseDown={handleMouseDown}
        style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}
      >
        <div
          class="singleton-handle"
          onMouseDown={(e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('button, .singleton-collapse-icon')) return;
            startTabDrag(e, {
              sessionId: sid,
              source: { type: 'leaf', leafId: leaf.id },
              label: label || sid,
              onClickFallback: () => {},
            });
          }}
        >
          <span
            class={`singleton-collapse-icon${collapsed ? '' : ' expanded'}`}
            onClick={(e) => { e.stopPropagation(); toggleLeafCollapsed(leaf.id); }}
            title={collapsed ? 'Expand' : 'Collapse'}
          >{'\u25B8'}</span>
          <span class="singleton-label">{appPrefix}{label}{countSuffix}</span>
          {extraBadges}
          <span style={{ flex: 1 }} />
          <button
            class="sidebar-new-terminal-btn"
            onClick={(e) => { e.stopPropagation(); plusAction(); }}
            title="Add tab"
          >+</button>
          <button
            class="sidebar-new-terminal-btn"
            onClick={(e) => { e.stopPropagation(); mergeLeaf(leaf.id); }}
            title="Close pane"
          >&times;</button>
        </div>
        {!collapsed && (
          <div class="pane-leaf-body" style={{ position: 'relative' }}>
            {renderTabContent(sid, true, sessionMap)}
            <DiagonalDropZone leafId={leaf.id} />
          </div>
        )}
        {(popInPickerSessionId.value || popInPickerPanelId.value) && (
          <PopInPickerOverlay leafId={leaf.id} />
        )}
      </div>
    );
  }

  const multiCollapsed = !!leaf.collapsed;

  if (multiCollapsed) {
    const parent = findParent(layoutTree.value.root, leaf.id);
    const parentDir = parent?.direction ?? 'horizontal';
    const isFirst = parent ? parent.children[0].id === leaf.id : true;
    // Horizontal parent split = vertical handle (attached to E or W edge).
    // Vertical parent split = horizontal handle (attached to N or S edge).
    const edge: 'N' | 'S' | 'E' | 'W' = parentDir === 'horizontal'
      ? (isFirst ? 'W' : 'E')
      : (isFirst ? 'N' : 'S');
    const activeTab = leaf.activeTabId || leaf.tabs[0];
    const label = activeTab ? getTabLabel(activeTab, sessionMap) : '';
    const offset = leaf.collapsedOffset || 0;
    const chevron = edge === 'W' ? '▸'
      : edge === 'E' ? '◂'
      : edge === 'N' ? '▾'
      : '▴';

    const onHandleMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handleMouseDown();

      const handleEl = e.currentTarget as HTMLElement;
      // Walk up to the SplitPane that owns this leaf — we need its bounding
      // rect to compute the expanded ratio.
      const splitContainer = handleEl.closest('.pane-split') as HTMLElement | null;
      const rect = splitContainer?.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startOffset = offset;
      const DRAG_THRESHOLD = 4;
      let moved = false;
      let axis: 'along' | 'cross' | null = null;

      const parallelIsY = parentDir === 'horizontal'; // handle is vertical → parallel axis is Y
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          moved = true;
          const parallelMag = Math.abs(parallelIsY ? dy : dx);
          const crossMag = Math.abs(parallelIsY ? dx : dy);
          axis = parallelMag > crossMag ? 'along' : 'cross';
        }
        if (!moved || !axis) return;
        if (axis === 'along') {
          // Slide handle along the edge (reposition).
          const delta = parallelIsY ? dy : dx;
          setLeafCollapsedOffset(leaf.id, startOffset + delta);
        } else if (rect && parent) {
          // Cross-axis drag = expand + set split ratio at drag position.
          const newRatio = parentDir === 'horizontal'
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;
          setSplitRatio(parent.id, Math.max(0.05, Math.min(0.95, newRatio)),
            parentDir === 'horizontal' ? rect.width : rect.height);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Click (no movement) OR cross-axis drag (expand) → uncollapse.
        // Along-axis drag keeps it collapsed with a new offset.
        if (!moved || axis === 'cross') {
          toggleLeafCollapsed(leaf.id);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    const offsetStyle = parentDir === 'horizontal'
      ? { transform: `translateY(${offset}px)` }
      : { transform: `translateX(${offset}px)` };

    return (
      <div
        class={`pane-leaf pane-leaf-collapsed pane-leaf-collapsed-multi pane-leaf-collapsed-${parentDir} pane-leaf-collapsed-edge-${edge}${isFocused ? ' pane-leaf-focused' : ''}`}
        data-leaf-id={leaf.id}
        onMouseDown={onHandleMouseDown}
        title={`Drag to resize, click to expand (${leaf.tabs.length} tab${leaf.tabs.length === 1 ? '' : 's'})${label ? ': ' + label : ''}`}
        style={offsetStyle}
      >
        <span class="pane-leaf-collapsed-icon">{chevron}</span>
        <span class="pane-leaf-collapsed-count">{leaf.tabs.length}</span>
        {label && <span class="pane-leaf-collapsed-label">{label}</span>}
      </div>
    );
  }

  return (
    <div
      class={`pane-leaf${isFocused ? ' pane-leaf-focused' : ''}`}
      data-leaf-id={leaf.id}
      onMouseDown={handleMouseDown}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden', position: 'relative', zIndex: isFocused && activePanelId.value == null ? 1000 : undefined }}
    >
      <div class="terminal-tab-bar">
        <div
          ref={tabsRef}
          class="pane-leaf-tabs"
          onWheel={(e) => { const d = (e as WheelEvent).deltaX || (e as WheelEvent).deltaY; if (d) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += d; } }}
        >
          {leaf.tabs.map((sid) => {
            const isView = sid.startsWith('view:');
            const isJsonl = sid.startsWith('jsonl:');
            const isSummary = sid.startsWith('summary:');
            const isFeedback = sid.startsWith('feedback:');
            const isFb = sid.startsWith('fb:');
            const isIframe = sid.startsWith('iframe:');
            const isTerminal = sid.startsWith('terminal:');
            const isIsolate = sid.startsWith('isolate:');
            const isUrl = sid.startsWith('url:');
            const isFile = sid.startsWith('file:');
            const isSettings = sid.startsWith('settings:');
            const isWiggumRuns = sid.startsWith('wiggum-runs:');
            const isArtifact = sid.startsWith('artifact:');
            const isCos = sid.startsWith('cos:');
            const isCompanion = isView || isJsonl || isSummary || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile || isSettings || isWiggumRuns || isArtifact || isCos;
            const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
            const isActive = sid === leaf.activeTabId;
            const isExited = exited.has(realSid);
            const sess = (isView || isIsolate || isUrl || isFile) ? null : sessionMap.get(realSid);
            const isPlain = !isCompanion && sess?.permissionProfile === 'plain';
            const inputState = !isExited && !isCompanion ? (sessionInputStates.value.get(sid) || null) : null;
            const label = getTabLabel(sid, sessionMap);
            const customLabel = getSessionLabel(sid);
            const globalIdx = globalSessions.indexOf(sid);
            const tabNum = globalIdx >= 0 ? globalIdx + 1 : null;

            const worktreeLabel = !isCompanion ? getWorktreeLabel(sess) : null;

            const tabTooltipParts: string[] = [];
            if (!isCompanion && sess?.isHarness) tabTooltipParts.push(`Harness: ${sess.harnessName || 'unknown'}`);
            else if (!isCompanion && sess?.isRemote) tabTooltipParts.push(`Remote: ${sess.machineName || sess.launcherHostname || 'unknown'}`);
            if (sess?.paneCommand) tabTooltipParts.push(`Process: ${sess.paneCommand}`);
            if (sess?.panePath) tabTooltipParts.push(`Path: ${sess.panePath}`);
            else if (sess?.cwd) tabTooltipParts.push(`Path: ${sess.cwd}`);
            tabTooltipParts.push(label);
            const tabTooltip = tabTooltipParts.length > 1 ? tabTooltipParts.join('\n') : label;

            return (
              <button
                key={sid}
                class={`pane-leaf-tab${isActive ? ' active' : ''}`}
                style={getSessionColor(sid) ? { boxShadow: `inset 0 -2px 0 ${getSessionColor(sid)}` } : undefined}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  startTabDrag(e, {
                    sessionId: sid,
                    source: { type: 'leaf', leafId: leaf.id },
                    label,
                    onClickFallback: () => handleActivate(sid),
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !renamingSessionId.value) {
                    e.preventDefault();
                    handleActivate(sid);
                  }
                }}
                title={tabTooltip}
                onDblClick={(e) => {
                  e.stopPropagation();
                  renameValue.value = customLabel || '';
                  renamingSessionId.value = sid;
                }}
              >
                {!isCompanion && !isFb && <span
                  class={`status-dot ${isExited ? 'exited' : ''}${isPlain ? ' plain' : ''}${inputState ? ` ${inputState}` : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    statusMenuOpen.value = { sessionId: sid, x: rect.left, y: rect.bottom + 4 };
                  }}
                >
                  {ctrlShiftHeld.value && tabNum !== null && (
                    <TabBadge tabNum={tabNum} />
                  )}
                </span>}
                {(isCompanion || isFb) && !isView && <span class="companion-icon">{
                  (isFeedback || isFb) ? '\u{1F4AC}' :
                  isJsonl ? '\u{1F4DC}' :
                  isSummary ? '\u{1F4CA}' :
                  isIframe ? '\u{1F310}' :
                  isTerminal ? '\u{25B8}' :
                  isUrl ? '\u{1F517}' :
                  isFile ? '\u{1F4C4}' :
                  isWiggumRuns ? '\u{1F43B}' :
                  isArtifact ? '\u{1F4CB}' :
                  isSettings ? '\u2699' :
                  isCos ? '\u2B50' :
                  '\u25C6'
                }</span>}
                {renamingSessionId.value === sid ? (
                  <input
                    type="text"
                    value={renameValue.value}
                    onInput={(e) => { renameValue.value = (e.target as HTMLInputElement).value; }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { setSessionLabel(sid, renameValue.value); renamingSessionId.value = null; }
                      if (e.key === 'Escape') { renamingSessionId.value = null; }
                    }}
                    onBlur={() => { setSessionLabel(sid, renameValue.value); renamingSessionId.value = null; }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    style="font-size:11px;padding:1px 4px;border:1px solid var(--pw-accent);border-radius:3px;background:var(--pw-input-bg);color:var(--pw-primary-text);width:120px;outline:none"
                    ref={(el) => el?.focus()}
                  />
                ) : (
                  <span class="pane-leaf-tab-label">{label}{worktreeLabel && <span class="worktree-badge" title={sess?.panePath || sess?.cwd || ''}>[{worktreeLabel}]</span>}</span>
                )}
                <span class="tab-close" onClick={(e) => { e.stopPropagation(); handleClose(sid); }}>&times;</span>
              </button>
            );
          })}
        </div>
        <div class="terminal-tab-actions">
          <button
            class="terminal-collapse-btn pane-tab-new-btn"
            title="New terminal / tab"
            onClick={(e) => { e.stopPropagation(); termPickerOpen.value = { kind: 'new' }; }}
          >{'+'}</button>
          <button
            ref={hamburgerRef}
            class="terminal-collapse-btn pane-hamburger-btn"
            title="Pane actions (drag to pop out the whole pane)"
            onMouseDown={(e) => {
              e.stopPropagation();
              startLeafDrag(e, {
                leafId: leaf.id,
                label: `Pane: ${leaf.tabs.length} tab${leaf.tabs.length === 1 ? '' : 's'}`,
                onClickFallback: () => { paneMenuOpen.value = !paneMenuOpen.value; },
              });
            }}
          >{'\u2630'}</button>
          <button
            class="terminal-collapse-btn pane-tab-close-btn"
            title="Close pane"
            onClick={(e) => { e.stopPropagation(); mergeLeaf(leaf.id); }}
          >{'\u00D7'}</button>
          {paneMenuOpen.value && (
            <PopupMenu anchorRef={hamburgerRef} align="right" onClose={() => { paneMenuOpen.value = false; }}>
              {leaf.tabs.length === 1 && activeId ? (
                <PopOutSubmenuItem
                  label="Pop Out"
                  title="Pop out this tab"
                  onPopout={(mode) => { paneMenuOpen.value = false; executePanePopout(leaf, mode); }}
                  closeMenu={() => { paneMenuOpen.value = false; }}
                />
              ) : (
                <>
                  {leaf.tabs.length > 0 && (
                    <PopOutSubmenuItem
                      label="Pop Out Panel"
                      title="Pop out the whole pane with all its tabs"
                      onPopout={(mode) => { paneMenuOpen.value = false; executePanePopout(leaf, mode); }}
                      closeMenu={() => { paneMenuOpen.value = false; }}
                    />
                  )}
                  {activeId && (
                    <PopOutSubmenuItem
                      label="Pop Out Tab"
                      title="Pop out just the active tab"
                      onPopout={(mode) => { paneMenuOpen.value = false; executePopout(activeId, mode); }}
                      closeMenu={() => { paneMenuOpen.value = false; }}
                    />
                  )}
                </>
              )}
              <SplitSubmenuItem leafId={leaf.id} closeMenu={() => { paneMenuOpen.value = false; }} />
              <CollapseSubmenuItem leafId={leaf.id} collapsed={!!leaf.collapsed} closeMenu={() => { paneMenuOpen.value = false; }} />
            </PopupMenu>
          )}
        </div>
      </div>

      {/* Status dot menu */}
      {statusMenuOpen.value && (() => {
        const menuSid = statusMenuOpen.value!.sessionId;
        const menuSess = sessionMap.get(menuSid);
        const menuExited = exited.has(menuSid);
        return (
          <div
            class="status-dot-menu"
            style={{ left: `${statusMenuOpen.value!.x}px`, top: `${statusMenuOpen.value!.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {!menuExited && (
              <button onClick={() => { statusMenuOpen.value = null; killSession(menuSid); }}>
                Kill {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}K</kbd>}
              </button>
            )}
            {menuSess?.feedbackId && (
              <button onClick={() => { statusMenuOpen.value = null; resolveSession(menuSid, menuSess.feedbackId); }}>
                Resolve {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}R</kbd>}
              </button>
            )}
            {!menuExited && (
              <button onClick={() => { statusMenuOpen.value = null; executePopout(menuSid, popoutMode.value); }}>
                Pop out
              </button>
            )}
            <button onClick={() => { statusMenuOpen.value = null; splitLeaf(leaf.id, 'horizontal', 'second', [], 0.5, true); }}>
              Split Right {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}"</kbd>}
            </button>
            <button onClick={() => { statusMenuOpen.value = null; splitLeaf(leaf.id, 'vertical', 'second', [], 0.5, true); }}>
              Split Down {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}-</kbd>}
            </button>
            {menuExited && (
              <button onClick={() => { statusMenuOpen.value = null; resumeSession(menuSid); }}>Resume</button>
            )}
            <button onClick={() => {
              statusMenuOpen.value = null;
              renameValue.value = getSessionLabel(menuSid) || '';
              renamingSessionId.value = menuSid;
            }}>
              Rename
            </button>
            {getSessionLabel(menuSid) && (
              <button onClick={() => { statusMenuOpen.value = null; setSessionLabel(menuSid, ''); }}>
                Clear name
              </button>
            )}
            <button onClick={() => { handleClose(menuSid); statusMenuOpen.value = null; }}>
              Close tab {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}W</kbd>}
            </button>
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

      {/* Hotkey hint menu */}
      {hotkeyMenuOpen.value && !statusMenuOpen.value && isFocused && (() => {
        const hk = hotkeyMenuOpen.value!;
        const hkSess = sessionMap.get(hk.sessionId);
        const hkExited = exited.has(hk.sessionId);
        return (
          <div
            class="status-dot-menu"
            style={{ left: `${hk.x}px`, top: `${hk.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {!hkExited && (
              <button onClick={() => killSession(hk.sessionId)}>
                Kill <kbd>K</kbd>
              </button>
            )}
            {hkSess?.feedbackId && (
              <button onClick={() => resolveSession(hk.sessionId, hkSess.feedbackId)}>
                Resolve <kbd>R</kbd>
              </button>
            )}
            <button onClick={() => { idMenuOpen.value = idMenuOpen.value ? null : hk.sessionId; }}>
              Session menu <kbd>P</kbd>
            </button>
            {hkExited && (
              <button onClick={() => resumeSession(hk.sessionId)}>Resume</button>
            )}
            <button onClick={() => handleClose(hk.sessionId)}>
              Close tab <kbd>W</kbd>
            </button>
          </div>
        );
      })()}

      {activeId && !activeId.startsWith('view:') && !activeId.startsWith('cos:') && (
        <PaneHeader
          sessionId={activeId}
          sessionMap={sessionMap}
          exited={exited}
          leafId={leaf.id}
        />
      )}
      <div class="pane-leaf-body" style={{ position: 'relative' }}>
        {leaf.tabs.filter((sid) => sid === leaf.activeTabId).map((sid) =>
          renderTabContent(sid, true, sessionMap, (code, text) => markSessionExited(sid, code, text))
        )}
        <DiagonalDropZone leafId={leaf.id} />
      </div>
      {(popInPickerSessionId.value || popInPickerPanelId.value) && (
        <PopInPickerOverlay leafId={leaf.id} />
      )}
    </div>
  );
}
