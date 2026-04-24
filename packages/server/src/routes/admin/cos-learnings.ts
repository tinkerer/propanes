import { Hono } from 'hono';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';

export const cosLearningsRoutes = new Hono();

const ALLOWED_TYPES = new Set(['pitfall', 'suggestion', 'tool_gap']);
const ALLOWED_SEVERITY = new Set(['low', 'medium', 'high']);
const ALLOWED_REL_TYPES = new Set(['related', 'caused_by', 'resolved_by', 'duplicate_of']);
const ALLOWED_LINK_SOURCES = new Set(['user', 'wiggum', 'auto']);

// Jaccard similarity threshold over title+body token sets above which the
// server proposes a `duplicate_of` link automatically when a new learning
// lands. Tuned conservatively — false positives just create a link the user
// can dismiss, but spamming every insertion would clutter the graph.
const AUTO_DUPLICATE_THRESHOLD = 0.6;
const AUTO_RELATED_THRESHOLD = 0.35;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'should', 'could', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in',
  'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into', 'about', 'this',
  'that', 'these', 'those', 'it', 'its', 'if', 'then', 'so', 'no', 'not',
  'we', 'i', 'you', 'they', 'them', 'their', 'our', 'us', 'me', 'my',
]);

function tokenize(text: string): Set<string> {
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
  const out = new Set<string>();
  for (const t of tokens) if (!STOP_WORDS.has(t)) out.add(t);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

type LearningRow = typeof schema.cosLearnings.$inferSelect;

function decodeTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string');
  } catch { /* ignore */ }
  return [];
}

function shapeLearning(row: LearningRow) {
  return {
    id: row.id,
    sessionJsonl: row.sessionJsonl,
    type: row.type,
    title: row.title,
    body: row.body,
    severity: row.severity,
    tags: decodeTags(row.tags),
    createdAt: row.createdAt,
  };
}

cosLearningsRoutes.get('/cos/learnings', async (c) => {
  const type = c.req.query('type');
  const severity = c.req.query('severity');

  const conditions = [];
  if (type && ALLOWED_TYPES.has(type)) conditions.push(eq(schema.cosLearnings.type, type));
  if (severity && ALLOWED_SEVERITY.has(severity)) conditions.push(eq(schema.cosLearnings.severity, severity));

  const rows = await db
    .select()
    .from(schema.cosLearnings)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.cosLearnings.createdAt))
    .limit(500);

  return c.json({ learnings: rows.map(shapeLearning) });
});

// Returns nodes + edges for the knowledge graph view. Nodes are every
// learning; edges are every link. UI is responsible for layout.
cosLearningsRoutes.get('/cos/learnings/graph', async (c) => {
  const [nodes, edges] = await Promise.all([
    db.select().from(schema.cosLearnings).orderBy(desc(schema.cosLearnings.createdAt)).limit(500),
    db.select().from(schema.cosLearningLinks),
  ]);
  return c.json({
    nodes: nodes.map(shapeLearning),
    edges: edges.map((e) => ({
      id: e.id,
      fromId: e.fromId,
      toId: e.toId,
      relType: e.relType,
      source: e.source,
      createdAt: e.createdAt,
    })),
  });
});

// Detail view for a single learning. Includes outgoing links (this learning
// → others) and backlinks (others → this learning), each annotated with the
// peer learning's title/type/severity so the wiki page can render without a
// follow-up roundtrip.
cosLearningsRoutes.get('/cos/learnings/:id', async (c) => {
  const id = c.req.param('id');
  const row = await db.query.cosLearnings.findFirst({
    where: eq(schema.cosLearnings.id, id),
  });
  if (!row) return c.json({ error: 'not found' }, 404);

  const linkRows = await db
    .select()
    .from(schema.cosLearningLinks)
    .where(or(eq(schema.cosLearningLinks.fromId, id), eq(schema.cosLearningLinks.toId, id)));

  const peerIds = new Set<string>();
  for (const l of linkRows) {
    if (l.fromId !== id) peerIds.add(l.fromId);
    if (l.toId !== id) peerIds.add(l.toId);
  }

  const peers = peerIds.size === 0
    ? []
    : await db.select().from(schema.cosLearnings)
        .where(inArray(schema.cosLearnings.id, Array.from(peerIds)));
  const peerMap = new Map(peers.map((p) => [p.id, p]));

  const outgoing = linkRows
    .filter((l) => l.fromId === id)
    .map((l) => {
      const peer = peerMap.get(l.toId);
      return {
        linkId: l.id,
        relType: l.relType,
        source: l.source,
        createdAt: l.createdAt,
        peer: peer ? {
          id: peer.id,
          title: peer.title,
          type: peer.type,
          severity: peer.severity,
        } : null,
      };
    });
  const backlinks = linkRows
    .filter((l) => l.toId === id)
    .map((l) => {
      const peer = peerMap.get(l.fromId);
      return {
        linkId: l.id,
        relType: l.relType,
        source: l.source,
        createdAt: l.createdAt,
        peer: peer ? {
          id: peer.id,
          title: peer.title,
          type: peer.type,
          severity: peer.severity,
        } : null,
      };
    });

  return c.json({
    learning: shapeLearning(row),
    outgoing,
    backlinks,
  });
});

