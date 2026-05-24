// Auto-organize: ask Claude to bucket existing CoS threads into channels.
//
// Flow:
//   1. POST /chief-of-staff/channels/auto-organize { appId } → loads thread
//      summaries, calls `claude -p` with a structured prompt, stores the
//      result as a `cos_channel_org_proposals` row in `pending` state.
//   2. Operator reviews via GET /chief-of-staff/org-proposals/:id and either
//      applies (creates channels, binds threads) or rejects.
//
// Synchronous: the LLM call blocks the request for ~10–60s. Acceptable for
// an explicitly operator-triggered admin action.

import { Hono } from 'hono';
import { eq, and, desc, asc } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';
import {
  uniqueSlug,
  policyForKind,
  type ChannelKind,
} from './cos-channels.js';
import { dispatchAgentSession } from '../../dispatch.js';
import type { PermissionProfile } from '@propanes/shared';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const ORGANIZER_MODEL = process.env.COS_ORGANIZER_MODEL || 'claude-sonnet-4-6';

type ProposedChannel = {
  slug: string;
  name: string;
  description: string;
  kind: ChannelKind;
  threadIds: string[];
};

type ProposalShape = {
  channels: ProposedChannel[];
  reasoning?: string;
};

function runClaude(prompt: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--model', ORGANIZER_MODEL, '--output-format', 'json'],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      },
    );
    // Close stdin so claude doesn't wait 3s for input.
    child.stdin?.end();
  });
}

function extractJson(raw: string): unknown {
  try {
    const wrapper = JSON.parse(raw);
    if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
      const inner = (wrapper as { result: string }).result;
      try { return JSON.parse(inner); } catch { /* fall through */ }
      const fenced = inner.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) return JSON.parse(fenced[1].trim());
      const braceMatch = inner.match(/\{[\s\S]*\}/);
      if (braceMatch) return JSON.parse(braceMatch[0]);
    }
  } catch { /* fall through */ }
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);
  throw new Error('Could not parse JSON from organizer output');
}

async function loadThreadSummaries(appId: string) {
  const threads = await db
    .select({
      id: schema.cosThreads.id,
      name: schema.cosThreads.name,
      agentId: schema.cosThreads.agentId,
      channelId: schema.cosThreads.channelId,
      createdAt: schema.cosThreads.createdAt,
    })
    .from(schema.cosThreads)
    .where(eq(schema.cosThreads.appId, appId))
    .orderBy(desc(schema.cosThreads.updatedAt));

  if (threads.length === 0) return [];

  const summaries: Array<{
    id: string;
    name: string;
    agentId: string;
    firstUserText: string;
    msgCount: number;
    createdAt: number;
  }> = [];

  for (const t of threads) {
    const firstUser = await db
      .select({ text: schema.cosMessages.text })
      .from(schema.cosMessages)
      .where(and(eq(schema.cosMessages.threadId, t.id), eq(schema.cosMessages.role, 'user')))
      .orderBy(asc(schema.cosMessages.createdAt))
      .limit(1);

    const total = await db
      .select({ id: schema.cosMessages.id })
      .from(schema.cosMessages)
      .where(eq(schema.cosMessages.threadId, t.id));

    const text = firstUser[0]?.text || '';
    summaries.push({
      id: t.id,
      name: t.name,
      agentId: t.agentId,
      firstUserText: text.length > 400 ? text.slice(0, 400) + '…' : text,
      msgCount: total.length,
      createdAt: t.createdAt,
    });
  }
  return summaries;
}

