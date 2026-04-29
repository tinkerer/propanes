// Client-side queue for "send when current finishes" follow-ups in CoS
// threads. The operator picks "Send when current finishes" from the
// composer's send-mode dropdown; we stash the payload here and a single
// effect watches `chiefOfStaffAgents` for the streaming flag on the
// relevant thread to clear, then dispatches via sendChiefOfStaffMessage.
//
// Distinct from the server's agent-session followup queue (which fires on
// PTY-process exit). CoS turns are SSE streams, not PTY processes — there
// is no "exit code" to wait on, just the streaming flag flipping back to
// false on the assistant message.
//
// Multiple queued items targeting the same thread are combined into a
// single send at dispatch time (joined by `\n\n---\n\n`, attachments and
// element refs concatenated). Items in the `editing` state pause the
// auto-dispatch for that thread so the operator's edit isn't fired off
// underneath them. Items briefly transition to `sending` before being
// removed from the queue, so the pending UI shows a "sending…" state
// instead of vanishing.

import { signal, effect } from '@preact/signals';
import {
  chiefOfStaffAgents,
  chiefOfStaffActiveId,
  sendChiefOfStaffMessage,
  type CosImageAttachment,
  type CosElementRef,
} from './chief-of-staff.js';

const STORAGE_KEY = 'pw-cos-followups-v1';

export type CosFollowupStatus = 'queued' | 'editing' | 'sending';

export type CosFollowup = {
  id: string;
  agentId: string;
  appId: string | null;
  // The cosThread server id this followup belongs to. The watcher uses
  // it to find the most recent assistant message in that thread and
  // wait for its streaming flag to clear.
  threadServerId: string;
  // Anchor user-message timestamp — passed back as replyToTs so the
  // dispatched message inherits the same thread.
  replyToTs?: number;
  text: string;
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
  enqueuedAt: number;
  status: CosFollowupStatus;
};

let _idCounter = 0;
function nextId(): string {
  _idCounter += 1;
  return `cosfu-${Date.now().toString(36)}-${_idCounter}`;
}

function loadAll(): CosFollowup[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d: any) =>
        d && typeof d.id === 'string'
        && typeof d.agentId === 'string'
        && typeof d.threadServerId === 'string'
        && typeof d.text === 'string',
      )
      .map((d: any) => ({
        ...d,
        // A `sending` followup that didn't get cleared before reload is
        // almost certainly a stuck row — demote to `queued` so the
        // dispatcher reconsiders it.
        status: d.status === 'editing' ? 'editing' : 'queued',
      }));
  } catch { return []; }
}

export const cosFollowups = signal<CosFollowup[]>(loadAll());

let _lastSerialized: string | null = null;

function slimify(list: CosFollowup[]): unknown[] {
  // Strip image dataUrls before persisting — keep shape so badges still
  // render. Attachments lost on reload show as empty thumbs.
  return list.map((d) => ({
    ...d,
    attachments: d.attachments?.map((att) => ({
      kind: att.kind,
      name: att.name,
      dataUrl: att.dataUrl?.startsWith('data:') ? att.dataUrl : '',
    })),
  }));
}

effect(() => {
  const v = cosFollowups.value;
  try {
    if (typeof localStorage === 'undefined') return;
    const serialized = JSON.stringify(slimify(v));
    if (serialized === _lastSerialized) return;
    _lastSerialized = serialized;
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch { /* quota — ignore */ }
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    if (e.newValue === _lastSerialized) return;
    _lastSerialized = e.newValue;
    cosFollowups.value = loadAll();
  });
}

export function enqueueCosFollowup(input: {
  agentId: string;
  appId: string | null;
  threadServerId: string;
  replyToTs?: number;
  text: string;
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
}): string {
  const followup: CosFollowup = {
    id: nextId(),
    agentId: input.agentId,
    appId: input.appId,
    threadServerId: input.threadServerId,
    replyToTs: input.replyToTs,
    text: input.text,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
    elementRefs: input.elementRefs && input.elementRefs.length > 0 ? input.elementRefs : undefined,
    enqueuedAt: Date.now(),
    status: 'queued',
  };
  cosFollowups.value = [...cosFollowups.value, followup];
  return followup.id;
}

export function cancelCosFollowup(id: string): void {
  cosFollowups.value = cosFollowups.value.filter((f) => f.id !== id);
}

export function updateCosFollowup(
  id: string,
  patch: { text?: string; status?: CosFollowupStatus },
): void {
  cosFollowups.value = cosFollowups.value.map((f) =>
    f.id === id
      ? {
          ...f,
          text: patch.text ?? f.text,
          status: patch.status ?? f.status,
        }
      : f,
  );
}

