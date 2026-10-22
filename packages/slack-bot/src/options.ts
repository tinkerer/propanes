/** Leading bracket options on a Slack request: `[claude, verbose, images] review PR 2013`. */
export type Runtime = 'claude' | 'codex';
export type OutputMode = 'default' | 'verbose' | 'quiet';

export interface ParsedCommand {
  command: 'help' | 'status' | 'prompt';
  runtime?: Runtime;
  mode?: OutputMode;
  images?: boolean;
  /** The request text with mentions and bracket options removed. */
  text: string;
  /** Set when the options are unknown or conflict; nothing must be dispatched. */
  error?: string;
}

export const KNOWN_OPTIONS = ['claude', 'codex', 'verbose', 'quiet', 'default', 'images', 'help', 'status'] as const;

const MENTION_RE = /<@[A-Z0-9]+(?:\|[^>]*)?>/g;

/** Remove the bot's own mention (every mention when its user id is unknown). */
export function stripMentions(text: string, botUserId?: string): string {
  const re = botUserId ? new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g') : MENTION_RE;
  return text.replace(re, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** Parse every leading `[...]` group, case-insensitively, comma separated. */
export function parseCommand(raw: string, botUserId?: string): ParsedCommand {
  let text = stripMentions(raw ?? '', botUserId);
  const tokens: string[] = [];
  const bracket = /^\[([^\]]*)\]\s*/;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().toLowerCase();
      if (t) tokens.push(t);
    }
    text = text.slice(m[0].length);
  }
  text = text.trim();

  const unknown = tokens.filter((t) => !(KNOWN_OPTIONS as readonly string[]).includes(t));
  if (unknown.length) {
    return {
      command: 'prompt', text,
      error: `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `\`${u}\``).join(', ')}. Known options: ${KNOWN_OPTIONS.map((o) => `\`${o}\``).join(', ')}. Send \`[help]\` for details.`,
    };
  }
  const has = (t: string) => tokens.includes(t);
  if (has('help') || has('status')) {
    const cmd = has('help') ? 'help' : 'status';
    const others = tokens.filter((t) => t !== cmd);
    if (others.length || (has('help') && has('status'))) {
      return { command: cmd, text, error: `\`[${cmd}]\` cannot be combined with other options (got \`[${tokens.join(', ')}]\`).` };
    }
    return { command: cmd, text };
  }
  if (has('claude') && has('codex')) {
    return { command: 'prompt', text, error: 'Choose one agent: `[claude]` or `[codex]`, not both.' };
  }
  const modes = (['verbose', 'quiet', 'default'] as const).filter(has);
  if (modes.length > 1) {
    return { command: 'prompt', text, error: `Choose one output mode: ${modes.map((x) => `\`[${x}]\``).join(' or ')} are mutually exclusive.` };
  }
  const out: ParsedCommand = { command: 'prompt', text };
  if (has('claude')) out.runtime = 'claude';
  if (has('codex')) out.runtime = 'codex';
  if (modes.length === 1) out.mode = modes[0];
  if (has('images')) out.images = true;
  return out;
}

export function isStopKeyword(text: string): boolean {
  return /^\s*(stop|halt|cancel|kill)\s*[.!]?\s*$/i.test(text);
}
