const BASE = '/api/v1';

function getToken(): string | null {
  return localStorage.getItem('pw-admin-token');
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Content-Type'] && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('pw-admin-token');
    window.location.hash = '#/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getFeedback: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return request<{
      items: any[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(`/admin/feedback?${qs}`);
  },

  getFeedbackById: (id: string) => request<any>(`/admin/feedback/${id}`),

  createFeedback: (data: { title: string; description?: string; type?: string; appId: string; tags?: string[] }) =>
    request<{ id: string; status: string; createdAt: string }>('/admin/feedback', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateFeedback: (id: string, data: Record<string, unknown>) =>
    request(`/admin/feedback/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteFeedback: (id: string) =>
    request(`/admin/feedback/${id}`, { method: 'DELETE' }),

  batchOperation: (data: { ids: string[]; operation: string; value?: string }) =>
    request('/admin/feedback/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getAgents: (appId?: string) => {
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return request<any[]>(`/admin/agents${qs}`);
  },

  createAgent: (data: Record<string, unknown>) =>
    request('/admin/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateAgent: (id: string, data: Record<string, unknown>) =>
    request(`/admin/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteAgent: (id: string) =>
    request(`/admin/agents/${id}`, { method: 'DELETE' }),

  dispatch: (data: { feedbackId: string; agentEndpointId: string; instructions?: string; launcherId?: string }) =>
    request<{ dispatched: boolean; sessionId?: string; status: number; response: string }>('/admin/dispatch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  spawnTerminal: (data?: { cwd?: string; appId?: string; launcherId?: string; harnessConfigId?: string }) =>
    request<{ sessionId: string }>('/admin/terminal', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),

  getDispatchTargets: () =>
    request<{ targets: Array<{
      launcherId: string;
      name: string;
      hostname: string;
      machineName: string | null;
      machineId: string | null;
      isHarness: boolean;
      harnessConfigId: string | null;
      activeSessions: number;
      maxSessions: number;
    }> }>('/admin/dispatch-targets'),

  listTmuxSessions: () =>
    request<{ sessions: { name: string; windows: number; created: string; attached: boolean }[] }>('/admin/tmux-sessions'),

  attachTmuxSession: (data: { tmuxTarget: string; appId?: string }) =>
    request<{ sessionId: string }>('/admin/terminal/attach-tmux', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getApplications: () => request<any[]>('/admin/applications'),

  getApplication: (id: string) => request<any>(`/admin/applications/${id}`),

  createApplication: (data: Record<string, unknown>) =>
    request<{ id: string; apiKey: string }>('/admin/applications', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateApplication: (id: string, data: Record<string, unknown>) =>
    request(`/admin/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteApplication: (id: string) =>
    request(`/admin/applications/${id}`, { method: 'DELETE' }),

  runControlAction: (appId: string, actionId: string) =>
    request<{ sessionId: string; actionId: string }>(`/admin/applications/${appId}/run-action`, {
      method: 'POST',
      body: JSON.stringify({ actionId }),
    }),

  submitAppRequest: (appId: string, data: { request: string; preferences?: string[] }) =>
    request<{ sessionId: string; feedbackId: string }>(`/admin/applications/${appId}/request`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  designAssist: (appId: string, data: { request: string; context: string; settingPath?: string }) =>
    request<{ sessionId: string; feedbackId: string }>(`/admin/applications/${appId}/design-assist`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  setupAssist: (data: { request: string; entityType: 'machine' | 'harness' | 'agent'; entityId?: string }) =>
    request<{ sessionId: string; feedbackId: string; companionSessionId?: string }>('/admin/setup-assist', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  scaffoldApp: (data: { name: string; parentDir: string; projectName: string }) =>
    request<{ id: string; apiKey: string; projectDir: string }>('/admin/applications/scaffold', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  cloneApp: (data: { name: string; gitUrl: string; parentDir: string; dirName?: string }) =>
    request<{ id: string; apiKey: string; projectDir: string }>('/admin/applications/clone', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  regenerateApplicationKey: (id: string) =>
    request<{ id: string; apiKey: string }>(`/admin/applications/${id}/regenerate-key`, {
      method: 'POST',
    }),

  // Agent sessions
  getAgentSessions: (feedbackId?: string, includeIds?: string[], includeDeleted?: boolean) => {
    const params = new URLSearchParams();
    if (feedbackId) params.set('feedbackId', feedbackId);
    if (includeIds?.length) params.set('include', includeIds.join(','));
    if (includeDeleted) params.set('includeDeleted', 'true');
    const qs = params.toString();
    return request<any[]>(`/admin/agent-sessions${qs ? `?${qs}` : ''}`);
  },

  getAgentSession: (id: string) =>
    request<any>(`/admin/agent-sessions/${id}`),

  killAgentSession: (id: string) =>
    request<{ id: string; killed: boolean }>(`/admin/agent-sessions/${id}/kill`, {
      method: 'POST',
    }),

  resumeAgentSession: (id: string) =>
    request<{ sessionId: string }>(`/admin/agent-sessions/${id}/resume`, {
      method: 'POST',
    }),

  archiveAgentSession: (id: string) =>
    request<{ id: string; archived: boolean }>(`/admin/agent-sessions/${id}/archive`, {
      method: 'POST',
    }),

  deleteAgentSession: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/admin/agent-sessions/${id}`, {
      method: 'DELETE',
    }),

  openSessionInTerminal: (id: string) =>
    request<{ ok: boolean; tmuxName: string }>(`/admin/agent-sessions/${id}/open-terminal`, {
      method: 'POST',
    }),

  getJsonl: async (id: string): Promise<string> => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/admin/agent-sessions/${id}/jsonl`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },

  tailJsonl: (id: string) =>
    request<{ sessionId: string; jsonlPath: string }>(`/admin/agent-sessions/${id}/tail-jsonl`, {
      method: 'POST',
    }),

  // Aggregate / clustering
  getAggregate: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return request<{
      clusters: any[];
      totalGroups: number;
      totalItems: number;
    }>(`/admin/aggregate?${qs}`);
  },

  analyzeAggregate: (data: { appId: string; agentEndpointId: string }) =>
    request<{ sessionId: string; feedbackId: string; itemCount: number }>('/admin/aggregate/analyze', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  analyzeCluster: (data: { appId: string; agentEndpointId: string; feedbackIds: string[]; clusterTitle: string }) =>
    request<{ sessionId: string; feedbackId: string; itemCount: number }>('/admin/aggregate/analyze-cluster', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getPlans: (appId?: string) => {
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return request<any[]>(`/admin/aggregate/plans${qs}`);
  },

  createPlan: (data: Record<string, unknown>) =>
    request<{ id: string }>('/admin/aggregate/plans', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updatePlan: (id: string, data: Record<string, unknown>) =>
    request(`/admin/aggregate/plans/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deletePlan: (id: string) =>
    request(`/admin/aggregate/plans/${id}`, { method: 'DELETE' }),

  // Live widget connections
  getLiveConnections: () =>
    request<{
      sessionId: string;
      connectedAt: string;
      lastActivity: string;
      userAgent: string | null;
      url: string | null;
      viewport: string | null;
      userId: string | null;
      appId: string | null;
      name: string | null;
      tags: string[];
      activityLog: { ts: string; command: string; category: string; ok: boolean; durationMs: number }[];
    }[]>('/agent/sessions'),

  // Tmux config (legacy)
  getTmuxConf: () =>
    request<{ content: string }>('/admin/tmux-conf'),

  saveTmuxConf: (content: string) =>
    request<{ saved: boolean }>('/admin/tmux-conf', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Tmux configs (multi-config)
  getTmuxConfigs: () =>
    request<any[]>('/admin/tmux-configs'),

  createTmuxConfig: (data: { name: string; content?: string }) =>
    request<{ id: string }>('/admin/tmux-configs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateTmuxConfig: (id: string, data: { name?: string; content?: string; isDefault?: boolean }) =>
    request<{ id: string; updated: boolean }>(`/admin/tmux-configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteTmuxConfig: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/admin/tmux-configs/${id}`, {
      method: 'DELETE',
    }),

  editTmuxConfigInTerminal: (id: string) =>
    request<{ sessionId: string; configId: string }>(`/admin/tmux-configs/${id}/edit-terminal`, {
      method: 'POST',
    }),

  saveTmuxConfigFromFile: (id: string) =>
    request<{ saved: boolean; content: string }>(`/admin/tmux-configs/${id}/save-from-file`, {
      method: 'POST',
    }),

  // Launchers
  getLaunchers: () =>
    request<{ launchers: any[] }>('/admin/launchers'),

  getHarnesses: () =>
    request<{ harnesses: any[] }>('/admin/launchers/harnesses'),

  getLauncher: (id: string) =>
    request<any>(`/admin/launchers/${id}`),

  deleteLauncher: (id: string) =>
    request<{ ok: boolean; id: string }>(`/admin/launchers/${id}`, { method: 'DELETE' }),

  // Machines
  getMachines: () => request<any[]>('/admin/machines'),

  createMachine: (data: Record<string, unknown>) =>
    request<any>('/admin/machines', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateMachine: (id: string, data: Record<string, unknown>) =>
    request<any>(`/admin/machines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteMachine: (id: string) =>
    request<{ ok: boolean; id: string }>(`/admin/machines/${id}`, { method: 'DELETE' }),

  // Harness configs
  getHarnessConfigs: (appId?: string) => {
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return request<any[]>(`/admin/harness-configs${qs}`);
  },

  createHarnessConfig: (data: Record<string, unknown>) =>
    request<any>('/admin/harness-configs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateHarnessConfig: (id: string, data: Record<string, unknown>) =>
    request<any>(`/admin/harness-configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteHarnessConfig: (id: string) =>
    request<{ ok: boolean; id: string }>(`/admin/harness-configs/${id}`, { method: 'DELETE' }),

  startHarness: (id: string) =>
    request<{ ok: boolean; status: string }>(`/admin/harness-configs/${id}/start`, { method: 'POST' }),

  stopHarness: (id: string) =>
    request<{ ok: boolean; status: string }>(`/admin/harness-configs/${id}/stop`, { method: 'POST' }),

  launchHarnessSession: (id: string, data?: { prompt?: string; permissionProfile?: string; serviceName?: string }) =>
    request<{ ok: boolean; sessionId: string }>(`/admin/harness-configs/${id}/session`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),

  getDefaultPromptTemplate: () =>
    request<{ template: string }>('/admin/default-prompt-template'),

  readFile: (path: string) =>
    request<{ path: string; content: string; size: number }>(`/admin/read-file?path=${encodeURIComponent(path)}`),

  readFileImage: async (path: string): Promise<string> => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/admin/read-file?path=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  browseDirs: (path?: string) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return request<{ path: string; parent: string | null; dirs: string[] }>(`/admin/browse-dirs${qs}`);
  },

  deleteScreenshot: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/images/${id}`, { method: 'DELETE' }),

  triggerAppendMode: (sessionId: string, feedbackId: string) =>
    request<{ appendMode: boolean; feedbackId: string }>(
      `/agent/sessions/${sessionId}/append-feedback`,
      { method: 'POST', body: JSON.stringify({ feedbackId }) }
    ),

  captureSessionScreenshot: (sessionId: string) =>
    request<{ dataUrl: string }>(`/agent/sessions/${sessionId}/screenshot`, { method: 'POST' }),

  getSessionConsole: (sessionId: string) =>
    request<{ logs: any[] }>(`/agent/sessions/${sessionId}/console`),

  getSessionNetwork: (sessionId: string) =>
    request<{ errors: any[] }>(`/agent/sessions/${sessionId}/network`),

  replaceImage: (imageId: string, blob: Blob) => {
    const fd = new FormData();
    fd.append('image', blob, 'crop.png');
    return request<{ id: string; size: number; replaced: boolean }>(`/images/${imageId}`, {
      method: 'PUT',
      body: fd,
    });
  },

  saveImageAsNew: (feedbackId: string, blob: Blob) => {
    const fd = new FormData();
    fd.append('image', blob, 'crop.png');
    fd.append('feedbackId', feedbackId);
    return request<{ id: string; feedbackId: string; filename: string; size: number }>('/images', {
      method: 'POST',
      body: fd,
    });
  },
};
