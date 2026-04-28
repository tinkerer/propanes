import { useRef } from 'preact/hooks';
import { copyWithTooltip } from '../lib/clipboard.js';
import { type ViewMode } from './SessionViewToggle.js';
import {
  type PopoutPanelState,
  exitedSessions,
  killSession,
  resumeSession,
  getViewMode,
  setViewMode,
  resolveSession,
  togglePanelCompanion,
  getTerminalCompanion,
} from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';
import { SessionIdMenu } from './SessionIdMenu.js';
import { popoutIdMenuOpen, companionMenuOpen } from './popout-signals.js';

export function PopoutPaneHeader({
  tabId,
  panel,
  sessionMap,
  anchorId,
}: {
  tabId: string | null;
  panel: PopoutPanelState;
  sessionMap: Map<string, any>;
  anchorId: string;
}) {
  const idMenuTriggerRef = useRef<HTMLSpanElement>(null);
  const isJsonlTab = tabId?.startsWith('jsonl:') || false;
  const isFeedbackTab = tabId?.startsWith('feedback:') || false;
  const isIframeTab = tabId?.startsWith('iframe:') || false;
  const isTerminalTab = tabId?.startsWith('terminal:') || false;
  const isIsolateTab = tabId?.startsWith('isolate:') || false;
  const isUrlTab = tabId?.startsWith('url:') || false;
  const isArtifactTab = tabId?.startsWith('artifact:') || false;
  const isCompanionTab = isJsonlTab || isFeedbackTab || isIframeTab || isTerminalTab || isIsolateTab || isUrlTab || isArtifactTab;
  const realSessionId = isCompanionTab && tabId ? tabId.slice(tabId.indexOf(':') + 1) : tabId;
  const sess = realSessionId ? sessionMap.get(realSessionId) : null;
  const appId = selectedAppId.value;
  const feedbackPath = sess?.feedbackId
    ? appId ? `/app/${appId}/tickets/${sess.feedbackId}` : `/tickets/${sess.feedbackId}`
    : null;
  const viewMode = realSessionId ? getViewMode(realSessionId) : 'terminal';
  const isExited = realSessionId ? exitedSessions.value.has(realSessionId) : false;
  const showCompanionMenu = companionMenuOpen.value === anchorId;

  return (
    <div class="popout-header">
      {tabId && isCompanionTab && (
        <>
          {isTerminalTab ? (
            (() => {
              const termSid = getTerminalCompanion(realSessionId!);
              const isLoading = termSid === '__loading__';
              const label = isLoading ? 'Terminal: loading...' : `Terminal: pw-${termSid?.slice(-6) || realSessionId!.slice(-6)}`;
              return (
                <div class="id-dropdown-wrapper">
                  <span
                    class="session-id-label"
                    style="cursor:pointer"
                    onClick={() => { if (!isLoading) companionMenuOpen.value = showCompanionMenu ? null : anchorId; }}
                  >
                    {label}
                    {!isLoading && <span class="id-dropdown-caret">{'\u25BE'}</span>}
                  </span>
                  {showCompanionMenu && termSid && !isLoading && (
                    <div class="id-dropdown-menu" onClick={() => { companionMenuOpen.value = null; }}>
                      <button onClick={(e: any) => { e.stopPropagation(); companionMenuOpen.value = null; copyWithTooltip(termSid, e); }}>
                        Copy ID: {termSid.slice(-8)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          ) : (
            (() => {
              const label = isJsonlTab ? `JSONL: pw-${realSessionId!.slice(-6)}`
                : isFeedbackTab ? `Ticket: pw-${realSessionId!.slice(-6)}`
                : isIframeTab ? `Page: pw-${realSessionId!.slice(-6)}`
                : isIsolateTab ? `Isolate: ${realSessionId}`
                : isUrlTab ? (() => { try { return `Iframe: ${new URL(realSessionId!).hostname}`; } catch { return `Iframe: ${realSessionId!.slice(0, 30)}`; } })()
                : isArtifactTab ? `Artifact: ${realSessionId!.slice(-6)}`
                : `pw-${realSessionId!.slice(-6)}`;
              return (
                <div class="id-dropdown-wrapper">
                  <span
                    class="session-id-label"
                    style="cursor:pointer"
                    onClick={() => { companionMenuOpen.value = showCompanionMenu ? null : anchorId; }}
                  >
                    {label}
                    <span class="id-dropdown-caret">{'\u25BE'}</span>
                  </span>
                  {showCompanionMenu && (
                    <div class="id-dropdown-menu" onClick={() => { companionMenuOpen.value = null; }}>
                      <button onClick={(e: any) => { e.stopPropagation(); companionMenuOpen.value = null; copyWithTooltip(realSessionId!, e); }}>
                        Copy ID: {realSessionId!.slice(-8)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          )}
          {feedbackPath && (
            <a
              href={`#${feedbackPath}`}
              onClick={(e) => { e.preventDefault(); if (sess?.feedbackId && realSessionId) togglePanelCompanion(panel.id, realSessionId, 'feedback'); }}
              class="feedback-title-link"
              title={sess?.feedbackTitle || 'View ticket'}
            >
              {sess?.feedbackTitle || 'View ticket'}
            </a>
          )}
        </>
      )}
      {tabId && !isCompanionTab && (
        <>
          <div class="id-dropdown-wrapper">
            <span
              ref={idMenuTriggerRef}
              class="session-id-label"
              onClick={() => { popoutIdMenuOpen.value = popoutIdMenuOpen.value === tabId ? null : tabId; }}
            >
              pw-{tabId.slice(-6)} <span class="id-dropdown-caret">{'\u25BE'}</span>
            </span>
            {popoutIdMenuOpen.value === tabId && (
              <SessionIdMenu
                sessionId={tabId}
                sess={sess}
                isExited={isExited}
                anchorRef={idMenuTriggerRef as any}
                onClose={() => { popoutIdMenuOpen.value = null; }}
                context={{ mode: 'popout', panel }}
              />
            )}
          </div>
          {feedbackPath && (
            <a
              href={`#${feedbackPath}`}
              onClick={(e) => { e.preventDefault(); if (sess?.feedbackId) togglePanelCompanion(panel.id, tabId, 'feedback'); }}
              class="feedback-title-link"
              title={sess?.feedbackTitle || 'View ticket'}
            >
              {sess?.feedbackTitle || 'View ticket'}
            </a>
          )}
        </>
      )}
      <span style="flex:1" />
      {tabId && !isCompanionTab && (
        <div class="popout-header-actions">
          {sess?.jsonlPath && (
            <select
              class="view-mode-select"
              value={viewMode}
              onChange={(e) => setViewMode(tabId, (e.target as HTMLSelectElement).value as ViewMode)}
            >
              <option value="terminal">Term</option>
              <option value="structured">Struct</option>
              <option value="split">Split</option>
            </select>
          )}
          {sess?.feedbackId && (
            <button class="btn-resolve" onClick={() => resolveSession(tabId, sess.feedbackId)} title="Resolve">Resolve</button>
          )}
          {isExited ? (
            <button onClick={() => resumeSession(tabId)} title="Resume">Resume</button>
          ) : (
            <button class="btn-kill" onClick={() => killSession(tabId)} title="Kill">Kill</button>
          )}
        </div>
      )}
    </div>
  );
}
