import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  allSessions,
  openTabs,
  activeTabId,
  sessionInputStates,
  sessionSearchQuery,
  sessionStatusFilters,
  sessionFiltersOpen,
  toggleSessionFiltersOpen,
  toggleStatusFilter,
  sessionsDrawerOpen,
  toggleSessionsDrawer,
  sessionPassesFilters,
  allNumberedSessions,
  pendingFirstDigit,
  popoutPanels,
  findPanelForSession,
  updatePanel,
  persistPopoutState,
  openSession,
  focusOrDockSession,
  deleteSession,
  focusSessionTerminal,
  getSessionLabel,
  setSessionLabel,
  getSessionColor,
  bringToFront,
  activePanelId,
  setFocusedPanel,
  termPickerOpen,
  rightPaneActiveId,
  cycleWaitingSession,
  cancelAutoJump,
  hideAutoJumpPopup,
  pendingAutoJump,
  autoJumpPaused,
  sidebarStatusMenu,
  sidebarItemMenu,
  sessionAppFilters,
  toggleAppFilter,
  sessionGroupByApp,
  toggleGroupByApp,
  sessionExpandedParents,
  toggleExpandedParent,
  sessionCollapsedAppGroups,
  toggleCollapsedAppGroup,
  loadAllSessions,
} from '../lib/sessions.js';
import { api } from '../lib/api.js';
import { setFocusedLeaf } from '../lib/pane-tree.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, autoJumpShowPopup, autoJumpLogs, autoCloseWaitingPanel, autoJumpHandleBounce } from '../lib/settings.js';
import { selectedAppId, applications, navigate } from '../lib/state.js';
import { PopupMenu } from './PopupMenu.js';
import { QuickDispatchPopup, type DispatchType } from './QuickDispatchPopup.js';
import { loadCosDispatches, cosGroupForSession } from '../lib/cos-dispatches.js';
import { chiefOfStaffAgents } from '../lib/chief-of-staff.js';

const autoJumpMenuOpen = signal(false);
const quickDispatchAppKey = signal<string | null>(null);
const quickDispatchInitialType = signal<DispatchType | null>(null);
const renamingSessionId = signal<string | null>(null);
const renameValue = signal<string>('');
const renameSaving = signal(false);

async function commitSessionRename(session: any) {
  if (!session) { renamingSessionId.value = null; return; }
  const next = renameValue.value.trim();
  if (!next) { renamingSessionId.value = null; return; }
  // Prefer feedback title (persists + tracked on server) when session has a feedback
  if (session.feedbackId && next !== (session.feedbackTitle || '')) {
    renameSaving.value = true;
    try {
      await api.updateFeedback(session.feedbackId, { title: next });
      // Optimistically update all sessions sharing this feedback
      allSessions.value = allSessions.value.map((s: any) =>
        s.feedbackId === session.feedbackId ? { ...s, feedbackTitle: next } : s
      );
      // Clear any stale local override so the server title wins
      if (getSessionLabel(session.id)) setSessionLabel(session.id, '');
    } catch {
      // fall back to local label if server update fails
      setSessionLabel(session.id, next);
    } finally {
      renameSaving.value = false;
    }
  } else if (!session.feedbackId) {
    setSessionLabel(session.id, next);
  }
  renamingSessionId.value = null;
}

function SidebarTabBadge({ tabNum }: { tabNum: number }) {
  const pending = pendingFirstDigit.value;
  const digits = String(tabNum);
  if (pending !== null) {
    const pendingStr = String(pending);
    if (!digits.startsWith(pendingStr)) {
      return <span class="sidebar-tab-badge tab-badge-dimmed">{tabNum}</span>;
    }
    return (
      <span class="sidebar-tab-badge tab-badge-pending">
        <span class="tab-badge-green">{pendingStr}</span>
        {digits.slice(pendingStr.length) || ''}
      </span>
    );
  }
  return <span class="sidebar-tab-badge">{tabNum}</span>;
}

function highlightMatch(text: string, query: string) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span class="search-match">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

