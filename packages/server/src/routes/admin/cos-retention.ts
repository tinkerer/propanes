// Channel retention sweeper. Channels with `policy.retention.archiveAfterDays`
// auto-archive open threads whose updatedAt is older than the cutoff. Runs
// every 5 minutes; never throws so a malformed policyJson can't crash the
// server. Operators flip the policy via PATCH /chief-of-staff/channels/:id
// { policy: { retention: { archiveAfterDays: 14 } } } until a settings UI lands.

import { and, eq, isNull, lt } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { policyForKind, type ChannelKind, type ChannelPolicy } from './cos-channels.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

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

export async function sweepRetentionOnce(): Promise<void> {
  const channels = await db
    .select()
    .from(schema.cosChannels)
    .where(isNull(schema.cosChannels.archivedAt));

  const now = Date.now();
  for (const ch of channels) {
    try {
      const policy = parsePolicy(ch.policyJson, ch.kind as ChannelKind);
      const days = policy.retention?.archiveAfterDays;
      if (!days || days <= 0) continue;

      const cutoff = now - days * DAY_MS;
      const stale = await db
        .select({ id: schema.cosThreads.id })
        .from(schema.cosThreads)
        .where(and(
          eq(schema.cosThreads.channelId, ch.id),
          isNull(schema.cosThreads.archivedAt),
          lt(schema.cosThreads.updatedAt, cutoff),
        ));

      if (stale.length === 0) continue;

      await db
        .update(schema.cosThreads)
        .set({ archivedAt: now })
        .where(and(
          eq(schema.cosThreads.channelId, ch.id),
          isNull(schema.cosThreads.archivedAt),
          lt(schema.cosThreads.updatedAt, cutoff),
        ));

      console.log(`[retention] archived ${stale.length} threads in #${ch.slug}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[retention] sweep failed for channel ${ch.slug}:`, msg);
    }
  }
}

export function startRetentionSweeper(): void {
  setInterval(() => {
    sweepRetentionOnce().catch((err) => {
      console.error('[retention] sweep crashed:', err);
    });
  }, SWEEP_INTERVAL_MS);
}
