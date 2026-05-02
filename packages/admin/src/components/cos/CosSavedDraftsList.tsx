import { type CosSavedDraft } from '../../lib/cos-saved-drafts.js';

/**
 * Pending-message list rendered at the bottom of a thread (or the chat root
 * for top-level drafts). Each row is italic + dashed-bordered to make it
 * obvious that the message hasn't been sent yet. Click loads it into the
 * composer (caller's `onLoad` handles the swap with the composer's current
 * state). Delete removes the draft.
 */
export function CosSavedDraftsList({
  drafts,
  onLoad,
  onDelete,
  scope,
}: {
  drafts: CosSavedDraft[];
  onLoad: (draft: CosSavedDraft) => void;
  onDelete: (draft: CosSavedDraft) => void;
  /** Visual hint about where this list sits — "thread" rows render slightly
   *  more compact; "root" gets a header. */
  scope: 'thread' | 'root';
}) {
  if (drafts.length === 0) return null;
  return (
    <div class={`cos-saved-drafts cos-saved-drafts-${scope}`} role="list" aria-label="Saved drafts">
      {scope === 'root' && (
        <div class="cos-saved-drafts-header">
          {drafts.length} draft{drafts.length === 1 ? '' : 's'} pending
        </div>
      )}
      {drafts.map((d) => {
        const trimmed = d.text.trim();
        const preview = trimmed.length > 240 ? trimmed.slice(0, 238) + '…' : trimmed;
        const hasAttachments = (d.attachments?.length ?? 0) > 0;
        const hasElements = (d.elementRefs?.length ?? 0) > 0;
        return (
          <div
            class="cos-saved-draft-row"
            role="listitem"
            key={d.id}
            title="Click to load this draft into the composer (your current text gets stashed)"
            tabIndex={0}
            onClick={() => onLoad(d)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLoad(d); }
            }}
          >
            <span class="cos-saved-draft-badge" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              draft
            </span>
            <span class="cos-saved-draft-text">{preview || <em class="cos-saved-draft-empty">(empty — attachments only)</em>}</span>
            {(hasAttachments || hasElements) && (
              <span class="cos-saved-draft-meta">
                {hasAttachments && <span title={`${d.attachments!.length} attachment${d.attachments!.length === 1 ? '' : 's'}`}>📎{d.attachments!.length}</span>}
                {hasElements && <span title={`${d.elementRefs!.length} element ref${d.elementRefs!.length === 1 ? '' : 's'}`}>⌖{d.elementRefs!.length}</span>}
              </span>
            )}
            <button
              type="button"
              class="cos-saved-draft-delete"
              onClick={(e) => { e.stopPropagation(); onDelete(d); }}
              title="Discard this draft"
              aria-label="Discard draft"
            >×</button>
          </div>
        );
      })}
    </div>
  );
}
