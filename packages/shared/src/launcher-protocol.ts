import type { SequencedOutput, SequencedInput, SessionInputData } from './protocol.js';
import type { PermissionProfile } from './types.js';

// --- Harness metadata ---

export interface HarnessMetadata {
  targetAppUrl: string;
  browserMcpUrl: string;
  composeProject?: string;
  appImage?: string;
  appPort?: number;
  serverPort?: number;
}

// --- Launcher → Server messages ---

export interface LauncherRegister {
  type: 'launcher_register';
  id: string;
  name: string;
  hostname: string;
  authToken: string;
  capabilities: LauncherCapabilities;
  harness?: HarnessMetadata;
  machineId?: string;
  harnessConfigId?: string;
  version?: string;
}

export interface LauncherCapabilities {
  maxSessions: number;
  hasTmux: boolean;
  hasClaudeCli: boolean;
  hasDocker?: boolean;
}

export interface LauncherHeartbeat {
  type: 'launcher_heartbeat';
  activeSessions: string[];
  systemLoad?: number;
  timestamp: string;
}

export interface LauncherSessionStarted {
  type: 'launcher_session_started';
  sessionId: string;
  pid: number;
  tmuxSessionName?: string;
}

export interface LauncherSessionOutput {
  type: 'launcher_session_output';
  sessionId: string;
  output: SequencedOutput;
}

export interface LauncherSessionEnded {
  type: 'launcher_session_ended';
  sessionId: string;
  exitCode: number;
  status: string;
  outputLog: string;
}

export interface HarnessStatusUpdate {
  type: 'harness_status';
  harnessConfigId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  errorMessage?: string;
}

export interface ImportSessionFilesResult {
  type: 'import_session_files_result';
  sessionId: string;
  ok: boolean;
  jsonlFilesWritten: number;
  artifactFilesWritten: number;
  error?: string;
}

export interface ExportSessionFilesResult {
  type: 'export_session_files_result';
  sessionId: string;
  ok: boolean;
  jsonlFiles?: Array<{ relativePath: string; content: string }>;
  artifactFiles?: Array<{ path: string; content: string }>;
  error?: string;
}

