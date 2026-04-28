// Explicit "saved drafts" — distinct from cos-drafts.ts, which is the
// per-scope live mirror of the textarea. A saved draft is a stashed
// pending message that the operator chose not to send. It lives in a
// list keyed by `(agentId, appId, threadId)` and renders as an italic
// pending row at the bottom of its thread (or the chat root for
// top-level drafts). Clicking one loads it back into the composer; if
// the composer already had text, that text is stashed in its place.

import { signal, effect } from '@preact/signals';
import {
  type CosImageAttachment,
  type CosElementRef,
} from './chief-of-staff.js';

const STORAGE_KEY = 'pw-cos-saved-drafts-v1';

export type CosSavedDraft = {
  id: string;
  agentId: string;
  // '' for "no app scope" — matches cos-drafts.ts convention.
  appId: string;
  // '' for top-level (new-thread) drafts; otherwise the cosThread server id.
  threadId: string;
  // Set when the draft was composed inside a "Reply in thread" scope. The
  // bubble uses this to route replies back to the anchor user message.
  replyToTs?: number;
  text: string;
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
  createdAt: number;
  updatedAt: number;
};

function loadAll(): CosSavedDraft[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d: any) =>
      d && typeof d.id === 'string'
      && typeof d.agentId === 'string'
      && typeof d.text === 'string',
    );
  } catch { return []; }
}

export const cosSavedDrafts = signal<CosSavedDraft[]>(loadAll());

// Last serialized payload the effect wrote (or the storage listener consumed).
// Used to short-circuit echo loops: when window A writes, window B's storage
// listener applies the change and its own effect fires with an identical
// payload — we skip the redundant setItem so it doesn't bounce back.
let _lastSerialized: string | null = null;

function slimify(list: CosSavedDraft[]): unknown[] {
  // Strip image dataUrls before persisting — they can balloon localStorage's
  // ~5 MB quota fast. Keep the shape so the list still renders, but tag the
  // attachment so the UI can warn the operator that the image was lost.
  return list.map((d) => ({
    ...d,
    attachments: d.attachments?.map((att) => ({
      kind: att.kind,
      name: att.name,
      // Empty dataUrl == "image lost on reload"
      dataUrl: att.dataUrl?.startsWith('data:') ? att.dataUrl : '',
    })),
  }));
}

effect(() => {
  const v = cosSavedDrafts.value;
  try {
    if (typeof localStorage === 'undefined') return;
    const serialized = JSON.stringify(slimify(v));
    if (serialized === _lastSerialized) return;
    _lastSerialized = serialized;
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch { /* quota — ignore */ }
});

// Cross-window sync: when another tab/window writes the same key, refresh the
// signal so the saved-drafts list re-renders here too. Storage events only
// fire in *other* windows per spec, so there's no own-write echo from this
// listener — but the resulting effect would re-write the same JSON, which we
// suppress via `_lastSerialized` above.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    if (e.newValue === _lastSerialized) return;
    _lastSerialized = e.newValue;
    cosSavedDrafts.value = loadAll();
  });
}

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `cosdraft-${Date.now().toString(36)}-${_idCounter}`;
}

/** Returns the new draft id. */
export function saveCosDraft(input: {
  agentId: string;
  appId: string | null;
  threadId: string | null;
  replyToTs?: number;
  text: string;
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
}): string {
  const now = Date.now();
  const draft: CosSavedDraft = {
    id: nextId(),
    agentId: input.agentId,
    appId: input.appId ?? '',
    threadId: input.threadId ?? '',
    replyToTs: input.replyToTs,
    text: input.text,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
    elementRefs: input.elementRefs && input.elementRefs.length > 0 ? input.elementRefs : undefined,
    createdAt: now,
    updatedAt: now,
  };
  cosSavedDrafts.value = [...cosSavedDrafts.value, draft];
  return draft.id;
}

export function deleteCosDraft(id: string): CosSavedDraft | null {
  const found = cosSavedDrafts.value.find((d) => d.id === id) || null;
  if (!found) return null;
  cosSavedDrafts.value = cosSavedDrafts.value.filter((d) => d.id !== id);
  return found;
}

/** Drafts attached to a specific thread (`threadId !== ''`) for this agent + app. */
export function getThreadSavedDrafts(
  agentId: string,
  appId: string | null,
  threadId: string,
): CosSavedDraft[] {
  if (!threadId) return [];
  const ap = appId ?? '';
  return cosSavedDrafts.value.filter(
    (d) => d.agentId === agentId && d.appId === ap && d.threadId === threadId,
  );
}

/** Top-level (new-thread) drafts for this agent + app. */
export function getRootSavedDrafts(
  agentId: string,
  appId: string | null,
): CosSavedDraft[] {
  const ap = appId ?? '';
  return cosSavedDrafts.value.filter(
    (d) => d.agentId === agentId && d.appId === ap && d.threadId === '',
  );
}

/** All drafts for this agent + app, ordered newest last. */
export function getAllSavedDrafts(
  agentId: string,
  appId: string | null,
): CosSavedDraft[] {
  const ap = appId ?? '';
  return cosSavedDrafts.value.filter(
    (d) => d.agentId === agentId && d.appId === ap,
  );
}

/** Set of threadIds that have at least one saved draft (for filter lookups). */
export function getThreadIdsWithDrafts(
  agentId: string,
  appId: string | null,
): Set<string> {
  const ap = appId ?? '';
  const out = new Set<string>();
  for (const d of cosSavedDrafts.value) {
    if (d.agentId === agentId && d.appId === ap && d.threadId) {
      out.add(d.threadId);
    }
  }
  return out;
}
