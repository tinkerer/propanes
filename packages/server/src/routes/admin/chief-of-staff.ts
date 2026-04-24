import { Hono } from 'hono';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { ulid } from 'ulidx';
import WebSocket from 'ws';
import { db, schema } from '../../db/index.js';
import { findRecentProjectJsonl } from '../../jsonl-scan.js';
import {
  spawnSessionRemote,
  inputSessionRemote,
  getSessionStatus,
  getSessionServiceWsUrl,
} from '../../session-service-client.js';

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

Fast acknowledgement: every turn, your FIRST output must be a short ack — one sentence restating your understanding of the ask, followed by a rough ETA tag like \`eta: looking now\` / \`eta: ~10s\` / \`eta: ~30s\` / \`eta: ~2m\` / \`eta: multi-step\`. Emit that ack in its own \`<cos-reply>\` tag before any tool calls, so the operator sees it immediately. Then do the work. Then emit a second \`<cos-reply>\` with the finished answer. Two tags per turn, ack first, final second.

Style: terse. Short bullet lists. Surface IDs. Flag anything stuck (sessions running hours without output, offline launchers, feedback queued but not dispatched, bailouts matching the heuristic above). Never invent IDs — always curl to look them up. Keep answers under 10 lines unless the operator asks for detail. Don't say "ok" or narrate tool calls — just report results. Don't cop out: if the operator told you to act, act — don't reply asking whether they meant it.

## Posting images / screenshots to the thread

When you take a screenshot (e.g. via pw-vnc screenshot) and want to show it in the chat, DO NOT post it via the CoS chat endpoint — that would create a "You" bubble attributed to the operator. Instead, convert the image to a base64 data URL and POST it as an assistant message directly:

\`\`\`bash
THREAD_ID="<threadId from your system prompt>"
IMG_B64=$(base64 -w0 /tmp/pw_vnc_screen.png)
curl -s -X POST "http://localhost:3001/api/v1/admin/chief-of-staff/threads/$THREAD_ID/messages" \\
  -H 'Content-Type: application/json' \\
  -d "{\"role\":\"assistant\",\"text\":\"Screenshot:\",\"attachmentsJson\":\"{\\\"images\\\":[{\\\"dataUrl\\\":\\\"data:image/png;base64,$IMG_B64\\\",\\\"name\\\":\\\"screenshot.png\\\"}]}\"}"
\`\`\`

This inserts the image as a Chief-of-Staff message so it appears in the "Ops" bubble, not "You".`;

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

Wrap any text the operator should see in \`<cos-reply>...</cos-reply>\` XML tags. All reasoning, planning, tool-use narration, and scratch work stays OUTSIDE the tags — only finished user-facing text goes inside.

Emit TWO tags per turn, in this order:

1. **Ack tag** (first, before any tool calls): one short sentence restating the ask, followed by a rough ETA line. Format:
   \`<cos-reply>On it — <your understanding>. eta: <looking now | ~10s | ~30s | ~2m | multi-step></cos-reply>\`
2. **Final tag** (after the work is done): the actual answer / report of what you did.

Rules:
- Emit the ack tag FIRST thing in the turn, before any Bash/tool call, so the operator sees it instantly.
- Both tags must be balanced; never leave one open.
- Never wrap a tag in code fences or quote the literal tag name as an example.
- If your reply itself needs angle brackets, prefer code fences inside the tag.
- Do not put a tag inside a tool_use input.

Inside the final tag, style the reply as:
- Verbosity (${verbosity}): ${VERBOSITY_GUIDE[verbosity]}
- Tone (${style}): ${STYLE_GUIDE[style]}

Anything outside the tags is hidden scratch work and will not be shown to the user.`;
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

