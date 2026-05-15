import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'preact/hooks';
import { type ChatRenderOpts } from './MessageRenderer.js';
import { useTranscriptStream } from '../../lib/transcript-stream.js';
import { useScrollAnchor } from '../../lib/use-scroll-anchor.js';
import { api } from '../../lib/api.js';
import { sessionInputStates } from '../../lib/session-state.js';
import { isMobile, NarrowContext, useContainerNarrow } from '../../lib/viewport.js';
import { ChoicePrompt, type ChoiceOption } from './InteractivePrompt.js';
import {
  groupMessages,
  partitionMergedMessages,
  AssistantGroupHeader,
  formatTurnTime,
  shortenModelName,
  type MessageGroup,
  type PartitionedMessages,
} from '../../lib/conversation.js';
import { ConversationView } from '../conversation/ConversationView.js';

// Re-export for backward compatibility — other files import these from StructuredView.
export { groupMessages, partitionMergedMessages, AssistantGroupHeader, formatTurnTime, shortenModelName };
export type { MessageGroup, PartitionedMessages };

// Initial window size — on mobile we render only the most recent N groups
// to keep first paint cheap; user can expand earlier history on demand.
// Without this, sessions with 150+ tool calls block iPhone Safari for several
// seconds during initial render and the page appears frozen on the
// "Loading JSONL..." → blank flash.
const MOBILE_INITIAL_WINDOW = 30;
const DESKTOP_INITIAL_WINDOW = 200;

interface Props {
  sessionId: string;
  isActive?: boolean;
  permissionProfile?: string;
  /** When set, render in compact chat-mode (collapse tool pairs, hide
   *  thinking/system, run assistant text through textFilter). Used by the
   *  Chief-of-Staff bubble; full session log viewer omits this. */
  chat?: ChatRenderOpts;
}

interface DetectedChoicePrompt {
  title: string;
  prompt: string;
  choices: ChoiceOption[];
}

// Scan the tail of captured terminal output for a Claude CLI permission prompt.
// Claude presents:
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again this session
//     3. No, and tell Claude what to do differently (esc)
// Returns null if no numbered-choice prompt is detected near the tail.
function detectChoicePrompt(content: string): DetectedChoicePrompt | null {
  if (!content) return null;
  // Strip ANSI escapes.
  const clean = content
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  const tail = clean.slice(-3000);
  const lines = tail.split('\n').map(l => l.replace(/^\s*[❯>*]\s?/, '').trimEnd());

  const optionRe = /^\s*(\d+)\.\s+(.+?)\s*$/;
  // Find the longest contiguous tail block of numbered options.
  let endIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (optionRe.test(lines[i])) { endIdx = i; break; }
    if (lines[i].trim() !== '') break;
  }
  if (endIdx < 0) return null;

  let startIdx = endIdx;
  const options: { num: string; label: string }[] = [];
  while (startIdx >= 0) {
    const m = lines[startIdx].match(optionRe);
    if (!m) break;
    options.unshift({ num: m[1], label: m[2].replace(/\s*\(esc\)\s*$/, '').trim() });
    startIdx--;
  }
  if (options.length < 2) return null;

  // Look backward for a prompt line before the options.
  let promptLine = '';
  let title = 'Permission required';
  for (let i = startIdx; i >= Math.max(0, startIdx - 6); i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/\?$/.test(t) || /proceed|allow|approve|continue|run\b/i.test(t)) {
      promptLine = t;
      // Look one more line back for a title hint.
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const tt = lines[j].trim();
        if (tt && !optionRe.test(tt)) { title = tt.slice(0, 120); break; }
      }
      break;
    }
  }
  if (!promptLine) return null;

  const choices: ChoiceOption[] = options.map(o => {
    const lower = o.label.toLowerCase();
    let kind: ChoiceOption['kind'] = 'neutral';
    if (/^no\b|deny|reject|don'?t/.test(lower)) kind = 'deny';
    else if (/session|always|all/.test(lower)) kind = 'approve-all';
    else if (/^yes\b|allow|approve|proceed/.test(lower)) kind = 'approve';
    return { label: o.label, keys: o.num, kind };
  });

  return { title, prompt: promptLine, choices };
}

