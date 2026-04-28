import { useEffect, useRef, useState } from 'preact/hooks';
import {
  type CosFollowup,
  cancelCosFollowup,
  updateCosFollowup,
  setCosFollowupStatus,
} from '../lib/cos-followups.js';

/**
 * Pending-message list for client-side "send when current finishes" follow-ups.
 * Visually parallels the saved-drafts list (italic, dashed border) but each
 * row is editable inline. While any row in a group is being edited, the
 * auto-dispatcher pauses the whole group. Rows in the `sending` state are
 * read-only and show a "sending…" badge until they're removed from the queue.
 */
export function CosEnqueuedList({
  followups,
  scope,
}: {
  followups: CosFollowup[];
  /** Visual hint about where this list sits — "thread" rows render slightly
   *  more compact; "root" gets a header. */
  scope: 'thread' | 'root';
}) {
  if (followups.length === 0) return null;
  return (
    <div class={`cos-saved-drafts cos-enqueued-list cos-saved-drafts-${scope}`} role="list" aria-label="Queued messages">
      {scope === 'root' && (
        <div class="cos-saved-drafts-header">
          {followups.length} queued message{followups.length === 1 ? '' : 's'}
        </div>
      )}
      {followups.map((f) => (
        <CosEnqueuedRow key={f.id} followup={f} />
      ))}
    </div>
  );
}

function CosEnqueuedRow({ followup: f }: { followup: CosFollowup }) {
  const isEditing = f.status === 'editing';
  const isSending = f.status === 'sending';
  const [editText, setEditText] = useState(f.text);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync edit buffer if the underlying text changes from elsewhere
  // (e.g. a different tab via storage event) while we're not editing.
  useEffect(() => {
    if (!isEditing) setEditText(f.text);
  }, [f.text, isEditing]);

  useEffect(() => {
    if (isEditing) {
      editAreaRef.current?.focus();
      const el = editAreaRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 240) + 'px';
      }
    }
  }, [isEditing]);

  const trimmed = f.text.trim();
  const preview = trimmed.length > 240 ? trimmed.slice(0, 238) + '…' : trimmed;
  const hasAttachments = (f.attachments?.length ?? 0) > 0;
  const hasElements = (f.elementRefs?.length ?? 0) > 0;

  function startEdit() {
    if (isSending) return;
    setEditText(f.text);
    setCosFollowupStatus(f.id, 'editing');
  }

  function cancelEdit() {
    setEditText(f.text);
    setCosFollowupStatus(f.id, 'queued');
  }

  function saveEdit() {
    const next = editText;
    if (!next.trim()) {
      cancelCosFollowup(f.id);
      return;
    }
    updateCosFollowup(f.id, { text: next, status: 'queued' });
  }

  return (
    <div
      class={`cos-saved-draft-row cos-enqueued-row${isSending ? ' cos-enqueued-row-sending' : ''}${isEditing ? ' cos-enqueued-row-editing' : ''}`}
      role="listitem"
    >
      <span
        class={`cos-saved-draft-badge cos-enqueued-badge${isSending ? ' cos-enqueued-badge-sending' : ''}`}
        aria-hidden="true"
      >
        {isSending ? (
          <>
            <svg class="cos-enqueued-spinner" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            sending…
          </>
        ) : (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            queued
          </>
        )}
      </span>

      {isEditing ? (
        <textarea
          ref={editAreaRef}
          class="cos-enqueued-edit-input"
          value={editText}
          onInput={(e) => {
            const v = (e.target as HTMLTextAreaElement).value;
            setEditText(v);
            const el = editAreaRef.current;
            if (el) {
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 240) + 'px';
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              saveEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          }}
          rows={2}
          aria-label="Edit queued message"
        />
      ) : (
        <span
          class="cos-saved-draft-text"
          tabIndex={isSending ? -1 : 0}
          onClick={isSending ? undefined : startEdit}
          onKeyDown={isSending ? undefined : (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
          }}
          title={isSending ? 'Sending…' : 'Click to edit'}
        >
          {preview || <em class="cos-saved-draft-empty">(empty — attachments only)</em>}
        </span>
      )}

      {!isEditing && (hasAttachments || hasElements) && (
        <span class="cos-saved-draft-meta">
          {hasAttachments && <span title={`${f.attachments!.length} attachment${f.attachments!.length === 1 ? '' : 's'}`}>📎{f.attachments!.length}</span>}
          {hasElements && <span title={`${f.elementRefs!.length} element ref${f.elementRefs!.length === 1 ? '' : 's'}`}>⌖{f.elementRefs!.length}</span>}
        </span>
      )}

      {isEditing ? (
        <span class="cos-enqueued-edit-actions">
          <button
            type="button"
            class="cos-enqueued-edit-btn"
            onClick={saveEdit}
            title="Save edits (Enter)"
            aria-label="Save edits"
          >Save</button>
          <button
            type="button"
            class="cos-enqueued-edit-btn cos-enqueued-edit-btn-secondary"
            onClick={cancelEdit}
            title="Discard edits (Esc)"
            aria-label="Discard edits"
          >Cancel</button>
        </span>
      ) : !isSending ? (
        <button
          type="button"
          class="cos-saved-draft-delete"
          onClick={(e) => { e.stopPropagation(); cancelCosFollowup(f.id); }}
          title="Remove from queue"
          aria-label="Remove from queue"
        >×</button>
      ) : null}
    </div>
  );
}
