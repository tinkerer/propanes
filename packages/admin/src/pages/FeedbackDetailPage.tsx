import { useSignal, useSignalEffect } from '@preact/signals';
import { useRef, useEffect } from 'preact/hooks';
import { marked } from 'marked';
import { api } from '../lib/api.js';
import { navigate } from '../lib/state.js';
import { openSession, resumeSession, feedbackTitleCache } from '../lib/sessions.js';
import { copyText, copyWithTooltip } from '../lib/clipboard.js';
import { CropEditor } from '../components/CropEditor.js';
import { openDispatchDialog, dispatchDialogResult } from '../components/DispatchDialog.js';
import { VoicePlayback } from '../components/VoicePlayback.js';
import { formatDate } from '../lib/date-utils.js';
import { ElementCard } from '../components/ElementCard.js';
import { SpecView, SpecToolbar } from '../components/SpecView.js';
import { fetchParent, fetchChildren, fetchSiblings, fetchComputedStyles } from '../lib/dom-traversal.js';

import type { Signal } from '@preact/signals';

marked.setOptions({ gfm: true, breaks: true });

const STATUSES = ['new', 'reviewed', 'dispatched', 'resolved', 'archived'];

function DescriptionEditor({ value, onChange, onCancel, onSave, elements, screenshots }: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  elements: any[];
  screenshots: { id: string; filename?: string }[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div style="margin-bottom:16px">
      {(elements.length > 0 || screenshots.length > 0) && (
        <SpecToolbar
          elements={elements}
          screenshots={screenshots}
          textareaRef={textareaRef}
          onInsert={(newVal) => onChange(newVal)}
        />
      )}
      <textarea
        value={value}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave();
        }}
        style="width:100%;padding:10px 12px;font-size:14px;min-height:80px;resize:vertical;font-family:inherit;background:var(--pw-input-bg);color:var(--pw-primary-text);border:1px solid var(--pw-accent);border-radius:6px;box-sizing:border-box"
        ref={(el) => { if (el) { textareaRef.current = el; el.focus(); } }}
      />
      <div style="display:flex;gap:4px;justify-content:flex-end;margin-top:6px">
        <button class="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button class="btn btn-sm btn-primary" onClick={onSave}>Save</button>
      </div>
    </div>
  );
}

