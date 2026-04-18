import { useRef, useCallback, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { type ViewMode } from './SessionViewToggle.js';
import type { LeafNode } from '../lib/pane-tree.js';
import {
  setActiveTab,
  setFocusedLeaf,
  focusedLeafId,
  reorderTabInLeaf,
  splitLeaf,
  mergeLeaf,
  SIDEBAR_LEAF_ID,
  PAGE_LEAF_ID,
  SESSIONS_LEAF_ID,
} from '../lib/pane-tree.js';
import { renderTabContent } from './PaneContent.js';
import {
  allSessions,
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
  buildTmuxAttachCmd,
  hotkeyMenuOpen,
  getWorktreeLabel,
} from '../lib/sessions.js';
import { startTabDrag } from '../lib/tab-drag.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { showHotkeyHints, popoutMode, type PopoutMode } from '../lib/settings.js';
import { navigate, selectedAppId } from '../lib/state.js';
import { api } from '../lib/api.js';
import { copyWithTooltip } from '../lib/clipboard.js';
import { useState } from 'preact/hooks';

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
      window.open(`#/session/${sessionId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no');
      break;
    case 'tab':
      window.open(`#/session/${sessionId}`, '_blank');
      break;
    case 'terminal':
      api.openSessionInTerminal(sessionId);
      break;
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
    const interval = setInterval(() => refresh(true), 10_000);
    return () => clearInterval(interval);
  }, [sessionId]);

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

  const shortUuid = claudeUuid ? claudeUuid.slice(0, 8) : sessionId.slice(-6);

  return (
    <div class="id-dropdown-wrapper jsonl-file-dropdown">
      <span
        class="tmux-id-label"
        onClick={() => { jsonlDropdownOpen.value = isOpen ? null : sessionId; }}
        title={claudeUuid ? `Claude Session: ${claudeUuid}` : undefined}
      >
        JSONL: {shortUuid} {files.length > 1 && <span class="id-dropdown-caret">{'\u25BE'}</span>}
      </span>
      {selectedFile && (
        <span class="jsonl-file-badge" title={files.find(f => f.id === selectedFile)?.label || selectedFile}>
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
  leafId,
}: {
  sessionId: string | null;
  sessionMap: Map<string, any>;
  exited: Set<string>;
  leafId: string;
}) {
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
  const viewMode = realSessionId ? getViewMode(realSessionId, sess?.permissionProfile) : 'terminal';
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
                    class="tmux-id-label"
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
                      <button onClick={(e: any) => { e.stopPropagation(); companionIdMenuOpen.value = null; copyWithTooltip(buildTmuxAttachCmd(termSid, termSess), e); }}>
                        Copy tmux command
                      </button>
                      <button onClick={() => { companionIdMenuOpen.value = null; api.openSessionInTerminal(termSid).catch(() => {}); }}>
                        Open in Terminal.app
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
                    class="tmux-id-label"
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
                      <button onClick={(e: any) => { e.stopPropagation(); companionIdMenuOpen.value = null; copyWithTooltip(buildTmuxAttachCmd(realSessionId!, sess), e); }}>
                        Copy tmux command
                      </button>
                      <button onClick={() => { companionIdMenuOpen.value = null; api.openSessionInTerminal(realSessionId!).catch(() => {}); }}>
                        Open in Terminal.app
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          )}
          {feedbackPath && (
            <a href={`#${feedbackPath}`} onClick={(e) => { e.preventDefault(); navigate(feedbackPath); }} class="feedback-title-link" title={sess?.feedbackTitle || 'View feedback'}>{sess?.feedbackTitle || 'View feedback'}</a>
          )}
        </>
      )}
      {sessionId && !isCompanionTab && (
        <>
          <div class="id-dropdown-wrapper">
            <span
              class="tmux-id-label"
              onClick={() => { idMenuOpen.value = idMenuOpen.value === sessionId ? null : sessionId; }}
            >
              pw-{sessionId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
            </span>
            {idMenuOpen.value === sessionId && (
              <div class="id-dropdown-menu" onClick={() => { idMenuOpen.value = null; }}>
                <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
                  <div class="id-submenu-trigger">Copy</div>
                  <div class="id-submenu">
                    <button onClick={(e) => { idMenuOpen.value = null; copyWithTooltip(sessionId, e as any); }}>
                      Session ID <kbd>C</kbd>
                    </button>
                    <button onClick={(e) => { idMenuOpen.value = null; copyWithTooltip(buildTmuxAttachCmd(sessionId, sessionMap.get(sessionId)), e as any); }}>
                      Tmux command <kbd>T</kbd>
                    </button>
                    {sess?.jsonlPath && (
                      <button onClick={(e) => { idMenuOpen.value = null; copyWithTooltip(sess.jsonlPath, e as any); }}>
                        JSONL path <kbd>J</kbd>
                      </button>
                    )}
                    {sess?.feedbackId && (
                      <button onClick={(e) => { idMenuOpen.value = null; copyWithTooltip(sess.feedbackId, e as any); }}>
                        Feedback ID <kbd>D</kbd>
                      </button>
                    )}
                  </div>
                </div>
                <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
                  <div class="id-submenu-trigger">Companion</div>
                  <div class="id-submenu">
                    {sess?.jsonlPath && (() => {
                      const companions = getCompanions(sessionId);
                      const jsonlActive = companions.includes('jsonl');
                      return (
                        <button onClick={() => { idMenuOpen.value = null; toggleCompanion(sessionId, 'jsonl'); }}>
                          {jsonlActive ? '\u2713 ' : ''}JSONL <kbd>L</kbd>
                        </button>
                      );
                    })()}
                    {sess?.feedbackId && (() => {
                      const companions = getCompanions(sessionId);
                      const fbActive = companions.includes('feedback');
                      return (
                        <button onClick={() => { idMenuOpen.value = null; toggleCompanion(sessionId, 'feedback'); }}>
                          {fbActive ? '\u2713 ' : ''}Feedback <kbd>F</kbd>
                        </button>
                      );
                    })()}
                    {sess?.url && (() => {
                      const companions = getCompanions(sessionId);
                      const iframeActive = companions.includes('iframe');
                      return (
                        <button onClick={() => { idMenuOpen.value = null; toggleCompanion(sessionId, 'iframe'); }}>
                          {iframeActive ? '\u2713 ' : ''}Page iframe <kbd>I</kbd>
                        </button>
                      );
                    })()}
                    {(() => {
                      const companions = getCompanions(sessionId);
                      const termActive = companions.includes('terminal');
                      return (
                        <button onClick={() => {
                          if (termActive) {
                            idMenuOpen.value = null;
                            toggleCompanion(sessionId, 'terminal');
                          } else {
                            idMenuOpen.value = null;
                            termPickerOpen.value = { kind: 'companion', sessionId };
                          }
                        }}>
                          {termActive ? '\u2713 ' : ''}Terminal <kbd>M</kbd>
                        </button>
                      );
                    })()}
                    <button onClick={() => {
                      idMenuOpen.value = null;
                      termPickerOpen.value = { kind: 'url' };
                    }}>
                      Iframe... <kbd>U</kbd>
                    </button>
                    {sess?.isHarness && sess?.harnessAppPort && (
                      <button onClick={() => {
                        const host = sess.isRemote && sess.launcherHostname ? sess.launcherHostname : 'localhost';
                        openUrlCompanion(`http://${host}:${sess.harnessAppPort}`);
                        idMenuOpen.value = null;
                      }}>
                        Open App <kbd>O</kbd>
                      </button>
                    )}
                  </div>
                </div>
                <div class="id-submenu-group" onClick={(e: any) => e.stopPropagation()}>
                  <div class="id-submenu-trigger">Open In</div>
                  <div class="id-submenu">
                    <button onClick={() => { idMenuOpen.value = null; executePopout(sessionId, 'panel'); }}>Panel <kbd>P</kbd></button>
                    <button onClick={() => { idMenuOpen.value = null; executePopout(sessionId, 'window'); }}>Window <kbd>W</kbd></button>
                    <button onClick={() => { idMenuOpen.value = null; executePopout(sessionId, 'tab'); }}>Browser Tab <kbd>B</kbd></button>
                    {!isExited && (
                      <button onClick={() => { idMenuOpen.value = null; executePopout(sessionId, 'terminal'); }}>Terminal.app <kbd>A</kbd></button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          {feedbackPath && (
            <a
              href={`#${feedbackPath}`}
              onClick={(e) => { e.preventDefault(); navigate(feedbackPath); }}
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
          {(sess?.permissionProfile === 'auto' || sess?.permissionProfile === 'yolo') && (
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

// --- Tab label helper ---

function getTabLabel(sid: string, sessionMap: Map<string, any>): string {
  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  const isFile = sid.startsWith('file:');
  const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl || isFile;
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const sess = (isIsolate || isUrl || isFile) ? null : sessionMap.get(realSid);

  const customLabel = getSessionLabel(sid);
  if (customLabel) return customLabel;

  if (isJsonl) return `JSONL: ${sess?.feedbackTitle || sess?.agentName || realSid.slice(-6)}`;
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

// --- Main component ---

interface LeafPaneProps {
  leaf: LeafNode;
}

export function LeafPane({ leaf }: LeafPaneProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const sessions = allSessions.value;
  const sessionMap = new Map(sessions.map((s: any) => [s.id, s]));
  const exited = exitedSessions.value;
  const isFocused = focusedLeafId.value === leaf.id;
  const globalSessions = allNumberedSessions();
  const activeId = leaf.activeTabId;

  const handleActivate = useCallback((sid: string) => {
    setActiveTab(leaf.id, sid);
    setFocusedLeaf(leaf.id);
    openSession(sid);
  }, [leaf.id]);

  const handleClose = useCallback((sid: string) => {
    closeTab(sid);
  }, [leaf.id]);

  const handleMouseDown = useCallback(() => {
    if (focusedLeafId.value !== leaf.id) {
      setFocusedLeaf(leaf.id);
    }
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
      } else if (key === 't') {
        navigator.clipboard.writeText(buildTmuxAttachCmd(menuSessionId, sess));
      } else if (key === 'p') {
        executePopout(menuSessionId, 'panel');
      } else if (key === 'w') {
        executePopout(menuSessionId, 'window');
      } else if (key === 'b') {
        executePopout(menuSessionId, 'tab');
      } else if (key === 'a' && !exited.has(menuSessionId)) {
        executePopout(menuSessionId, 'terminal');
      } else if (key === 'j') {
        if (sess?.jsonlPath) navigator.clipboard.writeText(sess.jsonlPath);
      } else if (key === 'd') {
        if (sess?.feedbackId) navigator.clipboard.writeText(sess.feedbackId);
      } else if (key === 'l') {
        if (sess?.jsonlPath) toggleCompanion(menuSessionId, 'jsonl');
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

  // Hotkey hint menu (Ctrl+Shift)
  useEffect(() => {
    const held = ctrlShiftHeld.value;
    if (!held || !activeId || !showHotkeyHints.value || !isFocused) {
      if (isFocused) hotkeyMenuOpen.value = null;
      return;
    }

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
      />
    );
  }

  return (
    <div
      class={`pane-leaf${isFocused ? ' pane-leaf-focused' : ''}`}
      data-leaf-id={leaf.id}
      onMouseDown={handleMouseDown}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      <div class="terminal-tab-bar">
        <div
          ref={tabsRef}
          class="pane-leaf-tabs"
          onWheel={(e) => { const d = (e as WheelEvent).deltaX || (e as WheelEvent).deltaY; if (d) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += d; } }}
        >
          {leaf.tabs.map((sid) => {
            const isJsonl = sid.startsWith('jsonl:');
            const isFeedback = sid.startsWith('feedback:');
            const isIframe = sid.startsWith('iframe:');
            const isTerminal = sid.startsWith('terminal:');
            const isIsolate = sid.startsWith('isolate:');
            const isUrl = sid.startsWith('url:');
            const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl;
            const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
            const isActive = sid === leaf.activeTabId;
            const isExited = exited.has(realSid);
            const sess = (isIsolate || isUrl) ? null : sessionMap.get(realSid);
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
                {!isCompanion && <span
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
            class="terminal-collapse-btn"
            title="Split right (Ctrl+Shift+&quot;)"
            onClick={(e) => {
              e.stopPropagation();
              splitLeaf(leaf.id, 'horizontal');
            }}
          >{'\u2502'}</button>
          <button
            class="terminal-collapse-btn"
            title="Split down (Ctrl+Shift+-)"
            onClick={(e) => {
              e.stopPropagation();
              splitLeaf(leaf.id, 'vertical');
            }}
          >{'\u2500'}</button>
          {leaf.id !== SIDEBAR_LEAF_ID && leaf.id !== PAGE_LEAF_ID && leaf.id !== SESSIONS_LEAF_ID && (
            <button
              class="terminal-collapse-btn"
              title="Close pane (Ctrl+Shift+Backspace)"
              onClick={(e) => {
                e.stopPropagation();
                mergeLeaf(leaf.id);
              }}
            >{'\u00D7'}</button>
          )}
          <button
            class="terminal-collapse-btn"
            title="New terminal"
            onClick={(e) => {
              e.stopPropagation();
              termPickerOpen.value = { kind: 'new' };
            }}
          >+</button>
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
            <button onClick={() => { statusMenuOpen.value = null; splitLeaf(leaf.id, 'horizontal'); }}>
              Split Right {showHotkeyHints.value && <kbd>{'\u2303\u21E7'}"</kbd>}
            </button>
            <button onClick={() => { statusMenuOpen.value = null; splitLeaf(leaf.id, 'vertical'); }}>
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
            <button onClick={() => { statusMenuOpen.value = null; handleClose(menuSid); }}>
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

      <PaneHeader
        sessionId={activeId}
        sessionMap={sessionMap}
        exited={exited}
        leafId={leaf.id}
      />
      <div class="pane-leaf-body">
        {leaf.tabs.map((sid) =>
          renderTabContent(sid, sid === leaf.activeTabId, sessionMap, (code, text) => markSessionExited(sid, code, text))
        )}
      </div>
    </div>
  );
}
