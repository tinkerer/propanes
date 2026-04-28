import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import {
  getSessionIdForThread,
  retryFailedAssistantMessage,
  dismissFailedAssistantMessage,
  type ChiefOfStaffMsg,
  type ChiefOfStaffVerbosity,
  type CosImageAttachment,
  type CosElementRef,
} from '../lib/chief-of-staff.js';
import { stripCosReplyMarkers } from '../lib/cos-reply-tags.js';
import { openSession, toggleCompanion } from '../lib/sessions.js';
import { openUrlCompanion } from '../lib/companion-state.js';
import { registerCosArtifact, artifactIdFor } from '../lib/cos-artifacts.js';
import { MessageRenderer } from './MessageRenderer.js';

marked.setOptions({ gfm: true, breaks: false });

const EXT_TO_LANG: Record<string, string> = {
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

const ULID_RE = /\b01[A-Z0-9]{24}\b/g;
// Matches http(s) URLs and bare host:port patterns (e.g. azstaging.myworkbench.ai:6080)
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})(?:\/[^\s<>"')\]]*)?/gi;

// Wrap ULID matches and URL matches in CoS-rendered HTML with clickable anchors.
// Skips text inside <code>, <pre>, and existing <a> tags.
function linkifyHtml(html: string): string {
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

function handleCosProseClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const urlLink = target.closest('a[data-cos-url]') as HTMLElement | null;
  if (urlLink) {
    const url = urlLink.getAttribute('data-cos-url');
    if (url) { e.preventDefault(); e.stopPropagation(); openUrlCompanion(url); }
    return;
  }
  const link = target.closest('a[data-cos-session-id]') as HTMLElement | null;
  if (!link) return;
  const sid = link.getAttribute('data-cos-session-id');
  if (!sid) return;
  e.preventDefault();
  e.stopPropagation();
  openSession(sid);
}

function extOf(path: string): string {
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

function parseAssistantContent(text: string): ContentSegment[] {
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

function ArtifactCard({
  seg,
  onPopout,
}: {
  seg: Extract<ContentSegment, { type: 'artifact' }>;
  onPopout: (artifactId: string) => void;
}) {
  // Register eagerly so the CoS artifact drawer and companion pane can look up
  // labels/content after a page reload (drawer/pane tab IDs are persisted; the
  // artifact contents are re-derived from message text on each render).
  useEffect(() => {
    registerCosArtifact({
      id: artifactIdFor(seg.kind, seg.raw),
      kind: seg.kind,
      label: seg.label,
      meta: seg.meta,
      lang: seg.lang,
      filename: seg.filename,
      raw: seg.raw,
    });
  }, [seg.kind, seg.raw, seg.label, seg.meta, seg.lang, seg.filename]);

  const icon = seg.kind === 'code' ? '❮❯' : seg.kind === 'table' ? '▦' : '☰';

  const popout = () => {
    const id = artifactIdFor(seg.kind, seg.raw);
    registerCosArtifact({
      id,
      kind: seg.kind,
      label: seg.label,
      meta: seg.meta,
      lang: seg.lang,
      filename: seg.filename,
      raw: seg.raw,
    });
    onPopout(id);
  };

  return (
    <div class={`cos-artifact cos-artifact-${seg.kind}`}>
      <button
        type="button"
        class="cos-artifact-header"
        onClick={popout}
        title="Open in companion pane"
        aria-label={`Open ${seg.label} in companion pane`}
      >
        <span class="cos-artifact-icon" aria-hidden="true">{icon}</span>
        <span class="cos-artifact-label">{seg.label}</span>
        <span class="cos-artifact-meta">{seg.meta}</span>
        <span class="cos-artifact-popout-hint" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h6v6" />
            <path d="M10 14L21 3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
          </svg>
        </span>
      </button>
    </div>
  );
}

// Splits `text` on (case-insensitive) occurrences of `highlight` and wraps the
// matches in `<mark class="cos-search-hit">`. Falls back to plain text when
// highlight is empty / not found. Used for inline search-result highlighting.
export function HighlightedText({ text, highlight }: { text: string; highlight?: string | null }) {
  if (!highlight) return <>{text}</>;
  const q = highlight.trim();
  if (!q) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  if (!lowerText.includes(lowerQ)) return <>{text}</>;
  const parts: import('preact').ComponentChildren[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const hit = lowerText.indexOf(lowerQ, i);
    if (hit < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<mark key={key++} class="cos-search-hit">{text.slice(hit, hit + q.length)}</mark>);
    i = hit + q.length;
  }
  return <>{parts}</>;
}

// Walks all text nodes inside a rendered markdown container and wraps
// substring matches in <mark class="cos-search-hit">. Skips nodes already
// inside a mark (idempotent across re-runs). Run from a useEffect after the
// dangerouslySetInnerHTML pass so we operate on the live DOM.
function highlightTextNodesInDom(root: HTMLElement, query: string) {
  if (!query) return;
  const lowerQ = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === 'MARK' && parent.classList.contains('cos-search-hit')) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue || '';
      return text.toLowerCase().includes(lowerQ) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets: Text[] = [];
  let cur = walker.nextNode();
  while (cur) { targets.push(cur as Text); cur = walker.nextNode(); }
  for (const node of targets) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const hit = lower.indexOf(lowerQ, i);
      if (hit < 0) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
      if (hit > i) frag.appendChild(document.createTextNode(text.slice(i, hit)));
      const mark = document.createElement('mark');
      mark.className = 'cos-search-hit';
      mark.textContent = text.slice(hit, hit + query.length);
      frag.appendChild(mark);
      i = hit + query.length;
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

function AssistantContent({ text, onArtifactPopout, searchHighlight }: { text: string; onArtifactPopout: (artifactId: string) => void; searchHighlight?: string | null }) {
  const segments = useMemo(() => parseAssistantContent(text), [text]);
  const proseRef = useRef<HTMLDivElement>(null);
  // Re-apply DOM-level highlight after every render that might change the
  // rendered markdown or the active query. The walker is idempotent thanks to
  // the dangerouslySetInnerHTML reset that runs before this effect.
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const q = (searchHighlight || '').trim();
    if (!q) return;
    highlightTextNodesInDom(root, q);
  }, [text, searchHighlight]);
  return (
    <div class="cos-msg-md" ref={proseRef}>
      {segments.map((seg, i) => {
        if (seg.type === 'artifact') {
          return <ArtifactCard key={i} seg={seg} onPopout={onArtifactPopout} />;
        }
        const html = marked.parse(seg.markdown) as string;
        const safeHtml = typeof html === 'string' ? linkifyHtml(html) : '';
        return <div key={i} class="cos-md-prose" onClick={handleCosProseClick} dangerouslySetInnerHTML={{ __html: safeHtml }} />;
      })}
    </div>
  );
}

function formatRelativeTime(ts: number, now: number): { rel: string; abs: string } {
  const d = new Date(ts);
  const abs = d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  let rel: string;
  if (s < 10) rel = 'just now';
  else if (s < 60) rel = `${s}s ago`;
  else if (s < 3600) rel = `${Math.floor(s / 60)}m ago`;
  else if (s < 86400) rel = `${Math.floor(s / 3600)}h ago`;
  else if (s < 86400 * 7) rel = `${Math.floor(s / 86400)}d ago`;
  else rel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { rel, abs };
}

export function Timestamp({ ts }: { ts: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const age = Date.now() - ts;
    const tickMs = age < 60_000 ? 5_000 : age < 3_600_000 ? 30_000 : 300_000;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [ts]);
  const { rel, abs } = formatRelativeTime(ts, now);
  return <span class="cos-msg-time" title={abs}>{rel}</span>;
}

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfYesterday) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DayDivider({ ts }: { ts: number }) {
  const label = dayLabel(ts);
  return (
    <div class="cos-day-divider" role="separator" aria-label={label}>
      <span class="cos-day-divider-label">{label}</span>
    </div>
  );
}

export function getAgentAvatarSrc(agentId: string | null | undefined): string | null {
  if (agentId === 'default') {
    // import.meta.env is a Vite augmentation not visible to the bare ts
    // compiler; cast through unknown so the avatar path picks up the
    // configured base URL without dragging vite/client types into tsconfig.
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    return `${env?.BASE_URL ?? '/'}chief-of-staff-avatar.svg`;
  }
  return null;
}

export function MessageAvatar({
  role,
  label,
  size,
  imageSrc,
}: {
  role: 'user' | 'assistant' | string;
  label: string;
  size?: 'sm';
  imageSrc?: string | null;
}) {
  const cls = `cos-avatar cos-avatar-${role === 'user' ? 'user' : 'assistant'}${size ? ' cos-avatar-' + size : ''}`;
  if (role === 'user') {
    return (
      <div class={cls} title={label} aria-hidden="true">
        <svg width={size === 'sm' ? 10 : 14} height={size === 'sm' ? 10 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </div>
    );
  }
  if (imageSrc) {
    return (
      <div class={cls} title={label} aria-hidden="true">
        <img class="cos-avatar-img" src={imageSrc} alt="" />
      </div>
    );
  }
  const initial = (label || 'O').trim().charAt(0).toUpperCase() || 'O';
  return (
    <div class={cls} title={label} aria-hidden="true">
      <span class="cos-avatar-initial">{initial}</span>
    </div>
  );
}

function MessageImageThumb({ src, name }: { src: string; name?: string }) {
  const [lightbox, setLightbox] = useState(false);
  const hasSrc = !!src;

  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setLightbox(false);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [lightbox]);

  if (!hasSrc) {
    return (
      <div class="cos-msg-attach-img cos-msg-attach-img-missing" title={name || 'image not loaded'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span>image</span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        class="cos-msg-attach-img"
        onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
        title={name || 'Click to enlarge'}
      >
        <img src={src} alt={name || 'attachment'} />
      </button>
      {lightbox && (
        <div class="sm-lightbox" onClick={() => setLightbox(false)}>
          <div class="sm-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img src={src} alt={name || 'attachment (full)'} />
            <button class="sm-lightbox-close" onClick={() => setLightbox(false)}>&times;</button>
          </div>
        </div>
      )}
    </>
  );
}

function formatElementHeader(ref: CosElementRef): string {
  let out = ref.tagName || 'element';
  if (ref.id) out += `#${ref.id}`;
  const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
  if (cls.length) out += '.' + cls.join('.');
  return out;
}

function MessageElementChip({ info }: { info: CosElementRef }) {
  const [expanded, setExpanded] = useState(false);
  const header = formatElementHeader(info);
  const br = info.boundingRect;
  const dims = br ? `${Math.round(br.width)}×${Math.round(br.height)}` : '';
  const textPreview = (info.textContent || '').trim().slice(0, 80);
  const attrs = info.attributes || {};
  const attrKeys = Object.keys(attrs);
  return (
    <div class={`cos-msg-attach-el${expanded ? ' cos-msg-attach-el-open' : ''}`}>
      <button
        type="button"
        class="cos-msg-attach-el-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={info.selector}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
        </svg>
        <code class="cos-msg-attach-el-name">{header}</code>
        {dims && <span class="cos-msg-attach-el-dims">{dims}</span>}
        {textPreview && !expanded && (
          <span class="cos-msg-attach-el-text">"{textPreview}{(info.textContent || '').length > 80 ? '…' : ''}"</span>
        )}
        <span class="cos-msg-attach-el-toggle" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div class="cos-msg-attach-el-body">
          <div class="cos-msg-attach-el-row">
            <span class="cos-msg-attach-el-label">selector</span>
            <code class="cos-msg-attach-el-value">{info.selector}</code>
          </div>
          {br && (
            <div class="cos-msg-attach-el-row">
              <span class="cos-msg-attach-el-label">rect</span>
              <code class="cos-msg-attach-el-value">
                x:{Math.round(br.x)} y:{Math.round(br.y)} w:{Math.round(br.width)} h:{Math.round(br.height)}
              </code>
            </div>
          )}
          {info.classes && info.classes.length > 0 && (
            <div class="cos-msg-attach-el-row">
              <span class="cos-msg-attach-el-label">classes</span>
              <code class="cos-msg-attach-el-value">{info.classes.join(' ')}</code>
            </div>
          )}
          {info.textContent && (
            <div class="cos-msg-attach-el-row">
              <span class="cos-msg-attach-el-label">text</span>
              <code class="cos-msg-attach-el-value cos-msg-attach-el-value-multiline">{info.textContent}</code>
            </div>
          )}
          {attrKeys.length > 0 && (
            <div class="cos-msg-attach-el-row cos-msg-attach-el-row-stack">
              <span class="cos-msg-attach-el-label">attributes</span>
              <div class="cos-msg-attach-el-attrs">
                {attrKeys.map((k) => (
                  <div key={k} class="cos-msg-attach-el-attr">
                    <code class="cos-msg-attach-el-attr-key">{k}</code>
                    <code class="cos-msg-attach-el-attr-val">{attrs[k]}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  elementRefs,
}: {
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
}) {
  const hasImgs = !!(attachments && attachments.length > 0);
  const hasEls = !!(elementRefs && elementRefs.length > 0);
  if (!hasImgs && !hasEls) return null;
  return (
    <div class="cos-msg-attachments">
      {hasImgs && (
        <div class="cos-msg-attach-imgs">
          {attachments!.map((att, i) => (
            <MessageImageThumb key={i} src={att.dataUrl} name={att.name} />
          ))}
        </div>
      )}
      {hasEls && (
        <div class="cos-msg-attach-els">
          {elementRefs!.map((info, i) => (
            <MessageElementChip key={i} info={info} />
          ))}
        </div>
      )}
    </div>
  );
}

function ElapsedSince({ ts }: { ts: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return <>{sec}s</>;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return <>{min}m {remSec.toString().padStart(2, '0')}s</>;
}

export function MessageBubble({
  msg,
  msgIdx,
  highlighted,
  showTools,
  onArtifactPopout,
  agentId,
  agentName,
  verbosity: _verbosity,
  searchHighlight,
}: {
  msg: ChiefOfStaffMsg;
  msgIdx: number;
  highlighted: boolean;
  showTools: boolean;
  onArtifactPopout: (artifactId: string) => void;
  agentId: string;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
  searchHighlight?: string | null;
}) {
  const hasTools = !!(msg.toolCalls && msg.toolCalls.length > 0);
  // Always show every text part the model emitted (markers stripped) so
  // nothing the JSONL captured is silently dropped from the Ops view. The
  // verbosity setting is passed to the model server-side as a tone hint
  // (terse = brief replies, verbose = with context) but is no longer a
  // client-side filter — that filter was hiding intro / explanatory text
  // the model emitted outside <cos-reply> tags.
  const assistantDisplay = msg.role === 'assistant' ? stripCosReplyMarkers(msg.text) : '';
  const showAssistantText = msg.role === 'assistant' && assistantDisplay;
  const showUserText = msg.role === 'user' && msg.text;
  const showEarlyAck =
    msg.role === 'assistant' && msg.streaming && msg.sending && !showAssistantText && !hasTools;
  const showElapsed = msg.role === 'assistant' && msg.streaming && !msg.sending;
  const authorLabel = msg.role === 'user' ? 'You' : (agentName || 'Ops');
  const avatarSrc = msg.role === 'assistant' ? getAgentAvatarSrc(agentId) : null;
  const showAttachments = !!(msg.attachments?.length || msg.elementRefs?.length);

  // Skip rendering empty assistant messages (no text, no tools, not streaming, no error)
  if (
    msg.role === 'assistant' &&
    !assistantDisplay &&
    !hasTools &&
    !msg.streaming &&
    !msg.error &&
    !showAttachments
  ) return null;

  return (
    <div
      class={`cos-msg cos-row cos-row-${msg.role}${highlighted ? ' cos-msg-highlight' : ''}`}
      data-cos-msg-idx={msgIdx}
    >
      <div class="cos-row-avatar">
        <MessageAvatar role={msg.role} label={authorLabel} imageSrc={avatarSrc} />
      </div>
      <div class="cos-row-main">
        <div class="cos-row-header">
          <span class="cos-row-author">{authorLabel}</span>
          {msg.timestamp && !msg.streaming && <Timestamp ts={msg.timestamp} />}
        </div>
        {hasTools && showTools && (
          <div class="cos-tools">
            {msg.toolCalls!.map((c, i) => (
              <MessageRenderer
                key={i}
                message={{
                  id: `cos-${msg.timestamp}-tool-${i}`,
                  role: 'tool_use',
                  timestamp: msg.timestamp,
                  toolName: c.name,
                  // Stash result/error on a private key so the chat-mode
                  // chip can show them when expanded. tool_result is
                  // suppressed in chat mode, so we have to thread the data
                  // in through the tool_use's input bag.
                  toolInput: {
                    ...c.input,
                    __chatExtras: { result: c.result, error: c.error },
                  },
                  toolUseId: c.id,
                  content: '',
                }}
                chat={{}}
              />
            ))}
          </div>
        )}
        {hasTools && !showTools && !msg.streaming && (
          <div class="cos-tools-hidden-hint" aria-hidden="true">
            {msg.toolCalls!.length} tool call{msg.toolCalls!.length === 1 ? '' : 's'} hidden
          </div>
        )}
        {showAssistantText && (
          <div class="cos-row-content cos-msg-text cos-msg-text-md">
            <AssistantContent text={assistantDisplay} onArtifactPopout={onArtifactPopout} searchHighlight={searchHighlight} />
          </div>
        )}
        {showUserText && (
          <div class="cos-row-content cos-msg-text"><HighlightedText text={msg.text} highlight={searchHighlight} /></div>
        )}
        {showAttachments && (
          <MessageAttachments attachments={msg.attachments} elementRefs={msg.elementRefs} />
        )}
        {msg.streaming && (() => {
          // Surface a shortcut to the backing session's jsonl log so the
          // operator can peek at the in-flight turn directly when the reply
          // takes too long or extraction drops output. The session is
          // provisioned at thread creation; even if the UI hasn't received
          // any assistant bytes yet, the jsonl file is already live.
          const linkSid = getSessionIdForThread(msg.threadId);
          const openJsonl = () => {
            if (!linkSid) return;
            openSession(linkSid);
            toggleCompanion(linkSid, 'jsonl');
          };
          return (
            <div class="cos-thinking-row">
              <div class="cos-thinking">
                <span /><span /><span />
              </div>
              {showEarlyAck && (
                linkSid ? (
                  <button
                    type="button"
                    class="cos-thinking-label cos-thinking-label-link"
                    onClick={(e) => { e.stopPropagation(); openJsonl(); }}
                    title="Open session jsonl log"
                  >
                    Working on it…
                  </button>
                ) : (
                  <span class="cos-thinking-label">Working on it…</span>
                )
              )}
              {showElapsed && (
                linkSid ? (
                  <button
                    type="button"
                    class="cos-thinking-label cos-thinking-label-elapsed cos-thinking-label-link"
                    onClick={(e) => { e.stopPropagation(); openJsonl(); }}
                    title="Open session jsonl log"
                  >
                    <ElapsedSince ts={msg.timestamp} />
                  </button>
                ) : (
                  <span class="cos-thinking-label cos-thinking-label-elapsed">
                    <ElapsedSince ts={msg.timestamp} />
                  </span>
                )
              )}
            </div>
          );
        })()}
        {msg.error && (() => {
          const linkSid = getSessionIdForThread(msg.threadId);
          return (
            <div class="cos-msg-error" role="alert">
              <div class="cos-msg-error-text">
                <strong>Send failed:</strong> {msg.error}
              </div>
              <div class="cos-msg-error-actions">
                {msg.retryPayload && (
                  <button
                    type="button"
                    class="cos-msg-error-btn"
                    onClick={(e) => { e.stopPropagation(); retryFailedAssistantMessage(msg.timestamp); }}
                  >
                    Retry
                  </button>
                )}
                {linkSid && (
                  <button
                    type="button"
                    class="cos-msg-error-btn cos-msg-error-btn-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSession(linkSid);
                      toggleCompanion(linkSid, 'jsonl');
                    }}
                    title="Open session jsonl log"
                  >
                    Open JSONL
                  </button>
                )}
                <button
                  type="button"
                  class="cos-msg-error-btn cos-msg-error-btn-secondary"
                  onClick={(e) => { e.stopPropagation(); dismissFailedAssistantMessage(msg.timestamp); }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
