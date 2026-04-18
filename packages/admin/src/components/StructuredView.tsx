import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageRenderer } from './MessageRenderer.js';
import { JsonOutputParser, type ParsedMessage } from '../lib/output-parser.js';
import { api } from '../lib/api.js';

interface Props {
  sessionId: string;
  isActive?: boolean;
  permissionProfile?: string;
}

export interface MessageGroup {
  id: string;
  messages: ParsedMessage[];
  role: 'assistant_group' | 'user_input' | 'standalone';
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

export function AssistantGroupHeader({ messages }: { messages: ParsedMessage[] }) {
  let model = '';
  let totalInput = 0;
  let totalOutput = 0;
  let toolCount = 0;

  for (const msg of messages) {
    if (msg.model && !model) model = msg.model;
    if (msg.usage) {
      totalInput += msg.usage.input_tokens || 0;
      totalOutput += msg.usage.output_tokens || 0;
    }
    if (msg.role === 'tool_use') toolCount++;
  }

  const shortModel = model ? shortenModelName(model) : null;
  const hasTokens = totalInput > 0 || totalOutput > 0;

  if (!shortModel && !hasTokens && toolCount === 0) return null;

  return (
    <div class="sm-group-header">
      {shortModel && <span class="sm-group-model" title={model}>{shortModel}</span>}
      {toolCount > 0 && (
        <span class="sm-group-tools">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
      )}
      {hasTokens && (
        <span class="sm-group-tokens" title={`Input: ${totalInput} | Output: ${totalOutput}`}>
          {totalInput.toLocaleString()}↓ {totalOutput.toLocaleString()}↑
        </span>
      )}
    </div>
  );
}

export function StructuredView({ sessionId }: Props) {
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const lastLength = useRef(0);

  useEffect(() => {
    lastLength.current = 0;
    setMessages([]);
    setLoading(true);
    setError(null);

    let cancelled = false;
    const fetchJsonl = async () => {
      try {
        const text = await api.getJsonl(sessionId);
        if (cancelled) return;
        if (text.length === lastLength.current) return;
        lastLength.current = text.length;
        const parser = new JsonOutputParser();
        parser.feed(text + '\n');
        setMessages(parser.getMessages());
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchJsonl();
    const interval = setInterval(() => { if (!document.hidden) fetchJsonl(); }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId]);

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

  if (loading) {
    return <div class="structured-view"><div class="sm-empty">Loading JSONL...</div></div>;
  }

  if (error) {
    return <div class="structured-view"><div class="sm-empty" style="color: #f87171">{error}</div></div>;
  }

  const groups = groupMessages(messages);
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingTool = lastMsg?.role === 'tool_use' ? lastMsg : null;

  return (
    <div class="structured-view" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div class="sm-empty">No messages yet</div>
      )}
      {groups.map(group => (
        <div key={group.id} class={`sm-group sm-group-${group.role}`}>
          {group.role === 'assistant_group' && (
            <AssistantGroupHeader messages={group.messages} />
          )}
          {group.messages.map((msg, idx) => (
            <MessageRenderer key={msg.id} message={msg} messages={group.messages} index={idx} />
          ))}
        </div>
      ))}
      {pendingTool && (
        <div class="sm-pending-approval">
          <span class="sm-pending-icon">⚙️</span>
          <span class="sm-pending-text">
            Running: <strong>{pendingTool.toolName || 'tool call'}</strong>
          </span>
        </div>
      )}
    </div>
  );
}
