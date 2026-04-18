export type MessageRole = 'assistant' | 'tool_use' | 'tool_result' | 'user_input' | 'system' | 'thinking';

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ParsedMessage {
  id: string;
  role: MessageRole;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  content: string;
  isError?: boolean;
  model?: string;
  usage?: TokenUsage;
}

let nextId = 0;
function genId(): string {
  return `msg-${++nextId}`;
}

function stripAnsi(s: string): string {
  let cleaned = s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\(B/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '');
  // Handle \r (carriage return) — keep only the last segment per line
  // This handles Claude CLI status line overwrites
  cleaned = cleaned.split('\n').map(line => {
    if (line.includes('\r')) {
      const parts = line.split('\r');
      return parts[parts.length - 1];
    }
    return line;
  }).join('\n');
  return cleaned;
}

// Parses structured JSON output from `claude --output-format stream-json`
export class JsonOutputParser {
  private buffer = '';
  private messages: ParsedMessage[] = [];
  private currentModel = '';
  private currentUsage: TokenUsage = {};

  // Track in-progress streaming blocks by index
  private activeBlocks: Map<number, { id: string; type: string; toolName?: string; textAccum: string; jsonAccum: string; thinkingAccum: string }> = new Map();
  // Track which subagent IDs we've already emitted a marker for
  private seenSubagents: Set<string> = new Set();

