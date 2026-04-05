import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { subscribeAdmin } from '../lib/admin-ws.js';

interface WiggumIteration {
  iteration: number;
  sessionId: string;
  screenshotId: string | null;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
}

interface WiggumRun {
  id: string;
  harnessConfigId: string | null;
  prompt: string;
  deployCommand: string | null;
  maxIterations: number;
  widgetSessionId: string | null;
  screenshotDelayMs: number;
  status: string;
  currentIteration: number;
  iterations: WiggumIteration[];
  errorMessage: string | null;
  isActive: boolean;
  screenshots?: any[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#888',
  running: '#4CAF50',
  paused: '#FF9800',
  completed: '#2196F3',
  failed: '#f44336',
  stopped: '#9E9E9E',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function RunCard({ run, onAction, onSelect }: { run: WiggumRun; onAction: (id: string, action: string) => void; onSelect: (id: string) => void }) {
  const progress = run.maxIterations > 0 ? (run.currentIteration / run.maxIterations) * 100 : 0;

  return (
    <div
      style={{
        border: '1px solid #333',
        borderRadius: 6,
        padding: 12,
        marginBottom: 8,
        background: '#1a1a1a',
        cursor: 'pointer',
      }}
      onClick={() => onSelect(run.id)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            background: STATUS_COLORS[run.status] || '#666',
            color: '#fff',
          }}>
            {run.status.toUpperCase()}
          </span>
          <span style={{ fontSize: 12, color: '#aaa' }}>{run.id.slice(0, 8)}</span>
        </div>
        <span style={{ fontSize: 11, color: '#888' }}>{timeAgo(run.createdAt)}</span>
      </div>

      <div style={{ fontSize: 13, color: '#ccc', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {run.prompt.slice(0, 120)}
      </div>

      <div style={{ background: '#333', borderRadius: 3, height: 6, marginBottom: 8 }}>
        <div style={{
          background: STATUS_COLORS[run.status] || '#666',
          width: `${progress}%`,
          height: '100%',
          borderRadius: 3,
          transition: 'width 0.3s',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#888' }}>
          Iteration {run.currentIteration} / {run.maxIterations}
          {run.deployCommand && ' \u2022 deploy'}
          {run.widgetSessionId && ' \u2022 screenshots'}
        </span>
        <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {run.status === 'running' && (
            <button class="btn btn-sm" onClick={() => onAction(run.id, 'pause')}>Pause</button>
          )}
          {run.status === 'paused' && (
            <button class="btn btn-sm" onClick={() => onAction(run.id, 'resume')}>Resume</button>
          )}
          {(run.status === 'running' || run.status === 'paused') && (
            <button class="btn btn-sm btn-danger" onClick={() => onAction(run.id, 'stop')}>Stop</button>
          )}
          {(run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') && (
            <button class="btn btn-sm btn-danger" onClick={() => onAction(run.id, 'delete')}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<WiggumRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getWiggumRun(runId);
      setRun(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, [runId]);

  useEffect(() => {
    load();
    return subscribeAdmin('wiggum', (data: WiggumRun[]) => {
      const found = data.find((r: any) => r.id === runId);
      if (found) setRun(found);
    });
  }, [load, runId]);

  if (error) return <div style={{ color: '#f44336', padding: 16 }}>Error: {error}</div>;
  if (!run) return <div style={{ padding: 16, color: '#888' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button class="btn btn-sm" onClick={onBack}>&larr; Back</button>
        <span style={{
          padding: '2px 8px',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          background: STATUS_COLORS[run.status] || '#666',
          color: '#fff',
        }}>
          {run.status.toUpperCase()}
        </span>
        <span style={{ fontSize: 12, color: '#888' }}>{run.id}</span>
        <div style={{ flex: 1 }} />
        {run.status === 'running' && (
          <button class="btn btn-sm" onClick={async () => { await api.pauseWiggumRun(run.id); load(); }}>Pause</button>
        )}
        {run.status === 'paused' && (
          <button class="btn btn-sm" onClick={async () => { await api.resumeWiggumRun(run.id); load(); }}>Resume</button>
        )}
        {(run.status === 'running' || run.status === 'paused') && (
          <button class="btn btn-sm btn-danger" onClick={async () => { await api.stopWiggumRun(run.id); load(); }}>Stop</button>
        )}
      </div>

      <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Prompt</div>
        <pre style={{ fontSize: 13, color: '#ccc', whiteSpace: 'pre-wrap', margin: 0 }}>{run.prompt}</pre>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: '#888' }}>
          Max iterations: <span style={{ color: '#ccc' }}>{run.maxIterations}</span>
        </div>
        {run.deployCommand && (
          <div style={{ fontSize: 12, color: '#888' }}>
            Deploy: <code style={{ color: '#ccc' }}>{run.deployCommand}</code>
          </div>
        )}
        {run.screenshotDelayMs && (
          <div style={{ fontSize: 12, color: '#888' }}>
            Screenshot delay: <span style={{ color: '#ccc' }}>{run.screenshotDelayMs}ms</span>
          </div>
        )}
        {run.errorMessage && (
          <div style={{ fontSize: 12, color: '#f44336' }}>
            Error: {run.errorMessage}
          </div>
        )}
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#ccc' }}>Iterations</div>

      {run.iterations.length === 0 && (
        <div style={{ color: '#888', fontSize: 13 }}>No iterations yet</div>
      )}

      {run.iterations.map((iter) => (
        <div
          key={iter.iteration}
          style={{
            display: 'flex',
            gap: 12,
            padding: '8px 0',
            borderBottom: '1px solid #222',
            alignItems: 'flex-start',
          }}
        >
          <div style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: iter.exitCode === 0 ? '#4CAF50' : iter.exitCode != null ? '#f44336' : '#FF9800',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            flexShrink: 0,
          }}>
            {iter.iteration}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <a
                href={`#/sessions/${iter.sessionId}`}
                style={{ color: '#64B5F6', textDecoration: 'none' }}
                title="Open session"
              >
                {iter.sessionId.slice(0, 10)}...
              </a>
              <span style={{ color: '#888' }}>
                exit={iter.exitCode ?? '?'}
              </span>
              {iter.completedAt && (
                <span style={{ color: '#888' }}>{timeAgo(iter.completedAt)}</span>
              )}
            </div>
          </div>

          {iter.screenshotId && (
            <img
              src={`/api/v1/admin/wiggum/${run.id}/screenshots/${iter.screenshotId}`}
              alt={`Iteration ${iter.iteration}`}
              style={{
                width: 120,
                height: 80,
                objectFit: 'cover',
                borderRadius: 4,
                border: '1px solid #333',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => window.open(`/api/v1/admin/wiggum/${run.id}/screenshots/${iter.screenshotId}`, '_blank')}
            />
          )}
        </div>
      ))}

      {run.iterations.some((i) => i.screenshotId) && (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 16, marginBottom: 8, color: '#ccc' }}>Screenshot Filmstrip</div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
            {run.iterations
              .filter((i) => i.screenshotId)
              .map((iter) => (
                <div key={iter.iteration} style={{ textAlign: 'center', flexShrink: 0 }}>
                  <img
                    src={`/api/v1/admin/wiggum/${run.id}/screenshots/${iter.screenshotId}`}
                    alt={`Iteration ${iter.iteration}`}
                    style={{
                      width: 200,
                      height: 130,
                      objectFit: 'cover',
                      borderRadius: 4,
                      border: '1px solid #333',
                      cursor: 'pointer',
                    }}
                    onClick={() => window.open(`/api/v1/admin/wiggum/${run.id}/screenshots/${iter.screenshotId}`, '_blank')}
                  />
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>#{iter.iteration}</div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

export function WiggumPage() {
  const [runs, setRuns] = useState<WiggumRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const data = await api.getWiggumRuns();
      setRuns(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadRuns();
    return subscribeAdmin('wiggum', (data: WiggumRun[]) => {
      setRuns(data);
    });
  }, [loadRuns]);

  const handleAction = async (id: string, action: string) => {
    try {
      if (action === 'pause') await api.pauseWiggumRun(id);
      else if (action === 'resume') await api.resumeWiggumRun(id);
      else if (action === 'stop') await api.stopWiggumRun(id);
      else if (action === 'delete') await api.deleteWiggumRun(id);
      loadRuns();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (selectedId) {
    return (
      <div style={{ padding: 16 }}>
        <RunDetail runId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#eee' }}>Wiggum Runs</h2>
        <button class="btn btn-sm" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Run'}
        </button>
      </div>

      {error && <div style={{ color: '#f44336', marginBottom: 8, fontSize: 13 }}>{error}</div>}

      {showCreate && <CreateRunForm onCreated={() => { setShowCreate(false); loadRuns(); }} />}

      {runs.length === 0 && !showCreate && (
        <div style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 32 }}>
          No wiggum runs yet. Create one to start iterating.
        </div>
      )}

      {runs.map((run) => (
        <RunCard key={run.id} run={run} onAction={handleAction} onSelect={setSelectedId} />
      ))}
    </div>
  );
}

function CreateRunForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    harnessConfigId: '',
    prompt: '',
    deployCommand: '',
    maxIterations: 10,
    widgetSessionId: '',
    screenshotDelayMs: 3000,
  });
  const [harnesses, setHarnesses] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getHarnessConfigs().then(setHarnesses).catch(() => {});
  }, []);

  const handleSubmit = async () => {
    if (!form.harnessConfigId || !form.prompt) {
      setError('Harness and prompt are required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.createWiggumRun({
        harnessConfigId: form.harnessConfigId,
        prompt: form.prompt,
        deployCommand: form.deployCommand || undefined,
        maxIterations: form.maxIterations,
        widgetSessionId: form.widgetSessionId || undefined,
        screenshotDelayMs: form.screenshotDelayMs,
      });
      onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: 16, marginBottom: 16 }}>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Harness</label>
        <select
          value={form.harnessConfigId}
          onChange={(e) => setForm({ ...form, harnessConfigId: (e.target as HTMLSelectElement).value })}
          style={{ width: '100%', padding: '6px 8px', background: '#111', border: '1px solid #444', color: '#ccc', borderRadius: 4 }}
        >
          <option value="">Select harness...</option>
          {harnesses.map((h: any) => (
            <option key={h.id} value={h.id}>{h.name} ({h.status})</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Prompt</label>
        <textarea
          value={form.prompt}
          onInput={(e) => setForm({ ...form, prompt: (e.target as HTMLTextAreaElement).value })}
          rows={4}
          style={{ width: '100%', padding: '6px 8px', background: '#111', border: '1px solid #444', color: '#ccc', borderRadius: 4, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="Instructions for each iteration..."
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Deploy Command</label>
          <input
            type="text"
            value={form.deployCommand}
            onInput={(e) => setForm({ ...form, deployCommand: (e.target as HTMLInputElement).value })}
            style={{ width: '100%', padding: '6px 8px', background: '#111', border: '1px solid #444', color: '#ccc', borderRadius: 4 }}
            placeholder="e.g. supervisorctl restart app"
          />
        </div>
        <div style={{ width: 100 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Max Iters</label>
          <input
            type="number"
            value={form.maxIterations}
            onInput={(e) => setForm({ ...form, maxIterations: parseInt((e.target as HTMLInputElement).value) || 10 })}
            style={{ width: '100%', padding: '6px 8px', background: '#111', border: '1px solid #444', color: '#ccc', borderRadius: 4 }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Widget Session ID (for screenshots)</label>
          <input
            type="text"
            value={form.widgetSessionId}
            onInput={(e) => setForm({ ...form, widgetSessionId: (e.target as HTMLInputElement).value })}
            style={{ width: '100%', padding: '6px 8px', background: '#111', border: '1px solid #444', color: '#ccc', borderRadius: 4 }}
            placeholder="Optional - live widget session ID"
          />
        </div>
        <div style={{ width: 120 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Screenshot Delay</label>
          <input
            type="number"
            value={form.screenshotDelayMs}
            onInput={(e) => setForm({ ...form, screenshotDelayMs: parseInt((e.target as HTMLInputElement).value) || 3000 })}
            style={{ width: '100%', padding: '6px 8px', background: '#111', border: '1px solid #444', color: '#ccc', borderRadius: 4 }}
          />
        </div>
      </div>

      {error && <div style={{ color: '#f44336', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <button class="btn" onClick={handleSubmit} disabled={submitting}>
        {submitting ? 'Creating...' : 'Create & Start'}
      </button>
    </div>
  );
}
