// Pure markdown / linkifying / artifact-segment parsing helpers extracted
// from CosMessage.tsx. No JSX, no React/Preact imports — these helpers run
// before render and have no UI side effects.

import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

export const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', graphql: 'graphql',
  swift: 'swift', kt: 'kotlin', cs: 'csharp',
  lua: 'lua', pl: 'perl', php: 'php', r: 'r',
  diff: 'diff', patch: 'diff', md: 'markdown', mdx: 'markdown',
};

export const ULID_RE = /\b01[A-Z0-9]{24}\b/g;
// Matches http(s) URLs and bare host:port patterns (e.g. azstaging.myworkbench.ai:6080)
export const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})(?:\/[^\s<>"')\]]*)?/gi;

// Wrap ULID matches and URL matches in CoS-rendered HTML with clickable anchors.
// Skips text inside <code>, <pre>, and existing <a> tags.
export function linkifyHtml(html: string): string {
  const tokens = html.split(/(<[^>]*>)/);
  let inCode = 0, inPre = 0, inAnchor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('<')) {
      const lower = tok.toLowerCase();
      if (/^<code(\s|>|\/)/.test(lower)) inCode++;
      else if (lower.startsWith('</code')) inCode = Math.max(0, inCode - 1);
      if (/^<pre(\s|>|\/)/.test(lower)) inPre++;
      else if (lower.startsWith('</pre')) inPre = Math.max(0, inPre - 1);
      if (/^<a(\s|>)/.test(lower)) inAnchor++;
      else if (lower.startsWith('</a')) inAnchor = Math.max(0, inAnchor - 1);
      continue;
    }
    if (inPre || inAnchor) continue;
    ULID_RE.lastIndex = 0;
    URL_RE.lastIndex = 0;
    let out = '';
    let last = 0;
    const text = tokens[i];
    const matches: { index: number; len: number; replacement: string }[] = [];
    let m: RegExpExecArray | null;
    ULID_RE.lastIndex = 0;
    while ((m = ULID_RE.exec(text)) !== null) {
      matches.push({ index: m.index, len: m[0].length,
        replacement: `<a class="cos-ulid-link" data-cos-session-id="${m[0]}" href="#" title="Open session ${m[0]}">${m[0]}</a>` });
    }
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      const raw = m[0];
      const href = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      if (matches.some(ex => m!.index < ex.index + ex.len && m!.index + raw.length > ex.index)) continue;
      matches.push({ index: m.index, len: raw.length,
        replacement: `<a class="cos-url-link" data-cos-url="${href}" href="#" title="Open in companion: ${raw}">${raw}</a>` });
    }
    matches.sort((a, b) => a.index - b.index);
    for (const mx of matches) {
      out += text.slice(last, mx.index) + mx.replacement;
      last = mx.index + mx.len;
    }
    out += text.slice(last);
    tokens[i] = out;
  }
  return tokens.join('');
}

export function extOf(path: string): string {
  const base = path.split('/').pop() || '';
  return base.split('.').pop()?.toLowerCase() || '';
}

export type ArtifactKind = 'code' | 'list' | 'table';

export type ContentSegment =
  | { type: 'prose'; markdown: string }
  | {
      type: 'artifact';
      kind: ArtifactKind;
      label: string;
      meta: string;
      lang?: string;
      filename?: string;
      raw: string;
    };

function deriveListLabel(token: any): { label: string; meta: string } {
  const items: any[] = Array.isArray(token.items) ? token.items : [];
  const n = items.length;
  const meta = `${n} item${n === 1 ? '' : 's'}`;
  const first = items[0];
  const rawFirst = typeof first?.text === 'string' ? first.text : '';
  const hint = rawFirst.split('\n')[0].replace(/[*_`]/g, '').trim().slice(0, 48);
  return { label: hint ? hint : 'List', meta };
}

function deriveTableLabel(token: any): { label: string; meta: string } {
  const rows: any[] = Array.isArray(token.rows) ? token.rows : [];
  const header: any[] = Array.isArray(token.header) ? token.header : [];
  const cols = header.length || (rows[0]?.length ?? 0);
  const meta = `${rows.length} row${rows.length === 1 ? '' : 's'} × ${cols} col${cols === 1 ? '' : 's'}`;
  const headText = header
    .map((h: any) => (typeof h?.text === 'string' ? h.text : ''))
    .filter(Boolean)
    .join(' · ')
    .slice(0, 48);
  return { label: headText || 'Table', meta };
}

function deriveCodeLabel(token: any): { label: string; meta: string; lang: string; filename?: string } {
  const rawLang = typeof token.lang === 'string' ? token.lang.trim() : '';
  const info = typeof (token as any).info === 'string' ? (token as any).info : '';
  let filename: string | undefined;
  const kv = info.match(/filename\s*=\s*("([^"]+)"|([^\s]+))/);
  if (kv) filename = kv[2] || kv[3];
  else {
    const tail = info.replace(/^\s*\S+\s*/, '').trim();
    if (tail && !tail.includes('=')) filename = tail.split(/\s+/)[0];
  }
  const text = typeof token.text === 'string' ? token.text : '';
  const lines = text.split('\n').length;
  const lang = rawLang || (filename ? EXT_TO_LANG[extOf(filename)] || '' : '');
  const label = filename || lang || 'code';
  const meta = `${lines} line${lines === 1 ? '' : 's'}${lang && label !== lang ? ` · ${lang}` : ''}`;
  return { label, meta, lang, filename };
}

export function parseAssistantContent(text: string): ContentSegment[] {
  if (!text) return [];
  let tokens: any[];
  try {
    tokens = marked.lexer(text) as any[];
  } catch {
    return [{ type: 'prose', markdown: text }];
  }

  const segments: ContentSegment[] = [];
  let proseBuffer = '';

  const flushProse = () => {
    if (proseBuffer.trim()) {
      segments.push({ type: 'prose', markdown: proseBuffer });
    }
    proseBuffer = '';
  };

  for (const tok of tokens) {
    const raw = typeof tok.raw === 'string' ? tok.raw : '';
    if (tok.type === 'code') {
      const d = deriveCodeLabel(tok);
      flushProse();
      segments.push({ type: 'artifact', kind: 'code', label: d.label, meta: d.meta, lang: d.lang, filename: d.filename, raw });
      continue;
    }
    if (tok.type === 'list') {
      const d = deriveListLabel(tok);
      flushProse();
      segments.push({ type: 'artifact', kind: 'list', label: d.label, meta: d.meta, raw });
      continue;
    }
    if (tok.type === 'table') {
      const d = deriveTableLabel(tok);
      flushProse();
      segments.push({ type: 'artifact', kind: 'table', label: d.label, meta: d.meta, raw });
      continue;
    }
    proseBuffer += raw;
  }
  flushProse();

  return segments;
}
