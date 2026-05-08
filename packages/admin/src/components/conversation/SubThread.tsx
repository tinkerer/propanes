import { useState } from 'preact/hooks';
import type { ParsedMessage } from '../../lib/output-parser.js';
import { ConversationView } from './ConversationView.js';

export interface SubThreadProps {
  agentId: string;
  messages: ParsedMessage[];
  /** Label from the parent Task tool call (if available) */
  taskLabel?: string;
  /** Initially collapsed -- user clicks to expand */
  defaultCollapsed?: boolean;
}

function countTools(messages: ParsedMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === 'tool_use') n++;
  return n;
}

export function SubThread({
  agentId,
  messages,
  taskLabel,
  defaultCollapsed = true,
}: SubThreadProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const shortId = agentId.slice(0, 8);
  const toolCount = countTools(messages);
  const msgCount = messages.length;

  if (collapsed) {
    return (
      <button
        type="button"
        class="conv-subthread-pill"
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
      >
        <span class="conv-subthread-pill-icon">{'\u2937'}</span>
        <span class="conv-subthread-pill-label">
          {taskLabel || `Sub-thread ${shortId}`}
        </span>
        <span class="conv-subthread-pill-badge">
          {msgCount} msg{msgCount !== 1 ? 's' : ''}
          {toolCount > 0 ? ` \u00b7 ${toolCount} tool${toolCount !== 1 ? 's' : ''}` : ''}
        </span>
        <span class="conv-subthread-pill-caret">{'\u25b8'}</span>
      </button>
    );
  }

  return (
    <div class="conv-subthread">
      <div class="conv-subthread-header">
        <button
          type="button"
          class="conv-subthread-header-toggle"
          onClick={() => setCollapsed(true)}
          aria-expanded={true}
        >
          <span class="conv-subthread-header-caret">{'\u25be'}</span>
          <span class="conv-subthread-header-icon">{'\u21b3'}</span>
          <span class="conv-subthread-header-label">
            Sub-thread: {taskLabel || shortId}
          </span>
        </button>
      </div>
      <div class="conv-subthread-expanded">
        <ConversationView
          messages={messages}
          mode="bubble"
          agentName={`Subagent ${shortId}`}
          agentId={agentId}
          showTools={true}
        />
      </div>
    </div>
  );
}