function DescriptionDisplay({ fb, onEdit, onScreenshotClick, liveConnections, expandedElements, specViewMode, domTraversalLoading, cacheBuster, feedback }: {
  fb: any;
  onEdit: () => void;
  onScreenshotClick: (ss: any) => void;
  liveConnections: Signal<any[]>;
  expandedElements: Signal<Set<number>>;
  specViewMode: Signal<'inline' | 'side'>;
  domTraversalLoading: Signal<string | null>;
  cacheBuster: Signal<number>;
  feedback: Signal<any>;
}) {
  const elements: any[] = fb.data?.selectedElements || (fb.data?.selectedElement ? [fb.data.selectedElement] : []);
  const screenshots: { id: string; filename?: string }[] = fb.screenshots || [];
  const hasTokens = fb.description && /\{\{(element|screenshot):[^}]+\}\}/.test(fb.description);
  const hasLive = liveConnections.value.length > 0;
  const liveSessionId = liveConnections.value[0]?.sessionId;

  if (!hasTokens && !elements.length) {
    return (
      <div
        class={`detail-description markdown-body${!fb.description ? ' detail-description-empty' : ''}`}
        title="Click to edit"
        onClick={onEdit}
        dangerouslySetInnerHTML={fb.description ? { __html: marked.parse(fb.description) as string } : undefined}
      >
        {fb.description ? undefined : 'No description'}
      </div>
    );
  }

  return (
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <button
          class="btn btn-sm"
          onClick={onEdit}
          title="Edit description"
        >
          Edit
        </button>
        <div class="spec-mode-toggle">
          <button
            class={`btn btn-sm${specViewMode.value === 'inline' ? ' btn-primary' : ''}`}
            onClick={() => (specViewMode.value = 'inline')}
          >Inline</button>
          <button
            class={`btn btn-sm${specViewMode.value === 'side' ? ' btn-primary' : ''}`}
            onClick={() => (specViewMode.value = 'side')}
          >Side</button>
        </div>
      </div>
      <SpecView
        description={fb.description || ''}
        elements={elements}
        screenshots={screenshots}
        expandedElements={expandedElements.value}
        onToggleElement={(idx) => {
          const next = new Set(expandedElements.value);
          if (next.has(idx)) next.delete(idx); else next.add(idx);
          expandedElements.value = next;
        }}
        onFetchParent={hasLive ? async (idx) => {
          if (!liveSessionId || !elements[idx]?.selector) return;
          domTraversalLoading.value = `parent-${idx}`;
          try {
            const parent = await fetchParent(liveSessionId, elements[idx].selector);
            if (parent) {
              const updated = [...elements, parent];
              await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
              fb.data = { ...fb.data, selectedElements: updated };
              feedback.value = { ...fb };
            }
          } finally { domTraversalLoading.value = null; }
        } : undefined}
        onFetchChildren={hasLive ? async (idx) => {
          if (!liveSessionId || !elements[idx]?.selector) return;
          domTraversalLoading.value = `children-${idx}`;
          try {
            const children = await fetchChildren(liveSessionId, elements[idx].selector);
            if (children.length) {
              const updated = [...elements, ...children];
              await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
              fb.data = { ...fb.data, selectedElements: updated };
              feedback.value = { ...fb };
            }
          } finally { domTraversalLoading.value = null; }
        } : undefined}
        onFetchSiblings={hasLive ? async (idx) => {
          if (!liveSessionId || !elements[idx]?.selector) return;
          domTraversalLoading.value = `siblings-${idx}`;
          try {
            const siblings = await fetchSiblings(liveSessionId, elements[idx].selector);
            if (siblings.length) {
              const updated = [...elements, ...siblings];
              await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
              fb.data = { ...fb.data, selectedElements: updated };
              feedback.value = { ...fb };
            }
          } finally { domTraversalLoading.value = null; }
        } : undefined}
        onFetchStyles={hasLive ? async (idx) => {
          if (!liveSessionId || !elements[idx]?.selector) return;
          domTraversalLoading.value = `styles-${idx}`;
          try {
            const styles = await fetchComputedStyles(liveSessionId, elements[idx].selector);
            if (Object.keys(styles).length) {
              elements[idx].computedStyles = styles;
              const updated = [...elements];
              await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
              fb.data = { ...fb.data, selectedElements: updated };
              feedback.value = { ...fb };
            }
          } finally { domTraversalLoading.value = null; }
        } : undefined}
        onScreenshotClick={onScreenshotClick}
        hasLiveSession={hasLive}
        traversalLoading={domTraversalLoading.value}
        mode={specViewMode.value}
        cacheBuster={cacheBuster.value}
      />
    </div>
  );
}

