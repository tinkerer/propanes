import { type ComponentChildren } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import { MessageRenderer, type ChatRenderOpts } from '../terminal/MessageRenderer.js';
import { type ParsedMessage } from '../../lib/output-parser.js';
import {
  groupMessages,
  partitionMergedMessages,
  AssistantGroupHeader,
  type MessageGroup,
} from '../../lib/conversation.js';
import { SubagentBlock } from '../terminal/SubagentBlock.js';
import { SubThread } from './SubThread.js';
import { AssistantContent } from '../cos/CosAssistantContent.js';
import { MessageAvatar, Timestamp, HighlightedText, getAgentAvatarSrc } from '../cos/CosMessage.js';
import { useNarrow } from '../../lib/viewport.js';
import { sessionInputStates } from '../../lib/session-state.js';
import { SessionInputBar } from './SessionInputBar.js';
import {
  ConversationFilter,
  DEFAULT_FILTERS,
  filtersActive as isFiltersActive,
  toolChipId,
  type ConversationFilters,
} from './ConversationFilter.js';

export interface ConversationViewProps {
  messages: ParsedMessage[];
  sessionId?: string;
  mode?: 'structured' | 'bubble';
  /** For bubble mode: agent display info */
  agentName?: string;
  agentId?: string;
  /** Chat render opts passed to MessageRenderer */
  chat?: ChatRenderOpts;
  /** Whether the session is waiting for input */
  isWaiting?: boolean;
  /** Whether the backing session is still running. */
  isRunning?: boolean;
  /** Callback for artifact popout */
  onArtifactPopout?: (artifactId: string) => void;
  /** Search highlight text */
  searchHighlight?: string | null;
  /** Show tool calls in bubble mode */
  showTools?: boolean;
  /** Ref callback for the scrollable message body. */
  scrollBodyRef?: (el: HTMLDivElement | null) => void;
  /** Optional content rendered at the top of the scrollable message body. */
  scrollBodyTop?: ComponentChildren;
}

// ---------------------------------------------------------------------------
// Structured mode: assistant group with collapsible tools
// ---------------------------------------------------------------------------

