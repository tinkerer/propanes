import { signal, effect } from '@preact/signals';
import { useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { navigate } from '../lib/state.js';
import { openSession } from '../lib/sessions.js';
import { DeletedItemsPanel, trackDeletion } from '../components/DeletedItemsPanel.js';

interface ClusterItem {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  createdAt: string;
}

interface Cluster {
  groupKey: string;
  title: string;
  count: number;
  feedbackIds: string[];
  items: ClusterItem[];
  tags: string[];
  types: string[];
  statuses: string[];
  oldestAt: string;
  newestAt: string;
  plan: Plan | null;
}

interface Plan {
  id: string;
  groupKey: string;
  title: string;
  body: string;
  status: 'draft' | 'active' | 'completed';
  linkedFeedbackIds: string[];
  appId: string | null;
  createdAt: string;
  updatedAt: string;
}

const clusters = signal<Cluster[]>([]);
const totalGroups = signal(0);
const totalItems = signal(0);
const loading = signal(false);
const minCount = signal(1);
const filterType = signal('');
const filterStatus = signal('');
const includeClosed = signal(false);
const currentAppId = signal<string | null>(null);
const agents = signal<any[]>([]);

const TYPES = ['', 'manual', 'ab_test', 'analytics', 'error_report', 'programmatic'];
const STATUSES = ['', 'new', 'reviewed', 'dispatched', 'resolved', 'archived'];

async function loadClusters() {
  loading.value = true;
  try {
    const params: Record<string, string | number> = {};
    if (currentAppId.value) params.appId = currentAppId.value;
    if (filterType.value) params.type = filterType.value;
    if (filterStatus.value) params.status = filterStatus.value;
    if (includeClosed.value) params.includeClosed = 1;
    if (minCount.value > 1) params.minCount = minCount.value;
    const result = await api.getAggregate(params);
    clusters.value = result.clusters;
    totalGroups.value = result.totalGroups;
    totalItems.value = result.totalItems;
  } catch (err) {
    console.error('Failed to load clusters:', err);
  } finally {
    loading.value = false;
  }
}

async function loadAgents() {
  try {
    agents.value = await api.getAgents();
  } catch { /* */ }
}

effect(() => {
  void currentAppId.value;
  void filterType.value;
  void filterStatus.value;
  void includeClosed.value;
  void minCount.value;
  loadClusters();
});

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

function PlanEditor({ cluster, appId, onSaved }: {
  cluster: Cluster;
  appId: string | null;
  onSaved: () => void;
}) {
  const existing = cluster.plan;
  const [title, setTitle] = useState(existing?.title || cluster.title);
  const [body, setBody] = useState(existing?.body || '');
  const [status, setStatus] = useState<'draft' | 'active' | 'completed'>(existing?.status || 'draft');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      if (existing) {
        await api.updatePlan(existing.id, { title, body, status });
      } else {
        await api.createPlan({
          groupKey: cluster.groupKey,
          title,
          body,
          status,
          linkedFeedbackIds: cluster.feedbackIds,
          appId: appId === '__unlinked__' ? undefined : appId,
        });
      }
      onSaved();
    } catch (err) {
      console.error('Failed to save plan:', err);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    await api.deletePlan(existing.id);
    trackDeletion('plans', existing.id, existing.title);
    onSaved();
  }

  return (
    <div class="plan-editor">
      <div class="form-group" style="margin-bottom:8px">
        <input
          type="text"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          placeholder="Plan title"
          style="width:100%;font-weight:600"
        />
      </div>
      <div class="form-group" style="margin-bottom:8px">
        <textarea
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          placeholder="Describe the action plan — what needs to be done to address this cluster of feedback..."
          style="width:100%;min-height:100px;font-size:13px"
        />
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <select
          value={status}
          onChange={(e) => setStatus((e.target as HTMLSelectElement).value as any)}
          style="font-size:12px"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
        </select>
        <button class="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : existing ? 'Update Plan' : 'Create Plan'}
        </button>
        {existing && (
          <button class="btn btn-sm btn-danger" onClick={remove}>Delete</button>
        )}
      </div>
    </div>
  );
}

