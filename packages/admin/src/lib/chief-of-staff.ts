import { signal, effect } from '@preact/signals';
import {
  popoutPanels,
  updatePanel,
  bringToFront,
  persistPopoutState,
  COS_PANEL_ID,
  type PopoutPanelState,
} from './popout-state.js';
import {
  layoutTree,
  findLeafWithTab,
  findLeaf,
  focusedLeafId,
  addTabToLeaf,
  setActiveTab,
  setFocusedLeaf,
  splitLeaf,
  removeTabFromLeaf,
  SIDEBAR_LEAF_ID,
  getAllLeaves,
} from './pane-tree.js';
import { isMobile } from './viewport.js';

export type ChiefOfStaffToolCall = {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type DispatchInfo = {
  feedbackId: string;
  sessionId: string | null;
};

/**
 * Inspect a tool call and, if it was a feedback dispatch, return the feedbackId
 * (always, parsed from the Bash command) and sessionId (when the call's result
 * has been hydrated). Returns null if this call isn't a dispatch.
 *
 * Works for both `POST /api/v1/admin/feedback/<id>/dispatch` and
 * `POST /api/v1/admin/dispatch` with a `{"feedbackId":"..."}` body.
 */
export function extractDispatchInfo(call: ChiefOfStaffToolCall): DispatchInfo | null {
  if (call.error) return null;
  if (call.name !== 'Bash') return null;
  const cmd = typeof call.input?.command === 'string' ? (call.input.command as string) : '';
  if (!cmd) return null;
  if (!/-X\s+POST/i.test(cmd)) return null;

  // Path-style: /api/v1/admin/feedback/<id>/dispatch
  let feedbackId: string | null = null;
  const pathMatch = cmd.match(/\/api\/v1\/admin\/feedback\/([A-Z0-9]{20,})\/dispatch/i);
  if (pathMatch) {
    feedbackId = pathMatch[1];
  } else {
    // Body-style: /api/v1/admin/dispatch with -d '{"feedbackId":"<id>",...}'
    if (!/\/api\/v1\/admin\/dispatch\b/.test(cmd)) return null;
    const bodyMatch = cmd.match(/["']feedbackId["']\s*:\s*["']([A-Z0-9]{20,})["']/i);
    if (!bodyMatch) return null;
    feedbackId = bodyMatch[1];
  }

  // Pull sessionId from the result when available (live stream or rehydrated).
  let sessionId: string | null = null;
  const res = call.result;
  if (typeof res === 'string' && res.trim()) {
    const m = res.match(/["']sessionId["']\s*:\s*["']([A-Za-z0-9-]+)["']/);
    if (m) sessionId = m[1];
  } else if (res && typeof res === 'object' && typeof (res as any).sessionId === 'string') {
    sessionId = (res as any).sessionId;
  }

  return { feedbackId, sessionId };
}


export type ChiefOfStaffVerbosity = 'terse' | 'normal' | 'verbose';
export type ChiefOfStaffStyle = 'dry' | 'neutral' | 'friendly';

export const DEFAULT_VERBOSITY: ChiefOfStaffVerbosity = 'terse';
export const DEFAULT_STYLE: ChiefOfStaffStyle = 'dry';

export type ChiefOfStaffMsg = {
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolCalls?: ChiefOfStaffToolCall[];
  timestamp: number;
  // Server-side cosThread this message belongs to. Each top-level UI thread
  // maps 1:1 to a cosThread (= one Claude session). Reply-in-thread messages
  // inherit the threadId from the anchor user message.
  threadId?: string;
  // Server-side cosMessages.id when known (set on history reload). Used to
  // dedupe rows that arrive both via the live stream and a subsequent
  // history fetch.
  serverId?: string;
  streaming?: boolean;
  // Set on the assistant placeholder until the first SSE event arrives, so the
  // UI can distinguish "request in flight, awaiting first byte" from "actively
  // streaming a reply".
  sending?: boolean;
  // Set when the request failed before/after streaming started. Keeps the
  // partial text/toolCalls visible and exposes a retry button.
  error?: string;
  retryPayload?: {
    text: string;
    appId: string | null;
    attachments?: CosImageAttachment[];
    elementRefs?: CosElementRef[];
  };
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
  // Set on user messages that were composed via "Reply in thread" — the
  // timestamp of the thread-anchor user message they attach to. Used client-
  // side by groupIntoThreads so the reply renders inline within the existing
  // thread instead of starting a new one.
  replyToTs?: number;
};

export type CosImageAttachment = {
  kind: 'image';
  dataUrl: string;
  name?: string;
};

export type CosElementRef = {
  selector: string;
  tagName: string;
  id?: string;
  classes?: string[];
  textContent?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
};

export type SendCosOptions = {
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
  replyToTs?: number;
};

function adminHeaders(): Record<string, string> {
  const token = localStorage.getItem('pw-admin-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}


export type ChiefOfStaffAgent = {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  messages: ChiefOfStaffMsg[];
  threadId?: string; // server-side thread ID
  verbosity?: ChiefOfStaffVerbosity;
  style?: ChiefOfStaffStyle;
};

// threadId → backing agentSessionId. Each cosThread owns exactly one
// persistent headless-stream agent session; this map lets the UI jump
// straight to its jsonl log without round-tripping the server.
export const cosThreadSessions = signal<Record<string, string>>({});

function mergeThreadSessions(threads: Array<{ id?: unknown; agentSessionId?: unknown }>): void {
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
};
export const cosThreadMeta = signal<Record<string, CosThreadMeta>>({});

function mergeThreadMeta(
  threads: Array<{
    id?: unknown;
    sessionStatus?: unknown;
    resolvedAt?: unknown;
    archivedAt?: unknown;
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
    const prev = next[tid];
    if (!prev || prev.sessionStatus !== sessionStatus || prev.resolvedAt !== resolvedAt || prev.archivedAt !== archivedAt) {
      next[tid] = { sessionStatus, resolvedAt, archivedAt };
      changed = true;
    }
  }
  if (changed) cosThreadMeta.value = next;
}

export function getThreadMeta(threadId: string | undefined | null): CosThreadMeta | null {
  if (!threadId) return null;
  return cosThreadMeta.value[threadId] ?? null;
}

const EMPTY_THREAD_META: CosThreadMeta = { sessionStatus: null, resolvedAt: null, archivedAt: null };

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
    const data = await res.json().catch(() => null) as { resolvedAt?: unknown; archivedAt?: unknown } | null;
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


const STORAGE_KEY = 'pw-chief-of-staff-v1';

const DEFAULT_AGENTS: ChiefOfStaffAgent[] = [
  {
    id: 'default',
    name: 'Ops',
    systemPrompt:
      'You are Ops, a sharp, terse operations assistant for the ProPanes admin dashboard. You know the feedback queues, agent sessions, and infra health. Direct, dry, practical. Bullet lists. Short answers. Never invent IDs — always query the API. Report dispatches as "launched <sessionId>".\n\nDon\'t cop out. When the operator\'s intent is clearly to act ("fix X", "rerun Y", "restart bailouts", "take care of it", "go ahead"), dispatch — don\'t ask for a second round of confirmation. Only pause when the request is genuinely ambiguous or would fan out 5+ sessions at once.\n\nBail-out detection: a session is almost certainly a silent crash when status=completed, exitCode=0, outputBytes<5000, and (completedAt − startedAt) < 2s. When asked to rerun failed/bailed sessions, filter by this heuristic and re-dispatch the same feedbackId with the same agentEndpointId.\n\nBase URL: http://localhost:3001\n\nKey routes (curl GET unless noted):\n- /api/v1/admin/feedback — feedback queue (supports ?appId, ?status, ?limit)\n- /api/v1/admin/agent-sessions — agent sessions (supports ?feedbackId)\n- /api/v1/admin/applications — registered apps (IDs, names, project dirs)\n- /api/v1/admin/machines — machine registry\n- /api/v1/launchers — connected launcher daemons\n- /api/v1/admin/aggregate — clustered feedback\n- POST /api/v1/admin/dispatch — dispatch a new agent session',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  },
  {
    id: 'infra',
    name: 'Infra Watcher',
    systemPrompt:
      'You are an infrastructure-focused assistant named Rover. Monitor machines, launchers, and harnesses. Check /api/v1/admin/machines, /api/v1/launchers, and /api/v1/admin/harness-configs. Flag anything offline, stale heartbeats, or error states. Bullet lists only. Terse.',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  },
  {
    id: 'triage',
    name: 'Triage',
    systemPrompt:
      'You specialize in triaging new feedback. List new/unreviewed items grouped by app, call out anything high-priority or duplicated, suggest which to dispatch next. When the operator says to dispatch ("go", "fix it", "dispatch those", "take care of it"), dispatch immediately — don\'t ask again. Only pause when the request is genuinely ambiguous or would fan out 5+ sessions at once. Report dispatches as "launched <sessionId>".',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  },
];

function loadState(): { agents: ChiefOfStaffAgent[]; activeAgentId: string; open: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { agents: DEFAULT_AGENTS, activeAgentId: DEFAULT_AGENTS[0].id, open: false };
    const parsed = JSON.parse(raw);
    const rawAgents: any[] = Array.isArray(parsed.agents) && parsed.agents.length > 0 ? parsed.agents : DEFAULT_AGENTS;
    // Strip any persisted claudeSessionId — we never resume anymore.
    const agents: ChiefOfStaffAgent[] = rawAgents.map((a) => ({
      id: a.id,
      name: a.name,
      systemPrompt: a.systemPrompt || '',
      model: a.model || '',
      messages: Array.isArray(a.messages)
        ? a.messages.map((m: any) => ({
            role: m.role,
            text: m.text || '',
            toolCalls: m.toolCalls,
            timestamp: m.timestamp,
            // Never persist streaming=true / sending=true across reloads — those
            // streams are dead, so the UI would lie about being mid-request.
            streaming: false,
            sending: false,
            // Preserve a prior error string so the user still sees the failure
            // after a reload, but drop retryPayload — image dataUrls were
            // stripped on save, so the retry would silently lose attachments.
            error: typeof m.error === 'string' ? m.error : undefined,
            attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
            elementRefs: Array.isArray(m.elementRefs) ? m.elementRefs : undefined,
          }))
        : [],
      threadId: a.threadId,
      verbosity: a.verbosity === 'normal' || a.verbosity === 'verbose' ? a.verbosity : DEFAULT_VERBOSITY,
      style: a.style === 'neutral' || a.style === 'friendly' ? a.style : DEFAULT_STYLE,
    }));
    const activeAgentId = typeof parsed.activeAgentId === 'string' && agents.some((a) => a.id === parsed.activeAgentId)
      ? parsed.activeAgentId
      : agents[0].id;
    const open = typeof parsed.open === 'boolean' ? parsed.open : false;
    return { agents, activeAgentId, open };
  } catch {
    return { agents: DEFAULT_AGENTS, activeAgentId: DEFAULT_AGENTS[0].id, open: false };
  }
}

const initial = loadState();

export const chiefOfStaffOpen = signal(initial.open);
export const chiefOfStaffAgents = signal<ChiefOfStaffAgent[]>(initial.agents);
export const chiefOfStaffActiveId = signal<string>(initial.activeAgentId);
export const chiefOfStaffError = signal<string | null>(null);
// Count of in-flight streams across all agents — informational only, never blocks input.
export const chiefOfStaffInFlight = signal(0);


export function ensureCosPanel(): PopoutPanelState {
  const existing = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
  if (existing) return existing;
  const w = 420;
  const h = 600;
  const panel: PopoutPanelState = {
    id: COS_PANEL_ID,
    sessionIds: [],
    activeSessionId: '',
    docked: false,
    visible: chiefOfStaffOpen.value,
    floatingRect: {
      x: Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1024) - w - 16),
      y: 72,
      w,
      h,
    },
    dockedHeight: h,
    dockedWidth: w,
    alwaysOnTop: true,
  };
  popoutPanels.value = [...popoutPanels.value, panel];
  return panel;
}

ensureCosPanel();

effect(() => {
  // Strip image dataUrls before persisting — they can easily blow localStorage's
  // ~5 MB quota. Server history is the authoritative store for attachments; we
  // only keep a shape marker here so UI can show something before rehydration.
  const agentsForStorage = chiefOfStaffAgents.value.map((a) => ({
    ...a,
    messages: a.messages.map((m) => ({
      ...m,
      // Drop transient request state — these are bound to the in-memory fetch
      // and meaningless after reload. retryPayload also has no value once
      // attachment dataUrls have been stripped for quota.
      sending: undefined,
      retryPayload: undefined,
      attachments: m.attachments
        ? m.attachments.map((att) => ({ kind: att.kind, name: att.name, dataUrl: '' }))
        : undefined,
    })),
  }));
  const state = { agents: agentsForStorage, activeAgentId: chiefOfStaffActiveId.value, open: chiefOfStaffOpen.value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota exceeded — ignore */
  }
});

export function getActiveAgent(): ChiefOfStaffAgent | null {
  return chiefOfStaffAgents.value.find((a) => a.id === chiefOfStaffActiveId.value) || null;
}

function updateAgent(id: string, mutate: (a: ChiefOfStaffAgent) => ChiefOfStaffAgent): void {
  chiefOfStaffAgents.value = chiefOfStaffAgents.value.map((a) => (a.id === id ? mutate(a) : a));
}

function serverMessageToClient(m: any): ChiefOfStaffMsg {
  let toolCalls: ChiefOfStaffToolCall[] | undefined;
  if (m?.toolCallsJson) {
    try {
      const parsed = JSON.parse(m.toolCallsJson);
      if (Array.isArray(parsed)) {
        toolCalls = parsed.map((c: any) => ({
          id: c.id,
          name: String(c.name || 'tool'),
          input: c.input && typeof c.input === 'object' ? c.input : {},
          result: c.result,
          error: c.error,
        }));
      }
    } catch { /* ignore */ }
  }
  let attachments: CosImageAttachment[] | undefined;
  let elementRefs: CosElementRef[] | undefined;
  let replyToTs: number | undefined;
  if (m?.attachmentsJson) {
    try {
      const parsed = JSON.parse(m.attachmentsJson);
      const imgs = Array.isArray(parsed?.images) ? parsed.images : [];
      const els = Array.isArray(parsed?.elements) ? parsed.elements : [];
      const mappedImgs: CosImageAttachment[] = imgs
        .filter((a: any) => a && typeof a.dataUrl === 'string')
        .map((a: any) => ({ kind: 'image', dataUrl: a.dataUrl, name: a.name }));
      if (mappedImgs.length > 0) attachments = mappedImgs;
      if (els.length > 0) elementRefs = els as CosElementRef[];
      if (typeof parsed?.replyToTs === 'number') replyToTs = parsed.replyToTs;
    } catch { /* ignore */ }
  }
  return {
    role: m?.role === 'assistant' || m?.role === 'system' ? m.role : 'user',
    text: String(m?.text || ''),
    toolCalls,
    timestamp: Number(m?.createdAt) || Date.now(),
    threadId: typeof m?.threadId === 'string' ? m.threadId : undefined,
    serverId: typeof m?.id === 'string' ? m.id : undefined,
    streaming: false,
    attachments,
    elementRefs,
    replyToTs,
  };
}

/**
 * Fetch ALL server-side threads + messages for an agent and replace the
 * local in-memory message log. Messages are interleaved across threads and
 * each one carries its threadId, so the client can route replies back to the
 * right Claude session. Called on module startup so a fresh page load (or
 * cleared localStorage) still sees prior CoS history.
 */
export async function loadChiefOfStaffHistory(agentId: string, appId: string | null = null): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    const res = await fetch(
      `/api/v1/admin/chief-of-staff/history/${encodeURIComponent(agentId)}${qs}`,
      { headers },
    );
    if (!res.ok) return;
    const data = await res.json();
    const threads = Array.isArray(data?.threads) ? data.threads : (data?.thread ? [data.thread] : []);
    mergeThreadSessions(threads);
    mergeThreadMeta(threads);
    // Server returns rows with `threadId` column — propagate it into each
    // ChiefOfStaffMsg via serverMessageToClient.
    const serverMessages: ChiefOfStaffMsg[] = Array.isArray(data?.messages)
      ? data.messages.map(serverMessageToClient)
      : [];

    // Only replace the local log if the server has something. Otherwise
    // leave locally-cached messages untouched (e.g. if the user wrote a
    // turn offline).
    if (threads.length === 0 && serverMessages.length === 0) return;

    updateAgent(agentId, (a) => ({
      ...a,
      messages: serverMessages,
      // agent.threadId is retained only as a legacy hint; every message now
      // carries its own threadId and each top-level send mints a fresh one.
      threadId: undefined,
    }));
  } catch {
    /* non-fatal */
  }
}

// Kick off server-side history rehydration for every known agent on startup.
// Runs in the background — does not block panel open.
void (async () => {
  for (const agent of chiefOfStaffAgents.value) {
    void loadChiefOfStaffHistory(agent.id);
  }
})();

/**
 * Mint a fresh cosThread for this agent. Every top-level UI thread gets its
 * own cosThread — the server provisions a dedicated headless-stream agent
 * session alongside, giving each thread its own Claude context.
 */
async function createCosThread(
  agent: ChiefOfStaffAgent,
  appId: string | null,
  nameHint: string,
): Promise<string | undefined> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const trimmedHint = nameHint.trim();
    const name = (trimmedHint ? trimmedHint.slice(0, 80) : agent.name) || 'New thread';
    const res = await fetch('/api/v1/admin/chief-of-staff/threads', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: agent.id,
        appId: appId || undefined,
        name,
        systemPrompt: agent.systemPrompt || undefined,
        model: agent.model || undefined,
      }),
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    if (data && typeof data === 'object') {
      mergeThreadSessions([data]);
      mergeThreadMeta([data]);
    }
    return typeof data?.id === 'string' ? data.id : undefined;
  } catch {
    return undefined;
  }
}