  feed(chunk: string): ParsedMessage[] {
    this.buffer += chunk;
    const newMessages: ParsedMessage[] = [];

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        const msgs = this.parseJsonEvent(obj);
        for (const msg of msgs) {
          this.messages.push(msg);
          newMessages.push(msg);
        }
      } catch {
        // not JSON
      }
    }

    return newMessages;
  }

  private parseJsonEvent(obj: any): ParsedMessage[] {
    // --- Subagent marker: emit a system message on first entry from a new subagent ---
    const subagentId = obj._subagentId || obj.agentId;
    if (subagentId && !this.seenSubagents.has(subagentId)) {
      this.seenSubagents.add(subagentId);
      const marker: ParsedMessage = { id: genId(), role: 'system', timestamp: Date.now(), content: `Subagent: ${subagentId}` };
      this.messages.push(marker);
      return [marker, ...this.parseJsonEventInner(obj)];
    }
    return this.parseJsonEventInner(obj);
  }

  private parseJsonEventInner(obj: any): ParsedMessage[] {
    const type = obj.type;

    // --- CLI stream-json: system message (session metadata) ---
    if (type === 'system') {
      if (obj.model) this.currentModel = obj.model;
      const parts: string[] = [];
      if (obj.model) parts.push(`Model: ${obj.model}`);
      if (obj.session_id) parts.push(`Session: ${obj.session_id}`);
      if (obj.tools?.length) parts.push(`Tools: ${obj.tools.length}`);
      if (parts.length > 0) {
        return [{ id: genId(), role: 'system', timestamp: Date.now(), content: parts.join(' | '), model: obj.model }];
      }
      return [];
    }

    // --- CLI stream-json: user message ---
    if (type === 'user') {
      const results: ParsedMessage[] = [];
      const content = obj.message?.content;
      if (typeof content === 'string') {
        if (content) results.push({ id: genId(), role: 'user_input', timestamp: Date.now(), content });
      } else if (Array.isArray(content)) {
        const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        if (text) results.push({ id: genId(), role: 'user_input', timestamp: Date.now(), content: text });
        for (const block of content) {
          if (block.type === 'tool_result') {
            const rc = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content) ? block.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
              : JSON.stringify(block.content);
            results.push({ id: genId(), role: 'tool_result', timestamp: Date.now(), content: rc, isError: block.is_error || false });
          }
        }
      }
      return results;
    }

    // --- API streaming: message_start ---
    if (type === 'message_start' && obj.message) {
      if (obj.message.model) this.currentModel = obj.message.model;
      if (obj.message.usage) {
        this.currentUsage = { ...obj.message.usage };
      }
      return [];
    }

    // --- API streaming: message_delta ---
    if (type === 'message_delta') {
      if (obj.usage) {
        this.currentUsage = {
          ...this.currentUsage,
          output_tokens: obj.usage.output_tokens || this.currentUsage.output_tokens,
        };
      }
      return [];
    }

    // --- CLI stream-json / API: assistant message with complete content blocks ---
    if (type === 'assistant' && obj.message?.content) {
      const results: ParsedMessage[] = [];
      const model = obj.message?.model || this.currentModel;
      const usage = obj.message?.usage || undefined;

      for (const block of obj.message.content) {
        if (block.type === 'text') {
          results.push({ id: genId(), role: 'assistant', timestamp: Date.now(), content: block.text, model, usage });
        } else if (block.type === 'tool_use') {
          results.push({
            id: genId(), role: 'tool_use', timestamp: Date.now(),
            toolName: block.name, toolInput: block.input,
            content: JSON.stringify(block.input, null, 2), model,
          });
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => typeof c === 'string' ? c : c.text || JSON.stringify(c)).join('\n')
              : JSON.stringify(block.content);
          results.push({
            id: genId(), role: 'tool_result', timestamp: Date.now(),
            content: resultContent, isError: block.is_error || false,
          });
        } else if (block.type === 'thinking') {
          results.push({ id: genId(), role: 'thinking', timestamp: Date.now(), content: block.thinking || '', model });
        }
      }
      return results;
    }

    // --- API streaming: content_block_start ---
    if (type === 'content_block_start' && obj.content_block) {
      const block = obj.content_block;
      const idx = obj.index ?? this.activeBlocks.size;
      const id = genId();

      if (block.type === 'tool_use') {
        this.activeBlocks.set(idx, { id, type: 'tool_use', toolName: block.name, textAccum: '', jsonAccum: '', thinkingAccum: '' });
      } else if (block.type === 'text') {
        this.activeBlocks.set(idx, { id, type: 'text', textAccum: '', jsonAccum: '', thinkingAccum: '' });
      } else if (block.type === 'thinking') {
        this.activeBlocks.set(idx, { id, type: 'thinking', textAccum: '', jsonAccum: '', thinkingAccum: '' });
      }
      return [];
    }

    // --- API streaming: content_block_delta ---
    if (type === 'content_block_delta') {
      const idx = obj.index ?? 0;
      const active = this.activeBlocks.get(idx);
      if (!active) return [];

      const delta = obj.delta;
      if (!delta) return [];

      if (delta.type === 'text_delta' && delta.text) {
        active.textAccum += delta.text;
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        active.jsonAccum += delta.partial_json;
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        active.thinkingAccum += delta.thinking;
      }
      return [];
    }

    // --- API streaming: content_block_stop ---
    if (type === 'content_block_stop') {
      const idx = obj.index ?? 0;
      const active = this.activeBlocks.get(idx);
      if (!active) return [];

      this.activeBlocks.delete(idx);
      const model = this.currentModel || undefined;

      if (active.type === 'text' && active.textAccum) {
        return [{
          id: active.id, role: 'assistant', timestamp: Date.now(),
          content: active.textAccum, model,
          usage: Object.keys(this.currentUsage).length > 0 ? { ...this.currentUsage } : undefined,
        }];
      }

      if (active.type === 'tool_use') {
        let toolInput: Record<string, unknown> = {};
        if (active.jsonAccum) {
          try { toolInput = JSON.parse(active.jsonAccum); } catch { /* partial JSON */ }
        }
        return [{
          id: active.id, role: 'tool_use', timestamp: Date.now(),
          toolName: active.toolName, toolInput,
          content: active.jsonAccum || '', model,
        }];
      }

      if (active.type === 'thinking' && active.thinkingAccum) {
        return [{ id: active.id, role: 'thinking', timestamp: Date.now(), content: active.thinkingAccum, model }];
      }

      return [];
    }

    // --- CLI stream-json / API: result (session end or error) ---
    if (type === 'result') {
      // Session end with metadata
      if (obj.subtype === 'session_end' || obj.duration_ms != null || obj.total_cost_usd != null) {
        const parts: string[] = ['Session complete'];
        if (obj.total_cost_usd != null) parts.push(`Cost: $${obj.total_cost_usd.toFixed(4)}`);
        if (obj.duration_ms != null) parts.push(`Duration: ${(obj.duration_ms / 1000).toFixed(1)}s`);
        if (obj.num_turns != null) parts.push(`Turns: ${obj.num_turns}`);
        if (obj.usage) {
          const u = obj.usage;
          if (u.input_tokens || u.output_tokens) {
            parts.push(`Tokens: ${(u.input_tokens || 0).toLocaleString()}↓ ${(u.output_tokens || 0).toLocaleString()}↑`);
          }
        }
        return [{ id: genId(), role: 'system', timestamp: Date.now(), content: parts.join(' | ') }];
      }
      // Error result
      if (obj.subtype === 'error_message' || obj.is_error) {
        return [{ id: genId(), role: 'tool_result', timestamp: Date.now(), content: obj.result || obj.error || 'Error', isError: true }];
      }
      if (obj.result) {
        return [{ id: genId(), role: 'tool_result', timestamp: Date.now(), content: obj.result }];
      }
    }

    return [];
  }

  getMessages(): ParsedMessage[] {
    return this.messages;
  }
}

