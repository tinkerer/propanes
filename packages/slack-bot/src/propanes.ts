/** Authenticated API access; keep credentials out of URLs, errors and logs. */
import type { AgentEndpointInfo } from './agents';
import type { AppInfo } from './apps';
import type { InfraList } from './infra';
import type { DownloadedFile } from './attachments';
import type { Runtime } from './options';
import type { ModelOption } from './models';

export class PropanesApiError extends Error {
  constructor(public readonly path: string, public readonly status: number, detail?: string) {
    super(`Propanes ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'PropanesApiError';
  }
}

function sanitizeDetail(body: string): string | undefined {
  // Only a JSON `error` field is surfaced (the admin UI shows the same text);
  // raw bodies, stack traces and headers never reach Slack or the journal.
  try {
    const parsed = JSON.parse(body);
    const err = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    if (typeof err === 'string' && err.trim()) return err.replace(/\s+/g, ' ').slice(0, 300);
  } catch { /* not JSON */ }
  return undefined;
}

/** A fixed token, or a source that mints/refreshes one per request (the shared
 * bot's per-user tokens). */
export type TokenSource = string | undefined | (() => Promise<string>);

export function createPropanesFetch(
  baseUrl: string,
  token: TokenSource,
  request: typeof fetch = fetch,
) {
  if (typeof token !== 'function' && !token?.trim()) throw new Error('Configure PROPANES_TOKEN for the Slack listener.');
  const bearer = typeof token === 'function' ? token : async () => token!;
  const base = baseUrl.replace(/\/$/, '');
  const raw = async (path: string, opts?: RequestInit): Promise<Response> => {
    const headers = new Headers(opts?.headers);
    // Multipart bodies set their own boundary; only JSON strings get the header.
    if (!headers.has('Content-Type') && typeof opts?.body === 'string') headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${(await bearer()).trim()}`);
    const response = await request(`${base}${path}`, {
      ...opts,
      headers,
      signal: opts?.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PropanesApiError(path, response.status, sanitizeDetail(body));
    }
    return response;
  };
  const json = async (path: string, opts?: RequestInit): Promise<any> => (await raw(path, opts)).json();
  return Object.assign(json, { raw });
}

export type PropanesFetch = ReturnType<typeof createPropanesFetch>;

export interface SessionInfo {
  id: string;
  status: string;
  inputState?: string | null;
  runtime?: string | null;
  permissionProfile?: string | null;
  feedbackId?: string | null;
  claudeSessionId?: string | null;
  title?: string | null;
  appId?: string | null;
  feedbackTitle?: string | null;
  launcherName?: string | null;
  machineName?: string | null;
  agentEndpointId?: string | null;
  launcherId?: string | null;
}

/** An admin "Continue in Slack" request (server: slack-handoffs.ts). */
export interface SlackHandoffRequest { id: string; sessionId: string; requestedBy: string; }

export interface JsonlDelta {
  cursor: string;
  reset: boolean;
  order: string[];
  files: { key: string; lines: string }[];
  pending?: boolean;
}

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'cancelled', 'deleted']);
export function isLive(status: string | null | undefined): boolean {
  return status === 'running' || status === 'pending' || status === 'dispatching';
}

