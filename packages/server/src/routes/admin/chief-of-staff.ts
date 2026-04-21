import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';
import { findRecentProjectJsonl } from '../../jsonl-scan.js';

export const chiefOfStaffRoutes = new Hono();

const DEFAULT_SYSTEM_PROMPT = `You are Ops, a sharp operations assistant embedded in the ProPanes admin dashboard. You're direct, practical, and a little dry — you cut to what matters fast and don't pad answers. You know this system cold: feedback queues, agent sessions, infra health.

You help the operator stay on top of:
- Feedback items coming in from apps (bugs, feature requests)
- In-flight agent sessions (Claude/Codex processes working on feedback)
- Connected infrastructure (machines, launchers, harnesses)

The project's CLAUDE.md documents the REST API at http://localhost:3001. Use Bash + curl to answer:
- GET /api/v1/admin/feedback[?status=...&appId=...&limit=...] — feedback inventory
- GET /api/v1/admin/agent-sessions[?feedbackId=...] — agent sessions (include output tails)
- GET /api/v1/admin/applications — registered apps with IDs + projectDirs
- GET /api/v1/admin/machines, /api/v1/launchers, /api/v1/admin/harness-configs — infrastructure
- GET /api/v1/admin/aggregate[?appId=...&minCount=N] — clustered feedback
Pipe through \`python3 -m json.tool\` when output is dense; use \`jq\` if you prefer.

To dispatch an agent to a feedback item, POST to /api/v1/admin/feedback/:id/dispatch with { agentEndpointId, instructions? }. Dispatch when the operator's intent is clearly to act — "fix X", "rerun Y", "restart those bailouts", "take care of it", "go ahead" are dispatch requests; act on them without a second round of confirmation. Only pause to confirm when the request is genuinely ambiguous or would fan out 5+ sessions at once. When you dispatch, report the resulting sessionId as "launched <id>".

Bail-out detection (encode, don't re-derive): a session is almost certainly a silent crash when status=completed, exitCode=0, outputBytes<5000, and (completedAt - startedAt) < 2s. When the operator asks to find, rerun, or clean up bailed/crashed sessions, filter by this heuristic, then re-dispatch the same feedbackId with the same agentEndpointId that originally ran.

Style: terse. Short bullet lists. Surface IDs. Flag anything stuck (sessions running hours without output, offline launchers, feedback queued but not dispatched, bailouts matching the heuristic above). Never invent IDs — always curl to look them up. Keep answers under 10 lines unless the operator asks for detail. Don't say "ok" or narrate tool calls — just report results. Don't cop out: if the operator told you to act, act — don't reply asking whether they meant it.`;

type Verbosity = 'terse' | 'normal' | 'verbose';
type ReplyStyle = 'dry' | 'neutral' | 'friendly';

const VERBOSITY_GUIDE: Record<Verbosity, string> = {
  terse: '1-3 short lines max, bullets preferred, no preamble, no exposition, no restating the question.',
  normal: 'A short paragraph or a few bullets. Answer the question and stop.',
  verbose: 'Include useful context, caveats, and a suggested follow-up where relevant. Still avoid filler.',
};

const STYLE_GUIDE: Record<ReplyStyle, string> = {
  dry: 'Matter-of-fact. No emojis, pleasantries, apologies, or softening hedges.',
  neutral: 'Plain professional. No emojis.',
  friendly: 'Warm and conversational. Light pleasantries are fine; still concise.',
};

function structuredReplyInstructions(verbosity: Verbosity, style: ReplyStyle): string {
  return `## Structured reply protocol

Wrap the text the user should see in a single \`<cos-reply>...</cos-reply>\` XML tag. All reasoning, planning, tool-use narration, and scratch work stays OUTSIDE the tag — only the finished user-facing reply goes inside.

Rules:
- Exactly one \`<cos-reply>\` per turn. Emit it after you've done your tool calls and know the answer.
- Never wrap the tag in code fences or quote the literal tag name as an example.
- If your reply itself needs to contain angle brackets, prefer code fences inside the tag.
- Do not put the tag inside a tool_use input.

Inside the tag, style the reply as:
- Verbosity (${verbosity}): ${VERBOSITY_GUIDE[verbosity]}
- Tone (${style}): ${STYLE_GUIDE[style]}

Anything you emit outside the tag is treated as hidden scratch work and will not be shown to the user.`;
}

