import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import {
  computeJsonlPath as computeClaudeJsonlPath,
  computeCodexJsonlPath,
  findContinuationJsonlsCached,
  readJsonlWithSubagents,
} from '../jsonl-utils.js';

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

function specWikiDir(projectDir: string, appId: string): string {
  return join(projectDir, 'docs', 'spec-wiki', appId);
}

function legacySpecWikiDir(projectDir: string): string {
  return join(projectDir, 'docs', 'spec-wiki');
}

function selectSpecAgent(appId: string, opts: { preferYolo?: boolean } = {}) {
  const agents = db.select().from(schema.agentEndpoints).all();
  const usable = agents.filter((agent) => agent.mode !== 'webhook' || !!agent.url);

  if (opts.preferYolo) {
    const isYolo = (a: typeof usable[number]) =>
      typeof a.permissionProfile === 'string' && a.permissionProfile.endsWith('-yolo');
    for (const profile of ['interactive-yolo', 'headless-yolo', 'headless-stream-yolo'] as const) {
      const match = (a: typeof usable[number]) => a.permissionProfile === profile;
      const hit =
        usable.find((a) => match(a) && a.isDefault && a.appId === appId) ||
        usable.find((a) => match(a) && a.appId === appId) ||
        usable.find((a) => match(a) && a.isDefault && !a.appId) ||
        usable.find(match);
      if (hit) return hit;
    }
    const anyYolo = usable.find(isYolo);
    if (anyYolo) return anyYolo;
  }

  return (
    usable.find((agent) => agent.isDefault && agent.appId === appId) ||
    usable.find((agent) => agent.appId === appId) ||
    usable.find((agent) => agent.isDefault && !agent.appId) ||
    usable[0] ||
    null
  );
}

function buildSpecUpdatePrompt(
  app: typeof schema.applications.$inferSelect,
  wikiDir: string,
  additionalInstructions?: string | null,
): string {
  const base = [
    `Create or update the spec wiki for application ${app.name} (${app.id}).`,
    '',
    'Goal: turn tickets, CoS thread inputs, and agent JSONL histories into a spec-driven development wiki.',
    '',
    'Write the wiki under this per-application directory:',
    `- ${wikiDir}`,
    '',
    'Required files:',
    '- index.md: landing/index page with links to the other pages and a concise current snapshot.',
    '- spec-backbone.md: durable product intent, constraints, architecture decisions, active themes, and development contract.',
    '- tickets.md: ticket beads consumed, grouped by theme with ticket IDs.',
    '- operator-inputs.md: relevant CoS/user inputs and the product intent they imply.',
    '- agent-jsonl-inputs.md: summarized prompts/inputs from agent JSONL histories that led to the current project state.',
    '',
    'Sources to inspect:',
    `- SQLite DB in this repo for feedback_items where app_id = ${app.id}.`,
    `- cos_threads and cos_messages for app_id = ${app.id}.`,
    '- agent_sessions linked to those tickets, and sessions whose cwd matches the app project directory.',
    `- Claude JSONL histories under ~/.claude/projects for projectDir ${app.projectDir}.`,
    '- Codex rollout histories under ~/.codex/sessions when sessions use runtime=codex.',
    '',
    'Implementation notes:',
    '- Make the wiki useful as the backbone for future spec-driven tickets, not just a dump.',
    '- Deduplicate repeated requests. Preserve concrete IDs and paths where they matter.',
    '- Keep each file readable; summarize long JSONL histories instead of pasting raw logs.',
    '- Do not write outside the per-application spec wiki directory except if you need temporary scratch notes.',
    '- When complete, report the files written and the major spec themes you extracted.',
  ];
  const extra = (additionalInstructions || '').trim();
  if (extra) {
    base.push('', '## Additional direction from operator', '', extra);
  }
  return base.join('\n');
}

function escapeMd(text: string | null | undefined): string {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function truncateText(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 24).trimEnd() + '\n\n[truncated]';
}

function extractJsonlUserText(line: string): string | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }

  const candidates = [
    obj?.message,
    obj?.payload?.message,
    obj?.item,
    obj?.payload?.item,
    obj,
  ];

  for (const candidate of candidates) {
    if (!candidate || candidate.role !== 'user') continue;
    const content = candidate.content;
    if (typeof content === 'string') return content.trim() || null;
    if (Array.isArray(content)) {
      const parts = content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.content === 'string') return part.content;
          return '';
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join('\n').trim() || null;
    }
  }

  const text = obj?.payload?.text || obj?.text;
  if ((obj?.type === 'user_message' || obj?.type === 'user_input') && typeof text === 'string') {
    return text.trim() || null;
  }
  return null;
}

