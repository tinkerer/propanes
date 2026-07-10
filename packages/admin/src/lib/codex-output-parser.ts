// Parses Codex CLI JSONL output. Handles two on-the-wire formats:
//
//   1. Rollout files (`~/.codex/sessions/.../rollout-*.jsonl`) — persistent
//      session log with `session_meta`, `event_msg`, `response_item`,
//      `turn_context` envelope types.
//   2. `codex exec --json` stdout — thin event stream with `thread.started`,
//      `turn.started`, `turn.completed`, `item.started/updated/completed`.
//
// Both are normalized into `ParsedMessage` so the existing MessageRenderer +
// StructuredView render Codex sessions with the same UI as Claude sessions.
//
// Split out of output-parser.ts so the Codex classifier evolves independently
// of the Claude parsers — the shared contract is just `ParsedMessage`.

import { tsOf, type ParsedMessage, type TokenUsage } from './output-parser.js';

export class CodexOutputParser {
  private buffer = '';
  private messages: ParsedMessage[] = [];
  private idCounter = 0;
  private genId(): string { return `msg-${++this.idCounter}`; }
  // Track exec items started via `item.started` so we can emit a tool_use
  // immediately and then attach the result on `item.completed`.
  private startedItems: Map<string, { toolName: string; toolInput: Record<string, unknown>; toolUseId: string }> = new Map();
  // Dedup: one user_message can appear both as event_msg/user_message and
  // response_item/message with role=user. We keep the event_msg version.
  private emittedUserMessages = new Set<string>();
  // Same for assistant: prefer event_msg/agent_message over response_item/message
  // (role=assistant) since the event_msg variant is cleaner.
  private emittedAssistantTexts = new Set<string>();

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
        const msgs = this.parseEvent(obj);
        for (const m of msgs) {
          this.messages.push(m);
          newMessages.push(m);
        }
      } catch { /* not JSON */ }
    }

    return newMessages;
  }

  private parseEvent(obj: any): ParsedMessage[] {
    const type = obj.type;

    // --- Rollout file: session_meta ---
    if (type === 'session_meta' && obj.payload) {
      const p = obj.payload;
      const parts: string[] = ['Codex session'];
      if (p.id) parts.push(`ID: ${p.id.slice(0, 8)}`);
      if (p.cwd) parts.push(`cwd: ${p.cwd}`);
      if (p.cli_version) parts.push(`v${p.cli_version}`);
      return [{ id: this.genId(), role: 'system', timestamp: tsOf(obj), content: parts.join(' | ') }];
    }

    // --- Rollout file: turn_context (model + sandbox info per turn) ---
    if (type === 'turn_context' && obj.payload) {
      const p = obj.payload;
      const parts: string[] = [];
      if (p.model) parts.push(`Model: ${p.model}`);
      if (p.sandbox_policy?.type) parts.push(`Sandbox: ${p.sandbox_policy.type}`);
      if (p.approval_policy) parts.push(`Approvals: ${p.approval_policy}`);
      if (parts.length === 0) return [];
      return [{ id: this.genId(), role: 'system', timestamp: tsOf(obj), content: parts.join(' | '), model: p.model }];
    }

    // --- Rollout file: event_msg ---
    if (type === 'event_msg' && obj.payload) {
      return this.parseEventMsg(obj.payload, tsOf(obj));
    }

    // --- Rollout file: response_item ---
    if (type === 'response_item' && obj.payload) {
      return this.parseResponseItem(obj.payload, tsOf(obj));
    }

    // --- exec --json: thread.started ---
    if (type === 'thread.started') {
      return [{
        id: this.genId(), role: 'system', timestamp: Date.now(),
        content: `Codex thread started${obj.thread_id ? ` (${obj.thread_id.slice(0, 8)})` : ''}`,
      }];
    }

    // --- exec --json: turn.started ---
    if (type === 'turn.started') {
      return [];
    }

    // --- exec --json: turn.completed ---
    if (type === 'turn.completed') {
      const u = obj.usage || {};
      const parts: string[] = ['Turn complete'];
      if (u.input_tokens || u.output_tokens) {
        parts.push(`Tokens: ${(u.input_tokens || 0).toLocaleString()}↓ ${(u.output_tokens || 0).toLocaleString()}↑`);
      }
      if (u.cached_input_tokens) parts.push(`Cached: ${u.cached_input_tokens.toLocaleString()}`);
      const usage: TokenUsage = {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cached_input_tokens,
      };
      return [{ id: this.genId(), role: 'system', timestamp: Date.now(), content: parts.join(' | '), usage }];
    }

    // --- exec --json: turn.failed ---
    if (type === 'turn.failed') {
      const msg = obj.error?.message || 'Turn failed';
      return [{ id: this.genId(), role: 'tool_result', timestamp: Date.now(), content: msg, isError: true }];
    }

    // --- exec --json: item.started / item.updated / item.completed ---
    if (type === 'item.started' && obj.item) {
      return this.parseItemStarted(obj.item);
    }
    if (type === 'item.completed' && obj.item) {
      return this.parseItemCompleted(obj.item);
    }
    if (type === 'item.updated') {
      return [];
    }

    // --- exec --json: error ---
    if (type === 'error') {
      return [{ id: this.genId(), role: 'tool_result', timestamp: Date.now(), content: obj.message || 'Codex error', isError: true }];
    }

    return [];
  }

  // event_msg payloads include user_message, agent_message, task_started/complete,
  // token_count, exec_command_end, patch_apply_end, view_image_tool_call.
  private parseEventMsg(p: any, ts: number): ParsedMessage[] {
    const sub = p.type;

    if (sub === 'user_message' && p.message) {
      const sig = p.message.slice(0, 200);
      if (this.emittedUserMessages.has(sig)) return [];
      this.emittedUserMessages.add(sig);
      return [{ id: this.genId(), role: 'user_input', timestamp: ts, content: p.message }];
    }

    if (sub === 'agent_message' && p.message) {
      const sig = p.message.slice(0, 200);
      this.emittedAssistantTexts.add(sig);
      return [{ id: this.genId(), role: 'assistant', timestamp: ts, content: p.message }];
    }

    if (sub === 'task_complete') {
      // task_complete carries last_agent_message which is the final user-facing
      // summary. If we've already emitted it as agent_message we skip the dup;
      // otherwise show it as the assistant's wrap-up.
      const msg = p.last_agent_message;
      if (msg && !this.emittedAssistantTexts.has(msg.slice(0, 200))) {
        return [{ id: this.genId(), role: 'assistant', timestamp: ts, content: msg }];
      }
      return [];
    }

    if (sub === 'view_image_tool_call' && p.path) {
      return [{
        id: this.genId(), role: 'tool_use', timestamp: ts,
        toolName: 'Read', toolInput: { file_path: p.path },
        content: JSON.stringify({ file_path: p.path }, null, 2),
        toolUseId: p.call_id,
      }];
    }

    // exec_command_end and patch_apply_end are skipped — the corresponding
    // response_item/function_call_output (or custom_tool_call_output) carries
    // the same data and is what we render. Token counts and task lifecycle
    // events are also dropped from the structured view (too noisy).
    return [];
  }

  // response_item payloads: message, reasoning, function_call,
  // function_call_output, custom_tool_call, custom_tool_call_output.
  private parseResponseItem(p: any, ts: number): ParsedMessage[] {
    const sub = p.type;

    if (sub === 'message') {
      const role = p.role;
      // developer messages are codex's system instructions — skip
      if (role === 'developer' || role === 'system') return [];
      const text = extractMessageText(p.content);
      if (!text) return [];
      if (role === 'user') {
        const sig = text.slice(0, 200);
        if (this.emittedUserMessages.has(sig)) return [];
        this.emittedUserMessages.add(sig);
        return [{ id: this.genId(), role: 'user_input', timestamp: ts, content: text }];
      }
      if (role === 'assistant') {
        const sig = text.slice(0, 200);
        if (this.emittedAssistantTexts.has(sig)) return [];
        this.emittedAssistantTexts.add(sig);
        return [{ id: this.genId(), role: 'assistant', timestamp: ts, content: text }];
      }
      return [];
    }

    if (sub === 'reasoning') {
      // Codex encrypts reasoning by default; only emit if there's a readable
      // summary or content array (rare in practice).
      const summary = Array.isArray(p.summary)
        ? p.summary.map((s: any) => s.text || s).filter(Boolean).join('\n')
        : '';
      const content = Array.isArray(p.content)
        ? p.content.map((c: any) => c.text || '').filter(Boolean).join('\n')
        : '';
      const text = (summary || content).trim();
      if (!text) return [];
      return [{ id: this.genId(), role: 'thinking', timestamp: ts, content: text }];
    }

    if (sub === 'function_call') {
      const name = p.name || 'function';
      let args: Record<string, unknown> = {};
      if (typeof p.arguments === 'string') {
        try { args = JSON.parse(p.arguments); } catch { args = { raw: p.arguments }; }
      } else if (p.arguments && typeof p.arguments === 'object') {
        args = p.arguments;
      }
      const { toolName, toolInput } = mapCodexToolCall(name, args);
      return [{
        id: this.genId(), role: 'tool_use', timestamp: ts,
        toolName, toolInput,
        content: JSON.stringify(toolInput, null, 2),
        toolUseId: p.call_id,
      }];
    }

    if (sub === 'function_call_output') {
      const out = parseFunctionCallOutput(p.output);
      return [{
        id: this.genId(), role: 'tool_result', timestamp: ts,
        content: out.content,
        isError: out.isError,
        toolUseResultId: p.call_id,
      }];
    }

    if (sub === 'custom_tool_call') {
      const name = p.name || 'custom_tool';
      const input = typeof p.input === 'string' ? p.input : JSON.stringify(p.input || {}, null, 2);
      const { toolName, toolInput } = mapCodexCustomToolCall(name, p.input);
      return [{
        id: this.genId(), role: 'tool_use', timestamp: ts,
        toolName, toolInput,
        content: input,
        toolUseId: p.call_id,
      }];
    }

    if (sub === 'custom_tool_call_output') {
      const out = parseCustomToolOutput(p.output);
      return [{
        id: this.genId(), role: 'tool_result', timestamp: ts,
        content: out.content,
        isError: out.isError,
        toolUseResultId: p.call_id,
      }];
    }

    return [];
  }

  // Codex `--json` exec stream uses item.started → item.completed lifecycle.
  // We emit a tool_use on started for command_execution / mcp_tool_call so the
  // UI shows "Running …", then attach the tool_result when it completes.
  private parseItemStarted(item: any): ParsedMessage[] {
    const itemType = item.type;
    const id = item.id || this.genId();

    if (itemType === 'command_execution') {
      const toolInput = { command: item.command || '' };
      this.startedItems.set(id, { toolName: 'Bash', toolInput, toolUseId: id });
      return [{
        id: this.genId(), role: 'tool_use', timestamp: Date.now(),
        toolName: 'Bash', toolInput,
        content: JSON.stringify(toolInput, null, 2),
        toolUseId: id,
      }];
    }

    if (itemType === 'mcp_tool_call') {
      const toolInput = item.arguments || {};
      const toolName = `mcp:${item.server || ''}/${item.tool || ''}`;
      this.startedItems.set(id, { toolName, toolInput, toolUseId: id });
      return [{
        id: this.genId(), role: 'tool_use', timestamp: Date.now(),
        toolName, toolInput,
        content: JSON.stringify(toolInput, null, 2),
        toolUseId: id,
      }];
    }

    return [];
  }

  private parseItemCompleted(item: any): ParsedMessage[] {
    const itemType = item.type;
    const id = item.id || '';

    if (itemType === 'agent_message' && item.text) {
      const sig = item.text.slice(0, 200);
      if (this.emittedAssistantTexts.has(sig)) return [];
      this.emittedAssistantTexts.add(sig);
      return [{ id: this.genId(), role: 'assistant', timestamp: Date.now(), content: item.text }];
    }

    if (itemType === 'reasoning' && item.text) {
      return [{ id: this.genId(), role: 'thinking', timestamp: Date.now(), content: item.text }];
    }

    if (itemType === 'command_execution') {
      const wasStarted = this.startedItems.delete(id);
      const out = item.aggregated_output || '';
      const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
      const result: ParsedMessage = {
        id: this.genId(), role: 'tool_result', timestamp: Date.now(),
        content: out, isError,
        toolUseResultId: id,
      };
      // If we never saw item.started, emit the tool_use first so the result
      // has something to attach to.
      if (!wasStarted) {
        const toolInput = { command: item.command || '' };
        return [
          { id: this.genId(), role: 'tool_use', timestamp: Date.now(), toolName: 'Bash', toolInput, content: JSON.stringify(toolInput, null, 2), toolUseId: id },
          result,
        ];
      }
      return [result];
    }

    if (itemType === 'file_change') {
      // Codex aggregates multi-file changes into a single FileChangeItem.
      // Render as a tool_use with the patch summary so the diff is visible.
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const summary = changes.map((c: any) => `${c.kind || 'edit'} ${c.path || ''}`).join('\n');
      return [{
        id: this.genId(), role: 'tool_use', timestamp: Date.now(),
        toolName: 'apply_patch',
        toolInput: { changes },
        content: summary || JSON.stringify(item, null, 2),
        toolUseId: id,
      }];
    }

    if (itemType === 'mcp_tool_call') {
      this.startedItems.delete(id);
      const out = item.result != null ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2)) : '';
      return [{
        id: this.genId(), role: 'tool_result', timestamp: Date.now(),
        content: out, isError: item.status === 'failed',
        toolUseResultId: id,
      }];
    }

    if (itemType === 'web_search') {
      return [{
        id: this.genId(), role: 'tool_use', timestamp: Date.now(),
        toolName: 'WebSearch', toolInput: { query: item.query || '' },
        content: JSON.stringify({ query: item.query }, null, 2),
        toolUseId: id,
      }];
    }

    if (itemType === 'todo_list') {
      const todos = Array.isArray(item.items) ? item.items : [];
      return [{
        id: this.genId(), role: 'tool_use', timestamp: Date.now(),
        toolName: 'TodoWrite', toolInput: { todos },
        content: JSON.stringify({ todos }, null, 2),
        toolUseId: id,
      }];
    }

    if (itemType === 'error') {
      return [{
        id: this.genId(), role: 'tool_result', timestamp: Date.now(),
        content: item.message || 'Codex item error', isError: true,
      }];
    }

    return [];
  }

  getMessages(): ParsedMessage[] {
    return this.messages;
  }
}

