import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MessageRenderer } from './MessageRenderer.js';
import { groupMessages, AssistantGroupHeader, partitionMergedMessages } from './StructuredView.js';
import { SubagentBlock } from './SubagentBlock.js';
import { InterruptBar } from './InterruptBar.js';
import { type ParsedMessage } from '../lib/output-parser.js';
import { useTranscriptStream } from '../lib/transcript-stream.js';
import { getJsonlSelectedFile, jsonlSelectedFile } from '../lib/sessions.js';
import { allSessions } from '../lib/sessions.js';
import { isMobile, NarrowContext, useContainerNarrow } from '../lib/viewport.js';
import { buildSummary, TaskItem, FileReadItem, FileEditItem } from './SessionSummaryView.js';

interface Props {
  sessionId: string;
  hideInterruptBar?: boolean;
}

// Filter chip identities. The 'role' chips toggle whole message kinds; the
// 'tool' chips toggle a specific tool category — only consulted when 'tools'
// is on. Order here drives chip rendering order.
const ROLE_CHIPS: Array<{ id: 'assistant' | 'thinking' | 'system' | 'user_input' | 'tools'; label: string }> = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'tools', label: 'Tools' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'system', label: 'System' },
  { id: 'user_input', label: 'User' },
];

const TOOL_CHIPS: Array<{ id: string; label: string; tools: string[] }> = [
  { id: 'edit', label: 'Edit', tools: ['Edit', 'Write'] },
  { id: 'read', label: 'Read', tools: ['Read'] },
  { id: 'bash', label: 'Bash', tools: ['Bash'] },
  { id: 'task', label: 'Task', tools: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'Task'] },
  { id: 'search', label: 'Search', tools: ['Glob', 'Grep'] },
  { id: 'web', label: 'Web', tools: ['WebFetch', 'WebSearch'] },
];

const KNOWN_TOOL_IDS = new Set(TOOL_CHIPS.flatMap(c => c.tools));
const DEFAULT_FILTERS = { assistant: true, thinking: true, system: true, user_input: true, tools: true };
const DEFAULT_TOOL_FILTERS: Record<string, boolean> = Object.fromEntries(
  [...TOOL_CHIPS.map(c => c.id), 'other'].map(id => [id, true])
);