function resolveSessionJsonlPath(row: {
  projectDir: string | null;
  cwd: string | null;
  claudeSessionId: string | null;
  runtime: string | null;
  startedAt: string | null;
}): string | null {
  if (row.runtime === 'codex') {
    return computeCodexJsonlPath(row.cwd, row.claudeSessionId, row.startedAt);
  }
  const primary = row.claudeSessionId ? computeClaudeJsonlPath(row.projectDir || process.cwd(), row.claudeSessionId) : null;
  if (primary && existsSync(primary)) return primary;
  if (row.cwd && row.cwd !== (row.projectDir || process.cwd()) && row.claudeSessionId) {
    const fallback = computeClaudeJsonlPath(row.cwd, row.claudeSessionId);
    if (existsSync(fallback)) return fallback;
  }
  return primary;
}

function collectSessionInputs(sessionRows: Array<{
  id: string;
  title: string | null;
  feedbackId: string | null;
  runtime: string | null;
  claudeSessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
  projectDir: string | null;
}>): { sections: string[]; inputCount: number; jsonlCount: number } {
  const sections: string[] = [];
  let inputCount = 0;
  let jsonlCount = 0;

  for (const session of sessionRows) {
    const jsonlPath = resolveSessionJsonlPath(session);
    if (!jsonlPath || !existsSync(jsonlPath)) continue;
    const lines: string[] = [];
    if (session.runtime === 'codex') {
      const raw = readFileSync(jsonlPath, 'utf-8');
      lines.push(...raw.split('\n').filter((line) => line.trim()));
    } else {
      const jsonlFiles = [jsonlPath, ...findContinuationJsonlsCached(jsonlPath)];
      for (const filePath of jsonlFiles) readJsonlWithSubagents(filePath, lines);
    }

    const inputs = lines.map(extractJsonlUserText).filter((v): v is string => !!v);
    if (inputs.length === 0) continue;
    jsonlCount++;
    inputCount += inputs.length;
    sections.push([
      `## Session ${session.id}`,
      session.title ? `Title: ${session.title}` : '',
      session.feedbackId ? `Feedback: ${session.feedbackId}` : '',
      `Runtime: ${session.runtime || 'claude'}`,
      `JSONL: \`${jsonlPath}\``,
      '',
      ...inputs.slice(0, 20).map((input, idx) => `### User input ${idx + 1}\n\n${truncateText(escapeMd(input), 2500)}`),
      inputs.length > 20 ? `\n_${inputs.length - 20} additional inputs omitted from this generated view._` : '',
    ].filter(Boolean).join('\n'));
  }

  return { sections, inputCount, jsonlCount };
}

