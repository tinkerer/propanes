// CoS turn consumer: bridges a session-service WebSocket → the per-thread
// event bus + cosMessages persistence.
//
// Two callers:
// 1. Chat handler — POST /chief-of-staff/chat fires a fresh consumer for the
//    new turn, then returns 202.
// 2. Recovery — at server startup, recoverInFlightTurns() scans the threads
//    table for orphaned in-flight turns (whose session-service-side claude
//    process survived a main-server restart via tryRecoverSession) and
//    re-attaches a consumer per orphan so the assistant row still lands in DB.
//
// Both paths are detached from any HTTP request; errors are surfaced via
// `turn_status: failed` events rather than thrown.

import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import WebSocket from 'ws';
import { db, schema } from '../../db/index.js';
import {
  inputSessionRemote,
  getSessionStatus,
  getSessionServiceWsUrl,
} from '../../session-service-client.js';
import {
  type CosClaudeEvent,
  type CosTurnStatus,
  appendTurnReplay,
  clearTurnReplay,
  recordTurnFinalStatus,
  publishBusEvent,
} from './cos-event-bus.js';

// Consume a session-service WebSocket and publish each parsed claude line
// through the per-thread event bus. Runs detached from the originating HTTP
// request: POST /chat returns 202 immediately and the consumer keeps going
// until the turn completes, fails, or the agent session exits. Subscribers
// (admin client) read events via /threads/:id/events SSE, which auto-replays
// from a per-turn ring buffer so a dropped or late-joining subscriber never
// loses content.
//
// Two callers:
// 1. New turn: `userMessage` is the prompt; we capture the current outputSeq
//    as the turn's start seq, call `onTurnStart(startSeq)`, then write stdin.
// 2. Initial spawn: `userMessage === null` (first turn was passed as the
//    initial prompt to spawnSessionRemote) — skip stdin write but still
//    record the turn-start seq.
//
// Returns a promise that resolves when the consumer finishes (clean done,
// exit, or error). Errors are surfaced as `turn_status: { kind: 'failed' }`
// events on the bus rather than thrown, so the caller can return 202 without
// awaiting completion.
export function runCosTurnConsumer(params: {
  agentSessionId: string;
  userMessage: string | null;
  /** turnId is the cosThreads.turnRequestId for this turn; used as the
   *  replay-buffer key + the discriminator on the bus so a single-thread
   *  subscriber can match events to the turn it just kicked off. */
  turnId: string;
  threadId: string;
  agentId: string | null;
  /** outputSeq snapshot captured by the caller before this consumer runs.
   *  Used as the WS replay boundary (everything > startSeq is "this turn")
   *  and as the seq emitted in `turn_status: started`. */
  startSeq: number;
  onAssistantText: (text: string, toolCalls: Map<string, { id: string; name: string; input: unknown; result?: string; error?: string }>, toolOrder: string[], images: { dataUrl: string; name?: string; mimeType?: string }[]) => void;
  onCapturedSessionId: (id: string) => void;
  onDone?: () => void;
}): Promise<void> {
  const {
    agentSessionId,
    userMessage,
    turnId,
    threadId,
    agentId,
    startSeq,
    onAssistantText,
    onCapturedSessionId,
    onDone,
  } = params;

  return new Promise<void>((resolve) => {
    let finished = false;
    let finalAssistantText = '';
    const finalToolCallsById = new Map<string, { id: string; name: string; input: unknown; result?: string; error?: string }>();
    const finalToolCallOrder: string[] = [];
    const finalImages: { dataUrl: string; name?: string; mimeType?: string }[] = [];
    // Defense-in-depth fallback for the long-reply PTY-wrap drop
    // (project_cos_long_reply_drop). Sessions are spawned with
    // --include-partial-messages, so claude emits per-token text_delta events
    // before the final assistant block. If the final block's JSON line is
    // wrapped/corrupted and fails JSON.parse, the deltas (each individually
    // short enough to often survive) can still reconstruct the assistant text.
    // Keyed by content-block index so multiple text blocks stay ordered.
    const deltaTextByIndex = new Map<number, string>();
    let capturedSessionId: string | null = null;
    let seqCursor = 0;

    const publishClaude = (seq: number, line: string) => {
      const ev: CosClaudeEvent = { threadId, turnId, seq, line };
      appendTurnReplay(ev);
      publishBusEvent(threadId, { kind: 'claude_event', payload: ev }, agentId);
    };
    const publishStatus = (status: CosTurnStatus) => {
      recordTurnFinalStatus(status);
      publishBusEvent(threadId, { kind: 'turn_status', payload: status }, agentId);
    };
    const finish = (exitCode: number, cancelled = false) => {
      if (finished) return;
      finished = true;
      if (!finalAssistantText && deltaTextByIndex.size > 0) {
        const sorted = Array.from(deltaTextByIndex.entries()).sort((a, b) => a[0] - b[0]);
        finalAssistantText = sorted.map(([, t]) => t).join('').trim();
      }
      onAssistantText(finalAssistantText, finalToolCallsById, finalToolCallOrder, finalImages);
      if (capturedSessionId) onCapturedSessionId(capturedSessionId);
      publishStatus({ kind: 'completed', threadId, turnId, exitCode, cancelled });
      // Hold the replay buffer briefly so a subscriber that connected just
      // after `completed` fired can still backfill missed events.
      setTimeout(() => clearTurnReplay(turnId), 30_000);
      onDone?.();
      resolve();
    };
    const fail = (error: string) => {
      if (finished) return;
      finished = true;
      publishStatus({ kind: 'failed', threadId, turnId, error });
      setTimeout(() => clearTurnReplay(turnId), 30_000);
      onDone?.();
      resolve();
    };

    // Parse a stream-json line and accumulate assistant content.
    //
    // Sessions run through a tmux-wrapped PTY (see session-service.ts), so
    // claude's stream-json stdout arrives interleaved with CSI/OSC escape
    // sequences + CR bytes. JSON.parse bails on that noise, which silently
    // drops the assistant reply and surfaces as "No response from Claude"
    // on the frontend even though the turn completed normally. Strip any
    // ANSI sequences + CRs before parsing.
    //
    // PTY-wrap fix: session-service now spawns stream profiles with a
    // very wide cols value, so tmux no longer hard-wraps long assistant
    // lines. As defense-in-depth, we also accumulate text_delta events
    // emitted by --include-partial-messages — each delta is short enough
    // to usually survive even if some future wrap regression appears, and
    // we only fall back to that text when the final assistant block was
    // never parsed. See memory note `project_cos_long_reply_drop.md`.
    const ANSI_RE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x2f]*[\x30-\x7e])/g;
    const processJsonLine = (line: string, seq: number): boolean => {
      const cleaned = line.replace(ANSI_RE, '').replace(/\r/g, '').trim();
      if (!cleaned) return false;
      if (cleaned.charCodeAt(0) !== 0x7b /* '{' */) return false;
      let obj: any;
      try { obj = JSON.parse(cleaned); } catch { return false; }
      publishClaude(seq, cleaned);
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
          let content: string;
          if (typeof raw === 'string') {
            content = raw;
          } else if (Array.isArray(raw)) {
            const textParts: string[] = [];
            for (const c of raw) {
              if (c?.type === 'image' && c?.source?.type === 'base64' && typeof c.source.data === 'string') {
                const mime = String(c.source.media_type || 'image/png');
                const filePath = (call.input as any)?.file_path;
                const name = typeof filePath === 'string' ? filePath.split('/').pop() : undefined;
                finalImages.push({ dataUrl: `data:${mime};base64,${c.source.data}`, name, mimeType: mime });
                textParts.push('[image attached]');
              } else if (typeof c?.text === 'string') {
                textParts.push(c.text);
              } else {
                textParts.push(JSON.stringify(c));
              }
            }
            content = textParts.join('\n');
          } else {
            content = JSON.stringify(raw);
          }
          if (content.length > 4000) content = `${content.slice(0, 4000)}…`;
          if (block.is_error) call.error = content; else call.result = content;
        }
      } else if (obj.type === 'stream_event' && obj.event) {
        // Partial-message events from --include-partial-messages. We only
        // collect text_delta as a fallback for finalAssistantText; tool calls
        // / inputs are reconciled from the canonical assistant block above.
        const event = obj.event;
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          const idx = typeof event.index === 'number' ? event.index : 0;
          deltaTextByIndex.set(idx, (deltaTextByIndex.get(idx) || '') + event.delta.text);
        }
      } else if (obj.type === 'result') {
        if (!finalAssistantText && obj.result) finalAssistantText = String(obj.result).trim();
        return true; // signal end of turn
      }
      return false;
    };

    (async () => {
      try {
        seqCursor = startSeq;

        publishStatus({
          kind: 'started',
          threadId,
          turnId,
          agentSessionId,
          startSeq,
          startedAt: Date.now(),
        });

        if (userMessage !== null) {
          const stdinPayload = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: userMessage }] },
          }) + '\n';
          await inputSessionRemote(agentSessionId, stdinPayload).catch((err) => {
            fail(`stdin write failed: ${String(err)}`);
          });
          if (finished) return;
        }

        const wsUrl = getSessionServiceWsUrl(agentSessionId);
        const ws = new WebSocket(wsUrl);
        let outputBuf = '';

        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'replay_request', fromSeq: startSeq + 1 }));
        });

        ws.on('message', (raw) => {
          if (finished) { ws.close(); return; }
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          const kind = msg?.content?.kind ?? msg?.kind;
          const data = typeof msg?.content?.data === 'string'
            ? msg.content.data
            : (typeof msg?.data === 'string' ? msg.data : null);
          const exitCode = msg?.content?.exitCode ?? msg?.exitCode;
          const exitStatus = msg?.content?.status ?? msg?.status;
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
            finish(exitCode ?? 0, exitStatus === 'killed');
          }
        });

        ws.on('error', (err) => {
          fail(String(err));
        });

        ws.on('close', () => {
          if (!finished) finish(0);
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}

// On server startup, recover any cosThreads marked in-flight (turnRequestId
// not null). The session-service keeps the underlying claude process alive
// across main-server restarts (tryRecoverSession), but the consumer that
// owned the WebSocket-to-session-service connection died with the old
// process. Without re-attaching, the assistant row would never land in DB.
// Spin up a fresh consumer per orphan that replays from turnStartSeq so the
// in-flight turn finishes cleanly and the per-thread /events SSE shows the
// missing content.
export async function recoverInFlightTurns(): Promise<void> {
  let orphans: typeof schema.cosThreads.$inferSelect[];
  try {
    orphans = await db.query.cosThreads.findMany({});
  } catch (err) {
    console.error('[cos] recoverInFlightTurns: failed to query threads:', err);
    return;
  }
  for (const thread of orphans) {
    if (!thread.turnRequestId || !thread.agentSessionId || thread.turnStartSeq == null) continue;
    // Confirm the underlying session is actually still running. If the
    // session-service couldn't recover it (e.g. tmux died), nuke the
    // in-flight metadata so the thread isn't permanently stuck.
    const live = await getSessionStatus(thread.agentSessionId).catch(() => null);
    if (!live?.active || live.status !== 'running') {
      db.update(schema.cosThreads).set({
        turnStartedAt: null,
        turnStartSeq: null,
        turnUserText: null,
        turnRequestId: null,
      }).where(eq(schema.cosThreads.id, thread.id)).run();
      console.log(`[cos] recoverInFlightTurns: cleared stale in-flight metadata for thread ${thread.id} (session not running)`);
      continue;
    }
    console.log(`[cos] recoverInFlightTurns: re-attaching turn ${thread.turnRequestId} on thread ${thread.id} (startSeq=${thread.turnStartSeq})`);
    const threadIdForCallbacks = thread.id;
    const agentSessionIdForCallbacks = thread.agentSessionId;
    const agentIdForCallbacks = thread.agentId;
    void runCosTurnConsumer({
      agentSessionId: agentSessionIdForCallbacks,
      userMessage: null,
      turnId: thread.turnRequestId,
      threadId: threadIdForCallbacks,
      agentId: agentIdForCallbacks,
      startSeq: thread.turnStartSeq,
      onAssistantText: (finalText, toolCallsById, toolOrder, images) => {
        // Always insert — see chief-of-staff.ts onAssistantText for rationale.
        // Empty-text rows are how we signal "turn finished" to the UI when
        // the parser dropped the assistant content (PTY width fragmentation,
        // tool-only turn, WS close before result).
        const now2 = Date.now();
        const toolCallsArr = toolOrder.map((id) => toolCallsById.get(id)).filter(Boolean);
        const attachmentsJson = images.length > 0 ? JSON.stringify({ images }) : null;
        db.insert(schema.cosMessages).values({
          id: ulid(), threadId: threadIdForCallbacks, role: 'assistant', text: finalText,
          toolCallsJson: toolCallsArr.length > 0 ? JSON.stringify(toolCallsArr) : null,
          attachmentsJson, createdAt: now2,
        }).run();
        db.update(schema.cosThreads).set({ updatedAt: now2 }).where(eq(schema.cosThreads.id, threadIdForCallbacks)).run();
      },
      onCapturedSessionId: (sid) => {
        db.update(schema.cosThreads).set({ claudeSessionId: sid }).where(eq(schema.cosThreads.id, threadIdForCallbacks)).run();
        db.update(schema.agentSessions).set({ claudeSessionId: sid }).where(eq(schema.agentSessions.id, agentSessionIdForCallbacks)).run();
      },
      onDone: () => {
        db.update(schema.cosThreads).set({
          turnStartedAt: null,
          turnStartSeq: null,
          turnUserText: null,
          turnRequestId: null,
        }).where(eq(schema.cosThreads.id, thread.id)).run();
      },
    }).catch((err) => {
      console.error(`[cos] recoverInFlightTurns: consumer crashed for thread ${threadIdForCallbacks}:`, err);
    });
  }
}
