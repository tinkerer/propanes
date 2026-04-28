import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  cosLearnings,
  cosLearningsLoading,
  loadCosLearnings,
  deleteCosLearning,
  type CosLearning,
  type CosLearningGraph,
  cosLearningGraph,
  cosLearningGraphLoading,
  loadCosLearningGraph,
  wiggumAnnouncement,
} from '../lib/cos-learnings.js';
import {
  type LearningsView,
  LEARNING_TYPE_LABELS,
  LEARNING_TYPE_ORDER,
  LEARNING_TYPE_COLOR,
  REL_TYPE_LABELS,
  REL_TYPE_COLOR,
} from '../lib/cos-learnings-constants.js';
import { LearningDetailView } from './LearningDetail.js';


export function LearningsPanel({ onClose }: { onClose: () => void }) {
  const items = cosLearnings.value;
  const loading = cosLearningsLoading.value;
  const graph = cosLearningGraph.value;
  const graphLoading = cosLearningGraphLoading.value;
  const announcement = wiggumAnnouncement.value;

  const [view, setView] = useState<LearningsView>('list');
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    void loadCosLearnings();
  }, []);

  // Lazy-load graph the first time the user flips to graph view, and again
  // whenever the underlying list changes (so a new learning shows up).
  useEffect(() => {
    if (view === 'graph') void loadCosLearningGraph();
  }, [view, items.length]);

  const grouped = useMemo(() => {
    const out: Record<CosLearning['type'], CosLearning[]> = {
      pitfall: [],
      suggestion: [],
      tool_gap: [],
    };
    for (const l of items) {
      if (out[l.type]) out[l.type].push(l);
    }
    return out;
  }, [items]);

  const refreshAll = useCallback(() => {
    void loadCosLearnings();
    if (view === 'graph') void loadCosLearningGraph();
  }, [view]);

  if (detailId) {
    return (
      <LearningDetailView
        id={detailId}
        allLearnings={items}
        onBack={() => setDetailId(null)}
        onClose={onClose}
        onOpenPeer={(peerId) => setDetailId(peerId)}
        onChanged={refreshAll}
      />
    );
  }

  return (
    <div class="cos-learnings-panel">
      <div class="cos-learnings-header">
        <span class="cos-learnings-title">Wiggum learnings</span>
        <div class="cos-view-segmented" role="radiogroup" aria-label="Learnings view">
          {(['list', 'graph'] as LearningsView[]).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              class={`cos-view-seg${view === v ? ' cos-view-seg-active' : ''}`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <button class="cos-link-btn" onClick={refreshAll} title="Reload">
          {loading || graphLoading ? 'loading…' : 'refresh'}
        </button>
        <button class="cos-link-btn" onClick={onClose} aria-label="Close">close</button>
      </div>
      {announcement && (
        <div class="cos-learnings-announce" title={`Posted ${new Date(announcement.at).toLocaleString()}`}>
          <span class="cos-learnings-announce-label">Latest reflection:</span> {announcement.summary}
        </div>
      )}
      {items.length === 0 && !loading && (
        <div class="cos-learnings-empty">No learnings yet. Wiggum reflects after each CoS session closes.</div>
      )}
      {view === 'list'
        ? <LearningsListView grouped={grouped} onOpen={setDetailId} />
        : <LearningsGraphView graph={graph} loading={graphLoading} onOpen={setDetailId} />}
    </div>
  );
}

function LearningsListView({
  grouped,
  onOpen,
}: {
  grouped: Record<CosLearning['type'], CosLearning[]>;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {LEARNING_TYPE_ORDER.map((type) => {
        const group = grouped[type];
        if (!group || group.length === 0) return null;
        return (
          <div key={type} class="cos-learnings-group">
            <div class="cos-learnings-group-title">
              {LEARNING_TYPE_LABELS[type]} <span class="cos-muted">({group.length})</span>
            </div>
            {group.map((l) => (
              <div key={l.id} class={`cos-learning cos-learning-sev-${l.severity}`}>
                <div class="cos-learning-row">
                  <span
                    class={`cos-learning-dot cos-learning-dot-${l.severity}`}
                    title={`severity: ${l.severity}`}
                    aria-label={`severity ${l.severity}`}
                  />
                  <button
                    type="button"
                    class="cos-learning-title cos-learning-title-btn"
                    onClick={() => onOpen(l.id)}
                    title="Open detail"
                  >
                    {l.title}
                  </button>
                  <button
                    class="cos-link-btn cos-danger-text"
                    onClick={(e) => { e.stopPropagation(); void deleteCosLearning(l.id); }}
                    title="Dismiss"
                    aria-label="Dismiss learning"
                  >
                    ×
                  </button>
                </div>
                {(l.tags?.length ?? 0) > 0 && (
                  <div class="cos-learning-tags">
                    {l.tags!.map((t) => <span key={t} class="cos-learning-tag">#{t}</span>)}
                  </div>
                )}
                {l.body && <div class="cos-learning-body">{l.body}</div>}
                {l.sessionJsonl && (
                  <div class="cos-learning-source" title={l.sessionJsonl}>
                    {l.sessionJsonl.split('/').pop()}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

// Tiny force-directed layout. Runs once per (nodes,edges) signature, freezes
// after a fixed number of ticks so the SVG stays static. Not a real physics
// sim — just enough to keep nodes from overlapping and pull related nodes
// closer. Bounded at 80 nodes; beyond that the UI tells the user to filter.
function computeGraphLayout(
  nodes: CosLearning[],
  edges: CosLearningGraph['edges'],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.35;
  // Seed deterministically so the layout doesn't shuffle on every render.
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    positions.set(n.id, {
      x: cx + r * Math.cos(angle) + (rand() - 0.5) * 10,
      y: cy + r * Math.sin(angle) + (rand() - 0.5) * 10,
      vx: 0,
      vy: 0,
    });
  });
  const ticks = nodes.length <= 30 ? 250 : 150;
  const targetEdgeLen = Math.max(60, Math.min(120, 300 / Math.sqrt(Math.max(nodes.length, 1))));
  for (let t = 0; t < ticks; t++) {
    // Repulsion (Coulomb-ish)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) { dx = rand(); dy = rand(); dist = 1; }
        const force = 1200 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Spring on edges
    for (const e of edges) {
      const a = positions.get(e.fromId);
      const b = positions.get(e.toId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - targetEdgeLen) * 0.08;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Centering
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      p.vx += (cx - p.x) * 0.01;
      p.vy += (cy - p.y) * 0.01;
    }
    // Integrate with damping; clamp to viewport
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x += p.vx;
      p.y += p.vy;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of positions) out.set(id, { x: p.x, y: p.y });
  return out;
}

function LearningsGraphView({
  graph,
  loading,
  onOpen,
}: {
  graph: CosLearningGraph | null;
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const width = 560;
  const height = 420;
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Memoize layout against node/edge identity so re-renders don't re-simulate.
  const layoutKey = useMemo(() => {
    if (!graph) return '';
    return [
      graph.nodes.length,
      graph.edges.length,
      graph.nodes.map((n) => n.id).join(','),
      graph.edges.map((e) => e.id).join(','),
    ].join('|');
  }, [graph]);
  const positions = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return new Map<string, { x: number; y: number }>();
    return computeGraphLayout(graph.nodes, graph.edges, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  if (loading && !graph) {
    return <div class="cos-learnings-empty">Loading graph…</div>;
  }
  if (!graph || graph.nodes.length === 0) {
    return <div class="cos-learnings-empty">No learnings to graph yet.</div>;
  }

  return (
    <div class="cos-learnings-graph-wrap">
      <div class="cos-learnings-graph-legend">
        {LEARNING_TYPE_ORDER.map((t) => (
          <span key={t} class="cos-learnings-graph-legend-item">
            <span class="cos-learnings-graph-legend-dot" style={{ background: LEARNING_TYPE_COLOR[t] }} />
            {LEARNING_TYPE_LABELS[t]}
          </span>
        ))}
        <span class="cos-muted">— click a node to open</span>
      </div>
      <svg
        class="cos-learnings-graph-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Learnings knowledge graph"
      >
        <defs>
          <marker id="cos-graph-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#9ca3af" />
          </marker>
        </defs>
        {graph.edges.map((e) => {
          const a = positions.get(e.fromId);
          const b = positions.get(e.toId);
          if (!a || !b) return null;
          const isHover = hoverId !== null && (e.fromId === hoverId || e.toId === hoverId);
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={REL_TYPE_COLOR[e.relType]}
              stroke-width={isHover ? 2 : 1}
              stroke-opacity={hoverId && !isHover ? 0.18 : 0.7}
              stroke-dasharray={e.relType === 'duplicate_of' ? '4 3' : undefined}
              marker-end="url(#cos-graph-arrow)"
            >
              <title>{`${REL_TYPE_LABELS[e.relType]}${e.source === 'auto' ? ' (auto)' : ''}`}</title>
            </line>
          );
        })}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const isHover = hoverId === n.id;
          const radius = n.severity === 'high' ? 9 : n.severity === 'medium' ? 7 : 5;
          return (
            <g
              key={n.id}
              class="cos-learnings-graph-node"
              transform={`translate(${p.x}, ${p.y})`}
              onMouseEnter={() => setHoverId(n.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === n.id ? null : cur))}
              onClick={() => onOpen(n.id)}
            >
              <circle
                r={radius}
                fill={LEARNING_TYPE_COLOR[n.type]}
                stroke={isHover ? '#fff' : 'rgba(0,0,0,0.4)'}
                stroke-width={isHover ? 2 : 1}
              >
                <title>{`${n.title} — ${n.type} / ${n.severity}`}</title>
              </circle>
              {isHover && (
                <text
                  x={radius + 4}
                  y={4}
                  fill="var(--pw-text-primary)"
                  font-size="11"
                  style={{ pointerEvents: 'none' }}
                >
                  {n.title.length > 40 ? n.title.slice(0, 38) + '…' : n.title}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

