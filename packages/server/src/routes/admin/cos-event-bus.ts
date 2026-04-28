// In-memory event bus for live Chief-of-Staff turns.
//
// The chat POST returns 202 immediately and consumers read events via the
// long-lived /threads/:id/events SSE. This module owns the cross-handler
// fanout: route handlers publish bus events; SSE handlers subscribe.
//
// Two parallel buses:
//   - threadEventBus: per-thread fanout, used by /threads/:id/events.
//   - agentEventBus: per-agent fanout, used by /agents/:agentId/stream so
//     the bubble can listen to all of an agent's threads with one socket.
//
// Plus two replay caches keyed by turnId, so a subscriber that reconnects or
// joins late doesn't miss anything:
//   - turnReplayBuffers: ring of claude_event lines for an in-flight turn.
//   - turnFinalStatus: the final completed/failed status, retained briefly
//     so a post-completion subscriber still observes the turn closing.

// Live claude-cli stream-json events for an in-flight turn. Replaces the
// old per-request SSE response body — these are now published through the
// thread bus so the chat POST can return 202 immediately and the client
// listens on the long-lived /threads/:id/events SSE instead.
export type CosClaudeEvent = {
  threadId: string;
  turnId: string;
  seq: number;
  /** raw claude-cli stream-json line, already ANSI-stripped & validated */
  line: string;
};

export type CosTurnStatus =
  | { kind: 'started'; threadId: string; turnId: string; agentSessionId: string; startSeq: number; startedAt: number }
  | { kind: 'completed'; threadId: string; turnId: string; exitCode: number; cancelled: boolean }
  | { kind: 'failed'; threadId: string; turnId: string; error: string };

export type CosBusEvent =
  | { kind: 'claude_event'; payload: CosClaudeEvent }
  | { kind: 'turn_status'; payload: CosTurnStatus };

const threadEventBus = new Map<string, Set<(ev: CosBusEvent) => void>>();
// Parallel agent-scoped bus so the panel can subscribe live to all of an
// agent's threads even when no thread-specific stream is open (i.e. between
// turns or for out-of-band posts that arrive while the operator is just
// looking).
const agentEventBus = new Map<string, Set<(ev: CosBusEvent) => void>>();

// Per-turn ring buffer of claude_event lines so a late-joining /events
// subscriber can replay the in-flight turn from any seq. Keyed by turnId
// (= cosThreads.turnRequestId). Deleted when the turn completes / fails.
const TURN_REPLAY_CAP = 5000;
const turnReplayBuffers = new Map<string, CosClaudeEvent[]>();
// Final turn_status (completed/failed) per turnId. Lives alongside the
// replay buffer so a subscriber that joins after the live turn_status
// has already fired still gets a closure event — without this, an
// EventSource that reconnects post-completion sits forever waiting and
// the optimistic assistant row stays in `streaming: true` (i.e. the
// "thinking" indicator never goes away).
const turnFinalStatus = new Map<string, CosTurnStatus>();

export function appendTurnReplay(ev: CosClaudeEvent): void {
  let buf = turnReplayBuffers.get(ev.turnId);
  if (!buf) { buf = []; turnReplayBuffers.set(ev.turnId, buf); }
  buf.push(ev);
  if (buf.length > TURN_REPLAY_CAP) buf.splice(0, buf.length - TURN_REPLAY_CAP);
}

export function clearTurnReplay(turnId: string): void {
  turnReplayBuffers.delete(turnId);
  turnFinalStatus.delete(turnId);
}

export function recordTurnFinalStatus(status: CosTurnStatus): void {
  if (status.kind !== 'completed' && status.kind !== 'failed') return;
  turnFinalStatus.set(status.turnId, status);
}

export function getTurnFinalStatus(turnId: string): CosTurnStatus | undefined {
  return turnFinalStatus.get(turnId);
}

export function getTurnReplay(turnId: string, fromSeq: number): CosClaudeEvent[] {
  const buf = turnReplayBuffers.get(turnId);
  if (!buf || buf.length === 0) return [];
  if (fromSeq <= 0) return buf.slice();
  return buf.filter((e) => e.seq > fromSeq);
}

export function subscribeThreadEvents(
  threadId: string,
  fn: (ev: CosBusEvent) => void,
): () => void {
  let set = threadEventBus.get(threadId);
  if (!set) { set = new Set(); threadEventBus.set(threadId, set); }
  set.add(fn);
  return () => {
    const s = threadEventBus.get(threadId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) threadEventBus.delete(threadId);
  };
}

export function subscribeAgentEvents(
  agentId: string,
  fn: (ev: CosBusEvent) => void,
): () => void {
  let set = agentEventBus.get(agentId);
  if (!set) { set = new Set(); agentEventBus.set(agentId, set); }
  set.add(fn);
  return () => {
    const s = agentEventBus.get(agentId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) agentEventBus.delete(agentId);
  };
}

export function publishBusEvent(threadId: string, ev: CosBusEvent, agentId?: string | null): void {
  const set = threadEventBus.get(threadId);
  if (set) {
    for (const fn of Array.from(set)) {
      try { fn(ev); } catch { /* ignore listener errors */ }
    }
  }
  if (agentId) {
    const aSet = agentEventBus.get(agentId);
    if (aSet) {
      for (const fn of Array.from(aSet)) {
        try { fn(ev); } catch { /* ignore listener errors */ }
      }
    }
  }
}
