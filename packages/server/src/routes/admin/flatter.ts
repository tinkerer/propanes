import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db, schema } from '../../db/index.js';
import { dispatchAgentSession } from '../../dispatch.js';

export const flatterRoutes = new Hono();

const focusSchema = z.object({
  includeKeywords: z.array(z.string()).optional(),
  excludeKeywords: z.array(z.string()).optional(),
});

const monitorCreateSchema = z.object({
  name: z.string().min(1).max(200),
  repoUrl: z.string().url(),
  branch: z.string().min(1).max(200).default('main'),
  baselineRef: z.string().max(200).optional(),
  baselineDate: z.string().max(100).optional(),
  focus: focusSchema.optional(),
});

const itemUpdateSchema = z.object({
  status: z.enum(['proposed', 'accepted', 'skipped', 'in_progress', 'done']).optional(),
  category: z.enum(['critical', 'nice', 'skip']).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  operatorNotes: z.string().max(20000).optional(),
});

type FocusConfig = z.infer<typeof focusSchema>;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function monitorJson(row: typeof schema.flatterMonitors.$inferSelect) {
  return {
    ...row,
    focus: parseJson<FocusConfig>(row.focusJson, {}),
  };
}

function reportJson(row: typeof schema.flatterReports.$inferSelect) {
  return {
    ...row,
    stats: parseJson<Record<string, unknown>>(row.statsJson, {}),
  };
}

function itemJson(row: typeof schema.flatterItems.$inferSelect) {
  return {
    ...row,
    payload: parseJson<Record<string, unknown>>(row.payloadJson, {}),
  };
}

function runJson(row: typeof schema.flatterRuns.$inferSelect) {
  return {
    ...row,
    columns: parseJson<Array<Record<string, unknown>>>(row.columnsJson, []),
  };
}

function execGit(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function cloneDirForMonitor(id: string) {
  return join(tmpdir(), 'propanes-flatter', id);
}

function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : '';
}

function summarizeBaseline(monitor: ReturnType<typeof monitorJson>) {
  if (monitor.baselineRef) return `since ${monitor.baselineRef}`;
  if (monitor.baselineDate) return `since ${monitor.baselineDate.slice(0, 10)}`;
  if (monitor.lastHeadSha) return `since ${shortSha(monitor.lastHeadSha)}`;
  return 'latest upstream window';
}

function ensureSeedMonitor(appId: string) {
  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  if (!app) return;
  const isPropanesAdmin = app.name === 'Propanes Admin' || /\/propanes\/?$/.test(app.projectDir);
  if (!isPropanesAdmin) return;
  const existing = db.select().from(schema.flatterMonitors)
    .where(and(
      eq(schema.flatterMonitors.appId, appId),
      eq(schema.flatterMonitors.repoUrl, 'https://github.com/meawoppl/agent-portal'),
    ))
    .get();
  if (existing) return;
  const now = new Date().toISOString();
  db.insert(schema.flatterMonitors).values({
    id: ulid(),
    appId,
    name: 'agent-portal structured view',
    repoUrl: 'https://github.com/meawoppl/agent-portal',
    branch: 'main',
    baselineDate: '2026-04-19T20:03:39Z',
    focusJson: JSON.stringify({
      includeKeywords: ['structured', 'session', 'input', 'delivery', 'subagent', 'task', 'renderer', 'codex', 'turn'],
      excludeKeywords: ['port forwarding', 'forward', 'subdomain', 'proxy', 'oauth', 'admin users', 'ci:', 'docs:'],
    }),
    createdAt: now,
    updatedAt: now,
  }).run();
}

type CommitRecord = {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  body: string;
};