cosLearningsRoutes.post('/cos/learnings', async (c) => {
  let body: {
    learnings?: Array<{
      sessionJsonl?: string | null;
      type?: string;
      title?: string;
      body?: string;
      severity?: string;
      tags?: string[];
    }>;
    sessionJsonl?: string | null;
    type?: string;
    title?: string;
    body?: string;
    severity?: string;
    tags?: string[];
    autoLink?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const items = Array.isArray(body.learnings)
    ? body.learnings
    : (body.type || body.title)
      ? [{
          sessionJsonl: body.sessionJsonl,
          type: body.type,
          title: body.title,
          body: body.body,
          severity: body.severity,
          tags: body.tags,
        }]
      : [];

  if (items.length === 0) return c.json({ error: 'No learnings provided' }, 400);

  const autoLink = body.autoLink !== false; // default on; Wiggum may opt out

  const now = Date.now();
  const inserted: ReturnType<typeof shapeLearning>[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  const autoLinks: Array<{ id: string; fromId: string; toId: string; relType: string; source: string }> = [];

  // Pull existing learnings once for similarity comparison; bounded so very
  // large stores don't blow up the comparison cost.
  const existing = autoLink
    ? await db.select().from(schema.cosLearnings).orderBy(desc(schema.cosLearnings.createdAt)).limit(500)
    : [];
  const existingTokens = existing.map((e) => ({
    row: e,
    tokens: tokenize(`${e.title} ${e.body}`),
  }));

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const type = (it.type || '').trim();
    const title = (it.title || '').trim();
    const text = (it.body || '').trim();
    const severity = (it.severity || 'medium').trim();
    const tags = Array.isArray(it.tags)
      ? it.tags.filter((t) => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim().slice(0, 60))
      : [];
    if (!ALLOWED_TYPES.has(type)) {
      skipped.push({ index: i, reason: `invalid type "${type}"` });
      continue;
    }
    if (!title) {
      skipped.push({ index: i, reason: 'title required' });
      continue;
    }
    if (!ALLOWED_SEVERITY.has(severity)) {
      skipped.push({ index: i, reason: `invalid severity "${severity}"` });
      continue;
    }
    const id = ulid();
    const row = {
      id,
      sessionJsonl: it.sessionJsonl ?? null,
      type,
      title: title.slice(0, 200),
      body: text,
      severity,
      tags: tags.length > 0 ? JSON.stringify(tags) : null,
      createdAt: now + i,
    };
    await db.insert(schema.cosLearnings).values(row);
    inserted.push(shapeLearning(row as LearningRow));

    if (autoLink) {
      const newTokens = tokenize(`${title} ${text}`);
      let bestRelated: { row: LearningRow; sim: number } | null = null;
      for (const cand of existingTokens) {
        if (cand.row.id === id) continue;
        const sim = jaccard(newTokens, cand.tokens);
        if (sim >= AUTO_DUPLICATE_THRESHOLD) {
          // Strong overlap → propose a duplicate_of link from the new
          // learning back to the older one.
          const linkId = ulid();
          try {
            await db.insert(schema.cosLearningLinks).values({
              id: linkId,
              fromId: id,
              toId: cand.row.id,
              relType: 'duplicate_of',
              source: 'auto',
              createdAt: now + i,
            });
            autoLinks.push({ id: linkId, fromId: id, toId: cand.row.id, relType: 'duplicate_of', source: 'auto' });
          } catch { /* unique index collision — skip */ }
        } else if (sim >= AUTO_RELATED_THRESHOLD) {
          if (!bestRelated || sim > bestRelated.sim) bestRelated = { row: cand.row, sim };
        }
      }
      // Add a single best `related` link if no duplicate fired — keeps the
      // graph from getting choked with weak edges.
      if (bestRelated && !autoLinks.some((l) => l.fromId === id && l.toId === bestRelated!.row.id)) {
        const linkId = ulid();
        try {
          await db.insert(schema.cosLearningLinks).values({
            id: linkId,
            fromId: id,
            toId: bestRelated.row.id,
            relType: 'related',
            source: 'auto',
            createdAt: now + i,
          });
          autoLinks.push({ id: linkId, fromId: id, toId: bestRelated.row.id, relType: 'related', source: 'auto' });
        } catch { /* skip */ }
      }
      // Add the freshly-inserted learning to the working set so subsequent
      // items in the same batch can link to it.
      existingTokens.push({ row: row as LearningRow, tokens: newTokens });
    }
  }

  return c.json({ inserted, skipped, count: inserted.length, autoLinks });
});

// Patch a single learning (wiki-style edit: tags, body, severity, title).
cosLearningsRoutes.patch('/cos/learnings/:id', async (c) => {
  const id = c.req.param('id');
  let body: { title?: string; body?: string; severity?: string; tags?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const row = await db.query.cosLearnings.findFirst({ where: eq(schema.cosLearnings.id, id) });
  if (!row) return c.json({ error: 'not found' }, 404);

  const patch: Partial<LearningRow> = {};
  if (typeof body.title === 'string') {
    const t = body.title.trim();
    if (!t) return c.json({ error: 'title cannot be empty' }, 400);
    patch.title = t.slice(0, 200);
  }
  if (typeof body.body === 'string') patch.body = body.body;
  if (typeof body.severity === 'string') {
    if (!ALLOWED_SEVERITY.has(body.severity)) return c.json({ error: `invalid severity "${body.severity}"` }, 400);
    patch.severity = body.severity;
  }
  if (Array.isArray(body.tags)) {
    const tags = body.tags
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().slice(0, 60));
    patch.tags = tags.length > 0 ? JSON.stringify(tags) : null;
  }
  if (Object.keys(patch).length === 0) return c.json({ learning: shapeLearning(row) });

  await db.update(schema.cosLearnings).set(patch).where(eq(schema.cosLearnings.id, id));
  const updated = await db.query.cosLearnings.findFirst({ where: eq(schema.cosLearnings.id, id) });
  return c.json({ learning: updated ? shapeLearning(updated) : null });
});

cosLearningsRoutes.delete('/cos/learnings/:id', async (c) => {
  const id = c.req.param('id');
  // Cascading FK delete handles links automatically.
  await db.delete(schema.cosLearnings).where(eq(schema.cosLearnings.id, id));
  return c.json({ ok: true });
});

// Create a manual link between two learnings.
cosLearningsRoutes.post('/cos/learnings/:id/links', async (c) => {
  const fromId = c.req.param('id');
  let body: { toId?: string; relType?: string; source?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const toId = (body.toId || '').trim();
  const relType = (body.relType || 'related').trim();
  const source = (body.source || 'user').trim();
  if (!toId) return c.json({ error: 'toId required' }, 400);
  if (toId === fromId) return c.json({ error: 'cannot link a learning to itself' }, 400);
  if (!ALLOWED_REL_TYPES.has(relType)) return c.json({ error: `invalid relType "${relType}"` }, 400);
  if (!ALLOWED_LINK_SOURCES.has(source)) return c.json({ error: `invalid source "${source}"` }, 400);

  const [fromRow, toRow] = await Promise.all([
    db.query.cosLearnings.findFirst({ where: eq(schema.cosLearnings.id, fromId) }),
    db.query.cosLearnings.findFirst({ where: eq(schema.cosLearnings.id, toId) }),
  ]);
  if (!fromRow || !toRow) return c.json({ error: 'learning not found' }, 404);

  const linkId = ulid();
  try {
    await db.insert(schema.cosLearningLinks).values({
      id: linkId,
      fromId,
      toId,
      relType,
      source,
      createdAt: Date.now(),
    });
  } catch (e: any) {
    // Most likely a unique-index collision on (from, to, rel_type)
    return c.json({ error: 'link already exists', detail: String(e?.message || e) }, 409);
  }
  return c.json({ link: { id: linkId, fromId, toId, relType, source } });
});

// Delete a single link by its own id.
cosLearningsRoutes.delete('/cos/learnings/links/:linkId', async (c) => {
  const linkId = c.req.param('linkId');
  await db.delete(schema.cosLearningLinks).where(eq(schema.cosLearningLinks.id, linkId));
  return c.json({ ok: true });
});

// Compute (but don't insert) candidate links for a learning, ranked by
// Jaccard similarity over title+body tokens. The UI uses this to surface
// "you may want to link these" suggestions in the detail drawer.
cosLearningsRoutes.get('/cos/learnings/:id/suggested-links', async (c) => {
  const id = c.req.param('id');
  const row = await db.query.cosLearnings.findFirst({ where: eq(schema.cosLearnings.id, id) });
  if (!row) return c.json({ error: 'not found' }, 404);

  const others = await db.select().from(schema.cosLearnings).orderBy(desc(schema.cosLearnings.createdAt)).limit(500);
  const existingLinks = await db.select().from(schema.cosLearningLinks)
    .where(or(eq(schema.cosLearningLinks.fromId, id), eq(schema.cosLearningLinks.toId, id)));
  const linkedPeerIds = new Set<string>();
  for (const l of existingLinks) {
    linkedPeerIds.add(l.fromId === id ? l.toId : l.fromId);
  }

  const myTokens = tokenize(`${row.title} ${row.body}`);
  const scored = others
    .filter((o) => o.id !== id && !linkedPeerIds.has(o.id))
    .map((o) => ({
      peer: { id: o.id, title: o.title, type: o.type, severity: o.severity },
      similarity: jaccard(myTokens, tokenize(`${o.title} ${o.body}`)),
    }))
    .filter((s) => s.similarity > 0.1)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);

  return c.json({ suggestions: scored });
});

// Wiggum posts a summary of its findings here. The summary becomes a
// system-role message in the named CoS thread (visible to history) AND is
// stashed in cos_metadata so the Learnings UI can show the banner without
// having to walk every thread.
cosLearningsRoutes.post('/cos/learnings/announce', async (c) => {
  let body: { threadId?: string; summary?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const threadId = (body.threadId || '').trim();
  const summary = (body.summary || '').trim();
  if (!summary) return c.json({ error: 'summary required' }, 400);

  const now = Date.now();
  let messageId: string | null = null;

  if (threadId) {
    const thread = await db.query.cosThreads.findFirst({
      where: eq(schema.cosThreads.id, threadId),
    });
    if (thread) {
      messageId = ulid();
      const text = `**Wiggum reflection** — ${summary}\n\nWant me to dispatch fixes? Open the Learnings pill to review.`;
      await db.insert(schema.cosMessages).values({
        id: messageId,
        threadId,
        role: 'system',
        text,
        toolCallsJson: null,
        createdAt: now,
      });
      await db.update(schema.cosThreads)
        .set({ updatedAt: now })
        .where(eq(schema.cosThreads.id, threadId));
    }
  }

  const announcement = JSON.stringify({ summary, threadId: threadId || null, at: now });
  const existing = await db.query.cosMetadata.findFirst({
    where: eq(schema.cosMetadata.key, 'wiggum.lastAnnouncement'),
  });
  if (existing) {
    await db.update(schema.cosMetadata)
      .set({ value: announcement })
      .where(eq(schema.cosMetadata.key, 'wiggum.lastAnnouncement'));
  } else {
    await db.insert(schema.cosMetadata).values({ key: 'wiggum.lastAnnouncement', value: announcement });
  }

  return c.json({ ok: true, messageId });
});

cosLearningsRoutes.get('/cos/learnings/announcement', async (c) => {
  const row = await db.query.cosMetadata.findFirst({
    where: eq(schema.cosMetadata.key, 'wiggum.lastAnnouncement'),
  });
  if (!row) return c.json({ announcement: null });
  try {
    return c.json({ announcement: JSON.parse(row.value) });
  } catch {
    return c.json({ announcement: null });
  }
});
