// Channel routes: workspace-scoped buckets of CoS threads with a
// `policyJson` blob that gates dispatch (allowed permission profiles, agent
// allowlist, approval requirement, classification badge). Pairs with the
// auto-organize endpoint (cos-channel-organize.ts) which proposes channel
// structure from existing thread content.

import { Hono } from 'hono';
import { eq, and, asc, desc, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';
import { PERMISSION_PROFILES } from '@propanes/shared';

export type ChannelKind = 'prod' | 'staging' | 'exploratory';

export type ChannelPolicy = {
  classification: ChannelKind;
  allowedProfiles: string[];
  allowedAgentIds: string[] | null;
  requireApproval: boolean;
  pathGuards: string[];
  powwow: { enabled: boolean; providers: ('claude' | 'codex' | 'gemini')[] };
  retention?: { archiveAfterDays?: number };
};

export const POLICY_PRESETS: Record<string, ChannelPolicy> = {
  'prod-careful': {
    classification: 'prod',
    allowedProfiles: ['interactive-require', 'headless-stream-require'],
    allowedAgentIds: null,
    requireApproval: true,
    pathGuards: ['packages/*/dist/**', '*.db', 'docker-compose*.yml', '.env*'],
    powwow: { enabled: false, providers: [] },
  },
  'staging-default': {
    classification: 'staging',
    allowedProfiles: PERMISSION_PROFILES.filter((p) => p !== 'plain'),
    allowedAgentIds: null,
    requireApproval: false,
    pathGuards: [],
    powwow: { enabled: false, providers: [] },
  },
  'fafo-powwow': {
    classification: 'exploratory',
    allowedProfiles: ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo'],
    allowedAgentIds: null,
    requireApproval: false,
    pathGuards: [],
    powwow: { enabled: true, providers: ['claude', 'codex'] },
  },
};

export function policyForKind(kind: ChannelKind): ChannelPolicy {
  if (kind === 'prod') return POLICY_PRESETS['prod-careful'];
  if (kind === 'exploratory') return POLICY_PRESETS['fafo-powwow'];
  return POLICY_PRESETS['staging-default'];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'channel';
}

export async function uniqueSlug(appId: string, base: string): Promise<string> {
  const slug = slugify(base);
  const existing = await db
    .select({ slug: schema.cosChannels.slug })
    .from(schema.cosChannels)
    .where(eq(schema.cosChannels.appId, appId));
  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 999; i++) {
    const candidate = `${slug}-${i}`.slice(0, 36);
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

function parsePolicy(raw: string | null | undefined, kind: ChannelKind): ChannelPolicy {
  if (!raw) return policyForKind(kind);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.allowedProfiles)) {
      return parsed as ChannelPolicy;
    }
  } catch { /* fall through */ }
  return policyForKind(kind);
}

