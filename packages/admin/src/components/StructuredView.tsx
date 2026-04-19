import { useEffect, useRef, useState } from 'preact/hooks';
import { MessageRenderer } from './MessageRenderer.js';
import { JsonOutputParser, type ParsedMessage } from '../lib/output-parser.js';
import { api } from '../lib/api.js';
import { sessionInputStates } from '../lib/session-state.js';
import { ChoicePrompt, type ChoiceOption } from './InteractivePrompt.js';

interface Props {
  sessionId: string;
  isActive?: boolean;
  permissionProfile?: string;
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
  const [choicePrompt, setChoicePrompt] = useState<DetectedChoicePrompt | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const lastLength = useRef(0);

  const inputState = sessionInputStates.value.get(sessionId) || 'active';
  const isWaiting = inputState === 'waiting';

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

  // When the session is waiting for input, poll the captured terminal output
  // for permission-prompt patterns and surface them as a ChoicePrompt card.
  useEffect(() => {
    if (!isWaiting) { setChoicePrompt(null); return; }
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
  }, [sessionId, isWaiting]);

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
  const askingForInput = isWaiting && pendingTool?.toolName === 'AskUserQuestion';

  return (
    <div class="structured-view" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div class="sm-empty">No messages yet</div>
      )}
      {groups.map(group => {
        const lastGroupMsg = group.messages[group.messages.length - 1];
        return (
          <div key={group.id} class={`sm-group sm-group-${group.role}`}>
            {group.role === 'assistant_group' && (
              <AssistantGroupHeader messages={group.messages} />
            )}
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
                />
              );
            })}
          </div>
        );
      })}
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
  );
}