function loadCommits(monitor: ReturnType<typeof monitorJson>): { headSha: string; commits: CommitRecord[] } {
  const cloneDir = cloneDirForMonitor(monitor.id);
  mkdirSync(join(tmpdir(), 'propanes-flatter'), { recursive: true });
  if (!existsSync(cloneDir)) {
    execGit(`git clone --depth=200 ${JSON.stringify(monitor.repoUrl)} ${JSON.stringify(cloneDir)}`);
  }
  execGit(`git fetch --prune origin ${JSON.stringify(monitor.branch)}`, cloneDir);
  const headSha = execGit(`git rev-parse origin/${monitor.branch}`, cloneDir);
  const rangeArg = monitor.baselineRef
    ? `${monitor.baselineRef}..origin/${monitor.branch}`
    : `origin/${monitor.branch}`;
  const sinceArg = !monitor.baselineRef && monitor.baselineDate
    ? ` --since=${JSON.stringify(monitor.baselineDate)}`
    : '';
  const raw = execGit(
    `git log ${rangeArg}${sinceArg} --max-count=80 --pretty=format:%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1e`,
    cloneDir,
  );
  const commits = raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, short, date, subject, body = ''] = chunk.split('\x1f');
      return { sha, shortSha: short, date, subject, body };
    });
  return { headSha, commits };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function suggestScopeNotes(text: string): string {
  const notes: string[] = [];
  if (/input|delivery|outbox|accepted|serverreceived/.test(text)) {
    notes.push('Touches operator-to-session input reliability; scope against `SessionInputBar`, session websocket plumbing, and JSONL/session state reconciliation.');
  }
  if (/subagent|task|spawnagent|collabagent/.test(text)) {
    notes.push('Touches structured-view nesting; scope against `output-parser.ts`, `StructuredView.tsx`, and `MessageRenderer.tsx` subagent/task rendering.');
  }
  if (/renderer|turn|tool result|compaction/.test(text)) {
    notes.push('Likely parser/renderer work; scope against our Claude/Codex output classifiers before lifting UI details verbatim.');
  }
  if (/session rail|pill menu|scroll/.test(text)) {
    notes.push('Mostly session-list chrome; lower-value unless the current admin shows the same layout defect.');
  }
  if (notes.length === 0) notes.push('Review for shared session UX patterns, but validate against Propanes-specific data flow before porting.');
  return dedupe(notes).join(' ');
}

function analyzeCommit(monitor: ReturnType<typeof monitorJson>, commit: CommitRecord) {
  const text = `${commit.subject}\n${commit.body}`.toLowerCase();
  const subject = commit.subject.toLowerCase();
  const includeKeywords = (monitor.focus.includeKeywords || []).map((k) => k.toLowerCase());
  const excludeKeywords = (monitor.focus.excludeKeywords || []).map((k) => k.toLowerCase());
  const includeHits = includeKeywords.filter((k) => text.includes(k));
  const excludeHits = excludeKeywords.filter((k) => text.includes(k));

  const relevant = includeHits.length > 0 || /subagent|delivery|input|structured|renderer|task|codex|turn|tool result|compaction/.test(text);
  const hardSkip = excludeHits.length > 0
    || /port forwarding|forward-origin|subdomain|reverse proxy|tunnel protocol|oauth|proxy-side|session rail|pill menu|y-axis|performance line charts|timestamp-precision|db tests/.test(text);
  const fixLike = /(^fix:|\bfix\b|bug|restore|reliable|wedge|failed|failure|wrong|duplicate|clamp)/.test(text);
  const featureLike = /(^feat:|\badd\b|\bsupport\b|\brender\b|\bshow\b|\btyped\b|\bprogress\b|\brollup\b)/.test(text);
  const highRisk = /delivery|outbox|websocket|accepted|serverreceived|protocol/.test(text);
  const mediumRisk = /renderer|parser|subagent|task|turn/.test(text);
  const refactorOnly = /^refactor:|^cleanup:|^chore:/.test(subject) && !fixLike && !featureLike;

  let category: 'critical' | 'nice' | 'skip' = 'skip';
  if (relevant && fixLike && !hardSkip && !subject.startsWith('refactor:')) category = 'critical';
  else if (relevant && (featureLike || mediumRisk || refactorOnly) && !hardSkip) category = 'nice';
  else if (relevant && !hardSkip) category = 'nice';

  let relevance: 'high' | 'medium' | 'low' = relevant ? 'high' : 'low';
  if (relevant && includeHits.length < 2) relevance = 'medium';

  let risk: 'low' | 'medium' | 'high' = 'low';
  if (highRisk) risk = 'high';
  else if (mediumRisk) risk = 'medium';

  const rationale: string[] = [];
  if (includeHits.length) rationale.push(`Matched focus terms: ${includeHits.join(', ')}.`);
  if (excludeHits.length) rationale.push(`Out of scope terms: ${excludeHits.join(', ')}.`);
  if (refactorOnly) rationale.push('Mostly architecture cleanup; pull patterns, not code wholesale.');
  if (fixLike) rationale.push('Reads like a defect or reliability fix.');
  if (featureLike) rationale.push('Reads like a feature lift rather than a pure refactor.');
  if (!rationale.length) rationale.push('Weak match for the current Propanes structured-view scope.');

  return {
    category,
    relevance,
    risk,
    rationale: rationale.join(' '),
    scopeNotes: suggestScopeNotes(text),
  };
}