export interface SyncCodebaseResult {
  type: 'sync_codebase_result';
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface ListTmuxSessionsResult {
  type: 'list_tmux_sessions_result';
  sessionId: string;
  sessions: Array<{ name: string; windows: number; created: string; attached: boolean }>;
}

export interface CheckClaudeAuthResult {
  type: 'check_claude_auth_result';
  sessionId: string;
  hasClaudeDir: boolean;
  hasCredentials: boolean;
  claudeVersion?: string;
  error?: string;
}

export interface CheckContainerClaudeResult {
  type: 'check_container_claude_result';
  sessionId: string;
  hasClaudeCli: boolean;
  claudeVersion?: string;
  hasCredentials: boolean;
  error?: string;
}

export interface LauncherHealthCheckResult {
  type: 'health_check_result';
  sessionId: string;
  uptime: number;
  nodeVersion: string;
  launcherVersion: string;
  platform: string;
  arch: string;
  memory: { total: number; free: number };
  activeSessions: number;
  capabilities: LauncherCapabilities;
  claudeCliVersion?: string;
  dockerVersion?: string;
  tmuxVersion?: string;
  claudeHomeExists: boolean;
}

export interface SendKeysResult {
  type: 'send_keys_result';
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface CapturePaneResult {
  type: 'capture_pane_result';
  sessionId: string;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface ExecInHarnessResult {
  type: 'exec_in_harness_result';
  sessionId: string;
  ok: boolean;
  output?: string;
  exitCode?: number;
  error?: string;
}

export type LauncherToServerMessage =
  | LauncherRegister
  | LauncherHeartbeat
  | LauncherSessionStarted
  | LauncherSessionOutput
  | LauncherSessionEnded
  | HarnessStatusUpdate
  | ImportSessionFilesResult
  | ExportSessionFilesResult
  | SyncCodebaseResult
  | SyncCodebaseToContainerResult
  | ListTmuxSessionsResult
  | CheckClaudeAuthResult
  | CheckContainerClaudeResult
  | LauncherHealthCheckResult
  | SendKeysResult
  | CapturePaneResult
  | ExecInHarnessResult;

// --- Server → Launcher messages ---

export interface LauncherRegistered {
  type: 'launcher_registered';
  ok: boolean;
  error?: string;
}

export interface LaunchSession {
  type: 'launch_session';
  sessionId: string;
  prompt: string;
  cwd: string;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  claudeSessionId?: string;
  resumeSessionId?: string;
  tmuxTarget?: string;
  cols: number;
  rows: number;
}

export interface KillSessionRequest {
  type: 'kill_session';
  sessionId: string;
}

export interface ResizeSessionRequest {
  type: 'resize_session';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface InputToSession {
  type: 'input_to_session';
  sessionId: string;
  input: SequencedInput | { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
}

export interface StartHarness {
  type: 'start_harness';
  harnessConfigId: string;
  appImage?: string;
  appPort?: number;
  appInternalPort?: number;
  serverPort?: number;
  browserMcpPort?: number;
  targetAppUrl?: string;
  composeDir?: string;
  envVars?: Record<string, string>;
  claudeHomePath?: string;
  anthropicApiKey?: string;
}

export interface StopHarness {
  type: 'stop_harness';
  harnessConfigId: string;
  composeDir?: string;
}

export interface LaunchHarnessSession {
  type: 'launch_harness_session';
  sessionId: string;
  harnessConfigId: string;
  prompt: string;
  composeDir?: string;
  serviceName?: string;
  permissionProfile: PermissionProfile;
  containerCwd?: string;
  claudeSessionId?: string;
  anthropicApiKey?: string;
  cols: number;
  rows: number;
}

export interface SyncCodebaseToContainer {
  type: 'sync_codebase_to_container';
  sessionId: string;
  harnessConfigId: string;
  branch: string;
  gitRemoteUrl: string;
  containerPath: string;
  composeDir?: string;
  serviceName?: string;
}

export interface SyncCodebaseToContainerResult {
  type: 'sync_codebase_to_container_result';
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface ImportSessionFiles {
  type: 'import_session_files';
  sessionId: string;
  claudeSessionId: string;
  projectDir: string;
  jsonlFiles: Array<{ relativePath: string; content: string }>;
  artifactFiles: Array<{ path: string; content: string }>;
}

export interface ExportSessionFiles {
  type: 'export_session_files';
  sessionId: string;
  claudeSessionId: string;
  projectDir: string;
  artifactPaths: string[];
}

export interface SyncCodebase {
  type: 'sync_codebase';
  sessionId: string;
  branch: string;
  projectDir: string;
  gitRemoteUrl: string;
}

export interface ListTmuxSessions {
  type: 'list_tmux_sessions';
  sessionId: string;
}

export interface RestartLauncher {
  type: 'restart_launcher';
}

export interface CheckClaudeAuth {
  type: 'check_claude_auth';
  sessionId: string;
  claudeHomePath?: string;
}

export interface CheckContainerClaude {
  type: 'check_container_claude';
  sessionId: string;
  harnessConfigId: string;
  composeDir?: string;
  serviceName?: string;
}

export interface LauncherHealthCheck {
  type: 'health_check';
  sessionId: string;
}

export interface SendKeys {
  type: 'send_keys';
  sessionId: string;
  targetSessionId: string;
  keys: string;
  enter?: boolean;
  tmuxTarget?: string;
}

export interface CapturePane {
  type: 'capture_pane';
  sessionId: string;
  targetSessionId: string;
  lastN?: number;
  tmuxTarget?: string;
}

export interface ExecInHarness {
  type: 'exec_in_harness';
  sessionId: string;
  harnessConfigId: string;
  command: string;
  composeDir?: string;
  serviceName?: string;
  timeout?: number;
}

export type ServerToLauncherMessage =
  | LauncherRegistered
  | LaunchSession
  | KillSessionRequest
  | ResizeSessionRequest
  | InputToSession
  | StartHarness
  | StopHarness
  | LaunchHarnessSession
  | ImportSessionFiles
  | ExportSessionFiles
  | SyncCodebase
  | SyncCodebaseToContainer
  | ListTmuxSessions
  | RestartLauncher
  | CheckClaudeAuth
  | CheckContainerClaude
  | LauncherHealthCheck
  | SendKeys
  | CapturePane
  | ExecInHarness;

// --- Combined ---

export type LauncherMessage = LauncherToServerMessage | ServerToLauncherMessage;

// --- Constants ---

export const LAUNCHER_HEARTBEAT_INTERVAL_MS = 30_000;
export const LAUNCHER_STALE_TIMEOUT_MS = 90_000;