export function StructuredView({ sessionId, chat }: Props) {
  const [choicePrompt, setChoicePrompt] = useState<DetectedChoicePrompt | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerNarrow = useContainerNarrow(containerRef);
  const narrow = isMobile.value || containerNarrow;

  const inputState = sessionInputStates.value.get(sessionId) || 'active';
  const isWaiting = inputState === 'waiting';

  const { messages, loading, error, isSessionDone, isRunning } = useTranscriptStream(sessionId);

  const { setRef: setScrollRef, showScrollDown, scrollToBottom } = useScrollAnchor({
    resetKey: sessionId,
    contentDeps: [messages.length],
  });

  // Combine refs: useContainerNarrow needs containerRef, useScrollAnchor needs setScrollRef.
  const setCombinedRef = (el: HTMLDivElement | null) => {
    (containerRef as any).current = el;
    setScrollRef(el);
  };

  // When the session is waiting for input, poll the captured terminal output
  // for permission-prompt patterns and surface them as a ChoicePrompt card.
  // Skip while JSONL is still loading: the ChoicePrompt renders alongside the
  // message stream, and there's no point burning regex cycles against 10KB of
  // terminal buffer every 1.5s when there are no messages on screen anyway.
  useEffect(() => {
    if (!isWaiting || loading) { setChoicePrompt(null); return; }
    let cancelled = false;
    const scan = async () => {
      try {
        const result = await api.capturePane(sessionId, { lastN: 3000 });
        if (cancelled) return;
        if (result.ok && result.content) {
          setChoicePrompt(detectChoicePrompt(result.content));
        } else {
          setChoicePrompt(null);
        }
      } catch {
        if (!cancelled) setChoicePrompt(null);
      }
    };
    scan();
    const interval = setInterval(() => { if (!document.hidden) scan(); }, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId, isWaiting, loading]);

  const initialWindow = isMobile.value ? MOBILE_INITIAL_WINDOW : DESKTOP_INITIAL_WINDOW;
  const [shownCount, setShownCount] = useState(initialWindow);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  // Captured just before shownCount expands so we can anchor the scroll
  // position after re-render — without this, prepending earlier messages
  // shoves the visible content downward by the prepended height.
  const scrollAnchorRef = useRef<{ height: number; top: number } | null>(null);

  // Window by raw messages, then group. Some sessions pack 100+ tool calls
  // into one assistant group, so windowing by group leaves all of them on
  // screen. Slicing messages first keeps initial render bounded regardless
  // of group shape. We window over main-only messages so the count reflects
  // what's actually visible (subagent transcripts are rendered inline as
  // collapsibles, not counted toward the main window).
  useEffect(() => {
    const total = messages.filter((m) => !m.subagentId).length;
    setShownCount((prev) => {
      if (prev > initialWindow) return Math.min(prev, total);
      return Math.min(initialWindow, total);
    });
  }, [messages, initialWindow]);

  function loadMoreEarlier() {
    const el = containerRef.current;
    if (el) scrollAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingEarlier(true);
    // rAF so the spinner paints before the heavy expansion + grouping pass.
    requestAnimationFrame(() => {
      setShownCount((n) => n + initialWindow);
      requestAnimationFrame(() => setLoadingEarlier(false));
    });
  }

  // Restore the user's visual scroll position after earlier messages have
  // been prepended. Runs synchronously after layout so the operator never
  // sees the content jump downward.
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    const el = containerRef.current;
    if (!anchor || !el) return;
    const delta = el.scrollHeight - anchor.height;
    if (delta > 0) el.scrollTop = anchor.top + delta;
    scrollAnchorRef.current = null;
  }, [shownCount]);

  // IntersectionObserver: fire load-more when the sentinel near the top of
  // the scroll container enters view. rootMargin lets us start loading a bit
  // before the user actually hits the top, smoothing the experience.
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = containerRef.current;
    if (!sentinel || !root) return;
    if (loadingEarlier) return;
    if (shownCount >= messages.filter((m) => !m.subagentId).length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loadingEarlier) loadMoreEarlier();
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [shownCount, messages, loadingEarlier]);

  // Partition out subagent messages so they can be rendered inline at the
  // Task call that spawned them — without this, Claude dumps every subagent
  // message after the main agent's stream and the main flow is buried.
  const partitioned = useMemo(() => partitionMergedMessages(messages), [messages]);
  const mainMessages = partitioned.main;

  const hiddenMsgCount = Math.max(0, mainMessages.length - shownCount);

  // Build the windowed message list for ConversationView: the visible slice
  // of main messages plus all subagent messages (ConversationView partitions
  // them internally and renders subagents inline at their parent tool call).
  const windowedMessages = useMemo(() => {
    const windowed = hiddenMsgCount > 0 ? mainMessages.slice(-shownCount) : mainMessages;
    const subMsgs = messages.filter(m => m.subagentId);
    if (subMsgs.length === 0) return windowed;
    return [...windowed, ...subMsgs];
  }, [messages, mainMessages, shownCount, hiddenMsgCount]);

  if (loading) {
    const msg = isSessionDone
      ? 'Loading JSONL...'
      : isRunning
        ? 'Session running, waiting for output...'
        : 'Waiting for agent to start...';
    // Visible pulse so mobile users see the page is alive while polling —
    // without it, "Session running, waiting for output..." looks identical
    // to a frozen browser.
    return (
      <div class="structured-view">
        <div class="sm-empty sm-empty-loading">
          <span class="sm-loading-dot" />
          {msg}
        </div>
      </div>
    );
  }

  if (error) {
    return <div class="structured-view"><div class="sm-empty" style="color: #f87171">{error}</div></div>;
  }

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingTool = lastMsg?.role === 'tool_use' ? lastMsg : null;
  const askingForInput = isWaiting && pendingTool?.toolName === 'AskUserQuestion';

  return (
    <NarrowContext.Provider value={narrow}>
    <div class="structured-view-wrap">
    <div class={`structured-view${narrow ? ' structured-view-narrow' : ''}`} ref={setCombinedRef}>
      {messages.length === 0 && (
        <div class="sm-empty">No messages yet</div>
      )}
      {hiddenMsgCount > 0 && (
        <div class="sm-load-more" ref={loadMoreSentinelRef}>
          {loadingEarlier ? (
            <div class="sm-load-spinner" role="status" aria-label="Loading earlier messages">
              <span class="sm-load-spinner-dot" />
              <span class="sm-load-spinner-dot" />
              <span class="sm-load-spinner-dot" />
            </div>
          ) : (
            <button
              type="button"
              class="sm-show-earlier"
              onClick={loadMoreEarlier}
              title="Or scroll up to auto-load"
            >
              Pull / scroll for {Math.min(hiddenMsgCount, initialWindow)} more ({hiddenMsgCount} earlier)
            </button>
          )}
        </div>
      )}
      <ConversationView
        messages={windowedMessages}
        sessionId={sessionId}
        mode="structured"
        chat={chat}
        isWaiting={isWaiting}
      />
      {isWaiting && choicePrompt && !askingForInput && (
        <ChoicePrompt
          sessionId={sessionId}
          title={choicePrompt.title}
          prompt={choicePrompt.prompt}
          choices={choicePrompt.choices}
          onSubmitted={() => setChoicePrompt(null)}
        />
      )}
    </div>
    {showScrollDown && (
      <button
        type="button"
        class="cos-scroll-down-btn"
        onClick={() => scrollToBottom('auto')}
        title="Scroll to latest"
        aria-label="Scroll to latest message"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    )}
    </div>
    </NarrowContext.Provider>
  );
}