/** Find the anchor user message whose timestamp matches — used to inherit
 *  the server-side threadId when the operator picks "Reply in thread". */
function findAnchorMessage(agent: ChiefOfStaffAgent, anchorTs: number | undefined): ChiefOfStaffMsg | null {
  if (typeof anchorTs !== 'number') return null;
  return agent.messages.find((m) => m.role === 'user' && m.timestamp === anchorTs) || null;
}

async function listThreadIdsForAgent(agentId: string, appId: string | null): Promise<string[]> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const qs = new URLSearchParams({ agentId });
    if (appId) qs.set('appId', appId);
    const res = await fetch(`/api/v1/admin/chief-of-staff/threads?${qs.toString()}`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    const threads = Array.isArray(data?.threads) ? data.threads : [];
    return threads.map((t: any) => t?.id).filter((id: any): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export async function clearActiveAgentHistory(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) return;

  const token = localStorage.getItem('pw-admin-token');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Delete ALL server-side threads for this agent (across apps). Legacy rows
  // only had one thread per agent; post-fix each top-level UI message has its
  // own thread, so "Clear history" needs to sweep them all.
  const threadIds = await listThreadIdsForAgent(agent.id, null);
  // Include any legacy singleton threadId the UI remembered that might not be
  // visible on the current app filter.
  if (agent.threadId && !threadIds.includes(agent.threadId)) threadIds.push(agent.threadId);
  await Promise.all(
    threadIds.map(async (id) => {
      try {
        await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        });
      } catch {
        /* non-fatal */
      }
    }),
  );

  updateAgent(agent.id, (a) => ({ ...a, messages: [], threadId: undefined }));
}

