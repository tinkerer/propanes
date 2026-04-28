import { useEffect, useRef, useState, useMemo } from 'preact/hooks';
import { MessageRenderer, type ChatRenderOpts } from './MessageRenderer.js';
import { type ParsedMessage } from '../lib/output-parser.js';
import { useTranscriptStream } from '../lib/transcript-stream.js';
import { api } from '../lib/api.js';
import { sessionInputStates } from '../lib/session-state.js';
import { isMobile, NarrowContext, useContainerNarrow, useNarrow } from '../lib/viewport.js';
import { ChoicePrompt, type ChoiceOption } from './InteractivePrompt.js';
import { SubagentBlock } from './SubagentBlock.js';

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

export interface MessageGroup {
  id: string;
  messages: ParsedMessage[];
  role: 'assistant_group' | 'user_input' | 'standalone';
}

export interface PartitionedMessages {
  // Messages from the main agent (no `_subagentId` tag).
  main: ParsedMessage[];
  // Subagent messages keyed by agentId, in arrival order.
  subagents: Map<string, ParsedMessage[]>;
  // Map main-agent tool_use_id → subagent agentId, derived from the
  // matching Task tool_result's `toolUseResult.agentId`.
  toolUseIdToAgentId: Map<string, string>;
  // Subagents whose agentId never appeared in any main tool_result.
  // The renderer should append these at the end.
  orphanSubagentIds: string[];
}

export function partitionMergedMessages(messages: ParsedMessage[]): PartitionedMessages {
  const main: ParsedMessage[] = [];
  const subagents = new Map<string, ParsedMessage[]>();
  const toolUseIdToAgentId = new Map<string, string>();
  const linkedAgentIds = new Set<string>();

  for (const msg of messages) {
    if (msg.subagentId) {
      const arr = subagents.get(msg.subagentId);
      if (arr) arr.push(msg);
      else subagents.set(msg.subagentId, [msg]);
      continue;
    }
    main.push(msg);
    if (msg.role === 'tool_result' && msg.toolUseResultId && msg.subagentLink) {
      toolUseIdToAgentId.set(msg.toolUseResultId, msg.subagentLink);
      linkedAgentIds.add(msg.subagentLink);
    }
  }

  const orphanSubagentIds: string[] = [];
  for (const agentId of subagents.keys()) {
    if (!linkedAgentIds.has(agentId)) orphanSubagentIds.push(agentId);
  }

  return { main, subagents, toolUseIdToAgentId, orphanSubagentIds };
}

export function groupMessages(messages: ParsedMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: ParsedMessage[] | null = null;

  for (const msg of messages) {
    const isAssistantLike = msg.role === 'assistant' || msg.role === 'tool_use' || msg.role === 'tool_result' || msg.role === 'thinking';

    if (isAssistantLike) {
      if (!currentGroup) {
        currentGroup = [msg];
      } else {
        currentGroup.push(msg);
      }
    } else {
      if (currentGroup) {
        groups.push({ id: currentGroup[0].id, messages: currentGroup, role: 'assistant_group' });
        currentGroup = null;
      }
      groups.push({ id: msg.id, messages: [msg], role: msg.role === 'user_input' ? 'user_input' : 'standalone' });
    }
  }

  if (currentGroup) {
    groups.push({ id: currentGroup[0].id, messages: currentGroup, role: 'assistant_group' });
  }

  return groups;
}

function shortenModelName(model: string): string | null {
  if (!model || model.startsWith('<')) return null;
  const parts = model.split('-');
  let version: string | null = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const major = parseInt(parts[i]);
    const minor = parseInt(parts[i + 1]);
    if (!isNaN(major) && !isNaN(minor) && parts[i + 1].length < 8) {
      version = `${major}.${minor}`;
      break;
    }
  }
  if (model.includes('opus')) return version ? `Opus ${version}` : 'Opus';
  if (model.includes('sonnet')) return version ? `Sonnet ${version}` : 'Sonnet';
  if (model.includes('haiku')) return version ? `Haiku ${version}` : 'Haiku';
  return parts[0];
}

