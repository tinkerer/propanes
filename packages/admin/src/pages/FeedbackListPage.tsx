import { useSignal, useSignalEffect } from '@preact/signals';
import { useEffect, useRef, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { currentRoute, navigate } from '../lib/state.js';
import { openSession, sessionInputStates, openFeedbackItem, feedbackTitleCache } from '../lib/sessions.js';
import { openDispatchDialog, dispatchDialogResult } from '../components/DispatchDialog.js';
import { copyWithTooltip } from '../lib/clipboard.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';
import { formatDate } from '../lib/date-utils.js';
import { AggregateWizard, openAggregateWizard } from '../components/AggregateWizard.js';
import { isMobile } from '../lib/viewport.js';

const TYPES = ['', 'manual', 'ab_test', 'analytics', 'error_report', 'programmatic'];
const STATUSES = ['', 'new', 'reviewed', 'running', 'completed', 'killed', 'failed', 'resolved', 'archived', 'deleted'];
const DISPATCH_STATUSES = new Set(['running', 'completed', 'killed', 'failed']);
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'state-waiting', label: 'Waiting first' },
  { value: 'state-active', label: 'Active first' },
  { value: 'state-idle', label: 'Idle first' },
];

function getItemSessionState(item: any): string | null {
  if (item.status !== 'dispatched' || !item.latestSessionId) return null;
  if (item.latestSessionStatus !== 'running') return item.latestSessionStatus || null;
  return sessionInputStates.value.get(item.latestSessionId) || 'active';
}

const EXPANDED_BRAINSTORMS_KEY = 'pw-feedback-expanded-brainstorms';

