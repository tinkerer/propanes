import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq } from 'drizzle-orm';
import {
  aggregateQuerySchema,
  planCreateSchema,
  planUpdateSchema,
  analyzeSchema,
  analyzeClusterSchema,
} from '@propanes/shared';
import type { PermissionProfile } from '@propanes/shared';
import { db, schema, sqlite } from '../db/index.js';
import { dispatchAgentSession } from '../dispatch.js';

export const aggregateRoutes = new Hono();

// --- Reusable clustering helpers ---

function normalizeForGrouping(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(text: string): Set<string> {
  const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'be', 'to', 'of', 'and', 'in', 'for', 'on', 'it', 'i', 'we', 'you', 'that', 'this', 'with']);
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 1 && !stopWords.has(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface ClusterItem {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  created_at: string;
}

export interface ClusterGroup {
  key: string;
  sampleTitle: string;
  items: ClusterItem[];
}

export function clusterItems(allItems: ClusterItem[], minCount = 2): ClusterGroup[] {
  const titleGroups = new Map<string, ClusterItem[]>();
  for (const item of allItems) {
    const key = normalizeForGrouping(item.title);
    const group = titleGroups.get(key);
    if (group) group.push(item);
    else titleGroups.set(key, [item]);
  }

  const groupEntries = [...titleGroups.entries()];
  const merged = new Array<boolean>(groupEntries.length).fill(false);
  const mergedGroups: ClusterGroup[] = [];

  for (let i = 0; i < groupEntries.length; i++) {
    if (merged[i]) continue;
    const [keyI, itemsI] = groupEntries[i];
    const wordsI = wordSet(keyI);
    const combined = [...itemsI];
    let mergedKey = keyI;

    for (let j = i + 1; j < groupEntries.length; j++) {
      if (merged[j]) continue;
      const [keyJ, itemsJ] = groupEntries[j];
      const wordsJ = wordSet(keyJ);
      if (jaccardSimilarity(wordsI, wordsJ) >= 0.6) {
        combined.push(...itemsJ);
        merged[j] = true;
        if (itemsJ.length > itemsI.length) mergedKey = keyJ;
      }
    }

    mergedGroups.push({ key: mergedKey, sampleTitle: combined[0].title, items: combined });
  }

  return mergedGroups.filter((g) => g.items.length >= minCount).sort((a, b) => b.items.length - a.items.length);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

// GET / — group feedback by normalized title
aggregateRoutes.get('/', async (c) => {
  const query = aggregateQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    return c.json({ error: 'Invalid query', details: query.error.flatten() }, 400);
  }

  const { appId, type, status, includeClosed, minCount } = query.data;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (appId) {
    if (appId === '__unlinked__') {
      conditions.push('fi.app_id IS NULL');
    } else {
      conditions.push('fi.app_id = ?');
      params.push(appId);
    }
  }
  if (type) {
    conditions.push('fi.type = ?');
    params.push(type);
  }
  if (status) {
    conditions.push('fi.status = ?');
    params.push(status);
  } else if (!includeClosed) {
    conditions.push("fi.status NOT IN ('resolved', 'archived')");
  }

  const whereClause = conditions.length > 0
    ? 'WHERE ' + conditions.join(' AND ')
    : '';

  // Fetch all matching feedback items
  const itemsQuery = `
    SELECT id, title, description, type, status, created_at
    FROM feedback_items fi
    ${whereClause}
    ORDER BY created_at DESC
  `;

  const allItems = sqlite.prepare(itemsQuery).all(
    ...params
  ) as { id: string; title: string; description: string; type: string; status: string; created_at: string }[];

  // Cluster using reusable function
  const filteredGroups = clusterItems(allItems as ClusterItem[], minCount);

  const clusters = filteredGroups.map((group) => {
    const feedbackIds = group.items.map((r) => r.id);
    const placeholders = feedbackIds.map(() => '?').join(',');

    const tagRows = sqlite.prepare(
      `SELECT DISTINCT tag FROM feedback_tags WHERE feedback_id IN (${placeholders})`
    ).all(...feedbackIds) as { tag: string }[];

    const types = [...new Set(group.items.map((r) => r.type))];
    const statuses = [...new Set(group.items.map((r) => r.status))];

    const dates = group.items.map((r) => r.created_at).sort();
    const oldestAt = dates[0];
    const newestAt = dates[dates.length - 1];

    const plan = sqlite.prepare(
      `SELECT * FROM plans WHERE group_key = ? AND (app_id = ? OR (app_id IS NULL AND ? IS NULL)) ORDER BY updated_at DESC LIMIT 1`
    ).get(group.key, appId || null, appId || null) as any | undefined;

    return {
      groupKey: group.key,
      title: group.sampleTitle,
      count: group.items.length,
      feedbackIds,
      items: group.items.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description?.slice(0, 200) || '',
        type: r.type,
        status: r.status,
        createdAt: r.created_at,
      })),
      tags: tagRows.map((t) => t.tag),
      types,
      statuses,
      oldestAt,
      newestAt,
      plan: plan ? {
        id: plan.id,
        groupKey: plan.group_key,
        title: plan.title,
        body: plan.body,
        status: plan.status,
        linkedFeedbackIds: JSON.parse(plan.linked_feedback_ids || '[]'),
        appId: plan.app_id,
        createdAt: plan.created_at,
        updatedAt: plan.updated_at,
      } : null,
    };
  });

  const totalItems = clusters.reduce((sum, c) => sum + c.count, 0);

  return c.json({
    clusters,
    totalGroups: clusters.length,
    totalItems,
  });
});