/** The same backend operations the admin structured view uses. */
export interface PropanesClient {
  me(): Promise<{ user: { id: string; username: string; role: string } }>;
  createTerminal(input: { appId?: string; launcherId?: string; cwd?: string; permissionProfile: 'plain' }): Promise<{ sessionId: string }>;
  listAgents(appId: string): Promise<AgentEndpointInfo[]>;
  /** GET /api/v1/admin/applications — the registered projects a session can run in. */
  listApplications(): Promise<AppInfo[]>;
  /** GET /api/v1/admin/dispatch-targets — connected launchers/machines plus the server host (the dispatch popup's target list). */
  listDispatchTargets(): Promise<InfraList>;
  /** POST /api/v1/feedback — JSON, or multipart with `screenshots` when images are attached
   * (the same shape the admin composer submits; screenshots render into the prompt). */
  createFeedback(input: { title: string; description: string; appId: string; tags?: string[]; screenshots?: DownloadedFile[] }): Promise<{ id: string }>;
  /** POST /api/v1/screenshots — InterruptBar's image attachments for a running session. */
  uploadScreenshots(sessionId: string | undefined, images: DownloadedFile[], appId: string): Promise<{ screenshots: { id: string; filename: string; path: string }[] }>;
  /** POST /api/v1/uploads — the composer's non-image file attachments. */
  uploadFiles(sessionId: string | undefined, files: DownloadedFile[], appId: string): Promise<{ files: { id: string; filename: string; originalName: string; path: string }[] }>;
  /** POST /api/v1/admin/dispatch — what the admin dispatch popup calls. */
  dispatch(input: { feedbackId: string; agentEndpointId: string; model?: string; instructions: string; permissionProfile: string; launcherId?: string }): Promise<{ sessionId: string }>;
  getSession(id: string): Promise<SessionInfo>;
  /** Active sessions visible to the bot's bearer token; no recent-row limit. */
  listActiveSessions(): Promise<SessionInfo[]>;
  /** Session rows for a feedback item, newest first, with live inputState. */
  listSessions(feedbackId: string): Promise<SessionInfo[]>;
  /** POST /:id/send-keys — SessionInputBar.sendTerminalText for a running session. */
  sendKeys(id: string, keys: string): Promise<{ ok: boolean; error?: string }>;
  /** POST /:id/resume — SessionInputBar.submitPrompt for a stopped session. */
  resume(id: string, input: { additionalPrompt: string; model?: string; runtime?: Runtime; permissionProfile?: string }): Promise<{ sessionId: string }>;
  fork(id: string, input: { additionalPrompt?: string }): Promise<{ sessionId: string }>;
  kill(id: string): Promise<void>;
  /** POST /:id/jsonl — the structured view's differential transcript poll. */
  jsonlDelta(id: string, cursor: string, tail: number): Promise<JsonlDelta>;
  /** POST /slack-handoffs/claim — the admin's queued "Continue in Slack" requests. */
  claimHandoffs(): Promise<SlackHandoffRequest[]>;
  /** POST /slack-handoffs/:id/result — what the admin toast shows. */
  reportHandoff(id: string, result: { ok: boolean; message: string; permalink?: string }): Promise<void>;
  /** GET /models — the runtime's models as this user's CLI logins see them
   * (discovered on their pinned launcher, else the server host). */
  discoverModels(runtime: Runtime): Promise<ModelOption[]>;
  /** GET an image the transcript elided (jsonl-image URL from the server). */
  fetchImage(path: string): Promise<{ bytes: Buffer; mime: string }>;
}

// Buffer is typed over ArrayBufferLike; Blob wants a plain ArrayBuffer view.
const toBlob = (f: DownloadedFile) => new Blob([f.bytes as unknown as Uint8Array<ArrayBuffer>], { type: f.mime });