function extractMessageText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => b?.text || b?.input_text || b?.output_text || '')
    .filter(Boolean)
    .join('\n');
}

function mapCodexToolCall(name: string, args: Record<string, unknown>): { toolName: string; toolInput: Record<string, unknown> } {
  // exec_command / unified_exec / shell — surface as Bash so the existing
  // renderer's syntax highlighting + copy button kick in.
  if (name === 'exec_command' || name === 'unified_exec' || name === 'shell') {
    const cmd = (args as any).cmd || (args as any).command || '';
    const command = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
    const input: Record<string, unknown> = { command };
    if ((args as any).workdir) input.cwd = (args as any).workdir;
    if ((args as any).timeout) input.timeout = (args as any).timeout;
    return { toolName: 'Bash', toolInput: input };
  }
  // Default: pass through tool name + raw args.
  return { toolName: name, toolInput: args };
}

function mapCodexCustomToolCall(name: string, input: any): { toolName: string; toolInput: Record<string, unknown> } {
  // apply_patch is Codex's primary file-edit tool. Surface it under its own
  // name so callers can recognize it; the patch text is in `content`.
  if (name === 'apply_patch') {
    const patchText = typeof input === 'string' ? input : JSON.stringify(input || {});
    return { toolName: 'apply_patch', toolInput: { patch: patchText } };
  }
  return { toolName: name, toolInput: typeof input === 'object' && input ? input : { input } };
}