async function scanMonitor(appId: string, monitorId: string) {
  const app = db.select().from(schema.applications).where(eq(schema.applications.id, appId)).get();
  const monitorRow = db.select().from(schema.flatterMonitors).where(eq(schema.flatterMonitors.id, monitorId)).get();
  if (!app || !monitorRow || monitorRow.appId !== appId) throw new Error('Monitor not found');

  const monitor = monitorJson(monitorRow);
  const { headSha, commits } = loadCommits(monitor);
  const analyzed = commits
    .map((commit) => {
      const analysis = analyzeCommit(monitor, commit);
      return {
        commit,
        ...analysis,
        upstreamUrl: monitor.repoUrl.replace(/\.git$/, '').replace('github.com/', 'github.com/') + `/commit/${commit.sha}`,
      };
    })
    .filter((entry) => entry.category !== 'skip' || /port forwarding|proxy|session rail|pill menu|scroll/.test(`${entry.commit.subject} ${entry.commit.body}`.toLowerCase()))
    .sort((a, b) => {
      const score = (entry: typeof a) =>
        (entry.category === 'critical' ? 100 : entry.category === 'nice' ? 60 : 10)
        + (entry.relevance === 'high' ? 20 : entry.relevance === 'medium' ? 10 : 0)
        - (entry.risk === 'high' ? 5 : 0);
      return score(b) - score(a);
    })
    .slice(0, 16);

  const critical = analyzed.filter((entry) => entry.category === 'critical').length;
  const nice = analyzed.filter((entry) => entry.category === 'nice').length;
  const skip = analyzed.filter((entry) => entry.category === 'skip').length;
  const summary = [
    `${critical} critical fixes`,
    `${nice} nice-to-have lifts`,
    `${skip} explicit skips`,
  ].join(' · ');

  const now = new Date().toISOString();
  const reportId = ulid();
  db.insert(schema.flatterReports).values({
    id: reportId,
    appId,
    monitorId,
    title: `${monitor.name} ${summarizeBaseline(monitor)}`,
    upstreamHeadSha: headSha,
    baselineSummary: summarizeBaseline(monitor),
    summary,
    statsJson: JSON.stringify({
      commitCount: commits.length,
      critical,
      nice,
      skip,
    }),
    createdAt: now,
    updatedAt: now,
  }).run();

  for (const entry of analyzed) {
    db.insert(schema.flatterItems).values({
      id: ulid(),
      reportId,
      monitorId: monitor.id,
      appId,
      kind: 'commit',
      upstreamRef: entry.commit.sha,
      upstreamUrl: entry.upstreamUrl,
      title: entry.commit.subject,
      summary: entry.commit.body.split('\n').filter(Boolean).slice(0, 3).join(' '),
      category: entry.category,
      relevance: entry.relevance,
      risk: entry.risk,
      status: entry.category === 'skip' ? 'skipped' : 'proposed',
      rationale: entry.rationale,
      scopeNotes: entry.scopeNotes,
      payloadJson: JSON.stringify({
        shortSha: entry.commit.shortSha,
        date: entry.commit.date,
        baseline: summarizeBaseline(monitor),
      }),
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  db.update(schema.flatterMonitors).set({
    lastHeadSha: headSha,
    lastScannedAt: now,
    updatedAt: now,
  }).where(eq(schema.flatterMonitors.id, monitor.id)).run();
}

function pickAgents(appId: string) {
  const agents = db.select().from(schema.agentEndpoints).all()
    .filter((agent) => !agent.appId || agent.appId === appId);
  const pick = (predicates: Array<(agent: typeof agents[number]) => boolean>, used: Set<string>) => {
    for (const predicate of predicates) {
      const match = agents.find((agent) => !used.has(agent.id) && predicate(agent));
      if (match) {
        used.add(match.id);
        return match;
      }
    }
    const fallback = agents.find((agent) => !used.has(agent.id)) || agents[0] || null;
    if (fallback) used.add(fallback.id);
    return fallback;
  };
  const used = new Set<string>();
  return {
    implement: pick([
      (agent) => agent.runtime === 'codex' && !!agent.appId,
      (agent) => agent.runtime === 'codex',
      (agent) => !!agent.isDefault,
    ], used),
    review: pick([
      (agent) => agent.runtime === 'claude' && !!agent.appId,
      (agent) => agent.runtime === 'claude',
      (agent) => !!agent.isDefault,
    ], used),
    verify: pick([
      (agent) => !!agent.appId,
      (agent) => agent.runtime === 'claude' || agent.runtime === 'codex',
    ], used),
  };
}

async function launchRunForItem(itemId: string) {
  const itemRow = db.select().from(schema.flatterItems).where(eq(schema.flatterItems.id, itemId)).get();
  if (!itemRow) throw new Error('Item not found');
  const app = db.select().from(schema.applications).where(eq(schema.applications.id, itemRow.appId)).get();
  if (!app) throw new Error('App not found');
  const agents = pickAgents(app.id);
  if (!agents.implement || !agents.review || !agents.verify) {
    throw new Error('Need at least one agent endpoint configured for this app');
  }

  const item = itemJson(itemRow);
  const runId = ulid();
  const now = new Date().toISOString();
  const stages = [
    {
      key: 'implement',
      label: 'PR',
      agent: agents.implement,
      prompt: `You are the implementation lane in a Flatter upstream-sync run.\n\nApp: ${app.name}\nRepo: ${app.projectDir}\nUpstream item: ${item.title}\nCommit: ${item.upstreamRef || '(not set)'}\nCategory: ${item.category}\nRisk: ${item.risk}\nRationale: ${item.rationale}\nScope notes: ${item.scopeNotes}\nOperator notes: ${item.operatorNotes || '(none)'}\n\nImplement the relevant change for Propanes. Stay scoped. Run the most relevant local verification.`,
    },
    {
      key: 'review',
      label: 'Review',
      agent: agents.review,
      prompt: `You are the review lane in a Flatter upstream-sync run.\n\nApp: ${app.name}\nRepo: ${app.projectDir}\nUpstream item: ${item.title}\nCommit: ${item.upstreamRef || '(not set)'}\nCategory: ${item.category}\nRisk: ${item.risk}\nRationale: ${item.rationale}\nScope notes: ${item.scopeNotes}\nOperator notes: ${item.operatorNotes || '(none)'}\n\nReview the intended lift for risks, regressions, and missing tests. If the implementation lane has not landed yet, review the scope and likely blast radius.`,
    },
    {
      key: 'verify',
      label: 'Verify',
      agent: agents.verify,
      prompt: `You are the verification lane in a Flatter upstream-sync run.\n\nApp: ${app.name}\nRepo: ${app.projectDir}\nUpstream item: ${item.title}\nCommit: ${item.upstreamRef || '(not set)'}\nCategory: ${item.category}\nRisk: ${item.risk}\nRationale: ${item.rationale}\nScope notes: ${item.scopeNotes}\nOperator notes: ${item.operatorNotes || '(none)'}\n\nFocus on test execution, screenshots, and verification notes. Report precisely what passed, what failed, and what still needs operator judgment.`,
    },
  ];

  const columns: Array<Record<string, unknown>> = [];
  for (const stage of stages) {
    const feedbackId = ulid();
    db.insert(schema.feedbackItems).values({
      id: feedbackId,
      type: 'manual',
      status: 'dispatched',
      title: `[Flatter/${stage.label}] ${item.title}`,
      description: stage.prompt,
      appId: app.id,
      dispatchedTo: stage.agent?.name || null,
      dispatchedAt: now,
      dispatchStatus: 'running',
      createdAt: now,
      updatedAt: now,
    }).run();
    const { sessionId } = await dispatchAgentSession({
      feedbackId,
      agentEndpointId: stage.agent!.id,
      prompt: stage.prompt,
      cwd: app.projectDir,
      permissionProfile: (stage.agent!.permissionProfile || app.defaultPermissionProfile || 'interactive-require') as any,
      allowedTools: stage.agent!.allowedTools || app.defaultAllowedTools || null,
    });
    columns.push({
      key: stage.key,
      label: stage.label,
      feedbackId,
      sessionId,
      agentEndpointId: stage.agent!.id,
      agentName: stage.agent!.name,
    });
  }

  db.insert(schema.flatterRuns).values({
    id: runId,
    appId: app.id,
    itemId: item.id,
    label: item.title,
    status: 'running',
    columnsJson: JSON.stringify(columns),
    createdAt: now,
    updatedAt: now,
  }).run();
  db.update(schema.flatterItems).set({
    status: 'in_progress',
    updatedAt: now,
  }).where(eq(schema.flatterItems.id, item.id)).run();
}

function hydrateState(appId: string) {
  ensureSeedMonitor(appId);
  const monitors = db.select().from(schema.flatterMonitors)
    .where(eq(schema.flatterMonitors.appId, appId))
    .orderBy(desc(schema.flatterMonitors.updatedAt))
    .all()
    .map(monitorJson);
  const reports = db.select().from(schema.flatterReports)
    .where(eq(schema.flatterReports.appId, appId))
    .orderBy(desc(schema.flatterReports.createdAt))
    .all()
    .map(reportJson);
  const reportIds = reports.map((report) => report.id);
  const items = reportIds.length
    ? db.select().from(schema.flatterItems)
      .where(inArray(schema.flatterItems.reportId, reportIds))
      .orderBy(desc(schema.flatterItems.createdAt))
      .all()
      .map(itemJson)
    : [];
  const runs = db.select().from(schema.flatterRuns)
    .where(eq(schema.flatterRuns.appId, appId))
    .orderBy(desc(schema.flatterRuns.createdAt))
    .all()
    .map(runJson);

  const sessionIds = dedupe(runs.flatMap((run) => run.columns.map((column) => String(column.sessionId || '')).filter(Boolean)));
  const sessionMap = sessionIds.length
    ? new Map(
      db.select().from(schema.agentSessions)
        .where(inArray(schema.agentSessions.id, sessionIds))
        .all()
        .map((session) => [session.id, session]),
    )
    : new Map<string, typeof schema.agentSessions.$inferSelect>();

  const hydratedRuns = runs.map((run) => {
    const columns = run.columns.map((column) => {
      const sessionId = typeof column.sessionId === 'string' ? column.sessionId : '';
      const session = sessionMap.get(sessionId);
      return {
        ...column,
        sessionStatus: session?.status || 'pending',
      };
    });
    const statuses = columns.map((column) => String(column.sessionStatus || 'pending'));
    const status = statuses.every((value) => value === 'completed') ? 'completed'
      : statuses.some((value) => value === 'failed') ? 'failed'
      : statuses.some((value) => value === 'running' || value === 'pending') ? 'running'
      : run.status;
    return { ...run, status, columns };
  });

  return {
    monitors,
    reports,
    items,
    runs: hydratedRuns,
  };
}

flatterRoutes.get('/flatter/apps/:appId', (c) => {
  const appId = c.req.param('appId');
  return c.json(hydrateState(appId));
});

flatterRoutes.post('/flatter/apps/:appId/monitors', async (c) => {
  const appId = c.req.param('appId');
  const parsed = monitorCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = new Date().toISOString();
  db.insert(schema.flatterMonitors).values({
    id: ulid(),
    appId,
    name: parsed.data.name,
    repoUrl: parsed.data.repoUrl,
    branch: parsed.data.branch,
    baselineRef: parsed.data.baselineRef || null,
    baselineDate: parsed.data.baselineDate || null,
    focusJson: JSON.stringify(parsed.data.focus || {}),
    createdAt: now,
    updatedAt: now,
  }).run();
  return c.json(hydrateState(appId));
});

flatterRoutes.post('/flatter/monitors/:monitorId/scan', async (c) => {
  const monitorId = c.req.param('monitorId');
  const monitor = db.select().from(schema.flatterMonitors).where(eq(schema.flatterMonitors.id, monitorId)).get();
  if (!monitor) return c.json({ error: 'Monitor not found' }, 404);
  try {
    await scanMonitor(monitor.appId, monitorId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Scan failed' }, 500);
  }
  return c.json(hydrateState(monitor.appId));
});

flatterRoutes.patch('/flatter/items/:itemId', async (c) => {
  const itemId = c.req.param('itemId');
  const item = db.select().from(schema.flatterItems).where(eq(schema.flatterItems.id, itemId)).get();
  if (!item) return c.json({ error: 'Item not found' }, 404);
  const parsed = itemUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  db.update(schema.flatterItems).set({
    ...parsed.data,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.flatterItems.id, itemId)).run();
  return c.json(hydrateState(item.appId));
});

flatterRoutes.post('/flatter/items/:itemId/launch', async (c) => {
  const itemId = c.req.param('itemId');
  const item = db.select().from(schema.flatterItems).where(eq(schema.flatterItems.id, itemId)).get();
  if (!item) return c.json({ error: 'Item not found' }, 404);
  try {
    await launchRunForItem(itemId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Launch failed' }, 500);
  }
  return c.json(hydrateState(item.appId));
});