// POST /analyze — dispatch all feedback to an agent for intelligent clustering
aggregateRoutes.post('/analyze', async (c) => {
  const body = await c.req.json();
  const parsed = analyzeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { appId, agentEndpointId } = parsed.data;

  const agent = await db.query.agentEndpoints.findFirst({
    where: eq(schema.agentEndpoints.id, agentEndpointId),
  });
  if (!agent) {
    return c.json({ error: 'Agent endpoint not found' }, 404);
  }

  // Fetch all feedback items for the app
  const condition = appId === '__unlinked__'
    ? 'WHERE app_id IS NULL'
    : 'WHERE app_id = ?';
  const feedbackParams = appId === '__unlinked__' ? [] : [appId];

  const feedbackRows = sqlite.prepare(
    `SELECT id, title, description, type, status, created_at FROM feedback_items ${condition} ORDER BY created_at DESC LIMIT 500`
  ).all(...feedbackParams) as {
    id: string;
    title: string;
    description: string;
    type: string;
    status: string;
    created_at: string;
  }[];

  if (feedbackRows.length === 0) {
    return c.json({ error: 'No feedback items found for this app' }, 400);
  }

  // Fetch tags for each item
  const allIds = feedbackRows.map((r) => r.id);
  const tagPlaceholders = allIds.map(() => '?').join(',');
  const allTags = sqlite.prepare(
    `SELECT feedback_id, tag FROM feedback_tags WHERE feedback_id IN (${tagPlaceholders})`
  ).all(...allIds) as { feedback_id: string; tag: string }[];

  const tagsByFeedback: Record<string, string[]> = {};
  for (const t of allTags) {
    (tagsByFeedback[t.feedback_id] ||= []).push(t.tag);
  }

  // Build the analysis prompt
  const itemsList = feedbackRows.map((r, i) => {
    const tags = tagsByFeedback[r.id]?.join(', ') || '';
    return `${i + 1}. [${r.id}] "${r.title}" (${r.type}, ${r.status}${tags ? `, tags: ${tags}` : ''})
   ${r.description || '(no description)'}`;
  }).join('\n\n');

  const analysisPrompt = `You are analyzing ${feedbackRows.length} feedback items for an application. Your job is to:

1. **Group similar/related feedback** — items that describe the same issue, request the same feature, or relate to the same topic should be clustered together, even if worded differently.
2. **Rank by frequency** — the most commonly requested items or most frequently reported issues should appear first.
3. **Create unambiguous action plans** — for each cluster, write a clear, actionable plan that a developer could follow. Be specific about what needs to be done.

Format your output as a structured analysis:

For each cluster:
- **Theme**: A clear, concise title for this group
- **Count**: How many feedback items belong to this group
- **Item IDs**: List the feedback IDs (the bracketed IDs like [01JXYZ...])
- **Priority**: High / Medium / Low based on frequency and severity
- **Action Plan**: A concrete, unambiguous plan for addressing this cluster

Here are the feedback items:

${itemsList}

Analyze these items and produce your clustering and action plans.`;

  // Look up the app for cwd (request appId takes priority, then agent's app)
  let app = null;
  const targetAppId = (appId && appId !== '__unlinked__') ? appId : agent.appId;
  if (targetAppId) {
    const appRow = await db.query.applications.findFirst({
      where: eq(schema.applications.id, targetAppId),
    });
    if (appRow) {
      app = { ...appRow, hooks: JSON.parse(appRow.hooks) };
    }
  }

  const cwd = app?.projectDir || process.cwd();
  const permissionProfile = (agent.permissionProfile || 'interactive') as PermissionProfile;

  // Create a synthetic feedback item to anchor the agent session
  const analysisFeedbackId = ulid();
  const now = new Date().toISOString();

  db.insert(schema.feedbackItems).values({
    id: analysisFeedbackId,
    type: 'programmatic',
    status: 'dispatched',
    title: `Feedback Analysis — ${feedbackRows.length} items`,
    description: `Automated analysis of ${feedbackRows.length} feedback items for clustering and action planning.`,
    appId: appId === '__unlinked__' ? null : appId,
    createdAt: now,
    updatedAt: now,
  }).run();

  const { sessionId } = await dispatchAgentSession({
    feedbackId: analysisFeedbackId,
    agentEndpointId,
    prompt: analysisPrompt,
    cwd,
    permissionProfile,
    allowedTools: agent.allowedTools || (app as any)?.defaultAllowedTools || null,
  });

  db.update(schema.feedbackItems).set({
    dispatchedTo: agent.name,
    dispatchedAt: now,
    dispatchStatus: 'running',
    dispatchResponse: `Analysis session: ${sessionId}`,
    updatedAt: now,
  }).where(eq(schema.feedbackItems.id, analysisFeedbackId)).run();

  return c.json({
    sessionId,
    feedbackId: analysisFeedbackId,
    itemCount: feedbackRows.length,
  });
});

