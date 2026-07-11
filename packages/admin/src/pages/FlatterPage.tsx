import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { api } from '../lib/api.js';
import { loadAllSessions, resumeSession } from '../lib/sessions.js';
import { FlatterAssistButton } from '../components/dispatch/FlatterAssistButton.js';

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

type SourceType = 'git' | 'webapp' | 'local';

const SOURCE_TYPES: { key: SourceType; label: string; hint: string }[] = [
  { key: 'git', label: 'Git Repo', hint: 'Scan upstream commits since a baseline' },
  { key: 'webapp', label: 'Web App', hint: 'Explore a live app with Playwright' },
  { key: 'local', label: 'Local App', hint: 'Examine a downloaded app via computer-use' },
];

function sourceTypeLabel(sourceType: string) {
  if (sourceType === 'webapp') return 'web app';
  if (sourceType === 'local') return 'local app';
  return 'git';
}

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
  const [sourceType, setSourceType] = useState<SourceType>('git');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [baselineDate, setBaselineDate] = useState('');
  const [includeKeywords, setIncludeKeywords] = useState('');
  const [excludeKeywords, setExcludeKeywords] = useState('');
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [planExpanded, setPlanExpanded] = useState(false);
  const [askPopup, setAskPopup] = useState<{ x: number; y: number; quote: string } | null>(null);
  const [askText, setAskText] = useState('');
  const [adjustText, setAdjustText] = useState('');
  const planDocRef = useRef<HTMLDivElement>(null);
  const askInputRef = useRef<HTMLTextAreaElement>(null);

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
  const planHtml = useMemo(() => {
    const doc = latestPlan?.planDocument;
    if (!doc) return '';
    const html = marked.parse(doc);
    return typeof html === 'string' ? html : '';
  }, [latestPlan?.planDocument]);

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
        sourceType,
        repoUrl,
        branch: sourceType === 'git' ? branch : 'main',
        baselineDate: sourceType === 'git' && baselineDate ? baselineDate : undefined,
        focus: {
          includeKeywords: includeKeywords.split(',').map((part) => part.trim()).filter(Boolean),
          excludeKeywords: excludeKeywords.split(',').map((part) => part.trim()).filter(Boolean),
        },
      }) as FlatterState;
      setState(result);
      setShowCreate(false);
      setSourceType('git');
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

  async function acceptPlan(planId: string) {
    setBusyKey(`accept-plan:${planId}`);
    setError('');
    try {
      setState(await api.acceptFlatterPlan(planId) as FlatterState);
    } catch (err: any) {
      setError(err.message || 'Accept failed');
    } finally {
      setBusyKey('');
    }
  }

  async function reopenPlan(planId: string) {
    setBusyKey(`reopen-plan:${planId}`);
    setError('');
    try {
      setState(await api.reopenFlatterPlan(planId) as FlatterState);
    } catch (err: any) {
      setError(err.message || 'Re-open failed');
    } finally {
      setBusyKey('');
    }
  }

  // Deliver an adjustment request to the planning lane: type into the live
  // session when it's still running, otherwise resume it with the prompt.
  // Either way the plan drops back to 'planning' so the revised document is
  // re-read from the session transcript.
  async function sendToPlanner(message: string): Promise<boolean> {
    const plan = latestPlan;
    if (!plan?.planningSessionId) {
      setError('This plan has no planning session to talk to');
      return false;
    }
    setBusyKey(`ask-plan:${plan.id}`);
    setError('');
    try {
      let newSessionId: string | undefined;
      if (plan.planningSessionStatus === 'running' || plan.planningSessionStatus === 'pending') {
        const result = await api.sendKeys(plan.planningSessionId, { keys: message, enter: true });
        if (!result.ok) throw new Error(result.error || 'send-keys failed');
      } else {
        const resumed = await resumeSession(plan.planningSessionId, { additionalPrompt: message });
        if (!resumed) throw new Error('Failed to resume the planning session');
        newSessionId = resumed;
      }
      setState(await api.reopenFlatterPlan(plan.id, newSessionId) as FlatterState);
      await loadAllSessions();
      return true;
    } catch (err: any) {
      setError(err.message || 'Failed to send to planner');
      return false;
    } finally {
      setBusyKey('');
    }
  }

  async function sendAsk() {
    if (!askPopup || !askText.trim()) return;
    const quoted = askPopup.quote.split('\n').map((line) => `> ${line}`).join('\n');
    const ok = await sendToPlanner(`About this part of the Flatter plan:\n\n${quoted}\n\n${askText.trim()}`);
    if (ok) {
      setAskPopup(null);
      setAskText('');
    }
  }

  async function sendAdjust() {
    if (!adjustText.trim()) return;
    const ok = await sendToPlanner(adjustText.trim());
    if (ok) setAdjustText('');
  }

  function onPlanMouseUp() {
    // Defer so the selection reflects this mouseup before we read it.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const quote = sel.toString().trim();
      if (!quote) return;
      const container = planDocRef.current;
      if (!container || !container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const width = 420;
      const x = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8);
      const below = rect.bottom + 8;
      const y = below + 240 > window.innerHeight ? Math.max(rect.top - 248, 8) : below;
      setAskPopup({ x, y, quote: quote.slice(0, 1500) });
      setAskText('');
    }, 0);
  }

  useEffect(() => {
    if (!askPopup) return;
    setTimeout(() => askInputRef.current?.focus(), 0);
    // Capture phase: pane-level handlers swallow bubbled keydowns.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setAskPopup(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('.flatter-ask-popup')) setAskPopup(null);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [askPopup]);

  return (
    // Rendered inside a fixed-height pane body: without min-content flooring,
    // flex children shrink and .detail-card { overflow: hidden } clips them to
    // their first row (the "40px form" bug), so every direct child is
    // flex: 0 0 auto.
    <div style="padding:16px;display:flex;flex-direction:column;gap:16px">
      <div class="page-header" style="margin-bottom:0;flex:0 0 auto">
        <div>
          <h2 style="margin-bottom:6px">Flatter</h2>
          <div style="font-size:13px;color:var(--pw-text-muted);max-width:920px">
            Monitor upstream projects, rank what to lift into this app, collect operator notes, and fan work out into parallel PR, review, and verification lanes.
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <FlatterAssistButton appId={appId} appLabel="Flatter" />
          <button class="btn btn-sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Close' : '+ Monitor'}
          </button>
          <button class="btn btn-sm" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
      </div>

      {error && (
        <div class="detail-card" style={{ borderColor: 'var(--pw-danger)', color: 'var(--pw-danger)', flex: '0 0 auto' }}>
          {error}
        </div>
      )}

      {showCreate && (
        <div class="detail-card" style="display:flex;flex-direction:column;gap:16px;max-width:880px;flex:0 0 auto">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
            <div>
              <div style="font-size:15px;font-weight:700">New Monitor</div>
              <div style="font-size:12px;color:var(--pw-text-muted);margin-top:2px">
                Watch another application and surface features worth lifting into this one.
              </div>
            </div>
            <FlatterAssistButton appId={appId} appLabel="New monitor" />
          </div>

          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
            {SOURCE_TYPES.map((st) => (
              <button
                key={st.key}
                type="button"
                onClick={() => setSourceType(st.key)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  border: `1px solid ${sourceType === st.key ? 'var(--pw-primary)' : 'var(--pw-border)'}`,
                  background: sourceType === st.key ? 'rgba(99,102,241,0.12)' : 'var(--pw-bg-surface)',
                  color: 'var(--pw-text-primary)',
                }}
              >
                <div style="font-size:13px;font-weight:700">{st.label}</div>
                <div style="font-size:11px;color:var(--pw-text-muted);margin-top:3px;line-height:1.4">{st.hint}</div>
              </button>
            ))}
          </div>

          <div style="display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:12px">
            <div class="form-group">
              <label>Name</label>
              <input value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} placeholder={sourceType === 'git' ? 'agent-portal structured view' : sourceType === 'webapp' ? 'linear command palette' : 'obsidian graph view'} />
            </div>
            {sourceType === 'git' && (
              <div class="form-group">
                <label>Repo URL</label>
                <input value={repoUrl} onInput={(e) => setRepoUrl((e.currentTarget as HTMLInputElement).value)} placeholder="https://github.com/org/repo" />
              </div>
            )}
            {sourceType === 'webapp' && (
              <div class="form-group">
                <label>Target URL</label>
                <input value={repoUrl} onInput={(e) => setRepoUrl((e.currentTarget as HTMLInputElement).value)} placeholder="https://app.example.com" />
                <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">An exploration agent drives the live app in a Playwright browser.</div>
              </div>
            )}
            {sourceType === 'local' && (
              <div class="form-group">
                <label>App Path or Launch Command</label>
                <input value={repoUrl} onInput={(e) => setRepoUrl((e.currentTarget as HTMLInputElement).value)} placeholder="/home/user/downloads/some-app or `some-app --flag`" />
                <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">An exploration agent launches the app on a visible display (computer-use) to examine it.</div>
              </div>
            )}
            {sourceType === 'git' && (
              <>
                <div class="form-group">
                  <label>Branch</label>
                  <input value={branch} onInput={(e) => setBranch((e.currentTarget as HTMLInputElement).value)} />
                </div>
                <div class="form-group">
                  <label>Baseline Date <span style="font-weight:400;color:var(--pw-text-faint)">(optional)</span></label>
                  <input value={baselineDate} onInput={(e) => setBaselineDate((e.currentTarget as HTMLInputElement).value)} placeholder="2026-04-19T20:03:39Z" />
                  <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">Only commits after this date are scanned. Leave blank to scan the latest window.</div>
                </div>
              </>
            )}
          </div>

          <div style="display:flex;flex-direction:column;gap:12px">
            <div style="font-size:11px;color:var(--pw-text-faint);text-transform:uppercase;letter-spacing:.06em">
              {sourceType === 'git' ? 'Focus keywords' : 'What to look for'}
            </div>
            <div style="display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:12px">
              <div class="form-group">
                <label>Include</label>
                <input value={includeKeywords} onInput={(e) => setIncludeKeywords((e.currentTarget as HTMLInputElement).value)} placeholder="structured, session, input, subagent" />
                <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">Comma-separated. {sourceType === 'git' ? 'Commits matching these rank higher.' : 'Steers the exploration agent toward these features.'}</div>
              </div>
              <div class="form-group">
                <label>Exclude</label>
                <input value={excludeKeywords} onInput={(e) => setExcludeKeywords((e.currentTarget as HTMLInputElement).value)} placeholder="proxy, auth, docs" />
                <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">Comma-separated. Matches are skipped.</div>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--pw-border);padding-top:12px">
            <div style="font-size:12px;color:var(--pw-text-muted)">
              {sourceType === 'git'
                ? 'Scanning ranks upstream commits into Critical / Nice to Have / Skip for triage.'
                : 'Exploring dispatches an agent session that examines the target and posts findings for triage.'}
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" onClick={() => setShowCreate(false)}>Cancel</button>
              <button class="btn btn-primary" onClick={() => void submitMonitor()} disabled={busyKey === 'create-monitor' || !name.trim() || !repoUrl.trim()}>
                {busyKey === 'create-monitor' ? 'Creating…' : 'Create Monitor'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;flex:0 0 auto">
        {state.monitors.map((monitor) => {
          const isGit = (monitor.sourceType || 'git') === 'git';
          return (
            <div key={monitor.id} class="detail-card" style="display:flex;flex-direction:column;gap:10px">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
                <div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <div style="font-weight:700">{monitor.name}</div>
                    <span class="sm-tool-badge">{sourceTypeLabel(monitor.sourceType || 'git')}</span>
                  </div>
                  <div style="font-size:12px;color:var(--pw-text-muted)">{monitor.repoUrl}</div>
                  {isGit && (
                    <div style="font-size:11px;color:var(--pw-text-faint);margin-top:4px">
                      {monitor.branch} · {monitor.baselineRef ? `since ${monitor.baselineRef}` : monitor.baselineDate ? `since ${monitor.baselineDate.slice(0, 10)}` : 'latest'}
                    </div>
                  )}
                </div>
                <button class="btn btn-sm" onClick={() => void scanMonitor(monitor.id)} disabled={busyKey === `scan:${monitor.id}`}>
                  {busyKey === `scan:${monitor.id}` ? (isGit ? 'Scanning…' : 'Dispatching…') : (isGit ? 'Scan' : 'Explore')}
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
              {monitor.lastExploreSessionId && (
                <div style="font-size:11px">
                  <a href={`#/sessions/${monitor.lastExploreSessionId}`}>Open exploration session</a>
                </div>
              )}
            </div>
          );
        })}
        {state.monitors.length === 0 && !loading && (
          <div class="detail-card" style="color:var(--pw-text-muted)">No monitors configured.</div>
        )}
      </div>

      {latestReport && (
        <div class="detail-card" style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex:0 0 auto">
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
            {latestPlan && latestPlan.status === 'planning' && (
              <button
                class="btn btn-primary btn-sm"
                onClick={() => void acceptPlan(latestPlan.id)}
                disabled={busyKey === `accept-plan:${latestPlan.id}` || !planHtml}
              >
                {!planHtml ? 'Planning…' : busyKey === `accept-plan:${latestPlan.id}` ? 'Accepting…' : 'Accept Plan'}
              </button>
            )}
            {latestPlan && latestPlan.status === 'ready' && (
              <>
                {latestPlan.planningSessionId && (
                  <button
                    class="btn btn-sm"
                    onClick={() => void reopenPlan(latestPlan.id)}
                    disabled={busyKey === `reopen-plan:${latestPlan.id}`}
                  >
                    {busyKey === `reopen-plan:${latestPlan.id}` ? 'Re-opening…' : 'Re-open Planning'}
                  </button>
                )}
                <button
                  class="btn btn-primary btn-sm"
                  onClick={() => void runPlan(latestPlan.id)}
                  disabled={busyKey === `run-plan:${latestPlan.id}`}
                >
                  {busyKey === `run-plan:${latestPlan.id}` ? 'Starting…' : 'Run Plan'}
                </button>
              </>
            )}
            {latestPlan && (latestPlan.status === 'running' || latestPlan.status === 'failed') && (
              <button class="btn btn-primary btn-sm" disabled>
                {latestPlan.status === 'running' ? 'Running' : 'Planning Failed'}
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

        {latestPlan && (planHtml ? (
          <div style="border:1px solid var(--pw-border);border-radius:10px;padding:14px;background:var(--pw-bg)">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
              <strong style="font-size:13px">Implementation Plan</strong>
              <div style="display:flex;gap:8px;align-items:center">
                <span style="font-size:11px;color:var(--pw-text-faint)">Highlight any part of the plan to ask the planner about it</span>
                <button class="btn btn-sm" onClick={() => setPlanExpanded((v) => !v)}>
                  {planExpanded ? 'Collapse' : 'Expand'}
                </button>
              </div>
            </div>
            <div
              ref={planDocRef}
              class="sm-md-rendered"
              style={{ marginTop: '10px', fontSize: '13px', overflow: 'auto', maxHeight: planExpanded ? 'none' : '320px' }}
              onMouseUp={onPlanMouseUp}
              dangerouslySetInnerHTML={{ __html: planHtml }}
            />
            {latestPlan.planningSessionId && (
              <div style="display:flex;gap:8px;margin-top:12px">
                <input
                  style="flex:1"
                  placeholder="Request adjustments or ask the planner… (highlight plan text to quote it)"
                  value={adjustText}
                  onInput={(e) => setAdjustText((e.currentTarget as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendAdjust(); } }}
                />
                <button
                  class="btn btn-sm"
                  onClick={() => void sendAdjust()}
                  disabled={!adjustText.trim() || busyKey === `ask-plan:${latestPlan.id}`}
                >
                  {busyKey === `ask-plan:${latestPlan.id}` ? 'Sending…' : 'Send'}
                </button>
              </div>
            )}
          </div>
        ) : latestPlan.status === 'planning' ? (
          <div style="font-size:12px;color:var(--pw-text-muted)">
            The planning session is still running — the implementation plan will appear here when it completes.
          </div>
        ) : null)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:start;flex:0 0 auto">
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

      {askPopup && (
        <div
          class="flatter-ask-popup"
          // Floating over arbitrary content — hardcoded opaque background, not
          // var(--pw-bg-surface) (translucent inside dark scopes).
          style={{
            position: 'fixed',
            left: `${askPopup.x}px`,
            top: `${askPopup.y}px`,
            width: '420px',
            zIndex: 1000,
            background: '#1e293b',
            border: '1px solid var(--pw-border)',
            borderRadius: '10px',
            padding: '12px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style="font-size:11px;color:var(--pw-text-faint);text-transform:uppercase;letter-spacing:.06em">Ask the planner about</div>
          <div style="font-size:12px;color:var(--pw-text-muted);max-height:72px;overflow:auto;border-left:2px solid var(--pw-border);padding-left:8px;white-space:pre-wrap">
            {askPopup.quote}
          </div>
          <textarea
            ref={askInputRef}
            value={askText}
            placeholder="What should change or be clarified? (Enter to send, Shift+Enter for newline)"
            style="min-height:64px;resize:vertical"
            onInput={(e) => setAskText((e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendAsk();
              }
            }}
          />
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn btn-sm" onClick={() => setAskPopup(null)}>Cancel</button>
            <button
              class="btn btn-primary btn-sm"
              onClick={() => void sendAsk()}
              disabled={!askText.trim() || (latestPlan && busyKey === `ask-plan:${latestPlan.id}`)}
            >
              {latestPlan && busyKey === `ask-plan:${latestPlan.id}` ? 'Sending…' : 'Send to Planner'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
