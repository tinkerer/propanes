export const FEEDBACK_TYPES = [
  'manual',
  'ab_test',
  'analytics',
  'error_report',
  'programmatic',
  'request',
  'fafo_worker',
] as const;

export const FEEDBACK_STATUSES = [
  'new',
  'reviewed',
  'dispatched',
  'resolved',
  'archived',
  'deleted',
] as const;

export const WIDGET_MODES = ['always', 'admin', 'hidden'] as const;

export const WIDGET_POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const;

export const COLLECTORS = [
  'console',
  'network',
  'performance',
  'environment',
] as const;

export const DEFAULT_POSITION = 'bottom-right' as const;
export const DEFAULT_MODE = 'always' as const;
export const DEFAULT_SHORTCUT = 'ctrl+shift+f';
export const DISPATCH_MODES = ['webhook', 'headless', 'interactive'] as const;
export const AGENT_RUNTIMES = ['claude', 'codex'] as const;

// Phase 5 — isolation is a property of the agent type chosen at launch.
//   'shared'       — the launcher's own agent-home (default, today's behavior).
//   'per_user_pod' — the owner's long-lived per-user pod.
//   'per_session'  — a fresh ephemeral isolate per session, torn down at end.
export const ISOLATION_MODES = ['shared', 'per_user_pod', 'per_session'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

// Permission profiles encode two orthogonal axes:
//   - I/O mode:     interactive (TTY) | headless (one-shot `-p`) | headless-stream (bidirectional JSON)
//   - Permissions:  yolo (skip) | require (ask)
// Name format: `<mode>-<perms>`. The `plain` profile is a raw shell (no agent).
export const PERMISSION_PROFILES = [
  'interactive-require',
  'interactive-yolo',
  'headless-yolo',
  'headless-stream-yolo',
  'headless-stream-require',
  'plain',
] as const;

// Stream profiles keep stdin open as long-running JSON channels — they don't
// render a TUI, so the PTY width is uncoupled from the human terminal. Wider
// cols reduce the chance that long stream-json frames get split across line
// boundaries and fail to parse downstream.
export const STREAM_PERMISSION_PROFILES: readonly string[] = [
  'headless-stream-yolo',
  'headless-stream-require',
];

export const STREAM_PROFILE_PTY_COLS = 10000;
export const DEFAULT_PTY_COLS = 120;

export function isStreamProfile(profile: string): boolean {
  return STREAM_PERMISSION_PROFILES.includes(profile);
}

export function ptyColsForProfile(profile: string): number {
  return isStreamProfile(profile) ? STREAM_PROFILE_PTY_COLS : DEFAULT_PTY_COLS;
}

export const AGENT_SESSION_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
  'idle',
] as const;

export const API_VERSION = 'v1';