// Codex wraps function_call_output `output` strings in a header like:
//   "Chunk ID: abc\nWall time: 0.001 s\nProcess exited with code 0\nOriginal token count: 30\nOutput:\n<actual stdout>"
// Strip the header so the rendered tool_result is the bare command output.
function parseFunctionCallOutput(raw: any): { content: string; isError: boolean } {
  if (raw == null) return { content: '', isError: false };
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  let isError = false;
  const exitMatch = text.match(/^Process exited with code (\-?\d+)/m);
  if (exitMatch && parseInt(exitMatch[1], 10) !== 0) isError = true;
  const outputIdx = text.indexOf('\nOutput:\n');
  if (outputIdx >= 0) {
    return { content: text.slice(outputIdx + '\nOutput:\n'.length), isError };
  }
  return { content: text, isError };
}

// custom_tool_call_output for apply_patch is a JSON string like:
//   {"output":"Success. Updated ...","metadata":{"exit_code":0,"duration_seconds":0.0}}
function parseCustomToolOutput(raw: any): { content: string; isError: boolean } {
  if (raw == null) return { content: '', isError: false };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      const isError = parsed?.metadata?.exit_code != null && parsed.metadata.exit_code !== 0;
      return { content: parsed?.output ?? raw, isError };
    } catch {
      return { content: raw, isError: false };
    }
  }
  const isError = raw?.metadata?.exit_code != null && raw.metadata.exit_code !== 0;
  return { content: raw?.output ?? JSON.stringify(raw, null, 2), isError };
}