function ClusterDispatchButton({ cluster, appId }: { cluster: Cluster; appId: string | null }) {
  const [showPicker, setShowPicker] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [dispatching, setDispatching] = useState(false);

  function open(e: Event) {
    e.stopPropagation();
    loadAgents();
    setShowPicker(true);
    setSelectedAgent('');
  }

  async function dispatch() {
    if (!selectedAgent || !appId) return;
    setDispatching(true);
    try {
      const res = await api.analyzeCluster({
        appId,
        agentEndpointId: selectedAgent,
        feedbackIds: cluster.feedbackIds,
        clusterTitle: cluster.title,
      });
      setShowPicker(false);
      openSession(res.sessionId);
    } catch (err) {
      console.error('Cluster dispatch failed:', err);
    } finally {
      setDispatching(false);
    }
  }

  const appAgents = agents.value.filter(
    (a: any) => a.mode === 'headless' || a.mode === 'interactive'
  );

  return (
    <>
      <button class="btn btn-sm btn-primary" onClick={open}>
        Analyze Cluster
      </button>
      {showPicker && (
        <div class="cluster-dispatch-picker" onClick={(e) => e.stopPropagation()}>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent((e.target as HTMLSelectElement).value)}
            style="font-size:12px;flex:1"
          >
            <option value="">Select agent...</option>
            {appAgents.map((a: any) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            class="btn btn-sm btn-primary"
            onClick={dispatch}
            disabled={dispatching || !selectedAgent}
          >
            {dispatching ? 'Sending...' : 'Go'}
          </button>
          <button class="btn btn-sm" onClick={(e) => { e.stopPropagation(); setShowPicker(false); }}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

function ClusterCard({ cluster, appId }: { cluster: Cluster; appId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showPlanEditor, setShowPlanEditor] = useState(false);
  const basePath = appId ? `/app/${appId}/feedback` : '/feedback';

  return (
    <div class="cluster-card">
      <div class="cluster-header" onClick={() => setExpanded(!expanded)}>
        <div class="cluster-title-row">
          <span class="cluster-count-badge">{cluster.count}</span>
          <h4 class="cluster-title">{cluster.title}</h4>
          <span class="cluster-expand">{expanded ? '\u25B2' : '\u25BC'}</span>
        </div>
        <div class="cluster-meta">
          <span class="cluster-date">{formatDate(cluster.oldestAt)} — {formatDate(cluster.newestAt)}</span>
          {cluster.types.map((t) => (
            <span key={t} class={`badge badge-${t}`} style="font-size:11px">{t.replace(/_/g, ' ')}</span>
          ))}
          {cluster.tags.map((t) => (
            <span key={t} class="tag" style="font-size:11px">{t}</span>
          ))}
          {cluster.plan && (
            <span class={`badge plan-badge-${cluster.plan.status}`}>
              Plan: {cluster.plan.status}
            </span>
          )}
        </div>
      </div>
      {expanded && (
        <div class="cluster-body">
          <div class="cluster-items-list">
            {(cluster.items || []).map((item) => (
              <div key={item.id} class="cluster-item-row">
                <a
                  class="cluster-item-link"
                  href={`#${basePath}/${item.id}`}
                  onClick={(e) => { e.preventDefault(); navigate(`${basePath}/${item.id}`); }}
                >
                  <span class="cluster-item-title">{item.title}</span>
                  <span class={`badge badge-${item.status}`} style="font-size:10px;margin-left:6px">{item.status}</span>
                </a>
                {item.description && (
                  <div class="cluster-item-desc">{item.description}</div>
                )}
                <div class="cluster-item-meta">
                  <span class={`badge badge-${item.type}`} style="font-size:10px">{item.type.replace(/_/g, ' ')}</span>
                  <span class="cluster-item-date">{formatDate(item.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
          <div class="cluster-actions">
            <button
              class="btn btn-sm"
              onClick={(e) => { e.stopPropagation(); setShowPlanEditor(!showPlanEditor); }}
            >
              {cluster.plan ? 'Edit Plan' : 'Create Plan'}
            </button>
            <ClusterDispatchButton cluster={cluster} appId={appId} />
          </div>
          {showPlanEditor && (
            <PlanEditor
              cluster={cluster}
              appId={appId}
              onSaved={() => { setShowPlanEditor(false); loadClusters(); }}
            />
          )}
          {cluster.plan && !showPlanEditor && (
            <div class="cluster-plan-preview">
              <div class="plan-preview-header">
                <strong>{cluster.plan.title}</strong>
                <span class={`badge plan-badge-${cluster.plan.status}`}>{cluster.plan.status}</span>
              </div>
              {cluster.plan.body && (
                <div class="plan-preview-body">{cluster.plan.body}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnalyzeButton({ appId }: { appId: string }) {
  const [showModal, setShowModal] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ sessionId: string; itemCount: number } | null>(null);

  function open() {
    loadAgents();
    setShowModal(true);
    setSelectedAgent('');
    setResult(null);
  }

  async function run() {
    if (!selectedAgent) return;
    setRunning(true);
    try {
      const res = await api.analyzeAggregate({ appId, agentEndpointId: selectedAgent });
      setResult(res);
    } catch (err) {
      console.error('Analyze failed:', err);
    } finally {
      setRunning(false);
    }
  }

  const appAgents = agents.value.filter(
    (a: any) => a.mode === 'headless' || a.mode === 'interactive'
  );

  return (
    <>
      <button class="btn btn-primary" onClick={open}>
        Analyze with Agent
      </button>
      {showModal && (
        <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div class="modal">
            <h3>AI-Powered Feedback Analysis</h3>
            <p style="font-size:13px;color:var(--pw-text-muted);margin-bottom:16px">
              Dispatch all feedback to an agent for intelligent clustering, disambiguation, and action plan generation.
            </p>
            {!result ? (
              <>
                <div class="form-group">
                  <label>Agent Endpoint</label>
                  <select
                    value={selectedAgent}
                    onChange={(e) => setSelectedAgent((e.target as HTMLSelectElement).value)}
                    style="width:100%"
                  >
                    <option value="">Select agent...</option>
                    {appAgents.map((a: any) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {appAgents.length === 0 && (
                    <span style="font-size:12px;color:var(--pw-warning);display:block;margin-top:4px">
                      No agents configured. Add one in Settings &gt; Agents first.
                    </span>
                  )}
                </div>
                <div class="modal-actions">
                  <button class="btn" onClick={() => setShowModal(false)}>Cancel</button>
                  <button
                    class="btn btn-primary"
                    onClick={run}
                    disabled={running || !selectedAgent}
                  >
                    {running ? 'Dispatching...' : 'Start Analysis'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style="background:var(--pw-success-soft);color:var(--pw-success-text);padding:12px;border-radius:8px;font-size:13px;margin-bottom:16px">
                  Analysis session started. {result.itemCount} feedback items sent for clustering.
                </div>
                <div class="modal-actions">
                  <button class="btn" onClick={() => setShowModal(false)}>Close</button>
                  <button
                    class="btn btn-primary"
                    onClick={() => { setShowModal(false); openSession(result.sessionId); }}
                  >
                    Open Session Terminal
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function AggregatePage({ appId }: { appId: string }) {
  if (currentAppId.value !== appId) {
    currentAppId.value = appId;
  }

  return (
    <div>
      <div class="page-header">
        <h2>Aggregate Feedback ({totalGroups.value} groups, {totalItems.value} items)</h2>
        <AnalyzeButton appId={appId} />
      </div>

      <div class="filters">
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">
          Min count:
          <input
            type="number"
            min="1"
            value={minCount.value}
            onInput={(e) => {
              const v = parseInt((e.target as HTMLInputElement).value);
              if (v >= 1) minCount.value = v;
            }}
            style="width:60px"
          />
        </label>
        <select
          value={filterType.value}
          onChange={(e) => (filterType.value = (e.target as HTMLSelectElement).value)}
        >
          <option value="">All types</option>
          {TYPES.filter(Boolean).map((t) => (
            <option value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          value={filterStatus.value}
          onChange={(e) => (filterStatus.value = (e.target as HTMLSelectElement).value)}
        >
          <option value="">All statuses</option>
          {STATUSES.filter(Boolean).map((s) => (
            <option value={s}>{s}</option>
          ))}
        </select>
        <label style="font-size:13px;display:flex;align-items:center;gap:4px">
          <input
            type="checkbox"
            checked={includeClosed.value}
            onChange={(e) => (includeClosed.value = (e.target as HTMLInputElement).checked)}
          />
          Include closed
        </label>
      </div>

      {loading.value && (
        <div style="text-align:center;padding:40px;color:var(--pw-text-faint)">Loading...</div>
      )}

      {!loading.value && clusters.value.length === 0 && (
        <div style="text-align:center;padding:40px;color:var(--pw-text-faint)">
          No clusters found. Submit feedback items first, or lower the minimum count filter.
        </div>
      )}

      <div class="cluster-list">
        {clusters.value.map((cluster) => (
          <ClusterCard key={cluster.groupKey} cluster={cluster} appId={appId} />
        ))}
      </div>
      <DeletedItemsPanel type="plans" />
    </div>
  );
}
