import { useState } from 'preact/hooks';
import { branchPickerOpen, branchSession } from '../../lib/agent-actions.js';

export function BranchModal() {
  const state = branchPickerOpen.value;
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);

  if (!state) return null;

  const close = () => {
    branchPickerOpen.value = null;
    setPrompt('');
    setLoading(false);
  };

  const handleBranch = async (e: Event) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      await branchSession(state.sessionId, prompt.trim(), {
        runtime: state.runtime,
        permissionProfile: state.permissionProfile,
      });
      close();
    } catch (err) {
      console.error('Branch failed:', err);
      setLoading(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form class="modal" style="max-width:520px" onSubmit={handleBranch}>
        <h3>Branch Session</h3>
        <p style="font-size:13px;color:var(--pw-text-muted);margin:0 0 12px">
          Fork this session's conversation context with a different direction.
          The new session inherits all prior context but follows your new prompt.
        </p>
        <div class="form-group">
          <label>New direction</label>
          <textarea
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="e.g., Now focus on optimizing the API response time instead..."
            style="width:100%;min-height:100px;font-size:13px"
            autoFocus
          />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={loading || !prompt.trim()}>
            {loading ? 'Branching...' : 'Branch'}
          </button>
        </div>
      </form>
    </div>
  );
}