const COORDINATION_INSTRUCTIONS = `## Coordinating with concurrent Chief-of-Staff sessions

Multiple CoS sessions may run in parallel. Before doing work that could conflict with another active session (editing the same file, running the same long command, mutating the same DB row), claim an advisory lock:

- POST /api/v1/admin/chief-of-staff/lock  body: {"requestId":"<yours>","key":"<namespace:resource>"}
  - {"granted":true} — you hold it; proceed.
  - {"granted":false,"heldBy":"<otherRequestId>","heldSince":<ts>} — another session holds it. Either wait and retry, or work on something non-conflicting.
- DELETE /api/v1/admin/chief-of-staff/lock/<yourRequestId>/<key>  — release when done.
- GET  /api/v1/admin/chief-of-staff/sessions — inspect all active sessions (text, startedAt, lockKeys).

Key conventions: "file:<repo-relative-path>", "feedback:<id>", "session:<id>", "dispatch:<feedbackId>". Locks are best-effort; if the other session's intent (its text) overlaps yours, wait or coordinate in your reply before writing.`;

// ────────────────────────────────────────────────────────────────────────────
// Wiggum self-reflection
// ────────────────────────────────────────────────────────────────────────────

const WIGGUM_PROJECT_DIR = pathResolve(homedir(), '.claude', 'projects', '-home-azureuser-propanes');
const WIGGUM_LAST_REFLECTED_KEY = 'wiggum.lastReflectedAt';

// Single-flight gate so multiple concurrent CoS sessions closing within the
// same window only spawn one reflection pass.
let wiggumInFlight = false;

function wiggumPrompt(jsonlPaths: string[], serverPort: number, selfSessionId: string): string {
  return `You are Wiggum, an embedded self-reflection agent for the ProPanes Chief-of-Staff. Your job is to scan recently completed CoS Claude Code sessions and extract concrete learnings so future runs avoid repeating mistakes.

## Self-reference guard

Your own Claude session id is \`${selfSessionId}\`. The corresponding JSONL
(\`~/.claude/projects/-home-azureuser-propanes/${selfSessionId}.jsonl\`) has
already been filtered out of the file list below. If you enumerate that
directory yourself (e.g. via \`ls\`/\`find\`), ALWAYS exclude \`${selfSessionId}.jsonl\`
— never read it, never treat it as "another running instance". Bailing on
self-discovery is a known pitfall; don't repeat it.

## What to look for

Read these JSONL transcript files (each line is one event from a Claude Code session). They are sorted oldest → newest:

${jsonlPaths.map((p) => `- ${p}`).join('\n')}

Identify, with specific evidence:

1. **Pitfalls** (\`type: "pitfall"\`) — things that went wrong:
   - Dispatch path confusion (CoS calling the wrong endpoint, wrong agent, malformed body)
   - Retry loops (same tool call repeated >3x with same args)
   - Memory-rule bypass failures (CoS edited code/files directly when the dispatch-only rule applied)
   - Sessions that aborted because a sub-agent misidentified itself as the Chief of Staff
   - Sub-agent blobs with no visibility (Task/agent calls whose output is opaque to the operator)

2. **Suggestions** (\`type: "suggestion"\`) — concrete improvements: prompt tweaks, route additions, UI affordances.

3. **Tool gaps** (\`type: "tool_gap"\`) — moments the agent had to do something awkwardly because a primitive was missing.

For each, assign \`severity\`: \`low\` | \`medium\` | \`high\`. High = recurring or user-visible failure.

## How to file findings

POST each batch (or one-shot) to:

  POST http://localhost:${serverPort}/api/v1/admin/cos/learnings
  Content-Type: application/json
  Body: { "learnings": [ { "sessionJsonl": "<path>", "type": "pitfall|suggestion|tool_gap", "title": "<≤80 char>", "body": "<evidence + suggestion>", "severity": "low|medium|high" } ] }

Then post a summary message back to the most-recently-updated CoS thread. Find it with:

  curl -s 'http://localhost:${serverPort}/api/v1/admin/chief-of-staff/threads?limit=1' | python3 -c "import sys,json; print(json.load(sys.stdin)['threads'][0]['id'])"

Insert a system-role message via:

  POST http://localhost:${serverPort}/api/v1/admin/cos/learnings/announce
  Body: { "threadId": "<id>", "summary": "<short summary: N pitfalls, M suggestions, K tool gaps. Top issue: ...>" }

## Constraints

- Be terse. Each learning's title ≤80 chars; body ≤400 chars with the evidence (file:line or quoted snippet).
- Skip duplicates: if you've seen the same issue across multiple sessions, file ONE learning with sessionJsonl=<most-recent>.
- Cap output at 20 learnings total — surface the most important.
- Do NOT edit code or dispatch agents. You are read-only except for the learnings + announce endpoints.
- If there's nothing notable, POST an empty learnings array and skip the announce.`;
}

