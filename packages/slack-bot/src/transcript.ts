/** Turn the structured view's differential transcript polls into an ordered
 * event stream. Reuses the admin parsers (claude stream-json / transcript
 * JSONL, codex rollouts) so Slack sees exactly what the structured view
 * renders — never terminal tails or ANSI. */
import { createHash } from 'node:crypto';
import { JsonOutputParser, type ParsedMessage } from '../../admin/src/lib/output-parser.js';
import { CodexOutputParser } from '../../admin/src/lib/codex-output-parser.js';
import type { Runtime } from './options';
import type { JsonlDelta } from './propanes';

export type { ParsedMessage };

export interface TranscriptEvent {
  /** Stable across restarts: the JSONL line's uuid (claude) or a content hash. */
  key: string;
  msg: ParsedMessage;
}

export class TranscriptFollower {
  private parser: JsonOutputParser | CodexOutputParser;
  /** tool_use id → tool_use message, so results and images can name their tool. */
  readonly toolUses = new Map<string, ParsedMessage>();
  /** Role of the main agent's most recent event (a trailing tool_use = still busy). */
  lastMainRole: ParsedMessage['role'] | null = null;
  /** Most recent tool call, for "waiting for input" context. */
  lastToolUse: ParsedMessage | null = null;

  constructor(private readonly runtime: Runtime) {
    this.parser = runtime === 'codex' ? new CodexOutputParser() : new JsonOutputParser();
  }

  ingest(delta: JsonlDelta): TranscriptEvent[] {
    if (delta.pending) return [];
    if (delta.reset) {
      this.parser = this.runtime === 'codex' ? new CodexOutputParser() : new JsonOutputParser();
    }
    const byKey = new Map(delta.files.map((f) => [f.key, f.lines]));
    const order = delta.order.length ? delta.order : delta.files.map((f) => f.key);
    const events: TranscriptEvent[] = [];
    for (const fileKey of order) {
      const text = byKey.get(fileKey);
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const lineKey = `${fileKey}:${lineId(line)}`;
        const msgs = this.parser.feed(line + '\n');
        msgs.forEach((msg, i) => {
          if (msg.role === 'tool_use') {
            if (msg.toolUseId) this.toolUses.set(msg.toolUseId, msg);
            this.lastToolUse = msg;
          }
          if (!msg.subagentId) this.lastMainRole = msg.role;
          events.push({ key: `${lineKey}:${i}`, msg });
        });
      }
    }
    return events;
  }
}

function lineId(line: string): string {
  const m = /"uuid":"([A-Za-z0-9_-]{8,})"/.exec(line);
  if (m) return m[1];
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}