function serializeChannel(row: typeof schema.cosChannels.$inferSelect) {
  return {
    id: row.id,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind as ChannelKind,
    policy: parsePolicy(row.policyJson, row.kind as ChannelKind),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Resolve channel by id OR (appId, slug). Slug lookups are convenient for the
// UI which uses slugs in URLs.
async function resolveChannel(idOrSlug: string, appId?: string) {
  let row = await db
    .select()
    .from(schema.cosChannels)
    .where(eq(schema.cosChannels.id, idOrSlug))
    .limit(1)
    .then((r) => r[0]);
  if (!row && appId) {
    row = await db
      .select()
      .from(schema.cosChannels)
      .where(and(eq(schema.cosChannels.appId, appId), eq(schema.cosChannels.slug, idOrSlug)))
      .limit(1)
      .then((r) => r[0]);
  }
  return row;
}

export const cosChannelRoutes = new Hono();

// GET /chief-of-staff/channels?appId=...&includeArchived=1
// Returns all channels in a workspace plus a `unsorted` count of threads with
// channelId=null so the UI can render the "Unsorted" virtual section.
cosChannelRoutes.get('/chief-of-staff/channels', async (c) => {
  const appId = c.req.query('appId');
  if (!appId) return c.json({ error: 'appId is required' }, 400);
  const includeArchived = c.req.query('includeArchived') === '1';

  const rows = await db
    .select()
    .from(schema.cosChannels)
    .where(
      includeArchived
        ? eq(schema.cosChannels.appId, appId)
        : and(eq(schema.cosChannels.appId, appId), isNull(schema.cosChannels.archivedAt)),
    )
    .orderBy(asc(schema.cosChannels.kind), asc(schema.cosChannels.slug));

  const channels = rows.map(serializeChannel);

  // Per-channel thread counts (open + total).
  const counts = await db
    .select({
      channelId: schema.cosThreads.channelId,
      total: sql<number>`COUNT(*)`,
      open: sql<number>`SUM(CASE WHEN ${schema.cosThreads.archivedAt} IS NULL AND ${schema.cosThreads.resolvedAt} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(schema.cosThreads)
    .where(eq(schema.cosThreads.appId, appId))
    .groupBy(schema.cosThreads.channelId);

  const countByChannel = new Map<string | null, { total: number; open: number }>();
  for (const c of counts) countByChannel.set(c.channelId, { total: c.total, open: c.open });

  const channelsWithCounts = channels.map((ch) => {
    const c = countByChannel.get(ch.id) ?? { total: 0, open: 0 };
    return { ...ch, threadCount: c.total, openCount: c.open };
  });

  const unsorted = countByChannel.get(null) ?? { total: 0, open: 0 };

  return c.json({
    channels: channelsWithCounts,
    unsorted: { threadCount: unsorted.total, openCount: unsorted.open },
  });
});

// POST /chief-of-staff/channels  body: { appId, name, slug?, description?, kind?, policy? }
cosChannelRoutes.post('/chief-of-staff/channels', async (c) => {
  let body: {
    appId?: string;
    name?: string;
    slug?: string;
    description?: string;
    kind?: ChannelKind;
    policy?: Partial<ChannelPolicy>;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const appId = (body.appId || '').trim();
  const name = (body.name || '').trim();
  if (!appId || !name) return c.json({ error: 'appId and name are required' }, 400);

  const kind: ChannelKind = body.kind || 'staging';
  const slug = await uniqueSlug(appId, body.slug || name);
  const basePolicy = policyForKind(kind);
  const policy: ChannelPolicy = body.policy
    ? { ...basePolicy, ...body.policy, classification: kind }
    : basePolicy;

  const now = Date.now();
  const id = ulid();
  await db.insert(schema.cosChannels).values({
    id,
    appId,
    slug,
    name,
    description: body.description || '',
    kind,
    policyJson: JSON.stringify(policy),
    createdAt: now,
    updatedAt: now,
  });

  const row = await db.select().from(schema.cosChannels).where(eq(schema.cosChannels.id, id)).limit(1);
  return c.json(serializeChannel(row[0]));
});

cosChannelRoutes.patch('/chief-of-staff/channels/:id', async (c) => {
  const id = c.req.param('id');
  let body: {
    name?: string;
    description?: string;
    kind?: ChannelKind;
    policy?: Partial<ChannelPolicy>;
    slug?: string;
    archived?: boolean;
  };
  try { body = await c.req.json(); } catch { body = {}; }

  const existing = await db
    .select().from(schema.cosChannels).where(eq(schema.cosChannels.id, id)).limit(1)
    .then((r) => r[0]);
  if (!existing) return c.json({ error: 'channel not found' }, 404);

  const updates: Partial<typeof schema.cosChannels.$inferInsert> = { updatedAt: Date.now() };
  if (typeof body.name === 'string') updates.name = body.name.trim();
  if (typeof body.description === 'string') updates.description = body.description;
  if (body.slug && body.slug !== existing.slug) {
    updates.slug = await uniqueSlug(existing.appId, body.slug);
  }
  if (body.kind) {
    updates.kind = body.kind;
    // If the operator switches kind without supplying a policy, swap to the
    // preset for that kind. If they pass `policy`, that wins.
    if (!body.policy) {
      updates.policyJson = JSON.stringify(policyForKind(body.kind));
    }
  }
  if (body.policy) {
    const currentKind = (body.kind || existing.kind) as ChannelKind;
    const merged: ChannelPolicy = {
      ...parsePolicy(existing.policyJson, currentKind),
      ...body.policy,
      classification: currentKind,
    };
    updates.policyJson = JSON.stringify(merged);
  }
  if ('archived' in body) {
    updates.archivedAt = body.archived === false ? null : Date.now();
  }

  await db.update(schema.cosChannels).set(updates).where(eq(schema.cosChannels.id, id));
  const row = await db
    .select().from(schema.cosChannels).where(eq(schema.cosChannels.id, id)).limit(1);
  return c.json(serializeChannel(row[0]));
});

// DELETE: cascades members and sets threads.channelId=null (FK ON DELETE SET NULL).
cosChannelRoutes.delete('/chief-of-staff/channels/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(schema.cosChannels).where(eq(schema.cosChannels.id, id));
  return c.json({ ok: true });
});

// Move a thread into a channel (or into "unsorted" if channelId omitted).
// POST /chief-of-staff/channels/:channelId/threads  body: { threadId }
// channelId may be the literal string "_unsorted" to clear the binding.
cosChannelRoutes.post('/chief-of-staff/channels/:channelId/threads', async (c) => {
  const channelId = c.req.param('channelId');
  let body: { threadId?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const threadId = (body.threadId || '').trim();
  if (!threadId) return c.json({ error: 'threadId is required' }, 400);

  const targetChannelId = channelId === '_unsorted' ? null : channelId;
  if (targetChannelId) {
    const exists = await db
      .select({ id: schema.cosChannels.id })
      .from(schema.cosChannels)
      .where(eq(schema.cosChannels.id, targetChannelId))
      .limit(1);
    if (exists.length === 0) return c.json({ error: 'channel not found' }, 404);
  }

  await db
    .update(schema.cosThreads)
    .set({ channelId: targetChannelId, updatedAt: Date.now() })
    .where(eq(schema.cosThreads.id, threadId));

  return c.json({ ok: true, threadId, channelId: targetChannelId });
});

// Member management. For users we use email-as-refId; for agents we use the
// agent_endpoints.id. The UI distinguishes via `kind`.
cosChannelRoutes.get('/chief-of-staff/channels/:id/members', async (c) => {
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(schema.cosChannelMembers)
    .where(eq(schema.cosChannelMembers.channelId, id))
    .orderBy(asc(schema.cosChannelMembers.kind), asc(schema.cosChannelMembers.refId));
  return c.json({ members: rows });
});

cosChannelRoutes.post('/chief-of-staff/channels/:id/members', async (c) => {
  const channelId = c.req.param('id');
  let body: { kind?: 'user' | 'agent'; refId?: string; role?: 'owner' | 'member' };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const kind = body.kind;
  const refId = (body.refId || '').trim();
  if ((kind !== 'user' && kind !== 'agent') || !refId) {
    return c.json({ error: 'kind ("user"|"agent") and refId are required' }, 400);
  }
  const role = body.role === 'owner' ? 'owner' : 'member';
  const id = ulid();
  try {
    await db.insert(schema.cosChannelMembers).values({
      id, channelId, kind, refId, role, joinedAt: Date.now(),
    });
  } catch (e: unknown) {
    // Unique constraint — return existing
    const existing = await db
      .select().from(schema.cosChannelMembers)
      .where(and(
        eq(schema.cosChannelMembers.channelId, channelId),
        eq(schema.cosChannelMembers.kind, kind),
        eq(schema.cosChannelMembers.refId, refId),
      ))
      .limit(1);
    if (existing.length > 0) return c.json(existing[0]);
    throw e;
  }
  const row = await db
    .select().from(schema.cosChannelMembers)
    .where(eq(schema.cosChannelMembers.id, id))
    .limit(1);
  return c.json(row[0]);
});

cosChannelRoutes.delete('/chief-of-staff/channels/:id/members/:memberId', async (c) => {
  const memberId = c.req.param('memberId');
  await db.delete(schema.cosChannelMembers).where(eq(schema.cosChannelMembers.id, memberId));
  return c.json({ ok: true });
});

// Resolve route used by the URL parser: GET /chief-of-staff/channels/by-slug/:appId/:slug
cosChannelRoutes.get('/chief-of-staff/channels/by-slug/:appId/:slug', async (c) => {
  const appId = c.req.param('appId');
  const slug = c.req.param('slug');
  const row = await resolveChannel(slug, appId);
  if (!row) return c.json({ error: 'channel not found' }, 404);
  return c.json(serializeChannel(row));
});

// Policy enforcement helper. Used by the dispatch route to gate spawns by
// channel rules. Returns either { allowed: true } or { allowed: false, reason }.
export async function checkDispatchPolicy(args: {
  channelId: string | null | undefined;
  permissionProfile: string;
  agentEndpointId?: string | null;
}): Promise<{ allowed: true } | { allowed: false; reason: string; requiresApproval?: boolean; policy?: ChannelPolicy }> {
  if (!args.channelId) return { allowed: true };
  const row = await db
    .select().from(schema.cosChannels).where(eq(schema.cosChannels.id, args.channelId)).limit(1)
    .then((r) => r[0]);
  if (!row) return { allowed: true };
  const policy = parsePolicy(row.policyJson, row.kind as ChannelKind);
  if (policy.allowedProfiles.length > 0 && !policy.allowedProfiles.includes(args.permissionProfile)) {
    return {
      allowed: false,
      reason: `channel #${row.slug} (${row.kind}) does not allow profile "${args.permissionProfile}"; allowed: ${policy.allowedProfiles.join(', ')}`,
      policy,
    };
  }
  if (policy.allowedAgentIds && args.agentEndpointId && !policy.allowedAgentIds.includes(args.agentEndpointId)) {
    return {
      allowed: false,
      reason: `channel #${row.slug} restricts agents to ${policy.allowedAgentIds.join(', ')}`,
      policy,
    };
  }
  if (policy.requireApproval) {
    return {
      allowed: false,
      reason: `channel #${row.slug} requires approval before dispatch`,
      requiresApproval: true,
      policy,
    };
  }
  return { allowed: true };
}
