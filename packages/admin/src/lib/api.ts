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

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
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

  dispatch: (data: { feedbackId: string; agentEndpointId: string; instructions?: string; launcherId?: string; harnessConfigId?: string }) =>
    request<{ dispatched: boolean; sessionId?: string; status: number; response: string }>('/admin/dispatch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  listNotifications: () =>
    request<{ notifications: any[] }>('/admin/notifications'),

  resolveNotification: (id: string, action: string, response?: unknown) =>
    request<{ notification: any }>(`/admin/notifications/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, response }),
    }),

  deleteNotification: (id: string) =>
    request<{ ok: boolean }>(`/admin/notifications/${id}`, { method: 'DELETE' }),

  clearResolvedNotifications: () =>
    request<{ removed: number }>('/admin/notifications/clear-resolved', { method: 'POST' }),

  cancelPendingDispatch: (pendingId: string) =>
    request<{ cancelled: boolean; deletedFeedback?: boolean }>(`/voice/pending-dispatches/${pendingId}/cancel`, {
      method: 'POST',
    }),

  launchPendingDispatchNow: (pendingId: string) =>
    request<{ ok: boolean }>(`/voice/pending-dispatches/${pendingId}/launch-now`, {
      method: 'POST',
    }),

  editPendingDispatch: (pendingId: string) =>
    request<{ cancelled: boolean; feedbackId?: string }>(`/voice/pending-dispatches/${pendingId}/edit`, {
      method: 'POST',
    }),

  spawnTerminal: (data?: { cwd?: string; appId?: string; launcherId?: string; harnessConfigId?: string; permissionProfile?: string }) =>
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
      isSprite?: boolean;
      spriteConfigId?: string | null;
      activeSessions: number;
      maxSessions: number;
      online: boolean;
    }> }>('/admin/dispatch-targets'),

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

  setupAssist: (data: { request: string; entityType: 'machine' | 'harness' | 'agent' | 'sprite'; entityId?: string }) =>
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

  onboardAssist: (data: { request: string }) =>
    request<{ sessionId: string; feedbackId: string }>('/admin/applications/onboard-assist', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  regenerateApplicationKey: (id: string) =>
    request<{ id: string; apiKey: string }>(`/admin/applications/${id}/regenerate-key`, {
      method: 'POST',
    }),

  // Agent sessions
  searchSessionContent: (data: { query?: string; errorsOnly?: boolean; limit?: number }) =>
    request<{
      results: Array<{
        sessionId: string;
        feedbackTitle: string | null;
        agentName: string | null;
        status: string;
        createdAt: string | null;
        errorCount: number;
        matches: Array<{ line: number; content: string; isError: boolean; toolName?: string }>;
      }>;
      total: number;
    }>('/admin/agent-sessions/search-content', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getSessionErrorSummary: () =>
    request<{
      sessions: Array<{
        sessionId: string;
        feedbackTitle: string | null;
        agentName: string | null;
        status: string;
        errorCount: number;
        errors: Array<{ content: string; toolName?: string }>;
      }>;
      totalErrorSessions: number;
      consoleErrors?: Array<{
        widgetSessionId: string;
        url: string | null;
        errors: Array<{ level: string; message: string; source?: string }>;
      }>;
    }>('/admin/agent-sessions/error-summary'),

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

  resumeAgentSession: (id: string, opts?: { permissionProfile?: string }) =>
    request<{ sessionId: string }>(`/admin/agent-sessions/${id}/resume`, {
      method: 'POST',
      body: opts ? JSON.stringify(opts) : undefined,
    }),

  archiveAgentSession: (id: string) =>
    request<{ id: string; archived: boolean }>(`/admin/agent-sessions/${id}/archive`, {
      method: 'POST',
    }),

  deleteAgentSession: (id: string) =>
    request<{ id: string; deleted: boolean }>(`/admin/agent-sessions/${id}`, {
      method: 'DELETE',
    }),

  getJsonl: async (id: string, fileFilter?: string): Promise<string> => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const qs = fileFilter ? `?file=${encodeURIComponent(fileFilter)}` : '';
    const res = await fetch(`${BASE}/admin/agent-sessions/${id}/jsonl${qs}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },

  getJsonlFiles: (id: string) =>
    request<{
      claudeSessionId: string;
      files: Array<{
        id: string;
        claudeSessionId: string;
        type: 'main' | 'continuation' | 'subagent';
        label: string;
        parentSessionId: string | null;
        agentId: string | null;
        order: number;
      }>;
    }>(`/admin/agent-sessions/${id}/jsonl-files`),

  tailJsonl: (id: string) =>
    request<{ sessionId: string; jsonlPath: string }>(`/admin/agent-sessions/${id}/tail-jsonl`, {
      method: 'POST',
    }),

  sendKeys: (id: string, data: { keys: string; enter?: boolean }) =>
    request<{ ok: boolean; error?: string }>(`/admin/agent-sessions/${id}/send-keys`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  capturePane: (id: string, data?: { lastN?: number }) =>
    request<{ ok: boolean; content?: string; error?: string }>(`/admin/agent-sessions/${id}/capture-pane`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
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

  clusterAndTag: (data: { appId: string; excludeAlreadyAggregated?: boolean }) =>
    request<{ clustersFound: number; itemsTagged: number; themes: string[] }>('/admin/aggregate/cluster-and-tag', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getFeedbackTags: (appId?: string) => {
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return request<{ tag: string; count: number }[]>(`/admin/feedback/tags${qs}`);
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

  // Launchers
  getLaunchers: () =>
    request<{ launchers: any[] }>('/admin/launchers'),

  getHarnesses: () =>
    request<{ harnesses: any[] }>('/admin/launchers/harnesses'),

  getLauncher: (id: string) =>
    request<any>(`/admin/launchers/${id}`),

  deleteLauncher: (id: string) =>
    request<{ ok: boolean; id: string }>(`/admin/launchers/${id}`, { method: 'DELETE' }),

  restartLauncher: (id: string) =>
    request<{ ok: boolean }>(`/admin/launchers/${id}/restart`, { method: 'POST' }),

  getSystemdTemplate: async (id: string): Promise<string> => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/admin/launchers/${id}/systemd-template`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },

  getLauncherHealth: (id: string) =>
    request<{
      uptime: number;
      nodeVersion: string;
      launcherVersion: string;
      platform: string;
      arch: string;
      memory: { total: number; free: number };
      activeSessions: number;
      capabilities: { maxSessions: number; hasClaudeCli: boolean; hasDocker?: boolean };
      claudeCliVersion?: string;
      dockerVersion?: string;
      claudeHomeExists: boolean;
    }>(`/admin/launchers/${id}/health`),

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

  checkMachineAdminHealth: (id: string) =>
    request<{ alive: boolean; status?: number; reason?: string }>(`/admin/machines/${id}/admin-health`),

  startMachineAdmin: (id: string) =>
    request<{ ok: boolean; sessionId: string }>(`/admin/machines/${id}/admin-start`, { method: 'POST' }),

  stopMachineAdmin: (id: string) =>
    request<{ ok: boolean; sessionId: string }>(`/admin/machines/${id}/admin-stop`, { method: 'POST' }),

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

  checkClaudeAuth: (harnessConfigId: string) =>
    request<{
      hasClaudeDir: boolean;
      hasCredentials: boolean;
      claudeVersion?: string;
      error?: string;
    }>(`/admin/harness-configs/${harnessConfigId}/check-auth`, { method: 'POST' }),

  checkContainerClaude: (harnessConfigId: string) =>
    request<{
      hasClaudeCli: boolean;
      claudeVersion?: string;
      hasCredentials: boolean;
      error?: string;
    }>(`/admin/harness-configs/${harnessConfigId}/check-container-claude`, { method: 'POST' }),

  // Sprite configs
  getSpriteConfigs: (appId?: string) => {
    const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return request<any[]>(`/admin/sprite-configs${qs}`);
  },

  createSpriteConfig: (data: Record<string, unknown>) =>
    request<any>('/admin/sprite-configs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateSpriteConfig: (id: string, data: Record<string, unknown>) =>
    request<any>(`/admin/sprite-configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteSpriteConfig: (id: string) =>
    request<{ ok: boolean; id: string }>(`/admin/sprite-configs/${id}`, { method: 'DELETE' }),

  provisionSprite: (id: string) =>
    request<{ ok: boolean; status: string; spriteId?: string }>(`/admin/sprite-configs/${id}/provision`, { method: 'POST' }),

  destroySprite: (id: string) =>
    request<{ ok: boolean; status: string }>(`/admin/sprite-configs/${id}/destroy`, { method: 'POST' }),

  checkSpriteStatus: (id: string) =>
    request<{ ok: boolean; status: string; spriteId?: string }>(`/admin/sprite-configs/${id}/status`, { method: 'POST' }),

  launchSpriteSession: (id: string, data?: { prompt?: string; permissionProfile?: string }) =>
    request<{ ok: boolean; sessionId: string }>(`/admin/sprite-configs/${id}/session`, {
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

  browseFiles: (appId: string, path?: string) => {
    const params = new URLSearchParams({ appId });
    if (path) params.set('path', path);
    return request<{ path: string; relativePath: string; parent: string | null; entries: { name: string; type: 'file' | 'dir'; size?: number; ext?: string }[]; isGitRepo: boolean }>(`/admin/browse-files?${params}`);
  },

  gitStatus: (appId: string) =>
    request<{ isGitRepo: boolean; branch: string | null; files: { path: string; status: string; staged: string; unstaged: string }[] }>(`/admin/git-status?appId=${encodeURIComponent(appId)}`),

  gitDiff: (appId: string, path?: string, staged?: boolean) => {
    const params = new URLSearchParams({ appId });
    if (path) params.set('path', path);
    if (staged) params.set('staged', 'true');
    return request<{ diff: string }>(`/admin/git-diff?${params}`);
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

  // Wiggum runs
  getWiggumRuns: () =>
    request<any[]>('/admin/wiggum'),

  createWiggumRun: (data: Record<string, unknown>) =>
    request<any>('/admin/wiggum', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getWiggumRun: (id: string) =>
    request<any>(`/admin/wiggum/${id}`),

  pauseWiggumRun: (id: string) =>
    request<any>(`/admin/wiggum/${id}/pause`, { method: 'POST' }),

  resumeWiggumRun: (id: string) =>
    request<any>(`/admin/wiggum/${id}/resume`, { method: 'POST' }),

  stopWiggumRun: (id: string) =>
    request<any>(`/admin/wiggum/${id}/stop`, { method: 'POST' }),

  deleteWiggumRun: (id: string) =>
    request<{ ok: boolean }>(`/admin/wiggum/${id}`, { method: 'DELETE' }),

  getWiggumRunsByParent: (sessionId: string) =>
    request<any[]>(`/admin/wiggum?parentSessionId=${encodeURIComponent(sessionId)}`),

  getWiggumPrompts: (harnessConfigId: string, promptDir?: string) => {
    const params = new URLSearchParams({ harnessConfigId });
    if (promptDir) params.set('promptDir', promptDir);
    return request<any[]>(`/admin/wiggum/prompts?${params}`);
  },

  getWiggumPromptFile: (harnessConfigId: string, filename: string) =>
    request<{ filename: string; content: string }>(`/admin/wiggum/prompt-file?harnessConfigId=${encodeURIComponent(harnessConfigId)}&filename=${encodeURIComponent(filename)}`),

  updateWiggumPromptFile: (harnessConfigId: string, filename: string, content: string, promptDir?: string) =>
    request<{ ok: boolean }>('/admin/wiggum/prompt-file', {
      method: 'PUT',
      body: JSON.stringify({ harnessConfigId, filename, content, promptDir }),
    }),

  batchCreateWiggumRuns: (data: { harnessConfigId: string; promptFiles: string[]; maxIterations?: number; deployCommand?: string; widgetSessionId?: string; screenshotDelayMs?: number; promptDir?: string }) =>
    request<any[]>('/admin/wiggum/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  batchWiggumAction: (action: 'stop' | 'pause' | 'resume', runIds: string[]) =>
    request<{ results: { id: string; ok: boolean; error?: string }[] }>('/admin/wiggum/batch-action', {
      method: 'POST',
      body: JSON.stringify({ action, runIds }),
    }),

  getWiggumLog: (harnessConfigId: string, logFile: string) =>
    request<{ logFile: string; content: string }>(`/admin/wiggum/log?harnessConfigId=${encodeURIComponent(harnessConfigId)}&logFile=${encodeURIComponent(logFile)}`),

  // FAFO Swarms
  getSwarms: (appId?: string) => {
    const params = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    return request<any[]>(`/admin/wiggum/swarms${params}`);
  },

  createSwarm: (data: Record<string, unknown>) =>
    request<any>('/admin/wiggum/swarms', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getSwarm: (id: string) =>
    request<any>(`/admin/wiggum/swarms/${id}`),

  updateSwarm: (id: string, data: Record<string, unknown>) =>
    request<any>(`/admin/wiggum/swarms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteSwarm: (id: string) =>
    request<{ ok: boolean }>(`/admin/wiggum/swarms/${id}`, { method: 'DELETE' }),

  getSwarmKnowledge: (id: string) =>
    request<{ knowledge: string }>(`/admin/wiggum/swarms/${id}/knowledge`),

  triggerNextGeneration: (id: string, data?: Record<string, unknown>) =>
    request<any>(`/admin/wiggum/swarms/${id}/next-generation`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),

  // Swarm Paths
  getSwarmPaths: (swarmId: string) =>
    request<any[]>(`/admin/wiggum/swarms/${swarmId}/paths`),

  createSwarmPath: (swarmId: string, data: Record<string, unknown>) =>
    request<any>(`/admin/wiggum/swarms/${swarmId}/paths`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateSwarmPath: (swarmId: string, pathId: string, data: Record<string, unknown>) =>
    request<any>(`/admin/wiggum/swarms/${swarmId}/paths/${pathId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteSwarmPath: (swarmId: string, pathId: string) =>
    request<{ ok: boolean }>(`/admin/wiggum/swarms/${swarmId}/paths/${pathId}`, { method: 'DELETE' }),

  // FAFO Feedback
  getSwarmFeedback: (swarmId: string, generation?: number) => {
    const params = generation != null ? `?generation=${generation}` : '';
    return request<any[]>(`/admin/wiggum/swarms/${swarmId}/feedback${params}`);
  },

  submitSwarmFeedback: (swarmId: string, data: {
    runId?: string;
    generation?: number;
    rating: number;
    annotation?: string;
    regionX?: number;
    regionY?: number;
    regionW?: number;
    regionH?: number;
    screenshotRef?: string;
  }) =>
    request<{ id: string }>(`/admin/wiggum/swarms/${swarmId}/feedback`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteSwarmFeedback: (swarmId: string, feedbackId: string) =>
    request<{ ok: boolean }>(`/admin/wiggum/swarms/${swarmId}/feedback/${feedbackId}`, { method: 'DELETE' }),

  // Auto-decomposition
  decomposeSwarm: (swarmId: string, context?: string) =>
    request<{ sessionId: string; message: string }>(`/admin/wiggum/swarms/${swarmId}/decompose`, {
      method: 'POST',
      body: JSON.stringify({ context }),
    }),

  // Worker diff
  getWorkerDiff: (swarmId: string, gen: number, pathName: string) =>
    fetch(`/api/v1/admin/wiggum/swarms/${swarmId}/gen/${gen}/path/${pathName}/diff`)
      .then(r => r.ok ? r.text() : ''),
};
