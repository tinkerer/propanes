// <cos-reply> tag parsing for the assistant message stream.
//
// The CoS agent is instructed to wrap user-facing text in <cos-reply>...
// </cos-reply> tags; everything outside is internal scratch work. These
// helpers pull the user-facing text out for normal display, and strip the
// markers entirely for the verbose ("show me everything") view.

/**
 * Extract the user-facing reply(s) from an assistant message. The model is
 * instructed to wrap its reply in <cos-reply>...</cos-reply>; anything outside
 * is internal reasoning. The model may emit MULTIPLE tags per turn (typically
 * an ack/ETA tag first, then a final-answer tag) — this extractor concatenates
 * all closed segments and appends any currently-open tail so streaming stays
 * visible. If no tag is present (model misbehaved or stream hasn't reached the
 * first open tag), returns the original text so something is visible.
 * isOpen = true while a tag is open but not yet closed (streaming).
 */
export function extractCosReply(text: string): { displayText: string; hasTag: boolean; isOpen: boolean } {
  if (!text) return { displayText: '', hasTag: false, isOpen: false };
  const openRe = /<cos-reply(?:\s[^>]*)?>/g;
  const segments: string[] = [];
  let isOpen = false;
  let hasTag = false;
  let idx = 0;
  while (idx < text.length) {
    openRe.lastIndex = idx;
    const openMatch = openRe.exec(text);
    if (!openMatch) break;
    hasTag = true;
    const contentStart = openMatch.index + openMatch[0].length;
    const rest = text.slice(contentStart);
    const closeIdx = rest.indexOf('</cos-reply>');
    if (closeIdx === -1) {
      segments.push(rest.replace(/^\s+/, ''));
      isOpen = true;
      break;
    }
    segments.push(rest.slice(0, closeIdx).trim());
    idx = contentStart + closeIdx + '</cos-reply>'.length;
  }
  if (!hasTag) return { displayText: text, hasTag: false, isOpen: false };
  const joined = segments.filter((s) => s.length > 0).join('\n\n');
  return { displayText: joined, hasTag: true, isOpen };
}

/**
 * Verbose display: strip the <cos-reply> markers so the raw text is visible,
 * including any scratch-work / planning the model emitted outside the tags.
 * Used when the agent's verbosity is set to 'verbose' — matches the user
 * request to "take all the text parts from the jsonl and send them to CoS".
 */
export function stripCosReplyMarkers(text: string): string {
  if (!text) return '';
  return text
    .replace(/<cos-reply(?:\s[^>]*)?>/g, '')
    .replace(/<\/cos-reply>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
