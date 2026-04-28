import { useEffect, useRef, useState } from 'preact/hooks';
import { JsonOutputParser, CodexOutputParser, type ParsedMessage } from './output-parser.js';
import { api } from './api.js';
import { allSessions, exitedSessions } from './sessions.js';
import { isMobile } from './viewport.js';

const TERMINAL_STATUSES = new Set(['completed', 'exited', 'failed', 'deleted', 'archived']);

export interface UseTranscriptStreamOpts {
  /** When set, pass `?file=` to the JSONL endpoint to filter to one transcript
   *  file (main / continuation / subagent). null/undefined = merged stream. */
  fileFilter?: string | null;
  /** Override the polling interval (ms). Defaults: 3000 desktop / 5000 mobile.
   *  Pass 0 to disable polling entirely (one-shot fetch). */
  pollMs?: number;
  /** Override the tail line cap. Defaults: 0 (full file) desktop, 500 mobile. */
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
 *  - On mobile we tail the file and poll less aggressively; multi-MB JSONL
 *    parses freeze Safari.
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
  const lastLength = useRef(0);
  const lastFileFilter = useRef<string | null | undefined>(undefined);

  const sessionRecord = allSessions.value.find((s: any) => s.id === sessionId);
  const terminalStatus = sessionRecord?.status && TERMINAL_STATUSES.has(sessionRecord.status);
  const isSessionDone = exitedSessions.value.has(sessionId) || !!terminalStatus;
  const isRunning = sessionRecord?.status === 'running';
  const runtime = sessionRecord?.runtime;

  const fileFilter = opts.fileFilter ?? null;
  const tailLines = opts.tailLines ?? (isMobile.value ? 500 : 0);
  const pollMs = opts.pollMs ?? (isMobile.value ? 5000 : 3000);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    // Reset on identity change so the previous session's tail doesn't bleed
    // into the new one mid-fetch.
    lastLength.current = 0;
    lastFileFilter.current = fileFilter;
    setMessages([]);
    setLoading(true);
    setError(null);

    const fetchJsonl = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (fileFilter !== lastFileFilter.current) {
          lastFileFilter.current = fileFilter;
          lastLength.current = 0;
        }
        const text = await api.getJsonl(sessionId, fileFilter || undefined, tailLines);
        if (cancelled) return;
        if (text.length === lastLength.current) {
          setLoading(false);
          return;
        }
        lastLength.current = text.length;
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