function StructuredAssistantGroup({
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
  sessionId?: string;
  subagentLookup?: {
    subagents: Map<string, ParsedMessage[]>;
    toolUseIdToAgentId: Map<string, string>;
  };
  chat?: ChatRenderOpts;
}) {
  const toolCount = group.messages.filter(m => m.role === 'tool_use').length;
  const narrow = useNarrow();
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
          {toolsCollapsed ? `\u25b8 ${toolCount} tool calls` : '\u25be hide tools'}
        </button>
      )}
      {!groupCollapsed && group.messages.map((msg, idx) => {
        const isTool = msg.role === 'tool_use' || msg.role === 'tool_result';
        // When tools are collapsed, still show the pending tool that needs
        // approval — otherwise the user has zero context for the permission
        // prompt (YES/NO buttons without knowing what's being approved).
        const isPending = msg === pendingTool;
        // Also show the tool_result that immediately follows the pending tool_use
        const isPendingResult = msg.role === 'tool_result' && msg.toolUseResultId && pendingTool?.toolUseId === msg.toolUseResultId;
        if (isTool && toolsCollapsed && !isPending && !isPendingResult) return null;
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

// ---------------------------------------------------------------------------
// Bubble mode: individual message bubble
// ---------------------------------------------------------------------------

function BubbleMessage({
  msg,
  agentName,
  agentId,
  onArtifactPopout,
  searchHighlight,
  showTools,
  chat,
  sessionId,
}: {
  msg: ParsedMessage;
  agentName?: string;
  agentId?: string;
  onArtifactPopout?: (artifactId: string) => void;
  searchHighlight?: string | null;
  showTools?: boolean;
  chat?: ChatRenderOpts;
  sessionId?: string;
}) {
  const isUser = msg.role === 'user_input';
  const isAssistant = msg.role === 'assistant';
  const isTool = msg.role === 'tool_use' || msg.role === 'tool_result';
  const isThinking = msg.role === 'thinking';
  const isSystem = msg.role === 'system';

  // In bubble mode, skip system and thinking messages
  if (isSystem || isThinking) return null;

  // Tool results are handled via tool_use chip
  if (msg.role === 'tool_result') return null;

  // Tool calls: render as compact chip if showTools is enabled
  if (isTool && msg.role === 'tool_use') {
    if (!showTools) return null;
    return (
      <div class="cv-bubble cv-bubble-tool">
        <MessageRenderer
          key={msg.id}
          message={msg}
          chat={chat || {}}
        />
      </div>
    );
  }

  // Assistant with no content to show
  if (isAssistant && !msg.content) return null;

  const authorLabel = isUser ? 'You' : (agentName || 'Assistant');
  const avatarSrc = !isUser ? getAgentAvatarSrc(agentId ?? null) : null;

  return (
    <div class={`cv-bubble cv-row cv-row-${isUser ? 'user' : 'assistant'}`}>
      <div class="cv-row-avatar">
        <MessageAvatar
          role={isUser ? 'user' : 'assistant'}
          label={authorLabel}
          imageSrc={avatarSrc}
        />
      </div>
      <div class="cv-row-main">
        <div class="cv-row-header">
          <span class="cv-row-author">{authorLabel}</span>
          {msg.timestamp > 0 && <Timestamp ts={msg.timestamp} />}
        </div>
        <div class="cv-row-content">
          {isUser && (
            <div class="cv-msg-text">
              <HighlightedText text={msg.content || ''} highlight={searchHighlight} />
            </div>
          )}
          {isAssistant && (
            <div class="cv-msg-text cv-msg-text-md">
              <AssistantContent
                text={msg.content || ''}
                onArtifactPopout={onArtifactPopout || (() => {})}
                searchHighlight={searchHighlight}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bubble mode: renders a group of messages as bubbles
// ---------------------------------------------------------------------------

function summarizeTask(toolInput?: Record<string, unknown>): string | undefined {
  if (!toolInput) return undefined;
  const desc = typeof toolInput.description === 'string' ? toolInput.description : null;
  const subType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : null;
  if (desc && subType) return `${subType}: ${desc}`;
  return desc || subType || undefined;
}

function BubbleGroup({
  group,
  agentName,
  agentId,
  onArtifactPopout,
  searchHighlight,
  showTools,
  chat,
  sessionId,
  subagentLookup,
}: {
  group: MessageGroup;
  agentName?: string;
  agentId?: string;
  onArtifactPopout?: (artifactId: string) => void;
  searchHighlight?: string | null;
  showTools?: boolean;
  chat?: ChatRenderOpts;
  sessionId?: string;
  subagentLookup?: {
    subagents: Map<string, ParsedMessage[]>;
    toolUseIdToAgentId: Map<string, string>;
  };
}) {
  return (
    <>
      {group.messages.map((msg) => {
        const bubble = (
          <BubbleMessage
            key={msg.id}
            msg={msg}
            agentName={agentName}
            agentId={agentId}
            onArtifactPopout={onArtifactPopout}
            searchHighlight={searchHighlight}
            showTools={showTools}
            chat={chat}
            sessionId={sessionId}
          />
        );
        // Render subagent as nested sub-thread after the tool_use bubble
        if (subagentLookup && msg.role === 'tool_use' && msg.toolUseId) {
          const subAgentId = subagentLookup.toolUseIdToAgentId.get(msg.toolUseId);
          const subMsgs = subAgentId ? subagentLookup.subagents.get(subAgentId) : null;
          if (subAgentId && subMsgs && subMsgs.length > 0) {
            return (
              <>
                {bubble}
                <SubThread
                  key={`subthread-${subAgentId}`}
                  agentId={subAgentId}
                  messages={subMsgs}
                  taskLabel={summarizeTask(msg.toolInput)}
                />
              </>
            );
          }
        }
        return bubble;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

/** Return true if a message should be hidden given the current filters. */
function shouldHideMessage(msg: ParsedMessage, filters: ConversationFilters): boolean {
  const { hiddenRoles, hiddenTools } = filters;
  // Role-based hiding. tool_use role chip hides both tool_use and tool_result.
  if (msg.role === 'tool_result') {
    return hiddenRoles.has('tool_use');
  }
  if (hiddenRoles.has(msg.role)) return true;
  // Tool-name-based hiding (only for tool_use messages)
  if (msg.role === 'tool_use' && msg.toolName && hiddenTools.size > 0) {
    const chip = toolChipId(msg.toolName);
    if (chip && hiddenTools.has(chip)) return true;
  }
  return false;
}

/** Apply filters to a group's messages, returning only visible ones. */
function filterGroupMessages(msgs: ParsedMessage[], filters: ConversationFilters): ParsedMessage[] {
  if (!isFiltersActive(filters)) return msgs;
  // Collect dropped tool_use ids so we can also hide their tool_results
  const droppedToolUseIds = new Set<string>();
  const result: ParsedMessage[] = [];
  for (const m of msgs) {
    if (shouldHideMessage(m, filters)) {
      if (m.role === 'tool_use' && m.toolUseId) droppedToolUseIds.add(m.toolUseId);
      continue;
    }
    // Additionally drop tool_results whose tool_use was hidden by tool-name filter
    if (m.role === 'tool_result' && m.toolUseResultId && droppedToolUseIds.has(m.toolUseResultId)) {
      continue;
    }
    result.push(m);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConversationView({
  messages,
  sessionId,
  mode = 'structured',
  agentName,
  agentId,
  chat,
  isWaiting,
  onArtifactPopout,
  searchHighlight,
  showTools = true,
  isRunning: sessionRunning,
  scrollBodyRef,
  scrollBodyTop,
}: ConversationViewProps) {
  const [filters, setFilters] = useState<ConversationFilters>(DEFAULT_FILTERS);

  const partitioned = useMemo(() => partitionMergedMessages(messages), [messages]);
  const mainMessages = partitioned.main;
  const groups = useMemo(() => groupMessages(mainMessages), [mainMessages]);

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingTool = lastMsg?.role === 'tool_use' ? lastMsg : null;
  const askingForInput = !!(isWaiting && pendingTool?.toolName === 'AskUserQuestion');

  // Derive input state from the sessionInputStates signal for the input bar
  const inputState = sessionId ? (sessionInputStates.value.get(sessionId) ?? 'idle') : 'idle';
  const isRunning = sessionRunning ?? (isWaiting || inputState === 'active' || inputState === 'waiting');

  const inputBar = sessionId ? (
    <SessionInputBar
      sessionId={sessionId}
      lastMessage={lastMsg}
      inputState={inputState}
      isRunning={isRunning}
    />
  ) : null;

  // Compute filtered count for the header
  const hasActiveFilters = isFiltersActive(filters);
  const filteredCount = useMemo(() => {
    if (!hasActiveFilters) return 0;
    let count = 0;
    for (const m of mainMessages) {
      if (shouldHideMessage(m, filters)) count++;
    }
    return count;
  }, [mainMessages, filters, hasActiveFilters]);

  // Effective search highlight: use filter searchQuery if set, otherwise fall back to prop
  const effectiveHighlight = filters.searchQuery || searchHighlight || null;

  const headerBar = (
    <ConversationFilter
      filters={filters}
      onFiltersChange={setFilters}
      totalCount={mainMessages.length}
      filteredCount={filteredCount}
    />
  );

  if (messages.length === 0) {
    return (
      <div class="conversation-view conversation-view-empty" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div class="cv-empty">No messages yet</div>
        {inputBar}
      </div>
    );
  }

  if (mode === 'bubble') {
    return (
      <div class="conversation-view conversation-view-bubble" style={{ display: 'flex', flexDirection: 'column' }}>
        {headerBar}
        <div ref={scrollBodyRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }}>
          {scrollBodyTop}
          {groups.map((group) => {
            const filtered = { ...group, messages: filterGroupMessages(group.messages, filters) };
            if (filtered.messages.length === 0) return null;
            return (
              <BubbleGroup
                key={group.id}
                group={filtered}
                agentName={agentName}
                agentId={agentId}
                onArtifactPopout={onArtifactPopout}
                searchHighlight={effectiveHighlight}
                showTools={showTools}
                chat={chat}
                sessionId={sessionId}
                subagentLookup={partitioned}
              />
            );
          })}
          {partitioned.orphanSubagentIds.length > 0 && (
            <div class="cv-subagent-orphans">
              {partitioned.orphanSubagentIds.map((sid) => {
                const subMsgs = partitioned.subagents.get(sid) || [];
                return (
                  <SubThread
                    key={`orphan-${sid}`}
                    agentId={sid}
                    messages={subMsgs}
                  />
                );
              })}
            </div>
          )}
          {inputBar}
        </div>
      </div>
    );
  }

  // mode === 'structured'
  return (
    <div class="conversation-view conversation-view-structured" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
      {headerBar}
      <div ref={scrollBodyRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }}>
        {scrollBodyTop}
        {groups.map((group) => {
          const lastGroupMsg = group.messages[group.messages.length - 1];
          const filteredMsgs = filterGroupMessages(group.messages, filters);
          if (filteredMsgs.length === 0) return null;
          const filtered = { ...group, messages: filteredMsgs };
          if (group.role === 'assistant_group') {
            return (
              <StructuredAssistantGroup
                key={group.id}
                group={filtered}
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
              {filtered.messages.map((msg, idx) => {
                const isInteractive = askingForInput && msg === lastGroupMsg && msg === pendingTool;
                return (
                  <MessageRenderer
                    key={msg.id}
                    message={msg}
                    messages={filtered.messages}
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
            {partitioned.orphanSubagentIds.map((sid) => {
              const subMsgs = partitioned.subagents.get(sid) || [];
              return (
                <SubagentBlock
                  key={`orphan-${sid}`}
                  agentId={sid}
                  messages={subMsgs}
                />
              );
            })}
          </div>
        )}
        {pendingTool && !askingForInput && (
          <div class="sm-pending-approval">
            <span class="sm-pending-icon">{'\u2699\ufe0f'}</span>
            <span class="sm-pending-text">
              Running: <strong>{pendingTool.toolName || 'tool call'}</strong>
            </span>
          </div>
        )}
      </div>
      {inputBar}
    </div>
  );
}
