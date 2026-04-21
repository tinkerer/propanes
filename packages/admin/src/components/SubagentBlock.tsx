import { useState } from 'preact/hooks';
import { MessageRenderer } from './MessageRenderer.js';
import { groupMessages, AssistantGroupHeader } from './StructuredView.js';
import type { ParsedMessage } from '../lib/output-parser.js';

interface Props {
  agentId: string;
  messages: ParsedMessage[];
  // Optional Task tool input from the parent that spawned this subagent —
  // used for the header label so users see *what* the subagent was sent to do
  // before expanding it.
  taskInput?: Record<string, unknown>;
  defaultOpen?: boolean;
}

function summarize(taskInput?: Record<string, unknown>): string | null {
  if (!taskInput) return null;
  const description = typeof taskInput.description === 'string' ? taskInput.description : null;
  const subagentType = typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : null;
  if (description && subagentType) return `${subagentType}: ${description}`;
  return description || subagentType || null;
}

function countTools(messages: ParsedMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === 'tool_use') n++;
  return n;
}

export function SubagentBlock({ agentId, messages, taskInput, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const summary = summarize(taskInput);
  const toolCount = countTools(messages);
  const shortId = agentId.slice(0, 8);

  const groups = open ? groupMessages(messages) : [];

  return (
    <div class={`sm-subagent-block${open ? ' sm-subagent-open' : ''}`}>
      <button
        type="button"
        class="sm-subagent-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span class="sm-subagent-caret">{open ? '▾' : '▸'}</span>
        <span class="sm-subagent-icon">{'\u{1F916}'}</span>
        <span class="sm-subagent-label">Subagent</span>
        {summary && <span class="sm-subagent-summary" title={summary}>{summary}</span>}
        <span class="sm-subagent-meta">
          {messages.length} msg{messages.length !== 1 ? 's' : ''}
          {toolCount > 0 ? ` · ${toolCount} tool${toolCount !== 1 ? 's' : ''}` : ''}
          {' · '}{shortId}
        </span>
      </button>
      {open && (
        <div class="sm-subagent-body">
          {groups.map((group) => (
            <div key={group.id} class={`sm-group sm-group-${group.role}`}>
              {group.role === 'assistant_group' && (
                <AssistantGroupHeader messages={group.messages} />
              )}
              {group.messages.map((msg, idx) => (
                <MessageRenderer
                  key={msg.id}
                  message={msg}
                  messages={group.messages}
                  index={idx}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