function buildPrompt(appName: string, threadCount: number, summaries: ReturnType<typeof loadThreadSummaries> extends Promise<infer R> ? R : never): string {
  const threadsBlock = summaries.map((s, i) =>
    `[${i + 1}] id=${s.id} agent=${s.agentId} msgs=${s.msgCount}\n  name: ${s.name}\n  first: ${s.firstUserText.replace(/\s+/g, ' ').slice(0, 360)}`
  ).join('\n\n');

  return `You are organizing operator/agent chat threads in the "${appName}" workspace into Slack-style channels.

There are ${threadCount} threads. Group them into 3–10 channels by topic, scope, or operational mode. Channels should feel like a small team's Slack: a few topical buckets that make navigation easier, not one bucket per thread.

For each channel:
- slug: short, lowercase, hyphenated, ≤24 chars (e.g. "mobile-ui", "deploy-ops", "agent-fafo")
- name: human-friendly title (e.g. "Mobile UI", "Deploy Ops")
- description: one short sentence
- kind: classification — one of:
    "prod"       → strict, production/deploy/data-handling work (gates dispatch behind approval, restricts to careful permission profiles)
    "staging"    → default for normal product work
    "exploratory"→ "fafo" multi-provider yolo pow-wow channels for experiments
- threadIds: array of thread ids that belong here

Hints:
- Use "prod" only if the threads are clearly about production deploys, customer data, secrets, releases, or migrations
- Use "exploratory" for fafo/yolo/pow-wow/experiment/swarm threads
- Otherwise default to "staging"
- Every thread must appear in exactly one channel
- Prefer fewer channels (~5) over many

Threads:
${threadsBlock}

Return ONLY this JSON shape (no markdown, no commentary):
{
  "channels": [
    {"slug": "...", "name": "...", "description": "...", "kind": "prod|staging|exploratory", "threadIds": ["...", "..."]}
  ],
  "reasoning": "one short paragraph on the grouping logic"
}`;
}

function validateProposal(raw: unknown, knownThreadIds: Set<string>): { ok: true; proposal: ProposalShape } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'proposal not an object' };
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.channels)) return { ok: false, error: 'proposal.channels missing or not an array' };
  const channels: ProposedChannel[] = [];
  const seenThreads = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const ch of obj.channels) {
    if (!ch || typeof ch !== 'object') return { ok: false, error: 'channel entry is not an object' };
    const c = ch as Record<string, unknown>;
    const slug = typeof c.slug === 'string' ? c.slug.toLowerCase() : '';
    const name = typeof c.name === 'string' ? c.name : '';
    const description = typeof c.description === 'string' ? c.description : '';
    const kind = (c.kind === 'prod' || c.kind === 'exploratory' || c.kind === 'staging')
      ? c.kind
      : 'staging';
    const threadIds = Array.isArray(c.threadIds)
      ? c.threadIds.filter((t): t is string => typeof t === 'string')
      : [];
    if (!slug || !name) return { ok: false, error: `channel missing slug/name: ${JSON.stringify(c)}` };
    if (seenSlugs.has(slug)) return { ok: false, error: `duplicate slug: ${slug}` };
    seenSlugs.add(slug);
    for (const t of threadIds) {
      if (!knownThreadIds.has(t)) {
        // Skip unknown ids — treat as hallucinations rather than fail outright.
        continue;
      }
      if (seenThreads.has(t)) return { ok: false, error: `thread ${t} appears in multiple channels` };
      seenThreads.add(t);
    }
    channels.push({
      slug,
      name,
      description,
      kind,
      threadIds: threadIds.filter((t) => knownThreadIds.has(t)),
    });
  }
  // Threads the model omitted: assign them to a "general" channel as a
  // fallback so applying the proposal always lands every thread somewhere.
  const missing = [...knownThreadIds].filter((t) => !seenThreads.has(t));
  if (missing.length > 0) {
    let general = channels.find((c) => c.slug === 'general');
    if (!general) {
      general = { slug: 'general', name: 'General', description: 'Catch-all for unsorted threads.', kind: 'staging', threadIds: [] };
      channels.push(general);
    }
    for (const t of missing) general.threadIds.push(t);
  }
  return {
    ok: true,
    proposal: {
      channels,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    },
  };
}

export const cosChannelOrganizeRoutes = new Hono();

// POST /chief-of-staff/channels/auto-organize  body: { appId, dryRun?: bool }
// Synchronous LLM call. Returns the stored proposal row (status=pending).
cosChannelOrganizeRoutes.post('/chief-of-staff/channels/auto-organize', async (c) => {
  let body: { appId?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const appId = (body.appId || '').trim();
  if (!appId) return c.json({ error: 'appId is required' }, 400);

  const app = await db
    .select({ id: schema.applications.id, name: schema.applications.name })
    .from(schema.applications)
    .where(eq(schema.applications.id, appId))
    .limit(1)
    .then((r) => r[0]);
  if (!app) return c.json({ error: 'app not found' }, 404);

  const summaries = await loadThreadSummaries(appId);
  if (summaries.length === 0) {
    return c.json({ error: 'no threads to organize' }, 400);
  }

  const knownThreadIds = new Set(summaries.map((s) => s.id));
  const prompt = buildPrompt(app.name, summaries.length, summaries);

  let raw: string;
  try {
    raw = await runClaude(prompt);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `claude call failed: ${msg}` }, 502);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `failed to parse organizer output: ${msg}`, raw: raw.slice(0, 1000) }, 502);
  }

  const validation = validateProposal(parsed, knownThreadIds);
  if (!validation.ok) {
    return c.json({ error: `invalid proposal: ${validation.error}`, raw: parsed }, 502);
  }

  const id = ulid();
  const now = Date.now();
  await db.insert(schema.cosChannelOrgProposals).values({
    id,
    appId,
    status: 'pending',
    proposalJson: JSON.stringify(validation.proposal),
    reasoning: validation.proposal.reasoning || '',
    createdAt: now,
  });

  return c.json({
    id,
    appId,
    status: 'pending',
    proposal: validation.proposal,
    createdAt: now,
  });
});