// Build the static system prompt for a thread's persistent session.
// Per-turn dynamic context (requestId, other sessions) is injected into each
// user message instead, since the session lives across multiple turns.
function buildThreadSystemPrompt(threadId: string, appId: string | null, overridePrompt: string | null): string {
  const base = (overridePrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
  let ctx = '';
  if (appId) ctx += `\n\nDefault appId context: ${appId}. Filter feedback/sessions by this appId unless asked otherwise.`;
  ctx += `\n\nYour threadId is ${threadId}. Post replies back to this thread as yourself by calling:\n  POST http://localhost:3001/api/v1/admin/chief-of-staff/threads/${threadId}/messages\n  body: {"role":"assistant","text":"<cos-reply>...</cos-reply>"}\n\nTo share a screenshot:\n  python3 -c "import base64,json,urllib.request; img=open('/tmp/pw_vnc_screen.png','rb').read(); b64='data:image/png;base64,'+base64.b64encode(img).decode(); body=json.dumps({'role':'assistant','text':'Screenshot:','attachmentsJson':json.dumps({'images':[{'dataUrl':b64,'name':'screenshot.png'}]})}); r=urllib.request.Request('http://localhost:3001/api/v1/admin/chief-of-staff/threads/${threadId}/messages',body.encode(),{'Content-Type':'application/json'},'POST'); print(urllib.request.urlopen(r).read())"`;
  ctx += '\n\n' + COORDINATION_INSTRUCTIONS;
  return base + ctx;
}

// Proxy session-service WebSocket output as an SSE ReadableStream.
//
// Three callers:
// 1. New turn: `userMessage` is the prompt; we capture the current outputSeq
//    as the turn's start seq, call `onTurnStart(startSeq)`, then write stdin.
// 2. Initial spawn: `userMessage === null` (first turn was passed as the
//    initial prompt to spawnSessionRemote) — skip stdin write but still
//    record the turn-start seq.
// 3. Re-attach: `attach === true` and `fromSeq` is provided — tail an
//    already-running turn from the given seq without writing stdin, without
//    persisting a fresh assistant row on finish.
//
// Each forwarded claude line is wrapped as an envelope `{"seq":N,"line":...}`
// so clients can remember the last seq they saw and resume exactly there.
function streamCosSessionOutput(params: {
  agentSessionId: string;
  userMessage: string | null;
  requestId: string;
  attach?: boolean;
  fromSeq?: number;
  onTurnStart?: (startSeq: number) => void;
  onAssistantText: (text: string, toolCalls: Map<string, { id: string; name: string; input: unknown; result?: string; error?: string }>, toolOrder: string[]) => void;
  onCapturedSessionId: (id: string) => void;
  onDone?: () => void;
}): ReadableStream {
  const {
    agentSessionId,
    userMessage,
    requestId,
    attach = false,
    fromSeq,
    onTurnStart,
    onAssistantText,
    onCapturedSessionId,
    onDone,
  } = params;
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      let closed = false;
      let startOutputSeq = 0;
      let finalAssistantText = '';
      const finalToolCallsById = new Map<string, { id: string; name: string; input: unknown; result?: string; error?: string }>();
      const finalToolCallOrder: string[] = [];
      let capturedSessionId: string | null = null;
      let seqCursor = 0;

      const enqueue = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
      };
      const enqueueClaudeFrame = (seq: number, raw: string) => {
        if (closed) return;
        // Wrap the raw claude JSON line so clients learn the session-service
        // seq they're processing. Kept as one-line JSON for cheap parsing.
        const envelope = `{"seq":${seq},"line":${raw}}`;
        try { controller.enqueue(encoder.encode(`event: claude\ndata: ${envelope}\n\n`)); } catch { closed = true; }
      };
      const finish = (exitCode: number, cancelled = false) => {
        if (closed) return;
        // On re-attach the original turn already owns persistence; don't
        // double-write the assistant row on every reconnect.
        if (!attach) {
          onAssistantText(finalAssistantText, finalToolCallsById, finalToolCallOrder);
          if (capturedSessionId) onCapturedSessionId(capturedSessionId);
        }
        enqueue('done', { exitCode, cancelled, attach });
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
        onDone?.();
      };

      // Parse a stream-json line and accumulate assistant content.
      //
      // Sessions run through a tmux-wrapped PTY (see session-service.ts), so
      // claude's stream-json stdout arrives interleaved with CSI/OSC escape
      // sequences + CR bytes. JSON.parse bails on that noise, which silently
      // drops the assistant reply and surfaces as "No response from Claude"
      // on the frontend even though the turn completed normally. Strip any
      // ANSI sequences + CRs before parsing.
      const ANSI_RE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x2f]*[\x30-\x7e])/g;
      const processJsonLine = (line: string, seq: number): boolean => {
        const cleaned = line.replace(ANSI_RE, '').replace(/\r/g, '').trim();
        if (!cleaned) return false;
        // Fast-path: only try to parse lines that look like a JSON object.
        // Keeps this resilient to tmux status/banner lines that survive the
        // strip (e.g. `[exited]`).
        if (cleaned.charCodeAt(0) !== 0x7b /* '{' */) return false;
        let obj: any;
        try { obj = JSON.parse(cleaned); } catch { return false; }
        enqueueClaudeFrame(seq, cleaned);
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
            const call = finalToolCallsById.get(String(block.tool_use_id || ''));
            if (!call) continue;
            const raw = block.content;
            let content = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c: any) => c?.text || JSON.stringify(c)).join('\n') : JSON.stringify(raw);
            if (content.length > 4000) content = `${content.slice(0, 4000)}…`;
            if (block.is_error) call.error = content; else call.result = content;
          }
        } else if (obj.type === 'result') {
          if (!finalAssistantText && obj.result) finalAssistantText = String(obj.result).trim();
          return true; // signal end of turn
        }
        return false;
      };

      (async () => {
        if (attach) {
          // Passive re-attach: use the given fromSeq without writing stdin.
          startOutputSeq = Math.max(0, (fromSeq ?? 1) - 1);
        } else {
          // Get current output seq before writing — we only want output after our message.
          const status = await getSessionStatus(agentSessionId).catch(() => null);
          startOutputSeq = status?.outputSeq ?? 0;
          onTurnStart?.(startOutputSeq);
        }
        seqCursor = startOutputSeq;

        enqueue('session', { sessionId: agentSessionId, requestId, startSeq: startOutputSeq, attach });

        if (!attach && userMessage !== null) {
          // Write user message as stream-json to stdin (first-turn message is
          // passed as the initial prompt to spawnSessionRemote instead).
          const stdinPayload = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: userMessage }] },
          }) + '\n';
          await inputSessionRemote(agentSessionId, stdinPayload).catch((err) => {
            enqueue('error', { error: String(err) });
            finish(1);
          });
          if (closed) return;
        }

        // Open WebSocket to session-service and replay output from startOutputSeq.
        const wsUrl = getSessionServiceWsUrl(agentSessionId);
        const ws = new WebSocket(wsUrl);
        let outputBuf = '';

        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'replay_request', fromSeq: startOutputSeq + 1 }));
        });

        ws.on('message', (raw) => {
          if (closed) { ws.close(); return; }
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          // Session-service emits SequencedOutput envelopes:
          //   { type: 'sequenced_output', seq, content: { kind, data } }
          // Fall back to flat fields in case of legacy frames.
          const kind = msg?.content?.kind ?? msg?.kind;
          const data = typeof msg?.content?.data === 'string'
            ? msg.content.data
            : (typeof msg?.data === 'string' ? msg.data : null);
          const exitCode = msg?.content?.exitCode ?? msg?.exitCode;
          if (typeof msg?.seq === 'number') seqCursor = msg.seq;
          if (kind === 'output' && data != null) {
            outputBuf += data;
            const lines = outputBuf.split('\n');
            outputBuf = lines.pop() || '';
            for (const line of lines) {
              const done = processJsonLine(line, seqCursor);
              if (done) { ws.close(); finish(0); return; }
            }
          } else if (kind === 'exit') {
            ws.close();
            finish(exitCode ?? 0, false);
          }
        });

        ws.on('error', (err) => {
          enqueue('error', { error: String(err) });
          finish(1);
        });

        ws.on('close', () => {
          if (!closed) finish(0);
        });
      })();
    },
  });
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

