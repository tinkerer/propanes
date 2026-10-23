/** Leading bracket options on a Slack request: `[claude, verbose, images] review PR 2013`. */
export type Runtime = 'claude' | 'codex';
export type OutputMode = 'default' | 'verbose' | 'quiet';

export interface ParsedCommand {
  command: 'help' | 'status' | 'list-apps' | 'list-infra' | 'list-sessions' | 'list-terminals' | 'prompt';
  runtime?: Runtime;
  terminal?: boolean;
  session?: boolean;
  mode?: OutputMode;
  images?: boolean;
  /** `[app:<name>]` — the ProPanes application (project) to run in, as typed (lower-cased). */
  app?: string;
  /** `[infra:<name>]` — the connected machine/launcher to run on, as typed (lower-cased). */
  infra?: string;
  /** The request text with mentions and bracket options removed. */
  text: string;
  /** Set when the options are unknown or conflict; nothing must be dispatched. */
  error?: string;
}

export const KNOWN_OPTIONS = ['claude', 'codex', 'verbose', 'quiet', 'default', 'images', 'terminal', 'session', 'help', 'status', 'list-apps', 'app:<name>', 'list-infra', 'infra:<name>', 'list-sessions', 'list-terminals', 'apps', 'infra', 'sessions', 'terminals'] as const;
const STANDALONE = ['help', 'status', 'list-apps', 'list-infra'] as const;
const VALUE_TOKEN = /^(app|infra)\s*[:=]\s*(.*)$/;

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

/** Parse every leading `[...]` group, case-insensitively, with comma- or space-separated options. */
export function parseCommand(raw: string, botUserId?: string): ParsedCommand {
  let text = decodeSlackText(stripMentions(raw ?? '', botUserId));
  let tokens: string[] = [];
  const bracket = /^\[([^\]]*)\]\s*/;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(text)) !== null) {
    for (const part of m[1].split(/,|\s+(?=(?:(?:app|infra)\s*[:=]|claude\b|codex\b|verbose\b|quiet\b|default\b|images\b|terminal\b|session\b|help\b|status\b|list-apps\b|list-infra\b|list-sessions\b|list-terminals\b|apps\b|infra\b|sessions\b|terminals\b))/i)) {
      const t = part.trim().toLowerCase();
      if (t) tokens.push(t);
    }
    text = text.slice(m[0].length);
  }
  text = text.trim();

  const values: Record<'app' | 'infra', string[]> = { app: [], infra: [] };
  const plain: string[] = [];
  for (const t of tokens) {
    const m = VALUE_TOKEN.exec(t);
    if (m) values[m[1] as 'app' | 'infra'].push(m[2].trim());
    else plain.push(t === 'apps' ? 'list-apps' : t === 'infra' || t === 'machines' ? 'list-infra' : t === 'sessions' ? 'list-sessions' : t === 'terminals' ? 'list-terminals' : t);
  }
  for (const [key, example, list] of [['app', 'my-app', 'apps'], ['infra', 'laptop', 'infra']] as const) {
    if (values[key].some((v) => !v)) {
      return { command: 'prompt', text, error: `\`[${key}:]\` needs a name, e.g. \`[${key}:${example}]\`. Send \`[${list}]\` to see them.` };
    }
    if (values[key].length > 1) {
      return { command: 'prompt', text, error: `Choose one ${key === 'app' ? 'application' : 'infrastructure target'}: ${values[key].map((v) => `\`[${key}:${v}]\``).join(' or ')}, not both.` };
    }
  }
  const appValues = values.app;
  const valueTokens = [...values.app.map((v) => `app:${v}`), ...values.infra.map((v) => `infra:${v}`)];
  tokens = plain;
  const unknown = tokens.filter((t) => !(KNOWN_OPTIONS as readonly string[]).includes(t));
  if (unknown.length) {
    return {
      command: 'prompt', text,
      error: `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `\`${u}\``).join(', ')}. Known options: ${KNOWN_OPTIONS.map((o) => `\`${o}\``).join(', ')}. Send \`[help]\` for details.`,
    };
  }
  const has = (t: string) => tokens.includes(t);
  const listing = (['list-sessions', 'list-terminals'] as const).find(has);
  if (listing) {
    const others = tokens.filter(t => t !== listing);
    if (others.length || values.infra.length || (listing === 'list-terminals' && appValues.length) || text) {
      return { command: listing, text, error: `\`[${listing.replace(/^list-/, '')}]\` accepts ${listing === 'list-sessions' ? 'only an optional app selector' : 'no other options'} and no prompt text.` };
    }
    return { command: listing, text, ...(appValues.length ? { app: appValues[0] } : {}) };
  }
  const standalone = STANDALONE.find(has);
  if (standalone) {
    const others = tokens.filter((t) => t !== standalone);
    if (others.length || valueTokens.length) {
      const all = [...tokens, ...valueTokens];
      return { command: standalone, text, error: `\`[${standalone.replace(/^list-/, '')}]\` cannot be combined with other options (got \`[${all.join(', ')}]\`).` };
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
  if (has('terminal') && (has('session') || has('claude') || has('codex') || has('images') || modes.length || text)) {
    return { command: 'prompt', text, error: 'Use `[terminal]` with optional `app:` / `infra:` selectors and no prompt or agent/output options.' };
  }
  const out: ParsedCommand = { command: 'prompt', text };
  if (has('terminal')) out.terminal = true;
  if (has('session')) out.session = true;
  if (has('claude')) out.runtime = 'claude';
  if (has('codex')) out.runtime = 'codex';
  if (modes.length === 1) out.mode = modes[0];
  if (has('images')) out.images = true;
  if (appValues.length === 1) out.app = appValues[0];
  if (values.infra.length === 1) out.infra = values.infra[0];
  return out;
}

export function isStopKeyword(text: string): boolean {
  return /^\s*(stop|halt|cancel|kill)\s*[.!]?\s*$/i.test(text);
}
