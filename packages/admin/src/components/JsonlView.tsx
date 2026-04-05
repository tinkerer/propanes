import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageRenderer } from './MessageRenderer.js';
import { groupMessages, AssistantGroupHeader } from './StructuredView.js';
import { JsonOutputParser, type ParsedMessage } from '../lib/output-parser.js';
import { api } from '../lib/api.js';
import { getJsonlSelectedFile, jsonlSelectedFile } from '../lib/sessions.js';

interface Props {
  sessionId: string;
}

export function JsonlView({ sessionId }: Props) {
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const lastLength = useRef(0);
  const lastFileFilter = useRef<string | null>(null);

  // Read the selected file from signal
  const selectedFile = getJsonlSelectedFile(sessionId);
  // Access the signal to trigger re-renders
  const _sel = jsonlSelectedFile.value;

  const fetchJsonl = async () => {
    const fileFilter = getJsonlSelectedFile(sessionId);
    // If file filter changed, reset
    if (fileFilter !== lastFileFilter.current) {
      lastFileFilter.current = fileFilter;
      lastLength.current = 0;
    }

    try {
      const text = await api.getJsonl(sessionId, fileFilter || undefined);
      if (text.length === lastLength.current) return;
      lastLength.current = text.length;

      const parser = new JsonOutputParser();
      parser.feed(text + '\n');
      const parsed = parser.getMessages();
      setMessages(parsed);
      setError(null);
    } catch (err: any) {
      if (messages.length === 0) setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    lastLength.current = 0;
    lastFileFilter.current = selectedFile;
    setMessages([]);
    setLoading(true);
    setError(null);
    fetchJsonl();
    const interval = setInterval(() => { if (!document.hidden) fetchJsonl(); }, 3000);
    return () => clearInterval(interval);
  }, [sessionId, selectedFile]);

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

  // Detect running tool: last message is tool_use with no following tool_result
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingTool = lastMsg?.role === 'tool_use' ? lastMsg : null;

  return (
    <div class="structured-view" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div class="sm-empty">No messages in JSONL file</div>
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
