import { autoFixState, launchAutoFix, dismissAutoFix } from '../lib/autofix.js';

export function AutoFixToast() {
  const state = autoFixState.value;
  if (state.phase === 'idle') return null;

  return (
    <div class={`autofix-toast autofix-toast-${state.phase}`}>
      {state.phase === 'pending' && (
        <>
          <div class="autofix-toast-msg">
            Session on <strong>{state.machineName}</strong> failed (exit {state.exitCode}).
          </div>
          <div class="autofix-toast-actions">
            <button class="autofix-btn-fix" onClick={launchAutoFix}>Run Diagnostic</button>
            <button class="autofix-btn-dismiss" onClick={dismissAutoFix}>Dismiss</button>
          </div>
        </>
      )}
      {state.phase === 'launching' && (
        <div class="autofix-toast-msg">
          <span class="autofix-spinner" /> Launching auto-fix agent...
        </div>
      )}
      {state.phase === 'active' && (
        <div class="autofix-toast-msg autofix-success">
          Auto-fix session launched.
        </div>
      )}
    </div>
  );
}