// POST /analyze-cluster — dispatch a specific cluster to an agent for plan generation
aggregateRoutes.post('/analyze-cluster', async (c) => {
  const body = await c.req.json();
  const parsed = analyzeClusterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { appId, agentEndpointId, feedbackIds, clusterTitle } = parsed.data;

  const agent = await db.query.agentEndpoints.findFirst({
    where: eq(schema.agentEndpoints.id, agentEndpointId),
  });
  if (!agent) {
    return c.json({ error: 'Agent endpoint not found' }, 404);
  }

  const placeholders = feedbackIds.map(() => '?').join(',');
  const feedbackRows = sqlite.prepare(
    `SELECT id, title, description, type, status, created_at FROM feedback_items WHERE id IN (${placeholders})`
  ).all(...feedbackIds) as { id: string; title: string; description: string; type: string; status: string; created_at: string }[];

  if (feedbackRows.length === 0) {
    return c.json({ error: 'No feedback items found' }, 400);
  }

  const allTags = sqlite.prepare(
    `SELECT feedback_id, tag FROM feedback_tags WHERE feedback_id IN (${placeholders})`
  ).all(...feedbackIds) as { feedback_id: string; tag: string }[];

  const tagsByFeedback: Record<string, string[]> = {};
  for (const t of allTags) {
    (tagsByFeedback[t.feedback_id] ||= []).push(t.tag);
  }

  const itemsList = feedbackRows.map((r, i) => {
    const tags = tagsByFeedback[r.id]?.join(', ') || '';
    return `${i + 1}. [${r.id}] "${r.title}" (${r.type}, ${r.status}${tags ? `, tags: ${tags}` : ''})
   ${r.description || '(no description)'}`;
  }).join('\n\n');

  const clusterPrompt = `You are analyzing a cluster of ${feedbackRows.length} related feedback items titled "${clusterTitle}". These items have been grouped together because they appear to describe the same request or issue.

Your job is to:
1. **Disambiguate** — Determine if all items truly describe the same thing, or if there are subtle differences that should be noted.
2. **Synthesize** — Create a single, unambiguous description of what this cluster represents.
3. **Create an action plan** — Write a clear, concrete, step-by-step plan for addressing this feedback. Be specific about what needs to be built, changed, or fixed. The plan should be actionable by a developer.
4. **Prioritize** — Assess the priority (High/Medium/Low) based on frequency and described severity.

Format your output as:

## Summary
A clear, one-paragraph synthesis of what these feedback items are requesting.

## Disambiguation Notes
Any differences between the items that should be noted. If they all say the same thing, state that.

## Action Plan
A numbered list of concrete steps to address this feedback.

## Priority
High / Medium / Low with justification.

Here are the feedback items in this cluster:

${itemsList}`;

  let app = null;
  const clusterAppId = (appId && appId !== '__unlinked__') ? appId : agent.appId;
  if (clusterAppId) {
    const appRow = await db.query.applications.findFirst({
      where: eq(schema.applications.id, clusterAppId),
    });
    if (appRow) {
      app = { ...appRow, hooks: JSON.parse(appRow.hooks) };
    }
  }

  const cwd = app?.projectDir || process.cwd();
  const permissionProfile = (agent.permissionProfile || 'interactive') as PermissionProfile;

  const analysisFeedbackId = ulid();
  const now = new Date().toISOString();

  db.insert(schema.feedbackItems).values({
    id: analysisFeedbackId,
    type: 'programmatic',
    status: 'dispatched',
    title: `Cluster Analysis — "${clusterTitle}" (${feedbackRows.length} items)`,
    description: `Automated analysis of cluster "${clusterTitle}" with ${feedbackRows.length} feedback items for disambiguation and action planning.`,
    appId: appId === '__unlinked__' ? null : appId,
    createdAt: now,
    updatedAt: now,
  }).run();

  const { sessionId } = await dispatchAgentSession({
    feedbackId: analysisFeedbackId,
    agentEndpointId,
    prompt: clusterPrompt,
    cwd,
    permissionProfile,
    allowedTools: agent.allowedTools || (app as any)?.defaultAllowedTools || null,
  });

  db.update(schema.feedbackItems).set({
    dispatchedTo: agent.name,
    dispatchedAt: now,
    dispatchStatus: 'running',
    dispatchResponse: `Cluster analysis session: ${sessionId}`,
    updatedAt: now,
  }).where(eq(schema.feedbackItems.id, analysisFeedbackId)).run();

  return c.json({
    sessionId,
    feedbackId: analysisFeedbackId,
    itemCount: feedbackRows.length,
  });
});

