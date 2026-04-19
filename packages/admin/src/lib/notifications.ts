import { signal, computed } from '@preact/signals';
import { subscribeAdmin } from './admin-ws.js';
import { api } from './api.js';
import type { Notification, NotificationEvent } from './notification-types.js';
export type { Notification, NotificationEvent, NotificationKind, NotificationSeverity,
  NotificationPayload, PlanReviewPayload, QnaPayload, QnaQuestion, ApprovalPayload } from './notification-types.js';

export const notifications = signal<Notification[]>([]);
export const notificationCenterOpen = signal(false);

export const unreadNotificationCount = computed(() =>
  notifications.value.filter((n) => !n.resolved).length,
);

export function openNotificationCenter() { notificationCenterOpen.value = true; }
export function closeNotificationCenter() { notificationCenterOpen.value = false; }

let subscribed = false;
export function initNotifications() {
  if (subscribed) return;
  subscribed = true;
  subscribeAdmin('notifications', (event: NotificationEvent) => {
    if (!event) return;
    if (event.type === 'snapshot') {
      notifications.value = event.notifications;
    } else if (event.type === 'added') {
      notifications.value = [event.notification, ...notifications.value];
    } else if (event.type === 'updated') {
      notifications.value = notifications.value.map((n) =>
        n.id === event.notification.id ? event.notification : n,
      );
    } else if (event.type === 'removed') {
      notifications.value = notifications.value.filter((n) => n.id !== event.id);
    }
  });
}

export async function resolveNotification(
  id: string,
  action: 'approved' | 'rejected' | 'answered' | 'dismissed' | 'launched' | 'edited' | 'cancelled',
  response?: unknown,
) {
  try {
    const result = await api.resolveNotification(id, action, response);
    if (result?.notification) {
      notifications.value = notifications.value.map((n) =>
        n.id === id ? result.notification : n,
      );
    }
  } catch (err) {
    console.error('Failed to resolve notification:', err);
  }
}

export async function dismissNotification(id: string) {
  await resolveNotification(id, 'dismissed');
}

export async function deleteNotification(id: string) {
  try {
    await api.deleteNotification(id);
    notifications.value = notifications.value.filter((n) => n.id !== id);
  } catch (err) {
    console.error('Failed to delete notification:', err);
  }
}

export async function clearResolvedNotifications() {
  try {
    await api.clearResolvedNotifications();
    notifications.value = notifications.value.filter((n) => !n.resolved);
  } catch (err) {
    console.error('Failed to clear notifications:', err);
  }
}
