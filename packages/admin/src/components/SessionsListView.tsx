import { useEffect, useRef } from 'preact/hooks';
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
} from '../lib/sessions.js';
import { setFocusedLeaf } from '../lib/pane-tree.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { autoJumpWaiting, autoJumpInterrupt, autoJumpDelay, autoJumpShowPopup, autoJumpLogs, autoCloseWaitingPanel, autoJumpHandleBounce } from '../lib/settings.js';
import { selectedAppId } from '../lib/state.js';
import { PopupMenu } from './PopupMenu.js';

const autoJumpMenuOpen = signal(false);

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
        s === 'running' ? 0 : s === 'pending' ? 1 : 2;
      const diff = statusOrder(a.status) - statusOrder(b.status);
      if (diff !== 0) return diff;
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
    const raw = customLabel || (isPlain ? `${locationPrefix || '\u{1F5A5}\uFE0F'} ${plainLabel}` : `${locationPrefix ? locationPrefix + ' ' : ''}${s.feedbackTitle || s.agentName || `Session ${s.id.slice(-6)}`}`);
    const tooltipParts: string[] = [];
    if (s.isHarness) tooltipParts.push(`Harness: ${s.harnessName || 'unknown'}`);
    else if (s.isRemote) tooltipParts.push(`Remote: ${s.machineName || s.launcherHostname || 'unknown'}`);
    if (s.paneCommand) tooltipParts.push(`Process: ${s.paneCommand}`);
    if (s.panePath) tooltipParts.push(`Path: ${s.panePath}`);
    tooltipParts.push(isPlain
      ? `Terminal \u2014 ${s.status}`
      : s.feedbackTitle
        ? `${s.feedbackTitle} \u2014 ${s.status}`
        : `${s.agentName || 'Session'} \u2014 ${s.status}`);
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
          <span class="session-label">{sessionSearchQuery.value ? highlightMatch(raw, sessionSearchQuery.value) : raw}</span>
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
              {(['running', 'pending', 'completed', 'failed', 'killed'] as const).map((status) => (
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
        {restAgents.length > 0 && (
          <>
            <div class="sidebar-section-label">Agent Sessions ({restAgents.length})</div>
            {restAgents.map(renderItem)}
          </>
        )}
      </div>
    </div>
  );
}
