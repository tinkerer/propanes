// Dispatched sessions get an [AGENT NOTE] preamble prepended to their prompt
// (IMPLEMENTATION_AGENT_PREAMBLE in server dispatch.ts). It's machine-facing
// boilerplate — hide it from operator-facing message renderings.
//
// Two formats exist in the wild:
//  - current: [AGENT NOTE] … [/AGENT NOTE] block — strip the whole block
//  - legacy: a leading "[AGENT NOTE]" line with no closing tag, followed by
//    one boilerplate paragraph — strip the marker line + first paragraph
const AGENT_NOTE_BLOCK_RE = /\[AGENT NOTE\][\s\S]*?\[\/AGENT NOTE\]\s*/g;
const AGENT_NOTE_LEGACY_RE = /^\s*\[AGENT NOTE\]\s*\n[\s\S]*?(?:\n\s*\n|$)/;

export function stripAgentNote(content: string): string {
  let stripped = content.replace(AGENT_NOTE_BLOCK_RE, '');
  if (stripped === content) stripped = content.replace(AGENT_NOTE_LEGACY_RE, '');
  stripped = stripped.trim();
  // If the message was nothing but the note, keep the original rather than
  // rendering an empty bubble.
  return stripped || content.trim();
}
