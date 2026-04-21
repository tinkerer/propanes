import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MessageRenderer } from './MessageRenderer.js';
import { groupMessages, AssistantGroupHeader, partitionMergedMessages } from './StructuredView.js';
import { SubagentBlock } from './SubagentBlock.js';
import { InterruptBar } from './InterruptBar.js';
import { JsonOutputParser, type ParsedMessage } from '../lib/output-parser.js';
import { api } from '../lib/api.js';
import { getJsonlSelectedFile, jsonlSelectedFile } from '../lib/sessions.js';
import { allSessions, exitedSessions } from '../lib/sessions.js';
import { isMobile } from '../lib/viewport.js';

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

  // The JSONL file doesn't exist until the agent writes its first line. While
  // a session is running, a 404 just means "not written yet" — keep polling
  // and don't surface it as an error.
  const sessionRecord = allSessions.value.find((s: any) => s.id === sessionId);
  const terminalStatus = sessionRecord?.status && ['completed', 'exited', 'failed', 'deleted', 'archived'].includes(sessionRecord.status);
  const isSessionDone = exitedSessions.value.has(sessionId) || !!terminalStatus;
  const isRunning = sessionRecord?.status === 'running';

  // Cap the initial fetch size on mobile — multi-MB JSONL parses freeze
  // mobile Safari. See StructuredView for the same rationale.
  const tailLines = isMobile.value ? 500 : 0;

  const fetchJsonl = async () => {
    const fileFilter = getJsonlSelectedFile(sessionId);
    // If file filter changed, reset
    if (fileFilter !== lastFileFilter.current) {
      lastFileFilter.current = fileFilter;
      lastLength.current = 0;
    }

    try {
      const text = await api.getJsonl(sessionId, fileFilter || undefined, tailLines);
      if (text.length === lastLength.current) {
        setLoading(false);
        return;
      }
      lastLength.current = text.length;

      const parser = new JsonOutputParser();
      parser.feed(text + '\n');
      const parsed = parser.getMessages();
      setMessages(parsed);
      setError(null);
      setLoading(false);
    } catch (err: any) {
      const isMissing = err?.status === 404;
      if (isMissing && !isSessionDone && messages.length === 0) {
        setLoading(true);
        setError(null);
      } else if (messages.length === 0) {
        setError(err.message);
        setLoading(false);
      } else {
        setLoading(false);
      }
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

  const profile = sessionRecord?.permissionProfile;

  if (loading) {
    const msg = isSessionDone
      ? 'Loading JSONL...'
      : isRunning
        ? 'Session running, waiting for output...'
        : 'Waiting for agent to start...';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div class="structured-view" style={{ flex: 1, minHeight: 0 }}><div class="sm-empty">{msg}</div></div>
        <InterruptBar sessionId={sessionId} permissionProfile={profile} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div class="structured-view" style={{ flex: 1, minHeight: 0 }}><div class="sm-empty" style="color: #f87171">{error}</div></div>
        <InterruptBar sessionId={sessionId} permissionProfile={profile} />
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
  const groups = useMemo(() => groupMessages(mainMessages), [mainMessages]);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div class="structured-view" style={{ flex: 1, minHeight: 0 }} ref={containerRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div class="sm-empty">No messages in JSONL file</div>
        )}
        {groups.map(group => (
          <div key={group.id} class={`sm-group sm-group-${group.role}`}>
            {group.role === 'assistant_group' && (
              <AssistantGroupHeader messages={group.messages} />
            )}
            {renderGroupMessages(group.messages)}
          </div>
        ))}
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
      <InterruptBar sessionId={sessionId} permissionProfile={profile} />
    </div>
  );
}
