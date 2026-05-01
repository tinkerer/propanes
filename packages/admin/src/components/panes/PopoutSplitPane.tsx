import { useRef } from 'preact/hooks';
import { copyWithTooltip } from '../lib/clipboard.js';
import { PopupMenu } from './PopupMenu.js';
import {
  type PopoutPanelState,
  updatePanel,
  persistPopoutState,
  switchAutoJumpActiveSession,
  disablePanelSplit,
  getSessionColor,
} from '../lib/sessions.js';
import { renderTabContent } from './PaneContent.js';
import { PopoutPaneHeader } from './PopoutPaneHeader.js';
import { companionMenuOpen } from './popout-signals.js';

// Renders the split-pane mode of a popout panel: a main (left/top) pane that
// holds the active session tab, and a companion (right/bottom) pane that
// holds the active companion tab. The two are separated by a draggable
// divider, or collapsed onto a single grab-handle when the user has hidden
// the companion.
//
// Strict-lazy mount invariant: only the active tab in each pane is passed to
// `renderTabContent` (`leftTabs.filter(sid => sid === activeId).map(...)` and
// the single-element activeCompanionId branch). Don't relax this — multiple
// AgentTerminal instances mounted at once will freeze Chrome.
export function PopoutSplitPane({
  panel,
  activeId,
  sessionMap,
  hasTabs,
  leftTabs,
  panelRightTabs,
  panelRightActive,
  leftSplitTabsRef,
  rightSplitTabsRef,
  onSplitDividerMouseDown,
  onPopoutCollapsedHandleMouseDown,
  tl,
  ccid,
}: {
  panel: PopoutPanelState;
  activeId: string;
  sessionMap: Map<string, any>;
  hasTabs: boolean;
  leftTabs: string[];
  panelRightTabs: string[];
  panelRightActive: string | null;
  leftSplitTabsRef: { current: HTMLDivElement | null };
  rightSplitTabsRef: { current: HTMLDivElement | null };
  onSplitDividerMouseDown: (e: MouseEvent) => void;
  onPopoutCollapsedHandleMouseDown: (e: MouseEvent, p: PopoutPanelState) => void;
  tl: (sid: string) => string;
  ccid: (sid: string) => string | null;
}) {
  const companionMenuBtnRef = useRef<HTMLButtonElement>(null);

  const edge: 'N' | 'S' | 'E' | 'W' = panel.splitEdge || 'E';
  const isHoriz = edge === 'E' || edge === 'W';
  const companionFirst = edge === 'W' || edge === 'N';
  const mainFlex = panel.splitCollapsed ? 1 : (panel.splitRatio ?? 0.5);
  const compFlex = panel.splitCollapsed ? 0 : (1 - (panel.splitRatio ?? 0.5));
  const activeCompanionId = panelRightActive || panelRightTabs[0] || null;
  const offsetTransform = panel.splitCollapsed
    ? (isHoriz ? `translateY(${panel.splitCollapsedOffset || 0}px)` : `translateX(${panel.splitCollapsedOffset || 0}px)`)
    : undefined;
  const chevron = edge === 'E' ? '◀' : edge === 'W' ? '▶' : edge === 'N' ? '▼' : '▲';

  const mainPane = (
    <div
      class="popout-split-pane"
      data-popout-split-pane={`${panel.id}:left`}
      style={{ flex: mainFlex }}
    >
      {hasTabs && leftTabs.length > 1 && (
        <div class="split-pane-tab-bar">
          <div
            ref={leftSplitTabsRef as any}
            class="popout-tab-scroll"
            onWheel={(e: WheelEvent) => { const delta = (e as any).deltaX || (e as any).deltaY; if (delta) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += delta; } }}
          >
            {leftTabs.map((sid) => (
              <button
                key={sid}
                class={`popout-tab ${sid === activeId ? 'active' : ''}`}
                style={getSessionColor(sid) ? { boxShadow: `inset 0 -2px 0 ${getSessionColor(sid)}` } : undefined}
                onClick={() => {
                  if (!switchAutoJumpActiveSession(panel.id, sid)) {
                    updatePanel(panel.id, { activeSessionId: sid });
                    persistPopoutState();
                  }
                }}
              >
                <span class="popout-tab-label">{tl(sid)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <PopoutPaneHeader
        tabId={activeId}
        panel={panel}
        sessionMap={sessionMap}
        anchorId={`left:${panel.id}:${activeId || 'none'}`}
      />
      <div class="popout-body">
        {leftTabs.filter((sid) => sid === activeId).map((sid) => renderTabContent(sid, true, sessionMap))}
      </div>
    </div>
  );

  const grabHandle = panel.splitCollapsed ? (
    <div
      class={`popout-split-grab popout-split-grab-${edge}`}
      style={{ transform: offsetTransform }}
      onMouseDown={(e) => onPopoutCollapsedHandleMouseDown(e, panel)}
      title="Drag to resize, click to expand (drag parallel to edge to reposition)"
    >
      <div class="popout-split-grab-chevron">{chevron}</div>
      <div class="popout-split-grab-label">
        {(() => {
          const activeSid = activeCompanionId;
          if (!activeSid) return 'PANE';
          const t = activeSid.split(':')[0];
          return (t === 'jsonl' || t === 'summary' || t === 'feedback' || t === 'iframe' || t === 'terminal' || t === 'isolate' || t === 'url')
            ? t.toUpperCase()
            : (panelRightTabs.length > 1 ? `${panelRightTabs.length} TABS` : 'PANE');
        })()}
      </div>
    </div>
  ) : null;

  const companionPane = panel.splitCollapsed ? null : (
    <div
      class="popout-split-pane"
      data-popout-split-pane={`${panel.id}:right`}
      style={{ flex: compFlex }}
    >
      {(() => {
        const activeSid = activeCompanionId;
        const activeTermId = activeSid ? ccid(activeSid) : null;
        const showCompMenu = companionMenuOpen.value === activeSid;
        return (
          <div class="split-pane-tab-bar">
            <div
              ref={rightSplitTabsRef as any}
              class="popout-tab-scroll"
              onWheel={(e: WheelEvent) => { const delta = (e as any).deltaX || (e as any).deltaY; if (delta) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += delta; } }}
            >
              {panelRightTabs.map((sid) => {
                const isActive = sid === activeSid;
                const hasCopyId = !!ccid(sid);
                return (
                  <button
                    key={sid}
                    ref={isActive && hasCopyId ? companionMenuBtnRef : undefined}
                    class={`popout-tab ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      if (isActive && hasCopyId) {
                        companionMenuOpen.value = showCompMenu ? null : sid;
                      } else {
                        companionMenuOpen.value = null;
                        updatePanel(panel.id, { rightPaneActiveId: sid });
                        persistPopoutState();
                      }
                    }}
                  >
                    <span class="popout-tab-label">{tl(sid)}{hasCopyId && isActive ? ` ${'▾'}` : ''}</span>
                  </button>
                );
              })}
            </div>
            {showCompMenu && activeTermId && (
              <PopupMenu anchorRef={companionMenuBtnRef} onClose={() => { companionMenuOpen.value = null; }} className="companion-dropdown">
                <button class="popup-menu-item" onClick={(e: any) => { e.stopPropagation(); companionMenuOpen.value = null; copyWithTooltip(activeTermId, e); }}>
                  Copy ID: {activeTermId.slice(-8)}
                </button>
              </PopupMenu>
            )}
            <button
              class="split-pane-unsplit-btn"
              onClick={(e) => {
                e.stopPropagation();
                const next: Record<'N'|'S'|'E'|'W', 'N'|'S'|'E'|'W'> = { E: 'S', S: 'W', W: 'N', N: 'E' };
                updatePanel(panel.id, { splitEdge: next[edge] });
                persistPopoutState();
              }}
              title={`Dock edge: ${edge} — click to rotate`}
            >
              {edge === 'E' ? '⇐' : edge === 'W' ? '⇒' : edge === 'N' ? '⇓' : '⇑'}
            </button>
            <button
              class="split-pane-unsplit-btn"
              onClick={(e) => { e.stopPropagation(); updatePanel(panel.id, { splitCollapsed: true }); persistPopoutState(); }}
              title="Collapse companion (keeps it available as an edge handle)"
            >
              {chevron}
            </button>
            <button
              class="split-pane-unsplit-btn"
              onClick={() => disablePanelSplit(panel.id)}
              title="Close split pane"
            >
              &times;
            </button>
          </div>
        );
      })()}
      <PopoutPaneHeader
        tabId={activeCompanionId}
        panel={panel}
        sessionMap={sessionMap}
        anchorId={`right:${panel.id}:${activeCompanionId || 'none'}`}
      />
      <div class="popout-body">
        {activeCompanionId && renderTabContent(activeCompanionId, true, sessionMap)}
      </div>
    </div>
  );

  const divider = panel.splitCollapsed ? null : (
    <div
      class={`popout-split-divider${isHoriz ? '' : ' popout-split-divider-h'}`}
      onMouseDown={onSplitDividerMouseDown}
    />
  );

  const children = companionFirst
    ? [grabHandle, companionPane, divider, mainPane]
    : [mainPane, divider, companionPane, grabHandle];

  return (
    <div
      class={`popout-split-container popout-split-edge-${edge}${panel.splitCollapsed ? ' split-collapsed' : ''}`}
      style={{ flexDirection: isHoriz ? 'row' : 'column' }}
    >
      {children.filter(Boolean)}
    </div>
  );
}