/**
 * Interrupt any in-flight turns for this agent. A turn is in-flight when at
 * least one local message is still streaming; we derive the targeted thread
 * ids from those messages. If nothing is streaming locally, fall back to the
 * agent's legacy singleton threadId (pre-multi-thread clients).
 */
export async function interruptActiveAgent(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) return;

  const targets = new Set<string>();
  for (const m of agent.messages) {
    if (m.streaming && m.threadId) targets.add(m.threadId);
  }
  if (targets.size === 0 && agent.threadId) targets.add(agent.threadId);
  if (targets.size === 0) return;

  const token = localStorage.getItem('pw-admin-token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  await Promise.all(
    Array.from(targets).map(async (id) => {
      try {
        await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(id)}/interrupt`, {
          method: 'POST',
          headers,
        });
      } catch {
        /* non-fatal */
      }
    }),
  );
}

/** Interrupt a single, known thread. Used by per-thread Stop buttons. */
export async function interruptThread(threadId: string): Promise<void> {
  if (!threadId) return;
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(threadId)}/interrupt`, {
      method: 'POST',
      headers,
    });
  } catch {
    /* non-fatal */
  }
}

export function renameActiveAgent(name: string): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, name: name.slice(0, 60) }));
}

export function updateActiveAgentSystemPrompt(systemPrompt: string): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, systemPrompt }));
}