export function AssistantGroupHeader({
  messages,
  collapsed,
  onToggle,
}: {
  messages: ParsedMessage[];
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  let model = '';
  let totalInput = 0;
  let totalOutput = 0;
  let toolCount = 0;
  let firstTs = 0;
  let lastTs = 0;

  for (const msg of messages) {
    if (msg.model && !model) model = msg.model;
    if (msg.usage) {
      totalInput += msg.usage.input_tokens || 0;
      totalOutput += msg.usage.output_tokens || 0;
    }
    if (msg.role === 'tool_use') toolCount++;
    if (msg.timestamp) {
      if (!firstTs || msg.timestamp < firstTs) firstTs = msg.timestamp;
      if (msg.timestamp > lastTs) lastTs = msg.timestamp;
    }
  }

  const shortModel = model ? shortenModelName(model) : null;
  const hasTokens = totalInput > 0 || totalOutput > 0;
  const toggleable = !!onToggle;
  const timeLabel = formatTurnTime(firstTs, lastTs);
  // Always render when toggleable so the user has a handle to expand an
  // empty-ish group header — otherwise groups with no model/tokens/tools
  // would have no click target.
  if (!toggleable && !shortModel && !hasTokens && toolCount === 0) return null;

  return (
    <div
      class={`sm-group-header${toggleable ? ' sm-group-header-toggle' : ''}${collapsed ? ' sm-group-header-collapsed' : ''}`}
      onClick={toggleable ? onToggle : undefined}
      role={toggleable ? 'button' : undefined}
      tabIndex={toggleable ? 0 : undefined}
      onKeyDown={toggleable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.(); }
      } : undefined}
    >
      {toggleable && <span class="sm-group-caret">{collapsed ? '▸' : '▾'}</span>}
      {shortModel && <span class="sm-group-model" title={model}>{shortModel}</span>}
      {toolCount > 0 && (
        <span class="sm-group-tools">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
      )}
      {hasTokens && (
        <span class="sm-group-tokens" title={`Input: ${totalInput} | Output: ${totalOutput}`}>
          {totalInput.toLocaleString()}↓ {totalOutput.toLocaleString()}↑
        </span>
      )}
      {timeLabel && (
        <span class="sm-group-time" title={firstTs ? new Date(firstTs).toLocaleString() : undefined}>
          {timeLabel}
        </span>
      )}
      {toggleable && collapsed && (
        <span class="sm-group-collapsed-hint">collapsed</span>
      )}
    </div>
  );
}

