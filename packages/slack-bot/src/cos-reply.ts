/** Final-answer extraction for quiet mode: only complete, closed <cos-reply> blocks count. */
const BLOCK_RE = /<cos-reply(?:\s[^>]*)?>([\s\S]*?)<\/cos-reply>/gi;
const TAG_RE = /<\/?cos-reply(?:\s[^>]*)?>/gi;
// A tag cut off at the end of a text block: `<`/`</` followed by any prefix of `cos-reply`.
const PARTIAL_TAIL_RE = /<\/?c(?:o(?:s(?:-(?:r(?:e(?:p(?:l(?:y(?:\s[^>]*)?)?)?)?)?)?)?)?)?$/i;

/** Every closed block in order, trimmed, empty ones dropped. */
export function cosReplyBlocks(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

/** The agent's final answer: the LAST closed block across the turn's assistant text.
 * An early acknowledgement wrapped in tags is superseded by the final one, and a
 * block whose closing tag has not been written yet is never returned. */
export function extractFinalCosReply(texts: string[]): string | null {
  const blocks = cosReplyBlocks(texts.join('\n'));
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/** True when an opening tag has no matching close in the text seen so far. */
export function hasOpenCosReply(text: string): boolean {
  const opens = (text.match(/<cos-reply(?:\s[^>]*)?>/gi) || []).length;
  const closes = (text.match(/<\/cos-reply>/gi) || []).length;
  return opens > closes;
}

/** Keep the answer, drop the protocol tags (including a stray partial one). */
export function stripCosReplyTags(text: string): string {
  return text.replace(TAG_RE, '').replace(PARTIAL_TAIL_RE, '').trim();
}
