import { ulid } from 'ulidx';
import { broadcastAdmin } from './admin-push.js';
import {
  NOTIFICATIONS_TOPIC,
  type Notification,
  type NotificationEvent,
  type NotificationKind,
  type NotificationPayload,
  type NotificationSeverity,
} from '@propanes/shared';

/**
 * In-memory notification registry.
 *
 * Kept in memory for now — persistence can be added later if we want
 * notifications to survive restart. Capped at MAX_NOTIFICATIONS to prevent
 * unbounded growth; oldest resolved entries are evicted first.
 */

const MAX_NOTIFICATIONS = 500;
const notifications: Notification[] = [];

export interface EmitNotificationInput {
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  appId?: string | null;
  sessionId?: string | null;
  feedbackId?: string | null;
  payload?: NotificationPayload;
}

export function emitNotification(input: EmitNotificationInput): Notification {
  const n: Notification = {
    id: ulid(),
    kind: input.kind,
    severity: input.severity || 'info',
    title: input.title,
    body: input.body,
    createdAt: new Date().toISOString(),
    appId: input.appId ?? null,
    sessionId: input.sessionId ?? null,
    feedbackId: input.feedbackId ?? null,
    payload: input.payload,
  };
  notifications.unshift(n);
  evictIfNeeded();
  pushEvent({ type: 'added', notification: n });
  return n;
}

export function listNotifications(): Notification[] {
  return notifications.slice();
}

export function getNotification(id: string): Notification | undefined {
  return notifications.find((n) => n.id === id);
}

export function resolveNotification(
  id: string,
  action: 'approved' | 'rejected' | 'answered' | 'dismissed',
  response?: unknown,
): Notification | undefined {
  const n = notifications.find((x) => x.id === id);
  if (!n) return undefined;
  if (n.resolved) return n;
  n.resolved = { at: new Date().toISOString(), action, response };
  pushEvent({ type: 'updated', notification: n });
  return n;
}

export function removeNotification(id: string): boolean {
  const idx = notifications.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  notifications.splice(idx, 1);
  pushEvent({ type: 'removed', id });
  return true;
}

export function clearResolved(): number {
  const before = notifications.length;
  for (let i = notifications.length - 1; i >= 0; i--) {
    if (notifications[i].resolved) notifications.splice(i, 1);
  }
  const removed = before - notifications.length;
  if (removed > 0) {
    pushEvent({ type: 'snapshot', notifications: notifications.slice() });
  }
  return removed;
}

function pushEvent(event: NotificationEvent) {
  broadcastAdmin({ topic: NOTIFICATIONS_TOPIC, data: event });
}

function evictIfNeeded() {
  if (notifications.length <= MAX_NOTIFICATIONS) return;
  // Evict oldest resolved first
  for (let i = notifications.length - 1; i >= 0 && notifications.length > MAX_NOTIFICATIONS; i--) {
    if (notifications[i].resolved) notifications.splice(i, 1);
  }
  // If still over, drop oldest regardless
  while (notifications.length > MAX_NOTIFICATIONS) {
    notifications.pop();
  }
}
