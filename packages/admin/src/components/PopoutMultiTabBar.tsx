import { useRef } from 'preact/hooks';
import { type ViewMode } from './SessionViewToggle.js';
import {
  type PopoutPanelState,
  updatePanel,
  persistPopoutState,
  killSession,
  resumeSession,
  setViewMode,
  closeTab,
  resolveSession,
  togglePanelCompanion,
  switchAutoJumpActiveSession,
  exitedSessions,
  sessionInputStates,
  getSessionLabel,
  setSessionLabel,
  getSessionColor,
} from '../lib/sessions.js';
import { startTabDrag, startPanelDrag } from '../lib/tab-drag.js';
import { ctrlShiftHeld } from '../lib/shortcuts.js';
import { PanelTabBadge, IdDropdownMenu, WindowMenu } from './PopoutPanelContent.js';
import {
  popoutIdMenuOpen,
  popoutWindowMenuOpen,
  popoutStatusMenuOpen,
  renamingSessionId,
  renameValue,
} from './popout-signals.js';

// The tab-list bar + companion header rendered when a panel holds two or more
// tabs. Inactive tabs are NOT mounted as content (lazy-mounting still happens
// in PanelView's body); this component only draws the row of `<button>`
// elements + the active-tab session header below it.
export function PopoutMultiTabBar({
  panel,
  ids,
  activeId,
  session,
  sessionMap,
  isExited,
  viewMode,
  feedbackPath,
  showIdMenu,
  docked,
  isLeftDocked,
  isMinimized,
  onHeaderDragStart,
  dragMoved,
  tabsRef,
  tl,
  globalNum,
}: {
  panel: PopoutPanelState;
  ids: string[];
  activeId: string;
  session: any;
  sessionMap: Map<string, any>;
  isExited: boolean;
  viewMode: ViewMode;
  feedbackPath: string | null;
  showIdMenu: boolean;
  docked: boolean;
  isLeftDocked: boolean;
  isMinimized: boolean;
  onHeaderDragStart: (e: MouseEvent, force?: boolean) => void;
  dragMoved: { current: boolean };
  tabsRef: { current: HTMLDivElement | null };
  tl: (sid: string) => string;
  globalNum: (sid: string) => number | null;
}) {
  const idMenuBtnRef2 = useRef<HTMLSpanElement>(null);
  const windowMenuBtnRef2 = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div class="popout-tab-bar" onMouseDown={onHeaderDragStart} onDblClick={() => {
        if (!docked) {
          updatePanel(panel.id, { minimized: !panel.minimized });
          persistPopoutState();
        }
      }}>
        <div ref={tabsRef as any} class="popout-tab-scroll" onWheel={(e: WheelEvent) => { const delta = (e as any).deltaX || (e as any).deltaY; if (delta) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += delta; } }}>
          {ids.map((sid) => {
            const gn = globalNum(sid);
            const tabSess = sessionMap.get(sid);
            const tabExited = exitedSessions.value.has(sid);
            const tabIsCompanion = sid.startsWith('jsonl:') || sid.startsWith('summary:') || sid.startsWith('feedback:') || sid.startsWith('iframe:') || sid.startsWith('terminal:') || sid.startsWith('artifact:');
            const tabIsFb = sid.startsWith('fb:');
            const tabInputState = !tabExited && !tabIsCompanion ? (sessionInputStates.value.get(sid) || null) : null;
            const tabIsPlain = tabSess?.permissionProfile === 'plain';
            const isActiveTab = sid === activeId;
            return (
              <button
                key={sid}
                class={`popout-tab ${isActiveTab ? 'active' : ''}`}
                style={getSessionColor(sid) ? { boxShadow: `inset 0 -2px 0 ${getSessionColor(sid)}` } : undefined}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  startTabDrag(e, {
                    sessionId: sid,
                    source: { panelId: panel.id },
                    label: tl(sid),
                    onClickFallback: () => {
                      if (!switchAutoJumpActiveSession(panel.id, sid)) {
                        updatePanel(panel.id, { activeSessionId: sid });
                        persistPopoutState();
                      }
                    },
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !renamingSessionId.value) {
                    e.preventDefault();
                    if (!switchAutoJumpActiveSession(panel.id, sid)) {
                      updatePanel(panel.id, { activeSessionId: sid });
                      persistPopoutState();
                    }
                  }
                }}
                title={tabSess?.feedbackTitle || sid}
                onDblClick={(e) => {
                  e.stopPropagation();
                  renameValue.value = getSessionLabel(sid) || '';
                  renamingSessionId.value = sid;
                }}
              >
                {!tabIsCompanion && !tabIsFb && <span
                  class={`status-dot${tabExited ? ' exited' : ''}${tabIsPlain ? ' plain' : ''}${tabInputState ? ` ${tabInputState}` : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    popoutStatusMenuOpen.value = { sessionId: sid, panelId: panel.id, x: rect.left, y: rect.bottom + 4 };
                  }}
                >
                  {ctrlShiftHeld.value && gn !== null && <PanelTabBadge tabNum={gn} />}
                </span>}
                {(tabIsCompanion || tabIsFb) && <span class="companion-icon">{
                  (sid.startsWith('feedback:') || sid.startsWith('fb:')) ? '\u{1F4AC}' :
                  sid.startsWith('jsonl:') ? '\u{1F4DC}' :
                  sid.startsWith('summary:') ? '\u{1F4CA}' :
                  sid.startsWith('iframe:') ? '\u{1F310}' :
                  sid.startsWith('terminal:') ? '\u{25B8}' :
                  sid.startsWith('artifact:') ? '\u{1F4CB}' :
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
                  <span class="popout-tab-label">{tl(sid)}</span>
                )}
                <span class="popout-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(sid); }}>&times;</span>
              </button>
            );
          })}
        </div>
      </div>
      <div class="popout-header" onMouseDown={onHeaderDragStart} onDblClick={() => {
        if (!docked) {
          updatePanel(panel.id, { minimized: !panel.minimized });
          persistPopoutState();
        }
      }}>
        {activeId && (
          <>
            <span
              ref={idMenuBtnRef2}
              class="session-id-label"
              onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = showIdMenu ? null : activeId; }}
            >
              pw-{activeId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
            </span>
            {showIdMenu && (
              <IdDropdownMenu activeId={activeId} panel={panel} session={session} isExited={isExited} anchorRef={idMenuBtnRef2} onClose={() => { popoutIdMenuOpen.value = null; }} />
            )}
          </>
        )}
        {feedbackPath && (
          <a
            href={`#${feedbackPath}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!dragMoved.current && activeId && session?.feedbackId) togglePanelCompanion(panel.id, activeId, 'feedback'); }}
            class="feedback-title-link"
            title={session?.feedbackTitle || 'View feedback'}
          >
            {session?.feedbackTitle || 'View feedback'}
          </a>
        )}
        <span style="flex:1" />
        <div class="popout-header-actions">
          {activeId && session?.jsonlPath && (
            <select
              class="view-mode-select"
              value={viewMode}
              onChange={(e) => setViewMode(activeId, (e.target as HTMLSelectElement).value as ViewMode)}
            >
              <option value="terminal">Term</option>
              <option value="structured">Struct</option>
              <option value="split">Split</option>
            </select>
          )}
          {activeId && session?.feedbackId && (
            <button class="btn-resolve" onClick={() => resolveSession(activeId, session.feedbackId)} title="Resolve">Resolve</button>
          )}
          {activeId && !activeId.startsWith('view:') && (isExited ? (
            <button onClick={() => resumeSession(activeId)} title="Resume">Resume</button>
          ) : (
            <button class="btn-kill" onClick={() => killSession(activeId)} title="Kill">Kill</button>
          ))}
        </div>
        <div class="popout-window-controls">
          <button
            ref={windowMenuBtnRef2}
            class="btn-window-menu"
            title="Window options (drag to move this panel to another pane)"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              startPanelDrag(e, {
                panelId: panel.id,
                label: `Panel: ${ids.length} tab${ids.length === 1 ? '' : 's'}`,
                onClickFallback: () => { popoutWindowMenuOpen.value = popoutWindowMenuOpen.value === panel.id ? null : panel.id; },
              });
            }}
          >
            {'\u2261'}
          </button>
          {popoutWindowMenuOpen.value === panel.id && (
            <WindowMenu panel={panel} activeId={activeId} docked={docked} isLeftDocked={isLeftDocked} isMinimized={isMinimized} anchorRef={windowMenuBtnRef2} onClose={() => { popoutWindowMenuOpen.value = null; }} />
          )}
          <button class="btn-close-panel" onClick={() => { updatePanel(panel.id, { visible: false }); persistPopoutState(); }} title="Hide panel">&times;</button>
        </div>
      </div>
    </>
  );
}
