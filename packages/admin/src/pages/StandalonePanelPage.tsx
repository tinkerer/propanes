import { useEffect, useState, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { renderTabContent } from '../components/PaneContent.js';
import { SessionIdMenu } from '../components/SessionIdMenu.js';
import { SshSetupDialog } from '../components/SshSetupDialog.js';
import { tabLabel } from '../components/PopoutPanelContent.js';
import { type ViewMode } from '../components/SessionViewToggle.js';
import {
  allSessions,
  sessionMapComputed,
  startSessionPolling,
  markSessionExited,
  exitedSessions,
  getSessionLabel,
  feedbackTitleCache,
  sessionInputStates,
  resolveSession,
  killSession,
  resumeSession,
  getViewMode,
  setViewMode,
} from '../lib/sessions.js';
import { applyTheme } from '../lib/settings.js';
import { selectedAppId } from '../lib/state.js';
import { startStandalonePanelTabDrag, openSessionExternally } from '../lib/tab-drag.js';

export interface PanelRouteParams {
  sessionIds: string[];
  activeId: string;
  rightIds: string[];
  ratio: number;
}

export function parsePanelRoute(route: string): PanelRouteParams | null {
  const after = route.slice('/panel/'.length);
  if (!after) return null;
  const [idPart, queryPart] = after.split('?');
  const sessionIds = idPart.split(',').map((s) => decodeURIComponent(s)).filter(Boolean);
  if (sessionIds.length === 0) return null;
  const params = new URLSearchParams(queryPart || '');
  const activeId = params.get('active') ? decodeURIComponent(params.get('active')!) : sessionIds[0];
  const rightRaw = params.get('right');
  const rightIds = rightRaw ? rightRaw.split(',').map((s) => decodeURIComponent(s)).filter(Boolean) : [];
  const ratio = Number(params.get('ratio')) || 0.5;
  return { sessionIds, activeId, rightIds, ratio: Math.max(0.2, Math.min(0.8, ratio)) };
}

export function buildPanelRoute(params: { sessionIds: string[]; activeId?: string | null; rightIds?: string[]; ratio?: number }): string {
  const ids = params.sessionIds.map(encodeURIComponent).join(',');
  const search = new URLSearchParams();
  if (params.activeId) search.set('active', encodeURIComponent(params.activeId));
  if (params.rightIds && params.rightIds.length > 0) search.set('right', params.rightIds.map(encodeURIComponent).join(','));
  if (params.ratio && params.ratio !== 0.5) search.set('ratio', String(params.ratio));
  const qs = search.toString();
  return `/panel/${ids}${qs ? `?${qs}` : ''}`;
}

function isCompanionTabId(sid: string): boolean {
  return sid.startsWith('jsonl:')
    || sid.startsWith('feedback:')
    || sid.startsWith('fb:')
    || sid.startsWith('iframe:')
    || sid.startsWith('terminal:')
    || sid.startsWith('artifact:')
    || sid.startsWith('isolate:')
    || sid.startsWith('url:')
    || sid.startsWith('file:')
    || sid.startsWith('wiggum-runs:')
    || sid.startsWith('summary:')
    || sid.startsWith('view:');
}

function companionIcon(sid: string): string {
  if (sid.startsWith('feedback:') || sid.startsWith('fb:')) return '\u{1F4AC}';
  if (sid.startsWith('jsonl:')) return '\u{1F4DC}';
  if (sid.startsWith('summary:')) return '\u{1F4CA}';
  if (sid.startsWith('iframe:') || sid.startsWith('url:')) return '\u{1F310}';
  if (sid.startsWith('terminal:')) return '\u{25B8}';
  if (sid.startsWith('artifact:')) return '\u{1F4CB}';
  return '◆';
}

const idMenuOpenSid = signal<string | null>(null);

export function StandalonePanelPage({ params }: { params: PanelRouteParams }) {
  useEffect(() => { applyTheme(); }, []);
  useEffect(() => {
    const cleanup = startSessionPolling();
    return cleanup;
  }, []);

  const initialLeft = params.sessionIds.filter((id) => !params.rightIds.includes(id));
  const [leftIds, setLeftIds] = useState<string[]>(initialLeft);
  const [rightIds, setRightIds] = useState<string[]>(params.rightIds);
  const [leftActiveId, setLeftActiveId] = useState<string>(
    initialLeft.includes(params.activeId) ? params.activeId : (initialLeft[0] || params.sessionIds[0])
  );
  const [rightActiveId, setRightActiveId] = useState<string>(params.rightIds[0] || '');

  const sessions = allSessions.value;
  const sessionMap = sessionMapComputed.value;
  void sessions;

  const activeLeft = leftIds.includes(leftActiveId) ? leftActiveId : (leftIds[0] || '');
  const activeRight = rightIds.includes(rightActiveId) ? rightActiveId : (rightIds[0] || '');

  const activeLeftSess = activeLeft ? sessionMap.get(activeLeft) : null;
  const isLeftCompanion = !activeLeft || isCompanionTabId(activeLeft);
  const isLeftExited = activeLeft ? exitedSessions.value.has(activeLeft) : false;
  const leftIdAnchorRef = useRef<HTMLSpanElement>(null);
  const openMenuSid = idMenuOpenSid.value;
  const leftIdMenuOpen = openMenuSid === activeLeft && !!activeLeft;

  const viewMode = activeLeft ? getViewMode(activeLeft) : 'terminal';
  const docTitle = activeLeft ? tabLabel(activeLeft, sessionMap) : 'Panel';
  useEffect(() => { document.title = docTitle; }, [docTitle]);

  const appId = selectedAppId.value;
  const feedbackPath = activeLeftSess?.feedbackId
    ? appId ? `/app/${appId}/tickets/${activeLeftSess.feedbackId}` : `/tickets/${activeLeftSess.feedbackId}`
    : null;
  const feedbackHref = feedbackPath ? `${location.origin}${location.pathname}#${feedbackPath}` : null;

  const hasSplit = rightIds.length > 0;
  const leftFlex = hasSplit ? params.ratio : 1;
  const rightFlex = hasSplit ? 1 - params.ratio : 0;

  useEffect(() => {
    if (!openMenuSid) return;
    const close = () => { idMenuOpenSid.value = null; };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openMenuSid]);

  function handleCloseTab(sid: string) {
    if (leftIds.includes(sid)) {
      const next = leftIds.filter((id) => id !== sid);
      setLeftIds(next);
      if (activeLeft === sid) {
        setLeftActiveId(next[next.length - 1] || '');
      }
      if (next.length === 0 && rightIds.length === 0) {
        try { window.close(); } catch {}
      }
    } else if (rightIds.includes(sid)) {
      const next = rightIds.filter((id) => id !== sid);
      setRightIds(next);
      if (activeRight === sid) {
        setRightActiveId(next[next.length - 1] || '');
      }
    }
  }

  async function handleKill() {
    if (!activeLeft) return;
    await killSession(activeLeft);
    handleCloseTab(activeLeft);
  }

  async function handleResolve() {
    if (!activeLeft || !activeLeftSess?.feedbackId) return;
    await resolveSession(activeLeft, activeLeftSess.feedbackId);
    handleCloseTab(activeLeft);
  }

  async function handleResume() {
    if (!activeLeft) return;
    await resumeSession(activeLeft);
  }

  function renderTabBar(ids: string[], activeId: string, onActivate: (id: string) => void) {
    return (
      <div class="popout-tab-bar" style={{ cursor: 'default' }}>
        <div
          class="popout-tab-scroll"
          onWheel={(e: WheelEvent) => {
            const d = (e as any).deltaX || (e as any).deltaY;
            if (d) { e.preventDefault(); (e.currentTarget as HTMLElement).scrollLeft += d; }
          }}
        >
          {ids.map((sid) => {
            const tabSess = sessionMap.get(sid);
            const tabExited = exitedSessions.value.has(sid);
            const isComp = isCompanionTabId(sid);
            const tabInputState = !tabExited && !isComp ? (sessionInputStates.value.get(sid) || null) : null;
            const tabIsPlain = tabSess?.permissionProfile === 'plain';
            const isActiveTab = sid === activeId;
            return (
              <button
                key={sid}
                class={`popout-tab ${isActiveTab ? 'active' : ''}`}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  startStandalonePanelTabDrag(e, {
                    sessionId: sid,
                    label: tabLabel(sid, sessionMap),
                    onExternalPopOut: (draggedSid, zone) => {
                      openSessionExternally(draggedSid, zone);
                      handleCloseTab(draggedSid);
                    },
                    onClickFallback: () => onActivate(sid),
                  });
                }}
                title={tabSess?.feedbackTitle || sid}
              >
                {!isComp && (
                  <span class={`status-dot${tabExited ? ' exited' : ''}${tabIsPlain ? ' plain' : ''}${tabInputState ? ` ${tabInputState}` : ''}`} />
                )}
                {isComp && <span class="companion-icon">{companionIcon(sid)}</span>}
                <span class="popout-tab-label">{tabLabel(sid, sessionMap)}</span>
                <span
                  class="popout-tab-close"
                  onClick={(e) => { e.stopPropagation(); handleCloseTab(sid); }}
                >&times;</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderHeader() {
    if (!activeLeft || isLeftCompanion) return null;
    return (
      <div class="popout-header">
        <span
          ref={leftIdAnchorRef}
          class="session-id-label"
          onClick={(e) => { e.stopPropagation(); idMenuOpenSid.value = leftIdMenuOpen ? null : activeLeft; }}
        >
          pw-{activeLeft.slice(-6)} <span class="id-dropdown-caret">{'▾'}</span>
        </span>
        {leftIdMenuOpen && (
          <SessionIdMenu
            sessionId={activeLeft}
            sess={activeLeftSess}
            isExited={isLeftExited}
            anchorRef={leftIdAnchorRef}
            onClose={() => { idMenuOpenSid.value = null; }}
            context={{ mode: 'standalone' }}
          />
        )}
        {feedbackHref && (
          <a
            href={feedbackHref}
            target="_blank"
            rel="noopener"
            class="feedback-title-link"
            title={activeLeftSess?.feedbackTitle || 'View feedback'}
            onClick={(e) => e.stopPropagation()}
          >
            {activeLeftSess?.feedbackTitle || 'View feedback'}
          </a>
        )}
        <span style="flex:1" />
        <div class="popout-header-actions">
          {activeLeftSess?.jsonlPath && (
            <select
              class="view-mode-select"
              value={viewMode}
              onChange={(e) => setViewMode(activeLeft, (e.target as HTMLSelectElement).value as ViewMode)}
            >
              <option value="terminal">Term</option>
              <option value="structured">Struct</option>
              <option value="split">Split</option>
            </select>
          )}
          {activeLeftSess?.feedbackId && (
            <button class="btn-resolve" onClick={handleResolve} title="Resolve">Resolve</button>
          )}
          {isLeftExited ? (
            <button onClick={handleResume} title="Resume">Resume</button>
          ) : (
            <button class="btn-kill" onClick={handleKill} title="Kill">Kill</button>
          )}
        </div>
      </div>
    );
  }

  function renderPane(ids: string[], activeId: string, onActivate: (id: string) => void, isLeft: boolean) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
        {renderTabBar(ids, activeId, onActivate)}
        {isLeft && renderHeader()}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {activeId && renderTabContent(activeId, true, sessionMap, (code, text) => markSessionExited(activeId, code, text))}
        </div>
      </div>
    );
  }

  return (
    <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: leftFlex, minWidth: 0, display: 'flex' }}>
          {renderPane(leftIds, activeLeft, setLeftActiveId, true)}
        </div>
        {hasSplit && (
          <>
            <div class="standalone-panel-splitter" />
            <div style={{ flex: rightFlex, minWidth: 0, display: 'flex' }}>
              {renderPane(rightIds, activeRight, setRightActiveId, false)}
            </div>
          </>
        )}
      </div>
      <SshSetupDialog />
    </div>
  );
}