export function SessionsListView() {
  const sessions = allSessions.value;
  const tabs = openTabs.value;
  const tabSet = new Set(tabs);
  for (const panel of popoutPanels.value) {
    for (const sid of panel.sessionIds) tabSet.add(sid);
  }
  const visibleSessions = sessions.filter((s: any) => sessionPassesFilters(s, tabSet));
  const recentSessions = [...visibleSessions]
    .sort((a, b) => {
      const aOpen = tabSet.has(a.id) ? 0 : 1;
      const bOpen = tabSet.has(b.id) ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      const statusOrder = (s: string) =>
        s === 'running' ? 0 : s === 'idle' ? 1 : s === 'pending' ? 2 : 3;
      const aTier = statusOrder(a.status);
      const bTier = statusOrder(b.status);
      if (aTier !== bTier) return aTier - bTier;
      // Completed tier (completed/failed/killed): order by completion time so the
      // most-recently-finished session surfaces first. Fall back to start/create
      // time if completedAt is missing (older rows). Running/pending keep the
      // startedAt ordering.
      if (aTier === 2) {
        const aTime = new Date(a.completedAt || a.startedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.completedAt || b.startedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      }
      return new Date(b.startedAt || b.createdAt || 0).getTime() -
        new Date(a.startedAt || a.createdAt || 0).getTime();
    });

  const filtered = recentSessions.filter((s) => {
    if (!sessionSearchQuery.value) return true;
    const q = sessionSearchQuery.value.toLowerCase();
    const text = [getSessionLabel(s.id), s.feedbackTitle, s.agentName, s.id, s.paneTitle, s.paneCommand, s.panePath].filter(Boolean).join(' ').toLowerCase();
    return text.includes(q);
  });
  const agents = filtered.filter((s: any) => s.permissionProfile !== 'plain');
  const waitingAgents = agents.filter((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting');
  const restAgents = agents.filter((s: any) => !(s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting'));

  const runningSessions = sessions.filter((s: any) => s.status === 'running').length;
  const waitingCount = sessions.filter((s: any) => s.status === 'running' && sessionInputStates.value.get(s.id) === 'waiting').length;
  const nonDeletedSessions = sessions.filter((s: any) => s.status !== 'deleted');
  const statusCounts: Record<string, number> = {};
  for (const s of nonDeletedSessions) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  }
  const filtersOpen = sessionFiltersOpen.value;
  const activeStatusFilters = sessionStatusFilters.value;
  const activeFilterCount = activeStatusFilters.size;

  const globalSessions = allNumberedSessions();
  const visibleSet = new Set<string>();
  if (activeTabId.value) visibleSet.add(activeTabId.value);
  if (rightPaneActiveId.value) visibleSet.add(rightPaneActiveId.value);
  for (const p of popoutPanels.value) {
    if (p.visible && p.activeSessionId) visibleSet.add(p.activeSessionId);
  }

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

  useEffect(() => {
    loadCosDispatches();
    const timer = window.setInterval(() => { loadCosDispatches(); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const autoJumpBtnRef = useRef<HTMLSpanElement>(null);

  const renderItem = (s: any) => {
    const isTabbed = tabSet.has(s.id);
    const isInPanel = !!findPanelForSession(s.id);
    const isVisible = visibleSet.has(s.id);
    const isNumbered = isTabbed || isInPanel;
    const inputSt = s.status === 'running' ? (sessionInputStates.value.get(s.id) || null) : null;
    const isPlain = s.permissionProfile === 'plain';
    const plainLabel = s.paneCommand
      ? `${s.paneCommand}:${s.panePath || ''} \u2014 ${s.paneTitle || s.id.slice(-6)}`
      : (s.paneTitle || s.id.slice(-6));
    const customLabel = getSessionLabel(s.id);
    const locationPrefix = s.isHarness ? '\u{1F4E6}' : s.isRemote ? '\u{1F310}' : '';
    const raw = customLabel || (isPlain ? `${locationPrefix || '\u{1F5A5}\uFE0F'} ${plainLabel}` : `${locationPrefix ? locationPrefix + ' ' : ''}${s.feedbackTitle || s.title || s.agentName || `Session ${s.id.slice(-6)}`}`);
    const tooltipParts: string[] = [];
    if (s.isHarness) tooltipParts.push(`Harness: ${s.harnessName || 'unknown'}`);
    else if (s.isRemote) tooltipParts.push(`Remote: ${s.machineName || s.launcherHostname || 'unknown'}`);
    if (s.paneCommand) tooltipParts.push(`Process: ${s.paneCommand}`);
    if (s.panePath) tooltipParts.push(`Path: ${s.panePath}`);
    tooltipParts.push(isPlain
      ? `Terminal \u2014 ${s.status}`
      : s.feedbackTitle
        ? `${s.feedbackTitle} \u2014 ${s.status}`
        : `${s.agentName || s.title || 'Session'} \u2014 ${s.status}`);
    if (s.claudeSessionId) tooltipParts.push(`Claude session: ${s.claudeSessionId}`);
    const tooltip = tooltipParts.join('\n');
    const globalIdx = globalSessions.indexOf(s.id);
    const globalNum = globalIdx >= 0 ? globalIdx + 1 : null;
    const showPausedPopup = autoJumpPaused.value && pendingAutoJump.value === s.id && autoJumpShowPopup.value;
    return (
      <div key={s.id} class="sidebar-session-item-wrapper">
        <div
          class={`sidebar-session-item ${isTabbed ? 'tabbed' : ''} ${isInPanel ? 'in-panel' : ''} ${isVisible ? 'active' : ''}`}
          style={getSessionColor(s.id) ? { borderLeft: `3px solid ${getSessionColor(s.id)}` } : undefined}
          onClick={() => {
            if (inputSt === 'waiting') {
              focusOrDockSession(s.id);
            } else {
              const panel = findPanelForSession(s.id);
              if (panel) {
                updatePanel(panel.id, { activeSessionId: s.id, visible: true });
                bringToFront(panel.id);
                activePanelId.value = panel.id;
                setFocusedPanel(panel.id);
                setFocusedLeaf(null);
                persistPopoutState();
                focusSessionTerminal(s.id);
                setTimeout(() => focusSessionTerminal(s.id), 100);
              } else {
                openSession(s.id);
                focusSessionTerminal(s.id);
                setTimeout(() => focusSessionTerminal(s.id), 100);
              }
            }
          }}
          title={tooltip}
        >
          <span class="sidebar-dot-wrapper">
            <span
              class={`session-status-dot ${s.status}${isPlain ? ' plain' : ''}${inputSt ? ` ${inputSt}` : ''}`}
              title={inputSt === 'waiting' ? 'waiting for input' : inputSt === 'idle' ? 'idle' : s.status}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                sidebarStatusMenu.value = { sessionId: s.id, x: rect.right + 4, y: rect.top };
              }}
            />
            {ctrlShiftHeld.value && inputSt === 'waiting' ? (
              <span class="sidebar-tab-badge sidebar-tab-badge-overlay tab-badge-waiting">A</span>
            ) : ctrlShiftHeld.value && isNumbered && globalNum !== null ? (
              <span class="sidebar-tab-badge-overlay"><SidebarTabBadge tabNum={globalNum} /></span>
            ) : null}
          </span>
          {renamingSessionId.value === s.id ? (
            <input
              class="session-label session-label-rename-input"
              type="text"
              value={renameValue.value}
              disabled={renameSaving.value}
              onInput={(e) => { renameValue.value = (e.target as HTMLInputElement).value; }}
              onKeyDown={(e) => {
                // Keep keystrokes contained — the global shortcut layer + xterm focus
                // stealing can otherwise intercept Home/End/arrow defaults
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); commitSessionRename(s); }
                if (e.key === 'Escape') { e.preventDefault(); renamingSessionId.value = null; }
              }}
              onBlur={() => commitSessionRename(s)}
              onClick={(e) => e.stopPropagation()}
              onDblClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              ref={(el) => {
                if (el && document.activeElement !== el) {
                  el.focus();
                  el.select();
                }
              }}
            />
          ) : (
            <span
              class="session-label"
              title="Double-click to rename"
              onDblClick={(e) => {
                e.stopPropagation();
                renameValue.value = getSessionLabel(s.id) || s.feedbackTitle || s.agentName || raw;
                renamingSessionId.value = s.id;
              }}
            >
              {sessionSearchQuery.value ? highlightMatch(raw, sessionSearchQuery.value) : raw}
            </span>
          )}
          <button
            class="sidebar-item-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              sidebarItemMenu.value = { sessionId: s.id, x: rect.right + 4, y: rect.top };
            }}
            title="Session actions"
          >
            {'\u25BE'}
          </button>
          <button
            class="session-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              deleteSession(s.id);
            }}
            title="Archive session"
          >
            {'\u00D7'}
          </button>
        </div>
        {showPausedPopup && (
          <div class="auto-jump-popup" onClick={(e) => e.stopPropagation()}>
            <span class="auto-jump-popup-text">Waiting for you to stop typing</span>
            <span class="auto-jump-popup-actions">
              <kbd onClick={() => { cycleWaitingSession(); cancelAutoJump(); }}>{'\u2303\u21E7'}A</kbd> jump
              {' '}<kbd onClick={cancelAutoJump}>{'\u2303\u21E7'}X</kbd> cancel
              {' '}<kbd onClick={hideAutoJumpPopup}>hide</kbd>
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div class="sessions-list-view" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div class="sidebar-sessions-filters">
        <input
          type="text"
          placeholder="Search..."
          value={sessionSearchQuery.value}
          onInput={(e) => (sessionSearchQuery.value = (e.target as HTMLInputElement).value)}
          onClick={(e) => e.stopPropagation()}
        />
        <button
          class={`sidebar-filter-toggle-btn ${filtersOpen ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); toggleSessionFiltersOpen(); }}
          title="Filter options"
        >
          {'\u2630'}
          {activeFilterCount < 5 && <span class="filter-active-dot" />}
        </button>
        <div class="auto-jump-dropdown" onClick={(e) => e.stopPropagation()}>
          <span
            ref={autoJumpBtnRef}
            class={`auto-jump-trigger${autoJumpWaiting.value ? ' active' : ''}`}
            onClick={() => { autoJumpMenuOpen.value = !autoJumpMenuOpen.value; }}
          >
            aj {autoJumpWaiting.value ? '\u25CF' : '\u25CB'} {'\u25BE'}
          </span>
          {autoJumpMenuOpen.value && (
            <PopupMenu anchorRef={autoJumpBtnRef} onClose={() => { autoJumpMenuOpen.value = false; }} className="auto-jump-menu">
              <label>
                <input type="checkbox" checked={autoJumpWaiting.value} onChange={(e) => { autoJumpWaiting.value = (e.target as HTMLInputElement).checked; }} />
                Enable Auto-Jump
              </label>
              <div class="id-dropdown-separator" />
              <label>
                <input type="checkbox" checked={autoJumpInterrupt.value} onChange={(e) => { autoJumpInterrupt.value = (e.target as HTMLInputElement).checked; }} />
                Interrupt typing
              </label>
              <label>
                <input type="checkbox" checked={autoJumpDelay.value} onChange={(e) => { autoJumpDelay.value = (e.target as HTMLInputElement).checked; }} />
                3s delay <kbd>{'\u2303\u21E7'}X</kbd>
              </label>
              <label>
                <input type="checkbox" checked={autoJumpShowPopup.value} onChange={(e) => { autoJumpShowPopup.value = (e.target as HTMLInputElement).checked; }} />
                Show paused popup
              </label>
              <label>
                <input type="checkbox" checked={autoCloseWaitingPanel.value} onChange={(e) => { autoCloseWaitingPanel.value = (e.target as HTMLInputElement).checked; }} />
                Auto-close panel
              </label>
              <label>
                <input type="checkbox" checked={autoJumpHandleBounce.value} onChange={(e) => { autoJumpHandleBounce.value = (e.target as HTMLInputElement).checked; }} />
                Handle bounce
              </label>
              <div class="id-dropdown-separator" />
              <label>
                <input type="checkbox" checked={autoJumpLogs.value} onChange={(e) => { autoJumpLogs.value = (e.target as HTMLInputElement).checked; }} />
                Log to console
              </label>
            </PopupMenu>
          )}
        </div>
      </div>
      {filtersOpen && (
        <div class="sidebar-filter-panel" onClick={(e) => e.stopPropagation()}>
          <div class="sidebar-filter-section">
            <div class="sidebar-filter-section-label">Status</div>
            <div class="sidebar-filter-checkboxes">
              {(['running', 'idle', 'pending', 'completed', 'failed', 'killed'] as const).map((status) => (
                <label key={status} class="sidebar-filter-checkbox">
                  <input
                    type="checkbox"
                    checked={activeStatusFilters.has(status)}
                    onChange={() => toggleStatusFilter(status)}
                  />
                  <span class={`session-status-dot ${status}`} />
                  <span>{status}</span>
                  {(statusCounts[status] || 0) > 0 && (
                    <span class="sidebar-filter-count">{statusCounts[status]}</span>
                  )}
                </label>
              ))}
            </div>
          </div>
          {applications.value.length > 0 && (
            <div class="sidebar-filter-section">
              <div class="sidebar-filter-section-label">Application</div>
              <div class="sidebar-filter-checkboxes">
                {applications.value.map((app: any) => {
                  const count = nonDeletedSessions.filter((s: any) => s.appId === app.id).length;
                  return (
                    <label key={app.id} class="sidebar-filter-checkbox">
                      <input
                        type="checkbox"
                        checked={sessionAppFilters.value.has(app.id)}
                        onChange={() => toggleAppFilter(app.id)}
                      />
                      <span>{app.name}</span>
                      {count > 0 && <span class="sidebar-filter-count">{count}</span>}
                    </label>
                  );
                })}
                {(() => {
                  const unlinkedCount = nonDeletedSessions.filter((s: any) => !s.appId).length;
                  return unlinkedCount > 0 ? (
                    <label class="sidebar-filter-checkbox">
                      <input
                        type="checkbox"
                        checked={sessionAppFilters.value.has('__unlinked__')}
                        onChange={() => toggleAppFilter('__unlinked__')}
                      />
                      <span style={{ fontStyle: 'italic' }}>Unlinked</span>
                      <span class="sidebar-filter-count">{unlinkedCount}</span>
                    </label>
                  ) : null;
                })()}
              </div>
            </div>
          )}
          <div class="sidebar-filter-section">
            <label class="sidebar-filter-checkbox">
              <input
                type="checkbox"
                checked={sessionGroupByApp.value}
                onChange={() => toggleGroupByApp()}
              />
              <span>Group by application</span>
            </label>
          </div>
        </div>
      )}
      <div class="sidebar-sessions-list" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {waitingAgents.length > 0 && (
          <>
            <div class="sidebar-section-label waiting-section-label">
              Waiting for input ({waitingAgents.length})
            </div>
            {waitingAgents.map(renderItem)}
          </>
        )}
        {restAgents.length > 0 && (() => {
          // Build parent-child hierarchy from filtered agent sessions
          // Uses both parentSessionId chains AND swarmId/wiggumRunId from server
          const sessionById = new Map(sessions.map((s: any) => [s.id, s]));
          const childrenByParent = new Map<string, any[]>();
          const childIds = new Set<string>();

          // Group by swarmId, wiggumRunId, or CoS agent (one root per agent — all
          // threads belonging to the same agent collapse into a single hierarchy).
          const swarmGroups = new Map<string, { label: string; type: string; children: any[] }>();
          const swarmChildIds = new Set<string>();
          const cosAgents = chiefOfStaffAgents.value;
          const cosAgentLabel = (agentId: string) => {
            const found = cosAgents.find((a) => a.id === agentId);
            return found?.name || 'Ops';
          };

          for (const s of restAgents) {
            if (s.swarmId) {
              const key = `swarm:${s.swarmId}`;
              let grp = swarmGroups.get(key);
              if (!grp) {
                grp = { label: `\uD83E\uDDEC ${s.swarmName || s.swarmId.slice(-8)}`, type: 'swarm', children: [] };
                swarmGroups.set(key, grp);
              }
              grp.children.push(s);
              swarmChildIds.add(s.id);
            } else if (s.wiggumRunId && !s.swarmId) {
              const key = `wiggum:${s.wiggumRunId}`;
              let grp = swarmGroups.get(key);
              if (!grp) {
                grp = { label: `\uD83D\uDD04 Wiggum ${s.wiggumRunId.slice(-8)}`, type: 'wiggum', children: [] };
                swarmGroups.set(key, grp);
              }
              grp.children.push(s);
              swarmChildIds.add(s.id);
            } else {
              const cos = cosGroupForSession(s);
              if (cos) {
                const agentId = cos.agentId || 'default';
                const key = `cos:${agentId}`;
                let grp = swarmGroups.get(key);
                if (!grp) {
                  grp = { label: cosAgentLabel(agentId), type: 'cos', children: [] };
                  swarmGroups.set(key, grp);
                }
                grp.children.push(s);
                swarmChildIds.add(s.id);
              }
            }
          }

          // Cluster CoS children by threadId so same-thread rows are adjacent.
          for (const grp of swarmGroups.values()) {
            if (grp.type !== 'cos') continue;
            grp.children.sort((a, b) => {
              const at = (cosGroupForSession(a)?.threadId || '');
              const bt = (cosGroupForSession(b)?.threadId || '');
              if (at !== bt) return at.localeCompare(bt);
              const ad = new Date(a.startedAt || a.createdAt || 0).getTime();
              const bd = new Date(b.startedAt || b.createdAt || 0).getTime();
              return ad - bd;
            });
          }

          // Renders CoS children with a per-thread divider so operators can
          // distinguish which thread each row belongs to.
          const renderCosChildren = (children: any[]) => {
            const out: any[] = [];
            let lastThreadId = '';
            for (const child of children) {
              const link = cosGroupForSession(child);
              const tid = link?.threadId || '';
              if (tid && tid !== lastThreadId) {
                out.push(
                  <div key={`cos-thread-${tid}`} class="sidebar-cos-thread-divider" title={tid}>
                    {link?.name || 'Thread'}
                  </div>,
                );
                lastThreadId = tid;
              }
              out.push(renderItem(child));
            }
            return out;
          };

          // Remaining: parentSessionId-based hierarchy (only for non-swarm sessions)
          for (const s of restAgents) {
            if (swarmChildIds.has(s.id)) continue;
            if (s.parentSessionId && sessionById.has(s.parentSessionId)) {
              const parentVisible = restAgents.some((a: any) => a.id === s.parentSessionId && !swarmChildIds.has(a.id));
              if (parentVisible) {
                childIds.add(s.id);
                const arr = childrenByParent.get(s.parentSessionId) || [];
                arr.push(s);
                childrenByParent.set(s.parentSessionId, arr);
              }
            }
          }
          // Top-level: sessions that are not children of another visible session and not in a swarm group
          const topLevel = restAgents.filter((s: any) => !childIds.has(s.id) && !swarmChildIds.has(s.id));

          const renderHierarchical = (items: any[]) => {
            return items.map((s: any) => {
              const children = childrenByParent.get(s.id);
              if (!children || children.length === 0) return renderItem(s);
              const expanded = sessionExpandedParents.value.has(s.id);
              return (
                <div key={`tree-${s.id}`} class="sidebar-session-tree">
                  <div class="sidebar-session-tree-row">
                    <button
                      class="sidebar-tree-toggle"
                      onClick={(e) => { e.stopPropagation(); toggleExpandedParent(s.id); }}
                      title={expanded ? 'Collapse' : 'Expand'}
                    >
                      {expanded ? '\u25be' : '\u25b8'}
                    </button>
                    <span class="sidebar-tree-count">{children.length}</span>
                    {renderItem(s)}
                  </div>
                  {expanded && (
                    <div class="sidebar-session-tree-children">
                      {children.map(renderItem)}
                    </div>
                  )}
                </div>
              );
            });
          };

          const renderSwarmGroups = () => {
            const entries = [...swarmGroups.entries()];
            if (entries.length === 0) return null;
            return entries.map(([key, grp]) => {
              const expanded = sessionExpandedParents.value.has(key);
              const activeCount = grp.children.filter((c: any) => c.status === 'running').length;
              const isCos = grp.type === 'cos';
              return (
                <div key={`sgrp-${key}`} class={`sidebar-session-tree${isCos ? ' sidebar-cos-group' : ''}`}>
                  <div class="sidebar-session-tree-row">
                    <button
                      class="sidebar-tree-toggle"
                      onClick={(e) => { e.stopPropagation(); toggleExpandedParent(key); }}
                      title={expanded ? 'Collapse' : 'Expand'}
                    >
                      {expanded ? '\u25be' : '\u25b8'}
                    </button>
                    <span class="sidebar-tree-count">{grp.children.length}</span>
                    {isCos && <span class="sidebar-cos-badge">CoS</span>}
                    <span
                      class="sidebar-swarm-group-label"
                      style={{
                        fontSize: 11,
                        color: 'var(--pw-text-faint)',
                        fontWeight: 600,
                        cursor: 'pointer',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isCos) {
                          // No /wiggum page for CoS threads — just toggle expand.
                          toggleExpandedParent(key);
                          return;
                        }
                        const appId = grp.children[0]?.appId || selectedAppId.value;
                        if (appId) navigate(`/app/${appId}/wiggum`);
                      }}
                    >
                      {grp.label}
                      {activeCount > 0 && <span style={{ color: '#4CAF50', marginLeft: 4, fontWeight: 400 }}>{activeCount} running</span>}
                    </span>
                    <button
                      class="sidebar-new-terminal-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        const groupAppId = grp.children[0]?.appId || selectedAppId.value || '__unlinked__';
                        quickDispatchInitialType.value = isCos ? 'powwow' : 'wiggum';
                        quickDispatchAppKey.value = quickDispatchAppKey.value === groupAppId ? null : groupAppId;
                      }}
                      title={isCos ? 'New powwow in this app' : 'New wiggum in this app'}
                    >+</button>
                  </div>
                  {expanded && (
                    <div class="sidebar-session-tree-children">
                      {isCos ? renderCosChildren(grp.children) : grp.children.map(renderItem)}
                    </div>
                  )}
                </div>
              );
            });
          };

          if (sessionGroupByApp.value) {
            // Group by app — include swarm groups within each app section
            const appMap = new Map<string, any[]>();
            const appSwarmMap = new Map<string, Map<string, { label: string; type: string; children: any[] }>>();
            for (const s of topLevel) {
              const key = s.appId || '__unlinked__';
              const arr = appMap.get(key) || [];
              arr.push(s);
              appMap.set(key, arr);
            }
            // Distribute swarm groups to their app
            for (const [sgKey, grp] of swarmGroups) {
              const appKey = grp.children[0]?.appId || '__unlinked__';
              let appSwarms = appSwarmMap.get(appKey);
              if (!appSwarms) { appSwarms = new Map(); appSwarmMap.set(appKey, appSwarms); }
              appSwarms.set(sgKey, grp);
              // Ensure the app key exists even if it has no standalone sessions
              if (!appMap.has(appKey)) appMap.set(appKey, []);
            }

            // Keep registered apps in the list even with zero sessions so users can
            // launch a new one via the + button. Skip when searching (search should
            // only surface matching sessions) and respect active app filters.
            if (!sessionSearchQuery.value) {
              const appFilter = sessionAppFilters.value;
              for (const app of applications.value) {
                if (appFilter.size > 0 && !appFilter.has(app.id)) continue;
                if (!appMap.has(app.id)) appMap.set(app.id, []);
              }
            }

            const appList = applications.value;
            const appName = (id: string) => {
              if (id === '__unlinked__') return 'Unlinked';
              return appList.find((a: any) => a.id === id)?.name || id.slice(-8);
            };
            const sortedKeys = [...new Set([...appMap.keys(), ...appSwarmMap.keys()])].sort((a, b) => {
              if (a === '__unlinked__') return 1;
              if (b === '__unlinked__') return -1;
              return appName(a).localeCompare(appName(b));
            });
            return sortedKeys.map((appKey) => {
              const items = appMap.get(appKey) || [];
              const appSwarms = appSwarmMap.get(appKey);
              const totalCount = items.length + (appSwarms ? [...appSwarms.values()].reduce((sum, g) => sum + g.children.length, 0) : 0);
              const collapsed = sessionCollapsedAppGroups.value.has(appKey);
              return (
                <div key={`appgrp-${appKey}`}>
                  <div
                    class="sidebar-section-label sidebar-app-group-label"
                    onClick={() => toggleCollapsedAppGroup(appKey)}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                  >
                    <span class="sidebar-tree-toggle" style={{ marginRight: 2 }}>
                      {collapsed ? '\u25b8' : '\u25be'}
                    </span>
                    {appName(appKey)} ({totalCount})
                    <button
                      class="sidebar-new-terminal-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        quickDispatchInitialType.value = null;
                        quickDispatchAppKey.value = quickDispatchAppKey.value === appKey ? null : appKey;
                      }}
                      title="New session"
                    >+</button>
                  </div>
                  {quickDispatchAppKey.value === appKey && (
                    <QuickDispatchPopup
                      appKey={appKey}
                      appName={appName(appKey)}
                      initialDispatchType={quickDispatchInitialType.value || undefined}
                      onClose={() => { quickDispatchAppKey.value = null; quickDispatchInitialType.value = null; }}
                    />
                  )}
                  {!collapsed && (
                    <>
                      {appSwarms && [...appSwarms.entries()].map(([key, grp]) => {
                        const exp = sessionExpandedParents.value.has(key);
                        const activeCount = grp.children.filter((c: any) => c.status === 'running').length;
                        const isCos = grp.type === 'cos';
                        return (
                          <div key={`sgrp-${key}`} class={`sidebar-session-tree${isCos ? ' sidebar-cos-group' : ''}`}>
                            <div class="sidebar-session-tree-row">
                              <button class="sidebar-tree-toggle" onClick={(e) => { e.stopPropagation(); toggleExpandedParent(key); }}>
                                {exp ? '\u25be' : '\u25b8'}
                              </button>
                              <span class="sidebar-tree-count">{grp.children.length}</span>
                              {isCos && <span class="sidebar-cos-badge">CoS</span>}
                              <span style={{ fontSize: 11, color: 'var(--pw-text-faint)', fontWeight: 600, cursor: 'pointer', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isCos) { toggleExpandedParent(key); return; }
                                  const swarmAppId = grp.children[0]?.appId || appKey;
                                  if (swarmAppId && swarmAppId !== '__unlinked__') navigate(`/app/${swarmAppId}/wiggum`);
                                }}>
                                {grp.label}
                                {activeCount > 0 && <span style={{ color: '#4CAF50', marginLeft: 4, fontWeight: 400 }}>{activeCount} running</span>}
                              </span>
                              <button
                                class="sidebar-new-terminal-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  quickDispatchInitialType.value = isCos ? 'powwow' : 'wiggum';
                                  quickDispatchAppKey.value = quickDispatchAppKey.value === appKey ? null : appKey;
                                }}
                                title={isCos ? 'New powwow in this app' : 'New wiggum in this app'}
                              >+</button>
                            </div>
                            {exp && <div class="sidebar-session-tree-children">{isCos ? renderCosChildren(grp.children) : grp.children.map(renderItem)}</div>}
                          </div>
                        );
                      })}
                      {renderHierarchical(items)}
                    </>
                  )}
                </div>
              );
            });
          }
          const ungroupedKey = selectedAppId.value || '__all__';
          return (
            <>
              <div class="sidebar-section-label" style={{ display: 'flex', alignItems: 'center' }}>
                Agent Sessions ({restAgents.length})
                <button
                  class="sidebar-new-terminal-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    quickDispatchInitialType.value = null;
                    quickDispatchAppKey.value = quickDispatchAppKey.value === ungroupedKey ? null : ungroupedKey;
                  }}
                  title="New session"
                >+</button>
              </div>
              {quickDispatchAppKey.value === ungroupedKey && (
                <QuickDispatchPopup
                  appKey={selectedAppId.value || '__unlinked__'}
                  appName={selectedAppId.value ? (applications.value.find((a: any) => a.id === selectedAppId.value)?.name || selectedAppId.value.slice(-8)) : undefined}
                  initialDispatchType={quickDispatchInitialType.value || undefined}
                  onClose={() => { quickDispatchAppKey.value = null; quickDispatchInitialType.value = null; }}
                />
              )}
              {renderSwarmGroups()}
              {renderHierarchical(topLevel)}
            </>
          );
        })()}
      </div>
    </div>
  );
}
