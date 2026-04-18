import { Hono } from 'hono';
import {
  listNotifications,
  getNotification,
  resolveNotification,
  removeNotification,
  clearResolved,
} from '../../notifications.js';

export const notificationRoutes = new Hono();

notificationRoutes.get('/notifications', (c) => {
  return c.json({ notifications: listNotifications() });
});

notificationRoutes.post('/notifications/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as {
    action?: 'approved' | 'rejected' | 'answered' | 'dismissed';
    response?: unknown;
  };
  const action = body.action || 'dismissed';
  const n = resolveNotification(id, action, body.response);
  if (!n) return c.json({ error: 'not found' }, 404);
  return c.json({ notification: n });
});

notificationRoutes.get('/notifications/:id', (c) => {
  const n = getNotification(c.req.param('id'));
  if (!n) return c.json({ error: 'not found' }, 404);
  return c.json({ notification: n });
});

notificationRoutes.delete('/notifications/:id', (c) => {
  const ok = removeNotification(c.req.param('id'));
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

notificationRoutes.post('/notifications/clear-resolved', (c) => {
  const removed = clearResolved();
  return c.json({ removed });
});