async function getLastReflectedAt(): Promise<number> {
  const row = await db.query.cosMetadata.findFirst({
    where: eq(schema.cosMetadata.key, WIGGUM_LAST_REFLECTED_KEY),
  });
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}

async function setLastReflectedAt(ts: number): Promise<void> {
  const existing = await db.query.cosMetadata.findFirst({
    where: eq(schema.cosMetadata.key, WIGGUM_LAST_REFLECTED_KEY),
  });
  if (existing) {
    await db.update(schema.cosMetadata)
      .set({ value: String(ts) })
      .where(eq(schema.cosMetadata.key, WIGGUM_LAST_REFLECTED_KEY));
  } else {
    await db.insert(schema.cosMetadata).values({ key: WIGGUM_LAST_REFLECTED_KEY, value: String(ts) });
  }
}

function spawnWiggumReflection(serverPort: number): void {
  if (wiggumInFlight) return;
  wiggumInFlight = true;

  void (async () => {
    try {
      // Generate Wiggum's session id up front so we can exclude its own
      // eventual JSONL from the scan — the same UUID becomes the basename
      // of ~/.claude/projects/.../<wiggumSessionId>.jsonl once claude starts
      // writing. Without this guard, a retrospective scan can pick up the
      // in-flight file and Wiggum bails thinking another instance is running.
      const wiggumSessionId = randomUUID();
      const since = await getLastReflectedAt();
      const jsonlPaths = await findRecentProjectJsonl(
        WIGGUM_PROJECT_DIR,
        since,
        wiggumSessionId,
      );
      if (jsonlPaths.length === 0) {
        wiggumInFlight = false;
        return;
      }

      const cwd = resolveRepoRoot();
      const bin = process.env.CLAUDE_BIN || 'claude';
      const prompt = wiggumPrompt(jsonlPaths, serverPort, wiggumSessionId);
      const args = [
        '-p', prompt,
        '--dangerously-skip-permissions',
        '--session-id', wiggumSessionId,
      ];

      const proc = spawn(bin, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      proc.stdout?.on('data', () => { /* drain */ });
      proc.stderr?.on('data', () => { /* drain */ });
      proc.on('close', () => {
        // Update watermark to "now" only on a clean run; on failure we'll
        // retry the same window next close.
        void setLastReflectedAt(Date.now()).catch(() => { /* non-fatal */ });
        wiggumInFlight = false;
      });
      proc.on('error', () => {
        wiggumInFlight = false;
      });
    } catch {
      wiggumInFlight = false;
    }
  })();
}

function resolveRepoRoot(): string {
  const envDir = process.env.CHIEF_OF_STAFF_CWD;
  if (envDir && existsSync(envDir)) return pathResolve(envDir);
  // Default: assume server runs from packages/server; repo root is two levels up.
  const guess = pathResolve(process.cwd(), '..', '..');
  if (existsSync(pathResolve(guess, 'CLAUDE.md'))) return guess;
  return pathResolve(process.cwd());
}

type ActiveSession = {
  requestId: string;
  sessionId: string;
  text: string;
  startedAt: number;
  lockKeys: Set<string>;
};

const activeSessions = new Map<string, ActiveSession>();
const locks = new Map<string, { owner: string; since: number }>();

// Track in-flight processes by threadId so they can be interrupted
type InFlightEntry = { proc: ReturnType<typeof spawn> };
const inFlightByThread = new Map<string, InFlightEntry>();

function serializeSession(s: ActiveSession) {
  return {
    requestId: s.requestId,
    sessionId: s.sessionId,
    text: s.text,
    startedAt: s.startedAt,
    lockKeys: Array.from(s.lockKeys),
  };
}

function releaseAllLocks(requestId: string): void {
  const session = activeSessions.get(requestId);
  if (session) {
    for (const key of session.lockKeys) {
      const held = locks.get(key);
      if (held && held.owner === requestId) locks.delete(key);
    }
    session.lockKeys.clear();
  }
  // Also sweep in case of drift
  for (const [key, held] of locks) {
    if (held.owner === requestId) locks.delete(key);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Thread CRUD routes
// ────────────────────────────────────────────────────────────────────────────

chiefOfStaffRoutes.get('/chief-of-staff/threads', async (c) => {
  const agentId = c.req.query('agentId');
  const appId = c.req.query('appId');

  const conditions = [];
  if (agentId) conditions.push(eq(schema.cosThreads.agentId, agentId));
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));

  const rows = await db
    .select()
    .from(schema.cosThreads)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.cosThreads.updatedAt))
    .limit(100);

  return c.json({ threads: rows });
});