export function updateActiveAgentModel(model: string): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, model }));
}

export function updateActiveAgentVerbosity(verbosity: ChiefOfStaffVerbosity): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, verbosity }));
}

export function updateActiveAgentStyle(style: ChiefOfStaffStyle): void {
  updateAgent(chiefOfStaffActiveId.value, (a) => ({ ...a, style }));
}

export function addAgent(name: string): string {
  const id = `agent-${Date.now().toString(36)}`;
  const agent: ChiefOfStaffAgent = {
    id,
    name: name.slice(0, 60) || 'New Agent',
    systemPrompt: '',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  };
  chiefOfStaffAgents.value = [...chiefOfStaffAgents.value, agent];
  chiefOfStaffActiveId.value = id;
  return id;
}

export function removeActiveAgent(): void {
  const remaining = chiefOfStaffAgents.value.filter((a) => a.id !== chiefOfStaffActiveId.value);
  if (remaining.length === 0) {
    // Don't allow removing the last agent — reset it instead
    void clearActiveAgentHistory();
    return;
  }
  chiefOfStaffAgents.value = remaining;
  chiefOfStaffActiveId.value = remaining[0].id;
}

type StreamAccum = {
  text: string;
  toolCalls: ChiefOfStaffToolCall[];
  toolCallsById: Map<string, ChiefOfStaffToolCall>;
};

