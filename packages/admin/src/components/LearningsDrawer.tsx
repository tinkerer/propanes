import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  cosLearnings,
  cosLearningsLoading,
  loadCosLearnings,
  deleteCosLearning,
  type CosLearning,
  type CosLearningRelType,
  type CosLearningGraph,
  type CosLearningDetail,
  type CosLearningLinkPeer,
  type CosLearningSuggestion,
  cosLearningGraph,
  cosLearningGraphLoading,
  loadCosLearningGraph,
  fetchCosLearningDetail,
  fetchCosLearningSuggestions,
  createCosLearningLink,
  deleteCosLearningLink,
  updateCosLearning,
  wiggumAnnouncement,
} from '../lib/cos-learnings.js';

type LearningsView = 'list' | 'graph';

const LEARNING_TYPE_LABELS: Record<CosLearning['type'], string> = {
  pitfall: 'Pitfalls',
  suggestion: 'Suggestions',
  tool_gap: 'Tool gaps',
};

const LEARNING_TYPE_ORDER: CosLearning['type'][] = ['pitfall', 'suggestion', 'tool_gap'];

const LEARNING_TYPE_COLOR: Record<CosLearning['type'], string> = {
  pitfall: '#e5484d',
  suggestion: '#3e63dd',
  tool_gap: '#d97706',
};

const REL_TYPE_LABELS: Record<CosLearningRelType, string> = {
  related: 'related',
  caused_by: 'caused by',
  resolved_by: 'resolved by',
  duplicate_of: 'duplicate of',
};

const REL_TYPE_COLOR: Record<CosLearningRelType, string> = {
  related: '#9ca3af',
  caused_by: '#e5484d',
  resolved_by: '#22c55e',
  duplicate_of: '#a855f7',
};

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

