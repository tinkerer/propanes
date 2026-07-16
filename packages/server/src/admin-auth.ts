import type { Context, Next } from 'hono';
import type { JWTPayload } from 'jose';
import { eq, or, type SQL } from 'drizzle-orm';
import { verifyToken } from './auth.js';
import { db, schema } from './db/index.js';

export type AdminUser = {
  id: string;
  username: string;
  role: 'admin' | 'member';
  orgId: string | null;
  launcherId: string | null;
};

// Resolve a verified JWT payload to an AdminUser, enforcing the same rules as
// requireAdminAuth (role must be admin|member; DB users must exist and be
// active). Returns null when the payload doesn't map to a usable account.
// Shared by the HTTP middleware and the WebSocket handshakes so members are
// accepted (and scoped) everywhere instead of being bounced with a 401/4003.
export function resolveAdminUser(payload: JWTPayload | null): AdminUser | null {
  if (!payload || !payload.sub || (payload.role !== 'admin' && payload.role !== 'member')) {
    return null;
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
      return null;
    }
    launcherId = user.launcherId ?? null;
  }

  return {
    id: String(payload.sub),
    username: String(payload.username || ''),
    role: payload.role,
    orgId: (payload as { orgId?: string | null }).orgId ?? null,
    launcherId,
  };
}

export async function requireAdminAuth(c: Context, next: Next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.query('token');
  const payload = token ? await verifyToken(token) : null;
  const user = resolveAdminUser(payload);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('user', user satisfies AdminUser);
  await next();
}

export function getAdminUser(c: Context): AdminUser {
  return c.get('user') as AdminUser;
}

// The unscoped "see everything" view belongs ONLY to org-less admins (the
// env-admin operator account). An admin who belongs to an org is that org's
// administrator, not a platform operator: their data plane (apps, feedback,
// sessions, push topics) is scoped to their org exactly like a member's, so
// two orgs on one server are completely separate environments. Role still
// gates the ops surfaces (user management, launchers, machines).
export function isGlobalAdmin(user: AdminUser): boolean {
  return user.role === 'admin' && !user.orgId;
}

// Users see ONLY their own workspace: rows they own or rows in their org.
// There is deliberately NO "legacy unscoped (owner+org both null) is visible to
// everyone" clause — that was a shared backdoor that leaked one operator's data
// to every member. Unowned/legacy rows stay visible to global admins (whose
// scope is undefined = no filter) but never to org-scoped users.
export function memberFeedbackScope(user: AdminUser): SQL | undefined {
  if (isGlobalAdmin(user)) return undefined;
  const ownerMatches = eq(schema.feedbackItems.ownerUserId, user.id);
  const orgMatches = user.orgId ? eq(schema.feedbackItems.orgId, user.orgId) : undefined;
  return orgMatches ? or(ownerMatches, orgMatches) : ownerMatches;
}

export function memberSessionScope(user: AdminUser): SQL | undefined {
  if (isGlobalAdmin(user)) return undefined;
  const ownerMatches = eq(schema.agentSessions.ownerUserId, user.id);
  const orgMatches = user.orgId ? eq(schema.agentSessions.orgId, user.orgId) : undefined;
  return orgMatches ? or(ownerMatches, orgMatches) : ownerMatches;
}

// Workspace (application) scope — same rule as feedback/sessions.
export function memberAppScope(user: AdminUser): SQL | undefined {
  if (isGlobalAdmin(user)) return undefined;
  const ownerMatches = eq(schema.applications.ownerUserId, user.id);
  const orgMatches = user.orgId ? eq(schema.applications.orgId, user.orgId) : undefined;
  return orgMatches ? or(ownerMatches, orgMatches) : ownerMatches;
}

export function visibleToMember(
  row: { ownerUserId?: string | null; orgId?: string | null },
  user: AdminUser,
): boolean {
  if (isGlobalAdmin(user)) return true;
  return row.ownerUserId === user.id || (!!user.orgId && row.orgId === user.orgId);
}
