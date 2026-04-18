export const FEEDBACK_TYPES = [
  'manual',
  'ab_test',
  'analytics',
  'error_report',
  'programmatic',
  'request',
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

export const PERMISSION_PROFILES = ['interactive', 'auto', 'yolo', 'plain'] as const;

export const AGENT_SESSION_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
] as const;

export const API_VERSION = 'v1';