aggregateRoutes.post('/spec/update', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const appId = String(body.appId || '');
  if (!appId) return c.json({ error: 'appId is required' }, 400);

  const additionalInstructions = typeof body.additionalInstructions === 'string'
    ? body.additionalInstructions
    : '';
  const preferYolo = body.preferYolo !== false; // default to YOLO

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  if (!app) return c.json({ error: 'Application not found' }, 404);

  if (body.mode !== 'generate-now') {
    const agent = selectSpecAgent(app.id, { preferYolo });
    if (!agent) return c.json({ error: 'No agent endpoint configured' }, 400);

    const now = new Date().toISOString();
    const wikiDir = specWikiDir(app.projectDir, app.id);
    const feedbackId = ulid();
    const prompt = buildSpecUpdatePrompt(app, wikiDir, additionalInstructions);

    db.insert(schema.feedbackItems).values({
      id: feedbackId,
      type: 'programmatic',
      status: 'dispatched',
      title: `Update Spec Wiki — ${app.name}`,
      description: `Generate the per-application spec wiki at ${wikiDir} from tickets, CoS inputs, and JSONL histories.`,
      appId: app.id,
      createdAt: now,
      updatedAt: now,
    }).run();

    const permissionProfile = (agent.permissionProfile || app.defaultPermissionProfile || 'interactive-require') as PermissionProfile;
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId: agent.id,
      prompt,
      cwd: app.projectDir || process.cwd(),
      runtime: (agent.runtime || 'claude') as any,
      permissionProfile,
      allowedTools: agent.allowedTools || app.defaultAllowedTools || null,
      launcherId: agent.preferredLauncherId || undefined,
    });

    db.update(schema.feedbackItems).set({
      dispatchedTo: agent.name,
      dispatchedAt: now,
      dispatchStatus: 'running',
      dispatchResponse: `Spec update session: ${sessionId}`,
      updatedAt: now,
    }).where(eq(schema.feedbackItems.id, feedbackId)).run();

    return c.json({
      ok: true,
      mode: 'session',
      sessionId,
      feedbackId,
      agentEndpointId: agent.id,
      agentName: agent.name,
      wikiDir,
      indexPath: join(wikiDir, 'index.md'),
      updatedAt: now,
    });
  }

  const now = new Date().toISOString();
  const wikiDir = specWikiDir(app.projectDir, app.id);
  mkdirSync(wikiDir, { recursive: true });

  const tickets = sqlite.prepare(`
    SELECT id, title, description, type, status, created_at, updated_at
    FROM feedback_items
    WHERE app_id = ?
    ORDER BY created_at ASC
  `).all(appId) as Array<{ id: string; title: string; description: string; type: string; status: string; created_at: string; updated_at: string }>;

  const cosMessages = sqlite.prepare(`
    SELECT t.id as thread_id, t.name as thread_name, m.role, m.text, m.created_at
    FROM cos_threads t
    JOIN cos_messages m ON m.thread_id = t.id
    WHERE t.app_id = ? AND m.role = 'user'
    ORDER BY m.created_at ASC
  `).all(appId) as Array<{ thread_id: string; thread_name: string; role: string; text: string; created_at: number }>;

  const sessionRows = sqlite.prepare(`
    SELECT s.id, s.title, s.feedback_id as feedbackId, s.runtime, s.claude_session_id as claudeSessionId,
           s.cwd, s.started_at as startedAt, a.project_dir as projectDir
    FROM agent_sessions s
    LEFT JOIN feedback_items fi ON fi.id = s.feedback_id
    LEFT JOIN applications a ON a.id = coalesce(fi.app_id, ?)
    WHERE fi.app_id = ? OR s.cwd = ?
    ORDER BY s.created_at ASC
    LIMIT 300
  `).all(appId, appId, app.projectDir) as Array<{
    id: string;
    title: string | null;
    feedbackId: string | null;
    runtime: string | null;
    claudeSessionId: string | null;
    cwd: string | null;
    startedAt: string | null;
    projectDir: string | null;
  }>;

  const clusters = clusterItems(tickets.map((ticket) => ({
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    type: ticket.type,
    status: ticket.status,
    created_at: ticket.created_at,
  })), 2);
  const sessionInputs = collectSessionInputs(sessionRows);

  const ticketMd = [
    '# Ticket Beads',
    '',
    `Generated: ${now}`,
    `Ticket count: ${tickets.length}`,
    '',
    ...tickets.map((ticket) => [
      `## ${ticket.title}`,
      '',
      `- ID: \`${ticket.id}\``,
      `- Type: ${ticket.type}`,
      `- Status: ${ticket.status}`,
      `- Created: ${ticket.created_at}`,
      `- Updated: ${ticket.updated_at}`,
      '',
      escapeMd(ticket.description) || '_No description._',
    ].join('\n')),
  ].join('\n');

  const threadMd = [
    '# Operator Inputs',
    '',
    `Generated: ${now}`,
    `CoS user message count: ${cosMessages.length}`,
    '',
    ...cosMessages.map((message) => [
      `## ${message.thread_name || message.thread_id}`,
      '',
      `- Thread: \`${message.thread_id}\``,
      `- Created: ${new Date(message.created_at).toISOString()}`,
      '',
      truncateText(escapeMd(message.text), 2500),
    ].join('\n')),
  ].join('\n');

  const agentMd = [
    '# Agent JSONL Inputs',
    '',
    `Generated: ${now}`,
    `Sessions with JSONL inputs: ${sessionInputs.jsonlCount}`,
    `Extracted user input count: ${sessionInputs.inputCount}`,
    '',
    sessionInputs.sections.join('\n\n') || '_No JSONL user inputs were found for this app._',
  ].join('\n');

  const architectureMd = [
    '# Spec Backbone',
    '',
    `Generated: ${now}`,
    '',
    '## Product Intent',
    '',
    escapeMd(app.description) || `${app.name} is tracked by Propanes as an application with ticket, thread, and agent-session history.`,
    '',
    '## Active Themes',
    '',
    ...(clusters.length > 0
      ? clusters.map((cluster) => `- ${cluster.sampleTitle} (${cluster.items.length} tickets): ${cluster.items.map((item) => `\`${item.id}\``).join(', ')}`)
      : ['- No repeated ticket clusters found yet.']),
    '',
    '## Development Contract',
    '',
    '- Treat tickets and CoS inputs as beads: small observations that should resolve against this spec wiki.',
    '- Before dispatching implementation work, check this wiki for current intent, active themes, and prior agent prompts.',
    '- Update this wiki when tickets or agent runs materially change product behavior.',
  ].join('\n');

  const indexMd = [
    `# ${app.name} Spec Wiki`,
    '',
    `Generated: ${now}`,
    '',
    'This wiki aggregates tickets, CoS thread inputs, and agent JSONL user prompts into a spec-driven backbone for future work.',
    '',
    '## Pages',
    '',
    '- [Spec Backbone](spec-backbone.md)',
    '- [Ticket Beads](tickets.md)',
    '- [Operator Inputs](operator-inputs.md)',
    '- [Agent JSONL Inputs](agent-jsonl-inputs.md)',
    '',
    '## Current Snapshot',
    '',
    `- Tickets consumed: ${tickets.length}`,
    `- CoS user messages consumed: ${cosMessages.length}`,
    `- Agent sessions scanned: ${sessionRows.length}`,
    `- JSONL files with user inputs: ${sessionInputs.jsonlCount}`,
    `- JSONL user inputs extracted: ${sessionInputs.inputCount}`,
    `- Repeated ticket themes: ${clusters.length}`,
    '',
    '## Top Themes',
    '',
    ...(clusters.slice(0, 12).map((cluster) => `- ${cluster.sampleTitle} (${cluster.items.length})`) || []),
    clusters.length === 0 ? '- No repeated ticket themes found yet.' : '',
  ].filter(Boolean).join('\n');

  const files = {
    'index.md': indexMd,
    'spec-backbone.md': architectureMd,
    'tickets.md': ticketMd,
    'operator-inputs.md': threadMd,
    'agent-jsonl-inputs.md': agentMd,
  };

  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(wikiDir, file), content.endsWith('\n') ? content : content + '\n', 'utf-8');
  }

  return c.json({
    ok: true,
    wikiDir,
    indexPath: join(wikiDir, 'index.md'),
    files: Object.keys(files),
    ticketCount: tickets.length,
    cosMessageCount: cosMessages.length,
    sessionCount: sessionRows.length,
    jsonlFileCount: sessionInputs.jsonlCount,
    jsonlInputCount: sessionInputs.inputCount,
    themeCount: clusters.length,
    updatedAt: now,
  });
});

