import { useState } from 'preact/hooks';
import { distillPickerOpen, distillToAgent } from '../../lib/agent-actions.js';
import { api } from '../../lib/api.js';

export function DistillModal() {
  const state = distillPickerOpen.value;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [extraContext, setExtraContext] = useState('');
  const [addSessionId, setAddSessionId] = useState('');
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appId, setAppId] = useState('');
  const [apps, setApps] = useState<any[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);

  if (!state) return null;

  // Initialize sessionIds from state on first render
  if (sessionIds.length === 0 && state.sessionIds.length > 0) {
    setSessionIds([...state.sessionIds]);
  }

  if (!appsLoaded) {
    setAppsLoaded(true);
    api.getApplications().then(setApps).catch(() => {});
  }

  const close = () => {
    distillPickerOpen.value = null;
    setName('');
    setDescription('');
    setExtraContext('');
    setAddSessionId('');
    setSessionIds([]);
    setLoading(false);
    setError('');
    setAppsLoaded(false);
  };

  const addSession = () => {
    const id = addSessionId.trim();
    if (id && !sessionIds.includes(id)) {
      setSessionIds([...sessionIds, id]);
    }
    setAddSessionId('');
  };

  const removeSession = (id: string) => {
    setSessionIds(sessionIds.filter(s => s !== id));
  };

  const handleDistill = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      await distillToAgent({
        name: name.trim(),
        description: description.trim(),
        sessionIds,
        appId: appId || undefined,
        extraContext: extraContext.trim() || undefined,
      });
      close();
    } catch (err: any) {
      setError(err.message || 'Failed to create agent');
      setLoading(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form class="modal" style="max-width:560px" onSubmit={handleDistill}>
        <h3>Distill to Expert Agent</h3>
        <p style="font-size:13px;color:var(--pw-text-muted);margin:0 0 12px">
          Create a specialized agent from session learnings. The agent will carry
          forward the knowledge and patterns from the selected sessions.
        </p>

        {error && <div class="error-msg">{error}</div>}

        <div class="form-group">
          <label>Agent Name</label>
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="e.g., Nexar API Expert, Document Explorer Expert"
            style="width:100%"
            required
            autoFocus
          />
        </div>

        <div class="form-group">
          <label>Expertise Description</label>
          <input
            type="text"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
            placeholder="e.g., Deep knowledge of Nexar GraphQL API, pagination, and error handling"
            style="width:100%"
          />
        </div>

        <div class="form-group">
          <label>Application</label>
          <select
            value={appId}
            onChange={(e) => setAppId((e.target as HTMLSelectElement).value)}
            style="width:100%"
          >
            <option value="">Global (all apps)</option>
            {apps.map((app) => (
              <option value={app.id} key={app.id}>{app.name}</option>
            ))}
          </select>
        </div>

        <div class="form-group">
          <label>Source Sessions</label>
          <div style="display:flex;flex-direction:column;gap:4px">
            {sessionIds.map(id => (
              <div key={id} style="display:flex;align-items:center;gap:6px;font-size:12px;font-family:monospace;background:var(--pw-bg-surface);padding:4px 8px;border-radius:4px;border:1px solid var(--pw-border)">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{id}</span>
                <button type="button" class="btn btn-sm" style="font-size:10px;padding:0 4px;line-height:1.4" onClick={() => removeSession(id)}>x</button>
              </div>
            ))}
            <div style="display:flex;gap:4px">
              <input
                type="text"
                value={addSessionId}
                onInput={(e) => setAddSessionId((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSession(); } }}
                placeholder="Add session ID..."
                style="flex:1;font-size:12px;font-family:monospace"
              />
              <button type="button" class="btn btn-sm" onClick={addSession} disabled={!addSessionId.trim()}>+</button>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Additional Context <span style="color:var(--pw-text-faint);font-weight:normal">(optional)</span></label>
          <textarea
            value={extraContext}
            onInput={(e) => setExtraContext((e.target as HTMLTextAreaElement).value)}
            placeholder="Any additional expertise, API docs, or patterns to encode..."
            style="width:100%;min-height:60px;font-size:13px"
          />
        </div>

        <div class="modal-actions">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={loading || !name.trim() || sessionIds.length === 0}>
            {loading ? 'Creating...' : 'Create Expert Agent'}
          </button>
        </div>
      </form>
    </div>
  );
}
