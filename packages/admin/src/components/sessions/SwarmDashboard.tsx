import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { marked } from 'marked';
import { api } from '../../lib/api.js';
import { launchFAFOAssistant } from '../../lib/agent-constants.js';
import { selectedAppId } from '../../lib/state.js';
import { openSession } from '../../lib/sessions.js';
import { openSessionLogDrawer } from '../../lib/companion-state.js';

interface SwarmSummary {
  id: string;
  name: string;
  mode: string;
  promptFile: string | null;
  fitnessCommand: string | null;
  targetArtifact: string | null;
  artifactType: string;
  fitnessMetric: string;
  fanOut: number;
  generationCount: number;
  status: string;
  appId: string | null;
  harnessConfigId: string | null;
  knowledgeContent: string;
  isolation: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SwarmPath {
  id: string;
  swarmId: string;
  name: string;
  prompt: string;
  files: string | null;
  focusLines: string | null;
  cropRegion: string | null;
  fitnessMetric: string | null;
  fitnessCommand: string | null;
  worktreePort: number | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  status: string;
  order: number;
}

interface SwarmRun {
  id: string;
  status: string;
  generation: number | null;
  pathId: string | null;
  fitnessScore: number | null;
  fitnessDetail: string | null;
  survived: boolean | null;
  parentRunId: string | null;
  knobs: string | null;
  currentIteration: number;
  maxIterations: number;
  iterations: any[];
  screenshots: any[];
  isActive: boolean;
  agentLabel: string | null;
  finalArtifactPath: string | null;
  sessionId: string | null;
  createdAt: string;
}

interface SwarmDetail extends SwarmSummary {
  generations: Record<string, SwarmRun[]>;
  paths: SwarmPath[];
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#888',
  running: '#4CAF50',
  paused: '#FF9800',
  completed: '#2196F3',
  failed: '#f44336',
  stopped: '#9E9E9E',
};

const ARTIFACT_TYPES = ['screenshot', 'svg', 'script', 'diff'] as const;
const FITNESS_PRESETS = [
  { label: 'Image diff', value: 'imgdiff' },
  { label: 'Test pass rate', value: 'test-pass' },
  { label: 'Custom shell', value: '' },
];

export function SwarmDashboard() {
  const [swarms, setSwarms] = useState<SwarmSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledge, setKnowledge] = useState('');
  const [loading, setLoading] = useState(false);

  const loadSwarms = useCallback(async () => {
    try {
      const list = await api.getSwarms(selectedAppId.value || undefined);
      setSwarms(list);
    } catch { /* ignore */ }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setLoading(true);
      const d = await api.getSwarm(id);
      setDetail(d);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
    loadSwarms();
  }, [selectedAppId.value]);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
      const timer = setInterval(() => loadDetail(selectedId), 5000);
      return () => clearInterval(timer);
    }
  }, [selectedId]);

  useEffect(() => {
    if (knowledgeOpen && selectedId) {
      api.getSwarmKnowledge(selectedId).then(r => setKnowledge(r.knowledge)).catch(() => {});
    }
  }, [knowledgeOpen, selectedId]);

  if (selectedId && detail) {
    return <SwarmDetailView
      detail={detail}
      knowledgeOpen={knowledgeOpen}
      knowledge={knowledge}
      onBack={() => { setSelectedId(null); setDetail(null); }}
      onToggleKnowledge={() => setKnowledgeOpen(!knowledgeOpen)}
      onRefresh={() => loadDetail(selectedId)}
      onNextGen={async (data) => {
        await api.triggerNextGeneration(selectedId, data);
        loadDetail(selectedId);
      }}
    />;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>FAFO Swarms</h3>
        <button class="btn btn-sm" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : '+ New Swarm'}
        </button>
      </div>

      {showCreate && <CreateSwarmForm onCreated={(s) => {
        setSwarms([s, ...swarms]);
        setShowCreate(false);
        setSelectedId(s.id);
      }} />}

      {swarms.length === 0 && !showCreate && (
        <div style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 32 }}>
          No swarms yet. Create one to start a FAFO evolutionary search.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {swarms.map(s => (
          <div
            key={s.id}
            class="session-card"
            style={{ cursor: 'pointer' }}
            onClick={() => setSelectedId(s.id)}
          >
            <div class="session-card-main">
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: STATUS_COLORS[s.status] || '#888',
                flexShrink: 0,
              }} />
              <span class="session-card-label" style={{ fontWeight: 600 }}>
                {s.name}
              </span>
              {s.mode === 'multi-path' && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                  background: '#7c3aed', color: '#fff', letterSpacing: '0.5px',
                }}>
                  MULTI-PATH
                </span>
              )}
              <span style={{ fontSize: 11, color: '#888' }}>
                {s.artifactType}
              </span>
              <span style={{ fontSize: 11, color: '#888' }}>
                {s.generationCount} gen{s.generationCount !== 1 ? 's' : ''}
              </span>
              <span class={`session-card-status ${s.status}`}>{s.status}</span>
              <button
                class="btn btn-sm"
                style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', background: '#7c3aed', color: '#fff', flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  const ctx = `The user wants help with swarm "${s.name}" (ID: ${s.id}).