// Format the turn's wall-clock time. If the turn spans more than 2s, show the
// duration too — long turns are useful to spot. Anything within 2s of "now"
// is treated as a fresh live-stream message and gets no time stamp (the user
// is watching it happen).
function formatTurnTime(firstTs: number, lastTs: number): string | null {
  if (!firstTs) return null;
  if (Math.abs(Date.now() - firstTs) < 2000) return null;
  const d = new Date(firstTs);
  if (isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const base = `${hh}:${mm}:${ss}`;
  const dur = lastTs - firstTs;
  if (dur < 2000) return base;
  const secs = Math.round(dur / 1000);
  if (secs < 60) return `${base} · ${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSec = secs % 60;
  return `${base} · ${mins}m${remSec ? ` ${remSec}s` : ''}`;
}

function AssistantGroup({
  group,
  lastGroupMsg,
  askingForInput,
  pendingTool,
  sessionId,
  subagentLookup,
  chat,
}: {
  group: MessageGroup;
  lastGroupMsg: ParsedMessage;
  askingForInput: boolean;
  pendingTool: ParsedMessage | null;
  sessionId: string;
  subagentLookup?: {
    subagents: Map<string, ParsedMessage[]>;
    toolUseIdToAgentId: Map<string, string>;
  };
  chat?: ChatRenderOpts;
}) {
  const toolCount = group.messages.filter(m => m.role === 'tool_use').length;
  const narrow = useNarrow();
  // In narrow containers, collapse tools by default above 2 — a 4-tool cutoff
  // still wall-papers the viewport when the pane is 350px wide. Chat mode is
  // always narrow visually, so use the narrow cutoff there too.
  const toolCollapseCutoff = (chat || narrow) ? 2 : 4;
  const defaultCollapsed = toolCount > toolCollapseCutoff;
  const [toolsCollapsed, setToolsCollapsed] = useState(defaultCollapsed);
  const [groupCollapsed, setGroupCollapsed] = useState(false);

  return (
    <div class={`sm-group sm-group-assistant_group${groupCollapsed ? ' sm-group-collapsed' : ''}${chat ? ' sm-group-chat' : ''}`}>
      {!chat && (
        <AssistantGroupHeader
          messages={group.messages}
          collapsed={groupCollapsed}
          onToggle={() => setGroupCollapsed(c => !c)}
        />
      )}
      {!groupCollapsed && toolCount > toolCollapseCutoff && (
        <button
          class="sm-tools-toggle"
          onClick={() => setToolsCollapsed(c => !c)}
        >
          {toolsCollapsed ? `▸ ${toolCount} tool calls` : '▾ hide tools'}
        </button>
      )}
      {!groupCollapsed && group.messages.map((msg, idx) => {
        const isTool = msg.role === 'tool_use' || msg.role === 'tool_result';
        if (isTool && toolsCollapsed) return null;
        const isInteractive = askingForInput && msg === lastGroupMsg && msg === pendingTool;
        const renderedMsg = (
          <MessageRenderer
            key={msg.id}
            message={msg}
            messages={group.messages}
            index={idx}
            sessionId={sessionId}
            interactive={isInteractive}
            chat={chat}
          />
        );
        // Inline subagent transcript right after the call that spawned it.
        // Match by toolUseId rather than name — Anthropic's SDK calls this
        // tool either "Task" or "Agent" depending on the version.
        if (subagentLookup && msg.role === 'tool_use' && msg.toolUseId) {
          const agentId = subagentLookup.toolUseIdToAgentId.get(msg.toolUseId);
          const subMsgs = agentId ? subagentLookup.subagents.get(agentId) : null;
          if (agentId && subMsgs && subMsgs.length > 0) {
            return (
              <>
                {renderedMsg}
                <SubagentBlock
                  key={`sub-${agentId}`}
                  agentId={agentId}
                  messages={subMsgs}
                  taskInput={msg.toolInput}
                />
              </>
            );
          }
        }
        return renderedMsg;
      })}
    </div>
  );
}

export function StructuredView({ sessionId, chat }: Props) {
  const [choicePrompt, setChoicePrompt] = useState<DetectedChoicePrompt | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerNarrow = useContainerNarrow(containerRef);
  const narrow = isMobile.value || containerNarrow;
  const autoScroll = useRef(true);

  const inputState = sessionInputStates.value.get(sessionId) || 'active';
  const isWaiting = inputState === 'waiting';

  const { messages, loading, error, isSessionDone, isRunning } = useTranscriptStream(sessionId);

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

  useEffect(() => {
    if (autoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  const initialWindow = isMobile.value ? MOBILE_INITIAL_WINDOW : DESKTOP_INITIAL_WINDOW;
  const [shownCount, setShownCount] = useState(initialWindow);

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

  // Partition out subagent messages so they can be rendered inline at the
  // Task call that spawned them — without this, Claude dumps every subagent
  // message after the main agent's stream and the main flow is buried.
  const partitioned = useMemo(() => partitionMergedMessages(messages), [messages]);
  const mainMessages = partitioned.main;

  const hiddenMsgCount = Math.max(0, mainMessages.length - shownCount);
  const groups = useMemo(
    () => groupMessages(hiddenMsgCount > 0 ? mainMessages.slice(-shownCount) : mainMessages),
    [mainMessages, shownCount, hiddenMsgCount]
  );

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
    <div class={`structured-view${narrow ? ' structured-view-narrow' : ''}`} ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div class="sm-empty">No messages yet</div>
      )}
      {hiddenMsgCount > 0 && (
        <button
          class="sm-show-earlier"
          onClick={() => setShownCount((n) => n + initialWindow)}
        >
          Show {Math.min(hiddenMsgCount, initialWindow)} earlier message{Math.min(hiddenMsgCount, initialWindow) === 1 ? '' : 's'} ({hiddenMsgCount} hidden)
        </button>
      )}
      {groups.map(group => {
        const lastGroupMsg = group.messages[group.messages.length - 1];
        if (group.role === 'assistant_group') {
          return (
            <AssistantGroup
              key={group.id}
              group={group}
              lastGroupMsg={lastGroupMsg}
              askingForInput={askingForInput}
              pendingTool={pendingTool}
              sessionId={sessionId}
              subagentLookup={partitioned}
              chat={chat}
            />
          );
        }
        return (
          <div key={group.id} class={`sm-group sm-group-${group.role}${chat ? ' sm-group-chat' : ''}`}>
            {group.messages.map((msg, idx) => {
              const isInteractive = askingForInput && msg === lastGroupMsg && msg === pendingTool;
              return (
                <MessageRenderer
                  key={msg.id}
                  message={msg}
                  messages={group.messages}
                  index={idx}
                  sessionId={sessionId}
                  interactive={isInteractive}
                  chat={chat}
                />
              );
            })}
          </div>
        );
      })}
      {partitioned.orphanSubagentIds.length > 0 && (
        <div class="sm-subagent-orphans">
          {partitioned.orphanSubagentIds.map((agentId) => {
            const subMsgs = partitioned.subagents.get(agentId) || [];
            return (
              <SubagentBlock
                key={`orphan-${agentId}`}
                agentId={agentId}
                messages={subMsgs}
              />
            );
          })}
        </div>
      )}
      {isWaiting && choicePrompt && !askingForInput && (
        <ChoicePrompt
          sessionId={sessionId}
          title={choicePrompt.title}
          prompt={choicePrompt.prompt}
          choices={choicePrompt.choices}
          onSubmitted={() => setChoicePrompt(null)}
        />
      )}
      {pendingTool && !askingForInput && (
        <div class="sm-pending-approval">
          <span class="sm-pending-icon">⚙️</span>
          <span class="sm-pending-text">
            Running: <strong>{pendingTool.toolName || 'tool call'}</strong>
          </span>
        </div>
      )}
    </div>
    </NarrowContext.Provider>
  );
}
