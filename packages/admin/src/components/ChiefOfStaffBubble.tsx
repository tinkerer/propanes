import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { selectedAppId } from '../lib/state.js';
import {
  chiefOfStaffOpen,
  chiefOfStaffAgents,
  chiefOfStaffActiveId,
  chiefOfStaffError,
  toggleChiefOfStaff,
  setChiefOfStaffOpen,
  sendChiefOfStaffMessage,
  getActiveAgent,
  addAgent,
  removeActiveAgent,
  renameActiveAgent,
  updateActiveAgentSystemPrompt,
  updateActiveAgentVerbosity,
  updateActiveAgentStyle,
  clearActiveAgentHistory,
  interruptActiveAgent,
  interruptThread,
  getSessionIdForThread,
  ensureCosPanel,
  extractCosReply,
  stripCosReplyMarkers,
  retryFailedAssistantMessage,
  dismissFailedAssistantMessage,
  DEFAULT_VERBOSITY,
  DEFAULT_STYLE,
  type ChiefOfStaffToolCall,
  type ChiefOfStaffMsg,
  type ChiefOfStaffVerbosity,
  type ChiefOfStaffStyle,
  type CosImageAttachment,
  type CosElementRef,
  cosLearnings,
  cosLearningsLoading,
  loadCosLearnings,
  deleteCosLearning,
  type CosLearning,
  type CosLearningRelType,
  type CosLearningGraph,
  type CosLearningDetail,
  type CosLearningLinkPeer,
  type CosLearningSuggestion,
  cosLearningGraph,
  cosLearningGraphLoading,
  loadCosLearningGraph,
  fetchCosLearningDetail,
  fetchCosLearningSuggestions,
  createCosLearningLink,
  deleteCosLearningLink,
  updateCosLearning,
  wiggumAnnouncement,
  extractDispatchInfo,
  fetchFeedbackTitle,
  getCachedFeedbackTitle,
  feedbackTitlesVersion,
  type DispatchInfo,
  openCosInPane,
  isCosInPane,
  closeCosPane,
  COS_PANE_TAB_ID,
} from '../lib/chief-of-staff.js';
import { layoutTree as layoutTreeSignal, findLeafWithTab, setFocusedLeaf } from '../lib/pane-tree.js';
import { startPicker, type SelectedElementInfo } from '@propanes/widget/element-picker';
import { captureScreenshot } from '@propanes/widget/screenshot';
import { ImageEditor } from '@propanes/widget/image-editor';
import {
  popoutPanels,
  persistPopoutState,
  bringToFront,
  getDockedPanelTop,
  getPanelZIndex,
  panelZOrders,
  sidebarWidth,
  sidebarCollapsed,
  dockedOrientation,
  COS_PANEL_ID,
  snapGuides,
  openSession,
  openFeedbackItem,
  updatePanel,
  toggleCompanion,
} from '../lib/sessions.js';
import { handleDragMove, handleResizeMove } from '../lib/popout-physics.js';
import { detectExternalZone, openCosExternally, applyExternalGhostHint } from '../lib/tab-drag.js';
import { isMobile } from '../lib/viewport.js';
import {
  registerCosArtifact,
  artifactIdFor,
  cosArtifacts,
} from '../lib/cos-artifacts.js';
import { openArtifactCompanion, openUrlCompanion } from '../lib/companion-state.js';
import { ArtifactCompanionView } from './ArtifactCompanionView.js';
import { PopupMenu } from './PopupMenu.js';
import { WindowMenu } from './PopoutPanelContent.js';
import {
  cosPopoutTree,
  cosOpenArtifactTab,
  cosToggleLearningsTab,
  cosIsLearningsOpen,
} from '../lib/cos-popout-tree.js';
import { CosPopoutTreeView } from './CosPopoutTreeView.js';

marked.setOptions({ gfm: true, breaks: false });

function hasAnyArtifactLeaf(node: import('../lib/pane-tree.js').PaneNode): boolean {
  if (node.type === 'leaf') return node.tabs.some((t) => t.startsWith('artifact:'));
  return hasAnyArtifactLeaf(node.children[0]) || hasAnyArtifactLeaf(node.children[1]);
}

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
    // Apply ULID linkification first, then URL linkification on non-ULID spans
    ULID_RE.lastIndex = 0;
    URL_RE.lastIndex = 0;
    let out = '';
    let last = 0;
    const text = tokens[i];
    // Collect all matches (ULIDs and URLs) sorted by index
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
      // Skip if overlaps with an already-found ULID match
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

type ArtifactKind = 'code' | 'list' | 'table';

type ContentSegment =
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