type ParserState = 'idle' | 'assistant_text' | 'tool_use' | 'tool_result' | 'thinking' | 'user_input';

const KNOWN_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Task',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'WebFetch', 'WebSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'NotebookEdit', 'Skill',
]);

// Heuristic state-machine parser for interactive terminal output from Claude CLI.
// Detects tool calls (⏺ ToolName), results (⎿), assistant text, thinking blocks, and user input.
export class TerminalOutputParser {
  private messages: ParsedMessage[] = [];
  private state: ParserState = 'idle';
  private accum = '';
  private currentToolName = '';
  private currentToolInput: Record<string, unknown> = {};
  private pendingLines: string[] = [];

  feed(chunk: string): ParsedMessage[] {
    const clean = stripAnsi(chunk);
    const newMessages: ParsedMessage[] = [];

    // Split into lines, keeping partial last line in pendingLines
    const raw = (this.pendingLines.length > 0 ? this.pendingLines.pop()! : '') + clean;
    const lines = raw.split('\n');
    // Keep last incomplete line
    this.pendingLines = [lines.pop() || ''];

    for (const line of lines) {
      const trimmed = line.trimEnd();
      const msgs = this.processLine(trimmed);
      newMessages.push(...msgs);
    }

    return newMessages;
  }

  private processLine(line: string): ParsedMessage[] {
    const results: ParsedMessage[] = [];

    // Detect tool use: ⏺ ToolName(arg) or ● ToolName
    // Only match known tool names to avoid false positives from status line garble
    const toolMatch = line.match(/^\s*[⏺●]\s+(\w+)(?:\(([^)]*)\))?/);
    if (toolMatch && KNOWN_TOOLS.has(toolMatch[1])) {
      results.push(...this.flush());
      const toolName = toolMatch[1];
      const toolArg = toolMatch[2] || '';
      this.state = 'tool_use';
      this.currentToolName = toolName;
      this.currentToolInput = {};
      this.accum = '';

      if (toolName === 'Bash' && toolArg) {
        this.currentToolInput = { command: toolArg };
      } else if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && toolArg) {
        this.currentToolInput = { file_path: toolArg };
      } else if ((toolName === 'Glob' || toolName === 'Grep') && toolArg) {
        this.currentToolInput = { pattern: toolArg };
      } else if (toolArg) {
        this.currentToolInput = { args: toolArg };
      }
      return results;
    }

    // ⏺ followed by text that isn't a known tool = assistant text
    const assistantBullet = line.match(/^\s*[⏺●]\s+(.*)/);
    if (assistantBullet && assistantBullet[1].trim()) {
      results.push(...this.flush());
      this.state = 'assistant_text';
      this.accum = assistantBullet[1];
      return results;
    }

    // Detect tool result block: ⎿ ...
    const resultMatch = line.match(/^\s*⎿\s?(.*)/);
    if (resultMatch) {
      // First flush any tool_use that was accumulating params
      if (this.state === 'tool_use') {
        results.push(...this.flushToolUse());
      }
      // If we were already in tool_result, continue accumulating
      if (this.state !== 'tool_result') {
        results.push(...this.flush());
        this.state = 'tool_result';
        this.accum = '';
      }
      this.accum += (this.accum ? '\n' : '') + resultMatch[1];
      return results;
    }

    // Detect thinking marker
    if (/^\s*Thinking\.\.\.\s*$/.test(line) || /^\s*💭/.test(line)) {
      results.push(...this.flush());
      this.state = 'thinking';
      this.accum = '';
      return results;
    }

    // Detect user input marker (❯ or > prefix from Claude CLI)
    if (/^\s*[❯>]\s/.test(line)) {
      results.push(...this.flush());
      const content = line.replace(/^\s*[❯>]\s*/, '');
      if (content.trim()) {
        const msg: ParsedMessage = { id: genId(), role: 'user_input', timestamp: Date.now(), content: content.trim() };
        this.messages.push(msg);
        results.push(msg);
      }
      return results;
    }

    // Handle state-specific accumulation
    switch (this.state) {
      case 'tool_use':
        // Lines under a tool use header contain parameters
        // e.g. "  command: ls -la" or "  file_path: /foo/bar"
        {
          const paramMatch = line.match(/^\s{2,}(\w[\w_]*):\s*(.*)/);
          if (paramMatch) {
            const key = paramMatch[1];
            let val: string | boolean | number = paramMatch[2];
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            this.currentToolInput[key] = val;
          } else if (line.trim()) {
            // Could be a continuation of a multi-line value
            this.accum += (this.accum ? '\n' : '') + line;
          }
        }
        break;

      case 'tool_result':
        // Indented lines under ⎿ are continuation of result
        if (line.match(/^\s{2,}/) || line.trim() === '') {
          this.accum += '\n' + line;
        } else {
          // Non-indented non-empty line means end of result
          results.push(...this.flush());
          // Re-process this line in idle state
          this.state = 'idle';
          results.push(...this.processLine(line));
        }
        break;

      case 'thinking':
        if (line.trim() === '') {
          // Empty line might end thinking block
          results.push(...this.flush());
          this.state = 'idle';
        } else {
          this.accum += (this.accum ? '\n' : '') + line;
        }
        break;

      default:
        // idle or assistant_text
        if (line.trim()) {
          if (this.state !== 'assistant_text') {
            results.push(...this.flush());
            this.state = 'assistant_text';
            this.accum = '';
          }
          this.accum += (this.accum ? '\n' : '') + line;
        } else if (this.state === 'assistant_text' && this.accum) {
          // Empty line: flush assistant text
          results.push(...this.flush());
        }
        break;
    }

    return results;
  }

  private flushToolUse(): ParsedMessage[] {
    if (this.state !== 'tool_use') return [];
    const msg: ParsedMessage = {
      id: genId(),
      role: 'tool_use',
      timestamp: Date.now(),
      toolName: this.currentToolName,
      toolInput: { ...this.currentToolInput },
      content: this.accum.trim(),
    };
    this.messages.push(msg);
    this.state = 'idle';
    this.accum = '';
    this.currentToolName = '';
    this.currentToolInput = {};
    return [msg];
  }

  private flush(): ParsedMessage[] {
    const results: ParsedMessage[] = [];

    switch (this.state) {
      case 'tool_use':
        results.push(...this.flushToolUse());
        break;

      case 'tool_result': {
        const content = this.accum.trim();
        if (content) {
          const isError = content.includes('Error') || content.includes('error:') || content.includes('FAILED') || content.includes('Permission denied');
          const msg: ParsedMessage = { id: genId(), role: 'tool_result', timestamp: Date.now(), content, isError };
          this.messages.push(msg);
          results.push(msg);
        }
        break;
      }

      case 'assistant_text': {
        const content = this.accum.trim();
        if (content) {
          const msg: ParsedMessage = { id: genId(), role: 'assistant', timestamp: Date.now(), content };
          this.messages.push(msg);
          results.push(msg);
        }
        break;
      }

      case 'thinking': {
        const content = this.accum.trim();
        if (content) {
          const msg: ParsedMessage = { id: genId(), role: 'thinking', timestamp: Date.now(), content };
          this.messages.push(msg);
          results.push(msg);
        }
        break;
      }
    }

    this.state = 'idle';
    this.accum = '';
    return results;
  }

  getMessages(): ParsedMessage[] {
    return this.messages;
  }
}

export function createOutputParser(permissionProfile: string): JsonOutputParser | TerminalOutputParser {
  if (permissionProfile === 'auto' || permissionProfile === 'yolo') {
    return new JsonOutputParser();
  }
  return new TerminalOutputParser();
}