aggregateRoutes.get('/spec', async (c) => {
  const appId = c.req.query('appId');
  const file = c.req.query('file') || 'index.md';
  if (!appId) return c.json({ error: 'appId is required' }, 400);
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(file)) return c.json({ error: 'Invalid spec file' }, 400);

  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  if (!app) return c.json({ error: 'Application not found' }, 404);

  const wikiDir = specWikiDir(app.projectDir, app.id);
  const legacyDir = legacySpecWikiDir(app.projectDir);
  const filePath = join(wikiDir, file);
  const legacyPath = join(legacyDir, file);
  if (!existsSync(filePath)) {
    if (!existsSync(legacyPath)) {
      return c.json({ exists: false, wikiDir, file, content: '', files: [] });
    }
    const legacyFiles = ['index.md', 'spec-backbone.md', 'tickets.md', 'operator-inputs.md', 'agent-jsonl-inputs.md']
      .filter((name) => existsSync(join(legacyDir, name)));
    return c.json({
      exists: true,
      wikiDir: legacyDir,
      file,
      files: legacyFiles,
      content: readFileSync(legacyPath, 'utf-8'),
      legacy: true,
    });
  }

  const files = ['index.md', 'spec-backbone.md', 'tickets.md', 'operator-inputs.md', 'agent-jsonl-inputs.md']
    .filter((name) => existsSync(join(wikiDir, name)));
  return c.json({
    exists: true,
    wikiDir,
    file,
    files,
    content: readFileSync(filePath, 'utf-8'),
  });
});

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
  const permissionProfile = (agent.permissionProfile || 'interactive-require') as PermissionProfile;

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
  const permissionProfile = (agent.permissionProfile || 'interactive-require') as PermissionProfile;

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
