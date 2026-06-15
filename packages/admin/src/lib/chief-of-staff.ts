import { signal, effect } from '@preact/signals';
import {
  type ChiefOfStaffToolCall,
  type DispatchInfo,
  extractDispatchInfo,
} from './cos-dispatch-info.js';
import {
  cosThreadSessions,
  cosThreadMeta,
  cosThreadChannels,
  mergeThreadSessions,
  mergeThreadMeta,
  mergeThreadChannels,
  getSessionIdForThread,
  getThreadChannelId,
  getThreadMeta,
  setThreadResolved,
  setThreadArchived,
  leavingThreadIds,
  isThreadLeaving,
  markThreadLeaving,
  type CosThreadMeta,
} from './cos-thread-meta.js';
import {
  ensureCosPanel,
  setChiefOfStaffOpen,
  toggleChiefOfStaff,
  openCosInPane,
  isCosInPane,
  closeCosPane,
  reclampCosPanelToViewport,
  dockCosToLeaf,
  COS_PANE_TAB_ID,
} from './cos-pane.js';
import { subscribeAdmin } from './admin-ws.js';
import { activeChannel, selectedAppId } from './state.js';

export { type ChiefOfStaffToolCall, type DispatchInfo, extractDispatchInfo };
export {
  cosThreadSessions,
  cosThreadMeta,
  cosThreadChannels,
  getSessionIdForThread,
  getThreadChannelId,
  getThreadMeta,
  setThreadResolved,
  setThreadArchived,
  leavingThreadIds,
  isThreadLeaving,
  markThreadLeaving,
  type CosThreadMeta,
};
export {
  ensureCosPanel,
  setChiefOfStaffOpen,
  toggleChiefOfStaff,
  openCosInPane,
  isCosInPane,
  closeCosPane,
  reclampCosPanelToViewport,
  dockCosToLeaf,
  COS_PANE_TAB_ID,
};

