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

// Tiny in-memory cache of feedback titles for the dispatch status-line expansion.
const feedbackTitleCache = new Map<string, string>();
const feedbackTitleInFlight = new Map<string, Promise<string | null>>();
export const feedbackTitlesVersion = signal(0);

export function getCachedFeedbackTitle(id: string): string | null {
  return feedbackTitleCache.get(id) ?? null;
}

export async function fetchFeedbackTitle(id: string): Promise<string | null> {
  const cached = feedbackTitleCache.get(id);
  if (cached) return cached;
  const inFlight = feedbackTitleInFlight.get(id);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const token = localStorage.getItem('pw-admin-token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/v1/admin/feedback/${encodeURIComponent(id)}`, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      const title = typeof data?.title === 'string' ? data.title : null;
      if (title) {
        feedbackTitleCache.set(id, title);
        feedbackTitlesVersion.value = feedbackTitlesVersion.value + 1;
      }
      return title;
    } catch {
      return null;
    } finally {
      feedbackTitleInFlight.delete(id);
    }
  })();
  feedbackTitleInFlight.set(id, p);
  return p;
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
  streaming?: boolean;
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
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
};

export type CosLearning = {
  id: string;
  sessionJsonl: string | null;
  type: 'pitfall' | 'suggestion' | 'tool_gap';
  title: string;
  body: string;
  severity: 'low' | 'medium' | 'high';
  createdAt: number;
};

export const cosLearnings = signal<CosLearning[]>([]);
export const cosLearningsLoading = signal(false);

export type WiggumAnnouncement = { summary: string; threadId: string | null; at: number };
export const wiggumAnnouncement = signal<WiggumAnnouncement | null>(null);

export async function loadWiggumAnnouncement(): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/v1/admin/cos/learnings/announcement', { headers });
    if (!res.ok) return;
    const data = await res.json();
    wiggumAnnouncement.value = data?.announcement || null;
  } catch {
    /* non-fatal */
  }
}

export async function loadCosLearnings(): Promise<void> {
  cosLearningsLoading.value = true;
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/v1/admin/cos/learnings', { headers });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.learnings)) {
      cosLearnings.value = data.learnings as CosLearning[];
    }
    // Pull the latest announcement banner alongside learnings.
    void loadWiggumAnnouncement();
  } catch {
    /* non-fatal */
  } finally {
    cosLearningsLoading.value = false;
  }
}

export async function deleteCosLearning(id: string): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`/api/v1/admin/cos/learnings/${id}`, { method: 'DELETE', headers });
    cosLearnings.value = cosLearnings.value.filter((l) => l.id !== id);
  } catch { /* non-fatal */ }
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

/**
 * Extract the user-facing reply from an assistant message. The model is
 * instructed to wrap its reply in <cos-reply>...</cos-reply>; anything outside
 * is internal reasoning. If no tag is present (model misbehaved or mid-stream
 * before the open tag arrives), returns the original text so something is
 * visible. isOpen = true while the tag is open but not yet closed (streaming).
 */
export function extractCosReply(text: string): { displayText: string; hasTag: boolean; isOpen: boolean } {
  if (!text) return { displayText: '', hasTag: false, isOpen: false };
  const openRe = /<cos-reply(?:\s[^>]*)?>/;
  const openMatch = openRe.exec(text);
  if (!openMatch) return { displayText: text, hasTag: false, isOpen: false };
  const contentStart = openMatch.index + openMatch[0].length;
  const rest = text.slice(contentStart);
  const closeIdx = rest.indexOf('</cos-reply>');
  if (closeIdx === -1) {
    return { displayText: rest.replace(/^\s+/, ''), hasTag: true, isOpen: true };
  }
  return { displayText: rest.slice(0, closeIdx).trim(), hasTag: true, isOpen: false };
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
            // Never persist streaming=true across reloads — those streams are dead.
            streaming: false,
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
    } catch { /* ignore */ }
  }
  return {
    role: m?.role === 'assistant' || m?.role === 'system' ? m.role : 'user',
    text: String(m?.text || ''),
    toolCalls,
    timestamp: Number(m?.createdAt) || Date.now(),
    streaming: false,
    attachments,
    elementRefs,
  };
}