function processClaudeEvent(obj: any, s: StreamAccum): boolean {
  const t = obj.type;

  if (t === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
    let changed = false;
    for (const block of obj.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        s.text += (s.text ? '\n\n' : '') + block.text;
        changed = true;
      } else if (block.type === 'tool_use') {
        const id = String(block.id || `tu-${s.toolCalls.length}`);
        if (!s.toolCallsById.has(id)) {
          const call: ChiefOfStaffToolCall = {
            id,
            name: String(block.name || 'tool'),
            input: (block.input && typeof block.input === 'object') ? block.input : {},
          };
          s.toolCallsById.set(id, call);
          s.toolCalls.push(call);
          changed = true;
        }
      }
    }
    return changed;
  }

  if (t === 'user' && obj.message?.content && Array.isArray(obj.message.content)) {
    let changed = false;
    for (const block of obj.message.content) {
      if (block.type !== 'tool_result') continue;
      const call = s.toolCallsById.get(String(block.tool_use_id));
      if (!call) continue;
      const rawContent = block.content;
      let content: string;
      if (typeof rawContent === 'string') {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        content = rawContent
          .map((c: any) => (typeof c === 'string' ? c : c?.text || JSON.stringify(c)))
          .join('\n');
      } else {
        content = JSON.stringify(rawContent);
      }
      if (content.length > 4000) content = `${content.slice(0, 4000)}…[${content.length - 4000} more chars truncated]`;
      if (block.is_error) call.error = content;
      else call.result = content;
      changed = true;
    }
    return changed;
  }

  if (t === 'result') {
    // Session end metadata. If the CLI produced a final `result` string but no
    // prior assistant text, surface it so the user sees something.
    if (!s.text && typeof obj.result === 'string' && obj.result.trim()) {
      s.text = obj.result.trim();
      return true;
    }
  }

  return false;
}

/**
 * Fire-and-forget: appends the user message + placeholder assistant, spawns an
 * independent stream. Multiple calls can be in-flight simultaneously. Each
 * assistant message is keyed by its timestamp so streams don't stomp on each
 * other.
 */
