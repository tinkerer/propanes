// Convert the JSONL transcript stream (ParsedMessage[]) into the bubble's
// ChiefOfStaffMsg[] shape, so the thread side panel can render the agent's
// real session output with the same slack-style avatar + author + content
// rows the main bubble uses.
//
// The JSONL has one event per line — a user_input, an assistant text block,
// a tool_use, a tool_result, a thinking block. The bubble groups all of
// these into "turns" (one assistant message per user message). This module
// does the same grouping client-side, with two extras:
//   - tool_result content is merged onto its tool_use call so the chip
//     can reveal the result on click (matches MessageBubble's behavior).
//   - thinking blocks are dropped — the slack-style view is for finished
//     output, not the model's scratch work.
//
// Sub-agent (Task) messages (tagged with subagentId) are filtered out here
// because they belong in a dedicated sub-tab, not the main flow. The main
// thread shows the parent agent's work; subagents render alongside.

import type { ParsedMessage } from './output-parser.js';
import type {
  ChiefOfStaffMsg,
  ChiefOfStaffToolCall,
} from './chief-of-staff.js';

export function jsonlToCosMessages(messages: ParsedMessage[]): ChiefOfStaffMsg[] {
  const main = messages.filter((m) => !m.subagentId);

  // Index tool_results by tool_use_id so we can attach them inline.
  const resultByUseId = new Map<string, ParsedMessage>();
  for (const m of main) {
    if (m.role === 'tool_result' && m.toolUseResultId) {
      resultByUseId.set(m.toolUseResultId, m);
    }
  }

  const out: ChiefOfStaffMsg[] = [];
  let assistant: ChiefOfStaffMsg | null = null;

  const flushAssistant = () => {
    if (assistant) {
      out.push(assistant);
      assistant = null;
    }
  };

  for (const m of main) {
    if (m.role === 'user_input') {
      flushAssistant();
      // user_input wraps the user's outgoing text; carry it through. Skip
      // empty system-bookkeeping inputs (e.g. injected meta-context lines)
      // by suppressing trivial entries — keeps the slack feed clean.
      const text = (m.content || '').trim();
      if (!text) continue;
      out.push({
        role: 'user',
        text,
        timestamp: m.timestamp,
      });
    } else if (m.role === 'system') {
      flushAssistant();
      out.push({
        role: 'system',
        text: m.content || '',
        timestamp: m.timestamp,
      });
    } else if (m.role === 'assistant') {
      if (!assistant) {
        assistant = {
          role: 'assistant',
          text: '',
          timestamp: m.timestamp,
          toolCalls: [],
        };
      }
      const piece = (m.content || '').trim();
      if (piece) {
        assistant.text = assistant.text
          ? `${assistant.text}\n\n${piece}`
          : piece;
      }
    } else if (m.role === 'tool_use') {
      if (!assistant) {
        assistant = {
          role: 'assistant',
          text: '',
          timestamp: m.timestamp,
          toolCalls: [],
        };
      }
      const result = m.toolUseId ? resultByUseId.get(m.toolUseId) : undefined;
      const call: ChiefOfStaffToolCall = {
        id: m.toolUseId,
        name: m.toolName || 'tool',
        input: (m.toolInput || {}) as Record<string, unknown>,
        result: result && !result.isError ? result.content : undefined,
        error: result && result.isError ? result.content : undefined,
      };
      assistant.toolCalls = [...(assistant.toolCalls || []), call];
    }
    // tool_result handled via the lookup above; thinking blocks dropped.
  }
  flushAssistant();
  return out;
}