// POST /cluster-and-tag — run clustering and auto-tag items with theme + aggregated date
aggregateRoutes.post('/cluster-and-tag', async (c) => {
  const body = await c.req.json();
  const { appId, excludeAlreadyAggregated } = body as { appId?: string; excludeAlreadyAggregated?: boolean };

  if (!appId) return c.json({ error: 'appId is required' }, 400);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (appId === '__unlinked__') {
    conditions.push('fi.app_id IS NULL');
  } else {
    conditions.push('fi.app_id = ?');
    params.push(appId);
  }
  conditions.push("fi.status NOT IN ('resolved', 'archived', 'deleted')");

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const allItems = sqlite.prepare(
    `SELECT id, title, description, type, status, created_at FROM feedback_items fi ${whereClause} ORDER BY created_at DESC`
  ).all(...params) as ClusterItem[];

  let itemsToCluster = allItems;

  if (excludeAlreadyAggregated) {
    const aggregatedIds = new Set(
      (sqlite.prepare(
        `SELECT DISTINCT feedback_id FROM feedback_tags WHERE tag LIKE 'aggregated:%'`
      ).all() as { feedback_id: string }[]).map(r => r.feedback_id)
    );
    itemsToCluster = allItems.filter(i => !aggregatedIds.has(i.id));
  }

  const clusters = clusterItems(itemsToCluster);
  const today = new Date().toISOString().slice(0, 10);
  const themes: string[] = [];
  let itemsTagged = 0;

  for (const cluster of clusters) {
    const themeSlug = slugify(cluster.sampleTitle);
    const themeTag = `theme:${themeSlug}`;
    const aggregatedTag = `aggregated:${today}`;
    themes.push(themeTag);

    for (const item of cluster.items) {
      // Check existing tags to avoid duplicates
      const existingTags = new Set(
        (sqlite.prepare('SELECT tag FROM feedback_tags WHERE feedback_id = ?').all(item.id) as { tag: string }[]).map(r => r.tag)
      );

      if (!existingTags.has(themeTag)) {
        sqlite.prepare('INSERT INTO feedback_tags (feedback_id, tag) VALUES (?, ?)').run(item.id, themeTag);
      }
      if (!existingTags.has(aggregatedTag)) {
        sqlite.prepare('INSERT INTO feedback_tags (feedback_id, tag) VALUES (?, ?)').run(item.id, aggregatedTag);
      }
      itemsTagged++;
    }
  }

  return c.json({
    clustersFound: clusters.length,
    itemsTagged,
    themes,
  });
});