export function JsonlView({ sessionId, hideInterruptBar }: Props) {
  const [roleFilters, setRoleFilters] = useState<typeof DEFAULT_FILTERS>(DEFAULT_FILTERS);
  const [toolFilters, setToolFilters] = useState<Record<string, boolean>>(DEFAULT_TOOL_FILTERS);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  const [filesDrawerOpen, setFilesDrawerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const containerNarrow = useContainerNarrow(containerRef);
  const narrow = isMobile.value || containerNarrow;
  const autoScroll = useRef(true);

  // Read the selected file from signal
  const selectedFile = getJsonlSelectedFile(sessionId);
  // Access the signal to trigger re-renders
  const _sel = jsonlSelectedFile.value;

  const { messages, loading, error, isSessionDone, isRunning } = useTranscriptStream(
    sessionId,
    { fileFilter: selectedFile }
  );

  const sessionRecord = allSessions.value.find((s: any) => s.id === sessionId);

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

  const profile = sessionRecord?.permissionProfile;

  if (loading) {
    const msg = isSessionDone
      ? 'Loading JSONL...'
      : isRunning
        ? 'Session running, waiting for output...'
        : 'Waiting for agent to start...';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', flex: 1, minHeight: 0 }}>
        <div class="structured-view" style={{ flex: 1, minHeight: 0 }}><div class="sm-empty">{msg}</div></div>
        {!hideInterruptBar && <InterruptBar sessionId={sessionId} permissionProfile={profile} />}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', flex: 1, minHeight: 0 }}>
        <div class="structured-view" style={{ flex: 1, minHeight: 0 }}><div class="sm-empty" style="color: #f87171">{error}</div></div>
        {!hideInterruptBar && <InterruptBar sessionId={sessionId} permissionProfile={profile} />}
      </div>
    );
  }

  // In "All (merged)" mode (no file filter) we split out subagent transcripts
  // and reattach them inline at the Task call that spawned them — otherwise
  // every subagent line gets dumped after the main agent and buries it.
  // When a single file is selected, render straight through.
  const isMerged = !selectedFile;
  const partitioned = useMemo(
    () => (isMerged ? partitionMergedMessages(messages) : null),
    [messages, isMerged]
  );
  const mainMessages = partitioned ? partitioned.main : messages;

  // Build a Set of message ids hidden by the current filter so groupings can
  // still see the unfiltered structure (and count "N hidden" inline). We
  // intentionally do NOT pre-strip messages here — the per-reply hidden-tool
  // badges need to know which tools were dropped between visible texts.
  const hiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    const droppedToolUseIds = new Set<string>();
    for (const m of mainMessages) {
      let drop = false;
      if (m.role === 'assistant' && !roleFilters.assistant) drop = true;
      else if (m.role === 'thinking' && !roleFilters.thinking) drop = true;
      else if (m.role === 'system' && !roleFilters.system) drop = true;
      else if (m.role === 'user_input' && !roleFilters.user_input) drop = true;
      else if (m.role === 'tool_use') {
        if (!roleFilters.tools) drop = true;
        else {
          const name = m.toolName || '';
          const cat = TOOL_CHIPS.find(c => c.tools.includes(name));
          const id = cat ? cat.id : 'other';
          if (!toolFilters[id]) drop = true;
        }
        if (drop && m.toolUseId) droppedToolUseIds.add(m.toolUseId);
      } else if (m.role === 'tool_result') {
        if (!roleFilters.tools) drop = true;
        if (m.toolUseResultId && droppedToolUseIds.has(m.toolUseResultId)) drop = true;
      }
      if (drop) hidden.add(m.id);
    }
    return hidden;
  }, [mainMessages, roleFilters, toolFilters]);

  // Group from the unfiltered stream so a hidden user_input doesn't merge two
  // turns into one — and so each turn knows the full set of tool calls it had
  // before filtering, for the "N hidden by filter" badges.
  const groups = useMemo(() => groupMessages(mainMessages), [mainMessages]);

  const toolChipUsable = roleFilters.tools;
  const toggleRole = (id: keyof typeof DEFAULT_FILTERS) => setRoleFilters(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleTool = (id: string) => setToolFilters(prev => ({ ...prev, [id]: !prev[id] }));
  const resetFilters = () => { setRoleFilters(DEFAULT_FILTERS); setToolFilters(DEFAULT_TOOL_FILTERS); };
  const filtersActive = Object.values(roleFilters).some(v => !v) || Object.values(toolFilters).some(v => !v);

  // Detect "other" tools present in stream so we only show the chip when it
  // would actually do something.
  const hasOtherTools = useMemo(
    () => mainMessages.some(m => m.role === 'tool_use' && m.toolName && !KNOWN_TOOL_IDS.has(m.toolName)),
    [mainMessages]
  );

  // The "tools:" button toggles every tool-category chip at once. If they're
  // all on it turns them all off; otherwise it switches them all on. "other"
  // is only included when the stream actually contains an Other-bucket tool.
  const allToolsOn = TOOL_CHIPS.every(c => toolFilters[c.id]) && (!hasOtherTools || toolFilters.other);
  const toggleAllTools = () => {
    const next: Record<string, boolean> = { ...toolFilters };
    const value = !allToolsOn;
    for (const c of TOOL_CHIPS) next[c.id] = value;
    if (hasOtherTools) next.other = value;
    setToolFilters(next);
  };

  // Aggregate tasks / files-read / files-edited from the same JSONL stream so
  // the left/right drawers can render alongside the message log.
  const summary = useMemo(() => buildSummary(mainMessages), [mainMessages]);
  const filesSummaryCount = summary.filesRead.length + summary.filesEdited.length;

  // Detect running tool: last message is tool_use with no following tool_result
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingTool = lastMsg?.role === 'tool_use' ? lastMsg : null;

  // For each group msg, we may want to render a SubagentBlock immediately
  // after a Task tool_use that links to a subagent transcript. Wrap the
  // common per-message render so we can branch without duplicating JSX.
  const renderGroupMessages = (groupMessages: ParsedMessage[]) => {
    const out: any[] = [];
    for (let idx = 0; idx < groupMessages.length; idx++) {
      const msg = groupMessages[idx];
      out.push(
        <MessageRenderer key={msg.id} message={msg} messages={groupMessages} index={idx} />
      );
      if (partitioned && msg.role === 'tool_use' && msg.toolUseId) {
        const agentId = partitioned.toolUseIdToAgentId.get(msg.toolUseId);
        if (agentId) {
          const subMsgs = partitioned.subagents.get(agentId);
          if (subMsgs && subMsgs.length > 0) {
            out.push(
              <SubagentBlock
                key={`sub-${agentId}`}
                agentId={agentId}
                messages={subMsgs}
                taskInput={msg.toolInput}
              />
            );
          }
        }
      }
    }
    return out;
  };

  return (
    <NarrowContext.Provider value={narrow}>
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', flex: 1, minHeight: 0 }}>
      <div class="jsonl-filter-bar">
        <button
          class={`jsonl-drawer-toggle${tasksDrawerOpen ? ' active' : ''}`}
          onClick={() => setTasksDrawerOpen(o => !o)}
          title="Toggle tasks drawer"
        >
          {tasksDrawerOpen ? '◀' : '▶'} Tasks
          {summary.tasks.length > 0 && <span class="jsonl-drawer-count">{summary.tasks.length}</span>}
        </button>
        {ROLE_CHIPS.map(c => (
          <button
            key={c.id}
            class={`jsonl-filter-chip${roleFilters[c.id] ? ' active' : ''}`}
            onClick={() => toggleRole(c.id)}
            title={`Toggle ${c.label}`}
          >
            {c.label}
          </button>
        ))}
        {toolChipUsable && (
          <>
            <button
              type="button"
              class={`jsonl-filter-label jsonl-filter-label-button${allToolsOn ? '' : ' partial'}`}
              onClick={toggleAllTools}
              title={allToolsOn ? 'Hide all tool categories' : 'Show all tool categories'}
            >
              tools:
            </button>
            {TOOL_CHIPS.map(c => (
              <button
                key={c.id}
                class={`jsonl-filter-chip${toolFilters[c.id] ? ' active' : ''}`}
                onClick={() => toggleTool(c.id)}
                title={`Toggle ${c.label} tools`}
              >
                {c.label}
              </button>
            ))}
            {hasOtherTools && (
              <button
                class={`jsonl-filter-chip${toolFilters.other ? ' active' : ''}`}
                onClick={() => toggleTool('other')}
                title="Other tool calls (MCP, custom, etc.)"
              >
                Other
              </button>
            )}
          </>
        )}
        {filtersActive && (
          <button class="jsonl-filter-chip-reset" onClick={resetFilters} title="Show all">
            reset
          </button>
        )}
        <button
          class={`jsonl-drawer-toggle jsonl-drawer-toggle-right${filesDrawerOpen ? ' active' : ''}`}
          onClick={() => setFilesDrawerOpen(o => !o)}
          title="Toggle files / changes drawer"
        >
          Files {filesDrawerOpen ? '▶' : '◀'}
          {filesSummaryCount > 0 && <span class="jsonl-drawer-count">{filesSummaryCount}</span>}
        </button>
      </div>
      <div class="jsonl-body">
        {tasksDrawerOpen && (
          <aside class="jsonl-drawer jsonl-drawer-left">
            <div class="jsonl-drawer-header">Tasks</div>
            <div class="jsonl-drawer-body">
              {summary.tasks.length === 0
                ? <div class="ssum-empty">No tasks created or updated.</div>
                : summary.tasks.map(t => <TaskItem key={t.taskId} t={t} />)}
            </div>
          </aside>
        )}
        <div class={`structured-view${narrow ? ' structured-view-narrow' : ''}`} style={{ flex: 1, minHeight: 0 }} ref={containerRef} onScroll={handleScroll}>
          {messages.length === 0 && (
            <div class="sm-empty">No messages in JSONL file</div>
          )}
          {groups.map(group => {
            if (group.role === 'assistant_group') {
              return (
                <CollapsibleAssistantGroup
                  key={group.id}
                  messages={group.messages}
                  partitioned={partitioned}
                  hiddenIds={hiddenIds}
                />
              );
            }
            // user_input / standalone — apply filter at the group level.
            const visible = group.messages.filter(m => !hiddenIds.has(m.id));
            if (visible.length === 0) return null;
            return (
              <div key={group.id} class={`sm-group sm-group-${group.role}`}>
                {renderGroupMessages(visible)}
              </div>
            );
          })}
          {partitioned && partitioned.orphanSubagentIds.length > 0 && (
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
          {pendingTool && (
            <div class="sm-pending-approval">
              <span class="sm-pending-icon">⚙️</span>
              <span class="sm-pending-text">
                Running: <strong>{pendingTool.toolName || 'tool call'}</strong>
              </span>
            </div>
          )}
        </div>
        {filesDrawerOpen && (
          <aside class="jsonl-drawer jsonl-drawer-right">
            <div class="jsonl-drawer-header">Files Edited</div>
            <div class="jsonl-drawer-body">
              {summary.filesEdited.length === 0
                ? <div class="ssum-empty">No files edited or written.</div>
                : summary.filesEdited.map(e => <FileEditItem key={e.path} e={e} />)}
            </div>
            <div class="jsonl-drawer-header">Files Read</div>
            <div class="jsonl-drawer-body">
              {summary.filesRead.length === 0
                ? <div class="ssum-empty">No files read.</div>
                : summary.filesRead.map(r => <FileReadItem key={r.path} r={r} />)}
            </div>
          </aside>
        )}
      </div>
      {!hideInterruptBar && <InterruptBar sessionId={sessionId} permissionProfile={profile} />}
    </div>
    </NarrowContext.Provider>
  );
}

// Each turn (assistant_group between two user inputs) is split into Replies.
// A Reply is one assistant text message plus everything that immediately
// follows it (thinking, tool calls) before the next assistant text. The first
// Reply in a turn may have no leading text (a tools-only preface).
//
// Three layers of progressive disclosure:
//   1. Turn header collapses the whole turn (AssistantGroupHeader + left edge)
//   2. Each Reply collapses its own text + tools (caret + left edge)
//   3. Each tool cluster inside a Reply collapses to "▾ N tools"
//   4. Each tool inside a cluster is a one-line chip that expands on click
type Reply = {
  // assistant text + thinking blocks that lead this reply
  textBlocks: ParsedMessage[];
  // tool_use messages that follow the text (in order)
  tools: ParsedMessage[];
  // tool_use messages that exist in the unfiltered stream but are hidden by
  // current role/tool filters — surfaced as a "N hidden by filter" badge
  hiddenTools: number;
  // first id in the reply, used as React key
  key: string;
};

function splitIntoReplies(messages: ParsedMessage[], hiddenIds: Set<string>): Reply[] {
  const replies: Reply[] = [];
  let cur: Reply | null = null;
  const ensureCur = (key: string) => {
    if (!cur) { cur = { textBlocks: [], tools: [], hiddenTools: 0, key }; replies.push(cur); }
    return cur;
  };
  for (const m of messages) {
    if (m.role === 'tool_result') continue; // folded into preceding tool_use chip
    if (m.role === 'assistant') {
      // assistant text starts a new reply IF the current one already has
      // any visible content (text or tools). Otherwise it just leads the
      // current empty reply.
      if (cur && (cur.textBlocks.length > 0 || cur.tools.length > 0 || cur.hiddenTools > 0)) {
        cur = null;
      }
      const r = ensureCur(m.id);
      if (!hiddenIds.has(m.id)) r.textBlocks.push(m);
    } else if (m.role === 'thinking') {
      const r = ensureCur(m.id);
      if (!hiddenIds.has(m.id)) r.textBlocks.push(m);
    } else if (m.role === 'tool_use') {
      const r = ensureCur(m.id);
      if (hiddenIds.has(m.id)) r.hiddenTools++;
      else r.tools.push(m);
    }
  }
  // Drop replies that ended up entirely empty (e.g. the only message was a
  // hidden assistant text and no tools).
  return replies.filter(r => r.textBlocks.length > 0 || r.tools.length > 0 || r.hiddenTools > 0);
}

// Fold matching tool_result content into each tool_use's __chatExtras so the
// one-line chip can reveal the result on click. Done per-turn so we don't
// scan the whole transcript for every render.
function foldToolResults(messages: ParsedMessage[]): Map<string, ParsedMessage> {
  const enriched = new Map<string, ParsedMessage>();
  const resultByUseId = new Map<string, ParsedMessage>();
  for (const m of messages) {
    if (m.role === 'tool_result' && m.toolUseResultId) resultByUseId.set(m.toolUseResultId, m);
  }
  for (const m of messages) {
    if (m.role !== 'tool_use' || !m.toolUseId) continue;
    const result = resultByUseId.get(m.toolUseId);
    if (!result) { enriched.set(m.id, m); continue; }
    enriched.set(m.id, {
      ...m,
      toolInput: {
        ...(m.toolInput || {}),
        __chatExtras: result.isError
          ? { error: result.content }
          : { result: result.content },
      },
    });
  }
  return enriched;
}

function ToolCluster({
  items,
  enrichedById,
  partitioned,
  hiddenCount,
}: {
  items: ParsedMessage[];
  enrichedById: Map<string, ParsedMessage>;
  partitioned: ReturnType<typeof partitionMergedMessages> | null;
  hiddenCount: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const toolCount = items.length;
  if (toolCount === 0 && hiddenCount === 0) return null;
  if (toolCount === 0) {
    // Nothing visible but filter dropped some — render the badge inline.
    return (
      <div class="jsonl-hidden-tools-badge">
        {hiddenCount} tool{hiddenCount === 1 ? '' : 's'} hidden by filter
      </div>
    );
  }
  return (
    <div class={`jsonl-tool-cluster${collapsed ? ' collapsed' : ''}`}>
      <div class="jsonl-tool-cluster-edge" onClick={() => setCollapsed(c => !c)} title="Toggle tool calls" />
      <button
        class="jsonl-tool-cluster-header"
        onClick={() => setCollapsed(c => !c)}
        title="Toggle tool calls"
      >
        <span class="jsonl-cluster-caret">{collapsed ? '▸' : '▾'}</span>
        <span class="jsonl-cluster-label">
          {toolCount} tool{toolCount === 1 ? '' : 's'}
        </span>
        {hiddenCount > 0 && (
          <span class="jsonl-cluster-hidden">+{hiddenCount} hidden</span>
        )}
      </button>
      {!collapsed && (
        <div class="jsonl-tool-cluster-body">
          {items.map((msg, idx) => {
            const enriched = enrichedById.get(msg.id) || msg;
            const node = (
              <MessageRenderer
                key={msg.id}
                message={enriched}
                messages={items}
                index={idx}
                chat={{}}
              />
            );
            if (partitioned && msg.toolUseId) {
              const agentId = partitioned.toolUseIdToAgentId.get(msg.toolUseId);
              const subMsgs = agentId ? partitioned.subagents.get(agentId) : null;
              if (agentId && subMsgs && subMsgs.length > 0) {
                return (
                  <span key={`wrap-${msg.id}`}>
                    {node}
                    <SubagentBlock
                      key={`sub-${agentId}`}
                      agentId={agentId}
                      messages={subMsgs}
                      taskInput={msg.toolInput}
                    />
                  </span>
                );
              }
            }
            return node;
          })}
        </div>
      )}
    </div>
  );
}

// Fold runs of consecutive `thinking` messages into a single block. A long
// extended-thinking turn streams as many small chunks; rendering each as its
// own "Thinking" line buries the turn in repeated headers. The grouped block
// shows a duration ("Thought for 42 seconds") and expands to the joined text.
type ThinkingRun = { kind: 'thinking_run'; key: string; messages: ParsedMessage[] };
function coalesceThinking(blocks: ParsedMessage[]): Array<ParsedMessage | ThinkingRun> {
  const out: Array<ParsedMessage | ThinkingRun> = [];
  let run: ParsedMessage[] | null = null;
  const flush = () => {
    if (run && run.length > 0) {
      out.push({ kind: 'thinking_run', key: `think-${run[0].id}`, messages: run });
    }
    run = null;
  };
  for (const m of blocks) {
    if (m.role === 'thinking') {
      if (!run) run = [];
      run.push(m);
    } else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

function ThinkingGroupBlock({ messages }: { messages: ParsedMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const firstTs = messages[0]?.timestamp || 0;
  const lastTs = messages[messages.length - 1]?.timestamp || 0;
  const durationSec = firstTs && lastTs ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0;
  const label = durationSec >= 1
    ? `Thought for ${durationSec} second${durationSec === 1 ? '' : 's'}`
    : messages.length > 1
      ? `Thought (${messages.length} blocks)`
      : 'Thinking';
  return (
    <div class="sm-message sm-thinking sm-thinking-group">
      <div class="sm-thinking-header" onClick={() => setExpanded(e => !e)}>
        <span class="sm-thinking-icon">💭</span>
        <span class="sm-thinking-label">{label}</span>
        <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div class="sm-thinking-content">
          {messages.map((m, i) => (
            <div key={m.id} class={i > 0 ? 'sm-thinking-chunk' : undefined}>
              {m.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyBlock({
  reply,
  fullMessages,
  enrichedById,
  partitioned,
}: {
  reply: Reply;
  fullMessages: ParsedMessage[];
  enrichedById: Map<string, ParsedMessage>;
  partitioned: ReturnType<typeof partitionMergedMessages> | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasText = reply.textBlocks.length > 0;
  const hasTools = reply.tools.length > 0 || reply.hiddenTools > 0;
  // First-line preview of the leading assistant text for the collapsed header.
  const leadText = (() => {
    const firstText = reply.textBlocks.find(m => m.role === 'assistant');
    if (!firstText) return null;
    const oneLine = (firstText.content || '').trim().split('\n')[0];
    return oneLine.length > 120 ? oneLine.slice(0, 117) + '…' : oneLine;
  })();
  return (
    <div class={`jsonl-reply${collapsed ? ' jsonl-reply-collapsed' : ''}`}>
      <div class="jsonl-reply-edge" onClick={() => setCollapsed(c => !c)} title="Toggle reply" />
      <div
        class="jsonl-reply-header"
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(c => !c); } }}
      >
        <span class="jsonl-reply-caret">{collapsed ? '▸' : '▾'}</span>
        <span class="jsonl-reply-label">
          {hasText ? 'Reply' : 'Tools'}
        </span>
        {reply.tools.length > 0 && (
          <span class="jsonl-reply-meta">{reply.tools.length} tool{reply.tools.length === 1 ? '' : 's'}</span>
        )}
        {reply.hiddenTools > 0 && (
          <span class="jsonl-reply-meta jsonl-reply-meta-muted">+{reply.hiddenTools} hidden</span>
        )}
        {collapsed && leadText && (
          <span class="jsonl-reply-preview">{leadText}</span>
        )}
      </div>
      {!collapsed && (
        <div class="jsonl-reply-body">
          {coalesceThinking(reply.textBlocks).map((item, idx) => {
            if ('kind' in item) {
              return <ThinkingGroupBlock key={item.key} messages={item.messages} />;
            }
            return (
              <MessageRenderer
                key={item.id}
                message={item}
                messages={fullMessages}
                index={idx}
              />
            );
          })}
          {hasTools && (
            <ToolCluster
              items={reply.tools}
              enrichedById={enrichedById}
              partitioned={partitioned}
              hiddenCount={reply.hiddenTools}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CollapsibleAssistantGroup({
  messages,
  partitioned,
  hiddenIds,
}: {
  messages: ParsedMessage[];
  partitioned: ReturnType<typeof partitionMergedMessages> | null;
  hiddenIds: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const replies = useMemo(() => splitIntoReplies(messages, hiddenIds), [messages, hiddenIds]);
  const enrichedById = useMemo(() => foldToolResults(messages), [messages]);
  // If the whole turn ends up with nothing visible (everything filtered),
  // still render the header so the user can toggle filters back on without
  // losing track of where the turn was.
  const empty = replies.length === 0;
  return (
    <div class={`sm-group sm-group-assistant_group${collapsed ? ' sm-group-collapsed' : ''}`}>
      <div class="sm-group-edge" onClick={() => setCollapsed(c => !c)} title="Toggle turn" />
      <AssistantGroupHeader
        messages={messages}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      {!collapsed && empty && (
        <div class="jsonl-reply-empty">All messages in this turn are hidden by filters.</div>
      )}
      {!collapsed && replies.map((reply) => (
        <ReplyBlock
          key={reply.key}
          reply={reply}
          fullMessages={messages}
          enrichedById={enrichedById}
          partitioned={partitioned}
        />
      ))}
    </div>
  );
}
