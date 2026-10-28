import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAdminUser, isGlobalAdmin, visibleToMember, type AdminUser } from '../admin-auth.js';
import {
  claimSlackHandoffs,
  completeSlackHandoff,
  getSlackHandoff,
  requestSlackHandoff,
  slackListenerConnected,
} from '../slack-handoffs.js';

// The Slack listener runs with the server operator's token, so only the global
// (org-less) admin drains the queue. Requests come from the operator (thread
// in their handoff channel) or from a user whose Slack account is linked
// (Users page → Link Slack); the bot opens theirs in a DM with them, acting as
// them. Nobody can send a session they cannot see.
export const slackHandoffRoutes = new Hono();

const forbidden = { error: 'Continue in Slack is available to the server operator only' };
const notLinked = { error: 'Link your Slack account first (ask an admin: Users page → Link Slack…)' };

function slackLinked(user: AdminUser): boolean {
  const row = db.select({ slackUserId: schema.users.slackUserId }).from(schema.users).where(eq(schema.users.id, user.id)).get();
  return !!row?.slackUserId;
}

/** The operator, or the user who asked for this handoff. */
function mayFollow(user: AdminUser, requestedBy: string): boolean {
  return isGlobalAdmin(user) || user.id === requestedBy;
}

slackHandoffRoutes.post('/', async (c) => {
  const user = getAdminUser(c);
  if (!isGlobalAdmin(user) && !slackLinked(user)) return c.json(notLinked, 403);
  const body = await c.req.json().catch(() => ({})) as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string' || !body.sessionId) return c.json({ error: 'sessionId is required' }, 400);
  const session = db.select({
    id: schema.agentSessions.id, status: schema.agentSessions.status, permissionProfile: schema.agentSessions.permissionProfile,
    ownerUserId: schema.agentSessions.ownerUserId, orgId: schema.agentSessions.orgId,
  }).from(schema.agentSessions).where(eq(schema.agentSessions.id, body.sessionId)).get();
  if (!session || session.status === 'deleted' || !visibleToMember(session, user)) return c.json({ error: 'Session not found' }, 404);
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
  const h = getSlackHandoff(c.req.param('id'));
  if (h && !mayFollow(getAdminUser(c), h.requestedBy)) return c.json(forbidden, 403);
  const body = await c.req.json().catch(() => ({})) as { ok?: unknown; message?: unknown; permalink?: unknown };
  const result = completeSlackHandoff(c.req.param('id'), {
    ok: body.ok === true,
    message: typeof body.message === 'string' ? body.message : null,
    permalink: typeof body.permalink === 'string' ? body.permalink : null,
  });
  return result ? c.json(result) : c.json({ error: 'Not found' }, 404);
});

slackHandoffRoutes.get('/:id', (c) => {
  const h = getSlackHandoff(c.req.param('id'));
  if (!h || !mayFollow(getAdminUser(c), h.requestedBy)) return c.json({ error: 'Not found' }, 404);
  return c.json(h);
});