export function FeedbackDetailPage({ id, appId, embedded }: { id: string; appId: string | null; embedded?: boolean }) {
  const feedback = useSignal<any>(null);
  const loading = useSignal(true);
  const error = useSignal('');
  const newTag = useSignal('');
  const agentSessions = useSignal<any[]>([]);
  const lastLoadedId = useSignal<string | null>(null);
  const lightboxSrc = useSignal<string | null>(null);
  const lightboxImageId = useSignal<string | null>(null);
  const lightboxFeedbackId = useSignal<string | null>(null);
  const cropMode = useSignal(false);
  const cacheBuster = useSignal(0);
  const editingTitle = useSignal(false);
  const editTitleValue = useSignal('');
  const editingDescription = useSignal(false);
  const editDescValue = useSignal('');
  const liveConnections = useSignal<any[]>([]);
  const enrichLoading = useSignal<string | null>(null);
  const expandedElements = useSignal<Set<number>>(new Set());
  const specViewMode = useSignal<'inline' | 'side'>('inline');
  const domTraversalLoading = useSignal<string | null>(null);

  const currentDetailAppIdRef = useRef<string | null>(null);

  async function load(loadId: string, loadAppId: string | null) {
    loading.value = true;
    error.value = '';
    lastLoadedId.value = loadId;
    currentDetailAppIdRef.current = loadAppId;
    try {
      const fb = await api.getFeedbackById(loadId);
      feedback.value = fb;
      if (fb?.title) {
        feedbackTitleCache.value = { ...feedbackTitleCache.value, [loadId]: fb.title };
      }
      loadSessions(loadId);
      loadLiveConnections(fb.appId);
    } catch (err: any) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  }

  async function loadLiveConnections(liveAppId?: string) {
    try {
      const all = await api.getLiveConnections();
      liveConnections.value = liveAppId ? all.filter((s: any) => s.appId === liveAppId) : all;
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
    if (currentDetailAppIdRef.current) {
      navigate(`/app/${currentDetailAppIdRef.current}/feedback`);
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

  function openDispatch() {
    const fb = feedback.value;
    if (!fb) return;
    openDispatchDialog([fb.id], fb.appId);
  }

  // Refresh feedback + sessions after a dispatch from the dialog
  useSignalEffect(() => {
    if (dispatchDialogResult.value !== 'dispatched') return;
    const fb = feedback.value;
    if (fb) {
      api.getFeedbackById(fb.id).then((updated) => { feedback.value = updated; }).catch(() => {});
      loadSessions(fb.id);
    }
    dispatchDialogResult.value = 'idle';
  });

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

  // Lightbox escape handler
  useSignalEffect(() => {
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

  // Paste handler: paste images from clipboard to add as screenshots
  useSignalEffect(() => {
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

  useEffect(() => {
    if (lastLoadedId.value !== id) {
      load(id, appId);
    }
  }, [id, appId]);

  if (loading.value || lastLoadedId.value !== id) return <div>Loading...</div>;
  if (error.value) return <div class="error-msg">{error.value}</div>;

  const fb = feedback.value;
  if (!fb) return <div>Not found</div>;

  const backPath = appId ? `/app/${appId}/feedback` : '/';

  return (
    <div>
      <div class="page-header">
        <div>
          {!embedded && (
            <a href={`#${backPath}`} onClick={(e) => { e.preventDefault(); navigate(backPath); }} style="color:var(--pw-text-muted);text-decoration:none;font-size:13px">
              &larr; Back to list
            </a>
          )}
          <h2 style={embedded ? undefined : "margin-top:4px"}>
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
          {Array.isArray(fb.titleHistory) && fb.titleHistory.length > 0 && (
            <details class="title-history" style="margin-top:4px;font-size:12px;color:var(--pw-text-muted)">
              <summary style="cursor:pointer">Previous titles ({fb.titleHistory.length})</summary>
              <ul style="margin:4px 0 0 0;padding-left:16px;list-style:disc">
                {[...fb.titleHistory].reverse().map((h: any, i: number) => (
                  <li key={i} style="margin-bottom:2px">
                    <span style="text-decoration:line-through;color:var(--pw-text-faint)">{h.title}</span>
                    {h.changedAt && (
                      <span style="margin-left:6px;font-size:11px;color:var(--pw-text-faint)">{formatDate(h.changedAt)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-ghost-danger" onClick={deleteFeedback}>Delete</button>
        </div>
      </div>

      <div class="dispatch-bar dispatch-bar-styled">
        <div class="dispatch-bar-label">Dispatch</div>
        <div class="dispatch-bar-controls">
          <button
            class="btn btn-primary dispatch-bar-btn"
            onClick={openDispatch}
            title="Open dispatch options (Interactive, YOLO, Wiggum, FAFO...)"
          >
            Dispatch{'\u2026'}
          </button>
        </div>
      </div>

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
              <DescriptionEditor
                value={editDescValue.value}
                onChange={(v: string) => (editDescValue.value = v)}
                onCancel={() => (editingDescription.value = false)}
                onSave={saveDescription}
                elements={fb.data?.selectedElements || (fb.data?.selectedElement ? [fb.data.selectedElement] : [])}
                screenshots={fb.screenshots || []}
              />
            ) : (
              <DescriptionDisplay
                fb={fb}
                onEdit={() => { editDescValue.value = fb.description || ''; editingDescription.value = true; }}
                onScreenshotClick={(ss: any) => {
                  lightboxSrc.value = `/api/v1/images/${ss.id}${cacheBuster.value ? `?t=${cacheBuster.value}` : ''}`;
                  lightboxImageId.value = ss.id;
                  lightboxFeedbackId.value = fb.id;
                  cropMode.value = false;
                }}
                liveConnections={liveConnections}
                expandedElements={expandedElements}
                specViewMode={specViewMode}
                domTraversalLoading={domTraversalLoading}
                cacheBuster={cacheBuster}
                feedback={feedback}
              />
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
              const hasLive = liveConnections.value.length > 0;
              const liveSessionId = liveConnections.value[0]?.sessionId;

              async function handleFetchParent(idx: number) {
                if (!liveSessionId || !elements[idx]?.selector) return;
                domTraversalLoading.value = `parent-${idx}`;
                try {
                  const parent = await fetchParent(liveSessionId, elements[idx].selector);
                  if (parent) {
                    const updated = [...elements, parent];
                    await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
                    fb.data.selectedElements = updated;
                    feedback.value = { ...fb };
                  }
                } finally { domTraversalLoading.value = null; }
              }

              async function handleFetchChildren(idx: number) {
                if (!liveSessionId || !elements[idx]?.selector) return;
                domTraversalLoading.value = `children-${idx}`;
                try {
                  const children = await fetchChildren(liveSessionId, elements[idx].selector);
                  if (children.length) {
                    const updated = [...elements, ...children];
                    await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
                    fb.data.selectedElements = updated;
                    feedback.value = { ...fb };
                  }
                } finally { domTraversalLoading.value = null; }
              }

              async function handleFetchSiblings(idx: number) {
                if (!liveSessionId || !elements[idx]?.selector) return;
                domTraversalLoading.value = `siblings-${idx}`;
                try {
                  const siblings = await fetchSiblings(liveSessionId, elements[idx].selector);
                  if (siblings.length) {
                    const updated = [...elements, ...siblings];
                    await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
                    fb.data.selectedElements = updated;
                    feedback.value = { ...fb };
                  }
                } finally { domTraversalLoading.value = null; }
              }

              async function handleFetchStyles(idx: number) {
                if (!liveSessionId || !elements[idx]?.selector) return;
                domTraversalLoading.value = `styles-${idx}`;
                try {
                  const styles = await fetchComputedStyles(liveSessionId, elements[idx].selector);
                  if (Object.keys(styles).length) {
                    elements[idx].computedStyles = styles;
                    const updated = [...elements];
                    await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
                    fb.data.selectedElements = updated;
                    feedback.value = { ...fb };
                  }
                } finally { domTraversalLoading.value = null; }
              }

              async function handleRemoveElement(idx: number) {
                const updated = elements.filter((_: any, i: number) => i !== idx);
                await api.updateFeedback(fb.id, { data: { ...fb.data, selectedElements: updated } });
                fb.data.selectedElements = updated;
                expandedElements.value = new Set([...expandedElements.value].filter((i) => i !== idx).map((i) => i > idx ? i - 1 : i));
                feedback.value = { ...fb };
              }

              function handleInsertIntoSpec(idx: number) {
                const token = `{{element:${idx}}}`;
                const desc = fb.description || '';
                const newDesc = desc ? desc + '\n\n' + token : token;
                editDescValue.value = newDesc;
                editingDescription.value = true;
              }

              return (
                <section class="detail-section">
                  <h4>Selected Element{elements.length > 1 ? 's' : ''} ({elements.length})</h4>
                  <div style="display:flex;flex-direction:column;gap:6px">
                    {elements.map((el: any, i: number) => (
                      <ElementCard
                        key={i}
                        element={el}
                        index={i}
                        expanded={expandedElements.value.has(i)}
                        onToggle={() => {
                          const next = new Set(expandedElements.value);
                          if (next.has(i)) next.delete(i); else next.add(i);
                          expandedElements.value = next;
                        }}
                        onFetchParent={() => handleFetchParent(i)}
                        onFetchChildren={() => handleFetchChildren(i)}
                        onFetchSiblings={() => handleFetchSiblings(i)}
                        onFetchStyles={() => handleFetchStyles(i)}
                        onRemove={() => handleRemoveElement(i)}
                        onInsertIntoSpec={() => handleInsertIntoSpec(i)}
                        hasLiveSession={hasLive}
                        traversalLoading={domTraversalLoading.value}
                      />
                    ))}
                  </div>
                </section>
              );
            })()}

            {fb.data?.voiceRecording && (fb.audioFiles?.length > 0 ? (
              <section class="detail-section">
                <h4>Voice Recording</h4>
                <VoicePlayback
                  audioUrl={`/api/v1/audio/${fb.audioFiles[0].id}`}
                  duration={fb.data.voiceRecording.duration || 0}
                  transcript={fb.data.voiceRecording.transcript || []}
                  interactions={fb.data.voiceRecording.interactions || []}
                  consoleLogs={fb.data.voiceRecording.consoleLogs || []}
                />
              </section>
            ) : (
              <section class="detail-section">
                <h4>Voice Recording (transcript only)</h4>
                <div style="font-size:13px;color:var(--pw-text)">
                  {(fb.data.voiceRecording.transcript || []).map((seg: any, i: number) => (
                    <span key={i} style="margin-right:4px">{seg.text}</span>
                  ))}
                </div>
              </section>
            ))}

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
                          copyText(s.id);
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
