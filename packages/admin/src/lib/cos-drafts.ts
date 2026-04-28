// Per-(appId, agentId, threadId) operator compose drafts.
//
// Authoritative store is server-side (cos_drafts table); this module owns
// the hot mirror that drives the textarea hydrate, the per-tab "draft"
// indicator, and any per-thread reply UI. Writes push through a per-key
// debounce so a fast typist doesn't spam PUTs on every keystroke.

import { signal } from '@preact/signals';

// Keyed by `${appId}|${agentId}|${threadId}` — appId is '' for "no app
// scope" and threadId is '' for the "new top-level thread" compose draft.
// The `|` separator (vs `:`) keeps the key unambiguous even though ULIDs
// never contain a pipe.
export const cosDrafts = signal<Record<string, string>>({});

function draftKey(agentId: string, appId: string | null, threadId: string | null): string {
  return `${appId || ''}|${agentId}|${threadId || ''}`;
}

export function getCosDraft(
  agentId: string,
  appId: string | null,
  threadId: string | null = null,
): string {
  return cosDrafts.value[draftKey(agentId, appId, threadId)] || '';
}

/** True iff the agent has *any* non-empty draft (across all thread scopes) for this app. */
export function hasAnyCosDraftForAgent(agentId: string, appId: string | null): boolean {
  const prefix = `${appId || ''}|${agentId}|`;
  for (const k of Object.keys(cosDrafts.value)) {
    if (k.startsWith(prefix) && cosDrafts.value[k].length > 0) return true;
  }
  return false;
}

const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRAFT_SAVE_DEBOUNCE_MS = 400;

async function pushDraftToServer(
  agentId: string,
  appId: string | null,
  threadId: string | null,
  text: string,
): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch('/api/v1/admin/chief-of-staff/drafts', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        agentId,
        appId: appId ?? '',
        threadId: threadId ?? '',
        text,
      }),
    });
  } catch { /* best-effort; signal already updated locally */ }
}

/**
 * Update a draft optimistically (signal first, then debounced server PUT).
 * Pass empty `text` to clear. Designed to run on every textarea keystroke.
 */
export function setCosDraft(
  agentId: string,
  appId: string | null,
  threadId: string | null,
  text: string,
): void {
  const key = draftKey(agentId, appId, threadId);
  const next = { ...cosDrafts.value };
  if (text.length === 0) delete next[key];
  else next[key] = text;
  cosDrafts.value = next;

  const existing = draftSaveTimers.get(key);
  if (existing) clearTimeout(existing);
  draftSaveTimers.set(key, setTimeout(() => {
    draftSaveTimers.delete(key);
    void pushDraftToServer(agentId, appId, threadId, text);
  }, DRAFT_SAVE_DEBOUNCE_MS));
}

/** Clear a draft synchronously — flushes any pending debounce and pushes immediately. */
export function clearCosDraft(
  agentId: string,
  appId: string | null,
  threadId: string | null = null,
): void {
  const key = draftKey(agentId, appId, threadId);
  const existing = draftSaveTimers.get(key);
  if (existing) { clearTimeout(existing); draftSaveTimers.delete(key); }
  if (cosDrafts.value[key]) {
    const next = { ...cosDrafts.value };
    delete next[key];
    cosDrafts.value = next;
  }
  void pushDraftToServer(agentId, appId, threadId, '');
}

/** Hydrate the in-memory draft cache for a given app scope from the server. */
export async function loadCosDrafts(appId: string | null): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const qs = `?appId=${encodeURIComponent(appId ?? '')}`;
    const res = await fetch(`/api/v1/admin/chief-of-staff/drafts${qs}`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    const rows: Array<{ agentId?: string; appId?: string; threadId?: string; text?: string }> =
      Array.isArray(data?.drafts) ? data.drafts : [];
    const next = { ...cosDrafts.value };
    // Wipe any stale entries for this app scope before re-populating, so a
    // server-side delete (clear) propagates to the in-memory cache.
    const scope = appId || '';
    for (const k of Object.keys(next)) {
      if (k.startsWith(`${scope}|`)) delete next[k];
    }
    for (const r of rows) {
      const aid = typeof r.agentId === 'string' ? r.agentId : '';
      const ap = typeof r.appId === 'string' ? r.appId : '';
      const tid = typeof r.threadId === 'string' ? r.threadId : '';
      const t = typeof r.text === 'string' ? r.text : '';
      if (aid && t.length > 0) next[`${ap}|${aid}|${tid}`] = t;
    }
    cosDrafts.value = next;
  } catch { /* ignore */ }
}