function AssistantContent({ text, onArtifactPopout }: { text: string; onArtifactPopout: (artifactId: string) => void }) {
  const segments = useMemo(() => parseAssistantContent(text), [text]);
  return (
    <div class="cos-msg-md">
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

function bashDisplayName(cmd: string): string {
  const postM = cmd.match(/curl[^|]*-X\s+POST[^|]*'[^']*?(\/api\/[^'?\s]+)/);
  if (postM) {
    const path = postM[1].replace('/api/v1/admin/', '').replace('/api/v1/', '');
    return `POST /${path}`;
  }
  const getM = cmd.match(/curl[^|]*'[^']*?(\/api\/[^'?\s]+)/);
  if (getM) {
    const path = getM[1].replace('/api/v1/admin/', '').replace('/api/v1/', '');
    return path;
  }
  return 'bash';
}

function toolSummary(call: ChiefOfStaffToolCall): string {
  if (call.error) return call.error.split('\n')[0].slice(0, 60);
  if (call.result === undefined || call.result === null) return '';
  const res = call.result;
  if (typeof res === 'string') {
    const trimmed = res.trim();
    if (!trimmed) return '✓';
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.sessionId) return `launched ${String(parsed.sessionId).slice(0, 16)}`;
      if (parsed?.id && parsed?.status) return `${parsed.status}`;
      if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
      if (typeof parsed?.count === 'number') return `${parsed.count} items`;
      if (parsed?.granted !== undefined) return parsed.granted ? 'lock granted' : 'lock denied';
      if (parsed?.released !== undefined) return parsed.released ? 'lock released' : parsed.reason || 'not released';
      if (parsed?.status) return String(parsed.status);
      return '✓';
    } catch { /* not JSON */ }
    if (trimmed.length <= 40) return trimmed;
    return '✓';
  }
  if (typeof res === 'object' && res && 'count' in (res as any)) {
    return `${(res as any).count} items`;
  }
  return '✓';
}

function collectDispatches(replies: { idx: number; msg: ChiefOfStaffMsg }[]): DispatchInfo[] {
  const out: DispatchInfo[] = [];
  for (const r of replies) {
    if (!r.msg.toolCalls) continue;
    for (const call of r.msg.toolCalls) {
      const info = extractDispatchInfo(call);
      if (info) out.push(info);
    }
  }
  return out;
}

function ToolCallChip({ call }: { call: ChiefOfStaffToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const displayName = call.name === 'Bash' && typeof call.input?.command === 'string'
    ? bashDisplayName(call.input.command as string)
    : call.name;
  const summary = toolSummary(call);
  const isDispatch = displayName.includes('dispatch') || summary.startsWith('launched');
  return (
    <div class={`cos-tool-chip${call.error ? ' cos-tool-error' : ''}${isDispatch ? ' cos-tool-dispatch' : ''}`}>
      <button type="button" class="cos-tool-header" onClick={() => setExpanded(!expanded)}>
        <span class="cos-tool-name">{displayName}</span>
        <span class="cos-tool-summary">{summary}</span>
        <span class="cos-tool-toggle">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div class="cos-tool-body">
          {Object.keys(call.input || {}).length > 0 && (
            <div class="cos-tool-section">
              <div class="cos-tool-label">input</div>
              <pre>{JSON.stringify(call.input, null, 2)}</pre>
            </div>
          )}
          {call.error && (
            <div class="cos-tool-section">
              <div class="cos-tool-label">error</div>
              <pre>{call.error}</pre>
            </div>
          )}
          {!call.error && call.result !== undefined && (
            <div class="cos-tool-section">
              <div class="cos-tool-label">result</div>
              <pre>{typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
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

function Timestamp({ ts }: { ts: number }) {
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

function dayKeyOf(ts: number): string {
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

function DayDivider({ ts }: { ts: number }) {
  const label = dayLabel(ts);
  return (
    <div class="cos-day-divider" role="separator" aria-label={label}>
      <span class="cos-day-divider-label">{label}</span>
    </div>
  );
}

function MessageAvatar({ role, label, size }: { role: 'user' | 'assistant' | string; label: string; size?: 'sm' }) {
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

function MessageAttachments({
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

function MessageBubble({
  msg,
  msgIdx,
  highlighted,
  showTools,
  onArtifactPopout,
  agentName,
  verbosity,
}: {
  msg: ChiefOfStaffMsg;
  msgIdx: number;
  highlighted: boolean;
  showTools: boolean;
  onArtifactPopout: (artifactId: string) => void;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
}) {
  const hasTools = !!(msg.toolCalls && msg.toolCalls.length > 0);
  // Verbose mode: bypass the <cos-reply> filter and show every text part the
  // model emitted, including planning/scratch-work outside the tags. Terse
  // and normal keep the default tag-scoped display.
  const assistantDisplay = msg.role === 'assistant'
    ? (verbosity === 'verbose' ? stripCosReplyMarkers(msg.text) : extractCosReply(msg.text).displayText)
    : '';
  const showAssistantText = msg.role === 'assistant' && assistantDisplay;
  const showUserText = msg.role === 'user' && msg.text;
  const showEarlyAck =
    msg.role === 'assistant' && msg.streaming && msg.sending && !showAssistantText && !hasTools;
  const showElapsed = msg.role === 'assistant' && msg.streaming && !msg.sending;
  const authorLabel = msg.role === 'user' ? 'You' : (agentName || 'Ops');
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
        <MessageAvatar role={msg.role} label={authorLabel} />
      </div>
      <div class="cos-row-main">
        <div class="cos-row-header">
          <span class="cos-row-author">{authorLabel}</span>
          {msg.timestamp && !msg.streaming && <Timestamp ts={msg.timestamp} />}
        </div>
        {hasTools && showTools && (
          <div class="cos-tools">
            {msg.toolCalls!.map((c, i) => <ToolCallChip key={i} call={c} />)}
          </div>
        )}
        {hasTools && !showTools && !msg.streaming && (
          <div class="cos-tools-hidden-hint" aria-hidden="true">
            {msg.toolCalls!.length} tool call{msg.toolCalls!.length === 1 ? '' : 's'} hidden
          </div>
        )}
        {showAssistantText && (
          <div class="cos-row-content cos-msg-text cos-msg-text-md">
            <AssistantContent text={assistantDisplay} onArtifactPopout={onArtifactPopout} />
          </div>
        )}
        {showUserText && (
          <div class="cos-row-content cos-msg-text">{msg.text}</div>
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

type Thread = {
  userIdx: number | null;
  userMsg: ChiefOfStaffMsg | null;
  replies: { idx: number; msg: ChiefOfStaffMsg }[];
};

function groupIntoThreads(messages: ChiefOfStaffMsg[]): Thread[] {
  const threads: Thread[] = [];
  const byThreadId = new Map<string, Thread>();
  // Route a "Reply in thread" user message back to its anchor thread instead
  // of starting a new top-level thread. Keyed by the anchor user-msg timestamp.
  const byAnchorTs = new Map<number, Thread>();
  let legacyCurrent: Thread | null = null;
  const pushIfNew = (t: Thread) => { if (!threads.includes(t)) threads.push(t); };

  messages.forEach((m, i) => {
    const tid = m.threadId;
    if (tid) {
      // Primary grouping: backend cosThread id. Handles interleaved parallel
      // turns cleanly — an assistant reply from thread A that arrives after a
      // user message in thread B lands back in thread A.
      let t = byThreadId.get(tid);
      if (!t) {
        t = m.role === 'user'
          ? { userIdx: i, userMsg: m, replies: [] }
          : { userIdx: null, userMsg: null, replies: [{ idx: i, msg: m }] };
        byThreadId.set(tid, t);
        pushIfNew(t);
        if (m.role === 'user' && m.timestamp) byAnchorTs.set(m.timestamp, t);
      } else if (m.role === 'user') {
        if (!t.userMsg) {
          t.userIdx = i;
          t.userMsg = m;
          if (m.timestamp) byAnchorTs.set(m.timestamp, t);
        } else {
          t.replies.push({ idx: i, msg: m });
        }
      } else {
        t.replies.push({ idx: i, msg: m });
      }
      legacyCurrent = t;
      return;
    }

    // Legacy fallback for messages without a threadId (pre-fix rows).
    if (m.role === 'user') {
      if (typeof m.replyToTs === 'number') {
        const target = byAnchorTs.get(m.replyToTs);
        if (target) {
          target.replies.push({ idx: i, msg: m });
          legacyCurrent = target;
          return;
        }
      }
      const t: Thread = { userIdx: i, userMsg: m, replies: [] };
      threads.push(t);
      if (m.timestamp) byAnchorTs.set(m.timestamp, t);
      legacyCurrent = t;
    } else {
      if (!legacyCurrent) {
        legacyCurrent = { userIdx: null, userMsg: null, replies: [] };
      }
      legacyCurrent.replies.push({ idx: i, msg: m });
      pushIfNew(legacyCurrent);
    }
  });

  return threads;
}

type LearningsView = 'list' | 'graph';

const LEARNING_TYPE_LABELS: Record<CosLearning['type'], string> = {
  pitfall: 'Pitfalls',
  suggestion: 'Suggestions',
  tool_gap: 'Tool gaps',
};

const LEARNING_TYPE_ORDER: CosLearning['type'][] = ['pitfall', 'suggestion', 'tool_gap'];

const LEARNING_TYPE_COLOR: Record<CosLearning['type'], string> = {
  pitfall: '#e5484d',
  suggestion: '#3e63dd',
  tool_gap: '#d97706',
};

const REL_TYPE_LABELS: Record<CosLearningRelType, string> = {
  related: 'related',
  caused_by: 'caused by',
  resolved_by: 'resolved by',
  duplicate_of: 'duplicate of',
};

const REL_TYPE_COLOR: Record<CosLearningRelType, string> = {
  related: '#9ca3af',
  caused_by: '#e5484d',
  resolved_by: '#22c55e',
  duplicate_of: '#a855f7',
};

function LearningsPanel({ onClose }: { onClose: () => void }) {
  const items = cosLearnings.value;
  const loading = cosLearningsLoading.value;
  const graph = cosLearningGraph.value;
  const graphLoading = cosLearningGraphLoading.value;
  const announcement = wiggumAnnouncement.value;

  const [view, setView] = useState<LearningsView>('list');
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    void loadCosLearnings();
  }, []);

  // Lazy-load graph the first time the user flips to graph view, and again
  // whenever the underlying list changes (so a new learning shows up).
  useEffect(() => {
    if (view === 'graph') void loadCosLearningGraph();
  }, [view, items.length]);

  const grouped = useMemo(() => {
    const out: Record<CosLearning['type'], CosLearning[]> = {
      pitfall: [],
      suggestion: [],
      tool_gap: [],
    };
    for (const l of items) {
      if (out[l.type]) out[l.type].push(l);
    }
    return out;
  }, [items]);

  const refreshAll = useCallback(() => {
    void loadCosLearnings();
    if (view === 'graph') void loadCosLearningGraph();
  }, [view]);

  if (detailId) {
    return (
      <LearningDetailView
        id={detailId}
        allLearnings={items}
        onBack={() => setDetailId(null)}
        onClose={onClose}
        onOpenPeer={(peerId) => setDetailId(peerId)}
        onChanged={refreshAll}
      />
    );
  }

  return (
    <div class="cos-learnings-panel">
      <div class="cos-learnings-header">
        <span class="cos-learnings-title">Wiggum learnings</span>
        <div class="cos-view-segmented" role="radiogroup" aria-label="Learnings view">
          {(['list', 'graph'] as LearningsView[]).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              class={`cos-view-seg${view === v ? ' cos-view-seg-active' : ''}`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <button class="cos-link-btn" onClick={refreshAll} title="Reload">
          {loading || graphLoading ? 'loading…' : 'refresh'}
        </button>
        <button class="cos-link-btn" onClick={onClose} aria-label="Close">close</button>
      </div>
      {announcement && (
        <div class="cos-learnings-announce" title={`Posted ${new Date(announcement.at).toLocaleString()}`}>
          <span class="cos-learnings-announce-label">Latest reflection:</span> {announcement.summary}
        </div>
      )}
      {items.length === 0 && !loading && (
        <div class="cos-learnings-empty">No learnings yet. Wiggum reflects after each CoS session closes.</div>
      )}
      {view === 'list'
        ? <LearningsListView grouped={grouped} onOpen={setDetailId} />
        : <LearningsGraphView graph={graph} loading={graphLoading} onOpen={setDetailId} />}
    </div>
  );
}

function LearningsListView({
  grouped,
  onOpen,
}: {
  grouped: Record<CosLearning['type'], CosLearning[]>;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {LEARNING_TYPE_ORDER.map((type) => {
        const group = grouped[type];
        if (!group || group.length === 0) return null;
        return (
          <div key={type} class="cos-learnings-group">
            <div class="cos-learnings-group-title">
              {LEARNING_TYPE_LABELS[type]} <span class="cos-muted">({group.length})</span>
            </div>
            {group.map((l) => (
              <div key={l.id} class={`cos-learning cos-learning-sev-${l.severity}`}>
                <div class="cos-learning-row">
                  <span
                    class={`cos-learning-dot cos-learning-dot-${l.severity}`}
                    title={`severity: ${l.severity}`}
                    aria-label={`severity ${l.severity}`}
                  />
                  <button
                    type="button"
                    class="cos-learning-title cos-learning-title-btn"
                    onClick={() => onOpen(l.id)}
                    title="Open detail"
                  >
                    {l.title}
                  </button>
                  <button
                    class="cos-link-btn cos-danger-text"
                    onClick={(e) => { e.stopPropagation(); void deleteCosLearning(l.id); }}
                    title="Dismiss"
                    aria-label="Dismiss learning"
                  >
                    ×
                  </button>
                </div>
                {(l.tags?.length ?? 0) > 0 && (
                  <div class="cos-learning-tags">
                    {l.tags!.map((t) => <span key={t} class="cos-learning-tag">#{t}</span>)}
                  </div>
                )}
                {l.body && <div class="cos-learning-body">{l.body}</div>}
                {l.sessionJsonl && (
                  <div class="cos-learning-source" title={l.sessionJsonl}>
                    {l.sessionJsonl.split('/').pop()}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

// Tiny force-directed layout. Runs once per (nodes,edges) signature, freezes
// after a fixed number of ticks so the SVG stays static. Not a real physics
// sim — just enough to keep nodes from overlapping and pull related nodes
// closer. Bounded at 80 nodes; beyond that the UI tells the user to filter.
function computeGraphLayout(
  nodes: CosLearning[],
  edges: CosLearningGraph['edges'],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.35;
  // Seed deterministically so the layout doesn't shuffle on every render.
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    positions.set(n.id, {
      x: cx + r * Math.cos(angle) + (rand() - 0.5) * 10,
      y: cy + r * Math.sin(angle) + (rand() - 0.5) * 10,
      vx: 0,
      vy: 0,
    });
  });
  const ticks = nodes.length <= 30 ? 250 : 150;
  const targetEdgeLen = Math.max(60, Math.min(120, 300 / Math.sqrt(Math.max(nodes.length, 1))));
  for (let t = 0; t < ticks; t++) {
    // Repulsion (Coulomb-ish)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) { dx = rand(); dy = rand(); dist = 1; }
        const force = 1200 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Spring on edges
    for (const e of edges) {
      const a = positions.get(e.fromId);
      const b = positions.get(e.toId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - targetEdgeLen) * 0.08;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Centering
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      p.vx += (cx - p.x) * 0.01;
      p.vy += (cy - p.y) * 0.01;
    }
    // Integrate with damping; clamp to viewport
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      p.vx *= 0.82;
      p.vy *= 0.82;
      p.x += p.vx;
      p.y += p.vy;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of positions) out.set(id, { x: p.x, y: p.y });
  return out;
}

function LearningsGraphView({
  graph,
  loading,
  onOpen,
}: {
  graph: CosLearningGraph | null;
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const width = 560;
  const height = 420;
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Memoize layout against node/edge identity so re-renders don't re-simulate.
  const layoutKey = useMemo(() => {
    if (!graph) return '';
    return [
      graph.nodes.length,
      graph.edges.length,
      graph.nodes.map((n) => n.id).join(','),
      graph.edges.map((e) => e.id).join(','),
    ].join('|');
  }, [graph]);
  const positions = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return new Map<string, { x: number; y: number }>();
    return computeGraphLayout(graph.nodes, graph.edges, width, height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  if (loading && !graph) {
    return <div class="cos-learnings-empty">Loading graph…</div>;
  }
  if (!graph || graph.nodes.length === 0) {
    return <div class="cos-learnings-empty">No learnings to graph yet.</div>;
  }

  return (
    <div class="cos-learnings-graph-wrap">
      <div class="cos-learnings-graph-legend">
        {LEARNING_TYPE_ORDER.map((t) => (
          <span key={t} class="cos-learnings-graph-legend-item">
            <span class="cos-learnings-graph-legend-dot" style={{ background: LEARNING_TYPE_COLOR[t] }} />
            {LEARNING_TYPE_LABELS[t]}
          </span>
        ))}
        <span class="cos-muted">— click a node to open</span>
      </div>
      <svg
        class="cos-learnings-graph-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Learnings knowledge graph"
      >
        <defs>
          <marker id="cos-graph-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#9ca3af" />
          </marker>
        </defs>
        {graph.edges.map((e) => {
          const a = positions.get(e.fromId);
          const b = positions.get(e.toId);
          if (!a || !b) return null;
          const isHover = hoverId !== null && (e.fromId === hoverId || e.toId === hoverId);
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={REL_TYPE_COLOR[e.relType]}
              stroke-width={isHover ? 2 : 1}
              stroke-opacity={hoverId && !isHover ? 0.18 : 0.7}
              stroke-dasharray={e.relType === 'duplicate_of' ? '4 3' : undefined}
              marker-end="url(#cos-graph-arrow)"
            >
              <title>{`${REL_TYPE_LABELS[e.relType]}${e.source === 'auto' ? ' (auto)' : ''}`}</title>
            </line>
          );
        })}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const isHover = hoverId === n.id;
          const radius = n.severity === 'high' ? 9 : n.severity === 'medium' ? 7 : 5;
          return (
            <g
              key={n.id}
              class="cos-learnings-graph-node"
              transform={`translate(${p.x}, ${p.y})`}
              onMouseEnter={() => setHoverId(n.id)}
              onMouseLeave={() => setHoverId((cur) => (cur === n.id ? null : cur))}
              onClick={() => onOpen(n.id)}
            >
              <circle
                r={radius}
                fill={LEARNING_TYPE_COLOR[n.type]}
                stroke={isHover ? '#fff' : 'rgba(0,0,0,0.4)'}
                stroke-width={isHover ? 2 : 1}
              >
                <title>{`${n.title} — ${n.type} / ${n.severity}`}</title>
              </circle>
              {isHover && (
                <text
                  x={radius + 4}
                  y={4}
                  fill="var(--pw-text-primary)"
                  font-size="11"
                  style={{ pointerEvents: 'none' }}
                >
                  {n.title.length > 40 ? n.title.slice(0, 38) + '…' : n.title}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LearningDetailView({
  id,
  allLearnings,
  onBack,
  onClose,
  onOpenPeer,
  onChanged,
}: {
  id: string;
  allLearnings: CosLearning[];
  onBack: () => void;
  onClose: () => void;
  onOpenPeer: (peerId: string) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CosLearningDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<CosLearningSuggestion[]>([]);
  const [tagsEdit, setTagsEdit] = useState<string | null>(null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [linkPickerFor, setLinkPickerFor] = useState<CosLearningRelType | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [d, s] = await Promise.all([
        fetchCosLearningDetail(id),
        fetchCosLearningSuggestions(id),
      ]);
      setDetail(d);
      setSuggestions(s);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    setTagsEdit(null);
    setBodyEdit(null);
    setTitleEdit(null);
    setLinkPickerFor(null);
  }, [id, refresh]);

  const handleSaveTags = async () => {
    if (tagsEdit === null) return;
    const tags = tagsEdit.split(',').map((t) => t.trim()).filter(Boolean);
    await updateCosLearning(id, { tags });
    setTagsEdit(null);
    await refresh();
    onChanged();
  };

  const handleSaveBody = async () => {
    if (bodyEdit === null) return;
    await updateCosLearning(id, { body: bodyEdit });
    setBodyEdit(null);
    await refresh();
    onChanged();
  };

  const handleSaveTitle = async () => {
    if (titleEdit === null) return;
    const t = titleEdit.trim();
    if (!t) { setTitleEdit(null); return; }
    await updateCosLearning(id, { title: t });
    setTitleEdit(null);
    await refresh();
    onChanged();
  };

  const handleSeverity = async (sev: CosLearning['severity']) => {
    await updateCosLearning(id, { severity: sev });
    await refresh();
    onChanged();
  };

  const handleAddLink = async (peerId: string, relType: CosLearningRelType) => {
    await createCosLearningLink(id, peerId, relType);
    setLinkPickerFor(null);
    await refresh();
    onChanged();
  };

  const handleDeleteLink = async (linkId: string) => {
    await deleteCosLearningLink(linkId);
    await refresh();
    onChanged();
  };

  const handleDeleteLearning = async () => {
    await deleteCosLearning(id);
    onChanged();
    onBack();
  };

  if (!detail) {
    return (
      <div class="cos-learnings-panel">
        <div class="cos-learnings-header">
          <button class="cos-link-btn" onClick={onBack}>← back</button>
          <span class="cos-learnings-title">{loading ? 'Loading…' : 'Not found'}</span>
          <button class="cos-link-btn" onClick={onClose} aria-label="Close">close</button>
        </div>
      </div>
    );
  }

  const l = detail.learning;
  const existingPeerIds = new Set<string>([
    ...detail.outgoing.map((x) => x.peer?.id).filter(Boolean) as string[],
    ...detail.backlinks.map((x) => x.peer?.id).filter(Boolean) as string[],
    id,
  ]);

  return (
    <div class="cos-learnings-panel cos-learning-detail">
      <div class="cos-learnings-header">
        <button class="cos-link-btn" onClick={onBack}>← back</button>
        <span class="cos-learnings-title cos-learning-detail-title-host">
          {titleEdit === null ? (
            <button
              type="button"
              class="cos-learning-title-btn"
              onClick={() => setTitleEdit(l.title)}
              title="Edit title"
            >
              {l.title}
            </button>
          ) : (
            <span class="cos-inline-edit">
              <input
                class="cos-inline-input"
                value={titleEdit}
                onInput={(e) => setTitleEdit((e.target as HTMLInputElement).value)}
                autoFocus
              />
              <button class="cos-link-btn" onClick={() => void handleSaveTitle()}>save</button>
              <button class="cos-link-btn" onClick={() => setTitleEdit(null)}>cancel</button>
            </span>
          )}
        </span>
        <button class="cos-link-btn" onClick={() => void refresh()}>{loading ? 'loading…' : 'refresh'}</button>
        <button class="cos-link-btn" onClick={onClose} aria-label="Close">close</button>
      </div>

      <div class="cos-learning-detail-meta">
        <span class="cos-learning-badge" style={{ background: LEARNING_TYPE_COLOR[l.type] }}>{l.type}</span>
        <div class="cos-view-segmented" role="radiogroup" aria-label="Severity">
          {(['low', 'medium', 'high'] as CosLearning['severity'][]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={l.severity === s}
              class={`cos-view-seg${l.severity === s ? ' cos-view-seg-active' : ''}`}
              onClick={() => void handleSeverity(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <span class="cos-muted" title={new Date(l.createdAt).toLocaleString()}>
          {new Date(l.createdAt).toLocaleDateString()}
        </span>
        <button
          class="cos-link-btn cos-danger-text"
          onClick={() => void handleDeleteLearning()}
          title="Delete this learning"
        >
          delete
        </button>
      </div>

      {l.sessionJsonl && (
        <div class="cos-learning-source" title={l.sessionJsonl}>
          source: {l.sessionJsonl.split('/').pop()}
        </div>
      )}

      <div class="cos-learning-detail-section">
        <div class="cos-learning-detail-section-head">
          <span class="cos-learning-detail-section-title">Tags</span>
          {tagsEdit === null
            ? <button class="cos-link-btn" onClick={() => setTagsEdit(l.tags.join(', '))}>edit</button>
            : (
              <span class="cos-inline-actions">
                <button class="cos-link-btn" onClick={() => void handleSaveTags()}>save</button>
                <button class="cos-link-btn" onClick={() => setTagsEdit(null)}>cancel</button>
              </span>
            )}
        </div>
        {tagsEdit === null ? (
          <div class="cos-learning-tags">
            {(l.tags?.length ?? 0) === 0
              ? <span class="cos-muted">no tags</span>
              : l.tags!.map((t) => <span key={t} class="cos-learning-tag">#{t}</span>)}
          </div>
        ) : (
          <input
            class="cos-inline-input"
            placeholder="comma, separated, tags"
            value={tagsEdit}
            onInput={(e) => setTagsEdit((e.target as HTMLInputElement).value)}
            autoFocus
          />
        )}
      </div>

      <div class="cos-learning-detail-section">
        <div class="cos-learning-detail-section-head">
          <span class="cos-learning-detail-section-title">Body</span>
          {bodyEdit === null
            ? <button class="cos-link-btn" onClick={() => setBodyEdit(l.body)}>edit</button>
            : (
              <span class="cos-inline-actions">
                <button class="cos-link-btn" onClick={() => void handleSaveBody()}>save</button>
                <button class="cos-link-btn" onClick={() => setBodyEdit(null)}>cancel</button>
              </span>
            )}
        </div>
        {bodyEdit === null ? (
          <div class="cos-learning-body cos-learning-detail-body">
            {l.body || <span class="cos-muted">no body</span>}
          </div>
        ) : (
          <textarea
            class="cos-prompt-textarea"
            rows={6}
            value={bodyEdit}
            onInput={(e) => setBodyEdit((e.target as HTMLTextAreaElement).value)}
            autoFocus
          />
        )}
      </div>

      <LearningLinksSection
        title="Outgoing links"
        links={detail.outgoing}
        emptyText="no outgoing links"
        onOpen={onOpenPeer}
        onDelete={(linkId) => void handleDeleteLink(linkId)}
        onAdd={(rel) => setLinkPickerFor(rel)}
      />

      <LearningLinksSection
        title="Backlinks"
        links={detail.backlinks}
        emptyText="no backlinks"
        onOpen={onOpenPeer}
        backlinks
      />

      {suggestions.length > 0 && (
        <div class="cos-learning-detail-section">
          <div class="cos-learning-detail-section-head">
            <span class="cos-learning-detail-section-title">Suggested links</span>
            <span class="cos-muted">based on text overlap</span>
          </div>
          <div class="cos-learning-suggestions">
            {suggestions.map((s) => (
              <div key={s.peer.id} class="cos-learning-suggestion">
                <span
                  class="cos-learning-dot"
                  style={{ background: LEARNING_TYPE_COLOR[s.peer.type] }}
                  title={s.peer.type}
                />
                <button
                  type="button"
                  class="cos-learning-title-btn"
                  onClick={() => onOpenPeer(s.peer.id)}
                >
                  {s.peer.title}
                </button>
                <span class="cos-muted">{Math.round(s.similarity * 100)}%</span>
                <span class="cos-inline-actions">
                  {(['related', 'duplicate_of', 'caused_by', 'resolved_by'] as CosLearningRelType[]).map((rel) => (
                    <button
                      key={rel}
                      class="cos-link-btn"
                      onClick={() => void handleAddLink(s.peer.id, rel)}
                      title={`Link as "${REL_TYPE_LABELS[rel]}"`}
                    >
                      +{REL_TYPE_LABELS[rel]}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {linkPickerFor !== null && (
        <LearningLinkPicker
          allLearnings={allLearnings}
          excludeIds={existingPeerIds}
          relType={linkPickerFor}
          onPick={(peerId, rel) => void handleAddLink(peerId, rel)}
          onCancel={() => setLinkPickerFor(null)}
        />
      )}
    </div>
  );
}

function LearningLinksSection({
  title,
  links,
  emptyText,
  onOpen,
  onDelete,
  onAdd,
  backlinks,
}: {
  title: string;
  links: CosLearningLinkPeer[];
  emptyText: string;
  onOpen: (peerId: string) => void;
  onDelete?: (linkId: string) => void;
  onAdd?: (rel: CosLearningRelType) => void;
  backlinks?: boolean;
}) {
  return (
    <div class="cos-learning-detail-section">
      <div class="cos-learning-detail-section-head">
        <span class="cos-learning-detail-section-title">{title}</span>
        {onAdd && (
          <span class="cos-inline-actions">
            {(['related', 'caused_by', 'resolved_by', 'duplicate_of'] as CosLearningRelType[]).map((rel) => (
              <button
                key={rel}
                class="cos-link-btn"
                onClick={() => onAdd(rel)}
                title={`Add a "${REL_TYPE_LABELS[rel]}" link`}
              >
                +{REL_TYPE_LABELS[rel]}
              </button>
            ))}
          </span>
        )}
      </div>
      {links.length === 0 ? (
        <div class="cos-muted cos-learning-empty-row">{emptyText}</div>
      ) : (
        <div class="cos-learning-links">
          {links.map((lp) => (
            <div key={lp.linkId} class="cos-learning-link-row">
              <span
                class="cos-learning-link-rel"
                style={{ color: REL_TYPE_COLOR[lp.relType] }}
                title={lp.source === 'auto' ? 'auto-suggested' : lp.source}
              >
                {backlinks ? '←' : '→'} {REL_TYPE_LABELS[lp.relType]}
                {lp.source !== 'user' && <span class="cos-muted"> ({lp.source})</span>}
              </span>
              {lp.peer ? (
                <button
                  type="button"
                  class="cos-learning-title-btn"
                  onClick={() => onOpen(lp.peer!.id)}
                >
                  {lp.peer.title}
                </button>
              ) : (
                <span class="cos-muted">[deleted learning]</span>
              )}
              {onDelete && (
                <button
                  class="cos-link-btn cos-danger-text"
                  onClick={() => onDelete(lp.linkId)}
                  title="Remove this link"
                  aria-label="Remove link"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LearningLinkPicker({
  allLearnings,
  excludeIds,
  relType,
  onPick,
  onCancel,
}: {
  allLearnings: CosLearning[];
  excludeIds: Set<string>;
  relType: CosLearningRelType;
  onPick: (peerId: string, rel: CosLearningRelType) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState('');
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allLearnings
      .filter((l) => !excludeIds.has(l.id))
      .filter((l) => !q || l.title.toLowerCase().includes(q) || l.body.toLowerCase().includes(q))
      .slice(0, 50);
  }, [allLearnings, excludeIds, filter]);
  return (
    <div class="cos-learning-link-picker">
      <div class="cos-learning-link-picker-head">
        <span>Pick a learning to link as <strong>{REL_TYPE_LABELS[relType]}</strong></span>
        <button class="cos-link-btn" onClick={onCancel}>cancel</button>
      </div>
      <input
        class="cos-inline-input"
        placeholder="Filter by title or body…"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        autoFocus
      />
      <div class="cos-learning-link-picker-list">
        {candidates.length === 0
          ? <div class="cos-muted">No matches.</div>
          : candidates.map((l) => (
              <button
                key={l.id}
                type="button"
                class="cos-learning-link-picker-row"
                onClick={() => onPick(l.id, relType)}
              >
                <span
                  class="cos-learning-dot"
                  style={{ background: LEARNING_TYPE_COLOR[l.type] }}
                  title={l.type}
                />
                <span class="cos-learning-link-picker-title">{l.title}</span>
                <span class="cos-muted">{l.severity}</span>
              </button>
            ))}
      </div>
    </div>
  );
}

function DispatchStatusLine({ dispatches }: { dispatches: DispatchInfo[] }) {
  // Observe title-cache invalidation so titles re-render after async fetch.
  const _titlesVersion = feedbackTitlesVersion.value;

  useEffect(() => {
    for (const d of dispatches) {
      if (!getCachedFeedbackTitle(d.feedbackId)) {
        void fetchFeedbackTitle(d.feedbackId);
      }
    }
  }, [dispatches]);

  return (
    <div class="cos-dispatch-status" role="status">
      {dispatches.map((d, i) => {
        const title = getCachedFeedbackTitle(d.feedbackId);
        const appId = selectedAppId.value;
        const feedbackHref = `#${appId ? `/app/${appId}/tickets/${d.feedbackId}` : `/tickets/${d.feedbackId}`}`;
        return (
          <div key={`${d.feedbackId}-${i}`} class="cos-dispatch-status-item">
            <a
              class="cos-dispatch-status-title"
              href={feedbackHref}
              title={d.feedbackId}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openFeedbackItem(d.feedbackId);
              }}
            >
              → {title || d.feedbackId.slice(0, 14) + '…'}
            </a>
            {d.sessionId && (
              <span class="cos-dispatch-session-pills">
                <button
                  type="button"
                  class="cos-dispatch-session-pill"
                  title={`Open terminal for session ${d.sessionId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSession(d.sessionId!);
                  }}
                >
                  ⌥ {d.sessionId.slice(0, 14)}
                </button>
                <button
                  type="button"
                  class="cos-dispatch-session-pill cos-dispatch-session-pill-jsonl"
                  title={`Open JSONL viewer for session ${d.sessionId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSession(d.sessionId!);
                    toggleCompanion(d.sessionId!, 'jsonl');
                  }}
                >
                  JSONL
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ThreadBlock({
  thread,
  collapsed,
  onToggle,
  onStop,
  showTools,
  highlightMsgIdx,
  onReply,
  onArtifactPopout,
  hasUnread,
  agentName,
  verbosity,
}: {
  thread: Thread;
  collapsed: boolean;
  onToggle: () => void;
  onStop: () => void;
  showTools: boolean;
  highlightMsgIdx: number | null;
  onReply: (role: string, text: string, anchorTs?: number) => void;
  onArtifactPopout: (artifactId: string) => void;
  hasUnread: boolean;
  agentName: string;
  verbosity: ChiefOfStaffVerbosity;
}) {
  const { userMsg, userIdx, replies } = thread;
  const dispatches = useMemo(() => collectDispatches(replies), [replies]);
  const isRunning = replies.some((r) => r.msg.streaming);
  const replyCount = replies.length;
  const hasReplies = replyCount > 0;
  const lastReply = replies[replies.length - 1]?.msg;
  const showSummaryCollapsed = !!userMsg && collapsed && hasReplies;
  const showExpandedReplies = !userMsg || !collapsed;
  const threadContext = userMsg?.text || '';
  const anchorTs = userMsg?.timestamp;
  // Each UI thread maps to one server-side cosThread. Pull the id from any
  // tagged message so Stop targets just this thread's Claude session instead
  // of interrupting unrelated in-flight threads for the same agent.
  const threadServerId =
    userMsg?.threadId ?? replies.find((r) => r.msg.threadId)?.msg.threadId ?? null;
  const handleThreadStop = () => {
    if (threadServerId) void interruptThread(threadServerId);
    else onStop();
  };
  const handleThreadReply = () => {
    if (threadContext) onReply('user', threadContext, anchorTs);
  };
  return (
    <div class={`cos-thread-block${hasUnread ? ' cos-thread-block-unread' : ''}${userMsg ? '' : ' cos-thread-block-orphan'}`}>
      {userMsg && (
        <div
          class={`cos-msg cos-row cos-row-user cos-row-post${highlightMsgIdx === userIdx ? ' cos-msg-highlight' : ''}${hasUnread ? ' cos-row-unread' : ''}`}
          data-cos-msg-idx={userIdx ?? undefined}
          data-cos-thread-anchor={userIdx ?? undefined}
        >
          <div class="cos-row-avatar">
            <MessageAvatar role="user" label="You" />
          </div>
          <div class="cos-row-main">
            <div class="cos-row-header">
              <span class="cos-row-author">You</span>
              {userMsg.timestamp && <Timestamp ts={userMsg.timestamp} />}
              {hasUnread && (
                <span class="cos-row-unread-dot" title="Unread reply" aria-label="Unread reply" />
              )}
            </div>
            {userMsg.text && (
              <div class="cos-row-content cos-msg-text">{userMsg.text}</div>
            )}
            <MessageAttachments attachments={userMsg.attachments} elementRefs={userMsg.elementRefs} />
          </div>
        </div>
      )}
      {(hasReplies || dispatches.length > 0) && (
        <div class="cos-thread-children">
          {dispatches.length > 0 && <DispatchStatusLine dispatches={dispatches} />}
          {showSummaryCollapsed && (
            <button
              type="button"
              class={`cos-thread-summary${hasUnread ? ' cos-thread-summary-unread' : ''}`}
              onClick={onToggle}
              aria-expanded="false"
              aria-label={`Expand ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`}
            >
              <span class="cos-thread-summary-avatars" aria-hidden="true">
                <MessageAvatar role="assistant" label={agentName} size="sm" />
              </span>
              <span class="cos-thread-summary-count">
                {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
              </span>
              {lastReply?.timestamp && (
                <span class="cos-thread-summary-time">
                  Last reply <Timestamp ts={lastReply.timestamp} />
                </span>
              )}
              <span class="cos-thread-summary-hint">View thread</span>
            </button>
          )}
          {showExpandedReplies && (
            <>
              {userMsg && (
                <div class="cos-thread-header-row">
                  <span class="cos-thread-header-count">
                    {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
                  </span>
                  <button
                    type="button"
                    class="cos-thread-header-btn"
                    onClick={onToggle}
                    aria-expanded="true"
                    title="Collapse thread"
                  >
                    Collapse
                  </button>
                </div>
              )}
              {replies.map((r) => (
                <MessageBubble
                  key={r.idx}
                  msg={r.msg}
                  msgIdx={r.idx}
                  highlighted={highlightMsgIdx === r.idx}
                  showTools={showTools}
                  onArtifactPopout={onArtifactPopout}
                  agentName={agentName}
                  verbosity={verbosity}
                />
              ))}
            </>
          )}
        </div>
      )}
      {userMsg && !(collapsed && hasReplies) && (
        <div class="cos-thread-actions">
          {isRunning && (
            <button
              type="button"
              class="cos-thread-reply-btn cos-thread-reply-btn-running"
              onClick={handleThreadStop}
              title="Interrupt current response"
              aria-label="Interrupt current response"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
              <span>Stop</span>
            </button>
          )}
          <button
            type="button"
            class="cos-thread-reply-btn"
            onClick={handleThreadReply}
            title="Reply in thread"
            aria-label="Reply in thread"
            disabled={!threadContext}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
            <span>Reply in thread</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ChiefOfStaffToggle() {
  const open = chiefOfStaffOpen.value;
  // Read the layout tree signal so this button re-renders when the cos pane
  // is opened/closed via another entry point.
  const _layout = layoutTreeSignal.value;
  const paneOpen = isCosInPane();
  const mobile = isMobile.value;
  // On mobile the pane mode falls back to the popout (openCosInPane does the
  // redirect), so the toggle's "active" state must key off `open` too —
  // `paneOpen` stays false because we never add `cos:main` to the tree there.
  const active = open || paneOpen;

  function handleClick(e: MouseEvent) {
    // Shift-click → dock CoS into the pane tree for users who want it inline.
    // Close the popout first since the two surfaces are mutually exclusive.
    if (e.shiftKey) {
      if (open) setChiefOfStaffOpen(false);
      if (paneOpen) closeCosPane(); else openCosInPane();
      return;
    }
    // Default: always toggle the popout. Close any docked pane first so the
    // two surfaces don't fight over the same `cos:main` tab.
    if (paneOpen) closeCosPane();
    if (!open && mobile) {
      // If the user tapped the toggle while an input elsewhere still held
      // focus (e.g. the feedback widget textarea), the iOS keyboard stays
      // up and squeezes the popout to near-zero height via
      // --pw-keyboard-inset. Blur first so the keyboard retracts before
      // the popout positions itself.
      const el = document.activeElement as HTMLElement | null;
      if (el && typeof el.blur === 'function') el.blur();
    }
    setChiefOfStaffOpen(!open);
  }

  return (
    <button
      class={`control-bar-btn control-bar-cos-btn${active ? ' control-bar-cos-btn-open' : ''}`}
      onClick={handleClick}
      title="Ops (shift-click to dock in pane)"
      aria-label="Open Ops chat"
    >
      <span class="control-bar-icon" aria-hidden="true">
        {active ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.2 6.6L21 10.8l-5.6 3.6L17.2 22 12 18l-5.2 4 1.8-7.6L3 10.8l6.8-2.2z" />
          </svg>
        )}
      </span>
    </button>
  );
}

export type CosMode = 'popout' | 'pane';

export function ChiefOfStaffBubble({
  floatingButton = true,
  mode = 'popout',
}: { floatingButton?: boolean; mode?: CosMode } = {}) {
  const open = chiefOfStaffOpen.value;
  const agents = chiefOfStaffAgents.value;
  const activeId = chiefOfStaffActiveId.value;
  const activeAgent = getActiveAgent();
  const error = chiefOfStaffError.value;

  const allPanels = popoutPanels.value;
  const _zOrders = panelZOrders.value;
  const panel = allPanels.find((p) => p.id === COS_PANEL_ID);
  const inPane = mode === 'pane';

  const [input, setInput] = useState('');
  type PendingAttachment = { id: string; dataUrl: string; name?: string; mimeType: string };
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pendingElementRefs, setPendingElementRefs] = useState<CosElementRef[]>([]);
  const [pickerActive, setPickerActive] = useState(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const pickerCleanupRef = useRef<(() => void) | null>(null);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  const [cameraMenuPos, setCameraMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [pickerMenuPos, setPickerMenuPos] = useState<{ top: number; left: number } | null>(null);
  const cameraGroupRef = useRef<HTMLDivElement | null>(null);
  const pickerGroupRef = useRef<HTMLDivElement | null>(null);
  const [screenshotExcludeWidget, setScreenshotExcludeWidget] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-excl-widget') : null;
    return v === null ? true : v === '1';
  });
  const [screenshotExcludeCursor, setScreenshotExcludeCursor] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-excl-cursor') : null;
    return v === null ? true : v === '1';
  });
  const [screenshotMethod, setScreenshotMethod] = useState<'html-to-image' | 'display-media'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-method') : null;
    return v === 'display-media' ? 'display-media' : 'html-to-image';
  });
  const [screenshotKeepStream, setScreenshotKeepStream] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-shot-keep') : null;
    return v === '1';
  });
  const [pickerExcludeWidget, setPickerExcludeWidget] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-excl-widget') : null;
    return v === '1';
  });
  const [pickerMultiSelect, setPickerMultiSelect] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-multi') : null;
    return v === '1';
  });
  const [pickerIncludeChildren, setPickerIncludeChildren] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-pick-children') : null;
    return v === '1';
  });
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-excl-widget', screenshotExcludeWidget ? '1' : '0'); } catch { /* ignore */ } }, [screenshotExcludeWidget]);
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-excl-cursor', screenshotExcludeCursor ? '1' : '0'); } catch { /* ignore */ } }, [screenshotExcludeCursor]);
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-method', screenshotMethod); } catch { /* ignore */ } }, [screenshotMethod]);
  useEffect(() => { try { localStorage.setItem('pw-cos-shot-keep', screenshotKeepStream ? '1' : '0'); } catch { /* ignore */ } }, [screenshotKeepStream]);
  useEffect(() => { try { localStorage.setItem('pw-cos-pick-excl-widget', pickerExcludeWidget ? '1' : '0'); } catch { /* ignore */ } }, [pickerExcludeWidget]);
  useEffect(() => { try { localStorage.setItem('pw-cos-pick-multi', pickerMultiSelect ? '1' : '0'); } catch { /* ignore */ } }, [pickerMultiSelect]);
  useEffect(() => { try { localStorage.setItem('pw-cos-pick-children', pickerIncludeChildren ? '1' : '0'); } catch { /* ignore */ } }, [pickerIncludeChildren]);
  const [replyTo, setReplyTo] = useState<{ role: string; text: string; anchorTs?: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [collapsedThreads, setCollapsedThreads] = useState<Set<number>>(new Set());
  const [showTools, setShowTools] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-show-tools') : null;
    return v === '1';
  });
  const [showLearnings, setShowLearnings] = useState(false);
  const [editingAttachment, setEditingAttachment] = useState<{ id: string; dataUrl: string } | null>(null);
  const [learningsSide, setLearningsSide] = useState<'left' | 'right'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-learnings-side') : null;
    return v === 'right' ? 'right' : 'left';
  });
  const [shellRect, setShellRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-show-tools', showTools ? '1' : '0'); } catch { /* ignore */ }
  }, [showTools]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-learnings-side', learningsSide); } catch { /* ignore */ }
  }, [learningsSide]);
  useEffect(() => {
    if (!showLearnings) { setShellRect(null); return; }
    const el = wrapperRef.current;
    if (!el) return;
    let raf: number | null = null;
    const update = () => {
      const r = el.getBoundingClientRect();
      setShellRect((prev) => {
        if (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) return prev;
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
    };
    const tick = () => { update(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); };
  }, [showLearnings, inPane]);

  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [promptEdit, setPromptEdit] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const threads = useMemo(
    () => groupIntoThreads(activeAgent?.messages || []),
    [activeAgent?.messages],
  );
  const collapsibleThreads = threads.filter((t) => t.userIdx !== null);
  const hasMultipleThreads = collapsibleThreads.length >= 2;
  const anyExpanded = collapsibleThreads.some((t) => !collapsedThreads.has(t.userIdx!));
  const isAgentStreaming = (activeAgent?.messages || []).some((m) => m.streaming);

  function toggleThread(userIdx: number) {
    setCollapsedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(userIdx)) next.delete(userIdx);
      else next.add(userIdx);
      return next;
    });
  }

  function toggleAllThreads() {
    if (anyExpanded) {
      setCollapsedThreads(new Set(collapsibleThreads.map((t) => t.userIdx!)));
    } else {
      setCollapsedThreads(new Set());
    }
  }

  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  const resizing = useRef<string | null>(null);
  const dragStart = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, dockedHeight: 0, dockedTopOffset: 0, dockedBaseTop: 0 });

  type ReplyNotification = {
    id: string;
    threadKey: string;
    userIdx: number | null;
    messageIdx: number;
    threadTitle: string;
    snippet: string;
  };
  const [replyNotifs, setReplyNotifs] = useState<ReplyNotification[]>([]);
  const [highlightMsgIdx, setHighlightMsgIdx] = useState<number | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const wasAtBottomRef = useRef(true);
  const seenMsgsRef = useRef<Map<number, boolean>>(new Map());
  const seenInitializedRef = useRef(false);
  const notifTimersRef = useRef<Map<string, number>>(new Map());

  const isVisible = open || inPane;

  function isScrollAtBottom(el: HTMLElement | null): boolean {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  // Reset notification + seen state when the active agent changes; the next
  // run of the messages effect will repopulate `seen` without firing notifs
  // for already-loaded history.
  useEffect(() => {
    seenMsgsRef.current = new Map();
    seenInitializedRef.current = false;
    for (const t of notifTimersRef.current.values()) clearTimeout(t);
    notifTimersRef.current.clear();
    setReplyNotifs([]);
    setHighlightMsgIdx(null);
    wasAtBottomRef.current = true;
  }, [activeId]);

  // Auto-scroll to bottom on load (panel open, agent switch, or when history
  // count changes while user is already pinned to the bottom).
  useEffect(() => {
    if (!isVisible) return;
    const el = scrollRef.current;
    if (!el) return;
    if (!seenInitializedRef.current || wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      wasAtBottomRef.current = true;
      setShowScrollDown(false);
    }
  }, [isVisible, activeId, activeAgent?.messages.length]);

  // Scroll listener: toggle the floating scroll-down button and remember the
  // user's "at bottom" state so new messages don't yank them around.
  useEffect(() => {
    if (!isVisible) return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isScrollAtBottom(el);
      wasAtBottomRef.current = atBottom;
      setShowScrollDown(!atBottom);
      // Clear any pending notifications once the user is back at the bottom.
      if (atBottom) {
        for (const t of notifTimersRef.current.values()) clearTimeout(t);
        notifTimersRef.current.clear();
        setReplyNotifs((prev) => (prev.length === 0 ? prev : []));
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [isVisible, activeId]);

  // Detect newly-completed assistant replies that arrive while the user is
  // scrolled away from the bottom and surface a stackable notification chip.
  useEffect(() => {
    if (!isVisible) return;
    const agent = activeAgent;
    if (!agent) return;
    const seen = seenMsgsRef.current;

    if (!seenInitializedRef.current) {
      agent.messages.forEach((m, i) => {
        if (m.role === 'assistant') seen.set(i, !!m.streaming);
      });
      seenInitializedRef.current = true;
      return;
    }

    const atBottom = isScrollAtBottom(scrollRef.current);

    const newlyComplete: { idx: number; msg: ChiefOfStaffMsg }[] = [];
    for (let i = 0; i < agent.messages.length; i++) {
      const msg = agent.messages[i];
      if (msg.role !== 'assistant') continue;
      const wasStreaming = seen.get(i);
      const isStreaming = !!msg.streaming;
      seen.set(i, isStreaming);
      if (isStreaming) continue;
      // New completion: streaming→done OR previously-unseen complete msg.
      if (wasStreaming === true || wasStreaming === undefined) {
        newlyComplete.push({ idx: i, msg });
      }
    }

    if (atBottom || newlyComplete.length === 0) return;

    const notifsToAdd: ReplyNotification[] = [];
    for (const { idx, msg } of newlyComplete) {
      const thread = threads.find(
        (t) => t.replies.some((r) => r.idx === idx),
      );
      if (!thread) continue;
      const threadKey = thread.userIdx !== null ? `t-${thread.userIdx}` : 'pre';
      const userText = thread.userMsg?.text?.trim() || '(no prompt)';
      const threadTitle = userText.length > 48 ? userText.slice(0, 48) + '…' : userText;
      const reply = extractCosReply(msg.text);
      const replyText = (reply.displayText || msg.text || '').trim();
      const snippet = replyText.length > 90 ? replyText.slice(0, 90) + '…' : replyText;
      notifsToAdd.push({
        id: `n-${idx}-${Date.now()}`,
        threadKey,
        userIdx: thread.userIdx,
        messageIdx: idx,
        threadTitle,
        snippet,
      });
    }

    if (notifsToAdd.length === 0) return;

    setReplyNotifs((prev) => {
      const replacedKeys = new Set(notifsToAdd.map((n) => n.threadKey));
      const kept = prev.filter((n) => {
        if (!replacedKeys.has(n.threadKey)) return true;
        const t = notifTimersRef.current.get(n.id);
        if (t) { clearTimeout(t); notifTimersRef.current.delete(n.id); }
        return false;
      });
      return [...kept, ...notifsToAdd];
    });

    for (const n of notifsToAdd) {
      const handle = window.setTimeout(() => {
        notifTimersRef.current.delete(n.id);
        setReplyNotifs((prev) => prev.filter((p) => p.id !== n.id));
      }, 8000);
      notifTimersRef.current.set(n.id, handle);
    }
  }, [activeAgent?.messages, threads, isVisible]);

  useEffect(() => {
    return () => {
      for (const t of notifTimersRef.current.values()) clearTimeout(t);
      notifTimersRef.current.clear();
    };
  }, []);

  function dismissReplyNotif(id: string) {
    const handle = notifTimersRef.current.get(id);
    if (handle) { clearTimeout(handle); notifTimersRef.current.delete(id); }
    setReplyNotifs((prev) => prev.filter((n) => n.id !== id));
  }

  function activateReplyNotif(notif: ReplyNotification) {
    if (notif.userIdx !== null && collapsedThreads.has(notif.userIdx)) {
      setCollapsedThreads((prev) => {
        const next = new Set(prev);
        next.delete(notif.userIdx!);
        return next;
      });
    }
    // Wait for the expand re-render before measuring scroll target.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const root = scrollRef.current;
        if (!root) return;
        const sel = `[data-cos-msg-idx="${notif.messageIdx}"]`;
        const target = root.querySelector(sel) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightMsgIdx(notif.messageIdx);
          window.setTimeout(() => {
            setHighlightMsgIdx((cur) => (cur === notif.messageIdx ? null : cur));
          }, 2400);
        }
      });
    });
    dismissReplyNotif(notif.id);
  }

  useEffect(() => {
    if (open && inputRef.current && !showSettings) inputRef.current.focus();
  }, [open, activeId, showSettings]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (inputHeight !== null) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [input, open, inputHeight]);

  function onInputResizeHandleMouseDown(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ta = inputRef.current;
    if (!ta) return;
    const startY = e.clientY;
    const startHeight = inputHeight ?? ta.clientHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      const next = Math.max(72, Math.min(600, startHeight + delta));
      setInputHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  useEffect(() => {
    setNameEdit(null);
    setPromptEdit(null);
    setConfirmDelete(false);
    setConfirmClear(false);
  }, [activeId, showSettings]);

  useEffect(() => {
    setCollapsedThreads(new Set());
  }, [activeId]);

  function submit() {
    const hasAttach = pendingAttachments.length > 0 || pendingElementRefs.length > 0;
    if (!input.trim() && !hasAttach) return;
    const text = input;
    const attachments: CosImageAttachment[] = pendingAttachments.map((a) => ({
      kind: 'image',
      dataUrl: a.dataUrl,
      name: a.name,
    }));
    const elementRefs: CosElementRef[] = pendingElementRefs.map((e) => ({ ...e }));
    const replyToTs = replyTo?.anchorTs;
    setInput('');
    setReplyTo(null);
    setPendingAttachments([]);
    setPendingElementRefs([]);
    sendChiefOfStaffMessage(text, selectedAppId.value, { attachments, elementRefs, replyToTs });
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function addImageBlob(blob: Blob, name?: string) {
    try {
      const dataUrl = await blobToDataUrl(blob);
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          dataUrl,
          name,
          mimeType: blob.type || 'image/png',
        },
      ]);
    } catch (err) {
      console.error('[cos] failed to read image blob:', err);
    }
  }

  async function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        handled = true;
        const ext = file.type.split('/')[1] || 'png';
        const name = (file as File).name && (file as File).name !== 'image.png'
          ? (file as File).name
          : `pasted-${Date.now()}.${ext}`;
        await addImageBlob(file, name);
      }
    }
    if (handled) e.preventDefault();
  }

  async function captureAndAttachScreenshot() {
    if (capturingScreenshot) return;
    setCapturingScreenshot(true);
    try {
      const blob = await captureScreenshot({
        method: screenshotMethod,
        excludeWidget: screenshotExcludeWidget,
        excludeCursor: screenshotExcludeCursor,
        keepStream: screenshotMethod === 'display-media' && screenshotKeepStream,
      });
      if (!blob) {
        chiefOfStaffError.value = 'Screenshot capture failed';
        return;
      }
      await addImageBlob(blob, `screenshot-${Date.now()}.png`);
    } catch (err: any) {
      chiefOfStaffError.value = `Screenshot failed: ${err?.message || err}`;
    } finally {
      setCapturingScreenshot(false);
    }
  }

  async function startTimedScreenshot(seconds: number) {
    if (capturingScreenshot) return;
    setCameraMenuOpen(false);
    setCapturingScreenshot(true);
    try {
      for (let i = seconds; i > 0; i--) {
        chiefOfStaffError.value = `Screenshot in ${i}…`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      chiefOfStaffError.value = '';
      const blob = await captureScreenshot({
        method: screenshotMethod,
        excludeWidget: screenshotExcludeWidget,
        excludeCursor: screenshotExcludeCursor,
        keepStream: screenshotMethod === 'display-media' && screenshotKeepStream,
      });
      if (!blob) {
        chiefOfStaffError.value = 'Screenshot capture failed';
        return;
      }
      await addImageBlob(blob, `screenshot-${Date.now()}.png`);
    } catch (err: any) {
      chiefOfStaffError.value = `Screenshot failed: ${err?.message || err}`;
    } finally {
      setCapturingScreenshot(false);
    }
  }

  function stopElementPicker() {
    if (pickerCleanupRef.current) {
      pickerCleanupRef.current();
      pickerCleanupRef.current = null;
    }
    setPickerActive(false);
  }

  function startElementPick() {
    if (pickerActive) {
      stopElementPicker();
      return;
    }
    const host = wrapperRef.current;
    if (!host) return;
    setPickerActive(true);
    setPickerMenuOpen(false);
    // On mobile the CoS panel fills the viewport, so fading it to 0.25 opacity
    // leaves a grey haze over everything AND still intercepts taps (the picker
    // excludes widget-host descendants). Hide it outright instead.
    const mobile = isMobile.value;
    const prevOpacity = host.style.opacity;
    const prevDisplay = host.style.display;
    if (mobile || pickerExcludeWidget) {
      host.style.display = 'none';
    } else {
      host.style.opacity = '0.25';
    }
    const restoreHost = () => {
      if (mobile || pickerExcludeWidget) host.style.display = prevDisplay;
      else host.style.opacity = prevOpacity;
    };
    const cleanup = startPicker(
      (infos: SelectedElementInfo[]) => {
        restoreHost();
        pickerCleanupRef.current = null;
        setPickerActive(false);
        if (infos.length === 0) return;
        const mapped: CosElementRef[] = infos.map((i) => ({
          selector: i.selector,
          tagName: i.tagName,
          id: i.id || undefined,
          classes: i.classes,
          textContent: i.textContent,
          boundingRect: i.boundingRect,
          attributes: i.attributes,
        }));
        setPendingElementRefs((prev) => [...prev, ...mapped]);
        inputRef.current?.focus();
      },
      host,
      { multiSelect: pickerMultiSelect, excludeWidget: pickerExcludeWidget, includeChildren: pickerIncludeChildren },
    );
    pickerCleanupRef.current = cleanup;
  }

  useEffect(() => {
    return () => {
      if (pickerCleanupRef.current) {
        pickerCleanupRef.current();
        pickerCleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!cameraMenuOpen && !pickerMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (cameraMenuOpen && cameraGroupRef.current && target && !cameraGroupRef.current.contains(target)) {
        setCameraMenuOpen(false);
      }
      if (pickerMenuOpen && pickerGroupRef.current && target && !pickerGroupRef.current.contains(target)) {
        setPickerMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [cameraMenuOpen, pickerMenuOpen]);

  function handleReply(role: string, text: string, anchorTs?: number) {
    const excerpt = text.length > 120 ? text.slice(0, 120) : text;
    setReplyTo({ role, text: excerpt, anchorTs });
    inputRef.current?.focus();
  }

  function handleArtifactPopout(artifactId: string) {
    // In pane mode the CoS is already a leaf in the main layout tree, so the
    // existing companion splitter gives the user the familiar left/right/
    // top/bottom pane placement.
    if (inPane) {
      // Anchor the split to the CoS leaf so the artifact becomes a companion
      // of the chat, no matter which leaf currently holds focus.
      const cosLeaf = findLeafWithTab(COS_PANE_TAB_ID);
      if (cosLeaf) setFocusedLeaf(cosLeaf.id);
      openArtifactCompanion(artifactId);
      return;
    }
    // Popout mode: the popout window hosts its own pane-tree. Opening an
    // artifact inserts a new split pane next to the chat.
    const wasEmpty = !hasAnyArtifactLeaf(cosPopoutTree.value.root);
    cosOpenArtifactTab(artifactId, 'right');
    // When opening the first artifact split, widen the floating panel so the
    // chat and artifact both have room. Skip when docked — docked width is
    // part of the user's layout and shouldn't jump.
    if (wasEmpty && panel && !panel.docked) {
      const needed = 720;
      if (panel.floatingRect.w < needed) {
        const maxW = typeof window !== 'undefined' ? window.innerWidth - 32 : needed;
        const targetW = Math.max(panel.floatingRect.w, Math.min(needed, maxW));
        const rightEdge = panel.floatingRect.x + targetW;
        const overflow = typeof window !== 'undefined' ? Math.max(0, rightEdge - (window.innerWidth - 8)) : 0;
        updatePanel(COS_PANEL_ID, {
          floatingRect: {
            ...panel.floatingRect,
            w: targetW,
            x: Math.max(8, panel.floatingRect.x - overflow),
          },
        });
        persistPopoutState();
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault();
      setReplyTo(null);
    }
  }

  function commitNewAgent() {
    const name = (newAgentName || '').trim();
    if (name) addAgent(name);
    setNewAgentName(null);
  }

  function commitRename() {
    if (nameEdit !== null && nameEdit.trim()) renameActiveAgent(nameEdit.trim());
    setNameEdit(null);
  }

  function commitPrompt() {
    if (promptEdit !== null) updateActiveAgentSystemPrompt(promptEdit);
    setPromptEdit(null);
  }

  const onHeaderDragStart = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a, select, textarea')) return;
    e.preventDefault();
    ensureCosPanel();
    const cp = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
    if (!cp) return;
    dragging.current = true;
    dragMoved.current = false;
    wrapperRef.current?.classList.add('popout-dragging');
    const fr = cp.floatingRect;
    dragStart.current = {
      mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h,
      dockedHeight: cp.dockedHeight, dockedTopOffset: cp.dockedTopOffset || 0,
      dockedBaseTop: cp.docked ? (e.clientY - getDockedPanelTop(COS_PANEL_ID)) : 0,
    };
    const ghostLabel = 'Ops chat';
    let ghost: HTMLElement | null = null;
    const ensureGhost = () => {
      if (ghost) return;
      ghost = document.createElement('div');
      ghost.className = 'tab-drag-ghost pane-drag-ghost';
      ghost.textContent = ghostLabel;
      document.body.appendChild(ghost);
    };
    const removeGhost = () => {
      if (ghost) { ghost.remove(); ghost = null; }
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      handleDragMove(ev, COS_PANEL_ID, dragStart.current, dragMoved);
      if (detectExternalZone(ev.clientX, ev.clientY)) {
        ensureGhost();
        applyExternalGhostHint(ghost, ghostLabel, ev.clientX, ev.clientY);
      } else {
        removeGhost();
      }
    };
    const onUp = (ev: MouseEvent) => {
      dragging.current = false;
      wrapperRef.current?.classList.remove('popout-dragging');
      snapGuides.value = [];
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      removeGhost();

      const externalZone = detectExternalZone(ev.clientX, ev.clientY);
      if (externalZone && dragMoved.current) {
        openCosExternally(externalZone);
        setChiefOfStaffOpen(false);
        return;
      }
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const onResizeStart = useCallback((edge: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cp = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
    if (!cp) return;
    resizing.current = edge;
    wrapperRef.current?.classList.add('popout-dragging');
    const fr = cp.floatingRect;
    const curOffset = cp.dockedTopOffset || 0;
    const curTop = getDockedPanelTop(COS_PANEL_ID);
    const baseTop = curTop - curOffset;
    dragStart.current = {
      mx: e.clientX, my: e.clientY, x: fr.x, y: fr.y, w: fr.w, h: fr.h,
      dockedHeight: cp.dockedHeight, dockedTopOffset: curOffset, dockedBaseTop: baseTop,
    };
    const startDockedW = cp.dockedWidth;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      handleResizeMove(ev, COS_PANEL_ID, resizing.current, dragStart.current, startDockedW);
    };
    const onUp = () => {
      resizing.current = null;
      wrapperRef.current?.classList.remove('popout-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistPopoutState();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  let panelStyle: Record<string, string | number> | undefined;
  let isDocked = false;
  let isLeftDocked = false;
  let isMinimized = false;
  if (panel && !inPane) {
    isDocked = panel.docked;
    isLeftDocked = isDocked && panel.dockedSide === 'left';
    isMinimized = !isDocked && !!panel.minimized;
    const zIdx = getPanelZIndex(panel);
    const panelTop = isDocked ? getDockedPanelTop(panel.id) : undefined;
    const orientation = dockedOrientation.value;
    if (isDocked) {
      if (isLeftDocked) {
        panelStyle = {
          position: 'fixed', left: sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3),
          top: panelTop as number, width: panel.dockedWidth, height: panel.dockedHeight, zIndex: zIdx,
        };
      } else if (orientation === 'horizontal') {
        const dockedPanels = popoutPanels.value.filter((p) => p.docked && p.visible && p.dockedSide !== 'left');
        const idx = dockedPanels.findIndex((p) => p.id === panel.id);
        const count = dockedPanels.length;
        const topStart = 40;
        const availH = window.innerHeight - topStart;
        const perPanel = count > 0 ? availH / count : availH;
        panelStyle = { position: 'fixed', right: 0, top: topStart + idx * perPanel, width: panel.dockedWidth, height: perPanel, zIndex: zIdx };
      } else {
        panelStyle = { position: 'fixed', right: 0, top: panelTop as number, width: panel.dockedWidth, height: panel.dockedHeight, zIndex: zIdx };
      }
    } else {
      panelStyle = {
        position: 'fixed', left: panel.floatingRect.x, top: panel.floatingRect.y,
        width: panel.floatingRect.w, height: isMinimized ? 34 : panel.floatingRect.h, zIndex: zIdx,
      };
    }
  }

  // Subscribe to layout signal so `isCosInPane()` re-evaluates when the tree
  // changes (keeps the popout hidden while the cos: tab is live in the tree).
  const _layout = layoutTreeSignal.value;
  const hasCosTabInTree = isCosInPane();
  // Subscribe to the popout-local tree so the CoS panel re-renders when
  // artifact/learnings leaves are added or split ratios change. We mirror the
  // signal into useState via an effect because relying on Preact's
  // signal-auto-subscription alone has missed re-renders when a collapsed
  // tree root happens to share node ids with a previously-rendered snapshot.
  // Subscribe to the popout-local tree so the CoS panel re-renders when
  // artifact/learnings leaves are added or split ratios change.
  const _cosTree = cosPopoutTree.value;
  // In popout mode the learnings panel is a tab in the popout-local tree, so
  // the toolbar button's "open" state is derived from the tree — not from the
  // local `showLearnings` state (which only drives the pane-mode side drawer).
  const learningsPopoutOpen = !inPane && cosIsLearningsOpen();
  const learningsButtonActive = inPane ? showLearnings : learningsPopoutOpen;

  const shouldRenderShell = inPane
    ? !!activeAgent
    : !!(open && activeAgent && panel && panel.visible && !hasCosTabInTree);

  const learningsDrawerWidth = 340;
  const learningsDrawerStyle = (() => {
    if (!showLearnings || !shellRect) return null;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    let side: 'left' | 'right' = learningsSide;
    const leftSpot = shellRect.left - learningsDrawerWidth;
    const rightSpot = shellRect.left + shellRect.width;
    if (side === 'left' && leftSpot < 0 && rightSpot + learningsDrawerWidth <= vw) side = 'right';
    if (side === 'right' && rightSpot + learningsDrawerWidth > vw && leftSpot >= 0) side = 'left';
    const leftPx = side === 'left'
      ? Math.max(0, leftSpot)
      : Math.min(vw - learningsDrawerWidth, rightSpot);
    const zIdx = !inPane && panel ? getPanelZIndex(panel) + 1 : 900;
    return {
      position: 'fixed' as const,
      top: shellRect.top,
      height: shellRect.height,
      left: leftPx,
      width: learningsDrawerWidth,
      zIndex: zIdx,
      side,
    };
  })();

  return (
    <>
      {!inPane && floatingButton && (
        <button
          class={`cos-bubble${open ? ' cos-bubble-open' : ''}`}
          onClick={toggleChiefOfStaff}
          title="Ops"
          aria-label="Open Ops chat"
        >
          {open ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l2.2 6.6L21 10.8l-5.6 3.6L17.2 22 12 18l-5.2 4 1.8-7.6L3 10.8l6.8-2.2z" />
            </svg>
          )}
        </button>
      )}

      {shouldRenderShell && activeAgent && inPane && showLearnings && learningsDrawerStyle && (
        <div
          class={`cos-learnings-side cos-learnings-side-${learningsDrawerStyle.side}`}
          style={{
            position: learningsDrawerStyle.position,
            top: learningsDrawerStyle.top,
            left: learningsDrawerStyle.left,
            width: learningsDrawerStyle.width,
            height: learningsDrawerStyle.height,
            zIndex: learningsDrawerStyle.zIndex,
          }}
        >
          <div class="cos-learnings-side-controls">
            <button
              type="button"
              class="cos-link-btn"
              onClick={() => setLearningsSide(learningsDrawerStyle.side === 'left' ? 'right' : 'left')}
              title={`Move to ${learningsDrawerStyle.side === 'left' ? 'right' : 'left'}`}
              aria-label="Flip drawer side"
            >
              {learningsDrawerStyle.side === 'left' ? '→' : '←'}
            </button>
          </div>
          <LearningsPanel onClose={() => setShowLearnings(false)} />
        </div>
      )}

      {shouldRenderShell && activeAgent && (
        <div
          ref={wrapperRef}
          class={inPane
            ? 'cos-popout cos-pane'
            : `${isDocked ? `popout-docked${isLeftDocked ? ' docked-left' : ''}` : 'popout-floating'}${isMinimized ? ' minimized' : ''}${panel!.alwaysOnTop ? ' always-on-top' : ''} cos-popout`}
          style={inPane ? undefined : (panelStyle as any)}
          data-panel-id={COS_PANEL_ID}
          onMouseDown={inPane ? undefined : (() => { bringToFront(COS_PANEL_ID); })}
        >
          <div class="popout-tab-bar" onMouseDown={inPane ? undefined : onHeaderDragStart}>
            <div class="popout-tab-scroll">
              {agents.map((a) => {
                const isActiveTab = a.id === activeId && !showSettings;
                return (
                  <button
                    key={a.id}
                    class={`popout-tab ${isActiveTab ? 'active' : ''}`}
                    onClick={() => {
                      chiefOfStaffActiveId.value = a.id;
                      setShowSettings(false);
                      if (!inPane) bringToFront(COS_PANEL_ID);
                    }}
                    title={a.name}
                  >
                    <span class="popout-tab-label">{a.name}</span>
                  </button>
                );
              })}
              {newAgentName === null ? (
                <button
                  class="popout-tab cos-tab-add"
                  title="New agent"
                  onClick={() => setNewAgentName('')}
                >
                  <span class="popout-tab-label">+</span>
                </button>
              ) : (
                <div class="popout-tab cos-tab-new" onMouseDown={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    autoFocus
                    placeholder="Agent name"
                    value={newAgentName}
                    onInput={(e) => setNewAgentName((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitNewAgent(); }
                      if (e.key === 'Escape') { e.preventDefault(); setNewAgentName(null); }
                    }}
                    onBlur={() => {
                      if ((newAgentName || '').trim()) commitNewAgent();
                      else setNewAgentName(null);
                    }}
                  />
                </div>
              )}
              <button
                class={`popout-tab ${showSettings ? 'active' : ''}`}
                onClick={() => setShowSettings(!showSettings)}
                title="Agent settings"
              >
                <span class="popout-tab-label">Settings</span>
              </button>
            </div>
            {!inPane && panel && (
              <div class="popout-window-controls">
                <button
                  ref={menuButtonRef}
                  class="btn-close-panel cos-hamburger-draggable"
                  onClick={() => setMenuOpen((v) => !v)}
                  onMouseDown={(e) => {
                    // Drag-to-popout: if the user drags the hamburger >40px, open
                    // a standalone CoS window via ?embed=cos (chat-only, no admin
                    // chrome) so the popped-out window matches what the
                    // CosEmbedRoot renders. Click-only opens the menu instead.
                    const startX = (e as MouseEvent).clientX;
                    const startY = (e as MouseEvent).clientY;
                    let dragged = false;
                    const onMove = (ev: MouseEvent) => {
                      const dx = ev.clientX - startX;
                      const dy = ev.clientY - startY;
                      if (!dragged && Math.hypot(dx, dy) > 40) {
                        dragged = true;
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        setMenuOpen(false);
                        const cosUrl = `${location.origin}${location.pathname}?embed=cos`;
                        // Decide window vs tab based on drop position: near screen
                        // edge → detached window, anywhere else → new tab.
                        const nearEdge =
                          ev.clientX < 20 ||
                          ev.clientX > window.innerWidth - 20 ||
                          ev.clientY < 20 ||
                          ev.clientY > window.innerHeight - 20;
                        if (nearEdge) {
                          window.open(cosUrl, '_blank', 'width=900,height=700,menubar=no,toolbar=no');
                        } else {
                          window.open(cosUrl, '_blank');
                        }
                      }
                    };
                    const onUp = () => {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                  }}
                  title="Panel options (drag to pop out to new window/tab)"
                  aria-haspopup="true"
                  aria-expanded={menuOpen}
                >{'☰'}</button>
                <button class="btn-close-panel" onClick={toggleChiefOfStaff} title="Hide panel">&times;</button>
                {menuOpen && (
                  <WindowMenu
                    panel={panel}
                    activeId={COS_PANE_TAB_ID}
                    docked={isDocked}
                    isLeftDocked={isLeftDocked}
                    isMinimized={isMinimized}
                    anchorRef={menuButtonRef}
                    onClose={() => setMenuOpen(false)}
                  />
                )}
              </div>
            )}
          </div>

          {!isMinimized && (
            <div class="popout-body cos-popout-body">
              {showSettings ? (
                <div class="cos-settings cos-settings-full">
                  <div class="cos-settings-row">
                    <label>Name</label>
                    {nameEdit === null ? (
                      <button class="cos-link-btn" onClick={() => setNameEdit(activeAgent.name)}>{activeAgent.name} — edit</button>
                    ) : (
                      <div class="cos-inline-edit">
                        <input
                          type="text"
                          autoFocus
                          value={nameEdit}
                          onInput={(e) => setNameEdit((e.target as HTMLInputElement).value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                            if (e.key === 'Escape') { e.preventDefault(); setNameEdit(null); }
                          }}
                        />
                        <button class="cos-link-btn" onClick={commitRename} disabled={!nameEdit.trim()}>save</button>
                        <button class="cos-link-btn" onClick={() => setNameEdit(null)}>cancel</button>
                      </div>
                    )}
                  </div>
                  <div class="cos-settings-row cos-settings-row-stack">
                    <label>
                      System prompt
                      {promptEdit === null && (
                        <button
                          class="cos-link-btn"
                          onClick={() => setPromptEdit(activeAgent.systemPrompt || '')}
                        >
                          {activeAgent.systemPrompt ? 'edit custom' : 'override default'}
                        </button>
                      )}
                    </label>
                    {promptEdit === null ? (
                      <div class="cos-prompt-preview">
                        {activeAgent.systemPrompt || <em>Using default Ops prompt (direct, terse, operations-focused)</em>}
                      </div>
                    ) : (
                      <>
                        <textarea
                          class="cos-prompt-textarea"
                          autoFocus
                          rows={5}
                          value={promptEdit}
                          onInput={(e) => setPromptEdit((e.target as HTMLTextAreaElement).value)}
                          placeholder="Leave empty to use default"
                        />
                        <div class="cos-inline-actions">
                          <button class="cos-link-btn" onClick={commitPrompt}>save</button>
                          <button class="cos-link-btn" onClick={() => setPromptEdit(null)}>cancel</button>
                        </div>
                      </>
                    )}
                  </div>
                  <div class="cos-settings-row">
                    <label>Verbosity</label>
                    <div class="cos-view-segmented" role="radiogroup" aria-label="Reply verbosity">
                      {(['terse', 'normal', 'verbose'] as ChiefOfStaffVerbosity[]).map((v) => {
                        const active = (activeAgent.verbosity || DEFAULT_VERBOSITY) === v;
                        return (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            class={`cos-view-seg${active ? ' cos-view-seg-active' : ''}`}
                            onClick={() => updateActiveAgentVerbosity(v)}
                          >
                            {v}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div class="cos-settings-row">
                    <label>Tone</label>
                    <div class="cos-view-segmented" role="radiogroup" aria-label="Reply tone">
                      {(['dry', 'neutral', 'friendly'] as ChiefOfStaffStyle[]).map((s) => {
                        const active = (activeAgent.style || DEFAULT_STYLE) === s;
                        return (
                          <button
                            key={s}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            class={`cos-view-seg${active ? ' cos-view-seg-active' : ''}`}
                            onClick={() => updateActiveAgentStyle(s)}
                          >
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div class="cos-settings-row">
                    <label>History</label>
                    {activeAgent.messages.length === 0 ? (
                      <span class="cos-muted">empty</span>
                    ) : !confirmClear ? (
                      <button class="cos-link-btn" onClick={() => setConfirmClear(true)}>
                        {activeAgent.messages.length} messages — clear
                      </button>
                    ) : (
                      <div class="cos-inline-edit">
                        <span class="cos-muted">Clear all?</span>
                        <button class="cos-link-btn cos-danger-text" onClick={() => { void clearActiveAgentHistory(); setConfirmClear(false); setCollapsedThreads(new Set()); }}>yes, clear</button>
                        <button class="cos-link-btn" onClick={() => setConfirmClear(false)}>cancel</button>
                      </div>
                    )}
                  </div>
                  <div class="cos-settings-row">
                    <label>Agent</label>
                    {!confirmDelete ? (
                      <button class="cos-link-btn cos-danger-text" onClick={() => setConfirmDelete(true)}>
                        {agents.length <= 1 ? 'reset this agent' : 'delete this agent'}
                      </button>
                    ) : (
                      <div class="cos-inline-edit">
                        <span class="cos-muted">Sure?</span>
                        <button class="cos-link-btn cos-danger-text" onClick={() => { removeActiveAgent(); setConfirmDelete(false); }}>yes</button>
                        <button class="cos-link-btn" onClick={() => setConfirmDelete(false)}>cancel</button>
                      </div>
                    )}
                  </div>
                </div>
              ) : ((() => {
                const chatPane = (
                  <div class="cos-chat-pane">
                    <div class="cos-scroll-toolbar">
                      {activeAgent.messages.length > 0 && (
                        <>
                          <button
                            type="button"
                            class={`cos-scroll-toolbar-btn${showTools ? ' cos-scroll-toolbar-btn-active' : ''}`}
                            onClick={() => setShowTools(!showTools)}
                            title={showTools ? 'Hide tool calls' : 'Show tool calls'}
                            aria-pressed={showTools}
                          >
                            Tools
                          </button>
                          {hasMultipleThreads && (
                            <button
                              type="button"
                              class="cos-scroll-toolbar-btn"
                              onClick={toggleAllThreads}
                              title={anyExpanded ? 'Collapse all threads' : 'Expand all threads'}
                            >
                              {anyExpanded ? 'Collapse' : 'Expand'}
                            </button>
                          )}
                        </>
                      )}
                      <button
                        type="button"
                        class={`cos-scroll-toolbar-btn${learningsButtonActive ? ' cos-scroll-toolbar-btn-active' : ''}`}
                        onClick={() => {
                          if (inPane) {
                            const next = !showLearnings;
                            setShowLearnings(next);
                            if (next) void loadCosLearnings();
                          } else {
                            // Popout mode: toggle the learnings tab in the
                            // popout-local pane-tree instead of opening a
                            // fixed-position side drawer.
                            const opened = cosToggleLearningsTab('left');
                            if (opened) void loadCosLearnings();
                          }
                        }}
                        title="Wiggum self-reflection learnings"
                        aria-pressed={learningsButtonActive}
                      >
                        Learnings{cosLearnings.value.length > 0 ? ` (${cosLearnings.value.length})` : ''}
                      </button>
                    </div>

                    <div class="cos-scroll-wrap">
                    <div class="cos-scroll" ref={scrollRef}>
                      {activeAgent.messages.length === 0 && (
                        <div class="cos-empty">
                          <div class="cos-empty-title">{activeAgent.name}</div>
                          <div class="cos-empty-hint">
                            Ready. Ask about feedback, sessions, or infra — or tell me to dispatch something.
                          </div>
                          <div class="cos-empty-examples">
                            {[
                              "What's new in the queue?",
                              'Any sessions stuck or running long?',
                              'Are all launchers online?',
                            ].map((q) => (
                              <button key={q} class="cos-example" onClick={() => setInput(q)}>{q}</button>
                            ))}
                          </div>
                        </div>
                      )}
                      {(() => {
                        const unreadThreadIdxs = new Set<number>();
                        for (const n of replyNotifs) {
                          if (n.userIdx !== null) unreadThreadIdxs.add(n.userIdx);
                        }
                        const nodes: import('preact').VNode[] = [];
                        let lastDayKey: string | null = null;
                        threads.forEach((t, i) => {
                          const ts = t.userMsg?.timestamp ?? t.replies[0]?.msg.timestamp ?? null;
                          if (ts) {
                            const k = dayKeyOf(ts);
                            if (k !== lastDayKey) {
                              nodes.push(<DayDivider key={`day-${k}-${i}`} ts={ts} />);
                              lastDayKey = k;
                            }
                          }
                          nodes.push(
                            <ThreadBlock
                              key={t.userIdx ?? `pre-${i}`}
                              thread={t}
                              collapsed={t.userIdx !== null && collapsedThreads.has(t.userIdx)}
                              onToggle={() => t.userIdx !== null && toggleThread(t.userIdx)}
                              onStop={() => void interruptActiveAgent()}
                              showTools={showTools}
                              highlightMsgIdx={highlightMsgIdx}
                              onReply={handleReply}
                              onArtifactPopout={handleArtifactPopout}
                              hasUnread={t.userIdx !== null && unreadThreadIdxs.has(t.userIdx)}
                              agentName={activeAgent.name}
                              verbosity={activeAgent.verbosity || DEFAULT_VERBOSITY}
                            />
                          );
                        });
                        return nodes;
                      })()}
                      {error && (
                        <div class="cos-error">
                          <span>{error}</span>
                          <button
                            type="button"
                            class="cos-error-dismiss"
                            onClick={() => { chiefOfStaffError.value = null; }}
                            aria-label="Dismiss error"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                          </button>
                        </div>
                      )}
                    </div>

                    <div class="cos-floating-actions" aria-hidden={!showScrollDown}>
                      {showScrollDown && (
                        <button
                          type="button"
                          class={`cos-scroll-down-btn${replyNotifs.length > 0 ? ' cos-scroll-down-btn-unread' : ''}`}
                          onClick={() => scrollToBottom('smooth')}
                          title={replyNotifs.length > 0 ? `${replyNotifs.length} new repl${replyNotifs.length === 1 ? 'y' : 'ies'} — scroll to latest` : 'Scroll to latest'}
                          aria-label="Scroll to latest message"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                          {replyNotifs.length > 0 && (
                            <span class="cos-scroll-down-badge" aria-hidden="true">{replyNotifs.length}</span>
                          )}
                        </button>
                      )}
                    </div>
                    </div>

                    {replyTo && (
                      <div class="cos-reply-pill" role="status">
                        <span class="cos-reply-pill-label">Replying to {replyTo.role}</span>
                        <span class="cos-reply-pill-text">{replyTo.text}</span>
                        <button
                          type="button"
                          class="cos-reply-pill-close"
                          onClick={() => setReplyTo(null)}
                          title="Clear reply"
                          aria-label="Clear reply"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                    )}
                    <div class="cos-input-row">
                      <div
                        class="cos-resize-handle"
                        onMouseDown={onInputResizeHandleMouseDown}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize input"
                        title="Drag to resize"
                      />
                      {(pendingAttachments.length > 0 || pendingElementRefs.length > 0) && (
                        <div class="cos-attach-strip">
                          {pendingAttachments.map((att) => (
                            <div class="cos-attach-thumb" key={att.id}>
                              <img
                                src={att.dataUrl}
                                alt={att.name || 'attachment'}
                                style="cursor:pointer"
                                title="Click to edit"
                                onClick={() => setEditingAttachment({ id: att.id, dataUrl: att.dataUrl })}
                              />
                              <button
                                type="button"
                                class="cos-attach-remove"
                                onClick={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                                title="Remove attachment"
                                aria-label="Remove attachment"
                              >
                                &times;
                              </button>
                            </div>
                          ))}
                          {pendingElementRefs.map((ref, idx) => {
                            let display = ref.tagName || 'element';
                            if (ref.id) display += `#${ref.id}`;
                            const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
                            if (cls.length) display += '.' + cls.join('.');
                            return (
                              <div class="cos-element-chip" key={`ref-${idx}`} title={ref.selector}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
                                </svg>
                                <code>{display}</code>
                                <button
                                  type="button"
                                  class="cos-attach-remove"
                                  onClick={() => setPendingElementRefs((prev) => prev.filter((_, i) => i !== idx))}
                                  title="Remove element reference"
                                  aria-label="Remove element reference"
                                >
                                  &times;
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <textarea
                        ref={inputRef}
                        class="cos-input"
                        value={input}
                        placeholder={`Message ${activeAgent.name}… (paste images to attach)`}
                        onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        rows={1}
                        style={inputHeight !== null ? { height: inputHeight + 'px', maxHeight: 'none' } : undefined}
                      />
                      <div class="cos-input-toolbar">
                        <div class="cos-tool-group" ref={cameraGroupRef}>
                          <button
                            type="button"
                            class={`cos-tool-btn cos-tool-btn-main${capturingScreenshot ? ' loading' : ''}`}
                            onClick={() => { void captureAndAttachScreenshot(); }}
                            disabled={capturingScreenshot}
                            title="Capture screenshot of this page"
                            aria-label="Capture screenshot"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                              <circle cx="12" cy="13" r="4" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="cos-tool-dropdown-toggle"
                            onClick={(e) => { e.stopPropagation(); setPickerMenuOpen(false); const r = cameraGroupRef.current?.getBoundingClientRect(); if (r) setCameraMenuPos({ top: r.top - 4, left: r.left }); setCameraMenuOpen((v) => !v); }}
                            title="Screenshot options"
                            aria-label="Screenshot options"
                            aria-expanded={cameraMenuOpen}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
                          </button>
                          {cameraMenuOpen && (
                            <div class="cos-tool-menu" style={cameraMenuPos ? { top: `${cameraMenuPos.top}px`, left: `${cameraMenuPos.left}px`, transform: 'translateY(-100%)' } : undefined}>
                              <label class="cos-tool-menu-item">
                                <input
                                  type="checkbox"
                                  checked={screenshotExcludeWidget}
                                  onChange={(e) => setScreenshotExcludeWidget((e.target as HTMLInputElement).checked)}
                                />
                                Exclude widget
                              </label>
                              <label class="cos-tool-menu-item">
                                <input
                                  type="checkbox"
                                  checked={screenshotExcludeCursor}
                                  onChange={(e) => setScreenshotExcludeCursor((e.target as HTMLInputElement).checked)}
                                />
                                Exclude cursor
                              </label>
                              <label class="cos-tool-menu-item">
                                <input
                                  type="checkbox"
                                  checked={screenshotMethod === 'html-to-image'}
                                  onChange={(e) => {
                                    const checked = (e.target as HTMLInputElement).checked;
                                    setScreenshotMethod(checked ? 'html-to-image' : 'display-media');
                                    if (checked) setScreenshotKeepStream(false);
                                  }}
                                />
                                html-to-image
                              </label>
                              <label class={`cos-tool-menu-item${screenshotMethod === 'html-to-image' ? ' disabled' : ''}`}>
                                <input
                                  type="checkbox"
                                  checked={screenshotKeepStream}
                                  disabled={screenshotMethod === 'html-to-image'}
                                  onChange={(e) => setScreenshotKeepStream((e.target as HTMLInputElement).checked)}
                                />
                                Multi-screenshot
                              </label>
                              <div class="cos-tool-menu-divider" />
                              <button
                                type="button"
                                class="cos-tool-menu-item cos-tool-menu-btn"
                                onClick={() => { void startTimedScreenshot(3); }}
                                disabled={capturingScreenshot}
                              >
                                Timed (3s)
                              </button>
                            </div>
                          )}
                        </div>
                        <div class="cos-tool-group" ref={pickerGroupRef}>
                          <button
                            type="button"
                            class={`cos-tool-btn cos-tool-btn-main${pickerActive ? ' active' : ''}`}
                            onClick={startElementPick}
                            title={pickerActive ? 'Cancel element picker (Esc)' : 'Pick a DOM element'}
                            aria-label="Pick element"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M13 2l7 19-7-4-4 7z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="cos-tool-dropdown-toggle"
                            onClick={(e) => { e.stopPropagation(); setCameraMenuOpen(false); const r = pickerGroupRef.current?.getBoundingClientRect(); if (r) setPickerMenuPos({ top: r.top - 4, left: r.left }); setPickerMenuOpen((v) => !v); }}
                            title="Picker options"
                            aria-label="Picker options"
                            aria-expanded={pickerMenuOpen}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
                          </button>
                          {pickerMenuOpen && (
                            <div class="cos-tool-menu" style={pickerMenuPos ? { top: `${pickerMenuPos.top}px`, left: `${pickerMenuPos.left}px`, transform: 'translateY(-100%)' } : undefined}>
                              <label class="cos-tool-menu-item">
                                <input
                                  type="checkbox"
                                  checked={pickerExcludeWidget}
                                  onChange={(e) => setPickerExcludeWidget((e.target as HTMLInputElement).checked)}
                                />
                                Exclude widget
                              </label>
                              <label class="cos-tool-menu-item">
                                <input
                                  type="checkbox"
                                  checked={pickerMultiSelect}
                                  onChange={(e) => setPickerMultiSelect((e.target as HTMLInputElement).checked)}
                                />
                                Multi-select
                              </label>
                              <label class="cos-tool-menu-item">
                                <input
                                  type="checkbox"
                                  checked={pickerIncludeChildren}
                                  onChange={(e) => setPickerIncludeChildren((e.target as HTMLInputElement).checked)}
                                />
                                Include children
                              </label>
                            </div>
                          )}
                        </div>
                        <div class="cos-input-toolbar-spacer" />
                        {isAgentStreaming ? (
                          <button
                            class="cos-stop"
                            onClick={() => void interruptActiveAgent()}
                            title="Stop (interrupt response)"
                            aria-label="Interrupt current response"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <rect x="5" y="5" width="14" height="14" rx="2" />
                            </svg>
                          </button>
                        ) : (
                          <button
                            class="cos-send"
                            onClick={submit}
                            disabled={!input.trim() && pendingAttachments.length === 0 && pendingElementRefs.length === 0}
                            title="Send (Enter)"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12l14-7-7 14-2-5z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
                if (inPane) return chatPane;
                return (
                  <CosPopoutTreeView
                    tree={_cosTree}
                    chatContent={chatPane}
                    learningsContent={<LearningsPanel onClose={() => cosToggleLearningsTab('left')} />}
                  />
                );
              })())}
            </div>
          )}

          {!inPane && !isMinimized && (isDocked ? (
            <>
              <div class="popout-resize-n" onMouseDown={(e) => onResizeStart('n', e)} />
              <div class="popout-resize-s" onMouseDown={(e) => onResizeStart('s', e)} />
              {isLeftDocked ? (
                <>
                  <div class="popout-resize-e" onMouseDown={(e) => onResizeStart('e', e)} />
                  <div class="popout-resize-ne" onMouseDown={(e) => onResizeStart('ne', e)} />
                  <div class="popout-resize-se" onMouseDown={(e) => onResizeStart('se', e)} />
                </>
              ) : (
                <>
                  <div class="popout-resize-w" onMouseDown={(e) => onResizeStart('w', e)} />
                  <div class="popout-resize-nw" onMouseDown={(e) => onResizeStart('nw', e)} />
                  <div class="popout-resize-sw" onMouseDown={(e) => onResizeStart('sw', e)} />
                </>
              )}
            </>
          ) : (
            <>
              <div class="popout-resize-n" onMouseDown={(e) => onResizeStart('n', e)} />
              <div class="popout-resize-s" onMouseDown={(e) => onResizeStart('s', e)} />
              <div class="popout-resize-e" onMouseDown={(e) => onResizeStart('e', e)} />
              <div class="popout-resize-w" onMouseDown={(e) => onResizeStart('w', e)} />
              <div class="popout-resize-ne" onMouseDown={(e) => onResizeStart('ne', e)} />
              <div class="popout-resize-nw" onMouseDown={(e) => onResizeStart('nw', e)} />
              <div class="popout-resize-se" onMouseDown={(e) => onResizeStart('se', e)} />
              <div class="popout-resize-sw" onMouseDown={(e) => onResizeStart('sw', e)} />
            </>
          ))}
        </div>
      )}
      {editingAttachment && (
        <AttachmentEditorModal
          dataUrl={editingAttachment.dataUrl}
          onSave={(newDataUrl) => {
            setPendingAttachments((prev) =>
              prev.map((a) => a.id === editingAttachment!.id ? { ...a, dataUrl: newDataUrl } : a)
            );
            setEditingAttachment(null);
          }}
          onClose={() => setEditingAttachment(null)}
        />
      )}
    </>
  );
}

function AttachmentEditorModal({ dataUrl, onSave, onClose }: { dataUrl: string; onSave: (newDataUrl: string) => void; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = new ImageEditor({
      container: containerRef.current,
      image: dataUrl,
      tools: ['highlight', 'crop'],
      initialTool: 'highlight',
      saveActions: [
        {
          label: 'Apply',
          primary: true,
          handler: (blob: Blob) => {
            const reader = new FileReader();
            reader.onload = () => onSave(reader.result as string);
            reader.readAsDataURL(blob);
          },
        },
      ],
      onCancel: onClose,
    });
    return () => editor.destroy();
  }, [dataUrl]);

  return (
    <div
      style="position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style="background:var(--cos-bg,#1a1a2e);border-radius:8px;padding:12px;max-width:90vw;max-height:90vh;overflow:auto;min-width:400px">
        <div ref={containerRef} style="display:flex;flex-direction:column;align-items:center;width:100%" />
      </div>
    </div>
  );
}
