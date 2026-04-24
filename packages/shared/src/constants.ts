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

export const AGENT_SESSION_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
  'idle',
] as const;

export const API_VERSION = 'v1';
