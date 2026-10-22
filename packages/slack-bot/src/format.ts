/** Slack mrkdwn rendering of transcript events, with coherent chunking. */
import type { ParsedMessage } from './transcript';
import type { OutputMode } from './options';
import { stripCosReplyTags } from './cos-reply';

export const SLACK_CHUNK = 3800;
const TOOL_INPUT_MAX = 600;
const TOOL_RESULT_MAX = 900;
const THINKING_MAX = 400;

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Light markdown → mrkdwn. Code blocks are kept verbatim (escaped only). */
export function toMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return escapeMrkdwn(part);
    let t = escapeMrkdwn(part);
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
    t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');
    return t;
  }).join('');
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${(s.length - max).toLocaleString()} chars)`;
}

/** Split long text on paragraph/line boundaries, keeping code fences balanced. */
export function chunkText(text: string, max = SLACK_CHUNK): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  let openFence = false;
  while (rest.length > 0) {
    const prefix = openFence ? '```\n' : '';
    const budget = max - prefix.length - 4;
    if (rest.length <= budget) {
      chunks.push(prefix + rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', budget);
    if (cut < budget / 2) cut = rest.lastIndexOf('\n', budget);
    if (cut < budget / 2) cut = rest.lastIndexOf(' ', budget);
    if (cut < budget / 2) cut = budget;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, '');
    const fences = (piece.match(/```/g) || []).length;
    const endsOpen = (openFence ? 1 : 0) + fences;
    piece = prefix + piece;
    if (endsOpen % 2 === 1) {
      piece += '\n```';
      openFence = true;
    } else {
      openFence = false;
    }
    chunks.push(piece);
  }
  return chunks;
}

export function summarizeToolInput(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  switch (name) {
    case 'Bash': case 'bash': return str('command') ?? '';
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return str('file_path') ?? str('path') ?? '';
    case 'Glob': case 'Grep': return [str('pattern'), str('path')].filter(Boolean).join('  in ');
    case 'WebFetch': case 'WebSearch': return str('url') ?? str('query') ?? '';
    case 'Task': case 'Agent': return str('description') ?? str('prompt') ?? '';
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v) return v;
  return JSON.stringify(input);
}

/** Render one structured-view event for Slack, or null when the mode hides it. */
export function renderEvent(msg: ParsedMessage, mode: OutputMode): string | null {
  if (mode === 'quiet') return null;
  const sub = msg.subagentId ? '↳ ' : '';
  switch (msg.role) {
    case 'assistant': {
      if (mode === 'default' && msg.subagentId) return null;
      const text = stripCosReplyTags(msg.content);
      return text ? sub + toMrkdwn(text) : null;
    }
    case 'user_input':
      return null; // the human's own prompt (or a harness-injected one)
    case 'tool_use': {
      if (mode !== 'verbose') return null;
      const summary = summarizeToolInput(msg.toolName, msg.toolInput);
      const name = escapeMrkdwn(msg.toolName || 'tool');
      return summary
        ? `${sub}🔧 *${name}*\n\`\`\`\n${escapeMrkdwn(truncate(summary, TOOL_INPUT_MAX))}\n\`\`\``
        : `${sub}🔧 *${name}*`;
    }
    case 'tool_result': {
      if (mode !== 'verbose') return null;
      const body = stripImageRefs(msg.content).trim();
      const label = msg.isError ? '⚠️ result (error)' : '↩︎ result';
      if (!body) return `${sub}${label}: _(no text output)_`;
      return `${sub}${label}\n\`\`\`\n${escapeMrkdwn(truncate(body, TOOL_RESULT_MAX))}\n\`\`\``;
    }
    case 'thinking':
      if (mode !== 'verbose' || !msg.content.trim()) return null;
      return `${sub}💭 _${escapeMrkdwn(truncate(msg.content.trim(), THINKING_MAX))}_`;
    case 'system':
      if (mode !== 'verbose') return null;
      return `${sub}_${escapeMrkdwn(truncate(msg.content, 300))}_`;
  }
  return null;
}

export function stripImageRefs(content: string): string {
  return content
    .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
    .replace(/\/api\/v1\/admin\/agent-sessions\/[\w-]+\/jsonl-image\/[\w-]+\/\d+/g, '[image]')
    .replace(/\[image elided: [^\]]*\]/g, '[image]');
}

/** Merge consecutive renderable pieces into as few Slack posts as possible. */
export function coalesce(pieces: string[], max = SLACK_CHUNK): string[] {
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const chunks = chunkText(piece, max);
    for (const chunk of chunks) {
      if (!current) current = chunk;
      else if (current.length + 2 + chunk.length <= max) current = `${current}\n\n${chunk}`;
      else { out.push(current); current = chunk; }
    }
  }
  if (current) out.push(current);
  return out;
}