// Track in-flight processes by threadId so they can be interrupted.
// `cancelled` records that we killed the proc on purpose (interrupt, supersede,
// client abort) so the close handler can distinguish a clean cancel from a
// real crash — SIGTERM surfaces as exit code 143 and should not surface as
// "Send failed" in the UI.
type InFlightEntry = { proc: ReturnType<typeof spawn>; cancelled: boolean };
const inFlightByThread = new Map<string, InFlightEntry>();

function killProc(entry: InFlightEntry): void {
  entry.cancelled = true;
  const pid = entry.proc.pid;
  if (!pid) return;
  // Kill the entire process group so subprocesses (tool calls) also die
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
  // SIGKILL fallback after 3s in case SIGTERM is ignored
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ } }, 3000);
}

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

// Every CoS thread has exactly one persistent headless-stream agent session.
// Provision it if missing (e.g. a thread created before the auto-provision
// migration). Returns the agentSessionId that's now linked to the thread.
async function ensureAgentSessionForThread(
  thread: typeof schema.cosThreads.$inferSelect,
): Promise<string> {
  if (thread.agentSessionId) return thread.agentSessionId;
  const agentSessionId = ulid();
  const nowIso = new Date().toISOString();
  await db.insert(schema.agentSessions).values({
    id: agentSessionId,
    cosThreadId: thread.id,
    runtime: 'claude',
    permissionProfile: 'headless-stream-yolo',
    status: 'idle',
    outputBytes: 0,
    title: thread.name,
    cwd: resolveRepoRoot(),
    createdAt: nowIso,
    startedAt: nowIso,
    lastActivityAt: nowIso,
  });
  await db.update(schema.cosThreads)
    .set({ agentSessionId })
    .where(eq(schema.cosThreads.id, thread.id));
  return agentSessionId;
}

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
  const agentSessionId = ulid();
  const nowIso = new Date(now).toISOString();

  const thread = {
    id,
    agentId,
    appId: body.appId || null,
    name,
    systemPrompt: body.systemPrompt || null,
    model: body.model || null,
    agentSessionId,
    createdAt: now,
    updatedAt: now,
  };

  const cwd = resolveRepoRoot();
  await db.insert(schema.cosThreads).values(thread);
  await db.insert(schema.agentSessions).values({
    id: agentSessionId,
    cosThreadId: id,
    runtime: 'claude',
    permissionProfile: 'headless-stream-yolo',
    status: 'idle',
    outputBytes: 0,
    title: name,
    cwd,
    createdAt: nowIso,
    startedAt: nowIso,
    lastActivityAt: nowIso,
  });

  return c.json(thread);
});


