import { useEffect, useRef, useState } from 'preact/hooks';
import { JsonOutputParser, CodexOutputParser, type ParsedMessage } from './output-parser.js';
import { api } from './api.js';
import { allSessions, exitedSessions } from './sessions.js';
import { isMobile } from './viewport.js';

const TERMINAL_STATUSES = new Set(['completed', 'exited', 'failed', 'deleted', 'archived', 'killed']);

export interface UseTranscriptStreamOpts {
  /** When set, pass `?file=` to the JSONL endpoint to filter to one transcript
   *  file (main / continuation / subagent). null/undefined = merged stream. */
  fileFilter?: string | null;
  /** Override the polling interval (ms). Defaults: 3000 desktop / 5000 mobile.
   *  Pass 0 to disable polling entirely (one-shot fetch). */
  pollMs?: number;
  /** Override the tail line cap, applied to the initial snapshot (subsequent
   *  differential polls only carry new lines anyway). Defaults: 0 (full
   *  history) desktop, 500 mobile. */
  tailLines?: number;
}

export interface TranscriptStreamState {
  messages: ParsedMessage[];
  loading: boolean;
  error: string | null;
  /** Session has reached a terminal status (no more JSONL lines will arrive). */
  isSessionDone: boolean;
  /** Session is actively running. */
  isRunning: boolean;
}

/** Subscribe to a session's JSONL transcript and keep parsing it as new lines
 *  arrive. Single source of truth for both `JsonlView` and `StructuredView` —
 *  the bubble's CoS feed will consume this too once we route assistant text
 *  through the JSONL stream instead of cosMessages.
 *
 *  Notes that earned their way into the consolidated implementation:
 *  - JSONL is missing for the first few seconds while the agent spins up.
 *    A 404 isn't an error then; it's "not written yet". 400 happens for
 *    sessions with no resolvable project_dir (plain terminals) — also benign.
 *  - On mobile we tail the initial snapshot and poll less aggressively;
 *    multi-MB JSONL parses freeze Safari.
 *  - Polls are differential: an opaque per-file byte-offset cursor is sent
 *    back to the server, which returns only newly appended lines. The merged
 *    transcript is rebuilt locally from per-file buffers because subagent
 *    lines interleave mid-stream (the merge is not append-only).
 *  - In-flight guard prevents request stacking on slow servers — the JSONL
 *    endpoint walks all continuations + subagents per call.
 */
export function useTranscriptStream(
  sessionId: string,
  opts: UseTranscriptStreamOpts = {}
): TranscriptStreamState {
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Differential-update state: per-file line buffers + the server's merge
  // order + the opaque cursor. The merged transcript is rebuilt locally from
  // these, so each poll only downloads lines appended since the last one.
  const buffers = useRef<Map<string, string>>(new Map());
  const order = useRef<string[]>([]);
  const cursor = useRef<string | null>(null);

  const sessionRecord = allSessions.value.find((s: any) => s.id === sessionId);
  const terminalStatus = sessionRecord?.status && TERMINAL_STATUSES.has(sessionRecord.status);
  const isSessionDone = exitedSessions.value.has(sessionId) || !!terminalStatus;
  const isRunning = sessionRecord?.status === 'running' || sessionRecord?.status === 'pending';
  const runtime = sessionRecord?.runtime;

  const fileFilter = opts.fileFilter ?? null;
  const tailLines = opts.tailLines ?? (isMobile.value ? 500 : 0);
  const pollMs = opts.pollMs ?? (isMobile.value ? 5000 : 3000);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    // Reset on identity change so the previous session's tail doesn't bleed
    // into the new one mid-fetch.
    buffers.current = new Map();
    order.current = [];
    cursor.current = null;
    setMessages([]);
    setLoading(true);
    setError(null);

    const fetchJsonl = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const delta = await api.getJsonlDelta(sessionId, {
          fileFilter: fileFilter || undefined,
          tail: tailLines,
          cursor: cursor.current,
        });
        if (cancelled) return;
        cursor.current = delta.cursor;
        order.current = delta.order;
        if (delta.reset) buffers.current = new Map();
        for (const f of delta.files) {
          const prev = buffers.current.get(f.key);
          buffers.current.set(f.key, prev ? prev + '\n' + f.lines : f.lines);
        }
        if (!delta.reset && delta.files.length === 0) {
          // Nothing appended since the last poll — keep the current parse.
          setLoading(false);
          return;
        }
        const text = order.current
          .map(k => buffers.current.get(k))
          .filter(Boolean)
          .join('\n');
        const parser = runtime === 'codex'
          ? new CodexOutputParser()
          : new JsonOutputParser();
        parser.feed(text + '\n');
        setMessages(parser.getMessages());
        setError(null);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.status;
        const isMissing = status === 404 || status === 400;
        // For a still-running session, "no JSONL yet" is the loading state,
        // not an error. For a done session, surface an empty view rather
        // than a red error wall.
        if (isMissing && !isSessionDone) {
          setLoading(true);
          setError(null);
        } else if (isMissing) {
          setError(null);
          setLoading(false);
        } else {
          setError(err?.message || String(err));
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };

    fetchJsonl();
    if (isSessionDone || pollMs <= 0) {
      return () => { cancelled = true; };
    }
    const interval = setInterval(() => { if (!document.hidden) fetchJsonl(); }, pollMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId, fileFilter, tailLines, pollMs, isSessionDone, runtime]);

  return { messages, loading, error, isSessionDone, isRunning };
}