cosChannelOrganizeRoutes.get('/chief-of-staff/org-proposals', async (c) => {
  const appId = c.req.query('appId');
  const conditions = [];
  if (appId) conditions.push(eq(schema.cosChannelOrgProposals.appId, appId));
  const rows = await db
    .select()
    .from(schema.cosChannelOrgProposals)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.cosChannelOrgProposals.createdAt))
    .limit(20);

  return c.json({
    proposals: rows.map((r) => ({
      id: r.id,
      appId: r.appId,
      status: r.status,
      reasoning: r.reasoning,
      proposal: JSON.parse(r.proposalJson) as ProposalShape,
      createdAt: r.createdAt,
      appliedAt: r.appliedAt,
    })),
  });
});

cosChannelOrganizeRoutes.get('/chief-of-staff/org-proposals/:id', async (c) => {
  const id = c.req.param('id');
  const row = await db
    .select().from(schema.cosChannelOrgProposals)
    .where(eq(schema.cosChannelOrgProposals.id, id)).limit(1)
    .then((r) => r[0]);
  if (!row) return c.json({ error: 'proposal not found' }, 404);
  return c.json({
    id: row.id,
    appId: row.appId,
    status: row.status,
    reasoning: row.reasoning,
    proposal: JSON.parse(row.proposalJson) as ProposalShape,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  });
});