// Agent CRUD lives in cos-agent-crud.ts but is re-exported here so existing
// consumers (CosAgentSettings, CosTabList, ChiefOfStaffBubble, …) don't need
// to update their import paths.
export {
  clearActiveAgentHistory,
  interruptActiveAgent,
  interruptThread,
  renameActiveAgent,
  updateActiveAgentSystemPrompt,
  updateActiveAgentModel,
  updateActiveAgentVerbosity,
  updateActiveAgentStyle,
  addAgent,
  removeActiveAgent,
} from './cos-agent-crud.js';

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
  // Pseudo-persona: widget/admin feedback intake threads are minted under
  // this id by the server (mintFeedbackThread). Without this local persona,
  // selecting an inbox thread makes activeAgent null and the CoS shell
  // appears to close.
  {
    id: '__inbox__',
    name: 'Inbox',
    systemPrompt:
      'You are the Inbox overview. Each thread is an intake item from widget or admin feedback. Keep the operator oriented, preserve the original report, and help route or dispatch follow-up work tersely.',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  },
  // Pseudo-persona: every agent_sessions row is auto-minted as a thread under
  // this id by the server (ensureCosThreadsForOrphanSessions). Selecting this
  // rail gives the operator a single place to see every running/idle session
  // as a thread, regardless of whether it originated from CoS chat, feedback,
  // QuickDispatch, or an API call. The systemPrompt is a placeholder — the
  // rail is read-mostly; sending a message here will lazy-create a real CoS
  // thread under this persona just like the other agents.
  {
    id: '__sessions__',
    name: 'Sessions',
    systemPrompt:
      'You are the Sessions overview. Each thread here is a real agent_sessions row — the conversation, dispatch history, and exit state of an underlying session. Keep responses terse and operational.',
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
            // Per-message threadId is what threadKeyOf uses to group replies and
            // match the persisted cosActiveThread on reload. Dropping it here
            // forced thread keys to fall back to positional `idx:N`, which never
            // matched the saved `tid:<id>` key.
            threadId: typeof m.threadId === 'string' ? m.threadId : undefined,
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
    // Merge in any DEFAULT_AGENTS the user is missing. Existing persisted state
    // bypasses DEFAULT_AGENTS entirely, so without this step new pseudo-personas
    // (e.g. __sessions__) would never appear for users who already have local
    // CoS state. Appended at the end so we don't reorder the user's rails.
    for (const def of DEFAULT_AGENTS) {
      if (!agents.some((a) => a.id === def.id)) agents.push({ ...def, messages: [] });
    }
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

// Override permission profile for the next /dispatch slash command. Set via
// `/profile <name>`; consumed (and cleared) by the dispatch slash command so
// the override is one-shot, not sticky.
export const pendingProfileOverride = signal<string | null>(null);

// Provision the popout panel state row up-front so consumers can read its
// floating rect without first calling ensureCosPanel themselves.
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

export function updateAgent(id: string, mutate: (a: ChiefOfStaffAgent) => ChiefOfStaffAgent): void {
  chiefOfStaffAgents.value = chiefOfStaffAgents.value.map((a) => (a.id === id ? mutate(a) : a));
}

export function ensureChiefOfStaffAgent(id: string, name?: string | null): ChiefOfStaffAgent {
  const existing = chiefOfStaffAgents.value.find((a) => a.id === id);
  if (existing) return existing;
  const label = (name || '').trim() || id.replace(/^__|__$/g, '').replace(/[-_]+/g, ' ') || 'Agent';
  const agent: ChiefOfStaffAgent = {
    id,
    name: label.charAt(0).toUpperCase() + label.slice(1),
    systemPrompt:
      'You are an operations assistant for this CoS thread group. Keep responses terse, preserve thread context, and help the operator continue or dispatch the work.',
    model: '',
    messages: [],
    verbosity: DEFAULT_VERBOSITY,
    style: DEFAULT_STYLE,
  };
  chiefOfStaffAgents.value = [...chiefOfStaffAgents.value, agent];
  return agent;
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

function synthesizeThreadAnchorMessage(thread: any): ChiefOfStaffMsg | null {
  const id = typeof thread?.id === 'string' ? thread.id : null;
  if (!id) return null;
  const name = typeof thread?.name === 'string' && thread.name.trim()
    ? thread.name.trim()
    : 'Session thread';
  return {
    role: 'user',
    text: name,
    timestamp: Number(thread?.createdAt) || Number(thread?.updatedAt) || Date.now(),
    threadId: id,
    serverId: `synthetic:${id}`,
    streaming: false,
  };
}

/**
 * Fetch ALL server-side threads + messages for an agent and replace the
 * local in-memory message log. Messages are interleaved across threads and
 * each one carries its threadId, so the client can route replies back to the
 * right Claude session. Called on module startup so a fresh page load (or
 * cleared localStorage) still sees prior CoS history.
 */
export const COS_WORKSPACE_ID = '__cos__';

export async function loadChiefOfStaffHistory(
  agentId: string,
  appId: string | null = null,
  opts: { preserveStreaming?: boolean } = {},
): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // CoS workspace spans all apps — don't filter by appId
    const effectiveAppId = appId === COS_WORKSPACE_ID ? null : appId;
    const qs = effectiveAppId ? `?appId=${encodeURIComponent(effectiveAppId)}` : '';
    const res = await fetch(
      `/api/v1/admin/chief-of-staff/history/${encodeURIComponent(agentId)}${qs}`,
      { headers },
    );
    if (!res.ok) return;
    const data = await res.json();
    const threads = Array.isArray(data?.threads) ? data.threads : (data?.thread ? [data.thread] : []);
    mergeThreadSessions(threads);
    mergeThreadMeta(threads);
    mergeThreadChannels(threads);
    // Server returns rows with `threadId` column — propagate it into each
    // ChiefOfStaffMsg via serverMessageToClient.
    const serverMessages: ChiefOfStaffMsg[] = Array.isArray(data?.messages)
      ? data.messages.map(serverMessageToClient)
      : [];
    const threadIdsWithMessages = new Set(
      serverMessages
        .map((m) => m.threadId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const syntheticAnchors = threads
      .filter((t: any) => {
        const tid = typeof t?.id === 'string' ? t.id : null;
        return tid && !threadIdsWithMessages.has(tid);
      })
      .map(synthesizeThreadAnchorMessage)
      .filter((m: ChiefOfStaffMsg | null): m is ChiefOfStaffMsg => !!m);
    const messages = [...serverMessages, ...syntheticAnchors].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );

    // Only replace the local log if the server has something. Otherwise
    // leave locally-cached messages untouched (e.g. if the user wrote a
    // turn offline).
    if (threads.length === 0 && messages.length === 0) return;

    updateAgent(agentId, (a) => {
      // preserveStreaming: refetch was triggered by a live push (e.g. the
      // cos-message admin-ws topic), and the local log may already hold an
      // optimistic streaming row from a send-in-progress on this same client.
      // A hard replace would clobber that row, snapping the chat back to the
      // pre-stream state until the SSE re-finalized. Instead, keep local rows
      // the server hasn't acknowledged yet (`streaming` / `sending`) and any
      // local rows whose `timestamp` is newer than the most recent server
      // row, so a just-sent message doesn't disappear mid-stream.
      if (!opts.preserveStreaming) {
        return { ...a, messages, threadId: undefined };
      }
      const serverMaxTs = messages.reduce(
        (mx, m) => (m.timestamp && m.timestamp > mx ? m.timestamp : mx),
        0,
      );
      const localOnly = a.messages.filter((m) => {
        if (m.streaming || m.sending) return true;
        return m.timestamp != null && m.timestamp > serverMaxTs;
      });
      const merged = [...messages, ...localOnly].sort(
        (x, y) => (x.timestamp || 0) - (y.timestamp || 0),
      );
      return { ...a, messages: merged, threadId: undefined };
    });
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

// Live refresh: when the server broadcasts that a thread got a new assistant
// message (see chief-of-staff.ts route, onAssistantText), refetch that agent's
// history so the thread block picks up the reply count + summary inline. Two
// guards keep this cheap:
//   1. Per-agent debounce: bursts of replies from parallel threads coalesce
//      into a single refetch within DEBOUNCE_MS.
//   2. preserveStreaming: the in-flight composer SSE keeps its optimistic row
//      intact across the refetch (the merge in loadChiefOfStaffHistory above).
const COS_LIVE_REFRESH_DEBOUNCE_MS = 500;
const pendingCosLiveRefresh = new Map<string, ReturnType<typeof setTimeout>>();
void (async () => {
  subscribeAdmin('cos-message', (data: { agentId?: string; threadId?: string } | null) => {
    const agentId = data?.agentId;
    if (!agentId) return;
    // Ignore broadcasts for agents this client hasn't loaded yet — those
    // will get fetched lazily on first selection.
    if (!chiefOfStaffAgents.value.some((a) => a.id === agentId)) return;
    const prev = pendingCosLiveRefresh.get(agentId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      pendingCosLiveRefresh.delete(agentId);
      void loadChiefOfStaffHistory(agentId, selectedAppId.value, { preserveStreaming: true });
    }, COS_LIVE_REFRESH_DEBOUNCE_MS);
    pendingCosLiveRefresh.set(agentId, timer);
  });
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
    const channelId = activeChannel.value?.id ?? undefined;

    const res = await fetch('/api/v1/admin/chief-of-staff/threads', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: agent.id,
        appId: (appId && appId !== COS_WORKSPACE_ID) ? appId : undefined,
        channelId,
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
      mergeThreadChannels([data]);
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
/**
 * Dispatches a CoS message. Resolves once the server has accepted the turn
 * (POST /chat returned 202 with a turn descriptor). Rejects if that POST
 * fails. Live SSE streaming continues in the background after resolve — the
 * resolved promise just means "the server has the message, the composer can
 * safely clear." Callers that don't care can `void` the return.
 */
export function sendChiefOfStaffMessage(
  text: string,
  appId: string | null,
  opts?: SendCosOptions,
): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) return Promise.resolve();
  const trimmed = text.trim();
  const attachments = opts?.attachments ?? [];
  const elementRefs = opts?.elementRefs ?? [];
  if (!trimmed && attachments.length === 0 && elementRefs.length === 0) return Promise.resolve();

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

  // Deferred promise that resolves on POST /chat 202 ack (rejects on POST
  // failure). Composer awaits this to keep the textarea frozen until the
  // server has the message — see CosComposer.submit().
  let resolveAck!: () => void;
  let rejectAck!: (e: Error) => void;
  const ackPromise = new Promise<void>((res, rej) => {
    resolveAck = res;
    rejectAck = rej;
  });

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

      // CoS workspace spans all apps — don't lock the thread to a specific app
      const effectiveAppId = appId === COS_WORKSPACE_ID ? null : appId;
      const payload: Record<string, unknown> = {
        text: trimmed,
        systemPrompt: agent.systemPrompt || undefined,
        model: agent.model || undefined,
        appId: effectiveAppId || undefined,
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

      let chatAck: { turnId?: string; threadId?: string; startSeq?: number; agentSessionId?: string };
      try {
        chatAck = await res.json();
      } catch {
        throw new Error('Server did not return a turn descriptor');
      }
      if (!chatAck.turnId || !chatAck.threadId) {
        throw new Error('Server did not return a turnId');
      }

      // POST acked — composer can safely clear now.
      resolveAck();

      const myTurnId = chatAck.turnId;
      const ackThreadId = chatAck.threadId;
      threadIdForResume = ackThreadId;
      const initialFromSeq = typeof chatAck.startSeq === 'number' ? chatAck.startSeq : 0;
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
      // Reject the composer-ack promise so the textarea unfreezes with the
      // operator's text intact. resolveAck() may have already run if the
      // POST ack succeeded but the SSE stream failed afterward — Promise
      // semantics already swallow the second settle, so this is safe either
      // way.
      rejectAck(err instanceof Error ? err : new Error(msg));
    } finally {
      chiefOfStaffInFlight.value = Math.max(0, chiefOfStaffInFlight.value - 1);
    }
  })();

  return ackPromise;
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
  }).catch(() => { /* error already surfaces via chiefOfStaffError */ });
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