Mode: ${s.mode} | Artifact: ${s.artifactType} | Fitness: ${s.fitnessCommand || 'none'} | Metric: ${s.fitnessMetric}
Target: ${s.targetArtifact || 'none'} | Generations: ${s.generationCount} | Status: ${s.status}
Fan-out: ${s.fanOut} | Harness: ${s.harnessConfigId || 'none'}

Start by fetching the full swarm detail: curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/${s.id}'
Then ask the user what they need help with.`;
                  launchFAFOAssistant({ appId: selectedAppId.value, context: ctx }).catch(() => {});
                }}
                title="Launch assistant for this swarm"
              >
                Assist
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Create Swarm Form ────────────────────────────────

function CreateSwarmForm({ onCreated }: { onCreated: (s: SwarmSummary) => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'single' | 'multi-path'>('single');
  const [artifactType, setArtifactType] = useState('screenshot');
  const [fitnessCommand, setFitnessCommand] = useState('');
  const [fitnessPreset, setFitnessPreset] = useState('imgdiff');
  const [fitnessMetric, setFitnessMetric] = useState('pixel-diff');
  const [targetArtifact, setTargetArtifact] = useState('');
  const [fanOut, setFanOut] = useState(6);
  const [isolationMethod, setIsolationMethod] = useState('worktree');
  const [basePort, setBasePort] = useState(5200);
  const [saving, setSaving] = useState(false);

  return (
    <div style={{
      background: 'var(--pw-bg-surface)',
      borderRadius: 8,
      padding: 16,
      marginBottom: 12,
      border: '1px solid var(--pw-border)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          type="text"
          placeholder="Swarm name (e.g. harness-combiner-svg)"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={mode}
            onChange={(e) => setMode((e.target as HTMLSelectElement).value as any)}
            style={{ width: 120, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
          >
            <option value="single">Single</option>
            <option value="multi-path">Multi-path</option>
          </select>
          <select
            value={artifactType}
            onChange={(e) => setArtifactType((e.target as HTMLSelectElement).value)}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
          >
            {ARTIFACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select
            value={fitnessPreset}
            onChange={(e) => {
              setFitnessPreset((e.target as HTMLSelectElement).value);
              if ((e.target as HTMLSelectElement).value) setFitnessCommand((e.target as HTMLSelectElement).value);
            }}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
          >
            {FITNESS_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <input
            type="number"
            value={fanOut}
            min={1}
            max={20}
            onInput={(e) => setFanOut(parseInt((e.target as HTMLInputElement).value) || 6)}
            style={{ width: 60, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)', textAlign: 'center' }}
            title="Fan-out (parallel runs per generation)"
          />
        </div>
        {mode === 'multi-path' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={isolationMethod}
              onChange={(e) => setIsolationMethod((e.target as HTMLSelectElement).value)}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
            >
              <option value="worktree">Worktree isolation</option>
              <option value="none">No isolation</option>
            </select>
            <select
              value={fitnessMetric}
              onChange={(e) => setFitnessMetric((e.target as HTMLSelectElement).value)}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
            >
              <option value="pixel-diff">Pixel diff</option>
              <option value="ssim">SSIM</option>
              <option value="edge-diff">Edge diff</option>
              <option value="custom">Custom</option>
            </select>
            <input
              type="number"
              value={basePort}
              onInput={(e) => setBasePort(parseInt((e.target as HTMLInputElement).value) || 5200)}
              style={{ width: 80, padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)', textAlign: 'center' }}
              title="Base port for worktree vite servers"
            />
          </div>
        )}
        <input
          type="text"
          placeholder="Target artifact path (e.g. /tmp/target.png)"
          value={targetArtifact}
          onInput={(e) => setTargetArtifact((e.target as HTMLInputElement).value)}
          style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
        />
        {fitnessPreset === '' && (
          <input
            type="text"
            placeholder="Custom fitness command (stdin=artifact, stdout=float)"
            value={fitnessCommand}
            onInput={(e) => setFitnessCommand((e.target as HTMLInputElement).value)}
            style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)' }}
          />
        )}
        <button
          class="btn btn-sm"
          disabled={!name || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const s = await api.createSwarm({
                name,
                mode,
                artifactType,
                fitnessCommand: fitnessPreset || fitnessCommand,
                fitnessMetric,
                targetArtifact: targetArtifact || null,
                fanOut,
                appId: selectedAppId.value || null,
                ...(mode === 'multi-path' ? {
                  isolation: { method: isolationMethod, basePort },
                } : {}),
              });
              onCreated(s);
            } catch { /* ignore */ }
            finally { setSaving(false); }
          }}
        >
          {saving ? 'Creating...' : 'Create Swarm'}
        </button>
      </div>
    </div>
  );
}

// ─── Swarm Detail View (Generation Strip Layout) ──────

function SwarmDetailView({
  detail,
  knowledgeOpen,
  knowledge,
  onBack,
  onToggleKnowledge,
  onRefresh,
  onNextGen,
}: {
  detail: SwarmDetail;
  knowledgeOpen: boolean;
  knowledge: string;
  onBack: () => void;
  onToggleKnowledge: () => void;
  onRefresh: () => void;
  onNextGen: (data: Record<string, unknown>) => Promise<void>;
}) {
  const genKeys = Object.keys(detail.generations)
    .map(Number)
    .sort((a, b) => a - b);

  // Compute per-generation stats
  const genStats = genKeys.map(gen => {
    const runs = detail.generations[gen] || [];
    const scores = runs.map(r => r.fitnessScore).filter((s): s is number => s != null);
    return {
      gen,
      runs,
      best: scores.length ? Math.min(...scores) : null,
      median: scores.length ? scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)] : null,
      count: runs.length,
    };
  });

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button class="btn btn-sm" onClick={onBack}>&larr; Back</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>FAFO: {detail.name}</div>
            <div style={{ fontSize: 12, color: '#888' }}>
              fitness: {detail.fitnessCommand || 'none'}
              {detail.targetArtifact && ` | target: ${detail.targetArtifact}`}
            </div>
          </div>
          <button
            class="btn btn-sm"
            style={{ background: '#7c3aed', color: '#fff' }}
            onClick={() => {
              const genKeys = Object.keys(detail.generations);
              const totalRuns = genKeys.reduce((sum, k) => sum + detail.generations[k].length, 0);
              const scores = genKeys.flatMap(k => detail.generations[k].map(r => r.fitnessScore).filter((s): s is number => s != null));
              const ctx = `The user is viewing swarm "${detail.name}" (ID: ${detail.id}).