// POST /chief-of-staff/org-proposals/:id/apply
// Idempotent against pending proposals; rejects if already applied/rejected.
// Creates channels (skipping any whose slug is already taken in the workspace,
// reusing the existing channel) and binds each thread to its proposed channel.
cosChannelOrganizeRoutes.post('/chief-of-staff/org-proposals/:id/apply', async (c) => {
  const id = c.req.param('id');
  const row = await db
    .select().from(schema.cosChannelOrgProposals)
    .where(eq(schema.cosChannelOrgProposals.id, id)).limit(1)
    .then((r) => r[0]);
  if (!row) return c.json({ error: 'proposal not found' }, 404);
  if (row.status !== 'pending') return c.json({ error: `proposal already ${row.status}` }, 409);

  const proposal = JSON.parse(row.proposalJson) as ProposalShape;
  const now = Date.now();
  const created: { id: string; slug: string; threadCount: number }[] = [];

  for (const ch of proposal.channels) {
    // Reuse existing channel with the same slug (idempotency).
    const existing = await db
      .select().from(schema.cosChannels)
      .where(and(eq(schema.cosChannels.appId, row.appId), eq(schema.cosChannels.slug, ch.slug)))
      .limit(1)
      .then((r) => r[0]);

    let channelId: string;
    if (existing) {
      channelId = existing.id;
    } else {
      channelId = ulid();
      const slug = await uniqueSlug(row.appId, ch.slug);
      await db.insert(schema.cosChannels).values({
        id: channelId,
        appId: row.appId,
        slug,
        name: ch.name,
        description: ch.description,
        kind: ch.kind,
        policyJson: JSON.stringify(policyForKind(ch.kind)),
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const threadId of ch.threadIds) {
      await db
        .update(schema.cosThreads)
        .set({ channelId, updatedAt: now })
        .where(eq(schema.cosThreads.id, threadId));
    }

    created.push({ id: channelId, slug: ch.slug, threadCount: ch.threadIds.length });
  }

  await db
    .update(schema.cosChannelOrgProposals)
    .set({ status: 'applied', appliedAt: now })
    .where(eq(schema.cosChannelOrgProposals.id, id));

  return c.json({ ok: true, channels: created });
});

cosChannelOrganizeRoutes.post('/chief-of-staff/org-proposals/:id/reject', async (c) => {
  const id = c.req.param('id');
  const row = await db
    .select().from(schema.cosChannelOrgProposals)
    .where(eq(schema.cosChannelOrgProposals.id, id)).limit(1)
    .then((r) => r[0]);
  if (!row) return c.json({ error: 'proposal not found' }, 404);
  if (row.status !== 'pending') return c.json({ error: `proposal already ${row.status}` }, 409);
  await db
    .update(schema.cosChannelOrgProposals)
    .set({ status: 'rejected' })
    .where(eq(schema.cosChannelOrgProposals.id, id));
  return c.json({ ok: true });
});

// Persist + apply a proposal in one call. Used by the auto-sort agent session
// so the model can ship its grouping directly without a separate review step.
async function persistAndApplyProposal(appId: string, proposal: ProposalShape): Promise<{
  proposalId: string;
  channels: { id: string; slug: string; threadCount: number }[];
}> {
  const id = ulid();
  const now = Date.now();
  await db.insert(schema.cosChannelOrgProposals).values({
    id,
    appId,
    status: 'pending',
    proposalJson: JSON.stringify(proposal),
    reasoning: proposal.reasoning || '',
    createdAt: now,
  });

  const channelsOut: { id: string; slug: string; threadCount: number }[] = [];
  for (const ch of proposal.channels) {
    const existing = await db
      .select().from(schema.cosChannels)
      .where(and(eq(schema.cosChannels.appId, appId), eq(schema.cosChannels.slug, ch.slug)))
      .limit(1)
      .then((r) => r[0]);

    let channelId: string;
    if (existing) {
      channelId = existing.id;
    } else {
      channelId = ulid();
      const slug = await uniqueSlug(appId, ch.slug);
      await db.insert(schema.cosChannels).values({
        id: channelId,
        appId,
        slug,
        name: ch.name,
        description: ch.description,
        kind: ch.kind,
        policyJson: JSON.stringify(policyForKind(ch.kind)),
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const threadId of ch.threadIds) {
      await db
        .update(schema.cosThreads)
        .set({ channelId, updatedAt: now })
        .where(eq(schema.cosThreads.id, threadId));
    }
    channelsOut.push({ id: channelId, slug: ch.slug, threadCount: ch.threadIds.length });
  }

  await db
    .update(schema.cosChannelOrgProposals)
    .set({ status: 'applied', appliedAt: now })
    .where(eq(schema.cosChannelOrgProposals.id, id));

  return { proposalId: id, channels: channelsOut };
}

// POST /chief-of-staff/channels/auto-organize-apply  body: { appId, proposal }
// One-shot endpoint the auto-sort agent session curls into when it's ready
// to ship its grouping. Validates against the live thread set so the model
// can't bind ids that no longer exist, then creates channels and rebinds
// threads in a single transaction-ish pass (uses persistAndApplyProposal).
cosChannelOrganizeRoutes.post('/chief-of-staff/channels/auto-organize-apply', async (c) => {
  let body: { appId?: string; proposal?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const appId = (body.appId || '').trim();
  if (!appId) return c.json({ error: 'appId is required' }, 400);
  if (!body.proposal) return c.json({ error: 'proposal is required' }, 400);

  const summaries = await loadThreadSummaries(appId);
  const knownThreadIds = new Set(summaries.map((s) => s.id));
  const validation = validateProposal(body.proposal, knownThreadIds);
  if (!validation.ok) return c.json({ error: `invalid proposal: ${validation.error}` }, 400);

  try {
    const result = await persistAndApplyProposal(appId, validation.proposal);
    return c.json({ ok: true, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `failed to apply: ${msg}` }, 500);
  }
});

function buildSessionPrompt(
  appId: string,
  appName: string,
  baseUrl: string,
  summaries: Awaited<ReturnType<typeof loadThreadSummaries>>,
): string {
  const threadsBlock = summaries.map((s, i) =>
    `[${i + 1}] id=${s.id} agent=${s.agentId} msgs=${s.msgCount}\n  name: ${s.name}\n  first: ${s.firstUserText.replace(/\s+/g, ' ').slice(0, 360)}`
  ).join('\n\n');

  return `# Auto-sort CoS threads into channels

Workspace: "${appName}" (appId=${appId})

There are ${summaries.length} threads in this workspace that need to be organized into Slack-style channels. Group them by topic, scope, or operational mode — fewer channels (~5) is better than many.

For each channel, decide:
- slug: short, lowercase, hyphenated, ≤24 chars (e.g. "mobile-ui", "deploy-ops", "agent-fafo")
- name: human-friendly title (e.g. "Mobile UI", "Deploy Ops")
- description: one short sentence
- kind: "prod" (production/deploy/secrets/migrations), "staging" (default product work), or "exploratory" (fafo/yolo/pow-wow experiments)
- threadIds: array of thread ids assigned to this channel

Every thread must appear in exactly one channel. Prefer fewer channels (~5) over many.

## Threads

${threadsBlock}

## How to apply

POST your proposal directly to the apply endpoint (no review step). Example:

\`\`\`bash
curl -s -X POST ${baseUrl}/api/v1/admin/chief-of-staff/channels/auto-organize-apply \\
  -H 'Content-Type: application/json' \\
  -d '{
    "appId": "${appId}",
    "proposal": {
      "channels": [
        {"slug":"mobile-ui","name":"Mobile UI","description":"...","kind":"staging","threadIds":["...","..."]}
      ],
      "reasoning": "one short paragraph on the grouping logic"
    }
  }'
\`\`\`

The server validates against the live thread set, creates channels (reusing existing slugs), binds each thread, and responds with \`{ ok: true, proposalId, channels: [...] }\`. Report the channel count and a one-line summary when done.`;
}

// POST /chief-of-staff/channels/auto-organize-session  body: { appId }
// Launches a visible agent session that does the auto-sort work. The session
// reads thread summaries in its prompt, picks a grouping, and curls the
// apply endpoint above to ship channels + thread bindings.
cosChannelOrganizeRoutes.post('/chief-of-staff/channels/auto-organize-session', async (c) => {
  let body: { appId?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  const appId = (body.appId || '').trim();
  if (!appId) return c.json({ error: 'appId is required' }, 400);

  const app = await db
    .select({ id: schema.applications.id, name: schema.applications.name, projectDir: schema.applications.projectDir })
    .from(schema.applications)
    .where(eq(schema.applications.id, appId))
    .limit(1)
    .then((r) => r[0]);
  if (!app) return c.json({ error: 'app not found' }, 404);

  const summaries = await loadThreadSummaries(appId);
  if (summaries.length === 0) return c.json({ error: 'no threads to organize' }, 400);

  // Pick the default agent endpoint (mirrors setupAssist pattern).
  let agentEndpointId: string | null = null;
  const defaultAgent = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.isDefault, true)).get();
  if (defaultAgent) {
    agentEndpointId = defaultAgent.id;
  } else {
    const anyAgent = db.select().from(schema.agentEndpoints).get();
    if (anyAgent) agentEndpointId = anyAgent.id;
  }
  if (!agentEndpointId) return c.json({ error: 'No agent endpoint configured' }, 400);

  const agentRow = db.select().from(schema.agentEndpoints)
    .where(eq(schema.agentEndpoints.id, agentEndpointId)).get();
  if (!agentRow) return c.json({ error: 'Agent endpoint not found' }, 404);

  const host = c.req.header('host') || 'localhost:3001';
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const baseUrl = `${proto}://${host}`;

  const prompt = buildSessionPrompt(appId, app.name, baseUrl, summaries);

  // Create a feedback row so the session has somewhere to land. Reuses the
  // dispatchedAt fields so the row reads correctly in the feedback list if
  // the operator stumbles on it; type=request matches setupAssist's pattern.
  const feedbackId = ulid();
  const now = new Date().toISOString();
  db.insert(schema.feedbackItems).values({
    id: feedbackId,
    type: 'request',
    status: 'dispatched',
    title: `[Auto-sort threads] ${app.name}: organize ${summaries.length} threads`,
    description: `Auto-sort agent session for ${summaries.length} CoS threads in workspace "${app.name}".`,
    appId,
    dispatchedTo: agentRow.name,
    dispatchedAt: now,
    dispatchStatus: 'dispatched',
    createdAt: now,
    updatedAt: now,
  }).run();

  const cwd = app.projectDir || process.cwd();

  try {
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId,
      prompt,
      cwd,
      permissionProfile: 'interactive-yolo' as PermissionProfile,
      allowedTools: agentRow.allowedTools,
    });
    return c.json({ sessionId, feedbackId, appId });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: errorMsg }, 500);
  }
});
