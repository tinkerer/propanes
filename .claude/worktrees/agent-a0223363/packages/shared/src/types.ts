import type {
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
  WIDGET_MODES,
  WIDGET_POSITIONS,
  COLLECTORS,
  DISPATCH_MODES,
  PERMISSION_PROFILES,
  AGENT_SESSION_STATUSES,
} from './constants.js';

export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export type WidgetMode = (typeof WIDGET_MODES)[number];
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];
export type Collector = (typeof COLLECTORS)[number];
export type DispatchMode = (typeof DISPATCH_MODES)[number];
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export interface FeedbackContext {
  consoleLogs?: ConsoleEntry[];
  networkErrors?: NetworkError[];
  performanceTiming?: PerformanceTiming;
  environment?: EnvironmentInfo;
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
  timestamp: number;
}

export interface NetworkError {
  url: string;
  method: string;
  status: number;
  statusText: string;
  timestamp: number;
}

export interface PerformanceTiming {
  loadTime?: number;
  domContentLoaded?: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
}

export interface EnvironmentInfo {
  userAgent: string;
  language: string;
  platform: string;
  screenResolution: string;
  viewport: string;
  url: string;
  referrer: string;
  timestamp: number;
}

export interface FeedbackItem {
  id: string;
  type: FeedbackType;
  status: FeedbackStatus;
  title: string;
  description: string;
  data: Record<string, unknown> | null;
  context: FeedbackContext | null;
  sourceUrl: string | null;
  userAgent: string | null;
  viewport: string | null;
  sessionId: string | null;
  userId: string | null;
  appId: string | null;
  tags: string[];
  screenshots: FeedbackScreenshot[];
  dispatchedTo: string | null;
  dispatchedAt: string | null;
  dispatchStatus: string | null;
  dispatchResponse: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackScreenshot {
  id: string;
  feedbackId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface ControlAction {
  id: string;
  label: string;
  command: string;
  icon?: string;
}

export interface RequestPanelSuggestion {
  label: string;
  prompt: string;
}

export interface RequestPanelPreference {
  id: string;
  label: string;
  promptSnippet: string;
  default?: boolean;
}

export interface RequestPanelConfig {
  suggestions: RequestPanelSuggestion[];
  preferences: RequestPanelPreference[];
  defaultAgentId?: string;
  promptPrefix?: string;
}

export interface Application {
  id: string;
  name: string;
  apiKey: string;
  projectDir: string;
  serverUrl: string | null;
  hooks: string[];
  description: string;
  controlActions: ControlAction[];
  requestPanel: RequestPanelConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEndpoint {
  id: string;
  name: string;
  url: string;
  authHeader: string | null;
  isDefault: boolean;
  appId: string | null;
  promptTemplate: string | null;
  mode: DispatchMode;
  permissionProfile: PermissionProfile;
  allowedTools: string | null;
  autoPlan: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  feedbackId: string;
  agentEndpointId: string;
  permissionProfile: PermissionProfile;
  status: AgentSessionStatus;
  pid: number | null;
  exitCode: number | null;
  outputLog: string | null;
  outputBytes: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WidgetConfig {
  endpoint: string;
  mode: WidgetMode;
  position: WidgetPosition;
  shortcut: string;
  collectors: Collector[];
  appKey?: string;
}

export interface SubmitOptions {
  type?: FeedbackType;
  title?: string;
  description?: string;
  data?: Record<string, unknown>;
  screenshot?: boolean;
  tags?: string[];
}

export interface UserIdentity {
  id: string;
  email?: string;
  name?: string;
}

export interface FeedbackListParams {
  page?: number;
  limit?: number;
  type?: FeedbackType;
  status?: FeedbackStatus;
  tag?: string;
  search?: string;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface FeedbackListResponse {
  items: FeedbackItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DispatchPayload {
  feedbackId: string;
  agentEndpointId: string;
  payload: {
    feedback: FeedbackItem;
    instructions?: string;
  };
}

export type PlanStatus = 'draft' | 'active' | 'completed';

export interface Plan {
  id: string;
  groupKey: string;
  title: string;
  body: string;
  status: PlanStatus;
  linkedFeedbackIds: string[];
  appId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClusterItem {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  createdAt: string;
}

export interface FeedbackCluster {
  groupKey: string;
  title: string;
  count: number;
  feedbackIds: string[];
  items: ClusterItem[];
  tags: string[];
  types: string[];
  statuses: string[];
  oldestAt: string;
  newestAt: string;
  plan: Plan | null;
}

export interface AggregateResponse {
  clusters: FeedbackCluster[];
  totalGroups: number;
  totalItems: number;
}

export type MachineType = 'local' | 'remote' | 'cloud';
export type MachineStatus = 'online' | 'offline';

export interface MachineCapabilities {
  maxSessions?: number;
  hasTmux?: boolean;
  hasDocker?: boolean;
  hasClaudeCli?: boolean;
}

export interface Machine {
  id: string;
  name: string;
  hostname: string | null;
  address: string | null;
  type: MachineType;
  status: MachineStatus;
  lastSeenAt: string | null;
  capabilities: MachineCapabilities | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export type HarnessConfigStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface HarnessConfig {
  id: string;
  appId: string | null;
  machineId: string | null;
  name: string;
  status: HarnessConfigStatus;
  appImage: string | null;
  appPort: number | null;
  appInternalPort: number | null;
  serverPort: number | null;
  browserMcpPort: number | null;
  targetAppUrl: string | null;
  composeDir: string | null;
  envVars: Record<string, string> | null;
  hostTerminalAccess: boolean;
  launcherId: string | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
}
