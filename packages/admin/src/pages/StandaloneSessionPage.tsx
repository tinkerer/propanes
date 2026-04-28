import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { SessionViewToggle, type ViewMode } from '../components/SessionViewToggle.js';
import { renderTabContent } from '../components/PaneContent.js';
import { SessionIdMenu } from '../components/SessionIdMenu.js';
import { SshSetupDialog } from '../components/SshSetupDialog.js';
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
    if (cs?.feedbackTitle) return `JSONL: ${cs.feedbackTitle}`;
    return `JSONL: ${realSid.slice(0, 6)}`;
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
  const idMenuAnchorRef = useRef<HTMLSpanElement>(null);

  const title = standaloneTitle(sessionId, sess, isExited);
  useEffect(() => {
    document.title = title;
  }, [title]);

  const showIdMenu = !companion && idMenuOpen.value;

  return (
    <div class="standalone-session-root" style={{ background: 'var(--pw-bg)', color: 'var(--pw-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid var(--pw-border)', fontSize: 12 }}>
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
          <span style={{ fontWeight: 600 }}>{title}</span>
        ) : (
          <>
            <span
              ref={idMenuAnchorRef}
              class="session-id-label"
              style={{ fontWeight: 600, cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); idMenuOpen.value = !idMenuOpen.value; }}
              title="Session actions"
            >
              pw-{sessionId.slice(-6)} <span class="id-dropdown-caret">{'▾'}</span>
            </span>
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
        {isExited && <span style={{ color: 'var(--pw-text-muted)' }}>(exited)</span>}
        <span style="flex:1" />
        {!companion && sess?.jsonlPath && !isMobile.value && (
          <select
            class="view-mode-select"
            value={mode}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ViewMode;
              viewMode.value = v;
              setViewMode(sessionId, v);
            }}
          >
            <option value="terminal">Term</option>
            <option value="structured">Struct</option>
            <option value="split">Split</option>
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