function loadExpandedBrainstorms(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_BRAINSTORMS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveExpandedBrainstorms(set: Set<string>) {
  try { localStorage.setItem(EXPANDED_BRAINSTORMS_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

type RowEntry =
  | { kind: 'single'; item: any }
  | { kind: 'brainstorm'; voiceSessionId: string; items: any[] };

function buildRowEntries(items: any[]): RowEntry[] {
  const groupIndex = new Map<string, number>();
  const entries: RowEntry[] = [];
  for (const item of items) {
    const vsid = item?.data?.voiceSessionId;
    if (vsid && typeof vsid === 'string') {
      const idx = groupIndex.get(vsid);
      if (idx !== undefined) {
        (entries[idx] as { kind: 'brainstorm'; voiceSessionId: string; items: any[] }).items.push(item);
      } else {
        groupIndex.set(vsid, entries.length);
        entries.push({ kind: 'brainstorm', voiceSessionId: vsid, items: [item] });
      }
    } else {
      entries.push({ kind: 'single', item });
    }
  }
  return entries;
}

function brainstormSummary(items: any[]): string {
  for (const item of items) {
    const s = item?.data?.conversationSummary;
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return '';
}

function StatusCell({ item }: { item: any }) {
  const isDispatched = item.status === 'dispatched';
  const dispatchStatus = item.dispatchStatus;
  const sessionState = getItemSessionState(item);

  if (isDispatched && item.latestSessionStatus === 'running' && sessionState) {
    return (
      <div class="status-cell-compound">
        <span class={`session-state-dot ${sessionState}`} title={sessionState} />
        <span class={`badge badge-dispatched`}>{sessionState}</span>
      </div>
    );
  }

  if (isDispatched && dispatchStatus && dispatchStatus !== 'running') {
    return (
      <div class="status-cell-compound">
        <span class={`badge badge-dispatch-${dispatchStatus}`}>
          {dispatchStatus}
        </span>
      </div>
    );
  }

  return (
    <div class="status-cell-compound">
      <span class={`badge badge-${item.status}`}>{item.status}</span>
      {isDispatched && dispatchStatus === 'running' && (
        <span class="dispatch-running-dot" title="Agent session running" />
      )}
    </div>
  );
}

function ColResizeHandle() {
  const handleRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const thEl = handleRef.current?.parentElement as HTMLTableCellElement | null;
    if (!thEl) return;
    const startX = e.clientX;
    const startW = thEl.offsetWidth;
    const handle = handleRef.current!;
    handle.classList.add('dragging');

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(40, startW + ev.clientX - startX);
      thEl.style.width = w + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  return <div ref={handleRef} class="col-resize-handle" onMouseDown={onMouseDown} />;
}

export function FeedbackListPage({ appId }: { appId: string }) {
  const items = useSignal<any[]>([]);
  const total = useSignal(0);
  const page = useSignal(1);
  const totalPages = useSignal(0);
  const loading = useSignal(false);
  const filterType = useSignal('');
  const filterStatuses = useSignal<Set<string>>(new Set());
  const searchQuery = useSignal('');
  const selected = useSignal<Set<string>>(new Set());
  const showCreateForm = useSignal(false);
  const createTitle = useSignal('');
  const createDescription = useSignal('');
  const createType = useSignal('manual');
  const createTags = useSignal('');
  const createLoading = useSignal(false);
  const isStuck = useSignal(false);
  const filtersCollapsed = useSignal(isMobile.value);
  const sortMode = useSignal<string>('newest');
  const filterTag = useSignal('');
  const availableTags = useSignal<{ tag: string; count: number }[]>([]);
  const expandedBrainstorms = useSignal<Set<string>>(loadExpandedBrainstorms());

  function toggleBrainstorm(voiceSessionId: string) {
    const next = new Set(expandedBrainstorms.value);
    if (next.has(voiceSessionId)) next.delete(voiceSessionId);
    else next.add(voiceSessionId);
    expandedBrainstorms.value = next;
    saveExpandedBrainstorms(next);
  }

  function applySortMode(list: any[]): any[] {
    const mode = sortMode.value;
    if (!mode.startsWith('state-')) return list;
    const target = mode.replace('state-', '');
    const stateOrder = (item: any) => {
      const state = getItemSessionState(item);
      if (state === target) return 0;
      if (state === 'waiting') return 1;
      if (state === 'active') return 2;
      if (state === 'idle') return 3;
      if (state) return 4;
      return 5;
    };
    return [...list].sort((a, b) => stateOrder(a) - stateOrder(b));
  }

  async function loadFeedback() {
    loading.value = true;
    try {
      const params: Record<string, string | number> = { page: page.value, limit: 20 };
      if (filterType.value) params.type = filterType.value;
      const regularStatuses: string[] = [];
      const dispatchStatuses: string[] = [];
      for (const s of filterStatuses.value) {
        if (DISPATCH_STATUSES.has(s)) dispatchStatuses.push(s);
        else regularStatuses.push(s);
      }
      if (regularStatuses.length > 0 || dispatchStatuses.length > 0) {
        if (regularStatuses.length > 0) params.status = regularStatuses.join(',');
        if (dispatchStatuses.length > 0) params.dispatchStatus = dispatchStatuses.join(',');
      }
      if (searchQuery.value) params.search = searchQuery.value;
      if (filterTag.value) params.tag = filterTag.value;
      params.appId = appId;
      const mode = sortMode.value;
      if (mode === 'oldest') { params.sortOrder = 'asc'; }
      else if (mode === 'updated') { params.sortBy = 'updatedAt'; }
      const result = await api.getFeedback(params);
      items.value = applySortMode(result.items);
      total.value = result.total;
      totalPages.value = result.totalPages;
    } catch (err) {
      console.error('Failed to load feedback:', err);
    } finally {
      loading.value = false;
    }
  }

  // Reactive filter/load effect
  useSignalEffect(() => {
    void filterType.value;
    void filterStatuses.value;
    void page.value;
    void currentRoute.value;
    void sortMode.value;
    void filterTag.value;
    loadFeedback();
  });

  // Dispatch result handler
  useSignalEffect(() => {
    if (dispatchDialogResult.value === 'dispatched') {
      loadFeedback();
      selected.value = new Set();
      dispatchDialogResult.value = 'idle';
    }
  });

  function toggleSelect(id: string) {
    const s = new Set(selected.value);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    selected.value = s;
  }

  function toggleSelectAll() {
    if (selected.value.size === items.value.length) {
      selected.value = new Set();
    } else {
      selected.value = new Set(items.value.map((i) => i.id));
    }
  }

  async function batchUpdateStatus(status: string) {
    if (selected.value.size === 0) return;
    await api.batchOperation({ ids: Array.from(selected.value), operation: 'updateStatus', value: status });
    selected.value = new Set();
    await loadFeedback();
  }

  async function batchDelete() {
    if (selected.value.size === 0) return;
    await api.batchOperation({ ids: Array.from(selected.value), operation: 'delete' });
    selected.value = new Set();
    await loadFeedback();
  }

  async function batchPermanentDelete() {
    if (selected.value.size === 0) return;
    const ids = Array.from(selected.value);
    await api.batchOperation({ ids, operation: 'permanentDelete' });
    for (const id of ids) {
      trackDeletion('feedback', id, `Ticket ${id.slice(-6)}`);
    }
    selected.value = new Set();
    await loadFeedback();
  }

  async function batchRestore() {
    if (selected.value.size === 0) return;
    await api.batchOperation({ ids: Array.from(selected.value), operation: 'updateStatus', value: 'new' });
    selected.value = new Set();
    await loadFeedback();
  }

  async function createFeedback() {
    if (!createTitle.value.trim()) return;
    createLoading.value = true;
    try {
      const tags = createTags.value.trim()
        ? createTags.value.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      const result = await api.createFeedback({
        title: createTitle.value.trim(),
        description: createDescription.value,
        type: createType.value,
        appId,
        tags,
      });
      showCreateForm.value = false;
      createTitle.value = '';
      createDescription.value = '';
      createType.value = 'manual';
      createTags.value = '';
      if (isMobile.value) {
        navigate(`/app/${appId}/tickets/${result.id}`);
      } else {
        openFeedbackItem(result.id);
      }
    } catch (err: any) {
      console.error('Failed to create:', err.message);
    } finally {
      createLoading.value = false;
    }
  }

  function ActionCell({ item }: { item: any }) {
    const hasSession = !!item.latestSessionId;
    const sessionStatus = item.latestSessionStatus;
    const isRunning = hasSession && sessionStatus === 'running';
    const isCompleted = hasSession && !isRunning;
    if (isRunning) {
      return (
        <div class="action-cell-group">
          <button
            class="btn-action-live"
            title="Open running session"
            onClick={(e) => { e.stopPropagation(); openSession(item.latestSessionId); }}
          >
            <span class="live-pulse" />
            Live
            {item.sessionCount > 1 && <span class="session-count">{item.sessionCount}</span>}
          </button>
        </div>
      );
    }

    if (isCompleted) {
      return (
        <div class="action-cell-group">
          <button
            class="btn-action-view"
            title={`View session (${sessionStatus})`}
            onClick={(e) => { e.stopPropagation(); openSession(item.latestSessionId); }}
          >
            View
            {item.sessionCount > 1 && <span class="session-count">{item.sessionCount}</span>}
          </button>
          <button
            class="btn-dispatch-mini"
            title="Re-dispatch to agent"
            onClick={(e) => {
              e.stopPropagation();
              openDispatchDialog([item.id], appId);
            }}
          >
            ↻
          </button>
        </div>
      );
    }

    return (
      <button
        class="btn-dispatch-quick"
        onClick={(e) => {
          e.stopPropagation();
          openDispatchDialog([item.id], appId);
        }}
        title="Cook it"
      >
        <span>→</span>
      </button>
    );
  }

  useEffect(() => {
    loadFeedback();
    api.getFeedbackTags(appId).then(tags => { availableTags.value = tags; }).catch(() => {});
    const token = localStorage.getItem('pw-admin-token');
    if (!token) return;
    const es = new EventSource(`/api/v1/admin/feedback/events?token=${encodeURIComponent(token)}`);
    const onEvent = (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      if (data.appId === appId) {
        loadFeedback();
        api.getFeedbackTags(appId).then(tags => { availableTags.value = tags; }).catch(() => {});
      }
    };
    es.addEventListener('new-feedback', onEvent);
    es.addEventListener('feedback-updated', onEvent);

    // Same-page widget submits: SSE on mobile Safari (and some proxies) can
    // buffer events, so piggyback on the widget's own submit event to reload
    // synchronously when feedback is submitted from this browser.
    const widget = (window as any).promptWidget;
    const onWidgetSubmit = (data: any) => {
      if (!data?.appId || data.appId === appId) {
        loadFeedback();
        api.getFeedbackTags(appId).then(tags => { availableTags.value = tags; }).catch(() => {});
      }
    };
    widget?.on?.('submit', onWidgetSubmit);

    return () => {
      es.close();
      widget?.off?.('submit', onWidgetSubmit);
    };
  }, [appId]);

  // Re-sort when session states change (for state-based sort modes)
  useEffect(() => {
    const unsub = sessionInputStates.subscribe(() => {
      if (sortMode.value.startsWith('state-')) {
        items.value = applySortMode([...items.value]);
      }
    });
    return unsub;
  }, []);


  const basePath = `/app/${appId}/tickets`;

  const viewingDeleted = filterStatuses.value.has('deleted');
  const hasSelection = selected.value.size > 0;
  const activeFilterCount =
    (searchQuery.value ? 1 : 0) +
    (filterType.value ? 1 : 0) +
    (sortMode.value !== 'newest' ? 1 : 0) +
    (filterTag.value ? 1 : 0) +
    (filterStatuses.value.size > 0 ? 1 : 0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { isStuck.value = !entry.isIntersecting; },
      { threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [appId]);

  return (
    <div>
      <div class="page-header">
        <button class="btn btn-sm btn-primary" onClick={() => (showCreateForm.value = !showCreateForm.value)}>
          + New
        </button>
        <button class="btn btn-sm" onClick={() => openAggregateWizard(appId)} title="Cluster tickets by similarity and auto-tag">
          Aggregate
        </button>
      </div>

      {showCreateForm.value && (
        <div class="detail-card" style="margin-bottom:16px">
          <h3 style="margin-bottom:12px">New Ticket</h3>
          <div style="display:flex;flex-direction:column;gap:8px">
            <input
              type="text"
              placeholder="Title"
              value={createTitle.value}
              onInput={(e) => (createTitle.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && createFeedback()}
              style="padding:6px 10px;font-size:14px"
            />
            <textarea
              placeholder="Description (optional)"
              value={createDescription.value}
              onInput={(e) => (createDescription.value = (e.target as HTMLTextAreaElement).value)}
              style="width:100%;box-sizing:border-box;padding:6px 10px;font-size:13px;min-height:80px;resize:vertical;font-family:inherit"
            />
            <div style="display:flex;gap:8px;align-items:center">
              <select
                value={createType.value}
                onChange={(e) => (createType.value = (e.target as HTMLSelectElement).value)}
                style="padding:4px 8px;font-size:13px"
              >
                {TYPES.filter(Boolean).map((t) => (
                  <option value={t}>{t.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Tags (comma-separated)"
                value={createTags.value}
                onInput={(e) => (createTags.value = (e.target as HTMLInputElement).value)}
                style="flex:1;padding:4px 8px;font-size:13px"
              />
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button class="btn btn-sm" onClick={() => (showCreateForm.value = false)}>Cancel</button>
              <button
                class="btn btn-sm btn-primary"
                disabled={!createTitle.value.trim() || createLoading.value}
                onClick={createFeedback}
              >
                {createLoading.value ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div ref={sentinelRef} class="filters-sentinel" />
      <div class={`filters ${hasSelection ? 'has-selection' : ''} ${isStuck.value ? 'stuck' : ''} ${filtersCollapsed.value ? 'collapsed' : ''}`}>
        <button
          class="btn-filter-toggle"
          onClick={() => (filtersCollapsed.value = !filtersCollapsed.value)}
          title={filtersCollapsed.value ? 'Show filters and search' : 'Hide filters and search'}
        >
          Filters
          {activeFilterCount > 0 && <span class="filter-count">{activeFilterCount}</span>}
          <span class={`filter-toggle-chevron ${filtersCollapsed.value ? 'collapsed' : ''}`}>&#9662;</span>
        </button>
        {!filtersCollapsed.value && (
          <>
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery.value}
              onInput={(e) => (searchQuery.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  page.value = 1;
                  loadFeedback();
                }
              }}
            />
            <select
              value={filterType.value}
              onChange={(e) => {
                filterType.value = (e.target as HTMLSelectElement).value;
                page.value = 1;
              }}
            >
              <option value="">All types</option>
              {TYPES.filter(Boolean).map((t) => (
                <option value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <select
              value={sortMode.value}
              onChange={(e) => {
                sortMode.value = (e.target as HTMLSelectElement).value;
                page.value = 1;
              }}
              class="sort-select"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {availableTags.value.length > 0 && (
              <select
                value={filterTag.value}
                onChange={(e) => {
                  filterTag.value = (e.target as HTMLSelectElement).value;
                  page.value = 1;
                }}
              >
                <option value="">All tags</option>
                {availableTags.value.map((t) => (
                  <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
                ))}
              </select>
            )}
            <div class="filter-pills">
              {STATUSES.filter(Boolean).map((s) => {
                const active = filterStatuses.value.has(s);
                const pillClass = DISPATCH_STATUSES.has(s) ? `badge-dispatch-${s}` : `badge-${s}`;
                return (
                  <button
                    key={s}
                    class={`status-filter-pill ${pillClass} ${active ? 'active' : ''}`}
                    onClick={() => {
                      const next = new Set(filterStatuses.value);
                      if (next.has(s)) next.delete(s);
                      else next.add(s);
                      filterStatuses.value = next;
                      page.value = 1;
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {hasSelection && (
          <div class="selection-actions">
            <span class="selection-bar-count">{selected.value.size} selected</span>
            {viewingDeleted ? (
              <>
                <button class="btn btn-sm btn-primary" onClick={batchRestore}>
                  Restore
                </button>
                <button class="btn btn-sm btn-danger" onClick={batchPermanentDelete}>
                  Permanently Delete
                </button>
              </>
            ) : (
              <>
                <button
                  class="btn btn-sm btn-primary"
                  onClick={() => {
                    openDispatchDialog(Array.from(selected.value), appId);
                  }}
                >
                  Dispatch
                </button>
                <select
                  class="btn btn-sm"
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    if (v) batchUpdateStatus(v);
                    (e.target as HTMLSelectElement).value = '';
                  }}
                >
                  <option value="">Set status...</option>
                  {STATUSES.filter((s) => s && s !== 'deleted').map((s) => (
                    <option value={s}>{s}</option>
                  ))}
                </select>
                <button class="btn btn-sm btn-danger" onClick={batchDelete}>
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div class="table-wrap">
        <table class={`resizable-cols${hasSelection ? ' has-selection' : ''}`}>
          <thead>
            <tr>
              <th style="width:40px">
                <input
                  type="checkbox"
                  class="checkbox"
                  checked={selected.value.size === items.value.length && items.value.length > 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th style="width:60px">ID<ColResizeHandle /></th>
              <th>Title<ColResizeHandle /></th>
              <th style="width:90px">Type<ColResizeHandle /></th>
              <th style="width:110px">Status<ColResizeHandle /></th>
              <th style="width:120px">Tags<ColResizeHandle /></th>
              <th style="width:100px">Created<ColResizeHandle /></th>
              <th style="width:120px">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const renderItemRow = (item: any, opts: { indent?: boolean } = {}) => (
                <tr key={item.id} class={opts.indent ? 'feedback-row-brainstorm-child' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      class="checkbox"
                      checked={selected.value.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                    />
                  </td>
                  <td>
                    <code
                      style="font-size:11px;color:var(--pw-text-faint);background:var(--pw-code-block-bg);padding:1px 5px;border-radius:3px;cursor:pointer"
                      title={`Click to copy: ${item.id}`}
                      onClick={(e) => { e.stopPropagation(); copyWithTooltip(item.id, e as any); }}
                    >
                      {item.id.slice(-6)}
                    </code>
                  </td>
                  <td style="max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    {opts.indent && <span class="feedback-brainstorm-indent" aria-hidden="true" />}
                    <a
                      href={`#${basePath}/${item.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        if (item.title) {
                          feedbackTitleCache.value = { ...feedbackTitleCache.value, [item.id]: item.title };
                        }
                        if (isMobile.value) {
                          navigate(`${basePath}/${item.id}`);
                        } else {
                          openFeedbackItem(item.id);
                        }
                      }}
                      style="color:var(--pw-primary-text);text-decoration:none;font-weight:500"
                      title={item.title}
                    >
                      {item.title}
                    </a>
                  </td>
                  <td>
                    <span class={`badge badge-${item.type}`}>{item.type.replace(/_/g, ' ')}</span>
                  </td>
                  <td>
                    <StatusCell item={item} />
                  </td>
                  <td>
                    <div class="tags">
                      {(item.tags || []).map((t: string) => (
                        <span
                          class="tag"
                          style="cursor:pointer"
                          onClick={(e) => { e.stopPropagation(); filterTag.value = t; page.value = 1; }}
                          title={`Filter by tag: ${t}`}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style="white-space:nowrap;color:var(--pw-text-muted);font-size:13px">{formatDate(item.createdAt)}</td>
                  <td>
                    <ActionCell item={item} />
                  </td>
                </tr>
              );

              const renderBrainstormHeader = (vsid: string, group: any[]) => {
                const expanded = expandedBrainstorms.value.has(vsid);
                const summary = brainstormSummary(group);
                const runningCount = group.filter((i) => i.latestSessionStatus === 'running').length;
                const earliest = group.reduce<string | null>((acc, it) => {
                  if (!acc) return it.createdAt;
                  return new Date(it.createdAt) < new Date(acc) ? it.createdAt : acc;
                }, null);
                return (
                  <tr key={`bs-${vsid}`} class="feedback-row-brainstorm-header" onClick={() => toggleBrainstorm(vsid)}>
                    <td colSpan={8}>
                      <div class="feedback-brainstorm-header-inner">
                        <button
                          class="session-swarm-toggle"
                          onClick={(e) => { e.stopPropagation(); toggleBrainstorm(vsid); }}
                          title={expanded ? 'Collapse' : 'Expand'}
                        >
                          {expanded ? '▾' : '▸'}
                        </button>
                        <span class="session-orchestrator-badge feedback-brainstorm-badge">Brainstorm</span>
                        <span class="feedback-brainstorm-label" title={summary || undefined}>
                          {summary || `Voice session ${vsid.slice(-8)}`}
                        </span>
                        <span class="feedback-brainstorm-count">
                          {group.length} ticket{group.length === 1 ? '' : 's'}
                          {runningCount > 0 ? ` · ${runningCount} running` : ''}
                        </span>
                        {earliest && (
                          <span class="feedback-brainstorm-time" title={new Date(earliest).toLocaleString()}>
                            {formatDate(earliest)}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              };

              const entries = buildRowEntries(items.value);
              const out: any[] = [];
              for (const entry of entries) {
                if (entry.kind === 'single') {
                  out.push(renderItemRow(entry.item));
                } else {
                  out.push(renderBrainstormHeader(entry.voiceSessionId, entry.items));
                  if (expandedBrainstorms.value.has(entry.voiceSessionId)) {
                    for (const child of entry.items) {
                      out.push(renderItemRow(child, { indent: true }));
                    }
                  }
                }
              }
              return out;
            })()}
            {items.value.length === 0 && !loading.value && (
              <tr>
                <td colSpan={8} style="text-align:center;padding:32px;color:#94a3b8">
                  No tickets found
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {totalPages.value > 1 && (
          <div class="pagination">
            <span>
              Page {page.value} of {totalPages.value} ({total.value} items)
            </span>
            <div class="pagination-btns">
              <button
                class="btn btn-sm"
                disabled={page.value <= 1}
                onClick={() => (page.value = page.value - 1)}
              >
                Prev
              </button>
              <button
                class="btn btn-sm"
                disabled={page.value >= totalPages.value}
                onClick={() => (page.value = page.value + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      <DeletedItemsPanel type="feedback" />
      <AggregateWizard onTagFilter={(tag) => { filterTag.value = tag; page.value = 1; }} />
    </div>
  );
}
