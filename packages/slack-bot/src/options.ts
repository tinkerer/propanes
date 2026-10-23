/** Leading bracket options on a Slack request: `[claude, verbose, images] review PR 2013`. */
export type Runtime = 'claude' | 'codex';
export type OutputMode = 'default' | 'verbose' | 'quiet';

export interface ParsedCommand {
  command: 'help' | 'status' | 'list-apps' | 'prompt';
  runtime?: Runtime;
  mode?: OutputMode;
  images?: boolean;
  /** `[app:<name>]` — the ProPanes application (project) to run in, as typed (lower-cased). */
  app?: string;
  /** The request text with mentions and bracket options removed. */
  text: string;
  /** Set when the options are unknown or conflict; nothing must be dispatched. */
  error?: string;
}

export const KNOWN_OPTIONS = ['claude', 'codex', 'verbose', 'quiet', 'default', 'images', 'help', 'status', 'list-apps', 'app:<name>'] as const;
const STANDALONE = ['help', 'status', 'list-apps'] as const;
const APP_TOKEN = /^app\s*[:=]\s*(.*)$/;

const MENTION_RE = /<@[A-Z0-9]+(?:\|[^>]*)?>/g;

/** Remove the bot's own mention (every mention when its user id is unknown). */
export function stripMentions(text: string, botUserId?: string): string {
  const re = botUserId ? new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g') : MENTION_RE;
  return text.replace(re, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** Turn Slack's message markup into plain text for the agent: `<url|label>` →
 * `label (url)`, `<mailto:a|a>` → `a`, `<#C1|chan>` → `#chan`, `<!here>` →
 * `@here`, and HTML entities unescaped. Mentions of people are left alone so
 * `stripMentions` can still find the bot's. */
export function decodeSlackText(text: string): string {
  return text
    .replace(/<(mailto|tel):([^|>]+)(?:\|([^>]*))?>/g, (_m, _s, addr, label) => label || addr)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_m, url, label) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/<(https?:\/\/[^|>]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Parse every leading `[...]` group, case-insensitively, comma separated. */
export function parseCommand(raw: string, botUserId?: string): ParsedCommand {
  let text = decodeSlackText(stripMentions(raw ?? '', botUserId));
  let tokens: string[] = [];
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

  const appValues: string[] = [];
  const plain: string[] = [];
  for (const t of tokens) {
    const m = APP_TOKEN.exec(t);
    if (m) appValues.push(m[1].trim());
    else plain.push(t === 'apps' ? 'list-apps' : t);
  }
  if (appValues.some((v) => !v)) {
    return { command: 'prompt', text, error: '`[app:]` needs an application name, e.g. `[app:atlas]`. Send `[list-apps]` to see them.' };
  }
  if (appValues.length > 1) {
    return { command: 'prompt', text, error: `Choose one application: ${appValues.map((v) => `\`[app:${v}]\``).join(' or ')}, not both.` };
  }
  tokens = plain;
  const unknown = tokens.filter((t) => !(KNOWN_OPTIONS as readonly string[]).includes(t));
  if (unknown.length) {
    return {
      command: 'prompt', text,
      error: `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `\`${u}\``).join(', ')}. Known options: ${KNOWN_OPTIONS.map((o) => `\`${o}\``).join(', ')}. Send \`[help]\` for details.`,
    };
  }
  const has = (t: string) => tokens.includes(t);
  const standalone = STANDALONE.find(has);
  if (standalone) {
    const others = tokens.filter((t) => t !== standalone);
    if (others.length || appValues.length) {
      const all = [...tokens, ...appValues.map((v) => `app:${v}`)];
      return { command: standalone, text, error: `\`[${standalone}]\` cannot be combined with other options (got \`[${all.join(', ')}]\`).` };
    }
    return { command: standalone, text };
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
  if (appValues.length === 1) out.app = appValues[0];
  return out;
}

export function isStopKeyword(text: string): boolean {
  return /^\s*(stop|halt|cancel|kill)\s*[.!]?\s*$/i.test(text);
}