// Plans CRUD

aggregateRoutes.post('/plans', async (c) => {
  const body = await c.req.json();
  const parsed = planCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const now = new Date().toISOString();
  const id = ulid();

  db.insert(schema.plans).values({
    id,
    groupKey: parsed.data.groupKey,
    title: parsed.data.title,
    body: parsed.data.body,
    status: parsed.data.status,
    linkedFeedbackIds: JSON.stringify(parsed.data.linkedFeedbackIds),
    appId: parsed.data.appId || null,
    createdAt: now,
    updatedAt: now,
  }).run();

  return c.json({ id }, 201);
});

aggregateRoutes.get('/plans', async (c) => {
  const appId = c.req.query('appId');
  const condition = appId
    ? appId === '__unlinked__'
      ? 'WHERE app_id IS NULL'
      : 'WHERE app_id = ?'
    : '';
  const params = appId && appId !== '__unlinked__' ? [appId] : [];

  const rows = sqlite.prepare(
    `SELECT * FROM plans ${condition} ORDER BY updated_at DESC`
  ).all(...params) as any[];

  const plans = rows.map((p) => ({
    id: p.id,
    groupKey: p.group_key,
    title: p.title,
    body: p.body,
    status: p.status,
    linkedFeedbackIds: JSON.parse(p.linked_feedback_ids || '[]'),
    appId: p.app_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));

  return c.json(plans);
});

aggregateRoutes.get('/plans/:id', async (c) => {
  const id = c.req.param('id');
  const plan = await db.query.plans.findFirst({
    where: eq(schema.plans.id, id),
  });
  if (!plan) return c.json({ error: 'Not found' }, 404);

  return c.json({
    ...plan,
    linkedFeedbackIds: JSON.parse(plan.linkedFeedbackIds),
  });
});

aggregateRoutes.patch('/plans/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = planUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const existing = await db.query.plans.findFirst({
    where: eq(schema.plans.id, id),
  });
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (parsed.data.title) updates.title = parsed.data.title;
  if (parsed.data.body !== undefined) updates.body = parsed.data.body;
  if (parsed.data.status) updates.status = parsed.data.status;
  if (parsed.data.linkedFeedbackIds) {
    updates.linkedFeedbackIds = JSON.stringify(parsed.data.linkedFeedbackIds);
  }

  await db.update(schema.plans).set(updates).where(eq(schema.plans.id, id));

  if (parsed.data.status === 'completed') {
    const feedbackIds: string[] = JSON.parse(existing.linkedFeedbackIds || '[]');
    if (feedbackIds.length > 0) {
      const placeholders = feedbackIds.map(() => '?').join(',');
      sqlite.prepare(
        `UPDATE feedback_items SET status = 'resolved', updated_at = ? WHERE id IN (${placeholders}) AND status NOT IN ('resolved', 'archived')`
      ).run(now, ...feedbackIds);
    }
  }

  return c.json({ id, updated: true });
});

aggregateRoutes.delete('/plans/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await db.query.plans.findFirst({
    where: eq(schema.plans.id, id),
  });
  if (!existing) return c.json({ error: 'Not found' }, 404);

  await db.delete(schema.plans).where(eq(schema.plans.id, id));
  return c.json({ id, deleted: true });
});