export function sendChiefOfStaffMessage(
  text: string,
  appId: string | null,
  opts?: SendCosOptions,
): void {
  const agent = getActiveAgent();
  if (!agent) return;
  const trimmed = text.trim();
  const attachments = opts?.attachments ?? [];
  const elementRefs = opts?.elementRefs ?? [];
  if (!trimmed && attachments.length === 0 && elementRefs.length === 0) return;

  const agentId = agent.id;
  const userTs = Date.now();
  // Ensure uniqueness even if two submits land in the same ms.
  const assistantTs = userTs + Math.floor(Math.random() * 1000) + 1;

  chiefOfStaffError.value = null;
  const replyToTs = opts?.replyToTs;
  const userMsg: ChiefOfStaffMsg = {
    role: 'user',
    text: trimmed,
    timestamp: userTs,
    attachments: attachments.length > 0 ? attachments : undefined,
    elementRefs: elementRefs.length > 0 ? elementRefs : undefined,
    replyToTs,
  };
  const assistantMsg: ChiefOfStaffMsg = {
    role: 'assistant',
    text: '',
    toolCalls: [],
    timestamp: assistantTs,
    streaming: true,
    sending: true,
  };
  updateAgent(agentId, (a) => ({ ...a, messages: [...a.messages, userMsg, assistantMsg] }));

  const patchAssistant = (mutate: (m: ChiefOfStaffMsg) => ChiefOfStaffMsg) => {
    updateAgent(agentId, (a) => ({
      ...a,
      messages: a.messages.map((m) =>
        m.role === 'assistant' && m.timestamp === assistantTs ? mutate(m) : m,
      ),
    }));
  };

  const commit = (s: StreamAccum) => {
    patchAssistant((m) => ({
      ...m,
      // Any committed event means the server is producing output — drop the
      // "Working on it…" early-ack state.
      sending: false,
      text: s.text,
      toolCalls: s.toolCalls.length > 0 ? s.toolCalls.map((c) => ({ ...c })) : undefined,
    }));
  };

  chiefOfStaffInFlight.value = chiefOfStaffInFlight.value + 1;

  void (async () => {
    // POST /chat now returns 202 immediately with { turnId, startSeq } and
    // the live content arrives over a long-lived per-thread EventSource on
    // /threads/:id/events. The accumulator absorbs claude events as they
    // come in (live or replayed from the per-turn ring buffer); processClaudeEvent
    // is idempotent across redelivery because lastSeenSeq filters duplicates.
    const accum: StreamAccum = {
      text: '',
      toolCalls: [],
      toolCallsById: new Map(),
    };
    let lastSeenSeq = 0;
    let cancelledByServer = false;
    let threadIdForResume: string | undefined;

    // Hydrate the optimistic row from the persisted assistant row once the
    // turn is done. Anchored to the user-message createdAt so client/server
    // clock skew can't cause us to pick up an unrelated reply.
    const hydrateFromHistory = async (): Promise<boolean> => {
      try {
        const token = localStorage.getItem('pw-admin-token');
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(
          `/api/v1/admin/chief-of-staff/history/${encodeURIComponent(agentId)}${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`,
          { headers },
        );
        if (!res.ok) return false;
        const data = await res.json();
        const allMessages: any[] = Array.isArray(data?.messages) ? data.messages : [];
        // Scope to the thread we're resuming. The history endpoint returns
        // messages across every thread of the agent, so without this filter
        // we could pick up an unrelated assistant reply from another thread.
        const threadMessages = threadIdForResume
          ? allMessages.filter((m) => m?.threadId === threadIdForResume)
          : allMessages;
        // Locate the user row this turn started from. It was persisted with
        // createdAt === userTs, which is the same value we sent as clientTs.
        const userIdx = threadMessages.findIndex(
          (m) => m?.role === 'user' && Number(m?.createdAt) === userTs,
        );
        const startIdx = userIdx >= 0 ? userIdx + 1 : 0;
        let latestAssistant: any = null;
        for (let i = threadMessages.length - 1; i >= startIdx; i--) {
          if (threadMessages[i]?.role === 'assistant') {
            latestAssistant = threadMessages[i];
            break;
          }
        }
        if (!latestAssistant) return false;
        const hydrated = serverMessageToClient(latestAssistant);
        patchAssistant(() => ({ ...hydrated, timestamp: assistantTs, streaming: false, sending: false }));
        return true;
      } catch {
        return false;
      }
    };

    try {
      const token = localStorage.getItem('pw-admin-token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Resolve the target cosThread:
      //   • Reply-in-thread → inherit the anchor user-message's threadId so the
      //     existing Claude session continues.
      //   • Top-level send  → mint a fresh cosThread so a new headless Claude
      //     session spawns. This is the behavior contract the operator expects:
      //     every "new chat" = its own session, not a continuation of the
      //     previous one.
      let threadId: string | undefined;
      if (typeof replyToTs === 'number') {
        const anchor = findAnchorMessage(agent, replyToTs);
        threadId = anchor?.threadId;
      }
      if (!threadId) {
        threadId = await createCosThread(agent, appId, trimmed);
      }
      threadIdForResume = threadId;

      // Tag the optimistic user message + assistant placeholder with the
      // resolved threadId so grouping, reply resolution, and targeted
      // interrupts line up with the backend.
      if (threadId) {
        updateAgent(agentId, (a) => ({
          ...a,
          messages: a.messages.map((m) => {
            if ((m.role === 'user' && m.timestamp === userTs) ||
                (m.role === 'assistant' && m.timestamp === assistantTs)) {
              return { ...m, threadId };
            }
            return m;
          }),
        }));
      }

      const payload: Record<string, unknown> = {
        text: trimmed,
        systemPrompt: agent.systemPrompt || undefined,
        model: agent.model || undefined,
        appId: appId || undefined,
        threadId: threadId || undefined,
        verbosity: agent.verbosity || DEFAULT_VERBOSITY,
        style: agent.style || DEFAULT_STYLE,
        clientTs: userTs,
      };
      if (attachments.length > 0) payload.attachments = attachments;
      if (elementRefs.length > 0) payload.elementRefs = elementRefs;
      if (typeof replyToTs === 'number') payload.replyToTs = replyToTs;

      const res = await fetch('/api/v1/admin/chief-of-staff/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const err = await res.json();
          if (err?.error) errMsg = err.error;
        } catch { /* ignore */ }
        throw new Error(errMsg);
      }

      let ack: { turnId?: string; threadId?: string; startSeq?: number; agentSessionId?: string };
      try {
        ack = await res.json();
      } catch {
        throw new Error('Server did not return a turn descriptor');
      }
      if (!ack.turnId || !ack.threadId) {
        throw new Error('Server did not return a turnId');
      }

      const myTurnId = ack.turnId;
      const ackThreadId = ack.threadId;
      threadIdForResume = ackThreadId;
      const initialFromSeq = typeof ack.startSeq === 'number' ? ack.startSeq : 0;
      lastSeenSeq = initialFromSeq;

      // Subscribe to the long-lived per-thread event stream. The browser's
      // EventSource auto-reconnects on transient drops; on each (re)connect
      // the server replays buffered claude_events for myTurnId from
      // ?fromSeq=<lastSeen>, so the gap is closed without us having to retry
      // the POST. The subscription closes once turn_status: completed |
      // failed arrives for myTurnId.
      const handleClaudeEvent = (raw: string) => {
        try {
          const ev = JSON.parse(raw);
          if (ev?.turnId !== myTurnId) return;
          if (typeof ev.seq === 'number') {
            if (ev.seq <= lastSeenSeq) return; // already processed
            lastSeenSeq = ev.seq;
          }
          const obj = typeof ev.line === 'string' ? JSON.parse(ev.line) : null;
          if (obj && processClaudeEvent(obj, accum)) commit(accum);
        } catch { /* ignore malformed frame */ }
      };
      let es: EventSource | null = null;
      const openSubscription = (fromSeq: number): EventSource => {
        const params = new URLSearchParams({
          fromSeq: String(fromSeq),
          turnId: myTurnId,
        });
        return new EventSource(
          `/api/v1/admin/chief-of-staff/threads/${encodeURIComponent(ackThreadId)}/events?${params.toString()}`,
        );
      };
      const closeSubscription = () => {
        if (!es) return;
        try { es.close(); } catch { /* ignore */ }
        es = null;
      };

      const turnDone: { error?: string; cancelled?: boolean } = await new Promise((resolve) => {
        let settled = false;
        const settle = (result: { error?: string; cancelled?: boolean }) => {
          if (settled) return;
          settled = true;
          closeSubscription();
          resolve(result);
        };

        const wireListeners = (source: EventSource) => {
          source.addEventListener('claude_event', (e) => handleClaudeEvent((e as MessageEvent).data));
          source.addEventListener('turn_status', (e) => {
            try {
              const status = JSON.parse((e as MessageEvent).data);
              if (status?.turnId !== myTurnId) return;
              if (status.kind === 'completed') {
                if (status.cancelled) cancelledByServer = true;
                settle({ cancelled: !!status.cancelled });
              } else if (status.kind === 'failed') {
                settle({ error: status.error || 'Turn failed' });
              }
            } catch { /* ignore */ }
          });
          // EventSource reconnects automatically on transient drops; the
          // server replays from fromSeq so no events are lost. We only act
          // here if the source itself is unrecoverable.
          source.onerror = () => {
            // browser is reconnecting; nothing to do
          };
        };

        es = openSubscription(initialFromSeq);
        wireListeners(es);
      });

      if (turnDone.error) throw new Error(turnDone.error);

      // Confirm the persisted assistant row in case any events were missed
      // beyond the replay buffer. Hydration is anchored on userTs so we
      // can't pick up an unrelated thread's reply.
      if (threadIdForResume) {
        const hydrated = await hydrateFromHistory();
        if (hydrated) return;
      }

      if (!cancelledByServer && !accum.text && accum.toolCalls.length === 0) {
        throw new Error('No response from Claude');
      }

      patchAssistant((m) => ({ ...m, streaming: false, sending: false }));
    } catch (err: any) {
      const msg = err?.message || 'Request failed';
      chiefOfStaffError.value = msg;
      patchAssistant((m) => ({
        ...m,
        streaming: false,
        sending: false,
        // Keep any partial text/toolCalls that arrived before the failure so
        // the user can see how far it got. The error UI is rendered separately.
        error: msg,
        retryPayload: {
          text: trimmed,
          appId,
          attachments: attachments.length > 0 ? attachments : undefined,
          elementRefs: elementRefs.length > 0 ? elementRefs : undefined,
        },
      }));
    } finally {
      chiefOfStaffInFlight.value = Math.max(0, chiefOfStaffInFlight.value - 1);
    }
  })();
}

