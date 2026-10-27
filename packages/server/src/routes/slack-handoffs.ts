import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAdminUser, isGlobalAdmin } from '../admin-auth.js';
import {
  claimSlackHandoffs,
  completeSlackHandoff,
  getSlackHandoff,
  requestSlackHandoff,
  slackListenerConnected,
} from '../slack-handoffs.js';

// The amirobot listener is the operator's own Slack workspace, so only the
// global (org-less) admin may send sessions there or drain the queue — an org
// user's session never lands in another tenant's Slack.
export const slackHandoffRoutes = new Hono();

const forbidden = { error: 'Continue in Slack is available to the server operator only' };

slackHandoffRoutes.post('/', async (c) => {
  const user = getAdminUser(c);
  if (!isGlobalAdmin(user)) return c.json(forbidden, 403);
  const body = await c.req.json().catch(() => ({})) as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string' || !body.sessionId) return c.json({ error: 'sessionId is required' }, 400);
  const session = db.select({ id: schema.agentSessions.id, status: schema.agentSessions.status, permissionProfile: schema.agentSessions.permissionProfile })
    .from(schema.agentSessions).where(eq(schema.agentSessions.id, body.sessionId)).get();
  if (!session || session.status === 'deleted') return c.json({ error: 'Session not found' }, 404);
  if (session.permissionProfile === 'plain') return c.json({ error: 'Plain terminals cannot be continued in Slack' }, 400);
  if (!slackListenerConnected()) {
    return c.json({ error: 'The Slack bot is not connected; start it and try again' }, 503);
  }
  return c.json(requestSlackHandoff(session.id, user.id), 202);
});

slackHandoffRoutes.post('/claim', (c) => {
  if (!isGlobalAdmin(getAdminUser(c))) return c.json(forbidden, 403);
  return c.json({ handoffs: claimSlackHandoffs() });
});

slackHandoffRoutes.post('/:id/result', async (c) => {
  if (!isGlobalAdmin(getAdminUser(c))) return c.json(forbidden, 403);
  const body = await c.req.json().catch(() => ({})) as { ok?: unknown; message?: unknown; permalink?: unknown };
  const result = completeSlackHandoff(c.req.param('id'), {
    ok: body.ok === true,
    message: typeof body.message === 'string' ? body.message : null,
    permalink: typeof body.permalink === 'string' ? body.permalink : null,
  });
  return result ? c.json(result) : c.json({ error: 'Not found' }, 404);
});

slackHandoffRoutes.get('/:id', (c) => {
  if (!isGlobalAdmin(getAdminUser(c))) return c.json(forbidden, 403);
  const h = getSlackHandoff(c.req.param('id'));
  return h ? c.json(h) : c.json({ error: 'Not found' }, 404);
});
