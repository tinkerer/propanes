import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { SessionViewToggle, type ViewMode } from '../components/SessionViewToggle.js';
import { allSessions, startSessionPolling, getViewMode, setViewMode, markSessionExited, setSessionInputState, exitedSessions } from '../lib/sessions.js';
import { applyTheme } from '../lib/settings.js';
import { isMobile } from '../lib/viewport.js';
import { navigate, selectedAppId } from '../lib/state.js';

const viewMode = signal<ViewMode>('terminal');

function goBack() {
  const appId = selectedAppId.value;
  navigate(appId ? `/app/${appId}/sessions` : '/');
}

export function StandaloneSessionPage({ sessionId }: { sessionId: string }) {
  useEffect(() => { applyTheme(); }, []);
  useEffect(() => {
    const cleanup = startSessionPolling();
    return cleanup;
  }, []);

  const sessions = allSessions.value;
  const sess = sessions.find((s: any) => s.id === sessionId);
  const isExited = exitedSessions.value.has(sessionId);
  const mode = getViewMode(sessionId) || viewMode.value;
  const mobile = isMobile.value;

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
        <span style={{ fontWeight: 600 }}>pw-{sessionId.slice(-6)}</span>
        {isExited && <span style={{ color: 'var(--pw-text-muted)' }}>(exited)</span>}
        <span style="flex:1" />
        {sess?.jsonlPath && !isMobile.value && (
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
        <SessionViewToggle
          sessionId={sessionId}
          isActive={true}
          onExit={(code, text) => markSessionExited(sessionId, code, text)}
          onInputStateChange={(s) => setSessionInputState(sessionId, s)}
          permissionProfile={sess?.permissionProfile}
          mode={mode}
        />
      </div>
    </div>
  );
}