export function createPropanesClient(api: PropanesFetch): PropanesClient {
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  return {
    me: () => api('/api/v1/auth/me'),
    createTerminal: async (input) => {
      const result = await post('/api/v1/admin/terminal', input);
      if (!result?.sessionId) throw new Error('terminal did not return a session id');
      return { sessionId: result.sessionId };
    },
    listAgents: (appId) => api(`/api/v1/admin/agents?appId=${encodeURIComponent(appId)}`),
    listDispatchTargets: async () => {
      const r = await api('/api/v1/admin/dispatch-targets');
      return { targets: Array.isArray(r?.targets) ? r.targets : [], localTarget: r?.localTarget ?? null };
    },
    listApplications: async () => {
      const rows = await api('/api/v1/admin/applications');
      return (Array.isArray(rows) ? rows : rows?.applications ?? []).map((a: any) => ({ id: a.id, name: a.name ?? a.id, projectDir: a.projectDir ?? null, description: a.description ?? null }));
    },
    createFeedback: (input) => {
      const { screenshots, ...fields } = input;
      if (!screenshots?.length) return post('/api/v1/feedback', { type: 'manual', ...fields });
      const fd = new FormData();
      fd.append('feedback', JSON.stringify({ type: 'manual', ...fields }));
      for (const f of screenshots) fd.append('screenshots', toBlob(f), f.name);
      return api('/api/v1/feedback', { method: 'POST', body: fd });
    },
    uploadScreenshots: (sessionId, images, appId) => {
      const fd = new FormData();
      for (const f of images) fd.append('screenshots', toBlob(f), f.name);
      fd.append('meta', JSON.stringify({ sessionId, appId, sourceUrl: 'slack' }));
      return api('/api/v1/screenshots', { method: 'POST', body: fd });
    },
    uploadFiles: (sessionId, files, appId) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', toBlob(f), f.name);
      fd.append('meta', JSON.stringify({ sessionId, appId, sourceUrl: 'slack' }));
      return api('/api/v1/uploads', { method: 'POST', body: fd });
    },
    dispatch: async (input) => {
      const result = await post('/api/v1/admin/dispatch', input);
      const sessionId = result?.sessionId ?? result?.id;
      if (!sessionId) throw new Error(result?.error || result?.reason || 'dispatch did not return a session id');
      return { sessionId };
    },
    getSession: (id) => api(`/api/v1/admin/agent-sessions/${encodeURIComponent(id)}`),
    listActiveSessions: async () => {
      const rows: SessionInfo[] = await api('/api/v1/admin/agent-sessions');
      return rows.filter(row => isLive(row.status));
    },
    listSessions: (feedbackId) => api(`/api/v1/admin/agent-sessions?feedbackId=${encodeURIComponent(feedbackId)}`),
    sendKeys: async (id, keys) => {
      try {
        const r = await post(`/api/v1/admin/agent-sessions/${encodeURIComponent(id)}/send-keys`, { keys, enter: true });
        return { ok: !!r?.ok, error: r?.error };
      } catch (err) {
        return { ok: false, error: err instanceof PropanesApiError ? err.message : 'send-keys failed' };
      }
    },
    resume: async (id, input) => {
      const r = await api(`/api/v1/admin/agent-sessions/${encodeURIComponent(id)}/resume`, {
        method: 'POST',
        headers: { 'x-propanes-resume-source': 'slack.thread-reply' },
        body: JSON.stringify(input),
      });
      const sessionId = r?.sessionId ?? r?.id;
      if (!sessionId) throw new Error('resume did not return a session id');
      return { sessionId };
    },
    fork: async (id, input) => {
      const result = await post(`/api/v1/admin/agent-sessions/${encodeURIComponent(id)}/fork`, input);
      if (!result?.sessionId) throw new Error('fork did not return a session id');
      return { sessionId: result.sessionId };
    },
    kill: async (id) => { await post(`/api/v1/admin/agent-sessions/${encodeURIComponent(id)}/kill`, {}); },
    jsonlDelta: (id, cursor, tail) => post(`/api/v1/admin/agent-sessions/${encodeURIComponent(id)}/jsonl`, { cursor, tail }),
    claimHandoffs: async () => {
      const r = await post('/api/v1/admin/slack-handoffs/claim', {});
      return Array.isArray(r?.handoffs) ? r.handoffs : [];
    },
    reportHandoff: async (id, result) => { await post(`/api/v1/admin/slack-handoffs/${encodeURIComponent(id)}/result`, result); },
    discoverModels: async (runtime) => {
      const r = await api(`/api/v1/admin/models?runtime=${runtime}`);
      return Array.isArray(r?.models) ? r.models : [];
    },
    fetchImage: async (path) => {
      const res = await api.raw(path, { method: 'GET' });
      const mime = res.headers.get('content-type') || 'application/octet-stream';
      return { bytes: Buffer.from(await res.arrayBuffer()), mime };
    },
  };
}