/**
 * Fetch the most recent server-side thread + messages for an agent and
 * replace the local in-memory messages with the authoritative server log.
 * Called on module startup so a fresh page load (or cleared localStorage)
 * still sees prior CoS history.
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
    const thread = data?.thread || null;
    const serverMessages: ChiefOfStaffMsg[] = Array.isArray(data?.messages)
      ? data.messages.map(serverMessageToClient)
      : [];

    // Only replace the local log if the server has something. Otherwise
    // leave locally-cached messages untouched (e.g. if the user wrote a
    // turn offline).
    if (!thread && serverMessages.length === 0) return;

    updateAgent(agentId, (a) => ({
      ...a,
      messages: serverMessages,
      threadId: thread?.id ?? a.threadId,
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

async function getOrCreateThread(agent: ChiefOfStaffAgent, appId: string | null): Promise<string | undefined> {
  if (agent.threadId) return agent.threadId;

  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch('/api/v1/admin/chief-of-staff/threads', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: agent.id,
        appId: appId || undefined,
        name: agent.name,
        systemPrompt: agent.systemPrompt || undefined,
        model: agent.model || undefined,
      }),
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const threadId = data?.id as string | undefined;
    if (threadId) {
      updateAgent(agent.id, (a) => ({ ...a, threadId }));
    }
    return threadId;
  } catch {
    return undefined;
  }
}

export async function clearActiveAgentHistory(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) return;

  // Delete server-side thread if it exists
  if (agent.threadId) {
    try {
      const token = localStorage.getItem('pw-admin-token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`/api/v1/admin/chief-of-staff/threads/${agent.threadId}`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      /* non-fatal */
    }
  }

  updateAgent(agent.id, (a) => ({ ...a, messages: [], threadId: undefined }));
}

export async function interruptActiveAgent(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent?.threadId) return;

  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`/api/v1/admin/chief-of-staff/threads/${agent.threadId}/interrupt`, {
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
  const userMsg: ChiefOfStaffMsg = {
    role: 'user',
    text: trimmed,
    timestamp: userTs,
    attachments: attachments.length > 0 ? attachments : undefined,
    elementRefs: elementRefs.length > 0 ? elementRefs : undefined,
  };
  const assistantMsg: ChiefOfStaffMsg = {
    role: 'assistant',
    text: '',
    toolCalls: [],
    timestamp: assistantTs,
    streaming: true,
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
      text: s.text,
      toolCalls: s.toolCalls.length > 0 ? s.toolCalls.map((c) => ({ ...c })) : undefined,
    }));
  };

  chiefOfStaffInFlight.value = chiefOfStaffInFlight.value + 1;

  void (async () => {
    try {
      const token = localStorage.getItem('pw-admin-token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Get or create a server-side thread for this agent
      const threadId = await getOrCreateThread(agent, appId);

      const payload: Record<string, unknown> = {
        text: trimmed,
        systemPrompt: agent.systemPrompt || undefined,
        model: agent.model || undefined,
        appId: appId || undefined,
        threadId: threadId || undefined,
        verbosity: agent.verbosity || DEFAULT_VERBOSITY,
        style: agent.style || DEFAULT_STYLE,
      };
      if (attachments.length > 0) payload.attachments = attachments;
      if (elementRefs.length > 0) payload.elementRefs = elementRefs;

      const res = await fetch('/api/v1/admin/chief-of-staff/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok || !res.body) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const err = await res.json();
          if (err?.error) errMsg = err.error;
        } catch { /* ignore */ }
        throw new Error(errMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const accum: StreamAccum = {
        text: '',
        toolCalls: [],
        toolCallsById: new Map(),
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line (\n\n)
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');

          let event = 'message';
          const dataLines: string[] = [];
          for (const ln of frame.split('\n')) {
            if (ln.startsWith(':')) continue; // comment / keepalive
            if (ln.startsWith('event:')) event = ln.slice(6).trim();
            else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');

          if (event === 'claude') {
            try {
              const obj = JSON.parse(data);
              if (processClaudeEvent(obj, accum)) commit(accum);
            } catch { /* ignore malformed line */ }
          } else if (event === 'error') {
            try {
              const obj = JSON.parse(data);
              throw new Error(obj?.error || 'Claude error');
            } catch (e: any) {
              throw new Error(e?.message || 'Claude error');
            }
          }
          // 'session' and 'done' events: no-op now that we don't persist sessionIds.
        }
      }

      if (!accum.text && accum.toolCalls.length === 0) {
        throw new Error('No response from Claude');
      }

      patchAssistant((m) => ({ ...m, streaming: false }));
    } catch (err: any) {
      const msg = err?.message || 'Request failed';
      chiefOfStaffError.value = msg;
      patchAssistant((m) => ({
        ...m,
        streaming: false,
        text: m.text || `(error) ${msg}`,
      }));
    } finally {
      chiefOfStaffInFlight.value = Math.max(0, chiefOfStaffInFlight.value - 1);
    }
  })();
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
  const existing = findLeafWithTab(COS_PANE_TAB_ID);
  if (!existing) return;
  removeTabFromLeaf(existing.id, COS_PANE_TAB_ID);
}