chiefOfStaffRoutes.post('/chief-of-staff/threads', async (c) => {
  let body: { agentId?: string; appId?: string; name?: string; systemPrompt?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const agentId = (body.agentId || '').trim();
  const name = (body.name || '').trim();
  if (!agentId || !name) return c.json({ error: 'agentId and name are required' }, 400);

  const now = Date.now();
  const id = ulid();
  const thread = {
    id,
    agentId,
    appId: body.appId || null,
    name,
    systemPrompt: body.systemPrompt || null,
    model: body.model || null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(schema.cosThreads).values(thread);
  return c.json(thread);
});

chiefOfStaffRoutes.delete('/chief-of-staff/threads/:id', async (c) => {
  const id = c.req.param('id');
  // Cascade deletes messages due to FK
  await db.delete(schema.cosThreads).where(eq(schema.cosThreads.id, id));
  return c.json({ ok: true });
});

chiefOfStaffRoutes.get('/chief-of-staff/threads/:id/messages', async (c) => {
  const threadId = c.req.param('id');
  const messages = await db
    .select()
    .from(schema.cosMessages)
    .where(eq(schema.cosMessages.threadId, threadId))
    .orderBy(schema.cosMessages.createdAt);
  return c.json({ messages });
});

// History lookup keyed by agentId — returns the most recent thread for this
// agent and its message log. Client uses this on startup to rehydrate CoS
// conversation state without depending on localStorage.
chiefOfStaffRoutes.get('/chief-of-staff/history/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const appId = c.req.query('appId');

  const conditions = [eq(schema.cosThreads.agentId, agentId)];
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));

  const threads = await db
    .select()
    .from(schema.cosThreads)
    .where(and(...conditions))
    .orderBy(desc(schema.cosThreads.updatedAt))
    .limit(1);
  const thread = threads[0];

  if (!thread) return c.json({ thread: null, messages: [] });

  const messages = await db
    .select()
    .from(schema.cosMessages)
    .where(eq(schema.cosMessages.threadId, thread.id))
    .orderBy(schema.cosMessages.createdAt);

  return c.json({ thread, messages });
});

// ────────────────────────────────────────────────────────────────────────────
// Dispatch index — derives "which CoS thread launched which session/feedback"
// by parsing tool_calls_json on persisted CoS messages. The Sessions sidebar
// uses this to nest CoS-dispatched agent sessions under their originating
// thread. Mirrors extractDispatchInfo() in packages/admin/src/lib/chief-of-staff.ts.
// ────────────────────────────────────────────────────────────────────────────

type DispatchToolCall = {
  id?: string;
  name?: string;
  input?: { command?: unknown };
  result?: unknown;
  error?: unknown;
};