function LearningDetailView({
  id,
  allLearnings,
  onBack,
  onClose,
  onOpenPeer,
  onChanged,
}: {
  id: string;
  allLearnings: CosLearning[];
  onBack: () => void;
  onClose: () => void;
  onOpenPeer: (peerId: string) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CosLearningDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<CosLearningSuggestion[]>([]);
  const [tagsEdit, setTagsEdit] = useState<string | null>(null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [linkPickerFor, setLinkPickerFor] = useState<CosLearningRelType | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [d, s] = await Promise.all([
        fetchCosLearningDetail(id),
        fetchCosLearningSuggestions(id),
      ]);
      setDetail(d);
      setSuggestions(s);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    setTagsEdit(null);
    setBodyEdit(null);
    setTitleEdit(null);
    setLinkPickerFor(null);
  }, [id, refresh]);

  const handleSaveTags = async () => {
    if (tagsEdit === null) return;
    const tags = tagsEdit.split(',').map((t) => t.trim()).filter(Boolean);
    await updateCosLearning(id, { tags });
    setTagsEdit(null);
    await refresh();
    onChanged();
  };

  const handleSaveBody = async () => {
    if (bodyEdit === null) return;
    await updateCosLearning(id, { body: bodyEdit });
    setBodyEdit(null);
    await refresh();
    onChanged();
  };

  const handleSaveTitle = async () => {
    if (titleEdit === null) return;
    const t = titleEdit.trim();
    if (!t) { setTitleEdit(null); return; }
    await updateCosLearning(id, { title: t });
    setTitleEdit(null);
    await refresh();
    onChanged();
  };

  const handleSeverity = async (sev: CosLearning['severity']) => {
    await updateCosLearning(id, { severity: sev });
    await refresh();
    onChanged();
  };

  const handleAddLink = async (peerId: string, relType: CosLearningRelType) => {
    await createCosLearningLink(id, peerId, relType);
    setLinkPickerFor(null);
    await refresh();
    onChanged();
  };

  const handleDeleteLink = async (linkId: string) => {
    await deleteCosLearningLink(linkId);
    await refresh();
    onChanged();
  };

  const handleDeleteLearning = async () => {
    await deleteCosLearning(id);
    onChanged();
    onBack();
  };

  if (!detail) {
    return (
      <div class="cos-learnings-panel">
        <div class="cos-learnings-header">
          <button class="cos-link-btn" onClick={onBack}>← back</button>
          <span class="cos-learnings-title">{loading ? 'Loading…' : 'Not found'}</span>
          <button class="cos-link-btn" onClick={onClose} aria-label="Close">close</button>
        </div>
      </div>
    );
  }

  const l = detail.learning;
  const existingPeerIds = new Set<string>([
    ...detail.outgoing.map((x) => x.peer?.id).filter(Boolean) as string[],
    ...detail.backlinks.map((x) => x.peer?.id).filter(Boolean) as string[],
    id,
  ]);

  return (
    <div class="cos-learnings-panel cos-learning-detail">
      <div class="cos-learnings-header">
        <button class="cos-link-btn" onClick={onBack}>← back</button>
        <span class="cos-learnings-title cos-learning-detail-title-host">
          {titleEdit === null ? (
            <button
              type="button"
              class="cos-learning-title-btn"
              onClick={() => setTitleEdit(l.title)}
              title="Edit title"
            >
              {l.title}
            </button>
          ) : (
            <span class="cos-inline-edit">
              <input
                class="cos-inline-input"
                value={titleEdit}
                onInput={(e) => setTitleEdit((e.target as HTMLInputElement).value)}
                autoFocus
              />
              <button class="cos-link-btn" onClick={() => void handleSaveTitle()}>save</button>
              <button class="cos-link-btn" onClick={() => setTitleEdit(null)}>cancel</button>
            </span>
          )}
        </span>
        <button class="cos-link-btn" onClick={() => void refresh()}>{loading ? 'loading…' : 'refresh'}</button>
        <button class="cos-link-btn" onClick={onClose} aria-label="Close">close</button>
      </div>

      <div class="cos-learning-detail-meta">
        <span class="cos-learning-badge" style={{ background: LEARNING_TYPE_COLOR[l.type] }}>{l.type}</span>
        <div class="cos-view-segmented" role="radiogroup" aria-label="Severity">
          {(['low', 'medium', 'high'] as CosLearning['severity'][]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={l.severity === s}
              class={`cos-view-seg${l.severity === s ? ' cos-view-seg-active' : ''}`}
              onClick={() => void handleSeverity(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <span class="cos-muted" title={new Date(l.createdAt).toLocaleString()}>
          {new Date(l.createdAt).toLocaleDateString()}
        </span>
        <button
          class="cos-link-btn cos-danger-text"
          onClick={() => void handleDeleteLearning()}
          title="Delete this learning"
        >
          delete
        </button>
      </div>

      {l.sessionJsonl && (
        <div class="cos-learning-source" title={l.sessionJsonl}>
          source: {l.sessionJsonl.split('/').pop()}
        </div>
      )}

      <div class="cos-learning-detail-section">
        <div class="cos-learning-detail-section-head">
          <span class="cos-learning-detail-section-title">Tags</span>
          {tagsEdit === null
            ? <button class="cos-link-btn" onClick={() => setTagsEdit(l.tags.join(', '))}>edit</button>
            : (
              <span class="cos-inline-actions">
                <button class="cos-link-btn" onClick={() => void handleSaveTags()}>save</button>
                <button class="cos-link-btn" onClick={() => setTagsEdit(null)}>cancel</button>
              </span>
            )}
        </div>
        {tagsEdit === null ? (
          <div class="cos-learning-tags">
            {(l.tags?.length ?? 0) === 0
              ? <span class="cos-muted">no tags</span>
              : l.tags!.map((t) => <span key={t} class="cos-learning-tag">#{t}</span>)}
          </div>
        ) : (
          <input
            class="cos-inline-input"
            placeholder="comma, separated, tags"
            value={tagsEdit}
            onInput={(e) => setTagsEdit((e.target as HTMLInputElement).value)}
            autoFocus
          />
        )}
      </div>

      <div class="cos-learning-detail-section">
        <div class="cos-learning-detail-section-head">
          <span class="cos-learning-detail-section-title">Body</span>
          {bodyEdit === null
            ? <button class="cos-link-btn" onClick={() => setBodyEdit(l.body)}>edit</button>
            : (
              <span class="cos-inline-actions">
                <button class="cos-link-btn" onClick={() => void handleSaveBody()}>save</button>
                <button class="cos-link-btn" onClick={() => setBodyEdit(null)}>cancel</button>
              </span>
            )}
        </div>
        {bodyEdit === null ? (
          <div class="cos-learning-body cos-learning-detail-body">
            {l.body || <span class="cos-muted">no body</span>}
          </div>
        ) : (
          <textarea
            class="cos-prompt-textarea"
            rows={6}
            value={bodyEdit}
            onInput={(e) => setBodyEdit((e.target as HTMLTextAreaElement).value)}
            autoFocus
          />
        )}
      </div>

      <LearningLinksSection
        title="Outgoing links"
        links={detail.outgoing}
        emptyText="no outgoing links"
        onOpen={onOpenPeer}
        onDelete={(linkId) => void handleDeleteLink(linkId)}
        onAdd={(rel) => setLinkPickerFor(rel)}
      />

      <LearningLinksSection
        title="Backlinks"
        links={detail.backlinks}
        emptyText="no backlinks"
        onOpen={onOpenPeer}
        backlinks
      />

      {suggestions.length > 0 && (
        <div class="cos-learning-detail-section">
          <div class="cos-learning-detail-section-head">
            <span class="cos-learning-detail-section-title">Suggested links</span>
            <span class="cos-muted">based on text overlap</span>
          </div>
          <div class="cos-learning-suggestions">
            {suggestions.map((s) => (
              <div key={s.peer.id} class="cos-learning-suggestion">
                <span
                  class="cos-learning-dot"
                  style={{ background: LEARNING_TYPE_COLOR[s.peer.type] }}
                  title={s.peer.type}
                />
                <button
                  type="button"
                  class="cos-learning-title-btn"
                  onClick={() => onOpenPeer(s.peer.id)}
                >
                  {s.peer.title}
                </button>
                <span class="cos-muted">{Math.round(s.similarity * 100)}%</span>
                <span class="cos-inline-actions">
                  {(['related', 'duplicate_of', 'caused_by', 'resolved_by'] as CosLearningRelType[]).map((rel) => (
                    <button
                      key={rel}
                      class="cos-link-btn"
                      onClick={() => void handleAddLink(s.peer.id, rel)}
                      title={`Link as "${REL_TYPE_LABELS[rel]}"`}
                    >
                      +{REL_TYPE_LABELS[rel]}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {linkPickerFor !== null && (
        <LearningLinkPicker
          allLearnings={allLearnings}
          excludeIds={existingPeerIds}
          relType={linkPickerFor}
          onPick={(peerId, rel) => void handleAddLink(peerId, rel)}
          onCancel={() => setLinkPickerFor(null)}
        />
      )}
    </div>
  );
}

function LearningLinksSection({
  title,
  links,
  emptyText,
  onOpen,
  onDelete,
  onAdd,
  backlinks,
}: {
  title: string;
  links: CosLearningLinkPeer[];
  emptyText: string;
  onOpen: (peerId: string) => void;
  onDelete?: (linkId: string) => void;
  onAdd?: (rel: CosLearningRelType) => void;
  backlinks?: boolean;
}) {
  return (
    <div class="cos-learning-detail-section">
      <div class="cos-learning-detail-section-head">
        <span class="cos-learning-detail-section-title">{title}</span>
        {onAdd && (
          <span class="cos-inline-actions">
            {(['related', 'caused_by', 'resolved_by', 'duplicate_of'] as CosLearningRelType[]).map((rel) => (
              <button
                key={rel}
                class="cos-link-btn"
                onClick={() => onAdd(rel)}
                title={`Add a "${REL_TYPE_LABELS[rel]}" link`}
              >
                +{REL_TYPE_LABELS[rel]}
              </button>
            ))}
          </span>
        )}
      </div>
      {links.length === 0 ? (
        <div class="cos-muted cos-learning-empty-row">{emptyText}</div>
      ) : (
        <div class="cos-learning-links">
          {links.map((lp) => (
            <div key={lp.linkId} class="cos-learning-link-row">
              <span
                class="cos-learning-link-rel"
                style={{ color: REL_TYPE_COLOR[lp.relType] }}
                title={lp.source === 'auto' ? 'auto-suggested' : lp.source}
              >
                {backlinks ? '←' : '→'} {REL_TYPE_LABELS[lp.relType]}
                {lp.source !== 'user' && <span class="cos-muted"> ({lp.source})</span>}
              </span>
              {lp.peer ? (
                <button
                  type="button"
                  class="cos-learning-title-btn"
                  onClick={() => onOpen(lp.peer!.id)}
                >
                  {lp.peer.title}
                </button>
              ) : (
                <span class="cos-muted">[deleted learning]</span>
              )}
              {onDelete && (
                <button
                  class="cos-link-btn cos-danger-text"
                  onClick={() => onDelete(lp.linkId)}
                  title="Remove this link"
                  aria-label="Remove link"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LearningLinkPicker({
  allLearnings,
  excludeIds,
  relType,
  onPick,
  onCancel,
}: {
  allLearnings: CosLearning[];
  excludeIds: Set<string>;
  relType: CosLearningRelType;
  onPick: (peerId: string, rel: CosLearningRelType) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState('');
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allLearnings
      .filter((l) => !excludeIds.has(l.id))
      .filter((l) => !q || l.title.toLowerCase().includes(q) || l.body.toLowerCase().includes(q))
      .slice(0, 50);
  }, [allLearnings, excludeIds, filter]);
  return (
    <div class="cos-learning-link-picker">
      <div class="cos-learning-link-picker-head">
        <span>Pick a learning to link as <strong>{REL_TYPE_LABELS[relType]}</strong></span>
        <button class="cos-link-btn" onClick={onCancel}>cancel</button>
      </div>
      <input
        class="cos-inline-input"
        placeholder="Filter by title or body…"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        autoFocus
      />
      <div class="cos-learning-link-picker-list">
        {candidates.length === 0
          ? <div class="cos-muted">No matches.</div>
          : candidates.map((l) => (
              <button
                key={l.id}
                type="button"
                class="cos-learning-link-picker-row"
                onClick={() => onPick(l.id, relType)}
              >
                <span
                  class="cos-learning-dot"
                  style={{ background: LEARNING_TYPE_COLOR[l.type] }}
                  title={l.type}
                />
                <span class="cos-learning-link-picker-title">{l.title}</span>
                <span class="cos-muted">{l.severity}</span>
              </button>
            ))}
      </div>
    </div>
  );
}