Mode: ${detail.mode} | Artifact: ${detail.artifactType} | Fitness: ${detail.fitnessCommand || 'none'} | Metric: ${detail.fitnessMetric}
Target: ${detail.targetArtifact || 'none'} | Generations: ${detail.generationCount} | Fan-out: ${detail.fanOut} | Status: ${detail.status}
Total runs: ${totalRuns} | Scores: ${scores.length > 0 ? `best=${Math.min(...scores).toFixed(3)}, worst=${Math.max(...scores).toFixed(3)}` : 'none yet'}
${detail.paths?.length ? `Paths: ${detail.paths.map(p => p.name).join(', ')}` : ''}
${detail.knowledgeContent ? `Knowledge file has ${detail.knowledgeContent.length} chars accumulated.` : 'Knowledge file is empty.'}

Fetch full detail: curl -s $AUTH 'http://localhost:3001/api/v1/admin/wiggum/swarms/${detail.id}'
Help the user with: monitoring progress, analyzing scores, triggering next generation, adjusting config, or troubleshooting.`;
              launchFAFOAssistant({ appId: selectedAppId.value, context: ctx }).catch(() => {});
            }}
          >
            Assist
          </button>
          {detail.mode === 'multi-path' && detail.targetArtifact && (
            <button
              class="btn btn-sm"
              style={{ background: '#e65100', color: '#fff' }}
              onClick={async () => {
                try {
                  const result = await api.decomposeSwarm(detail.id);
                  if (result.sessionId) openSession(result.sessionId);
                } catch { /* ignore */ }
              }}
              title="Auto-analyze target image and suggest worker paths"
            >
              Decompose
            </button>
          )}
          <button class="btn btn-sm" onClick={onToggleKnowledge}>
            {knowledgeOpen ? 'Hide' : 'Show'} Knowledge
          </button>
          <button class="btn btn-sm" onClick={onRefresh}>Refresh</button>
        </div>

        {/* Paths panel (multi-path mode) */}
        {detail.mode === 'multi-path' && detail.paths && detail.paths.length > 0 && (
          <div style={{
            display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12,
            padding: 10, background: 'var(--pw-bg-surface)', borderRadius: 8,
            border: '1px solid var(--pw-border)',
          }}>
            <div style={{ width: '100%', fontSize: 11, fontWeight: 600, color: 'var(--pw-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Paths ({detail.paths.length})
            </div>
            {detail.paths.sort((a, b) => a.order - b.order).map(path => {
              const pathRuns = Object.values(detail.generations).flat().filter((r: SwarmRun) => r.pathId === path.id);
              const activeCount = pathRuns.filter(r => r.status === 'running').length;
              const doneCount = pathRuns.filter(r => r.status === 'completed').length;
              return (
                <div key={path.id} style={{
                  background: 'var(--pw-bg-raised)', borderRadius: 6, padding: '6px 10px',
                  border: `1px solid ${path.status === 'completed' ? 'rgba(76,175,80,0.4)' : 'var(--pw-border)'}`,
                  minWidth: 140,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLORS[path.status] || '#888' }} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{path.name}</span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--pw-text-faint)' }}>
                    {path.worktreePort && <span>:{path.worktreePort} </span>}
                    {path.focusLines && <span>L{path.focusLines} </span>}
                    {activeCount > 0 && <span style={{ color: '#4CAF50' }}>{activeCount} running </span>}
                    {doneCount > 0 && <span>{doneCount} done</span>}
                  </div>
                  {path.prompt && (
                    <div style={{ fontSize: 9, color: 'var(--pw-text-faint)', marginTop: 4, maxHeight: 40, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {path.prompt.slice(0, 100)}{path.prompt.length > 100 ? '...' : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Convergence chart */}
        {genStats.length > 1 && <ConvergenceChart genStats={genStats} />}

        {/* Generation strips */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {genStats.length === 0 && (
            <div style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 32 }}>
              No generations yet. Create runs or trigger the first generation.
            </div>
          )}

          {genStats.map(({ gen, runs, best, median }) => {
            // Find path name for each run
            const pathMap = new Map(detail.paths.map(p => [p.id, p.name]));
            return (
            <div key={gen} style={{
              background: 'var(--pw-bg-surface)',
              borderRadius: 8,
              border: '1px solid var(--pw-border)',
              padding: '10px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, minWidth: 50 }}>Gen {gen}</span>
                <span style={{ fontSize: 11, color: '#888' }}>
                  {runs.length} runs
                </span>
                {best != null && (
                  <span style={{ fontSize: 11, color: '#4CAF50' }}>
                    best: {best.toFixed(3)}
                  </span>
                )}
                {median != null && (
                  <span style={{ fontSize: 11, color: '#888' }}>
                    median: {median.toFixed(3)}
                  </span>
                )}
                {/* Show path name for each run in multi-path mode */}
                {detail.mode === 'multi-path' && runs.length > 0 && (
                  <span style={{ fontSize: 10, color: 'var(--pw-text-faint)' }}>
                    [{runs.map(r => pathMap.get(r.pathId || '') || '?').join(', ')}]
                  </span>
                )}
              </div>

              {/* Run cells */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {runs.map(run => (
                  <RunCell key={run.id} run={run} detail={detail} />
                ))}
              </div>
            </div>
            );
          })}

          {/* Next generation button */}
          <div style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
            <button
              class="btn btn-sm"
              onClick={() => onNextGen({})}
            >
              Trigger Next Generation
            </button>
          </div>
        </div>
      </div>

      {/* Knowledge panel */}
      {knowledgeOpen && (
        <div style={{
          width: 350,
          flexShrink: 0,
          background: 'var(--pw-bg-surface)',
          borderRadius: 8,
          border: '1px solid var(--pw-border)',
          padding: 12,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            Knowledge File
          </div>
          {knowledge ? (
            <div
              class="sm-result-markdown"
              style={{ flex: 1, fontSize: 12, overflowY: 'auto' }}
              dangerouslySetInnerHTML={{ __html: marked.parse(knowledge) as string }}
            />
          ) : (
            <div style={{ flex: 1, fontSize: 11, color: 'var(--pw-text-muted)' }}>
              (empty — populated after first generation completes)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Convergence Chart (SVG sparkline) ──────────────

function ConvergenceChart({ genStats }: { genStats: { gen: number; best: number | null; median: number | null }[] }) {
  const data = genStats.filter(g => g.best != null) as { gen: number; best: number; median: number | null }[];
  if (data.length < 2) return null;

  const W = 400, H = 80, PAD = 24;
  const minScore = Math.min(...data.map(d => d.best));
  const maxScore = Math.max(...data.map(d => d.best), ...data.filter(d => d.median != null).map(d => d.median!));
  const range = maxScore - minScore || 0.01;

  const x = (i: number) => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + ((v - minScore) / range) * (H - PAD * 2);

  const bestLine = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.best).toFixed(1)}`).join(' ');
  const medianLine = data.filter(d => d.median != null).length > 1
    ? data.map((d, i) => d.median != null ? `${i === 0 || data[i - 1]?.median == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.median!).toFixed(1)}` : '').filter(Boolean).join(' ')
    : '';

  return (
    <div style={{
      background: 'var(--pw-bg-surface)', borderRadius: 8, border: '1px solid var(--pw-border)',
      padding: '8px 12px', marginBottom: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pw-text-muted)', marginBottom: 4 }}>
        Fitness Convergence (lower = better)
        <span style={{ marginLeft: 12, fontWeight: 400, fontSize: 10 }}>
          <span style={{ color: '#4CAF50' }}>--- best</span>
          {medianLine && <span style={{ color: '#FF9800', marginLeft: 8 }}>--- median</span>}
        </span>
      </div>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => {
          const yy = PAD + frac * (H - PAD * 2);
          const val = minScore + frac * range;
          return (
            <g key={frac}>
              <line x1={PAD} y1={yy} x2={W - PAD} y2={yy} stroke="rgba(128,128,128,0.15)" strokeWidth={1} />
              <text x={2} y={yy + 3} fill="var(--pw-text-faint)" fontSize={8}>{val.toFixed(2)}</text>
            </g>
          );
        })}
        {/* Gen labels */}
        {data.map((d, i) => (
          <text key={d.gen} x={x(i)} y={H - 2} fill="var(--pw-text-faint)" fontSize={8} textAnchor="middle">
            {d.gen}
          </text>
        ))}
        {/* Best line */}
        <path d={bestLine} fill="none" stroke="#4CAF50" strokeWidth={2} />
        {data.map((d, i) => (
          <circle key={d.gen} cx={x(i)} cy={y(d.best)} r={3} fill="#4CAF50">
            <title>Gen {d.gen}: best={d.best.toFixed(3)}</title>
          </circle>
        ))}
        {/* Median line */}
        {medianLine && <path d={medianLine} fill="none" stroke="#FF9800" strokeWidth={1.5} strokeDasharray="4,2" />}
      </svg>
    </div>
  );
}