function parseDispatchToolCall(call: DispatchToolCall): { feedbackId: string; sessionId: string | null } | null {
  if (call.error) return null;
  if (call.name !== 'Bash') return null;
  const cmd = typeof call.input?.command === 'string' ? call.input.command : '';
  if (!cmd) return null;
  if (!/-X\s+POST/i.test(cmd)) return null;

  let feedbackId: string | null = null;
  const pathMatch = cmd.match(/\/api\/v1\/admin\/feedback\/([A-Z0-9]{20,})\/dispatch/i);
  if (pathMatch) {
    feedbackId = pathMatch[1];
  } else {
    if (!/\/api\/v1\/admin\/dispatch\b/.test(cmd)) return null;
    const bodyMatch = cmd.match(/["']feedbackId["']\s*:\s*["']([A-Z0-9]{20,})["']/i);
    if (!bodyMatch) return null;
    feedbackId = bodyMatch[1];
  }

  let sessionId: string | null = null;
  const res = call.result;
  if (typeof res === 'string' && res.trim()) {
    const m = res.match(/["']sessionId["']\s*:\s*["']([A-Za-z0-9-]+)["']/);
    if (m) sessionId = m[1];
  } else if (res && typeof res === 'object' && typeof (res as { sessionId?: unknown }).sessionId === 'string') {
    sessionId = (res as { sessionId: string }).sessionId;
  }

  return { feedbackId, sessionId };
}

chiefOfStaffRoutes.get('/chief-of-staff/dispatches', async (c) => {
  const rows = await db
    .select({
      messageId: schema.cosMessages.id,
      threadId: schema.cosMessages.threadId,
      toolCallsJson: schema.cosMessages.toolCallsJson,
      createdAt: schema.cosMessages.createdAt,
      threadName: schema.cosThreads.name,
      threadAgentId: schema.cosThreads.agentId,
      threadAppId: schema.cosThreads.appId,
    })
    .from(schema.cosMessages)
    .innerJoin(schema.cosThreads, eq(schema.cosMessages.threadId, schema.cosThreads.id))
    .orderBy(desc(schema.cosMessages.createdAt))
    .limit(2000);

  const dispatches: Array<{
    sessionId: string | null;
    feedbackId: string;
    cosThreadId: string;
    cosThreadName: string;
    cosAgentId: string;
    cosAppId: string | null;
    cosMessageId: string;
    createdAt: number;
  }> = [];

  for (const row of rows) {
    if (!row.toolCallsJson) continue;
    let calls: unknown;
    try { calls = JSON.parse(row.toolCallsJson); } catch { continue; }
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const info = parseDispatchToolCall(call as DispatchToolCall);
      if (!info) continue;
      dispatches.push({
        sessionId: info.sessionId,
        feedbackId: info.feedbackId,
        cosThreadId: row.threadId,
        cosThreadName: row.threadName,
        cosAgentId: row.threadAgentId,
        cosAppId: row.threadAppId,
        cosMessageId: row.messageId,
        createdAt: row.createdAt,
      });
    }
  }

  return c.json({ dispatches });
});

// ────────────────────────────────────────────────────────────────────────────
// Interrupt route
// ────────────────────────────────────────────────────────────────────────────

chiefOfStaffRoutes.post('/chief-of-staff/threads/:id/interrupt', (c) => {
  const threadId = c.req.param('id');
  const entry = inFlightByThread.get(threadId);
  if (entry) {
    try { entry.proc.kill('SIGTERM'); } catch { /* already dead */ }
    inFlightByThread.delete(threadId);
    return c.json({ ok: true, interrupted: true });
  }
  return c.json({ ok: true, interrupted: false });
});

// ────────────────────────────────────────────────────────────────────────────
// Session management routes (pre-existing)
// ────────────────────────────────────────────────────────────────────────────

chiefOfStaffRoutes.get('/chief-of-staff/sessions', (c) => {
  const sessions = Array.from(activeSessions.values()).map(serializeSession);
  return c.json({ sessions });
});

chiefOfStaffRoutes.post('/chief-of-staff/lock', async (c) => {
  let body: { requestId?: string; key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const requestId = (body.requestId || '').trim();
  const key = (body.key || '').trim();
  if (!requestId || !key) return c.json({ error: 'requestId and key are required' }, 400);

  const existing = locks.get(key);
  if (existing && existing.owner !== requestId) {
    return c.json({ granted: false, heldBy: existing.owner, heldSince: existing.since });
  }
  const now = Date.now();
  if (!existing) locks.set(key, { owner: requestId, since: now });
  const session = activeSessions.get(requestId);
  if (session) session.lockKeys.add(key);
  return c.json({ granted: true, heldSince: (locks.get(key) || { since: now }).since });
});

chiefOfStaffRoutes.delete('/chief-of-staff/lock/:requestId/:key', (c) => {
  const requestId = c.req.param('requestId');
  const key = c.req.param('key');
  const held = locks.get(key);
  if (!held) return c.json({ released: false, reason: 'not held' });
  if (held.owner !== requestId) {
    return c.json({ released: false, reason: 'not owner', heldBy: held.owner }, 403);
  }
  locks.delete(key);
  const session = activeSessions.get(requestId);
  if (session) session.lockKeys.delete(key);
  return c.json({ released: true });
});

// ────────────────────────────────────────────────────────────────────────────
// Chat route
// ────────────────────────────────────────────────────────────────────────────

type CosImageAttachment = {
  kind: 'image';
  dataUrl: string;
  name?: string;
};

type CosElementRef = {
  selector: string;
  tagName: string;
  id?: string;
  classes?: string[];
  textContent?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
};

function writeImageAttachmentsToTmp(
  attachments: CosImageAttachment[],
): Array<{ absPath: string; name: string }> {
  if (!attachments.length) return [];
  const dir = pathJoin(tmpdir(), `cos-attach-${ulid()}`);
  mkdirSync(dir, { recursive: true });
  const out: Array<{ absPath: string; name: string }> = [];
  attachments.forEach((att, i) => {
    if (att.kind !== 'image' || typeof att.dataUrl !== 'string') return;
    const m = /^data:([^;,]+);base64,(.*)$/i.exec(att.dataUrl);
    if (!m) return;
    const mime = m[1].toLowerCase();
    const ext =
      mime === 'image/png' ? 'png' :
      mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpg' :
      mime === 'image/gif' ? 'gif' :
      mime === 'image/webp' ? 'webp' :
      'png';
    const filename = (att.name && /^[\w.\-]+$/.test(att.name)) ? att.name : `image-${i + 1}.${ext}`;
    const absPath = pathJoin(dir, filename);
    writeFileSync(absPath, Buffer.from(m[2], 'base64'));
    out.push({ absPath, name: filename });
  });
  return out;
}

function renderElementRefsBlock(refs: CosElementRef[]): string {
  if (!refs.length) return '';
  const lines = refs.map((r, i) => {
    const parts: string[] = [`[${i + 1}] <${r.tagName || 'element'}>`];
    if (r.id) parts.push(`#${r.id}`);
    if (r.classes && r.classes.length) parts.push(`.${r.classes.slice(0, 3).join('.')}`);
    if (r.selector) parts.push(`selector=${JSON.stringify(r.selector)}`);
    if (r.boundingRect) {
      const br = r.boundingRect;
      parts.push(`rect={x:${Math.round(br.x)},y:${Math.round(br.y)},w:${Math.round(br.width)},h:${Math.round(br.height)}}`);
    }
    if (r.textContent) {
      const t = r.textContent.trim().slice(0, 120);
      if (t) parts.push(`text=${JSON.stringify(t)}`);
    }
    return parts.join(' ');
  });
  return `Selected DOM elements (from the operator's browser):\n${lines.join('\n')}`;
}

chiefOfStaffRoutes.post('/chief-of-staff/chat', async (c) => {
  let body: {
    text?: string;
    systemPrompt?: string;
    appId?: string;
    model?: string;
    threadId?: string;
    verbosity?: Verbosity;
    style?: ReplyStyle;
    messages?: Array<{ role: string; text?: string }>;
    attachments?: CosImageAttachment[];
    elementRefs?: CosElementRef[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Back-compat: earlier client versions sent {messages:[{role,text},...]}
  // instead of {text}. Pick up the last user message from either shape.
  let text = (body.text || '').trim();
  if (!text && Array.isArray(body.messages) && body.messages.length > 0) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m?.role === 'user' && typeof m.text === 'string' && m.text.trim()) {
        text = m.text.trim();
        break;
      }
    }
  }
  if (!text) return c.json({ error: 'text is required (reload the admin page to pick up the latest client)' }, 400);

  const cwd = resolveRepoRoot();

  // Load thread if provided
  let thread: typeof schema.cosThreads.$inferSelect | undefined;

  if (body.threadId) {
    thread = await db.query.cosThreads.findFirst({
      where: eq(schema.cosThreads.id, body.threadId),
    });
  }

  let appContext = '';
  const appId = body.appId || (thread?.appId ?? undefined);
  if (appId) {
    const app = await db.query.applications.findFirst({
      where: eq(schema.applications.id, appId),
    });
    if (app) {
      appContext = `\n\nCurrent app context: appId=${app.id}, name="${app.name}"${
        app.projectDir ? `, projectDir=${app.projectDir}` : ''
      }. When listing feedback/sessions, default to filtering by this appId unless asked otherwise.`;
    } else {
      appContext = `\n\nCurrent app context: appId=${appId}.`;
    }
  }

  // If the thread already has a claude session id, resume it so the CLI carries
  // full prior context itself (no need to re-inject history into the prompt).
  // Otherwise we start a fresh session with a new UUID, and capture the session
  // id from the stream to persist on the thread for the next turn.
  const resumeSessionId = thread?.claudeSessionId ?? null;
  const requestId = randomUUID();
  const startedAt = Date.now();
  const otherSessions = Array.from(activeSessions.values()).map(serializeSession);
  const session: ActiveSession = {
    requestId,
    sessionId: resumeSessionId || requestId,
    text,
    startedAt,
    lockKeys: new Set(),
  };
  activeSessions.set(requestId, session);

  const concurrencyContext =
    `\n\nYour requestId is ${requestId} (pass it to the lock API).` +
    (otherSessions.length > 0
      ? `\n\nOther active Chief-of-Staff sessions right now:\n${JSON.stringify(otherSessions, null, 2)}`
      : `\n\nNo other Chief-of-Staff sessions are active right now.`) +
    `\n\n${COORDINATION_INSTRUCTIONS}`;

  // Build base system prompt from thread or body
  const baseSystemPrompt = (thread?.systemPrompt || body.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;

  const verbosity: Verbosity = body.verbosity === 'normal' || body.verbosity === 'verbose' ? body.verbosity : 'terse';
  const style: ReplyStyle = body.style === 'neutral' || body.style === 'friendly' ? body.style : 'dry';
  const replyProtocol = '\n\n' + structuredReplyInstructions(verbosity, style);

  const systemPrompt = baseSystemPrompt + appContext + concurrencyContext + replyProtocol;

  const resolvedModel = thread?.model || body.model;

  // Write any image attachments to a per-turn tmp dir and inject their absolute
  // paths into the prompt. Claude will use the Read tool to view them.
  const attachmentsIn = Array.isArray(body.attachments) ? body.attachments : [];
  const elementRefs = Array.isArray(body.elementRefs) ? body.elementRefs : [];
  let tmpImagePaths: Array<{ absPath: string; name: string }> = [];
  try {
    tmpImagePaths = writeImageAttachmentsToTmp(attachmentsIn);
  } catch (err) {
    console.error('[cos] failed to write image attachments:', err);
  }

  const contextBlocks: string[] = [];
  if (tmpImagePaths.length > 0) {
    const lines = tmpImagePaths.map((p, i) => `[${i + 1}] ${p.absPath}`);
    contextBlocks.push(
      `Attached images from the operator (use the Read tool on these absolute paths to view them):\n${lines.join('\n')}`,
    );
  }
  const elementBlock = renderElementRefsBlock(elementRefs);
  if (elementBlock) contextBlocks.push(elementBlock);

  const promptText = contextBlocks.length > 0
    ? `${contextBlocks.join('\n\n')}\n\n---\n\n${text}`
    : text;

  // --resume and --session-id conflict: pick one.
  const args: string[] = [
    '-p', promptText,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--append-system-prompt', systemPrompt,
  ];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  } else {
    args.push('--session-id', requestId);
  }
  if (resolvedModel) args.push('--model', resolvedModel);

  const bin = process.env.CLAUDE_BIN || 'claude';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let cleanedUp = false;

      // Accumulate the final assistant text for persistence. Tool calls are
      // keyed by tool_use id so we can splice tool_result content back onto
      // the matching call when it arrives on a later `user` frame.
      let finalAssistantText = '';
      const finalToolCallsById = new Map<string, { id: string; name: string; input: unknown; result?: string; error?: string }>();
      const finalToolCallOrder: string[] = [];

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        releaseAllLocks(requestId);
        activeSessions.delete(requestId);
        if (body.threadId) inFlightByThread.delete(body.threadId);
        // Remove any tmp images we wrote for this turn. Keep non-fatal.
        for (const p of tmpImagePaths) {
          try { unlinkSync(p.absPath); } catch { /* ignore */ }
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const sendRaw = (event: string, rawJson: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${rawJson}\n\n`));
        } catch {
          closed = true;
        }
      };

      send('session', { sessionId: resumeSessionId || requestId, requestId });

      // Persist the user message upfront (before the stream) so it survives a
      // stream failure. The assistant row is written on successful close.
      const userMsgStartedAt = Date.now();
      const userMsgId = ulid();
      const userAttachmentsJson =
        attachmentsIn.length > 0 || elementRefs.length > 0
          ? JSON.stringify({
              images: attachmentsIn
                .filter((a) => a.kind === 'image' && typeof a.dataUrl === 'string')
                .map((a) => ({ dataUrl: a.dataUrl, name: a.name })),
              elements: elementRefs,
            })
          : null;
      if (body.threadId && thread) {
        db.insert(schema.cosMessages).values({
          id: userMsgId,
          threadId: thread.id,
          role: 'user',
          text,
          toolCallsJson: null,
          attachmentsJson: userAttachmentsJson,
          createdAt: userMsgStartedAt,
        }).catch(() => { /* non-fatal */ });
      }

      // Session id the CLI actually used (captured from the first `system`
      // init event). On the first turn we persist it on the thread so
      // subsequent turns can --resume.
      let capturedSessionId: string | null = null;

      let proc;
      try {
        proc = spawn(bin, args, {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        send('error', { error: err?.message || 'Failed to spawn claude CLI' });
        closed = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      // Register in-flight for interrupt support
      if (body.threadId) {
        inFlightByThread.set(body.threadId, { proc });
      }

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Validate it's JSON; forward opaque — client parses.
          let ok = false;
          let obj: any;
          try {
            obj = JSON.parse(trimmed);
            ok = true;
          } catch {
            /* skip non-JSON line */
          }
          if (ok) {
            sendRaw('claude', trimmed);
            // Accumulate assistant text for persistence
            if (obj) {
              if (!capturedSessionId && typeof obj.session_id === 'string' && obj.session_id) {
                capturedSessionId = obj.session_id;
              }
              if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
                for (const block of obj.message.content) {
                  if (block.type === 'text' && block.text) {
                    finalAssistantText += (finalAssistantText ? '\n\n' : '') + block.text;
                  } else if (block.type === 'tool_use') {
                    const id = String(block.id || `tu-${finalToolCallOrder.length}`);
                    if (!finalToolCallsById.has(id)) {
                      finalToolCallsById.set(id, { id, name: String(block.name || 'tool'), input: block.input });
                      finalToolCallOrder.push(id);
                    }
                  }
                }
              } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
                for (const block of obj.message.content) {
                  if (block.type !== 'tool_result') continue;
                  const id = String(block.tool_use_id || '');
                  const call = finalToolCallsById.get(id);
                  if (!call) continue;
                  const raw = block.content;
                  let content: string;
                  if (typeof raw === 'string') content = raw;
                  else if (Array.isArray(raw)) {
                    content = raw
                      .map((c: any) => (typeof c === 'string' ? c : c?.text || JSON.stringify(c)))
                      .join('\n');
                  } else content = JSON.stringify(raw);
                  // Cap to keep row size sane — full output is still in the JSONL transcript.
                  if (content.length > 4000) content = `${content.slice(0, 4000)}…[${content.length - 4000} more chars truncated]`;
                  if (block.is_error) call.error = content;
                  else call.result = content;
                }
              } else if (obj.type === 'result' && !finalAssistantText && obj.result) {
                finalAssistantText = String(obj.result).trim();
              }
            }
          }
        }
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });

      proc.on('error', (err: any) => {
        send('error', { error: err?.message || 'claude process error' });
        closed = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          send('error', {
            error: `claude exited with code ${code}${stderrBuf ? `: ${stderrBuf.slice(0, 500)}` : ''}`,
            exitCode: code,
          });
        }

        // Persist assistant message + thread bookkeeping. The user message was
        // already written before the stream started. We also stash the
        // captured claude session id on the thread the first time we see it,
        // so the next turn can --resume.
        if (body.threadId && thread) {
          const now = Date.now();
          const ops: Promise<unknown>[] = [];
          const orderedToolCalls = finalToolCallOrder
            .map((id) => finalToolCallsById.get(id))
            .filter((c): c is NonNullable<typeof c> => !!c);
          if (finalAssistantText || orderedToolCalls.length > 0) {
            ops.push(db.insert(schema.cosMessages).values({
              id: ulid(),
              threadId: thread.id,
              role: 'assistant',
              text: finalAssistantText || '',
              toolCallsJson: orderedToolCalls.length > 0 ? JSON.stringify(orderedToolCalls) : null,
              createdAt: now,
            }));
          }
          const threadPatch: Partial<typeof schema.cosThreads.$inferInsert> = { updatedAt: now };
          if (capturedSessionId && capturedSessionId !== thread.claudeSessionId) {
            threadPatch.claudeSessionId = capturedSessionId;
          }
          ops.push(db.update(schema.cosThreads)
            .set(threadPatch)
            .where(eq(schema.cosThreads.id, thread.id)));
          Promise.all(ops).catch(() => { /* non-fatal */ });
        }

        send('done', { exitCode: code ?? 0 });
        closed = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }

        // Wiggum self-reflection: fire-and-forget background pass over recent
        // JSONL transcripts. Single-flight so concurrent closes coalesce.
        const port = Number(process.env.PORT) || 3001;
        spawnWiggumReflection(port);
      });

      c.req.raw.signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        cleanup();
      });
    },
  });

  return c.body(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