/**
 * Re-issue a previously failed assistant turn. Drops the failed assistant
 * placeholder and the user message that originated it (if directly preceding),
 * then re-calls sendChiefOfStaffMessage with the captured payload. This keeps
 * the conversation linear instead of stacking duplicate user prompts on retry.
 */
export function retryFailedAssistantMessage(targetTimestamp: number): void {
  const agent = getActiveAgent();
  if (!agent) return;
  const idx = agent.messages.findIndex(
    (m) => m.role === 'assistant' && m.timestamp === targetTimestamp,
  );
  if (idx < 0) return;
  const failed = agent.messages[idx];
  const payload = failed.retryPayload;
  if (!payload) return;
  const dropFrom = idx > 0 && agent.messages[idx - 1].role === 'user' ? idx - 1 : idx;
  updateAgent(agent.id, (a) => ({
    ...a,
    messages: a.messages.filter((_, i) => i < dropFrom || i > idx),
  }));
  sendChiefOfStaffMessage(payload.text, payload.appId, {
    attachments: payload.attachments,
    elementRefs: payload.elementRefs,
  });
}

export function dismissFailedAssistantMessage(targetTimestamp: number): void {
  const agent = getActiveAgent();
  if (!agent) return;
  updateAgent(agent.id, (a) => ({
    ...a,
    messages: a.messages.filter(
      (m) => !(m.role === 'assistant' && m.timestamp === targetTimestamp),
    ),
  }));
}

