import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  type CosLearning,
  type CosLearningRelType,
  type CosLearningDetail,
  type CosLearningLinkPeer,
  type CosLearningSuggestion,
  deleteCosLearning,
  fetchCosLearningDetail,
  fetchCosLearningSuggestions,
  createCosLearningLink,
  deleteCosLearningLink,
  updateCosLearning,
} from '../lib/cos-learnings.js';
import {
  LEARNING_TYPE_COLOR,
  REL_TYPE_LABELS,
  REL_TYPE_COLOR,
} from '../lib/cos-learnings-constants.js';

export function LearningDetailView({
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
