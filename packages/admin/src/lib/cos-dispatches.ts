import { signal } from '@preact/signals';
import { api } from './api.js';

export type CosLink = {
  threadId: string;
  name: string;
  agentId: string;
  createdAt: number;
};

// Shared CoS-dispatch lookup tables, kept module-level so every view (sidebar
// list, sessions page, etc.) reads the same data. `sessionToCos` is the precise
// link (parsed from dispatch result); `feedbackToCos` is the fallback when the
// result couldn't be parsed. Most-recent dispatch wins.
export const sessionToCos = signal<Map<string, CosLink>>(new Map());
export const feedbackToCos = signal<Map<string, CosLink>>(new Map());

export async function loadCosDispatches(): Promise<void> {
  try {
    const { dispatches } = await api.getCosDispatches();
    // Endpoint orders dispatches newest-first, so the *last* write to each
    // map key wins — flip iteration so the newest dispatch ends up persisted.
    const sMap = new Map<string, CosLink>();
    const fMap = new Map<string, CosLink>();
    for (let i = dispatches.length - 1; i >= 0; i--) {
      const d = dispatches[i];
      const link: CosLink = {
        threadId: d.cosThreadId,
        name: d.cosThreadName,
        agentId: d.cosAgentId,
        createdAt: d.createdAt,
      };
      if (d.sessionId) sMap.set(d.sessionId, link);
      fMap.set(d.feedbackId, link);
    }
    sessionToCos.value = sMap;
    feedbackToCos.value = fMap;
  } catch {
    // non-fatal — views still render flat
  }
}

export function cosLinkFor(sessionId: string, feedbackId?: string | null): CosLink | null {
  const bySession = sessionToCos.value.get(sessionId);
  if (bySession) return bySession;
  if (feedbackId) return feedbackToCos.value.get(feedbackId) || null;
  return null;
}

/**
 * Resolve the CoS group for a session row. A chat-turn session carries its
 * thread id directly on the row (cos_thread_id); older CoS-dispatched sessions
 * (where the CoS ran a curl POST /dispatch) are linked through the parsed
 * dispatch map. Direct linkage wins so new chat turns show up immediately
 * without waiting for loadCosDispatches() to refresh.
 */
export function cosGroupForSession(s: {
  id: string;
  feedbackId?: string | null;
  cosThreadId?: string | null;
  cosThreadName?: string | null;
  cosThreadAgentId?: string | null;
}): CosLink | null {
  if (s.cosThreadId) {
    return {
      threadId: s.cosThreadId,
      name: s.cosThreadName || 'Ops',
      agentId: s.cosThreadAgentId || 'default',
      createdAt: 0,
    };
  }
  return cosLinkFor(s.id, s.feedbackId);
}
