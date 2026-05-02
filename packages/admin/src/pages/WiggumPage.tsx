import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { subscribeAdmin } from '../lib/admin-ws.js';
import { SwarmDashboard } from '../components/sessions/SwarmDashboard.js';
import { launchFAFOAssistant } from '../lib/agent-constants.js';
import { selectedAppId } from '../lib/state.js';
import { openSession } from '../lib/sessions.js';
import { openSessionLogDrawer } from '../lib/companion-state.js';

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
  promptFile: string | null;
  logFile: string | null;
  agentLabel: string | null;
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

interface PromptInfo {
  filename: string;
  label: string;
  excerpt: string;
  activeRunId: string | null;
  activeRunStatus: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  totalRuns: number;
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

// ─── Agent Card ─────────────────────────────────────────────

function AgentCard({
  prompt,
  run,
  harnessConfigId,
  onLaunch,
  onAction,
  onViewRun,
  onEdit,
  onViewLog,
}: {
  prompt: PromptInfo;
  run: WiggumRun | null;
  harnessConfigId: string;
  onLaunch: (filename: string) => void;
  onAction: (id: string, action: string) => void;
  onViewRun: (id: string) => void;
  onEdit: (filename: string) => void;
  onViewLog: (logFile: string) => void;
}) {
  const status = run?.status || 'idle';
  const progress = run && run.maxIterations > 0 ? (run.currentIteration / run.maxIterations) * 100 : 0;
  const color = STATUS_COLORS[status] || '#555';

  return (
    <div style={{
      border: '1px solid #333',
      borderRadius: 8,
      padding: 14,
      background: '#1a1a1a',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
    }}>
      {/* Header: label + status */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#eee', letterSpacing: 0.5 }}>
          {prompt.label}
        </span>
        <span style={{
          padding: '2px 8px',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          background: color,
          color: '#fff',
        }}>
          {status === 'idle' ? 'IDLE' : status.toUpperCase()}
        </span>
      </div>

      {/* Excerpt */}
      <div style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {prompt.excerpt || prompt.filename}
      </div>

      {/* Progress bar (shown when running/paused/completed) */}
      {run && (
        <>
          <div style={{ background: '#333', borderRadius: 3, height: 6 }}>
            <div style={{
              background: color,
              width: `${Math.min(progress, 100)}%`,
              height: '100%',
              borderRadius: 3,
              transition: 'width 0.3s',
            }} />
          </div>
          <div style={{ fontSize: 11, color: '#888' }}>
            iter {run.currentIteration}/{run.maxIterations}
            {run.errorMessage && <span style={{ color: '#f44336' }}> — {run.errorMessage}</span>}
          </div>
        </>
      )}

      {/* Stats line */}
      {prompt.totalRuns > 0 && !run && (
        <div style={{ fontSize: 11, color: '#666' }}>
          {prompt.totalRuns} previous run{prompt.totalRuns > 1 ? 's' : ''}
          {prompt.lastRunStatus && ` (last: ${prompt.lastRunStatus})`}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
        {(!run || status === 'completed' || status === 'failed' || status === 'stopped') && (
          <button class="btn btn-sm" onClick={() => onLaunch(prompt.filename)}>
            {run ? 'Relaunch' : 'Launch'}
          </button>
        )}
        {status === 'running' && (
          <>
            <button class="btn btn-sm" onClick={() => onAction(run!.id, 'pause')}>Pause</button>
            <button class="btn btn-sm btn-danger" onClick={() => onAction(run!.id, 'stop')}>Stop</button>
          </>
        )}
        {status === 'paused' && (
          <>
            <button class="btn btn-sm" onClick={() => onAction(run!.id, 'resume')}>Resume</button>
            <button class="btn btn-sm btn-danger" onClick={() => onAction(run!.id, 'stop')}>Stop</button>
          </>
        )}
        <button class="btn btn-sm" style={{ opacity: 0.7 }} onClick={() => onEdit(prompt.filename)}>Edit</button>
        {run?.logFile && (
          <button class="btn btn-sm" style={{ opacity: 0.7 }} onClick={() => onViewLog(run.logFile!)}>Log</button>
        )}
        {run && (
          <button class="btn btn-sm" style={{ opacity: 0.7 }} onClick={() => onViewRun(run.id)}>Details</button>
        )}
      </div>
    </div>
  );
}

// ─── Prompt Editor (inline) ─────────────────────────────────

function PromptEditor({
  harnessConfigId,
  filename,
  onClose,
}: {
  harnessConfigId: string;
  filename: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getWiggumPromptFile(harnessConfigId, filename)
      .then(r => { setContent(r.content); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [harnessConfigId, filename]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateWiggumPromptFile(harnessConfigId, filename, content);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: '#111', border: '1px solid #444', borderRadius: 6, padding: 12, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#ccc' }}>Editing: {filename}</span>
        <button class="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {loading ? (
        <div style={{ color: '#888', padding: 16 }}>Loading...</div>
      ) : (
        <>
          <textarea
            value={content}
            onInput={e => setContent((e.target as HTMLTextAreaElement).value)}
            rows={16}
            style={{
              width: '100%',
              padding: 8,
              background: '#0a0a0a',
              border: '1px solid #333',
              color: '#ccc',
              borderRadius: 4,
              resize: 'vertical',
              fontFamily: 'monospace',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          />
          {error && <div style={{ color: '#f44336', fontSize: 12, marginTop: 4 }}>{error}</div>}
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button class="btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
            <button class="btn btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Log Viewer ─────────────────────────────────────────────

function LogViewer({
  harnessConfigId,
  logFile,
  onClose,
}: {
  harnessConfigId: string;
  logFile: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<number | null>(null);

  const load = useCallback(() => {
    api.getWiggumLog(harnessConfigId, logFile)
      .then(r => { setContent(r.content); setLoading(false); })
      .catch(() => setLoading(false));
  }, [harnessConfigId, logFile]);

  useEffect(() => {
    load();
    intervalRef.current = window.setInterval(load, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [load]);

  return (
    <div style={{ background: '#111', border: '1px solid #444', borderRadius: 6, padding: 12, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#ccc' }}>Log: {logFile}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn btn-sm" onClick={load}>Refresh</button>
          <button class="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      {loading ? (
        <div style={{ color: '#888', padding: 16 }}>Loading...</div>
      ) : (
        <pre style={{
          background: '#0a0a0a',
          border: '1px solid #333',
          borderRadius: 4,
          padding: 8,
          fontSize: 12,
          color: '#aaa',
          maxHeight: 400,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}>
          {content || '(empty)'}
        </pre>
      )}
    </div>
  );
}

// ─── Run Detail (kept from original) ────────────────────────

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
        {run.agentLabel && <span style={{ fontSize: 14, fontWeight: 600, color: '#ccc' }}>{run.agentLabel}</span>}
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
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Prompt {run.promptFile && `(${run.promptFile})`}</div>
        <pre style={{ fontSize: 13, color: '#ccc', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 200, overflow: 'auto' }}>{run.prompt}</pre>
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
                onClick={(e: any) => { e.preventDefault(); openSession(iter.sessionId); }}
                style={{ color: '#64B5F6', textDecoration: 'none' }}
                title="Open session terminal"
              >
                {iter.sessionId.slice(0, 10)}...
              </a>
              <button
                onClick={() => { openSessionLogDrawer(iter.sessionId); }}
                style={{
                  fontSize: 9, padding: '1px 4px', background: 'rgba(100,181,246,0.15)',
                  border: '1px solid rgba(100,181,246,0.3)', borderRadius: 3,
                  color: '#64B5F6', cursor: 'pointer',
                }}
                title="Open JSONL structured view"
              >
                JSONL
              </button>
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

// ─── Create Run Form (kept from original) ───────────────────

function CreateRunForm({ onCreated, defaultHarnessId }: { onCreated: () => void; defaultHarnessId?: string }) {
  const [form, setForm] = useState({
    harnessConfigId: defaultHarnessId || '',
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

  useEffect(() => {
    if (defaultHarnessId && form.harnessConfigId !== defaultHarnessId) {
      setForm(f => ({ ...f, harnessConfigId: defaultHarnessId }));
    }
  }, [defaultHarnessId]);

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

// ─── Main: Wiggum Swarm Page ────────────────────────────────

export function WiggumPage() {
  const [harnesses, setHarnesses] = useState<any[]>([]);
  const [selectedHarnessId, setSelectedHarnessId] = useState<string>('');
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [runs, setRuns] = useState<WiggumRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sub-views
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showManualCreate, setShowManualCreate] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [viewingLog, setViewingLog] = useState<string | null>(null);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [showFAFO, setShowFAFO] = useState(false);

  // Batch launch settings
  const [batchMaxIters, setBatchMaxIters] = useState(10);
  const [batchDeploy, setBatchDeploy] = useState('');

  // Load harnesses on mount
  useEffect(() => {
    api.getHarnessConfigs().then(list => {
      setHarnesses(list);
      const running = list.find((h: any) => h.status === 'running');
      if (running) setSelectedHarnessId(running.id);
      else if (list.length > 0) setSelectedHarnessId(list[0].id);
    }).catch(() => {});
  }, []);

  // Load runs + subscribe to WS updates
  const loadRuns = useCallback(async () => {
    try {
      const data = await api.getWiggumRuns();
      setRuns(data);
    } catch {}
  }, []);

  useEffect(() => {
    loadRuns();
    return subscribeAdmin('wiggum', (data: WiggumRun[]) => {
      setRuns(data);
    });
  }, [loadRuns]);

  // Load prompts when harness changes
  const loadPrompts = useCallback(async () => {
    if (!selectedHarnessId) { setPrompts([]); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getWiggumPrompts(selectedHarnessId);
      setPrompts(data);
    } catch (err: any) {
      setError(err.message);
      setPrompts([]);
    } finally {
      setLoading(false);
    }
  }, [selectedHarnessId]);

  useEffect(() => { loadPrompts(); }, [loadPrompts]);

  // Match prompts to runs
  const harnessRuns = runs.filter(r => r.harnessConfigId === selectedHarnessId);
  const getActiveRun = (filename: string): WiggumRun | null => {
    return harnessRuns.find(r =>
      r.promptFile === filename &&
      (r.status === 'running' || r.status === 'paused' || r.status === 'pending')
    ) || null;
  };

  // Batch IDs for batch actions
  const activeRunIds = harnessRuns
    .filter(r => r.status === 'running' || r.status === 'paused')
    .map(r => r.id);

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

  const handleLaunch = async (filename: string) => {
    if (!selectedHarnessId) return;
    try {
      await api.batchCreateWiggumRuns({
        harnessConfigId: selectedHarnessId,
        promptFiles: [filename],
        maxIterations: batchMaxIters,
        deployCommand: batchDeploy || undefined,
      });
      loadRuns();
      loadPrompts();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleLaunchAll = async () => {
    if (!selectedHarnessId || prompts.length === 0) return;
    const idle = prompts.filter(p => !getActiveRun(p.filename));
    if (idle.length === 0) { setError('All agents already running'); return; }
    try {
      await api.batchCreateWiggumRuns({
        harnessConfigId: selectedHarnessId,
        promptFiles: idle.map(p => p.filename),
        maxIterations: batchMaxIters,
        deployCommand: batchDeploy || undefined,
      });
      loadRuns();
      loadPrompts();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleBatchAction = async (action: 'stop' | 'pause' | 'resume') => {
    if (activeRunIds.length === 0) return;
    const ids = action === 'resume'
      ? harnessRuns.filter(r => r.status === 'paused').map(r => r.id)
      : activeRunIds;
    if (ids.length === 0) return;
    try {
      await api.batchWiggumAction(action, ids);
      loadRuns();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // ── Sub-views ──
  if (selectedRunId) {
    return (
      <div style={{ padding: 16 }}>
        <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
      </div>
    );
  }

  // ── Group wiggum runs by label/promptFile ──
  const runGroups = new Map<string, WiggumRun[]>();
  for (const r of runs) {
    const key = r.agentLabel || r.promptFile || 'Ungrouped';
    const arr = runGroups.get(key) || [];
    arr.push(r);
    runGroups.set(key, arr);
  }
  // Sort each group by createdAt desc
  for (const arr of runGroups.values()) {
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const sortedGroupKeys = [...runGroups.keys()].sort((a, b) => {
    const aRuns = runGroups.get(a)!;
    const bRuns = runGroups.get(b)!;
    const aActive = aRuns.some(r => r.status === 'running' || r.status === 'paused');
    const bActive = bRuns.some(r => r.status === 'running' || r.status === 'paused');
    if (aActive !== bActive) return aActive ? -1 : 1;
    return bRuns[0].createdAt.localeCompare(aRuns[0].createdAt);
  });

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    // Auto-expand groups with active runs
    const active = new Set<string>();
    for (const [key, arr] of runGroups) {
      if (arr.some(r => r.status === 'running' || r.status === 'paused')) active.add(key);
    }
    return active;
  });

  const toggleGroup = (key: string) => {
    const next = new Set(expandedGroups);
    if (next.has(key)) next.delete(key); else next.add(key);
    setExpandedGroups(next);
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--pw-text)' }}>FAFO / Wiggum</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            class="btn btn-sm"
            style={{ background: '#7c3aed', color: '#fff' }}
            onClick={async () => {
              try {
                setError(null);
                await launchFAFOAssistant({ appId: selectedAppId.value });
              } catch (err: any) {
                setError(err.message || 'Failed to launch assistant');
              }
            }}
          >
            Setup Assistant
          </button>
          <select
            value={selectedHarnessId}
            onChange={e => setSelectedHarnessId((e.target as HTMLSelectElement).value)}
            style={{ padding: '4px 8px', background: 'var(--pw-bg-raised)', border: '1px solid var(--pw-border)', color: 'var(--pw-text)', borderRadius: 4, fontSize: 12 }}
          >
            <option value="">Harness...</option>
            {harnesses.map((h: any) => (
              <option key={h.id} value={h.id}>{h.name} ({h.status})</option>
            ))}
          </select>
          <button class="btn btn-sm" onClick={loadRuns}>Refresh</button>
        </div>
      </div>

      {error && (
        <div style={{ color: '#f44336', fontSize: 13 }}>
          {error}
          <button style={{ marginLeft: 8, background: 'none', border: 'none', color: '#888', cursor: 'pointer' }} onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {/* Editors / Log viewer overlays */}
      {editingFile && selectedHarnessId && (
        <PromptEditor harnessConfigId={selectedHarnessId} filename={editingFile} onClose={() => { setEditingFile(null); loadPrompts(); }} />
      )}
      {viewingLog && selectedHarnessId && (
        <LogViewer harnessConfigId={selectedHarnessId} logFile={viewingLog} onClose={() => setViewingLog(null)} />
      )}

      {/* ── FAFO Swarms Section ── */}
      <SwarmDashboard />

      {/* ── Wiggum Runs Section ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: 'var(--pw-text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Wiggum Runs
          </h3>
          <span style={{ fontSize: 11, color: 'var(--pw-text-faint)' }}>
            {runs.length} total
            {runs.filter(r => r.status === 'running').length > 0 && ` \u00b7 ${runs.filter(r => r.status === 'running').length} running`}
          </span>
        </div>

        {sortedGroupKeys.length === 0 && (
          <div style={{ color: 'var(--pw-text-faint)', fontSize: 13, textAlign: 'center', padding: 24 }}>
            No wiggum runs yet.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sortedGroupKeys.map(groupKey => {
            const groupRuns = runGroups.get(groupKey)!;
            const expanded = expandedGroups.has(groupKey);
            const activeCount = groupRuns.filter(r => r.status === 'running' || r.status === 'paused').length;
            const doneCount = groupRuns.filter(r => r.status === 'completed').length;
            const failedCount = groupRuns.filter(r => r.status === 'failed').length;
            const latestRun = groupRuns[0];
            const bestIter = Math.max(...groupRuns.map(r => r.currentIteration));
            const maxIter = Math.max(...groupRuns.map(r => r.maxIterations));

            return (
              <div key={groupKey} style={{
                background: 'var(--pw-bg-surface)',
                borderRadius: 8,
                border: `1px solid ${activeCount > 0 ? 'rgba(76,175,80,0.3)' : 'var(--pw-border)'}`,
                overflow: 'hidden',
              }}>
                {/* Group header */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                    cursor: 'pointer', userSelect: 'none',
                  }}
                  onClick={() => toggleGroup(groupKey)}
                >
                  <span style={{ fontSize: 11, color: 'var(--pw-text-faint)', width: 12 }}>
                    {expanded ? '\u25be' : '\u25b8'}
                  </span>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: activeCount > 0 ? '#4CAF50' : doneCount > 0 ? '#2196F3' : failedCount > 0 ? '#f44336' : '#888',
                  }} />
                  <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {groupKey}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--pw-text-faint)', flexShrink: 0 }}>
                    {groupRuns.length} run{groupRuns.length !== 1 ? 's' : ''}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--pw-text-faint)', flexShrink: 0 }}>
                    iter {bestIter}/{maxIter}
                  </span>
                  {activeCount > 0 && (
                    <span style={{ fontSize: 10, color: '#4CAF50', fontWeight: 600, flexShrink: 0 }}>
                      {activeCount} active
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--pw-text-faint)', flexShrink: 0 }}>
                    {timeAgo(latestRun.createdAt)}
                  </span>
                  <button
                    class="btn btn-sm"
                    style={{ fontSize: 9, padding: '1px 6px', background: '#7c3aed', color: '#fff', flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const runIds = groupRuns.map(r => r.id).join(', ');
                      const ctx = `The user wants help with wiggum run group "${groupKey}".
Runs: ${groupRuns.length} (${activeCount} active, ${doneCount} done, ${failedCount} failed)
Best iteration: ${bestIter}/${maxIter}
Run IDs: ${runIds}
Latest run: ${latestRun.id} (${latestRun.status})

Start by fetching the latest run detail: curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum/${latestRun.id}'
Then ask the user what they need help with — monitoring, adjusting, or creating a new run in this group.`;
                      launchFAFOAssistant({ appId: selectedAppId.value, context: ctx }).catch(err => setError(err.message));
                    }}
                    title="Launch assistant for this run group"
                  >
                    Assist
                  </button>
                </div>

                {/* Expanded: individual runs */}
                {expanded && (
                  <div style={{ borderTop: '1px solid var(--pw-border)', padding: '4px 0' }}>
                    {groupRuns.map(run => (
                      <div
                        key={run.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 12px 6px 34px', cursor: 'pointer',
                          fontSize: 12,
                        }}
                        onClick={() => setSelectedRunId(run.id)}
                      >
                        <span style={{
                          padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                          background: STATUS_COLORS[run.status] || '#666', color: '#fff', flexShrink: 0,
                        }}>
                          {run.status}
                        </span>
                        <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--pw-text-faint)', flexShrink: 0 }}>
                          {run.id.slice(-8)}
                        </span>
                        <span style={{ color: 'var(--pw-text-muted)', fontSize: 11 }}>
                          iter {run.currentIteration}/{run.maxIterations}
                        </span>
                        {run.iterations.length > 0 && run.iterations[run.iterations.length - 1]?.screenshotId && (
                          <span style={{ fontSize: 10, color: 'var(--pw-text-faint)' }}>[screenshot]</span>
                        )}
                        <span style={{ flex: 1 }} />
                        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                          {run.status === 'running' && <button class="btn btn-sm" onClick={() => handleAction(run.id, 'pause')}>Pause</button>}
                          {run.status === 'paused' && <button class="btn btn-sm" onClick={() => handleAction(run.id, 'resume')}>Resume</button>}
                          {(run.status === 'running' || run.status === 'paused') && (
                            <button class="btn btn-sm btn-danger" onClick={() => handleAction(run.id, 'stop')}>Stop</button>
                          )}
                          {(run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') && (
                            <button class="btn btn-sm btn-danger" onClick={() => handleAction(run.id, 'delete')}>Del</button>
                          )}
                        </div>
                        <span style={{ fontSize: 10, color: 'var(--pw-text-faint)' }}>{timeAgo(run.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
