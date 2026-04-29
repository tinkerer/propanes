// Per-cosThread sessionId map + per-thread meta (status, resolved, archived).
//
// `cosThreadSessions` answers "which agentSession backs this thread" so the
// rail can deep-link into the jsonl viewer without hitting the server.
// `cosThreadMeta` carries the operator-set flags (resolved/archived) plus
// the last-known sessionStatus so the rail dot can color-code itself.
//
// Both signals are seeded from the threads array returned by the
// /chief-of-staff/history and /chief-of-staff/threads endpoints — call
// `mergeThreadSessions` / `mergeThreadMeta` whenever fresh thread rows
// arrive.

import { signal } from '@preact/signals';
import { adminHeaders } from './admin-headers.js';

// threadId → backing agentSessionId. Each cosThread owns exactly one
// persistent headless-stream agent session; this map lets the UI jump
// straight to its jsonl log without round-tripping the server.
export const cosThreadSessions = signal<Record<string, string>>({});

export function mergeThreadSessions(
  threads: Array<{ id?: unknown; agentSessionId?: unknown }>,
): void {
  if (!Array.isArray(threads) || threads.length === 0) return;
  const next = { ...cosThreadSessions.value };
  let changed = false;
  for (const t of threads) {
    const tid = typeof t?.id === 'string' ? t.id : null;
    const sid = typeof t?.agentSessionId === 'string' ? t.agentSessionId : null;
    if (tid && sid && next[tid] !== sid) {
      next[tid] = sid;
      changed = true;
    }
  }
  if (changed) cosThreadSessions.value = next;
}

export function getSessionIdForThread(threadId: string | undefined | null): string | null {
  if (!threadId) return null;
  return cosThreadSessions.value[threadId] ?? null;
}

// Per-thread health derived from the joined agentSessions row (server-side)
// plus the operator-set resolved flag. Drives the rail status indicator and
// the inline resolve toggle. sessionStatus = null when the underlying agent
// session was garbage collected (gray "no session" state).
export type CosThreadMeta = {
  sessionStatus: string | null;
  resolvedAt: number | null;
  archivedAt: number | null;
  // The backing agent session's permissionProfile (e.g. 'interactive-yolo'
  // vs 'headless-stream-yolo'). Drives the rail's interactive-mode glyph
  // and the "Open as interactive" button copy ("Open" vs "Convert to
  // interactive").
  sessionPermissionProfile: string | null;
};
export const cosThreadMeta = signal<Record<string, CosThreadMeta>>({});

export function mergeThreadMeta(
  threads: Array<{
    id?: unknown;
    sessionStatus?: unknown;
    resolvedAt?: unknown;
    archivedAt?: unknown;
    sessionPermissionProfile?: unknown;
  }>,
): void {
  if (!Array.isArray(threads) || threads.length === 0) return;
  const next = { ...cosThreadMeta.value };
  let changed = false;
  for (const t of threads) {
    const tid = typeof t?.id === 'string' ? t.id : null;
    if (!tid) continue;
    const sessionStatus = typeof t.sessionStatus === 'string' ? t.sessionStatus : null;
    const resolvedAt = typeof t.resolvedAt === 'number' ? t.resolvedAt : null;
    const archivedAt = typeof t.archivedAt === 'number' ? t.archivedAt : null;
    const sessionPermissionProfile =
      typeof t.sessionPermissionProfile === 'string' ? t.sessionPermissionProfile : null;
    const prev = next[tid];
    if (
      !prev ||
      prev.sessionStatus !== sessionStatus ||
      prev.resolvedAt !== resolvedAt ||
      prev.archivedAt !== archivedAt ||
      prev.sessionPermissionProfile !== sessionPermissionProfile
    ) {
      next[tid] = { sessionStatus, resolvedAt, archivedAt, sessionPermissionProfile };
      changed = true;
    }
  }
  if (changed) cosThreadMeta.value = next;
}

export function getThreadMeta(threadId: string | undefined | null): CosThreadMeta | null {
  if (!threadId) return null;
  return cosThreadMeta.value[threadId] ?? null;
}

// Threads currently animating out of the visible list after resolve/archive.
// The visibility filter keeps these threads mounted while the CSS collapse
// animation runs; the entry auto-clears when the timer fires.
export const leavingThreadIds = signal<Set<string>>(new Set());

export const LEAVING_ANIMATION_MS = 280;

export function markThreadLeaving(threadId: string): void {
  if (!threadId) return;
  if (leavingThreadIds.value.has(threadId)) return;
  const next = new Set(leavingThreadIds.value);
  next.add(threadId);
  leavingThreadIds.value = next;
  setTimeout(() => {
    if (!leavingThreadIds.value.has(threadId)) return;
    const cur = new Set(leavingThreadIds.value);
    cur.delete(threadId);
    leavingThreadIds.value = cur;
  }, LEAVING_ANIMATION_MS);
}

export function isThreadLeaving(threadId: string | undefined | null): boolean {
  if (!threadId) return false;
  return leavingThreadIds.value.has(threadId);
}

const EMPTY_THREAD_META: CosThreadMeta = {
  sessionStatus: null,
  resolvedAt: null,
  archivedAt: null,
  sessionPermissionProfile: null,
};

async function patchThreadFlags(
  threadId: string,
  body: { resolved?: boolean; archived?: boolean },
  optimistic: Partial<CosThreadMeta>,
): Promise<void> {
  const prev = cosThreadMeta.value[threadId] ?? EMPTY_THREAD_META;
  cosThreadMeta.value = {
    ...cosThreadMeta.value,
    [threadId]: { ...prev, ...optimistic },
  };
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...adminHeaders() };
    const res = await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
    const data = (await res.json().catch(() => null)) as
      | { resolvedAt?: unknown; archivedAt?: unknown }
      | null;
    const serverResolvedAt = typeof data?.resolvedAt === 'number' ? data.resolvedAt : null;
    const serverArchivedAt = typeof data?.archivedAt === 'number' ? data.archivedAt : null;
    cosThreadMeta.value = {
      ...cosThreadMeta.value,
      [threadId]: { ...prev, resolvedAt: serverResolvedAt, archivedAt: serverArchivedAt },
    };
  } catch {
    cosThreadMeta.value = { ...cosThreadMeta.value, [threadId]: prev };
  }
}

/**
 * Toggle the resolved flag on a thread. Optimistically updates the local
 * signal so the rail re-renders immediately, then PATCHes the server.
 */
export async function setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  await patchThreadFlags(threadId, { resolved }, { resolvedAt: resolved ? Date.now() : null });
}

/**
 * Toggle the archived flag on a thread. Archiving a thread also implicitly
 * resolves it (server-side); unarchiving leaves the resolved state alone.
 */
export async function setThreadArchived(threadId: string, archived: boolean): Promise<void> {
  const optimistic: Partial<CosThreadMeta> = archived
    ? { archivedAt: Date.now(), resolvedAt: cosThreadMeta.value[threadId]?.resolvedAt ?? Date.now() }
    : { archivedAt: null };
  await patchThreadFlags(threadId, { archived }, optimistic);
}