// ─── Image Annotation Overlay ───────────────────────
// Click and drag on an image to select a region, then annotate it.

function ImageAnnotator({
  src,
  onRegionSelect,
}: {
  src: string;
  onRegionSelect: (region: { x: number; y: number; w: number; h: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number; natW: number; natH: number } | null>(null);

  const getRelPos = (e: MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !imgSize) return null;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    // Convert to natural image coordinates
    return { x: Math.round(px * imgSize.natW), y: Math.round(py * imgSize.natH) };
  };

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    const pos = getRelPos(e);
    if (pos) { setStart(pos); setCurrent(pos); setDragging(true); }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    const pos = getRelPos(e);
    if (pos) setCurrent(pos);
  };

  const onMouseUp = () => {
    if (dragging && start && current) {
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const w = Math.abs(current.x - start.x);
      const h = Math.abs(current.y - start.y);
      if (w > 5 && h > 5) {
        onRegionSelect({ x, y, w, h });
      }
    }
    setDragging(false);
    setStart(null);
    setCurrent(null);
  };

  // Compute selection rect in percentage for overlay
  const selRect = start && current && imgSize ? (() => {
    const x1 = Math.min(start.x, current.x) / imgSize.natW * 100;
    const y1 = Math.min(start.y, current.y) / imgSize.natH * 100;
    const w = Math.abs(current.x - start.x) / imgSize.natW * 100;
    const h = Math.abs(current.y - start.y) / imgSize.natH * 100;
    return { left: `${x1}%`, top: `${y1}%`, width: `${w}%`, height: `${h}%` };
  })() : null;

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', cursor: 'crosshair', userSelect: 'none', lineHeight: 0 }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <img
        src={src}
        style={{ width: '100%', height: 'auto', borderRadius: 4, display: 'block' }}
        onLoad={(e) => {
          const img = e.currentTarget as HTMLImageElement;
          setImgSize({ w: img.width, h: img.height, natW: img.naturalWidth, natH: img.naturalHeight });
        }}
        draggable={false}
      />
      {selRect && (
        <div style={{
          position: 'absolute', ...selRect,
          border: '2px solid #f44336',
          background: 'rgba(244,67,54,0.15)',
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
}

// ─── Run Cell (single child in generation strip) ──────

function RunCell({ run, detail }: { run: SwarmRun; detail: SwarmDetail }) {
  const [expanded, setExpanded] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedScreenshot, setSelectedScreenshot] = useState(0);
  const [annotationRegion, setAnnotationRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const isDimmed = run.survived === false;
  const isSurvivor = run.survived === true;

  const targetUrl = `/api/v1/admin/wiggum/swarms/${detail.id}/target`;
  const latestScreenshot = run.screenshots.length > 0
    ? run.screenshots[Math.min(selectedScreenshot, run.screenshots.length - 1)]
    : null;
  const screenshotUrl = latestScreenshot
    ? (latestScreenshot.url || `/api/v1/admin/wiggum/${run.id}/screenshots/${latestScreenshot.id}`)
    : null;

  const submitFeedback = async (rating: number) => {
    try {
      await api.submitSwarmFeedback(detail.id, {
        runId: run.id,
        generation: run.generation ?? undefined,
        rating,
        annotation: feedbackText || undefined,
        ...(annotationRegion ? {
          regionX: annotationRegion.x,
          regionY: annotationRegion.y,
          regionW: annotationRegion.w,
          regionH: annotationRegion.h,
        } : {}),
        screenshotRef: latestScreenshot?.filename || latestScreenshot?.id || undefined,
      });
      setFeedbackRating(rating);
      setShowFeedback(false);
      setFeedbackText('');
      setAnnotationRegion(null);
    } catch { /* ignore */ }
  };

  // Parse fitness detail for sub-score display
  const fitnessDetail = useMemo(() => {
    try { return run.fitnessDetail ? JSON.parse(run.fitnessDetail) : null; }
    catch { return null; }
  }, [run.fitnessDetail]);

  // Path name for this run
  const pathName = useMemo(() => {
    if (!run.pathId) return null;
    return detail.paths.find(p => p.id === run.pathId)?.name || null;
  }, [run.pathId, detail.paths]);

  return (
    <div
      style={{
        width: expanded ? '100%' : 90,
        minHeight: 60,
        background: isDimmed ? 'rgba(100,100,100,0.15)' : isSurvivor ? 'rgba(76,175,80,0.1)' : 'var(--pw-bg-raised)',
        borderRadius: 6,
        border: `1px solid ${isSurvivor ? 'rgba(76,175,80,0.4)' : isDimmed ? 'rgba(100,100,100,0.3)' : 'var(--pw-border)'}`,
        padding: 6,
        cursor: 'pointer',
        opacity: isDimmed ? 0.5 : 1,
        transition: 'all 0.2s',
      }}
      onClick={() => { if (!expanded) setExpanded(true); }}
      title={`${run.id.slice(-8)} | ${run.status} | score: ${run.fitnessScore ?? '?'}`}
    >
      {/* Compact header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: STATUS_COLORS[run.status] || '#888',
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--pw-text-faint)' }}>
          {pathName ? pathName : run.id.slice(-6)}
        </span>
        {isSurvivor && <span style={{ fontSize: 8, color: '#4CAF50' }}>&#x2713;</span>}
        {expanded && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
            style={{
              marginLeft: 'auto', fontSize: 10, cursor: 'pointer', padding: '1px 5px',
              background: 'transparent', border: '1px solid var(--pw-border)', borderRadius: 3,
              color: 'var(--pw-text-muted)',
            }}
          >
            Collapse
          </button>
        )}
      </div>

      {/* Fitness score + sub-scores */}
      {run.fitnessScore != null && (
        <div style={{ textAlign: expanded ? 'left' : 'center', marginBottom: expanded ? 8 : 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--pw-text)' }}>
            {run.fitnessScore.toFixed(3)}
          </div>
          {expanded && fitnessDetail && (
            <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--pw-text-muted)', marginTop: 2 }}>
              {fitnessDetail.ssim != null && <span>SSIM: {fitnessDetail.ssim.toFixed(3)}</span>}
              {fitnessDetail.edge_iou != null && <span>Edge: {fitnessDetail.edge_iou.toFixed(3)}</span>}
              {fitnessDetail.hist_corr != null && <span>Hist: {fitnessDetail.hist_corr.toFixed(3)}</span>}
              {fitnessDetail.pixel_mean != null && <span>Px: {fitnessDetail.pixel_mean.toFixed(1)}</span>}
            </div>
          )}
        </div>
      )}

      {!expanded && (
        <div style={{ fontSize: 9, color: 'var(--pw-text-faint)', textAlign: 'center' }}>
          {run.currentIteration}/{run.maxIterations}
        </div>
      )}

      {/* Expanded view */}
      {expanded && (
        <div style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
          {/* Session links */}
          {(() => {
            const sids: string[] = [];
            if (run.sessionId) sids.push(run.sessionId);
            for (const iter of run.iterations) {
              if (iter.sessionId && !sids.includes(iter.sessionId)) sids.push(iter.sessionId);
            }
            if (sids.length === 0) return null;
            return (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {sids.map((sid, i) => (
                  <div key={sid} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <a
                      href={`#/sessions/${sid}`}
                      onClick={(e) => { e.preventDefault(); openSession(sid); }}
                      style={{ fontSize: 10, color: '#64B5F6', textDecoration: 'none', fontFamily: 'monospace' }}
                    >
                      {sids.length > 1 ? `#${i}` : ''} {sid.slice(-8)}
                    </a>
                    <button
                      onClick={() => { openSessionLogDrawer(sid); }}
                      style={{
                        fontSize: 9, padding: '1px 4px', background: 'rgba(100,181,246,0.15)',
                        border: '1px solid rgba(100,181,246,0.3)', borderRadius: 3,
                        color: '#64B5F6', cursor: 'pointer',
                      }}
                    >
                      JSONL
                    </button>
                  </div>
                ))}
                <span style={{ fontSize: 10, color: 'var(--pw-text-faint)' }}>
                  iter: {run.currentIteration}/{run.maxIterations}
                </span>
              </div>
            );
          })()}

          {/* Side-by-side comparison toggle */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            <button
              onClick={() => setCompareMode(!compareMode)}
              style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                background: compareMode ? 'rgba(124,58,237,0.2)' : 'transparent',
                border: `1px solid ${compareMode ? '#7c3aed' : 'var(--pw-border)'}`,
                color: compareMode ? '#7c3aed' : 'var(--pw-text-muted)',
              }}
            >
              {compareMode ? 'Hide Comparison' : 'Compare with Target'}
            </button>
            {run.screenshots.length > 1 && (
              <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                <button
                  onClick={() => setSelectedScreenshot(Math.max(0, selectedScreenshot - 1))}
                  disabled={selectedScreenshot === 0}
                  style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', border: '1px solid var(--pw-border)', borderRadius: 3, background: 'transparent', color: 'var(--pw-text)' }}
                >
                  &lt;
                </button>
                <span style={{ fontSize: 10, color: 'var(--pw-text-muted)', minWidth: 40, textAlign: 'center' }}>
                  {selectedScreenshot + 1}/{run.screenshots.length}
                </span>
                <button
                  onClick={() => setSelectedScreenshot(Math.min(run.screenshots.length - 1, selectedScreenshot + 1))}
                  disabled={selectedScreenshot >= run.screenshots.length - 1}
                  style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', border: '1px solid var(--pw-border)', borderRadius: 3, background: 'transparent', color: 'var(--pw-text)' }}
                >
                  &gt;
                </button>
              </div>
            )}
            {/* Live preview link */}
            {(() => {
              try {
                const knobs = run.knobs ? JSON.parse(run.knobs) : null;
                if (knobs?.port) {
                  return (
                    <a
                      href={`http://localhost:${knobs.port}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 10, color: '#64B5F6', marginLeft: 'auto' }}
                    >
                      Preview :{knobs.port}
                    </a>
                  );
                }
              } catch { /* ignore */ }
              return null;
            })()}
          </div>

          {/* Side-by-side: Target vs Result */}
          {compareMode && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--pw-text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
                  Target
                </div>
                <img
                  src={targetUrl}
                  style={{ width: '100%', height: 'auto', borderRadius: 4, border: '2px solid rgba(124,58,237,0.4)' }}
                  loading="lazy"
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--pw-text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
                  Result {latestScreenshot?.filename && `(${latestScreenshot.filename})`}
                </div>
                {screenshotUrl ? (
                  <ImageAnnotator
                    src={screenshotUrl}
                    onRegionSelect={(region) => {
                      setAnnotationRegion(region);
                      setShowFeedback(true);
                    }}
                  />
                ) : (
                  <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 11, background: 'var(--pw-bg-raised)', borderRadius: 4 }}>
                    No screenshots yet
                  </div>
                )}
                {annotationRegion && (
                  <div style={{ fontSize: 9, color: '#f44336', marginTop: 2 }}>
                    Region selected: [{annotationRegion.x}, {annotationRegion.y}, {annotationRegion.w}, {annotationRegion.h}]
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Screenshot filmstrip (when not in compare mode) */}
          {!compareMode && run.screenshots.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {run.screenshots.map((ss: any, i: number) => (
                <img
                  key={ss.id}
                  src={ss.url || `/api/v1/admin/wiggum/${run.id}/screenshots/${ss.id}`}
                  style={{
                    width: 100, height: 66, objectFit: 'cover', borderRadius: 4,
                    border: `2px solid ${i === selectedScreenshot ? '#7c3aed' : 'var(--pw-border)'}`,
                    cursor: 'pointer', opacity: i === selectedScreenshot ? 1 : 0.6,
                  }}
                  loading="lazy"
                  title={ss.filename || ss.id}
                  onClick={() => setSelectedScreenshot(i)}
                />
              ))}
            </div>
          )}

          {!compareMode && run.screenshots.length === 0 && (
            <span style={{ fontSize: 10, color: '#888', display: 'block', marginBottom: 8 }}>No screenshots</span>
          )}

          {run.knobs && (
            <div style={{ fontSize: 9, color: '#888', marginBottom: 6 }}>
              knobs: {run.knobs}
            </div>
          )}

          {/* Feedback controls */}
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center',
            borderTop: '1px solid var(--pw-border)', paddingTop: 6,
          }}>
            <button
              onClick={() => submitFeedback(1)}
              style={{
                fontSize: 14, cursor: 'pointer', padding: '2px 8px', borderRadius: 4,
                background: feedbackRating === 1 ? 'rgba(76,175,80,0.3)' : 'transparent',
                border: '1px solid rgba(76,175,80,0.4)', color: '#4CAF50',
              }}
              title="Good result"
            >
              +
            </button>
            <button
              onClick={() => submitFeedback(-1)}
              style={{
                fontSize: 14, cursor: 'pointer', padding: '2px 8px', borderRadius: 4,
                background: feedbackRating === -1 ? 'rgba(244,67,54,0.3)' : 'transparent',
                border: '1px solid rgba(244,67,54,0.4)', color: '#f44336',
              }}
              title="Bad result"
            >
              -
            </button>
            <button
              onClick={() => setShowFeedback(!showFeedback)}
              style={{
                fontSize: 10, cursor: 'pointer', padding: '2px 8px', borderRadius: 4,
                background: showFeedback ? 'rgba(124,58,237,0.15)' : 'transparent',
                border: `1px solid ${showFeedback ? '#7c3aed' : 'var(--pw-border)'}`,
                color: showFeedback ? '#7c3aed' : 'var(--pw-text-muted)',
              }}
            >
              Annotate
            </button>
            {feedbackRating != null && (
              <span style={{ fontSize: 10, color: feedbackRating === 1 ? '#4CAF50' : '#f44336' }}>
                {feedbackRating === 1 ? 'Marked good' : 'Marked bad'}
              </span>
            )}
          </div>

          {/* Annotation form */}
          {showFeedback && (
            <div style={{ marginTop: 6 }}>
              {annotationRegion && (
                <div style={{
                  fontSize: 10, padding: '4px 8px', marginBottom: 4, borderRadius: 4,
                  background: 'rgba(244,67,54,0.1)', border: '1px solid rgba(244,67,54,0.3)', color: '#f44336',
                }}>
                  Region: [{annotationRegion.x}, {annotationRegion.y}] {annotationRegion.w}x{annotationRegion.h}px
                  <button
                    onClick={() => setAnnotationRegion(null)}
                    style={{ marginLeft: 8, fontSize: 9, cursor: 'pointer', background: 'transparent', border: 'none', color: '#f44336', textDecoration: 'underline' }}
                  >
                    clear
                  </button>
                </div>
              )}
              {!annotationRegion && compareMode && (
                <div style={{ fontSize: 10, color: 'var(--pw-text-faint)', marginBottom: 4 }}>
                  Tip: Click and drag on the result image to select a region
                </div>
              )}
              <textarea
                value={feedbackText}
                onInput={(e) => setFeedbackText((e.target as HTMLTextAreaElement).value)}
                placeholder="What's wrong or right? (e.g., 'horn curves too wide', 'port color is correct')"
                style={{
                  width: '100%', minHeight: 50, padding: 6, fontSize: 11, borderRadius: 4,
                  border: '1px solid var(--pw-border)', background: 'var(--pw-bg-raised)', color: 'var(--pw-text)',
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button class="btn btn-sm" style={{ fontSize: 10, background: '#4CAF50', color: '#fff' }} onClick={() => submitFeedback(1)}>
                  Good
                </button>
                <button class="btn btn-sm" style={{ fontSize: 10, background: '#f44336', color: '#fff' }} onClick={() => submitFeedback(-1)}>
                  Bad
                </button>
                <button class="btn btn-sm" style={{ fontSize: 10 }} onClick={() => submitFeedback(0)}>
                  Neutral
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
