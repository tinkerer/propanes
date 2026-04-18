import { useRef, useCallback, useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { type ViewMode } from './SessionViewToggle.js';
import {
  openTabs,
  activeTabId,
  panelMinimized,
  panelMaximized,
  panelHeight,
  exitedSessions,
  openSession,
  closeTab,
  killSession,
  resumeSession,
  markSessionExited,
  sidebarWidth,
  sidebarCollapsed,
  allSessions,
  sessionMapComputed,
  persistPanelState,
  popOutTab,
  getViewMode,
  setViewMode,
  pendingFirstDigit,
  allNumberedSessions,
  sidebarAnimating,
  focusedPanelId,
  hotkeyMenuOpen,
  sessionInputStates,
  setSessionInputState,
  splitEnabled,
  rightPaneTabs,
  rightPaneActiveId,
  splitRatio,
  leftPaneTabs,
  enableSplit,
  disableSplit,
  setSplitRatio,
  sessionLabels,
  setSessionLabel,
  getSessionLabel,
  getSessionColor,
  setSessionColor,
  SESSION_COLOR_PRESETS,
  activePanelId,
  AUTOJUMP_PANEL_ID,
  popoutPanels,
  toggleCompanion,
  getCompanions,
  type CompanionType,
  resolveSession,
  bringToFront,
  getPanelZIndex,
  panelZOrders,
  getTerminalCompanion,
  terminalCompanionMap,
  focusSessionTerminal,
  termPickerOpen,
  openUrlCompanion,
  jsonlFilesCache,
  jsonlSelectedFile,
  jsonlDropdownOpen,
  fetchJsonlFiles,
  getJsonlSelectedFile,
  setJsonlSelectedFile,
  type JsonlFileInfo,
  openFeedbackItem,
  openLocalTerminal,
} from '../lib/sessions.js';
import { renderTabContent } from './PaneContent.js';
import { AdminAssistChat } from './AdminAssistChat.js';
import { startTabDrag, type TabDragSource } from '../lib/tab-drag.js';
import { selectedAppId } from '../lib/state.js';
import { showTabs, showHotkeyHints, popoutMode, type PopoutMode } from '../lib/settings.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { copyText, copyWithTooltip } from '../lib/clipboard.js';
import { TerminalPicker } from './TerminalPicker.js';
import { SessionIdMenu } from './SessionIdMenu.js';

const statusMenuOpen = signal<{ sessionId: string; x: number; y: number } | null>(null);
const renamingSessionId = signal<string | null>(null);
const renameValue = signal('');
export const idMenuOpen = signal<string | null>(null);
const companionIdMenuOpen = signal<string | null>(null);
const panelResizing = signal(false);

function JsonlFileDropdown({ sessionId, sess }: { sessionId: string; sess: any }) {
  const [files, setFiles] = useState<JsonlFileInfo[]>([]);
  const [claudeUuid, setClaudeUuid] = useState<string | null>(null);
  const isOpen = jsonlDropdownOpen.value === sessionId;
  const selectedFile = getJsonlSelectedFile(sessionId);

  useEffect(() => {
    const cached = jsonlFilesCache.value.get(sessionId);
    if (cached) {
      setFiles(cached.files);
      setClaudeUuid(cached.claudeSessionId);
    }
    const refresh = (force = false) => {
      fetchJsonlFiles(sessionId, force).then((result) => {
        setFiles(result.files);
        setClaudeUuid(result.claudeSessionId);
      }).catch(() => {});
    };
    refresh();
    // Poll for new files every 10s (new continuations/subagents appear mid-session)
    const interval = setInterval(() => { if (!document.hidden) refresh(true); }, 10_000);
    return () => clearInterval(interval);
  }, [sessionId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.jsonl-file-dropdown')) {
        jsonlDropdownOpen.value = null;
      }
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [isOpen]);

  const selectedLabel = selectedFile
    ? files.find(f => f.id === selectedFile)?.label || selectedFile
    : 'All (merged)';

  const shortUuid = claudeUuid ? claudeUuid.slice(0, 8) : sessionId.slice(-6);

  return (
    <div class="id-dropdown-wrapper jsonl-file-dropdown">
      <span
        class="session-id-label"
        onClick={() => {
          jsonlDropdownOpen.value = isOpen ? null : sessionId;
        }}
        title={claudeUuid ? `Claude Session: ${claudeUuid}` : undefined}
      >
        JSONL: {shortUuid} {files.length > 1 && <span class="id-dropdown-caret">{'\u25BE'}</span>}
      </span>
      {selectedFile && (
        <span class="jsonl-file-badge" title={selectedLabel}>
          {files.find(f => f.id === selectedFile)?.type === 'subagent' ? 'sub' : 'file'}
        </span>
      )}
      {isOpen && files.length > 0 && (
        <div class="id-dropdown-menu jsonl-file-menu" onClick={() => { jsonlDropdownOpen.value = null; }}>
          <button
            class={!selectedFile ? 'active' : ''}
            onClick={() => setJsonlSelectedFile(sessionId, null)}
          >
            {!selectedFile ? '\u2713 ' : ''}All (merged) — {files.length} file{files.length !== 1 ? 's' : ''}
          </button>
          <div class="jsonl-file-divider" />
          {files.map(f => (
            <button
              key={f.id}
              class={selectedFile === f.id ? 'active' : ''}
              onClick={() => setJsonlSelectedFile(sessionId, f.id)}
              title={`${f.type}: ${f.claudeSessionId}`}
            >
              {selectedFile === f.id ? '\u2713 ' : ''}
              {f.type === 'main' && '\u{1F4C4} '}
              {f.type === 'continuation' && '\u{1F517} '}
              {f.type === 'subagent' && '\u{1F916} '}
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PaneHeader({
  sessionId,
  sessionMap,
  exited,
  canSplit,
  showCollapse,
  onToggleMinimized,
  onToggleMaximized,
}: {
  sessionId: string | null;
  sessionMap: Map<string, any>;
  exited: Set<string>;
  canSplit?: boolean;
  showCollapse?: boolean;
  onToggleMinimized?: () => void;
  onToggleMaximized?: () => void;
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
    ? appId ? `/app/${appId}/feedback/${sess.feedbackId}` : `/feedback/${sess.feedbackId}`
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
              const label = isFeedbackTab ? `Feedback: pw-${realSessionId!.slice(-6)}`
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
            <a href={`#${feedbackPath}`} onClick={(e) => { e.preventDefault(); if (sess?.feedbackId) openFeedbackItem(sess.feedbackId); }} class="feedback-title-link" title={sess?.feedbackTitle || 'View feedback'}>{sess?.feedbackTitle || 'View feedback'}</a>
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
                context={{ mode: 'tab', canSplit, enableSplit }}
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
      {showCollapse && (
        <>
          {onToggleMaximized && (
            <button class="terminal-collapse-btn" onClick={onToggleMaximized} title={panelMaximized.value ? 'Restore' : 'Maximize'}>
              {panelMaximized.value ? '\u25A3' : '\u25B2'}
            </button>
          )}
          {onToggleMinimized && (
            <button class="terminal-collapse-btn" onClick={onToggleMinimized}>
              {panelMinimized.value ? '\u25B2' : '\u25BC'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function executePopout(sessionId: string, mode: PopoutMode) {
  switch (mode) {
    case 'panel':
      popOutTab(sessionId);
      break;
    case 'window':
      window.open(`#/session/${sessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
      break;
    case 'tab':
      window.open(`#/session/${sessionId}`, '_blank');
      break;
  }
}

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

function PaneTabBar({
  tabs,
  activeId,
  source,
  exited,
  sessionMap,
  tabsRef,
  onActivate,
}: {
  tabs: string[];
  activeId: string | null;
  source: TabDragSource;
  exited: Set<string>;
  sessionMap: Map<string, any>;
  tabsRef?: preact.RefObject<HTMLDivElement>;
  onActivate: (sid: string) => void;
}) {
  const globalSessions = allNumberedSessions();
  return (
    <div ref={tabsRef} class="terminal-tabs" onWheel={(e) => { const delta = e.deltaX || e.deltaY; if (delta) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += delta; } }}>
      {tabs.map((sid) => {
        const isJsonl = sid.startsWith('jsonl:');
        const isFeedback = sid.startsWith('feedback:');
        const isFb = sid.startsWith('fb:');
        const isIframe = sid.startsWith('iframe:');
        const isTerminal = sid.startsWith('terminal:');
        const isIsolate = sid.startsWith('isolate:');
        const isUrl = sid.startsWith('url:');
        const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl;
        const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
        const isExited = exited.has(realSid);
        const inputState = !isExited && !isCompanion ? (sessionInputStates.value.get(sid) || null) : null;
        const isActive = sid === activeId;
        const sess = (isIsolate || isUrl) ? null : sessionMap.get(realSid);
        const isPlain = !isCompanion && sess?.permissionProfile === 'plain';
        const plainLabel = sess?.paneCommand
          ? `${sess.paneCommand}:${sess.panePath || ''} \u2014 ${sess?.paneTitle || realSid.slice(-6)}`
          : (sess?.paneTitle || realSid.slice(-6));
        const customLabel = getSessionLabel(sid);
        const companionLabel = isJsonl ? `JSONL: ${sess?.feedbackTitle || sess?.agentName || realSid.slice(-6)}`
          : isFeedback ? `FB: ${sess?.feedbackTitle || realSid.slice(-6)}`
          : isIframe ? `Page: ${realSid.slice(-6)}`
          : isTerminal ? (() => { const ts = getTerminalCompanion(realSid); if (ts === '__loading__') return 'Term: loading...'; const tSess = ts ? sessionMap.get(ts) : null; return `Term: ${tSess?.paneTitle || ts?.slice(-6) || realSid.slice(-6)}`; })()
          : isIsolate ? `Isolate: ${realSid}`
          : isUrl ? (() => { try { return `Iframe: ${new URL(realSid).hostname}`; } catch { return `Iframe: ${realSid.slice(0, 30)}`; } })()
          : '';
        const locationPrefix = !isCompanion && sess?.isHarness ? '\u{1F4E6}' : !isCompanion && sess?.isRemote ? '\u{1F310}' : '';
        const raw = customLabel || (isCompanion ? companionLabel : isPlain ? `${locationPrefix || '\u{1F5A5}\uFE0F'} ${plainLabel}` : `${locationPrefix ? locationPrefix + ' ' : ''}${sess?.feedbackTitle || sess?.agentName || `Session ${sid.slice(-6)}`}`);
        const tabLabel = raw;
        const tabTooltipParts: string[] = [];
        if (!isCompanion && sess?.isHarness) tabTooltipParts.push(`Harness: ${sess.harnessName || 'unknown'}`);
        else if (!isCompanion && sess?.isRemote) tabTooltipParts.push(`Remote: ${sess.machineName || sess.launcherHostname || 'unknown'}`);
        if (sess?.paneCommand) tabTooltipParts.push(`Process: ${sess.paneCommand}`);
        if (sess?.panePath) tabTooltipParts.push(`Path: ${sess.panePath}`);
        tabTooltipParts.push(raw);
        const tabTooltip = tabTooltipParts.length > 1 ? tabTooltipParts.join('\n') : raw;
        const globalIdx = globalSessions.indexOf(sid);
        const tabNum = globalIdx >= 0 ? globalIdx + 1 : null;
        return (
          <button
            key={sid}
            class={`terminal-tab ${isActive ? 'active' : ''}`}
            style={getSessionColor(sid) ? { boxShadow: `inset 0 -2px 0 ${getSessionColor(sid)}` } : undefined}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              startTabDrag(e, {
                sessionId: sid,
                source,
                label: tabLabel,
                onClickFallback: () => onActivate(sid),
              });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !renamingSessionId.value) {
                e.preventDefault();
                onActivate(sid);
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
            {(isCompanion || isFb) && <span class="companion-icon">{
              (isFeedback || isFb) ? '\u{1F4AC}' :
              isJsonl ? '\u{1F4DC}' :
              isIframe ? '\u{1F310}' :
              isTerminal ? '\u{25B8}' :
              isUrl ? '\u{1F517}' :
              isIsolate ? '\u2699' :
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
              <span class="terminal-tab-label">{tabLabel}</span>
            )}
            <span class="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(sid); }}>&times;</span>
          </button>
        );
      })}
    </div>
  );
}


export function GlobalTerminalPanel() {
  const tabs = openTabs.value;
  if (tabs.length === 0) {
    // Still render the TerminalPicker even when no tabs are open
    if (termPickerOpen.value) {
      return (
        <TerminalPicker
          mode={termPickerOpen.value}
          onClose={() => { termPickerOpen.value = null; }}
        />
      );
    }
    return <AdminAssistChat />;
  }

  const activeId = activeTabId.value;
  const minimized = panelMinimized.value;
  const height = panelHeight.value;
  const exited = exitedSessions.value;
  const sessionMap = sessionMapComputed.value;
  const isSplit = splitEnabled.value;
  const leftTabs = isSplit ? leftPaneTabs() : tabs;
  const rightTabs = isSplit ? rightPaneTabs.value : [];
  const rightActive = rightPaneActiveId.value;

  const dragging = useRef(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const splitDragging = useRef(false);
  useEffect(() => {
    if (!activeId) return;
    requestAnimationFrame(() => {
      const container = tabsRef.current;
      if (!container) return;
      const el = container.querySelector('.terminal-tab.active') as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    });
  }, [activeId, tabs.length]);

  useEffect(() => {
    if (!statusMenuOpen.value) return;
    const close = () => { statusMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [statusMenuOpen.value]);

  useEffect(() => {
    if (!idMenuOpen.value) return;
    const close = () => { idMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [idMenuOpen.value]);

  useEffect(() => {
    if (!companionIdMenuOpen.value) return;
    const close = () => { companionIdMenuOpen.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [companionIdMenuOpen.value]);

  useEffect(() => {
    const onResize = () => {
      const maxH = window.innerHeight - 100;
      if (panelHeight.value > maxH) {
        panelHeight.value = Math.max(150, maxH);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const menuSessionId = idMenuOpen.value;
    if (!menuSessionId) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === 'c') {
        copyText(menuSessionId);
      } else if (key === 'p') {
        executePopout(menuSessionId, 'panel');
      } else if (key === 'w') {
        executePopout(menuSessionId, 'window');
      } else if (key === 'b') {
        executePopout(menuSessionId, 'tab');
      } else if (key === 'j') {
        const s = sessionMap.get(menuSessionId);
        if (s?.jsonlPath) copyText(s.jsonlPath);
      } else if (key === 'd') {
        const s = sessionMap.get(menuSessionId);
        if (s?.feedbackId) copyText(s.feedbackId);
      } else if (key === 'l') {
        const s = sessionMap.get(menuSessionId);
        if (s?.jsonlPath) toggleCompanion(menuSessionId, 'jsonl');
      } else if (key === 'f') {
        const s = sessionMap.get(menuSessionId);
        if (s?.feedbackId) toggleCompanion(menuSessionId, 'feedback');
      } else if (key === 'i') {
        const s = sessionMap.get(menuSessionId);
        if (s?.url) toggleCompanion(menuSessionId, 'iframe');
      } else if (key === 'm') {
        const companions = getCompanions(menuSessionId);
        if (companions.includes('terminal')) {
          toggleCompanion(menuSessionId, 'terminal');
        } else {
          termPickerOpen.value = { kind: 'companion', sessionId: menuSessionId };
        }
      } else if (key === 'u') {
        termPickerOpen.value = { kind: 'url' };
      } else if (key === 's' && tabs.length >= 2 && !isSplit) {
        enableSplit();
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

  useEffect(() => {
    const held = ctrlShiftHeld.value;
    const ap = activePanelId.value;
    const isGlobalFocused = ap === 'global' || ap === 'split-left' || ap === 'split-right';
    if (!held || !activeId || !showHotkeyHints.value || !isGlobalFocused) {
      hotkeyMenuOpen.value = null;
      return;
    }

    function updatePos() {
      const dot = tabsRef.current?.querySelector('.terminal-tab.active .status-dot') as HTMLElement | null;
      const scrollBox = tabsRef.current;
      if (!dot || !scrollBox) { hotkeyMenuOpen.value = null; return; }
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
  }, [ctrlShiftHeld.value, activeId, activePanelId.value]);

  const onResizeMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    panelResizing.value = true;
    if (panelMinimized.value) {
      panelMinimized.value = false;
    }
    panelMaximized.value = false;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const newH = window.innerHeight - ev.clientY;
      panelHeight.value = Math.max(150, Math.min(newH, window.innerHeight - 100));
    };
    const onUp = () => {
      dragging.current = false;
      panelResizing.value = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistPanelState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const onSplitDividerMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    container.classList.add('dragging');
    const containerRect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      if (!splitDragging.current) return;
      const ratio = (ev.clientX - containerRect.left) / containerRect.width;
      setSplitRatio(ratio);
    };
    const onUp = () => {
      splitDragging.current = false;
      container.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const hasTabs = showTabs.value;
  const maximized = panelMaximized.value;
  const toggleMinimized = () => { panelMinimized.value = !panelMinimized.value; persistPanelState(); };
  const toggleMaximized = () => {
    if (panelMaximized.value) {
      panelMaximized.value = false;
    } else {
      panelMaximized.value = true;
      panelMinimized.value = false;
    }
    persistPanelState();
  };
  const appId = selectedAppId.value;

  const panelButtons = (
    <>
      <button
        class="terminal-collapse-btn"
        title="New terminal"
        onClick={(e) => {
          e.stopPropagation();
          termPickerOpen.value = { kind: 'new' };
        }}
      >+</button>
      <button class="terminal-collapse-btn" onClick={toggleMaximized} title={maximized ? 'Restore' : 'Maximize'}>
        {maximized ? '\u25A3' : '\u25B2'}
      </button>
      <button class="terminal-collapse-btn" onClick={toggleMinimized}>
        {minimized ? '\u25B2' : '\u25BC'}
      </button>
    </>
  );

  const ap = activePanelId.value;
  const fp = focusedPanelId.value;
  const isFocused = fp === 'global' || fp === 'split-left' || fp === 'split-right' || ap === 'global' || ap === 'split-left' || ap === 'split-right';
  const canSplit = tabs.length >= 2 && !isSplit;
  const _zOrders = panelZOrders.value;
  const globalZIdx = getPanelZIndex('global-panel');

  return (
    <>
    {termPickerOpen.value && (
      <TerminalPicker
        mode={termPickerOpen.value}
        onClose={() => { termPickerOpen.value = null; }}
      />
    )}
    <div
      class={`global-terminal-panel${sidebarAnimating.value ? ' animating' : ''}${panelResizing.value ? ' dragging' : ''}${isFocused ? ' panel-focused' : ''}`}
      style={{ height: minimized ? (hasTabs ? '66px' : '32px') : maximized ? '100vh' : `${height}px`, left: `${sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3)}px`, zIndex: globalZIdx }}
      onMouseDown={() => {
        bringToFront('global-panel');
        if (!isSplit) {
          activePanelId.value = 'global';
          if (activeId) focusSessionTerminal(activeId);
        }
      }}
    >
      <div class="terminal-resize-handle" onMouseDown={onResizeMouseDown} />
      {hasTabs && !isSplit && (
        <div class="terminal-tab-bar">
          <PaneTabBar
            tabs={tabs}
            activeId={activeId}
            source="main"
            exited={exited}
            sessionMap={sessionMap}
            tabsRef={tabsRef}
            onActivate={openSession}
          />
          <div class="terminal-tab-actions">
            {panelButtons}
          </div>
        </div>
      )}
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
                Kill {showHotkeyHints.value && <kbd>⌃⇧K</kbd>}
              </button>
            )}
            {menuSess?.feedbackId && (
              <button onClick={() => { statusMenuOpen.value = null; resolveSession(menuSid, menuSess.feedbackId); }}>
                Resolve {showHotkeyHints.value && <kbd>⌃⇧R</kbd>}
              </button>
            )}
            {!menuExited && (
              <button onClick={() => { statusMenuOpen.value = null; executePopout(menuSid, popoutMode.value); }}>
                Pop out
              </button>
            )}
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
            <button onClick={() => { closeTab(menuSid); statusMenuOpen.value = null; }}>
              Close tab {showHotkeyHints.value && <kbd>⌃⇧W</kbd>}
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
      {hotkeyMenuOpen.value && !statusMenuOpen.value && (() => {
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
            <button onClick={() => closeTab(hk.sessionId)}>
              Close tab <kbd>W</kbd>
            </button>
          </div>
        );
      })()}
      {!isSplit && (
        <PaneHeader
          sessionId={activeId}
          sessionMap={sessionMap}
          exited={exited}
          canSplit={canSplit}
          showCollapse={!hasTabs}
          onToggleMinimized={toggleMinimized}
          onToggleMaximized={toggleMaximized}
        />
      )}
      {!minimized && !isSplit && (
        <div class="terminal-body">
          {tabs.filter((sid) => sid === activeId).map((sid) => renderTabContent(sid, true, sessionMap, (code, text) => markSessionExited(sid, code, text)))}
        </div>
      )}
      {!minimized && isSplit && (
        <div class="terminal-split-container">
          <div
            class={`terminal-split-pane${activePanelId.value === 'split-left' ? ' split-focused' : ''}`}
            data-split-pane="split-left"
            style={{ flex: splitRatio.value }}
            onMouseDown={() => { activePanelId.value = 'split-left'; if (activeId) focusSessionTerminal(activeId); }}
          >
            <div class="split-pane-tab-bar">
              <PaneTabBar
                tabs={leftTabs}
                activeId={activeId}
                source="split-left"
                exited={exited}
                sessionMap={sessionMap}
                tabsRef={tabsRef}
                onActivate={openSession}
              />
              <div class="terminal-tab-actions">
                {panelButtons}
              </div>
            </div>
            <PaneHeader sessionId={activeId} sessionMap={sessionMap} exited={exited} />
            <div class="terminal-body">
              {leftTabs.filter((sid) => sid === activeId).map((sid) => renderTabContent(sid, true, sessionMap, (code, text) => markSessionExited(sid, code, text)))}
            </div>
          </div>
          <div class="terminal-split-divider" onMouseDown={onSplitDividerMouseDown} />
          <div
            class={`terminal-split-pane${activePanelId.value === 'split-right' ? ' split-focused' : ''}`}
            data-split-pane="split-right"
            style={{ flex: 1 - splitRatio.value }}
            onMouseDown={() => { activePanelId.value = 'split-right'; if (rightActive) focusSessionTerminal(rightActive); }}
          >
            <div class="split-pane-tab-bar">
              <PaneTabBar
                tabs={rightTabs}
                activeId={rightActive}
                source="split-right"
                exited={exited}
                sessionMap={sessionMap}
                onActivate={(sid) => { rightPaneActiveId.value = sid; }}
              />
              <div class="terminal-tab-actions">
                <button
                  class="split-pane-unsplit-btn"
                  onClick={() => disableSplit()}
                  title="Close split pane"
                >
                  &times;
                </button>
              </div>
            </div>
            <PaneHeader sessionId={rightActive} sessionMap={sessionMap} exited={exited} />
            <div class="terminal-body">
              {rightTabs.filter((sid) => sid === rightActive).map((sid) => renderTabContent(sid, true, sessionMap, (code, text) => markSessionExited(sid, code, text)))}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
