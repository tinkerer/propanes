import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { loadAllSessions } from '../lib/sessions.js';

type FlatterState = {
  monitors: any[];
  reports: any[];
  items: any[];
  plans: any[];
  runs: any[];
};

const EMPTY_STATE: FlatterState = {
  monitors: [],
  reports: [],
  items: [],
  plans: [],
  runs: [],
};

function categoryLabel(category: string) {
  if (category === 'critical') return 'Critical';
  if (category === 'nice') return 'Nice to Have';
  return 'Skip';
}

function riskTone(risk: string) {
  if (risk === 'high') return 'var(--pw-danger)';
  if (risk === 'medium') return 'var(--pw-warning)';
  return 'var(--pw-primary)';
}

function statusTone(status: string) {
  if (status === 'done' || status === 'completed') return 'var(--pw-primary)';
  if (status === 'failed') return 'var(--pw-danger)';
  if (status === 'in_progress' || status === 'running') return 'var(--pw-warning)';
  return 'var(--pw-text-muted)';
}

export function FlatterPage({ appId }: { appId: string }) {
  const [state, setState] = useState<FlatterState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [baselineDate, setBaselineDate] = useState('');
  const [includeKeywords, setIncludeKeywords] = useState('');
  const [excludeKeywords, setExcludeKeywords] = useState('');
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await api.getFlatter(appId) as FlatterState;
      setState(result);
      setDraftNotes((prev) => {
        const next = { ...prev };
        for (const item of result.items) {
          if (!(item.id in next)) next[item.id] = item.operatorNotes || '';
        }
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load Flatter');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [appId]);

  const latestReport = state.reports[0] || null;
  const itemsByCategory = useMemo(() => {
    const map: Record<string, any[]> = {
      critical: [],
      nice: [],
      skip: [],
    };
    for (const item of state.items) {
      if (!map[item.category]) map[item.category] = [];
      map[item.category].push(item);
    }
    return map;
  }, [state.items]);

  const acceptedItems = useMemo(() => state.items.filter((item) => item.status === 'accepted'), [state.items]);
  const latestPlan = state.plans[0] || null;

  const runsByPlan = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const run of state.runs) {
      const key = run.planId || run.itemId;
      const list = map.get(key) || [];
      list.push(run);
      map.set(key, list);
    }
    return map;
  }, [state.runs]);

  async function submitMonitor() {
    setBusyKey('create-monitor');
    setError('');
    try {
      const result = await api.createFlatterMonitor(appId, {
        name,
        repoUrl,
        branch,
        baselineDate: baselineDate || undefined,
        focus: {
          includeKeywords: includeKeywords.split(',').map((part) => part.trim()).filter(Boolean),
          excludeKeywords: excludeKeywords.split(',').map((part) => part.trim()).filter(Boolean),
        },
      }) as FlatterState;
      setState(result);
      setShowCreate(false);
      setName('');
      setRepoUrl('');
      setBranch('main');
      setBaselineDate('');
      setIncludeKeywords('');
      setExcludeKeywords('');
    } catch (err: any) {
      setError(err.message || 'Failed to create monitor');
    } finally {
      setBusyKey('');
    }
  }

  async function scanMonitor(monitorId: string) {
    setBusyKey(`scan:${monitorId}`);
    setError('');
    try {
      setState(await api.scanFlatterMonitor(monitorId) as FlatterState);
    } catch (err: any) {
      setError(err.message || 'Scan failed');
    } finally {
      setBusyKey('');
    }
  }

  async function saveItem(item: any, patch: Record<string, unknown>) {
    setBusyKey(`item:${item.id}`);
    setError('');
    try {
      setState(await api.updateFlatterItem(item.id, patch) as FlatterState);
    } catch (err: any) {
      setError(err.message || 'Save failed');
    } finally {
      setBusyKey('');
    }
  }

  async function createPlan() {
    setBusyKey('create-plan');
    setError('');
    try {
      setState(await api.createFlatterPlan(appId) as FlatterState);
      await loadAllSessions();
    } catch (err: any) {
      setError(err.message || 'Plan creation failed');
    } finally {
      setBusyKey('');
    }
  }

  async function runPlan(planId: string) {
    setBusyKey(`run-plan:${planId}`);
    setError('');
    try {
      setState(await api.runFlatterPlan(planId) as FlatterState);
      await loadAllSessions();
    } catch (err: any) {
      setError(err.message || 'Plan run failed');
    } finally {
      setBusyKey('');
    }
  }

  return (
    <div style="padding:16px;display:flex;flex-direction:column;gap:16px">
      <div class="page-header" style="margin-bottom:0">
        <div>
          <h2 style="margin-bottom:6px">Flatter</h2>
          <div style="font-size:13px;color:var(--pw-text-muted);max-width:920px">
            Monitor upstream projects, rank what to lift into this app, collect operator notes, and fan work out into parallel PR, review, and verification lanes.
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Close' : '+ Monitor'}
          </button>
          <button class="btn btn-sm" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
      </div>

      {error && (
        <div class="detail-card" style={{ borderColor: 'var(--pw-danger)', color: 'var(--pw-danger)' }}>
          {error}
        </div>
      )}

      {showCreate && (
        <div class="detail-card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div class="form-group">
            <label>Name</label>
            <input value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} placeholder="agent-portal structured view" />
          </div>
          <div class="form-group">
            <label>Repo URL</label>
            <input value={repoUrl} onInput={(e) => setRepoUrl((e.currentTarget as HTMLInputElement).value)} placeholder="https://github.com/org/repo" />
          </div>
          <div class="form-group">
            <label>Branch</label>
            <input value={branch} onInput={(e) => setBranch((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="form-group">
            <label>Baseline Date</label>
            <input value={baselineDate} onInput={(e) => setBaselineDate((e.currentTarget as HTMLInputElement).value)} placeholder="2026-04-19T20:03:39Z" />
          </div>
          <div class="form-group">
            <label>Include Keywords</label>
            <input value={includeKeywords} onInput={(e) => setIncludeKeywords((e.currentTarget as HTMLInputElement).value)} placeholder="structured, session, input, subagent" />
          </div>
          <div class="form-group">
            <label>Exclude Keywords</label>
            <input value={excludeKeywords} onInput={(e) => setExcludeKeywords((e.currentTarget as HTMLInputElement).value)} placeholder="proxy, auth, docs" />
          </div>
          <div style="grid-column:1 / -1;display:flex;justify-content:flex-end">
            <button class="btn btn-primary" onClick={() => void submitMonitor()} disabled={busyKey === 'create-monitor'}>
              {busyKey === 'create-monitor' ? 'Creating…' : 'Create Monitor'}
            </button>
          </div>
        </div>
      )}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
        {state.monitors.map((monitor) => (
          <div key={monitor.id} class="detail-card" style="display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
              <div>
                <div style="font-weight:700">{monitor.name}</div>
                <div style="font-size:12px;color:var(--pw-text-muted)">{monitor.repoUrl}</div>
                <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">
                  {monitor.branch} · {monitor.baselineRef ? `since ${monitor.baselineRef}` : monitor.baselineDate ? `since ${monitor.baselineDate.slice(0, 10)}` : 'latest'}
                </div>
              </div>
              <button class="btn btn-sm" onClick={() => void scanMonitor(monitor.id)} disabled={busyKey === `scan:${monitor.id}`}>
                {busyKey === `scan:${monitor.id}` ? 'Scanning…' : 'Scan'}
              </button>
            </div>
            <div style="font-size:12px;color:var(--pw-text-muted)">
              Focus: {(monitor.focus?.includeKeywords || []).join(', ') || 'none'}
            </div>
            {monitor.lastHeadSha && (
              <div style="font-size:11px;color:var(--pw-text-faint)">
                Head: <code>{String(monitor.lastHeadSha).slice(0, 12)}</code>
              </div>
            )}
          </div>
        ))}
        {state.monitors.length === 0 && !loading && (
          <div class="detail-card" style="color:var(--pw-text-muted)">No monitors configured.</div>
        )}
      </div>

      {latestReport && (
        <div class="detail-card" style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start">
          <div>
            <div style="font-size:11px;color:var(--pw-text-faint);text-transform:uppercase;letter-spacing:.06em">Latest Report</div>
            <div style="font-size:18px;font-weight:700;margin-top:4px">{latestReport.title}</div>
            <div style="font-size:13px;color:var(--pw-text-muted);margin-top:6px">{latestReport.summary}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
            <span class="sm-tool-badge">{latestReport.stats?.commitCount || 0} commits scanned</span>
            {latestReport.upstreamHeadSha && <span class="sm-tool-badge">head {String(latestReport.upstreamHeadSha).slice(0, 7)}</span>}
          </div>
        </div>
      )}

      <div class="detail-card" style="display:flex;flex-direction:column;gap:14px;flex:0 0 auto;overflow:visible">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <div style="font-size:11px;color:var(--pw-text-faint);text-transform:uppercase;letter-spacing:.06em">Plan & Run</div>
            <div style="font-size:18px;font-weight:700;margin-top:4px">
              {latestPlan ? latestPlan.title : 'No plan generated yet'}
            </div>
            <div style="font-size:13px;color:var(--pw-text-muted);margin-top:6px">
              {latestPlan ? latestPlan.summary : `${acceptedItems.length} accepted items are ready to aggregate into a plan.`}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn btn-sm" onClick={() => void createPlan()} disabled={busyKey === 'create-plan' || acceptedItems.length === 0}>
              {busyKey === 'create-plan' ? 'Planning…' : 'Create Plan from Accepted'}
            </button>
            {latestPlan && (
              <button class="btn btn-primary btn-sm" onClick={() => void runPlan(latestPlan.id)} disabled={busyKey === `run-plan:${latestPlan.id}` || latestPlan.status !== 'ready'}>
                {busyKey === `run-plan:${latestPlan.id}` ? 'Starting…' : latestPlan.status === 'planning' ? 'Planning…' : latestPlan.status === 'running' ? 'Running' : 'Run Plan'}
              </button>
            )}
          </div>
        </div>

        {latestPlan && (
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
            <div style="border:1px solid var(--pw-border);border-radius:10px;padding:12px;background:var(--pw-bg-surface)">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                <strong style="font-size:13px">Accepted Changes</strong>
                <span class="sm-tool-badge" style={{ color: statusTone(latestPlan.status), borderColor: statusTone(latestPlan.status) }}>{latestPlan.status}</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;max-height:240px;overflow:auto">
                {(latestPlan.items || []).map((item: any) => (
                  <div key={item.id} style="font-size:12px;color:var(--pw-text-muted)">
                    <span style="color:var(--pw-text-primary);font-weight:700">{item.title}</span>
                    <span> · risk {item.risk}</span>
                    {item.operatorNotes ? <div style="margin-top:3px;color:var(--pw-text-faint)">Notes: {item.operatorNotes}</div> : null}
                  </div>
                ))}
              </div>
            </div>
            <div style="border:1px solid var(--pw-border);border-radius:10px;padding:12px;background:var(--pw-bg)">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                <strong style="font-size:13px">Progress</strong>
                {latestPlan.planningSessionId && (
                  <a href={`#/sessions/${latestPlan.planningSessionId}`} style="font-size:11px">Open planning session</a>
                )}
              </div>
              {latestPlan.planningSessionId && (
                <div style="font-size:12px;color:var(--pw-text-muted);margin-top:10px">
                  Planning session: <span style={{ color: statusTone(String(latestPlan.planningSessionStatus || latestPlan.status)) }}>{latestPlan.planningSessionStatus || latestPlan.status}</span>
                </div>
              )}
              {(runsByPlan.get(latestPlan.id) || []).length === 0 && (
                <div style="font-size:12px;color:var(--pw-text-muted);margin-top:10px">Run this plan to launch PR, review, and verification lanes.</div>
              )}
              {(runsByPlan.get(latestPlan.id) || []).map((run) => (
                <div key={run.id} style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px">
                  {run.columns.map((column: any) => (
                    <div key={String(column.key)} style="border:1px solid var(--pw-border);border-radius:8px;padding:8px;background:var(--pw-bg-surface)">
                      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                        <strong style="font-size:12px">{column.label}</strong>
                        <span style={{ fontSize: '11px', color: statusTone(String(column.sessionStatus || 'pending')) }}>{String(column.sessionStatus || 'pending')}</span>
                      </div>
                      <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">{column.agentName}</div>
                      {column.sessionId && (
                        <a href={`#/sessions/${column.sessionId}`} style="font-size:11px;margin-top:6px;display:inline-block">Open session</a>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:start">
        {(['critical', 'nice', 'skip'] as const).map((category) => (
          <div key={category} class="detail-card" style="display:flex;flex-direction:column;gap:12px;min-height:240px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <h3 style="margin:0">{categoryLabel(category)}</h3>
              <span class="sidebar-count">{itemsByCategory[category]?.length || 0}</span>
            </div>
            {(itemsByCategory[category] || []).map((item) => {
              return (
                <div key={item.id} style="border:1px solid var(--pw-border);border-radius:10px;padding:12px;background:var(--pw-bg-surface);display:flex;flex-direction:column;gap:10px">
                  <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
                    <div>
                      <div style="font-weight:700;line-height:1.35">{item.title}</div>
                      <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">
                        {item.payload?.shortSha ? <code>{item.payload.shortSha}</code> : null}
                        {item.payload?.date ? ` · ${String(item.payload.date).slice(0, 10)}` : null}
                      </div>
                    </div>
                    {item.upstreamUrl && (
                      <a class="btn btn-sm" href={item.upstreamUrl} target="_blank" rel="noreferrer">Commit</a>
                    )}
                  </div>
                  {item.summary && <div style="font-size:12px;color:var(--pw-text-muted)">{item.summary}</div>}
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <span class="sm-tool-badge" style={{ color: riskTone(item.risk), borderColor: riskTone(item.risk) }}>risk {item.risk}</span>
                    <span class="sm-tool-badge">relevance {item.relevance}</span>
                    <span class="sm-tool-badge" style={{ color: statusTone(item.status), borderColor: statusTone(item.status) }}>{item.status}</span>
                  </div>
                  <div style="font-size:12px;color:var(--pw-text-muted)">{item.rationale}</div>
                  <div style="font-size:12px">{item.scopeNotes}</div>

                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    {item.status !== 'accepted' && item.status !== 'done' && (
                      <button class="btn btn-sm" onClick={() => void saveItem(item, { status: 'accepted' })} disabled={busyKey === `item:${item.id}`}>Accept</button>
                    )}
                    {item.status !== 'skipped' && (
                      <button class="btn btn-sm" onClick={() => void saveItem(item, { status: 'skipped', category: 'skip' })} disabled={busyKey === `item:${item.id}`}>Skip</button>
                    )}
                  </div>

                  <div style="display:flex;flex-direction:column;gap:6px">
                    <label style="font-size:11px;color:var(--pw-text-faint)">Operator Notes</label>
                    <textarea
                      value={draftNotes[item.id] ?? ''}
                      onInput={(e) => setDraftNotes((prev) => ({ ...prev, [item.id]: (e.currentTarget as HTMLTextAreaElement).value }))}
                      style="width:100%;min-height:72px"
                    />
                    <div style="display:flex;justify-content:flex-end">
                      <button class="btn btn-sm" onClick={() => void saveItem(item, { operatorNotes: draftNotes[item.id] ?? '' })} disabled={busyKey === `item:${item.id}`}>Save Notes</button>
                    </div>
                  </div>

                </div>
              );
            })}
            {(itemsByCategory[category] || []).length === 0 && (
              <div style="font-size:12px;color:var(--pw-text-muted)">No items in this bucket.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
