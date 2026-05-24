// Bridge from feedback submissions to the unified CoS thread/channel/message
// model. Every widget or admin-created feedback item also mints a CoS thread
// in a per-app `#inbox` channel so the conversation lives in the same store
// as organic CoS threads. Feedback row remains the source of truth for status,
// dispatch, and screenshot/voice metadata; the thread is the canonical
// interaction surface.
//
// Failures must NOT propagate back to the feedback insert path — the widget's
// API contract is preserved even if CoS plumbing trips. Callers wrap with try.

import { ulid } from 'ulidx';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { POLICY_PRESETS } from './routes/admin/cos-channels.js';

// Sentinel agentId on threads created from widget feedback. Distinguishes
// inbox threads from operator-driven CoS threads (which use a real agent
// persona id) so the bubble can render them differently if desired.
export const INBOX_AGENT_ID = '__inbox__';

// Sentinel agentId on threads auto-minted from agent_sessions rows that have
// no organic CoS thread. Every agent session shows up under this persona so
// the CoS pane is the single place an operator looks for any running work.
export const SESSIONS_AGENT_ID = '__sessions__';

const INBOX_SLUG = 'inbox';
const SESSIONS_SLUG = 'sessions';

// Idempotent: returns the channelId for the app's inbox channel, creating it
// on first call. Uses POLICY_PRESETS['staging-default'] (permissive — same as
// the existing default channel) but with classification = 'exploratory' so the
// UI badge doesn't claim "staging" guarantees for raw widget intake.
export async function ensureInboxChannel(appId: string): Promise<string> {
  const existing = await db
    .select({ id: schema.cosChannels.id })
    .from(schema.cosChannels)
    .where(and(eq(schema.cosChannels.appId, appId), eq(schema.cosChannels.slug, INBOX_SLUG)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const id = ulid();
  const now = Date.now();
  const policy = { ...POLICY_PRESETS['staging-default'], classification: 'exploratory' as const };
  try {
    await db.insert(schema.cosChannels).values({
      id,
      appId,
      slug: INBOX_SLUG,
      name: 'Inbox',
      description: 'Auto-routed widget feedback and other intake. Operators can move threads to other channels.',
      kind: 'exploratory',
      policyJson: JSON.stringify(policy),
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // Race with another concurrent insert (unique index on app_id + slug). Re-read.
    const refetch = await db
      .select({ id: schema.cosChannels.id })
      .from(schema.cosChannels)
      .where(and(eq(schema.cosChannels.appId, appId), eq(schema.cosChannels.slug, INBOX_SLUG)))
      .limit(1);
    if (refetch.length > 0) return refetch[0].id;
    throw new Error('inbox channel creation failed and could not be re-read');
  }
  return id;
}

// Idempotent: returns the channelId for the app's #sessions channel, creating
// it on first call. Mirrors ensureInboxChannel — sessions live in their own
// per-app channel so they don't crowd #inbox triage.
export async function ensureSessionsChannel(appId: string): Promise<string> {
  const existing = await db
    .select({ id: schema.cosChannels.id })
    .from(schema.cosChannels)
    .where(and(eq(schema.cosChannels.appId, appId), eq(schema.cosChannels.slug, SESSIONS_SLUG)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const id = ulid();
  const now = Date.now();
  const policy = { ...POLICY_PRESETS['staging-default'], classification: 'exploratory' as const };
  try {
    await db.insert(schema.cosChannels).values({
      id,
      appId,
      slug: SESSIONS_SLUG,
      name: 'Sessions',
      description: 'Every agent session in this workspace shows up here as a thread, regardless of how it was dispatched.',
      kind: 'exploratory',
      policyJson: JSON.stringify(policy),
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    const refetch = await db
      .select({ id: schema.cosChannels.id })
      .from(schema.cosChannels)
      .where(and(eq(schema.cosChannels.appId, appId), eq(schema.cosChannels.slug, SESSIONS_SLUG)))
      .limit(1);
    if (refetch.length > 0) return refetch[0].id;
    throw new Error('sessions channel creation failed and could not be re-read');
  }
  return id;
}

export interface MintFeedbackThreadOpts {
  feedbackId: string;
  appId: string;
  title: string;
  description: string;
  // Inline image attachments to surface on the seed message. Caller should
  // already have written the screenshot rows to feedback_screenshots.
  images?: { dataUrl: string; name?: string; mimeType?: string }[];
  // DOM element refs captured by the widget's element picker.
  elements?: unknown[];
}

// Returns the threadId on success, or null if the bridge failed. Always
// best-effort — never throws to the caller.
export async function mintFeedbackThread(opts: MintFeedbackThreadOpts): Promise<string | null> {
  try {
    // If a thread for this feedbackId already exists (e.g. retry after a
    // transient failure), reuse it.
    const existing = await db
      .select({ id: schema.cosThreads.id })
      .from(schema.cosThreads)
      .where(eq(schema.cosThreads.feedbackId, opts.feedbackId))
      .limit(1);
    if (existing.length > 0) return existing[0].id;

    const channelId = await ensureInboxChannel(opts.appId);
    const now = Date.now();
    const threadId = ulid();
    await db.insert(schema.cosThreads).values({
      id: threadId,
      agentId: INBOX_AGENT_ID,
      appId: opts.appId,
      channelId,
      feedbackId: opts.feedbackId,
      name: opts.title,
      // No agentSessionId — inbox threads stay passive until an operator opens
      // them. ensureAgentSessionForThread() will lazy-provision on first chat.
      createdAt: now,
      updatedAt: now,
    });

    const attachmentsJson = (opts.images && opts.images.length > 0) || (opts.elements && opts.elements.length > 0)
      ? JSON.stringify({
          images: opts.images ?? [],
          elements: opts.elements ?? [],
        })
      : null;

    await db.insert(schema.cosMessages).values({
      id: ulid(),
      threadId,
      role: 'user',
      text: opts.description || opts.title,
      toolCallsJson: null,
      attachmentsJson,
      mentionsJson: null,
      slashCommand: null,
      createdAt: now,
    });

    return threadId;
  } catch (err) {
    console.error('[cos-inbox] mintFeedbackThread failed', { feedbackId: opts.feedbackId, error: err });
    return null;
  }
}

// Backfill: mint a cos_threads row for every agent_sessions row that lacks one,
// and back-link the session. Idempotent (re-running is cheap because the orphan
// query returns empty once caught up).
//
// Channel routing: each thread lands in the matching app's #sessions channel
// (auto-created via ensureSessionsChannel) so the channel-first CoS pane can
// see it. AppId is inferred from the session's feedback link. Sessions with
// no feedback (and therefore no app) fall back to agentId=SESSIONS_AGENT_ID +
// appId=null — DB-reachable but not surfaced in any per-workspace channel
// view yet. The CoS pane's agent-history endpoint still returns them.
export async function ensureCosThreadsForOrphanSessions(): Promise<number> {
  try {
    const orphans = await db
      .select({
        id: schema.agentSessions.id,
        title: schema.agentSessions.title,
        createdAt: schema.agentSessions.createdAt,
        cwd: schema.agentSessions.cwd,
        feedbackAppId: schema.feedbackItems.appId,
      })
      .from(schema.agentSessions)
      .leftJoin(schema.feedbackItems, eq(schema.agentSessions.feedbackId, schema.feedbackItems.id))
      .where(isNull(schema.agentSessions.cosThreadId));

    if (orphans.length === 0) return 0;

    // Load all apps once so we can fall back to cwd-based app inference when
    // the session has no feedback link. Match rule: session.cwd === projectDir
    // or starts with projectDir + '/' (longest-projectDir wins, so nested
    // monorepo paths like .../packages/server resolve to the parent app).
    const apps = await db
      .select({ id: schema.applications.id, projectDir: schema.applications.projectDir })
      .from(schema.applications);
    const appsByDirDesc = apps
      .filter((a) => a.projectDir)
      .sort((a, b) => (b.projectDir!.length - a.projectDir!.length));
    const appIdFromCwd = (cwd: string | null | undefined): string | null => {
      if (!cwd) return null;
      for (const a of appsByDirDesc) {
        const dir = a.projectDir!;
        if (cwd === dir || cwd.startsWith(dir + '/')) return a.id;
      }
      return null;
    };

    // Cache per-app sessions channel id so we don't re-ensure for every row.
    const sessionsChannelByApp = new Map<string, string>();

    let minted = 0;
    for (const row of orphans) {
      const threadId = ulid();
      const createdMs = (() => {
        const ms = Date.parse(row.createdAt);
        return Number.isFinite(ms) ? ms : Date.now();
      })();
      const name = (row.title && row.title.trim()) || `Session ${row.id.slice(0, 8)}`;
      const appId = row.feedbackAppId || appIdFromCwd(row.cwd) || null;

      let channelId: string | null = null;
      if (appId) {
        if (!sessionsChannelByApp.has(appId)) {
          try {
            sessionsChannelByApp.set(appId, await ensureSessionsChannel(appId));
          } catch (err) {
            console.error('[cos-inbox] ensureSessionsChannel failed', { appId, error: err });
            sessionsChannelByApp.set(appId, '');
          }
        }
        channelId = sessionsChannelByApp.get(appId) || null;
      }

      try {
        await db.insert(schema.cosThreads).values({
          id: threadId,
          agentId: SESSIONS_AGENT_ID,
          appId,
          channelId,
          feedbackId: null,
          agentSessionId: row.id,
          name,
          createdAt: createdMs,
          updatedAt: createdMs,
        });
        await db
          .update(schema.agentSessions)
          .set({ cosThreadId: threadId })
          .where(eq(schema.agentSessions.id, row.id));
        minted++;
      } catch (err) {
        console.error('[cos-inbox] ensureCosThreadsForOrphanSessions: per-row failed', { sessionId: row.id, error: err });
      }
    }
    return minted;
  } catch (err) {
    console.error('[cos-inbox] ensureCosThreadsForOrphanSessions failed', err);
    return 0;
  }
}
