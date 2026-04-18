/**
 * Unified notification system types.
 *
 * A Notification is a server-emitted event that the admin UI renders in a
 * notification center. Some notifications are plain informational toasts;
 * others carry an interactive pane (plan-review, qna, approval) that the
 * user can act on inline.
 */

export type NotificationKind =
  | 'plain'          // informational: "Session X finished"
  | 'approval'       // user approves/rejects a proposed action
  | 'plan-review'    // user reviews a plan.md before coding starts
  | 'qna';           // user answers structured questions to configure dispatch

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface PlanReviewPayload {
  planMarkdown: string;
  /** Session that produced the plan; editing sends feedback back to that session. */
  plannerSessionId: string;
  /** Optional pre-built dispatch config to launch when the plan is approved. */
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
  /** 'choice' renders radio/select, 'boolean' renders yes/no, 'text' renders input */
  type: 'choice' | 'boolean' | 'text';
  options?: { value: string; label: string; description?: string }[];
  default?: string | boolean;
}

export interface QnaPayload {
  questions: QnaQuestion[];
  /** Context for the UI to describe what is being configured. */
  context?: string;
  /** Where the answers go — typically picked up by the server to launch a dispatch. */
  callbackUrl?: string;
}

export interface ApprovalPayload {
  /** Human-readable description of what will happen on approval. */
  description: string;
  approveLabel?: string;
  rejectLabel?: string;
  callbackUrl?: string;
}

export type NotificationPayload =
  | { kind: 'plain' }
  | { kind: 'approval'; approval: ApprovalPayload }
  | { kind: 'plan-review'; planReview: PlanReviewPayload }
  | { kind: 'qna'; qna: QnaPayload };

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  /** ISO timestamp */
  createdAt: string;
  /** Scope — admin may filter by app or session */
  appId?: string | null;
  sessionId?: string | null;
  feedbackId?: string | null;
  /** Interactive payload, varies by kind */
  payload?: NotificationPayload;
  /** Once resolved, notification shows as completed and is removable */
  resolved?: {
    at: string;
    action: 'approved' | 'rejected' | 'answered' | 'dismissed';
    response?: unknown;
  };
}

/** WS topic for notification push. */
export const NOTIFICATIONS_TOPIC = 'notifications';

/** WS event payloads for topic='notifications' */
export type NotificationEvent =
  | { type: 'snapshot'; notifications: Notification[] }
  | { type: 'added'; notification: Notification }
  | { type: 'updated'; notification: Notification }
  | { type: 'removed'; id: string };
