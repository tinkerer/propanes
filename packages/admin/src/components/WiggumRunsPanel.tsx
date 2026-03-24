import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';

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
  status: string;
  prompt: string;
  currentIteration: number;
  maxIterations: number;
  iterations: WiggumIteration[];
  isActive: boolean;
  errorMessage: string | null;
  createdAt: string;
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

export function WiggumRunsPanel({ sessionId }: { sessionId: string }) {
  const [runs, setRuns] = useState<WiggumRun[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getWiggumRunsByParent(sessionId);
      setRuns(data);
    } catch (err: any) {
      setError(err.message);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const handleAction = async (id: string, action: string) => {
    try {
      if (action === 'pause') await api.pauseWiggumRun(id);
      else if (action === 'resume') await api.resumeWiggumRun(id);
      else if (action === 'stop') await api.stopWiggumRun(id);
      else if (action === 'delete') await api.deleteWiggumRun(id);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const running = runs.filter((r) => r.status === 'running' || r.status === 'paused').length;
  const completed = runs.filter((r) => r.status === 'completed').length;
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'stopped').length;

  return (
    <div style={{ padding: 12, height: '100%', overflow: 'auto', background: 'var(--pw-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--pw-text)' }}>Wiggum Runs</span>
        <span style={{ fontSize: 11, color: 'var(--pw-text-faint)' }}>
          {runs.length} total
          {running > 0 && ` \u00b7 ${running} active`}
          {completed > 0 && ` \u00b7 ${completed} done`}
          {failed > 0 && ` \u00b7 ${failed} failed`}
        </span>
      </div>

      {error && <div style={{ color: '#f44336', fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {runs.length === 0 && (
        <div style={{ color: 'var(--pw-text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
          No wiggum runs dispatched yet.
          <br />
          The meta-wiggum agent will create runs here.
        </div>
      )}

      {runs.map((run) => {
        const progress = run.maxIterations > 0 ? (run.currentIteration / run.maxIterations) * 100 : 0;
        const isExpanded = expandedId === run.id;

        return (
          <div
            key={run.id}
            style={{
              border: '1px solid var(--pw-border)',
              borderRadius: 6,
              padding: 10,
              marginBottom: 6,
              background: 'var(--pw-bg-surface)',
            }}
          >
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
              onClick={() => setExpandedId(isExpanded ? null : run.id)}
            >
              <span style={{
                padding: '1px 6px',
                borderRadius: 3,
                fontSize: 10,
                fontWeight: 600,
                background: STATUS_COLORS[run.status] || '#666',
                color: '#fff',
              }}>
                {run.status.toUpperCase()}
              </span>

              <span style={{ fontSize: 11, color: 'var(--pw-text-muted)', fontFamily: 'var(--pw-font-mono)' }}>
                {run.id.slice(0, 8)}
              </span>

              <div style={{ flex: 1, margin: '0 8px' }}>
                <div style={{ background: 'var(--pw-border)', borderRadius: 2, height: 4 }}>
                  <div style={{
                    background: STATUS_COLORS[run.status] || '#666',
                    width: `${progress}%`,
                    height: '100%',
                    borderRadius: 2,
                    transition: 'width 0.3s',
                  }} />
                </div>
              </div>

              <span style={{ fontSize: 10, color: 'var(--pw-text-faint)', whiteSpace: 'nowrap' }}>
                {run.currentIteration}/{run.maxIterations}
              </span>

              <span style={{ fontSize: 10, color: 'var(--pw-text-faint)' }}>
                {timeAgo(run.createdAt)}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 4, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
              {run.status === 'running' && (
                <button class="btn btn-sm" onClick={() => handleAction(run.id, 'pause')} style={{ fontSize: 10, padding: '1px 6px' }}>Pause</button>
              )}
              {run.status === 'paused' && (
                <button class="btn btn-sm" onClick={() => handleAction(run.id, 'resume')} style={{ fontSize: 10, padding: '1px 6px' }}>Resume</button>
              )}
              {(run.status === 'running' || run.status === 'paused') && (
                <button class="btn btn-sm btn-danger" onClick={() => handleAction(run.id, 'stop')} style={{ fontSize: 10, padding: '1px 6px' }}>Stop</button>
              )}
            </div>

            {isExpanded && (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--pw-border)', paddingTop: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--pw-text-muted)', marginBottom: 6, whiteSpace: 'pre-wrap', maxHeight: 100, overflow: 'auto' }}>
                  {run.prompt.slice(0, 500)}{run.prompt.length > 500 ? '...' : ''}
                </div>

                {run.errorMessage && (
                  <div style={{ fontSize: 11, color: '#f44336', marginBottom: 6 }}>
                    Error: {run.errorMessage}
                  </div>
                )}

                {run.iterations.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pw-text-muted)', marginBottom: 4 }}>Iterations</div>
                    {run.iterations.map((iter) => (
                      <div key={iter.iteration} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, padding: '2px 0' }}>
                        <span style={{
                          width: 18, height: 18, borderRadius: '50%',
                          background: iter.exitCode === 0 ? '#4CAF50' : iter.exitCode != null ? '#f44336' : '#FF9800',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 9, fontWeight: 600, color: '#fff', flexShrink: 0,
                        }}>
                          {iter.iteration}
                        </span>
                        <a
                          href={`#/sessions/${iter.sessionId}`}
                          style={{ color: '#64B5F6', textDecoration: 'none' }}
                        >
                          {iter.sessionId.slice(0, 10)}
                        </a>
                        <span style={{ color: 'var(--pw-text-faint)' }}>
                          exit={iter.exitCode ?? '?'}
                        </span>
                        {iter.screenshotId && (
                          <img
                            src={`/api/v1/admin/wiggum/${run.id}/screenshots/${iter.screenshotId}`}
                            alt={`#${iter.iteration}`}
                            style={{ width: 48, height: 32, objectFit: 'cover', borderRadius: 3, border: '1px solid var(--pw-border)', cursor: 'pointer' }}
                            onClick={() => window.open(`/api/v1/admin/wiggum/${run.id}/screenshots/${iter.screenshotId}`, '_blank')}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
