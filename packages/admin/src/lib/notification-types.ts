/**
 * Local mirror of the notification types in packages/shared/src/notifications.ts.
 * Admin doesn't currently take a dependency on @propanes/shared, so
 * shared types are duplicated. Keep in sync when editing either side.
 */

export type NotificationKind = 'plain' | 'approval' | 'plan-review' | 'qna' | 'voice-dispatch';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface VoiceDispatchPayload {
  pendingDispatchId: string;
  feedbackId: string;
  agentEndpointId: string;
  dispatchAt: string;
  title: string;
  description: string;
}

export interface PlanReviewPayload {
  planMarkdown: string;
  plannerSessionId: string;
  followupDispatch?: {
    agentEndpointId: string;
    feedbackId: string;
    instructions?: string;
    launcherId?: string;
    harnessConfigId?: string;
  };
}

export interface QnaQuestion {
  id: string;
  text: string;
  type: 'choice' | 'boolean' | 'text';
  options?: { value: string; label: string; description?: string }[];
  default?: string | boolean;
}

export interface QnaPayload {
  questions: QnaQuestion[];
  context?: string;
  callbackUrl?: string;
}

export interface ApprovalPayload {
  description: string;
  approveLabel?: string;
  rejectLabel?: string;
  callbackUrl?: string;
}

export type NotificationPayload =
  | { kind: 'plain' }
  | { kind: 'approval'; approval: ApprovalPayload }
  | { kind: 'plan-review'; planReview: PlanReviewPayload }
  | { kind: 'qna'; qna: QnaPayload }
  | { kind: 'voice-dispatch'; voiceDispatch: VoiceDispatchPayload };

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  createdAt: string;
  appId?: string | null;
  sessionId?: string | null;
  feedbackId?: string | null;
  payload?: NotificationPayload;
  resolved?: {
    at: string;
    action: 'approved' | 'rejected' | 'answered' | 'dismissed' | 'launched' | 'edited' | 'cancelled';
    response?: unknown;
  };
}

export type NotificationEvent =
  | { type: 'snapshot'; notifications: Notification[] }
  | { type: 'added'; notification: Notification }
  | { type: 'updated'; notification: Notification }
  | { type: 'removed'; id: string };
