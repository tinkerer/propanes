import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { SessionViewToggle, type ViewMode } from '../components/SessionViewToggle.js';
import { allSessions, startSessionPolling, getViewMode, setViewMode, markSessionExited, setSessionInputState, exitedSessions } from '../lib/sessions.js';
import { applyTheme } from '../lib/settings.js';

const viewMode = signal<ViewMode>('terminal');

export function StandaloneSessionPage({ sessionId }: { sessionId: string }) {
  useEffect(() => { applyTheme(); }, []);
  useEffect(() => {
    const cleanup = startSessionPolling();
    return cleanup;
  }, []);

  const sessions = allSessions.value;
  const sess = sessions.find((s: any) => s.id === sessionId);
  const isExited = exitedSessions.value.has(sessionId);
  const mode = getViewMode(sessionId, sess?.permissionProfile) || viewMode.value;

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--pw-bg)', color: 'var(--pw-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid var(--pw-border)', fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>pw-{sessionId.slice(-6)}</span>
        {isExited && <span style={{ color: 'var(--pw-text-muted)' }}>(exited)</span>}
        <span style="flex:1" />
        {(sess?.permissionProfile === 'auto' || sess?.permissionProfile === 'yolo') && (
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
