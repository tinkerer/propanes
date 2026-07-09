import type { Context, Next } from 'hono';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { verifyToken } from './auth.js';
import { db, schema } from './db/index.js';

export type AdminUser = {
  id: string;
  username: string;
  role: 'admin' | 'member';
  orgId: string | null;
  launcherId: string | null;
};

export async function requireAdminAuth(c: Context, next: Next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.query('token');
  const payload = token ? await verifyToken(token) : null;
  if (!payload || !payload.sub || (payload.role !== 'admin' && payload.role !== 'member')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let launcherId: string | null = null;
  if (payload.sub !== 'env-admin') {
    const user = db
      .select({
        id: schema.users.id,
        status: schema.users.status,
        launcherId: schema.users.launcherId,
        orgId: schema.users.orgId,
      })
      .from(schema.users)
      .where(eq(schema.users.id, String(payload.sub)))
      .get();
    if (!user || user.status !== 'active') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    launcherId = user.launcherId ?? null;
  }

  c.set('user', {
    id: String(payload.sub),
    username: String(payload.username || ''),
    role: payload.role,
    orgId: (payload as { orgId?: string | null }).orgId ?? null,
    launcherId,
  } satisfies AdminUser);
  await next();
}

export function getAdminUser(c: Context): AdminUser {
  return c.get('user') as AdminUser;
}

export function memberFeedbackScope(user: AdminUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  const ownerMatches = eq(schema.feedbackItems.ownerUserId, user.id);
  const orgMatches = user.orgId ? eq(schema.feedbackItems.orgId, user.orgId) : undefined;
  const legacyUnscoped = and(isNull(schema.feedbackItems.ownerUserId), isNull(schema.feedbackItems.orgId));
  return orgMatches ? or(ownerMatches, orgMatches, legacyUnscoped) : or(ownerMatches, legacyUnscoped);
}

export function memberSessionScope(user: AdminUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  const ownerMatches = eq(schema.agentSessions.ownerUserId, user.id);
  const orgMatches = user.orgId ? eq(schema.agentSessions.orgId, user.orgId) : undefined;
  const legacyUnscoped = and(isNull(schema.agentSessions.ownerUserId), isNull(schema.agentSessions.orgId));
  return orgMatches ? or(ownerMatches, orgMatches, legacyUnscoped) : or(ownerMatches, legacyUnscoped);
}

export function visibleToMember(
  row: { ownerUserId?: string | null; orgId?: string | null },
  user: AdminUser,
): boolean {
  if (user.role === 'admin') return true;
  if (!row.ownerUserId && !row.orgId) return true;
  return row.ownerUserId === user.id || (!!user.orgId && row.orgId === user.orgId);
}
