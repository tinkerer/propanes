import { useRef } from 'preact/hooks';
import { type ViewMode } from './SessionViewToggle.js';
import {
  type PopoutPanelState,
  updatePanel,
  persistPopoutState,
  killSession,
  resumeSession,
  setViewMode,
  resolveSession,
  togglePanelCompanion,
  sessionInputStates,
} from '../lib/sessions.js';
import { startPanelDrag } from '../lib/tab-drag.js';
import { IdDropdownMenu, WindowMenu } from './PopoutPanelContent.js';
import { popoutIdMenuOpen, popoutWindowMenuOpen, popoutStatusMenuOpen } from './popout-signals.js';

// Tab/header bar used when a panel holds exactly one tab.
//
// Renders a single "row" of: status dot -> id label (or singleton view label)
// -> ticket link -> view-mode toggle -> resolve/kill/resume -> window controls.
//
// Drag/dblclick handlers and the dragMoved ref are owned by PanelView (because
// the same handlers are reused for the multi-tab variant); we just receive
// them as props.
export function PopoutSingletonBar({
  panel,
  activeId,
  session,
  feedbackPath,
  isExited,
  isPlain,
  viewMode,
  showIdMenu,
  ids,
  docked,
  isLeftDocked,
  isMinimized,
  onHeaderDragStart,
  dragMoved,
  tl,
}: {
  panel: PopoutPanelState;
  activeId: string;
  session: any;
  feedbackPath: string | null;
  isExited: boolean;
  isPlain: boolean;
  viewMode: ViewMode;
  showIdMenu: boolean;
  ids: string[];
  docked: boolean;
  isLeftDocked: boolean;
  isMinimized: boolean;
  onHeaderDragStart: (e: MouseEvent, force?: boolean) => void;
  dragMoved: { current: boolean };
  tl: (sid: string) => string;
}) {
  const idMenuBtnRef = useRef<HTMLSpanElement>(null);
  const windowMenuBtnRef = useRef<HTMLButtonElement>(null);
  return (
    <div class="popout-tab-bar popout-singleton-bar" onMouseDown={onHeaderDragStart} onDblClick={() => {
      if (!docked) { updatePanel(panel.id, { minimized: !panel.minimized }); persistPopoutState(); }
    }}>
      {activeId && !activeId.startsWith('view:') && (
        <span
          class={`status-dot${isExited ? ' exited' : ''}${isPlain ? ' plain' : ''}${!isExited ? ` ${sessionInputStates.value.get(activeId) || ''}` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            popoutStatusMenuOpen.value = { sessionId: activeId, panelId: panel.id, x: rect.left, y: rect.bottom + 4 };
          }}
        />
      )}
      {activeId && activeId.startsWith('view:') && (
        <span class="singleton-label" style="font-weight:600;font-size:12px;margin:0 8px;white-space:nowrap">{tl(activeId)}</span>
      )}
      {activeId && !activeId.startsWith('view:') && (
        <>
          <span
            ref={idMenuBtnRef}
            class="session-id-label"
            onClick={(e) => { e.stopPropagation(); popoutIdMenuOpen.value = showIdMenu ? null : activeId; }}
          >
            pw-{activeId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
          </span>
          {showIdMenu && (
            <IdDropdownMenu activeId={activeId} panel={panel} session={session} isExited={isExited} anchorRef={idMenuBtnRef} onClose={() => { popoutIdMenuOpen.value = null; }} />
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
          ref={windowMenuBtnRef}
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
          <WindowMenu panel={panel} activeId={activeId} docked={docked} isLeftDocked={isLeftDocked} isMinimized={isMinimized} anchorRef={windowMenuBtnRef} onClose={() => { popoutWindowMenuOpen.value = null; }} />
        )}
        <button class="btn-close-panel" onClick={() => { updatePanel(panel.id, { visible: false }); persistPopoutState(); }} title="Hide panel">&times;</button>
      </div>
    </div>
  );
}