// Post a message directly into a thread as assistant/system role.
// Used by the CoS itself to surface content (e.g. screenshots) without the
// message being attributed to the operator ("You").
chiefOfStaffRoutes.post('/chief-of-staff/threads/:id/messages', async (c) => {
  const threadId = c.req.param('id');
  let body: { role?: string; text?: string; attachmentsJson?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const role = body.role === 'system' ? 'system' : 'assistant';
  const text = (body.text || '').trim();
  if (!text) return c.json({ error: 'text is required' }, 400);

  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const now = Date.now();
  const messageId = ulid();
  await db.insert(schema.cosMessages).values({
    id: messageId,
    threadId,
    role,
    text,
    toolCallsJson: null,
    attachmentsJson: body.attachmentsJson || null,
    createdAt: now,
  });
  await db.update(schema.cosThreads)
    .set({ updatedAt: now })
    .where(eq(schema.cosThreads.id, threadId));

  return c.json({ ok: true, messageId });
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

// History lookup keyed by agentId — returns ALL threads for the agent and the
// interleaved message log across them. Client uses this on startup to
// rehydrate CoS conversation state without depending on localStorage. Each
// message carries its threadId so the client can route replies back to the
// right server-side thread (== its own Claude session).
chiefOfStaffRoutes.get('/chief-of-staff/history/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const appId = c.req.query('appId');

  const conditions = [eq(schema.cosThreads.agentId, agentId)];
  if (appId) conditions.push(eq(schema.cosThreads.appId, appId));

  const threads = await db
    .select()
    .from(schema.cosThreads)
    .where(and(...conditions))
    .orderBy(desc(schema.cosThreads.updatedAt));

  if (threads.length === 0) {
    return c.json({ threads: [], thread: null, messages: [] });
  }

  const threadIds = threads.map((t) => t.id);
  const messages = await db
    .select()
    .from(schema.cosMessages)
    .where(inArray(schema.cosMessages.threadId, threadIds))
    .orderBy(schema.cosMessages.createdAt);

  // `thread` retained for backward-compat — points at the most-recently
  // updated thread. New clients read `threads` + per-message threadId.
  return c.json({ threads, thread: threads[0], messages });
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
    killProc(entry);
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

// Query thread status without invoking the LLM. Answers "is the bot working?"
// and, when the turn is running through the session-service (persistent-
// stream path), "what seq should I re-attach from if my SSE dropped?".
chiefOfStaffRoutes.get('/chief-of-staff/threads/:id/status', async (c) => {
  const threadId = c.req.param('id');
  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  const live = thread.agentSessionId
    ? await getSessionStatus(thread.agentSessionId).catch(() => null)
    : null;
  const inFlight = thread.turnStartedAt != null;
  // A re-attach is possible when the session-service is still holding the
  // output buffer for this turn. For the direct-spawn (non-persistent) path
  // turnStartSeq is null — the turn is observable but not re-attachable.
  const resumable = inFlight && thread.turnStartSeq != null && live?.active === true;

  return c.json({
    threadId,
    inFlight,
    resumable,
    turnStartedAt: thread.turnStartedAt,
    turnStartSeq: thread.turnStartSeq,
    turnUserText: thread.turnUserText,
    turnRequestId: thread.turnRequestId,
    agentSessionId: thread.agentSessionId,
    agentSessionStatus: live?.status ?? null,
    agentSessionActive: live?.active ?? null,
    currentOutputSeq: live?.outputSeq ?? null,
    updatedAt: thread.updatedAt,
    serverTime: Date.now(),
  });
});

// Re-attach SSE stream to an in-flight turn. Used by the frontend to resume
// after the main-server restarts or after a transient network drop — the
// session-service's output buffer lets us replay from the last-seen seq so
// nothing is lost or duplicated.
chiefOfStaffRoutes.get('/chief-of-staff/threads/:id/attach', async (c) => {
  const threadId = c.req.param('id');
  const fromSeqRaw = c.req.query('fromSeq');
  const fromSeq = fromSeqRaw != null && !Number.isNaN(Number(fromSeqRaw)) ? Number(fromSeqRaw) : undefined;

  const thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);
  if (!thread.agentSessionId) return c.json({ error: 'Thread has no session to attach to' }, 404);
  if (thread.turnStartedAt == null || thread.turnStartSeq == null) {
    return c.json({ error: 'No in-flight turn to attach to' }, 409);
  }

  const requestId = thread.turnRequestId || randomUUID();
  const stream = streamCosSessionOutput({
    agentSessionId: thread.agentSessionId,
    userMessage: null,
    requestId,
    attach: true,
    fromSeq: fromSeq ?? (thread.turnStartSeq + 1),
    onAssistantText: () => { /* primary turn owns persistence */ },
    onCapturedSessionId: () => { /* primary turn owns session-id capture */ },
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
    replyToTs?: number;
    clientTs?: number;
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

  // Every chat turn belongs to a thread. The client always creates one via
  // POST /chief-of-staff/threads before sending, which also provisions the
  // persistent headless-stream agent session for that thread.
  if (!body.threadId) return c.json({ error: 'threadId is required' }, 400);
  let thread = await db.query.cosThreads.findFirst({
    where: eq(schema.cosThreads.id, body.threadId),
  });
  if (!thread) return c.json({ error: 'Thread not found' }, 404);

  // Pre-migration threads may not yet have an agentSessionId — provision one
  // now so the persistent-stream path below always has a session to drive.
  if (!thread.agentSessionId) {
    await ensureAgentSessionForThread(thread);
    thread = await db.query.cosThreads.findFirst({
      where: eq(schema.cosThreads.id, body.threadId),
    });
    if (!thread?.agentSessionId) {
      return c.json({ error: 'Failed to provision CoS agent session' }, 500);
    }
  }

  // Stop keyword: if the operator sent just "stop"/"halt"/"cancel"/"kill",
  // interrupt the in-flight claude proc for this thread and return a short
  // SSE stream with a "Stopped." reply. No new turn is fired.
  const STOP_RE = /^\s*(stop|halt|cancel|kill)\s*\.?\s*$/i;
  if (body.threadId && thread && STOP_RE.test(text)) {
    const existing = inFlightByThread.get(body.threadId);
    const wasRunning = !!existing;
    if (existing) {
      killProc(existing);
      inFlightByThread.delete(body.threadId);
    }
    const now = Date.now();
    const userTs = typeof body.clientTs === 'number' ? body.clientTs : now;
    db.insert(schema.cosMessages).values({
      id: ulid(),
      threadId: thread.id,
      role: 'user',
      text,
      toolCallsJson: null,
      attachmentsJson: null,
      createdAt: userTs,
    }).catch(() => { /* non-fatal */ });
    const ackText = wasRunning ? 'Stopped.' : 'Nothing running.';
    db.insert(schema.cosMessages).values({
      id: ulid(),
      threadId: thread.id,
      role: 'assistant',
      text: `<cos-reply>${ackText}</cos-reply>`,
      toolCallsJson: null,
      attachmentsJson: null,
      createdAt: userTs + 1,
    }).catch(() => { /* non-fatal */ });
    db.update(schema.cosThreads)
      .set({ updatedAt: now })
      .where(eq(schema.cosThreads.id, thread.id))
      .catch(() => { /* non-fatal */ });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          `event: claude\ndata: ${JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `<cos-reply>${ackText}</cos-reply>` }] },
          })}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          `event: done\ndata: ${JSON.stringify({ exitCode: 0, stopped: wasRunning })}\n\n`,
        ));
        controller.close();
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
  }

  // Concurrent follow-up: the persistent session-service session accepts
  // stream-json messages over stdin, so a new turn from the operator queues
  // naturally behind the running one. Just clear any stale inFlightByThread
  // stub from a prior turn so the new turn's stub replaces it cleanly.
  if (body.threadId) inFlightByThread.delete(body.threadId);

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
  //
  // Safety guard: if the JSONL file for the stored session exceeds 5 MB, loading
  // it on every turn makes startup slow enough that the concurrent-follow-up
  // killer fires before the first ack goes out (SIGTERM → exit 143). In that
  // case drop the resume and let the thread start fresh.
  const JSONL_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB
  let rawResumeId = thread?.claudeSessionId ?? null;
  if (rawResumeId) {
    const cwdForSize = resolveRepoRoot();
    const projectSlug = cwdForSize.replace(/\//g, '-');
    const jsonlPath = pathJoin(homedir(), '.claude', 'projects', projectSlug, `${rawResumeId}.jsonl`);
    try {
      const { size } = statSync(jsonlPath);
      if (size > JSONL_SIZE_LIMIT) {
        console.warn(`[cos] session ${rawResumeId} JSONL is ${size} bytes (>${JSONL_SIZE_LIMIT}) — dropping resume to avoid slow startup`);
        rawResumeId = null;
        if (body.threadId) {
          db.update(schema.cosThreads)
            .set({ claudeSessionId: null })
            .where(eq(schema.cosThreads.id, body.threadId))
            .run();
        }
      }
    } catch { /* file not found or unreadable — proceed normally */ }
  }
  const resumeSessionId = rawResumeId;
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
    (body.threadId
      ? `\n\nYour threadId is ${body.threadId}. To post content back to this thread as yourself (not labelled "You"), POST to:\n  http://localhost:3001/api/v1/admin/chief-of-staff/threads/${body.threadId}/messages\n\nTo share a screenshot, use this Python one-liner (handles escaping safely):\n  python3 -c "import base64,json,urllib.request; img=open('/tmp/pw_vnc_screen.png','rb').read(); b64='data:image/png;base64,'+base64.b64encode(img).decode(); body=json.dumps({'role':'assistant','text':'Screenshot:','attachmentsJson':json.dumps({'images':[{'dataUrl':b64,'name':'screenshot.png'}]})}); r=urllib.request.Request('http://localhost:3001/api/v1/admin/chief-of-staff/threads/${body.threadId}/messages',body.encode(),{'Content-Type':'application/json'},'POST'); print(urllib.request.urlopen(r).read())"`
      : '') +
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

  // ── Persistent headless-stream path ──────────────────────────────────────
  // Every CoS thread has exactly one persistent headless-stream agent session
  // (provisioned at thread creation or backfilled above). If the session is
  // alive in the session-service, forward the turn's user message as stdin
  // JSON and proxy the output as SSE; otherwise spawn it fresh with this
  // message as the initial prompt. Per-turn context (requestId, other active
  // sessions) is prepended so the persistent session sees it.
  {
    // Prepend per-turn metadata so the model has requestId / lock context.
    const turnMeta = [
      `[TURN requestId=${requestId}]`,
      otherSessions.length > 0 ? `Other active CoS sessions: ${JSON.stringify(otherSessions)}` : null,
    ].filter(Boolean).join('\n');
    const fullTurnText = turnMeta ? `${turnMeta}\n\n${promptText}` : promptText;

    const liveStatus = await getSessionStatus(thread.agentSessionId).catch(() => null);
    const isLive = liveStatus?.active && liveStatus.status === 'running';

    // If session is dead or idle, spawn it with the first user message as the initial prompt.
    // headless-stream requires at least one prompt to start; subsequent turns go via stdin.
    if (!isLive) {
      const nowIso2 = new Date().toISOString();
      // If the thread already has a claudeSessionId from an earlier turn, pass
      // it as `resumeSessionId` so the CLI runs `--resume <id>` and picks up
      // prior context. Passing it as `claudeSessionId` would map to
      // `--session-id <id>`, which claude rejects with
      // "Session ID … is already in use" when the JSONL already exists — that
      // made the session exit in <1s and the UI showed "send failed" with no
      // reply. `resumeSessionId` honours the JSONL-size guard above (rawResumeId
      // gets nulled if the stored session's JSONL exceeds 5 MB).
      const priorResumeId = resumeSessionId;
      const freshSessionId = priorResumeId ? null : randomUUID();
      const effectiveClaudeSessionId = priorResumeId ?? freshSessionId!;
      db.update(schema.agentSessions)
        .set({ status: 'running', claudeSessionId: effectiveClaudeSessionId, startedAt: nowIso2, lastActivityAt: nowIso2 })
        .where(eq(schema.agentSessions.id, thread.agentSessionId))
        .run();
      const threadSp = buildThreadSystemPrompt(thread.id, thread.appId, thread.systemPrompt);
      let spawnErr: unknown = null;
      try {
        await spawnSessionRemote({
          sessionId: thread.agentSessionId,
          prompt: fullTurnText,
          cwd,
          permissionProfile: 'headless-stream-yolo',
          claudeSessionId: freshSessionId ?? undefined,
          resumeSessionId: priorResumeId ?? undefined,
          appendSystemPrompt: threadSp,
        });
      } catch (err) {
        spawnErr = err;
        console.error('[cos] spawn failed:', err);
      }
      // Give it a moment to start before we try to proxy output
      await new Promise((r) => setTimeout(r, 800));

      // If the spawn itself rejected, surface a real error to the client
      // instead of falling through to a WebSocket that'll time out against a
      // non-running session. Also flip the agentSessions row back to failed
      // so the sidebar reflects reality.
      if (spawnErr) {
        db.update(schema.agentSessions)
          .set({ status: 'failed', completedAt: new Date().toISOString() })
          .where(eq(schema.agentSessions.id, thread.agentSessionId))
          .run();
        activeSessions.delete(requestId);
        if (body.threadId) inFlightByThread.delete(body.threadId);
        for (const p of tmpImagePaths) { try { unlinkSync(p.absPath); } catch { /* ignore */ } }
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        return c.json({ error: `Failed to start CoS agent session: ${msg}` }, 502);
      }
    }

    // Persist user message row upfront.
    const userMsgStartedAt2 = typeof body.clientTs === 'number' ? body.clientTs : Date.now();
    const userMsgId2 = ulid();
    const hasExtras2 = attachmentsIn.length > 0 || elementRefs.length > 0 || typeof body.replyToTs === 'number';
    const userAttachmentsJson2 = hasExtras2 ? JSON.stringify({
      images: attachmentsIn.filter((a) => a.kind === 'image').map((a) => ({ dataUrl: a.dataUrl, name: a.name })),
      elements: elementRefs,
      ...(typeof body.replyToTs === 'number' ? { replyToTs: body.replyToTs } : {}),
    }) : null;
    if (body.threadId && thread) {
      db.insert(schema.cosMessages).values({
        id: userMsgId2, threadId: thread.id, role: 'user', text,
        toolCallsJson: null, attachmentsJson: userAttachmentsJson2, createdAt: userMsgStartedAt2,
      }).run();
    }

    // Update agentSession to show running state.
    db.update(schema.agentSessions).set({
      status: 'running',
      lastActivityAt: new Date().toISOString(),
      title: text.slice(0, 160),
    }).where(eq(schema.agentSessions.id, thread.agentSessionId)).run();

    activeSessions.set(requestId, { requestId, sessionId: thread.agentSessionId, text, startedAt, lockKeys: new Set() });
    if (body.threadId) inFlightByThread.set(body.threadId, { proc: { pid: undefined } as any, cancelled: false });

    const streamOut = streamCosSessionOutput({
      agentSessionId: thread.agentSessionId,
      userMessage: isLive ? fullTurnText : null,
      requestId,
      onTurnStart: (startSeq) => {
        if (!thread) return;
        // Mark the turn as in-flight so /threads/:id/status can answer
        // "is the bot busy?" without invoking the LLM, and so the frontend
        // can re-attach from startSeq if the SSE stream drops.
        db.update(schema.cosThreads).set({
          turnStartedAt: startedAt,
          turnStartSeq: startSeq,
          turnUserText: text.slice(0, 500),
          turnRequestId: requestId,
        }).where(eq(schema.cosThreads.id, thread.id)).run();
      },
      onAssistantText: (finalText, toolCallsById, toolOrder) => {
        if (!finalText || !thread) return;
        const now2 = Date.now();
        const toolCallsArr = toolOrder.map((id) => toolCallsById.get(id)).filter(Boolean);
        db.insert(schema.cosMessages).values({
          id: ulid(), threadId: thread.id, role: 'assistant', text: finalText,
          toolCallsJson: toolCallsArr.length > 0 ? JSON.stringify(toolCallsArr) : null,
          attachmentsJson: null, createdAt: now2,
        }).run();
        db.update(schema.cosThreads).set({ updatedAt: now2 }).where(eq(schema.cosThreads.id, thread.id)).run();
        db.update(schema.agentSessions).set({
          status: 'running', lastActivityAt: new Date().toISOString(),
        }).where(eq(schema.agentSessions.id, thread.agentSessionId!)).run();
      },
      onCapturedSessionId: (sid) => {
        if (!thread) return;
        db.update(schema.cosThreads).set({ claudeSessionId: sid }).where(eq(schema.cosThreads.id, thread.id)).run();
        db.update(schema.agentSessions).set({ claudeSessionId: sid }).where(eq(schema.agentSessions.id, thread.agentSessionId!)).run();
      },
      onDone: () => {
        releaseAllLocks(requestId);
        activeSessions.delete(requestId);
        if (body.threadId) inFlightByThread.delete(body.threadId);
        if (thread) {
          db.update(schema.cosThreads).set({
            turnStartedAt: null,
            turnStartSeq: null,
            turnUserText: null,
            turnRequestId: null,
          }).where(eq(schema.cosThreads.id, thread.id)).run();
        }
        for (const p of tmpImagePaths) { try { unlinkSync(p.absPath); } catch { /* ignore */ } }
      },
    });

    return c.body(streamOut, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }
  // ── End persistent headless-stream path ───────────────────────────────────

  // Unreachable: every chat turn above routed through the persistent path and
  // already returned.
  return c.json({ error: 'Internal routing error' }, 500);
});
