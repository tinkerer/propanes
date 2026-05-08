/**
 * Conversation data-logic: unified types, adapters, grouping, partitioning,
 * and presentational helpers. Shared by StructuredView, ConversationView,
 * and the CoS bubble.
 */
import { type ParsedMessage, type MessageRole, type TokenUsage } from './output-parser.js';
import type {
  ChiefOfStaffMsg,
  CosImageAttachment,
  CosElementRef,
} from './chief-of-staff.js';
import type { ChiefOfStaffToolCall } from './cos-dispatch-info.js';

export type { ParsedMessage, MessageRole, TokenUsage };

// ---------------------------------------------------------------------------
// ConversationMessage — superset of ParsedMessage + CoS-specific fields
// ---------------------------------------------------------------------------

export interface ConversationMessage extends ParsedMessage {
  threadId?: string;
  serverId?: string;
  streaming?: boolean;
  sending?: boolean;
  error?: string;
  retryPayload?: {
    text: string;
    appId: string | null;
    attachments?: CosImageAttachment[];
    elementRefs?: CosElementRef[];
  };
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
  replyToTs?: number;
  /** Original CoS tool calls kept for renderers that need the structured form. */
  cosToolCalls?: ChiefOfStaffToolCall[];
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const COS_ROLE_MAP: Record<ChiefOfStaffMsg['role'], MessageRole> = {
  user: 'user_input',
  assistant: 'assistant',
  system: 'system',
};

/**
 * Convert a single CoS message into one or more ConversationMessages.
 * The main text becomes one message; each tool call produces a tool_use +
 * tool_result pair so existing grouping / rendering logic works unchanged.
 */
export function cosMessageToConversation(
  msg: ChiefOfStaffMsg,
  index: number,
): ConversationMessage[] {
  const baseId = `cos-${index}-${msg.timestamp}`;
  const shared = {
    threadId: msg.threadId,
    serverId: msg.serverId,
    streaming: msg.streaming,
    sending: msg.sending,
    error: msg.error,
    retryPayload: msg.retryPayload,
    attachments: msg.attachments,
    elementRefs: msg.elementRefs,
    replyToTs: msg.replyToTs,
  };

  const results: ConversationMessage[] = [];

  // Primary text message
  if (msg.text || !msg.toolCalls?.length) {
    results.push({
      id: baseId,
      role: COS_ROLE_MAP[msg.role],
      timestamp: msg.timestamp,
      content: msg.text,
      cosToolCalls: msg.toolCalls,
      ...shared,
    });
  }

  // One tool_use + tool_result per tool call
  if (msg.toolCalls) {
    for (let i = 0; i < msg.toolCalls.length; i++) {
      const tc = msg.toolCalls[i];
      const tcId = `${baseId}-tc-${i}`;

      results.push({
        id: `${tcId}-use`,
        role: 'tool_use',
        timestamp: msg.timestamp,
        toolName: tc.name,
        toolInput: tc.input,
        toolUseId: tc.id,
        content: '',
        ...shared,
      });

      if (tc.result !== undefined || tc.error) {
        results.push({
          id: `${tcId}-result`,
          role: 'tool_result',
          timestamp: msg.timestamp,
          toolUseResultId: tc.id,
          content: tc.error
            ? tc.error
            : typeof tc.result === 'string'
              ? tc.result
              : JSON.stringify(tc.result ?? ''),
          isError: !!tc.error,
          ...shared,
        });
      }
    }
  }

  return results;
}

/**
 * Wrap a ParsedMessage as a ConversationMessage (identity — ParsedMessage is
 * already a structural subtype of ConversationMessage).
 */
export function parsedToConversation(msg: ParsedMessage): ConversationMessage {
  return msg;
}

/**
 * Batch-convert an array of CoS messages into a flat ConversationMessage transcript.
 */
export function cosMessagesToTranscript(msgs: ChiefOfStaffMsg[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const converted = cosMessageToConversation(msgs[i], i);
    for (const m of converted) result.push(m);
  }
  return result;
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

export function shortenModelName(model: string): string | null {
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

// Format the turn's wall-clock time. If the turn spans more than 2s, show the
// duration too — long turns are useful to spot. Anything within 2s of "now"
// is treated as a fresh live-stream message and gets no time stamp (the user
// is watching it happen).
export function formatTurnTime(firstTs: number, lastTs: number): string | null {
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
