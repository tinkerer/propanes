import { signal, effect } from '@preact/signals';
import { marked } from 'marked';
import { api } from '../lib/api.js';
import { navigate } from '../lib/state.js';
import { openSession, resumeSession } from '../lib/sessions.js';
import { copyWithTooltip } from '../lib/clipboard.js';
import { CropEditor } from '../components/CropEditor.js';
import { DispatchTargetSelect } from '../components/DispatchTargetSelect.js';

marked.setOptions({ gfm: true, breaks: true });

const feedback = signal<any>(null);
const loading = signal(true);
const error = signal('');
const agents = signal<any[]>([]);
const dispatchAgentId = signal('');
const dispatchInstructions = signal('');
const dispatchLoading = signal(false);
const dispatchTarget = signal('');
const newTag = signal('');
const agentSessions = signal<any[]>([]);
const lastLoadedId = signal<string | null>(null);
const lightboxSrc = signal<string | null>(null);
const lightboxImageId = signal<string | null>(null);
const lightboxFeedbackId = signal<string | null>(null);
const cropMode = signal(false);
const cacheBuster = signal(0);
const editingTitle = signal(false);
const editTitleValue = signal('');
const editingDescription = signal(false);
const editDescValue = signal('');
const liveConnections = signal<any[]>([]);
const enrichLoading = signal<string | null>(null);

const STATUSES = ['new', 'reviewed', 'dispatched', 'resolved', 'archived'];

effect(() => {
  if (!lightboxSrc.value) return;
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      if (cropMode.value) {
        cropMode.value = false;
      } else {
        lightboxSrc.value = null;
        lightboxImageId.value = null;
        lightboxFeedbackId.value = null;
      }
    }
  };
  document.addEventListener('keydown', handler, true);
  return () => document.removeEventListener('keydown', handler, true);
});

let currentDetailAppId: string | null = null;

