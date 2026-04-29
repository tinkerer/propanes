// Approval queue routes. Channels with `policy.requireApproval` divert
// dispatch into pending rows here instead of spawning agents directly. The
// admin UI Approvals page lists them and lets an operator approve (replays
// the saved payload through dispatchFeedbackToAgent) or deny.

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { dispatchFeedbackToAgent } from '../../dispatch.js';
import type { PermissionProfile } from '@propanes/shared';

export const cosApprovalRoutes = new Hono();

type ApprovalRow = typeof schema.cosDispatchApprovals.$inferSelect;

function serializeApproval(row: ApprovalRow, channel?: { slug: string; name: string; appId: string; kind: string } | null) {
  return {
    id: row.id,
    channelId: row.channelId,
    channelSlug: channel?.slug || null,
    channelName: channel?.name || null,
    channelKind: channel?.kind || null,
    appId: channel?.appId || null,
    feedbackId: row.feedbackId,
    agentEndpointId: row.agentEndpointId,
    instructions: row.instructions,
    permissionProfile: row.permissionProfile,
    requestedBy: row.requestedBy,
    status: row.status as 'pending' | 'approved' | 'denied' | 'expired',
    denyReason: row.denyReason,
    dispatchedSessionId: row.dispatchedSessionId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
  };
}

// GET /chief-of-staff/approvals?appId&status
cosApprovalRoutes.get('/chief-of-staff/approvals', async (c) => {
  const appId = c.req.query('appId');
  const status = c.req.query('status') || 'pending';

  // Join through channels so we can scope to a workspace and surface slug/name.
  const rows = await db
    .select({
      approval: schema.cosDispatchApprovals,
      channel: schema.cosChannels,
    })
    .from(schema.cosDispatchApprovals)
    .innerJoin(schema.cosChannels, eq(schema.cosDispatchApprovals.channelId, schema.cosChannels.id))
    .where(
      appId
        ? (status === 'all'
            ? eq(schema.cosChannels.appId, appId)
            : and(eq(schema.cosChannels.appId, appId), eq(schema.cosDispatchApprovals.status, status)))
        : (status === 'all' ? undefined : eq(schema.cosDispatchApprovals.status, status)),
    )
    .orderBy(desc(schema.cosDispatchApprovals.createdAt))
    .limit(200);

  const approvals = rows.map((r) => serializeApproval(r.approval, {
    slug: r.channel.slug,
    name: r.channel.name,
    appId: r.channel.appId,
    kind: r.channel.kind,
  }));

  return c.json({ approvals });
});

// POST /chief-of-staff/approvals/:id/approve
cosApprovalRoutes.post('/chief-of-staff/approvals/:id/approve', async (c) => {
  const id = c.req.param('id');
  const row = await db
    .select().from(schema.cosDispatchApprovals)
    .where(eq(schema.cosDispatchApprovals.id, id)).limit(1)
    .then((r) => r[0]);
  if (!row) return c.json({ error: 'approval not found' }, 404);
  if (row.status !== 'pending') {
    return c.json({ error: `approval already ${row.status}` }, 409);
  }

  // Flip to approved up-front so a slow dispatch doesn't allow double-approval.
  const now = Date.now();
  await db.update(schema.cosDispatchApprovals)
    .set({ status: 'approved', resolvedAt: now })
    .where(eq(schema.cosDispatchApprovals.id, id));

  try {
    const result = await dispatchFeedbackToAgent({
      feedbackId: row.feedbackId,
      agentEndpointId: row.agentEndpointId,
      instructions: row.instructions || undefined,
      permissionProfile: (row.permissionProfile || undefined) as PermissionProfile | undefined,
    });
    if (result.sessionId) {
      await db.update(schema.cosDispatchApprovals)
        .set({ dispatchedSessionId: result.sessionId })
        .where(eq(schema.cosDispatchApprovals.id, id));
    }
    return c.json({ ok: true, approvalId: id, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Roll back so the operator can retry; otherwise the approval is stuck
    // in `approved` with no session to show for it.
    await db.update(schema.cosDispatchApprovals)
      .set({ status: 'pending', resolvedAt: null })
      .where(eq(schema.cosDispatchApprovals.id, id));
    return c.json({ ok: false, error: msg }, 500);
  }
});

// POST /chief-of-staff/approvals/:id/deny  body: { reason? }
cosApprovalRoutes.post('/chief-of-staff/approvals/:id/deny', async (c) => {
  const id = c.req.param('id');
  let body: { reason?: string } = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const row = await db
    .select().from(schema.cosDispatchApprovals)
    .where(eq(schema.cosDispatchApprovals.id, id)).limit(1)
    .then((r) => r[0]);
  if (!row) return c.json({ error: 'approval not found' }, 404);
  if (row.status !== 'pending') {
    return c.json({ error: `approval already ${row.status}` }, 409);
  }

  await db.update(schema.cosDispatchApprovals)
    .set({
      status: 'denied',
      resolvedAt: Date.now(),
      denyReason: body.reason ? body.reason.slice(0, 1000) : null,
    })
    .where(eq(schema.cosDispatchApprovals.id, id));

  return c.json({ ok: true, approvalId: id });
});
