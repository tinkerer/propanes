import {
  allSessions,
  openTabs,
  sessionInputStates,
  sessionSearchQuery,
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
  termPickerOpen,
  activeTabId,
  rightPaneActiveId,
  sidebarStatusMenu,
  sidebarItemMenu,
  sessionPassesFilters,
} from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';

export function TerminalsListView() {
  const sessions = allSessions.value;
  const tabs = openTabs.value;
  const tabSet = new Set(tabs);
  for (const panel of popoutPanels.value) {
    for (const sid of panel.sessionIds) tabSet.add(sid);
  }
  const terminals = sessions
    .filter((s: any) => s.permissionProfile === 'plain' && sessionPassesFilters(s, tabSet))
    .sort((a: any, b: any) => {
      const aOpen = tabSet.has(a.id) ? 0 : 1;
      const bOpen = tabSet.has(b.id) ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return new Date(b.startedAt || b.createdAt || 0).getTime() -
        new Date(a.startedAt || a.createdAt || 0).getTime();
    });

  const visibleSet = new Set<string>();
  if (activeTabId.value) visibleSet.add(activeTabId.value);
  if (rightPaneActiveId.value) visibleSet.add(rightPaneActiveId.value);
  for (const p of popoutPanels.value) {
    if (p.visible && p.activeSessionId) visibleSet.add(p.activeSessionId);
  }

  const filtered = terminals.filter((s: any) => {
    if (!sessionSearchQuery.value) return true;
    const q = sessionSearchQuery.value.toLowerCase();
    const text = [getSessionLabel(s.id), s.title, s.paneTitle, s.paneCommand, s.panePath, s.id].filter(Boolean).join(' ').toLowerCase();
    return text.includes(q);
  });

  return (
    <div class="sessions-list-view" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div class="sidebar-sessions-list" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {filtered.map((s: any) => {
          const isTabbed = tabSet.has(s.id);
          const isInPanel = !!findPanelForSession(s.id);
          const isVisible = visibleSet.has(s.id);
          const inputSt = s.status === 'running' ? (sessionInputStates.value.get(s.id) || null) : null;
          const plainLabel = s.title
            ? s.title
            : s.paneCommand
              ? `${s.paneCommand}:${s.panePath || ''} \u2014 ${s.paneTitle || s.id.slice(-6)}`
              : (s.paneTitle || s.id.slice(-6));
          const customLabel = getSessionLabel(s.id);
          const locationPrefix = s.isHarness ? '\u{1F4E6}' : s.isRemote ? '\u{1F310}' : '';
          const label = customLabel || `${locationPrefix || '\u{1F5A5}\uFE0F'} ${plainLabel}`;
          return (
            <div key={s.id} class="sidebar-session-item-wrapper">
              <div
                class={`sidebar-session-item ${isTabbed ? 'tabbed' : ''} ${isInPanel ? 'in-panel' : ''} ${isVisible ? 'active' : ''}`}
                style={getSessionColor(s.id) ? { borderLeft: `3px solid ${getSessionColor(s.id)}` } : undefined}
                onClick={() => {
                  const panel = findPanelForSession(s.id);
                  if (panel) {
                    updatePanel(panel.id, { activeSessionId: s.id, visible: true });
                    bringToFront(panel.id);
                    persistPopoutState();
                    focusSessionTerminal(s.id);
                  } else {
                    openSession(s.id);
                    focusSessionTerminal(s.id);
                  }
                }}
                title={`Terminal \u2014 ${s.status}`}
              >
                <span class="sidebar-dot-wrapper">
                  <span
                    class={`session-status-dot ${s.status} plain${inputSt ? ` ${inputSt}` : ''}`}
                    title={s.status}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      sidebarStatusMenu.value = { sessionId: s.id, x: rect.right + 4, y: rect.top };
                    }}
                  />
                </span>
                <span class="session-label">{label}</span>
                <button
                  class="sidebar-item-menu-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    sidebarItemMenu.value = { sessionId: s.id, x: rect.right + 4, y: rect.top };
                  }}
                  title="Session actions"
                >{'\u25BE'}</button>
                <button
                  class="session-delete-btn"
                  onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                  title="Archive session"
                >{'\u00D7'}</button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--pw-text-muted)', fontSize: '12px' }}>No terminals</div>
        )}
      </div>
    </div>
  );
}