async function load(id: string, appId: string | null) {
  loading.value = true;
  error.value = '';
  agents.value = [];
  dispatchAgentId.value = '';
  lastLoadedId.value = id;
  currentDetailAppId = appId;
  try {
    const fb = await api.getFeedbackById(id);
    feedback.value = fb;
    const agentsList = await api.getAgents(fb.appId || undefined);
    agents.value = agentsList;
    // Prefer per-app default, then global default, then first agent
    const appDefault = agentsList.find((a: any) => a.isDefault && a.appId === fb.appId);
    const globalDefault = agentsList.find((a: any) => a.isDefault && !a.appId);
    const def = appDefault || globalDefault;
    if (def) dispatchAgentId.value = def.id;
    else if (agentsList.length > 0) dispatchAgentId.value = agentsList[0].id;
    loadSessions(id);
    loadLiveConnections(fb.appId);
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function loadLiveConnections(appId?: string) {
  try {
    const all = await api.getLiveConnections();
    liveConnections.value = appId ? all.filter((s: any) => s.appId === appId) : all;
  } catch {
    liveConnections.value = [];
  }
}

async function loadSessions(feedbackId: string) {
  try {
    agentSessions.value = await api.getAgentSessions(feedbackId);
  } catch {
    // ignore
  }
}

async function updateStatus(status: string) {
  const fb = feedback.value;
  if (!fb) return;
  await api.updateFeedback(fb.id, { status });
  fb.status = status;
  feedback.value = { ...fb };
}

async function saveTitle() {
  const fb = feedback.value;
  if (!fb || !editTitleValue.value.trim()) return;
  await api.updateFeedback(fb.id, { title: editTitleValue.value.trim() });
  fb.title = editTitleValue.value.trim();
  feedback.value = { ...fb };
  editingTitle.value = false;
}

async function saveDescription() {
  const fb = feedback.value;
  if (!fb) return;
  await api.updateFeedback(fb.id, { description: editDescValue.value });
  fb.description = editDescValue.value;
  feedback.value = { ...fb };
  editingDescription.value = false;
}

async function deleteFeedback() {
  const fb = feedback.value;
  if (!fb) return;
  await api.updateFeedback(fb.id, { status: 'deleted' });
  if (currentDetailAppId) {
    navigate(`/app/${currentDetailAppId}/feedback`);
  } else {
    navigate('/');
  }
}

async function addTag() {
  const fb = feedback.value;
  if (!fb || !newTag.value.trim()) return;
  const tags = [...(fb.tags || []), newTag.value.trim()];
  await api.updateFeedback(fb.id, { tags });
  fb.tags = tags;
  feedback.value = { ...fb };
  newTag.value = '';
}

async function removeTag(tag: string) {
  const fb = feedback.value;
  if (!fb) return;
  const tags = (fb.tags || []).filter((t: string) => t !== tag);
  await api.updateFeedback(fb.id, { tags });
  fb.tags = tags;
  feedback.value = { ...fb };
}

async function doDispatch() {
  const fb = feedback.value;
  if (!fb || !dispatchAgentId.value) return;
  dispatchLoading.value = true;
  try {
    const selectedAgent = agents.value.find((a) => a.id === dispatchAgentId.value);
    const result = await api.dispatch({
      feedbackId: fb.id,
      agentEndpointId: dispatchAgentId.value,
      instructions: dispatchInstructions.value || undefined,
      launcherId: dispatchTarget.value || undefined,
    });
    dispatchInstructions.value = '';

    // Optimistically update local feedback state instead of re-fetching everything
    feedback.value = {
      ...fb,
      status: 'dispatched',
      dispatchedTo: selectedAgent?.name || 'Agent',
      dispatchedAt: new Date().toISOString(),
      dispatchStatus: result.sessionId ? 'running' : 'success',
      dispatchResponse: result.response,
    };

    if (result.sessionId) {
      openSession(result.sessionId);
    }

    // Only refresh sessions list (lightweight) instead of full page reload
    loadSessions(fb.id);
  } catch (err: any) {
    const msg = err.message || 'Unknown error';
    const isServiceDown = msg.includes('unreachable') || msg.includes('503');
    if (isServiceDown) {
      error.value = `Dispatch failed — session service may be down: ${msg}`;
    } else {
      error.value = 'Dispatch failed: ' + msg;
    }
  } finally {
    dispatchLoading.value = false;
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function formatJson(data: any) {
  if (!data) return 'null';
  return JSON.stringify(data, null, 2);
}

async function deleteScreenshot(screenshotId: string) {
  const fb = feedback.value;
  if (!fb) return;
  await api.deleteScreenshot(screenshotId);
  fb.screenshots = (fb.screenshots || []).filter((s: any) => s.id !== screenshotId);
  feedback.value = { ...fb };
}

async function handleFileUpload(e: Event) {
  const fb = feedback.value;
  if (!fb) return;
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const result = await api.saveImageAsNew(fb.id, file);
  fb.screenshots = [...(fb.screenshots || []), { id: result.id, filename: result.filename }];
  feedback.value = { ...fb };
  input.value = '';
}

async function captureFromSession(sessionId: string) {
  const fb = feedback.value;
  if (!fb) return;
  enrichLoading.value = `screenshot-${sessionId}`;
  try {
    const result = await api.captureSessionScreenshot(sessionId);
    if (result.dataUrl) {
      const res = await fetch(result.dataUrl);
      const blob = await res.blob();
      const saved = await api.saveImageAsNew(fb.id, blob);
      fb.screenshots = [...(fb.screenshots || []), { id: saved.id, filename: saved.filename }];
      feedback.value = { ...fb };
    }
  } finally {
    enrichLoading.value = null;
  }
}

async function enrichConsole(sessionId: string) {
  const fb = feedback.value;
  if (!fb) return;
  enrichLoading.value = `console-${sessionId}`;
  try {
    const result = await api.getSessionConsole(sessionId);
    if (result.logs?.length) {
      await api.updateFeedback(fb.id, { context: { consoleLogs: result.logs } });
      const updated = await api.getFeedbackById(fb.id);
      feedback.value = updated;
    }
  } finally {
    enrichLoading.value = null;
  }
}

async function triggerAppendMode(sessionId: string) {
  const fb = feedback.value;
  if (!fb) return;
  enrichLoading.value = `append-${sessionId}`;
  try {
    await api.triggerAppendMode(sessionId, fb.id);
  } finally {
    enrichLoading.value = null;
  }
}

async function enrichNetwork(sessionId: string) {
  const fb = feedback.value;
  if (!fb) return;
  enrichLoading.value = `network-${sessionId}`;
  try {
    const result = await api.getSessionNetwork(sessionId);
    if (result.errors?.length) {
      await api.updateFeedback(fb.id, { context: { networkErrors: result.errors } });
      const updated = await api.getFeedbackById(fb.id);
      feedback.value = updated;
    }
  } finally {
    enrichLoading.value = null;
  }
}

// Paste handler: paste images from clipboard to add as screenshots
effect(() => {
  const fb = feedback.value;
  if (!fb) return;
  const handler = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const result = await api.saveImageAsNew(fb.id, file);
        const current = feedback.value;
        if (current) {
          current.screenshots = [...(current.screenshots || []), { id: result.id, filename: result.filename }];
          feedback.value = { ...current };
        }
        break;
      }
    }
  };
  document.addEventListener('paste', handler as EventListener);
  return () => document.removeEventListener('paste', handler as EventListener);
});

export function FeedbackDetailPage({ id, appId }: { id: string; appId: string | null }) {
  if (lastLoadedId.value !== id) {
    load(id, appId);
  }

  if (loading.value) return <div>Loading...</div>;
  if (error.value) return <div class="error-msg">{error.value}</div>;

  const fb = feedback.value;
  if (!fb) return <div>Not found</div>;

  const backPath = appId ? `/app/${appId}/feedback` : '/';

  return (
    <div>
      <div class="page-header">
        <div>
          <a href={`#${backPath}`} onClick={(e) => { e.preventDefault(); navigate(backPath); }} style="color:var(--pw-text-muted);text-decoration:none;font-size:13px">
            &larr; Back to list
          </a>
          <h2 style="margin-top:4px">
            <code style="font-size:14px;color:var(--pw-text-faint);background:var(--pw-code-block-bg);padding:2px 6px;border-radius:4px;margin-right:8px;cursor:pointer" title={`Click to copy: ${fb.id}`} onClick={(e) => copyWithTooltip(fb.id, e as any)}>{fb.id.slice(-6)}</code>
            {editingTitle.value ? (
              <input
                type="text"
                value={editTitleValue.value}
                onInput={(e) => (editTitleValue.value = (e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') (editingTitle.value = false);
                }}
                onBlur={saveTitle}
                style="font-size:inherit;font-weight:inherit;padding:2px 6px;border:1px solid var(--pw-accent);border-radius:4px;background:var(--pw-input-bg);color:var(--pw-primary-text);width:100%;max-width:800px"
                ref={(el) => el?.focus()}
              />
            ) : (
              <span
                style="cursor:pointer;border-bottom:1px dashed var(--pw-text-faint)"
                title="Click to edit"
                onClick={() => { editTitleValue.value = fb.title; editingTitle.value = true; }}
              >
                {fb.title}
              </span>
            )}
          </h2>
          <div style="font-size:11px;color:var(--pw-text-faint);font-family:monospace;margin-top:2px">{fb.id}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-ghost-danger" onClick={deleteFeedback}>Delete</button>
        </div>
      </div>

      {agents.value.length > 0 && (
        <div class="dispatch-bar dispatch-bar-styled">
          <div class="dispatch-bar-label">Dispatch</div>
          <div class="dispatch-bar-controls">
            <select
              class="dispatch-bar-select"
              value={dispatchAgentId.value}
              onChange={(e) => (dispatchAgentId.value = (e.target as HTMLSelectElement).value)}
            >
              {agents.value.map((a) => (
                <option value={a.id}>
                  {a.name}{a.isDefault && a.appId ? ' (app default)' : a.isDefault ? ' (default)' : ''}{!a.appId ? '' : ''}
                </option>
              ))}
            </select>
            <input
              class="dispatch-bar-input"
              type="text"
              placeholder="Instructions (optional)..."
              value={dispatchInstructions.value}
              onInput={(e) => (dispatchInstructions.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doDispatch(); }}
            />
            <DispatchTargetSelect
              value={dispatchTarget.value}
              onChange={(id) => { dispatchTarget.value = id || ''; }}
            />
            <button
              class="btn btn-primary dispatch-bar-btn"
              disabled={!dispatchAgentId.value || dispatchLoading.value}
              onClick={doDispatch}
            >
              {dispatchLoading.value ? 'Dispatching...' : 'Dispatch'}
            </button>
          </div>
        </div>
      )}

      <div class="detail-grid">
        <div>
          <div class="detail-card" style="margin-bottom:16px">
            <h3>Details</h3>

            <div class="status-pills">
              {STATUSES.map((s) => (
                <span
                  class={`status-pill badge-${s}${fb.status === s ? ' active' : ''}`}
                  onClick={() => updateStatus(s)}
                >
                  {s}
                </span>
              ))}
            </div>

            {editingDescription.value ? (
              <div style="margin-bottom:16px">
                <textarea
                  value={editDescValue.value}
                  onInput={(e) => (editDescValue.value = (e.target as HTMLTextAreaElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') (editingDescription.value = false);
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveDescription();
                  }}
                  style="width:100%;padding:10px 12px;font-size:14px;min-height:80px;resize:vertical;font-family:inherit;background:var(--pw-input-bg);color:var(--pw-primary-text);border:1px solid var(--pw-accent);border-radius:6px;box-sizing:border-box"
                  ref={(el) => el?.focus()}
                />
                <div style="display:flex;gap:4px;justify-content:flex-end;margin-top:6px">
                  <button class="btn btn-sm" onClick={() => (editingDescription.value = false)}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={saveDescription}>Save</button>
                </div>
              </div>
            ) : (
              <div
                class={`detail-description markdown-body${!fb.description ? ' detail-description-empty' : ''}`}
                title="Click to edit"
                onClick={() => { editDescValue.value = fb.description || ''; editingDescription.value = true; }}
                dangerouslySetInnerHTML={fb.description ? { __html: marked.parse(fb.description) as string } : undefined}
              >
                {fb.description ? undefined : 'No description'}
              </div>
            )}

            <div class="detail-meta-row">
              <span class={`badge badge-${fb.type}`}>{fb.type.replace(/_/g, ' ')}</span>
              {fb.sourceUrl && (
                <a href={fb.sourceUrl} target="_blank" rel="noopener">{fb.sourceUrl}</a>
              )}
            </div>

            <details class="detail-meta-collapse">
              <summary>Technical Details</summary>
              <div class="field-row">
                <span class="field-label">Source URL</span>
                <span class="field-value" style="word-break:break-all">{fb.sourceUrl ? <a href={fb.sourceUrl} target="_blank" rel="noopener" style="color:var(--pw-accent)">{fb.sourceUrl}</a> : '—'}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Viewport</span>
                <span class="field-value">{fb.viewport || '—'}</span>
              </div>
              <div class="field-row">
                <span class="field-label">User Agent</span>
                <span class="field-value" style="font-size:12px">{fb.userAgent || '—'}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Session</span>
                <span class="field-value" style="font-size:12px">{fb.sessionId || '—'}</span>
              </div>
              <div class="field-row">
                <span class="field-label">User</span>
                <span class="field-value">{fb.userId || '—'}</span>
              </div>
            </details>

            <div class="detail-timestamps">
              <span>Created {formatDate(fb.createdAt)}</span>
              <span>Updated {formatDate(fb.updatedAt)}</span>
            </div>
          </div>

          {fb.data && (
            <div class="detail-card" style="margin-bottom:16px">
              <h3>Custom Data</h3>
              <div class="json-viewer">{formatJson(fb.data)}</div>
            </div>
          )}

          {fb.context?.consoleLogs && fb.context.consoleLogs.length > 0 && (
            <div class="detail-card" style="margin-bottom:16px">
              <h3>Console Logs ({fb.context.consoleLogs.length})</h3>
              <div class="console-viewer">
                {fb.context.consoleLogs.map((entry: any, i: number) => (
                  <div class={`console-entry ${entry.level}`} key={i}>
                    <span style="color:var(--pw-text-muted)">{new Date(entry.timestamp).toLocaleTimeString()}</span>{' '}
                    [{entry.level.toUpperCase()}] {entry.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {fb.context?.networkErrors && fb.context.networkErrors.length > 0 && (
            <div class="detail-card" style="margin-bottom:16px">
              <h3>Network Errors ({fb.context.networkErrors.length})</h3>
              <table class="network-table">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {fb.context.networkErrors.map((err: any, i: number) => (
                    <tr key={i}>
                      <td>{err.method}</td>
                      <td style="word-break:break-all;max-width:300px">{err.url}</td>
                      <td class={err.status >= 400 ? 'status-error' : ''}>{err.status || 'ERR'}</td>
                      <td style="white-space:nowrap">{new Date(err.timestamp).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {fb.context?.performanceTiming && (
            <div class="detail-card" style="margin-bottom:16px">
              <h3>Performance</h3>
              <div class="field-row">
                <span class="field-label">Load Time</span>
                <span class="field-value">{fb.context.performanceTiming.loadTime?.toFixed(0)}ms</span>
              </div>
              <div class="field-row">
                <span class="field-label">DOM Ready</span>
                <span class="field-value">{fb.context.performanceTiming.domContentLoaded?.toFixed(0)}ms</span>
              </div>
              <div class="field-row">
                <span class="field-label">FCP</span>
                <span class="field-value">{fb.context.performanceTiming.firstContentfulPaint?.toFixed(0)}ms</span>
              </div>
            </div>
          )}
        </div>

        <div>
          <div class="detail-card detail-sidebar">
            <section class="detail-section">
              <h4>Tags</h4>
              <div class="tags" style="margin-bottom:8px">
                {(fb.tags || []).map((t: string) => (
                  <span class="tag">
                    {t}
                    <button onClick={() => removeTag(t)}>&times;</button>
                  </span>
                ))}
                {(fb.tags || []).length === 0 && <span style="color:var(--pw-text-faint);font-size:13px">No tags</span>}
              </div>
              <div style="display:flex;gap:4px">
                <input
                  type="text"
                  placeholder="Add tag..."
                  value={newTag.value}
                  onInput={(e) => (newTag.value = (e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                  style="flex:1;padding:4px 8px;font-size:12px"
                />
                <button class="btn btn-sm" onClick={addTag}>Add</button>
              </div>
            </section>

            {(fb.data?.selectedElements || fb.data?.selectedElement) && (() => {
              const elements: any[] = fb.data.selectedElements
                ? fb.data.selectedElements
                : [fb.data.selectedElement];
              return (
                <section class="detail-section">
                  <h4>Selected Element{elements.length > 1 ? 's' : ''} ({elements.length})</h4>
                  {elements.map((el: any, i: number) => (
                    <div key={i} style={elements.length > 1 ? "padding:8px 0;border-bottom:1px solid var(--pw-border)" : ""}>
                      <div class="field-row">
                        <span class="field-label">Tag</span>
                        <span class="field-value"><code style="background:var(--pw-code-block-bg);padding:1px 6px;border-radius:3px">{el.tagName}</code></span>
                      </div>
                      {el.id && (
                        <div class="field-row">
                          <span class="field-label">ID</span>
                          <span class="field-value" style="font-family:monospace">#{el.id}</span>
                        </div>
                      )}
                      {el.classes?.length > 0 && (
                        <div class="field-row">
                          <span class="field-label">Classes</span>
                          <span class="field-value" style="font-family:monospace">.{el.classes.join(' .')}</span>
                        </div>
                      )}
                      <div class="field-row">
                        <span class="field-label">Selector</span>
                        <span class="field-value" style="font-family:monospace;word-break:break-all;font-size:12px">{el.selector}</span>
                      </div>
                      {el.textContent && (
                        <div class="field-row">
                          <span class="field-label">Text</span>
                          <span class="field-value" style="font-size:12px;color:var(--pw-text-muted)">{el.textContent}</span>
                        </div>
                      )}
                      {el.boundingRect && (
                        <div class="field-row">
                          <span class="field-label">Position</span>
                          <span class="field-value" style="font-size:12px">{Math.round(el.boundingRect.x)},{Math.round(el.boundingRect.y)} &mdash; {Math.round(el.boundingRect.width)}&times;{Math.round(el.boundingRect.height)}</span>
                        </div>
                      )}
                      {Object.keys(el.attributes || {}).length > 0 && (
                        <div style="margin-top:8px">
                          <div style="font-size:11px;color:var(--pw-text-faint);margin-bottom:4px">Attributes</div>
                          {Object.entries(el.attributes).map(([k, v]) => (
                            <div class="field-row" key={k}>
                              <span class="field-label" style="font-family:monospace;font-size:11px">{k}</span>
                              <span class="field-value" style="font-size:12px;word-break:break-all">{v as string}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              );
            })()}

            <section class="detail-section">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <h4 style="margin:0">Screenshots ({(fb.screenshots || []).length})</h4>
                <button class="btn btn-sm" onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'image/*';
                  input.onchange = (e) => handleFileUpload(e);
                  input.click();
                }}>+ Upload</button>
              </div>
              {(fb.screenshots || []).length > 0 ? (
                <div class="screenshots-grid">
                  {fb.screenshots.map((s: any) => (
                    <div key={s.id} style="position:relative">
                      <img
                        class="screenshot-img"
                        src={`/api/v1/images/${s.id}${cacheBuster.value ? `?t=${cacheBuster.value}` : ''}`}
                        alt={s.filename}
                        onClick={() => {
                          lightboxSrc.value = `/api/v1/images/${s.id}${cacheBuster.value ? `?t=${cacheBuster.value}` : ''}`;
                          lightboxImageId.value = s.id;
                          lightboxFeedbackId.value = fb.id;
                          cropMode.value = false;
                        }}
                      />
                      <button
                        class="screenshot-delete-btn"
                        onClick={(e) => { e.stopPropagation(); deleteScreenshot(s.id); }}
                        title="Delete screenshot"
                      >&times;</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style="color:var(--pw-text-faint);font-size:13px;padding:12px 0">
                  No screenshots. Paste from clipboard, upload, or capture from a live session.
                </div>
              )}
            </section>

            {fb.dispatchedTo && (
              <section class="detail-section">
                <h4>Dispatch Info</h4>
                <div class="field-row">
                  <span class="field-label">Sent to</span>
                  <span class="field-value">{fb.dispatchedTo}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">At</span>
                  <span class="field-value">{fb.dispatchedAt ? formatDate(fb.dispatchedAt) : '—'}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Status</span>
                  <span class="field-value">
                    <span class={`badge ${fb.dispatchStatus === 'success' ? 'badge-resolved' : fb.dispatchStatus === 'running' ? 'badge-dispatched' : 'badge-new'}`}>
                      {fb.dispatchStatus}
                    </span>
                  </span>
                </div>
                {fb.dispatchResponse && (
                  <div style="margin-top:8px">
                    <div class="json-viewer" style="max-height:150px">{fb.dispatchResponse}</div>
                  </div>
                )}
              </section>
            )}

            {agentSessions.value.length > 0 && (
              <section class="detail-section">
                <h4>Agent Sessions ({agentSessions.value.length})</h4>
                <div class="session-list">
                  {agentSessions.value.map((s: any) => (
                    <div class="session-item" key={s.id}>
                      <div>
                        <span class="session-id" title="Click to copy full ID" onClick={(e: Event) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(s.id);
                          const el = e.currentTarget as HTMLElement;
                          const orig = el.textContent;
                          el.textContent = 'Copied!';
                          setTimeout(() => { el.textContent = orig; }, 1000);
                        }}>{s.id.slice(-8)}</span>
                        <span class={`session-status ${s.status}`} style="margin-left:6px">{s.status}</span>
                      </div>
                      <div style="display:flex;gap:4px">
                        <button
                          class="btn btn-sm"
                          onClick={() => openSession(s.id)}
                        >
                          {s.status === 'running' ? 'Attach' : 'View Log'}
                        </button>
                        {s.status !== 'running' && s.status !== 'pending' && (
                          <button
                            class="btn btn-sm btn-primary"
                            onClick={async () => {
                              const newId = await resumeSession(s.id);
                              if (newId) loadSessions(fb.id);
                            }}
                          >
                            Resume
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {liveConnections.value.length > 0 && (
              <section class="detail-section">
                <h4>Live Session Enrichment</h4>
                <div style="font-size:12px;color:var(--pw-text-muted);margin-bottom:8px">
                  Capture data from active widget sessions
                </div>
                {liveConnections.value.map((conn: any) => (
                  <div key={conn.sessionId} style="margin-bottom:8px;padding:8px;background:var(--pw-bg-sunken);border-radius:6px">
                    <div style="font-size:12px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px">
                      <span style="width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block" />
                      {conn.name || conn.sessionId.slice(-8)}
                    </div>
                    {conn.url && <div style="font-size:11px;color:var(--pw-text-faint);margin-bottom:6px;word-break:break-all">{conn.url}</div>}
                    <div style="display:flex;gap:4px;flex-wrap:wrap">
                      <button
                        class="btn btn-sm"
                        disabled={enrichLoading.value === `screenshot-${conn.sessionId}`}
                        onClick={() => captureFromSession(conn.sessionId)}
                      >
                        {enrichLoading.value === `screenshot-${conn.sessionId}` ? 'Capturing...' : 'Screenshot'}
                      </button>
                      <button
                        class="btn btn-sm"
                        disabled={enrichLoading.value === `console-${conn.sessionId}`}
                        onClick={() => enrichConsole(conn.sessionId)}
                      >
                        {enrichLoading.value === `console-${conn.sessionId}` ? 'Fetching...' : 'Console Logs'}
                      </button>
                      <button
                        class="btn btn-sm"
                        disabled={enrichLoading.value === `network-${conn.sessionId}`}
                        onClick={() => enrichNetwork(conn.sessionId)}
                      >
                        {enrichLoading.value === `network-${conn.sessionId}` ? 'Fetching...' : 'Network Errors'}
                      </button>
                      <button
                        class="btn btn-sm btn-primary"
                        disabled={enrichLoading.value === `append-${conn.sessionId}`}
                        onClick={() => triggerAppendMode(conn.sessionId)}
                      >
                        {enrichLoading.value === `append-${conn.sessionId}` ? 'Opening...' : 'Enrich with Widget'}
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {fb.context?.environment && (
              <section class="detail-section">
                <h4>Environment</h4>
                <div class="field-row">
                  <span class="field-label">Platform</span>
                  <span class="field-value">{fb.context.environment.platform}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Language</span>
                  <span class="field-value">{fb.context.environment.language}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Screen</span>
                  <span class="field-value">{fb.context.environment.screenResolution}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Referrer</span>
                  <span class="field-value" style="word-break:break-all">{fb.context.environment.referrer || '—'}</span>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {lightboxSrc.value && (
        <div class="sm-lightbox" onClick={() => {
          if (!cropMode.value) {
            lightboxSrc.value = null;
            lightboxImageId.value = null;
            lightboxFeedbackId.value = null;
          }
        }}>
          <div class="sm-lightbox-content" onClick={(e) => e.stopPropagation()}>
            {cropMode.value && lightboxImageId.value && lightboxFeedbackId.value ? (
              <CropEditor
                src={lightboxSrc.value}
                imageId={lightboxImageId.value}
                feedbackId={lightboxFeedbackId.value}
                onClose={() => (cropMode.value = false)}
                onSaved={(mode, newScreenshot) => {
                  if (mode === 'replace') {
                    cacheBuster.value = Date.now();
                    lightboxSrc.value = `/api/v1/images/${lightboxImageId.value}?t=${cacheBuster.value}`;
                  } else if (newScreenshot) {
                    const fb2 = feedback.value;
                    if (fb2) {
                      fb2.screenshots = [...(fb2.screenshots || []), { id: newScreenshot.id, filename: newScreenshot.filename }];
                      feedback.value = { ...fb2 };
                    }
                    lightboxImageId.value = newScreenshot.id;
                    lightboxSrc.value = `/api/v1/images/${newScreenshot.id}`;
                  }
                  cropMode.value = false;
                }}
              />
            ) : (
              <>
                <img src={lightboxSrc.value} alt="Screenshot (full)" />
                <button class="sm-lightbox-close" onClick={() => {
                  lightboxSrc.value = null;
                  lightboxImageId.value = null;
                  lightboxFeedbackId.value = null;
                }}>&times;</button>
                <div class="sm-lightbox-toolbar">
                  <button class="btn btn-sm" onClick={() => (cropMode.value = true)}>Edit</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
