import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { SessionViewToggle, type ViewMode } from '../components/terminal/SessionViewToggle.js';
import { renderTabContent } from '../components/panes/PaneContent.js';
import { SessionIdMenu } from '../components/sessions/SessionIdMenu.js';
import { SshSetupDialog } from '../components/modals/SshSetupDialog.js';
import { allSessions, sessionMapComputed, startSessionPolling, getViewMode, setViewMode, markSessionExited, setSessionInputState, exitedSessions, getSessionLabel, feedbackTitleCache } from '../lib/sessions.js';
import { applyTheme } from '../lib/settings.js';
import { isMobile } from '../lib/viewport.js';
import { navigate, selectedAppId } from '../lib/state.js';

const idMenuOpen = signal(false);

const viewMode = signal<ViewMode>('terminal');

function goBack() {
  const appId = selectedAppId.value;
  navigate(appId ? `/app/${appId}/sessions` : '/');
}

function goToFeedback(feedbackId: string) {
  const appId = selectedAppId.value;
  navigate(appId ? `/app/${appId}/tickets/${feedbackId}` : `/tickets/${feedbackId}`);
}

function isCompanionTab(sid: string): boolean {
  return sid.startsWith('view:')
    || sid.startsWith('jsonl:')
    || sid.startsWith('feedback:')
    || sid.startsWith('fb:')
    || sid.startsWith('iframe:')
    || sid.startsWith('terminal:')
    || sid.startsWith('isolate:')
    || sid.startsWith('url:')
    || sid.startsWith('file:')
    || sid.startsWith('settings:')
    || sid.startsWith('cos:')
    || sid.startsWith('wiggum-runs:')
    || sid.startsWith('summary:')
    || sid.startsWith('artifact:');
}

function standaloneTitle(sessionId: string, sess: any, isExited: boolean): string {
  const custom = getSessionLabel(sessionId);
  if (custom) return isExited ? `${custom} (exited)` : custom;
  if (sessionId.startsWith('fb:')) {
    const cached = feedbackTitleCache.value[sessionId.slice(3)];
    if (cached) return `FB: ${cached.slice(0, 60)}`;
    return `FB: ${sessionId.slice(-6)}`;
  }
  if (sessionId.startsWith('jsonl:')) {
    const realSid = sessionId.slice(6);
    const cs = allSessions.value.find((s: any) => s.id === realSid);
    if (cs?.feedbackTitle) return `Conversation: ${cs.feedbackTitle}`;
    return `Conversation: ${realSid.slice(0, 6)}`;
  }
  if (sessionId.startsWith('feedback:')) {
    const realSid = sessionId.slice(9);
    const cs = allSessions.value.find((s: any) => s.id === realSid);
    if (cs?.feedbackTitle) return `Ticket: ${cs.feedbackTitle}`;
    return `Ticket: ${realSid.slice(0, 6)}`;
  }
  if (sessionId.startsWith('terminal:')) return `Terminal: ${sessionId.slice(9, 15)}`;
  if (sessionId.startsWith('url:')) return `Iframe: ${sessionId.slice(4, 40)}`;
  if (sessionId.startsWith('cos:')) return 'Ops';
  const fallback = sess?.feedbackTitle || sess?.agentName || sess?.paneCommand || sess?.label || `pw-${sessionId.slice(-6)}`;
  return isExited ? `${fallback} (exited)` : fallback;
}

export function StandaloneSessionPage({ sessionId }: { sessionId: string }) {
  useEffect(() => { applyTheme(); }, []);
  useEffect(() => {
    const cleanup = startSessionPolling();
    return cleanup;
  }, []);

  const companion = isCompanionTab(sessionId);
  const sessions = allSessions.value;
  const sess = sessions.find((s: any) => s.id === sessionId);
  const isExited = exitedSessions.value.has(sessionId);
  const mode = getViewMode(sessionId) || viewMode.value;
  const mobile = isMobile.value;
  const selectableMode = mobile && mode === 'split' ? 'structured' : mode;
  const idMenuAnchorRef = useRef<HTMLButtonElement>(null);

  const title = standaloneTitle(sessionId, sess, isExited);
  useEffect(() => {
    document.title = title;
  }, [title]);

  const showIdMenu = !companion && idMenuOpen.value;

  return (
    <div class="standalone-session-root">
      <div class="standalone-session-toolbar" role="region" aria-label="Session controls">
        {mobile && (
          <button
            class="mobile-session-back"
            onClick={goBack}
            aria-label="Back to sessions"
            title="Back"
          >
            ←
          </button>
        )}
        {companion ? (
              <span class="standalone-session-title">{title}</span>
        ) : (
          <>
            <button
              type="button"
              ref={idMenuAnchorRef}
              class="session-id-label"
              aria-label="Session actions"
              aria-expanded={showIdMenu}
              onClick={(e) => { e.stopPropagation(); idMenuOpen.value = !idMenuOpen.value; }}
              title="Session actions"
            >
              pw-{sessionId.slice(-6)} <span class="id-dropdown-caret">{'▾'}</span>
            </button>
            {showIdMenu && (
              <SessionIdMenu
                sessionId={sessionId}
                sess={sess}
                isExited={isExited}
                anchorRef={idMenuAnchorRef}
                onClose={() => { idMenuOpen.value = false; }}
                context={{ mode: 'standalone' }}
              />
            )}
          </>
        )}
        {isExited && <span class="standalone-session-status">(exited)</span>}
        {!companion && sess?.feedbackId && sess?.feedbackTitle && (
          <button
            class="session-feedback-link"
            onClick={(e) => { e.stopPropagation(); goToFeedback(sess.feedbackId); }}
            title={`Back to ticket: ${sess.feedbackTitle}`}
          >
            {sess.feedbackTitle}
          </button>
        )}
        <span style="flex:1" />
        {!companion && sess?.jsonlPath && (
          <select
            class="view-mode-select"
            aria-label="Session view"
            value={selectableMode}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ViewMode;
              viewMode.value = v;
              setViewMode(sessionId, v);
            }}
          >
            <option value="terminal">Term</option>
            <option value="structured">Struct</option>
            {!mobile && <option value="split">Split</option>}
          </select>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {companion ? (
          renderTabContent(sessionId, true, sessionMapComputed.value, (code, text) => markSessionExited(sessionId, code, text))
        ) : (
          <SessionViewToggle
            sessionId={sessionId}
            isActive={true}
            onExit={(code, text) => markSessionExited(sessionId, code, text)}
            onInputStateChange={(s) => setSessionInputState(sessionId, s)}
            permissionProfile={sess?.permissionProfile}
            mode={mode}
          />
        )}
      </div>
      <SshSetupDialog />
    </div>
  );
}
