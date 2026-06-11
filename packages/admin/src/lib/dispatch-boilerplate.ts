// Machine-facing boilerplate the server appends to dispatched prompts —
// hide it from operator-facing message renderings.
//
// Current format (COS_REPLY_DISPATCH_HINT in server dispatch.ts): a single
// trailing parenthetical teaching the <cos-reply> wrap.
const COS_REPLY_HINT_RE = /\s*\(Implement directly\.[\s\S]*?Inbox thread\.\)\s*/g;

// Legacy formats, no longer produced (the "[AGENT NOTE]" preamble was removed
// from dispatch.ts on 2026-06-11) but still present in historical sessions
// and threads:
//  - [AGENT NOTE] … [/AGENT NOTE] block — strip the whole block
//  - a leading "[AGENT NOTE]" line with no closing tag, followed by one
//    boilerplate paragraph — strip the marker line + first paragraph
const LEGACY_NOTE_BLOCK_RE = /\[AGENT NOTE\][\s\S]*?\[\/AGENT NOTE\]\s*/g;
const LEGACY_NOTE_OPEN_RE = /^\s*\[AGENT NOTE\]\s*\n[\s\S]*?(?:\n\s*\n|$)/;

export function stripDispatchBoilerplate(content: string): string {
  let stripped = content.replace(COS_REPLY_HINT_RE, '\n');
  const beforeLegacy = stripped;
  stripped = stripped.replace(LEGACY_NOTE_BLOCK_RE, '');
  if (stripped === beforeLegacy) stripped = stripped.replace(LEGACY_NOTE_OPEN_RE, '');
  stripped = stripped.trim();
  // If the message was nothing but boilerplate, keep the original rather
  // than rendering an empty bubble.
  return stripped || content.trim();
}