export function setCosFollowupStatus(id: string, status: CosFollowupStatus): void {
  cosFollowups.value = cosFollowups.value.map((f) => (f.id === id ? { ...f, status } : f));
}

export function getThreadFollowups(threadServerId: string): CosFollowup[] {
  if (!threadServerId) return [];
  return cosFollowups.value.filter((f) => f.threadServerId === threadServerId);
}

// Reentrancy guard so the dispatcher doesn't fire twice for the same
// thread if the streaming-flag effect re-triggers between the dispatch
// call and the queue-prune setValue.
const dispatching = new Set<string>();

effect(() => {
  const queue = cosFollowups.value;
  if (queue.length === 0) return;

  const agents = chiefOfStaffAgents.value;

  // Group queued followups by (agentId, threadServerId). Each group is
  // dispatched as a single combined send when the thread's streaming
  // flag clears AND no item in the group is currently being edited.
  const groups = new Map<string, CosFollowup[]>();
  for (const fu of queue) {
    if (fu.status === 'sending') continue;
    const key = `${fu.agentId}::${fu.threadServerId}`;
    const arr = groups.get(key) ?? [];
    arr.push(fu);
    groups.set(key, arr);
  }

  for (const [key, items] of groups) {
    if (dispatching.has(key)) continue;
    // If anyone in this group is being edited, hold the whole group —
    // the operator's mid-edit text shouldn't be auto-fired and the
    // combined send shouldn't reorder around the edit.
    if (items.some((f) => f.status === 'editing')) continue;
    // Only dispatch items that are queued (no editing items remain by this
    // point). Sort by enqueue time so the combined message preserves order.
    const queued = items
      .filter((f) => f.status === 'queued')
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    if (queued.length === 0) continue;

    const first = queued[0];
    const agent = agents.find((a) => a.id === first.agentId);
    if (!agent) continue;

    // Find messages in this thread. If any assistant message in the
    // thread is still streaming, hold off. An empty match (synthetic
    // threadServerId from "queue without active context", or stale id
    // from a thread that no longer exists in this agent) falls through
    // and dispatches immediately — replyToTs is what determines whether
    // the send inherits a thread or spawns a fresh one.
    const threadMessages = agent.messages.filter((m) => m.threadId === first.threadServerId);
    const stillStreaming = threadMessages.some((m) => m.streaming);
    if (stillStreaming) continue;

    dispatching.add(key);

    // Mark every queued item in this group as `sending` so the inline UI
    // shows the "sending…" state during dispatch.
    const sendingIds = new Set(queued.map((f) => f.id));
    cosFollowups.value = cosFollowups.value.map((f) =>
      sendingIds.has(f.id) ? { ...f, status: 'sending' } : f,
    );

    // Combine: concatenate texts (newest last), merge attachments and
    // element refs in order. Use the earliest replyToTs so the combined
    // send lands on the same thread anchor.
    const combinedText = queued
      .map((f) => f.text.trim())
      .filter((t) => t.length > 0)
      .join('\n\n---\n\n');
    const combinedAttachments: CosImageAttachment[] = [];
    const combinedElementRefs: CosElementRef[] = [];
    for (const f of queued) {
      if (f.attachments) combinedAttachments.push(...f.attachments);
      if (f.elementRefs) combinedElementRefs.push(...f.elementRefs);
    }
    const replyToTs = queued.find((f) => typeof f.replyToTs === 'number')?.replyToTs;

    if (chiefOfStaffActiveId.value !== first.agentId) {
      chiefOfStaffActiveId.value = first.agentId;
    }

    // Hold the items in `sending` state for the duration of the POST
    // roundtrip — the operator sees a "sending…" pill until the server
    // acks (or fails), at which point the row drops out and the optimistic
    // user message is already visible inline in the chat.
    void (async () => {
      try {
        await sendChiefOfStaffMessage(combinedText, first.appId, {
          replyToTs,
          attachments: combinedAttachments.length > 0 ? combinedAttachments : undefined,
          elementRefs: combinedElementRefs.length > 0 ? combinedElementRefs : undefined,
        });
      } catch {
        /* error surfaces via chiefOfStaffError; failed user/assistant pair is
           already in the chat with a retry button. */
      } finally {
        cosFollowups.value = cosFollowups.value.filter((f) => !sendingIds.has(f.id));
        dispatching.delete(key);
      }
    })();
  }
});