export function setChiefOfStaffOpen(open: boolean): void {
  ensureCosPanel();
  chiefOfStaffOpen.value = open;
  updatePanel(COS_PANEL_ID, { visible: open, minimized: false });
  if (open) bringToFront(COS_PANEL_ID);
  persistPopoutState();
}

export function toggleChiefOfStaff(): void {
  setChiefOfStaffOpen(!chiefOfStaffOpen.value);
}

/** Single well-known tab id for the in-tree CoS pane. */
export const COS_PANE_TAB_ID = 'cos:main';

/**
 * Open the CoS as a first-class pane in the layout tree. If the cos tab
 * already exists, focus/activate it. Otherwise insert it into the focused
 * leaf (or split the main content leaf). Hides the floating popout.
 */
export function openCosInPane(): void {
  // Mobile: the layout renders MobilePageView instead of the pane tree, so a
  // cos:main tab added to the tree would be invisible. Fall back to the
  // floating popout (which has full-screen mobile CSS). Also strip any stale
  // pane tab so the popout's !hasCosTabInTree guard doesn't suppress it.
  if (isMobile.value) {
    const stale = findLeafWithTab(COS_PANE_TAB_ID);
    if (stale) removeTabFromLeaf(stale.id, COS_PANE_TAB_ID);
    setChiefOfStaffOpen(true);
    return;
  }

  // If already open, just activate.
  const existing = findLeafWithTab(COS_PANE_TAB_ID);
  if (existing) {
    setActiveTab(existing.id, COS_PANE_TAB_ID);
    setFocusedLeaf(existing.id);
    // Also hide the floating popout so only one cos UI is visible.
    chiefOfStaffOpen.value = false;
    updatePanel(COS_PANEL_ID, { visible: false });
    persistPopoutState();
    return;
  }

  // Pick a target leaf: focused (non-sidebar) leaf, else first non-sidebar leaf.
  const sidebarIds = new Set([SIDEBAR_LEAF_ID, 'sidebar-sessions', 'sidebar-terminals', 'sidebar-files']);
  const tree = layoutTree.value;
  const focused = focusedLeafId.value;
  let targetLeaf = focused ? findLeaf(tree.root, focused) : null;
  if (!targetLeaf || sidebarIds.has(targetLeaf.id)) {
    const mainLeaf = getAllLeaves(tree.root).find((l) => !sidebarIds.has(l.id));
    targetLeaf = mainLeaf ?? null;
  }
  if (!targetLeaf) return;

  // If the target already has tabs, split right with the cos tab so it gets
  // its own pane rather than becoming a sibling tab. This matches the
  // first-class-pane intent.
  if (targetLeaf.tabs.length > 0) {
    const newLeaf = splitLeaf(targetLeaf.id, 'horizontal', 'second', [COS_PANE_TAB_ID], 0.6);
    if (newLeaf) setFocusedLeaf(newLeaf.id);
  } else {
    addTabToLeaf(targetLeaf.id, COS_PANE_TAB_ID, true);
    setFocusedLeaf(targetLeaf.id);
  }

  // Hide the popout so we show one CoS surface at a time.
  chiefOfStaffOpen.value = false;
  updatePanel(COS_PANEL_ID, { visible: false });
  persistPopoutState();
}

/** True when the CoS tab is present somewhere in the layout tree. */
export function isCosInPane(): boolean {
  return !!findLeafWithTab(COS_PANE_TAB_ID);
}

export function closeCosPane(): void {
  // On mobile the pane-mode surface is the popout (see openCosInPane), so the
  // "close pane" toggle means "hide the popout." Still sweep any stale pane
  // tab so a subsequent open isn't blocked by shouldRenderShell's
  // !hasCosTabInTree guard.
  if (isMobile.value) {
    const stale = findLeafWithTab(COS_PANE_TAB_ID);
    if (stale) removeTabFromLeaf(stale.id, COS_PANE_TAB_ID);
    setChiefOfStaffOpen(false);
    return;
  }
  const existing = findLeafWithTab(COS_PANE_TAB_ID);
  if (!existing) return;
  removeTabFromLeaf(existing.id, COS_PANE_TAB_ID);
}
