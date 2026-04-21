import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import { selectedAppId } from '../lib/state.js';
import {
  chiefOfStaffOpen,
  chiefOfStaffAgents,
  chiefOfStaffActiveId,
  chiefOfStaffError,
  chiefOfStaffInFlight,
  toggleChiefOfStaff,
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
  ensureCosPanel,
  extractCosReply,
  DEFAULT_VERBOSITY,
  DEFAULT_STYLE,
  type ChiefOfStaffToolCall,
  type ChiefOfStaffMsg,
  type ChiefOfStaffVerbosity,
  type ChiefOfStaffStyle,
  cosLearnings,
  cosLearningsLoading,
  loadCosLearnings,
  deleteCosLearning,
  type CosLearning,
  wiggumAnnouncement,
} from '../lib/chief-of-staff.js';
import {
  popoutPanels,
  updatePanel,
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
} from '../lib/sessions.js';
import { handleDragMove, handleResizeMove } from '../lib/popout-physics.js';

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  // Use first item's plain text as hint, truncated
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
    // "lang filename" form — marked puts lang separately; any extra tail might be here
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
    // Prose-ish: paragraph, heading, blockquote, hr, space, html, etc.
    proseBuffer += raw;
  }
  flushProse();

  return segments;
}

function ArtifactCard({
  seg,
  expandedDefault,
}: {
  seg: Extract<ContentSegment, { type: 'artifact' }>;
  expandedDefault: boolean;
}) {
  const [expanded, setExpanded] = useState(expandedDefault);
  useEffect(() => { setExpanded(expandedDefault); }, [expandedDefault]);

  const body = useMemo(() => {
    if (seg.kind === 'code') {
      // Recover just the code text from raw fence
      const m = seg.raw.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
      const code = m ? m[1] : seg.raw;
      try {
        if (seg.lang && hljs.getLanguage(seg.lang)) {
          return { __html: hljs.highlight(code, { language: seg.lang }).value };
        }
      } catch { /* fall through */ }
      return { __html: escapeHtml(code) };
    }
    const html = marked.parse(seg.raw) as string;
    return { __html: typeof html === 'string' ? html : '' };
  }, [seg.raw, seg.kind, seg.lang]);

  const icon = seg.kind === 'code' ? '❮❯' : seg.kind === 'table' ? '▦' : '☰';

  return (
    <div class={`cos-artifact cos-artifact-${seg.kind}${expanded ? ' cos-artifact-open' : ''}`}>
      <button
        type="button"
        class="cos-artifact-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span class="cos-artifact-icon" aria-hidden="true">{icon}</span>
        <span class="cos-artifact-label">{seg.label}</span>
        <span class="cos-artifact-meta">{seg.meta}</span>
        <span class="cos-artifact-toggle">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        seg.kind === 'code' ? (
          <pre class="cos-artifact-body cos-artifact-body-code"><code class="hljs" dangerouslySetInnerHTML={body} /></pre>
        ) : (
          <div class="cos-artifact-body cos-md-prose" dangerouslySetInnerHTML={body} />
        )
      )}
    </div>
  );
}

function AssistantContent({ text, expandArtifacts }: { text: string; expandArtifacts: boolean }) {
  const segments = useMemo(() => parseAssistantContent(text), [text]);
  return (
    <div class="cos-msg-md">
      {segments.map((seg, i) => {
        if (seg.type === 'artifact') {
          return <ArtifactCard key={i} seg={seg} expandedDefault={expandArtifacts} />;
        }
        const html = marked.parse(seg.markdown) as string;
        return <div key={i} class="cos-md-prose" dangerouslySetInnerHTML={{ __html: typeof html === 'string' ? html : '' }} />;
      })}
    </div>
  );
}

function bashDisplayName(cmd: string): string {
  // Extract HTTP method + short path from curl commands
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

function countDispatches(replies: { idx: number; msg: ChiefOfStaffMsg }[]): number {
  let n = 0;
  for (const r of replies) {
    if (!r.msg.toolCalls) continue;
    for (const call of r.msg.toolCalls) {
      if (call.error) continue;
      if (toolSummary(call).startsWith('launched')) n++;
    }
  }
  return n;
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

function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      class="cos-msg-reply-btn"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="Reply to this message"
      aria-label="Reply to this message"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 17 4 12 9 7" />
        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      </svg>
    </button>
  );
}

function MessageBubble({
  msg,
  showTools,
  expandArtifacts,
  onReply,
}: {
  msg: ChiefOfStaffMsg;
  showTools: boolean;
  expandArtifacts: boolean;
  onReply: (role: string, text: string) => void;
}) {
  const hasTools = !!(msg.toolCalls && msg.toolCalls.length > 0);
  // For assistant messages, pull the user-facing reply out of <cos-reply> tags.
  // While streaming and before the tag opens, displayText is empty so only the
  // thinking dots show — keeps chain-of-thought out of the chat.
  const extracted = msg.role === 'assistant' ? extractCosReply(msg.text) : null;
  const assistantDisplay = extracted ? extracted.displayText : '';
  const showAssistantText = msg.role === 'assistant' && assistantDisplay;
  const showUserText = msg.role === 'user' && msg.text;
  const replyText = showAssistantText ? assistantDisplay : (showUserText ? msg.text : '');
  const canReply = !!replyText && !msg.streaming;
  return (
    <div class={`cos-msg cos-msg-${msg.role}`}>
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
        <div class="cos-msg-bubble">
          <div class="cos-msg-text cos-msg-text-md"><AssistantContent text={assistantDisplay} expandArtifacts={expandArtifacts} /></div>
          {canReply && <ReplyButton onClick={() => onReply(msg.role, replyText)} />}
        </div>
      )}
      {showUserText && (
        <div class="cos-msg-bubble">
          <div class="cos-msg-text">{msg.text}</div>
          {canReply && <ReplyButton onClick={() => onReply(msg.role, replyText)} />}
        </div>
      )}
      {msg.streaming && (
        <div class="cos-thinking">
          <span /><span /><span />
        </div>
      )}
      {msg.timestamp && !msg.streaming && (
        <div class="cos-msg-footer"><Timestamp ts={msg.timestamp} /></div>
      )}
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
  let current: Thread | null = null;
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      if (current) threads.push(current);
      current = { userIdx: i, userMsg: m, replies: [] };
    } else {
      if (!current) current = { userIdx: null, userMsg: null, replies: [] };
      current.replies.push({ idx: i, msg: m });
    }
  });
  if (current) threads.push(current);
  return threads;
}

function LearningsPanel({ onClose }: { onClose: () => void }) {
  const items = cosLearnings.value;
  const loading = cosLearningsLoading.value;

  useEffect(() => {
    void loadCosLearnings();
  }, []);

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

  const labels: Record<CosLearning['type'], string> = {
    pitfall: 'Pitfalls',
    suggestion: 'Suggestions',
    tool_gap: 'Tool gaps',
  };

  const order: CosLearning['type'][] = ['pitfall', 'suggestion', 'tool_gap'];

  const announcement = wiggumAnnouncement.value;

  return (
    <div class="cos-learnings-panel">
      <div class="cos-learnings-header">
        <span class="cos-learnings-title">Wiggum learnings</span>
        <button class="cos-link-btn" onClick={() => void loadCosLearnings()} title="Reload">
          {loading ? 'loading…' : 'refresh'}
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
      {order.map((type) => {
        const group = grouped[type];
        if (!group || group.length === 0) return null;
        return (
          <div key={type} class="cos-learnings-group">
            <div class="cos-learnings-group-title">
              {labels[type]} <span class="cos-muted">({group.length})</span>
            </div>
            {group.map((l) => (
              <div key={l.id} class={`cos-learning cos-learning-sev-${l.severity}`}>
                <div class="cos-learning-row">
                  <span
                    class={`cos-learning-dot cos-learning-dot-${l.severity}`}
                    title={`severity: ${l.severity}`}
                    aria-label={`severity ${l.severity}`}
                  />
                  <span class="cos-learning-title">{l.title}</span>
                  <button
                    class="cos-link-btn cos-danger-text"
                    onClick={() => void deleteCosLearning(l.id)}
                    title="Dismiss"
                    aria-label="Dismiss learning"
                  >
                    ×
                  </button>
                </div>
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
    </div>
  );
}

function ThreadBlock({
  thread,
  collapsed,
  onToggle,
  showTools,
  expandArtifacts,
  onReply,
}: {
  thread: Thread;
  collapsed: boolean;
  onToggle: () => void;
  showTools: boolean;
  expandArtifacts: boolean;
  onReply: (role: string, text: string) => void;
}) {
  const { userMsg, replies } = thread;
  const showReplies = !userMsg || !collapsed;
  const dispatchCount = useMemo(() => countDispatches(replies), [replies]);
  return (
    <>
      {userMsg && (
        <div class="cos-msg cos-msg-user">
          <div class="cos-thread-user-row">
            <button
              type="button"
              class={`cos-thread-toggle${collapsed ? ' cos-thread-toggle-collapsed' : ''}`}
              onClick={onToggle}
              aria-label={collapsed ? 'Expand thread' : 'Collapse thread'}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand thread' : 'Collapse thread'}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div class="cos-msg-bubble">
              <div class="cos-msg-text">{userMsg.text}</div>
              {userMsg.text && <ReplyButton onClick={() => onReply('user', userMsg.text)} />}
            </div>
          </div>
          {userMsg.timestamp && (
            <div class="cos-msg-footer cos-msg-footer-user"><Timestamp ts={userMsg.timestamp} /></div>
          )}
        </div>
      )}
      {userMsg && dispatchCount > 0 && (
        <div class="cos-dispatch-status" role="status">
          → {dispatchCount} agent{dispatchCount === 1 ? '' : 's'} dispatched
        </div>
      )}
      {showReplies && replies.map((r) => (
        <MessageBubble
          key={r.idx}
          msg={r.msg}
          showTools={showTools}
          expandArtifacts={expandArtifacts}
          onReply={onReply}
        />
      ))}
    </>
  );
}

export function ChiefOfStaffToggle() {
  const open = chiefOfStaffOpen.value;
  return (
    <button
      class={`control-bar-btn control-bar-cos-btn${open ? ' control-bar-cos-btn-open' : ''}`}
      onClick={toggleChiefOfStaff}
      title="Ops"
      aria-label="Open Ops chat"
    >
      <span class="control-bar-icon" aria-hidden="true">
        {open ? (
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

export function ChiefOfStaffBubble({ floatingButton = true }: { floatingButton?: boolean } = {}) {
  const open = chiefOfStaffOpen.value;
  const agents = chiefOfStaffAgents.value;
  const activeId = chiefOfStaffActiveId.value;
  const activeAgent = getActiveAgent();
  const error = chiefOfStaffError.value;
  const inFlight = chiefOfStaffInFlight.value;

  // Subscribe to popout panel state for CoS
  const allPanels = popoutPanels.value;
  const _zOrders = panelZOrders.value;
  const panel = allPanels.find((p) => p.id === COS_PANEL_ID);

  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<{ role: string; text: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [collapsedThreads, setCollapsedThreads] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<'summary' | 'full'>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-view-mode') : null;
    return v === 'full' ? 'full' : 'summary';
  });
  const [showTools, setShowTools] = useState<boolean>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('pw-cos-show-tools') : null;
    return v === '1';
  });
  const [showLearnings, setShowLearnings] = useState(false);
  const [inputHeight, setInputHeight] = useState<number | null>(null);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-view-mode', viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  useEffect(() => {
    try { localStorage.setItem('pw-cos-show-tools', showTools ? '1' : '0'); } catch { /* ignore */ }
  }, [showTools]);
  const expandArtifacts = viewMode === 'full';

  // Inline settings state
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

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, activeAgent?.messages.length]);

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
    // Reset inline state when switching agents or closing settings
    setNameEdit(null);
    setPromptEdit(null);
    setConfirmDelete(false);
    setConfirmClear(false);
  }, [activeId, showSettings]);

  useEffect(() => {
    setCollapsedThreads(new Set());
  }, [activeId]);

  function submit() {
    if (!input.trim()) return;
    let text = input;
    if (replyTo) {
      const quoted = replyTo.text.replace(/\n/g, '\n> ');
      text = `> ${quoted}\n\n${text}`;
    }
    setInput('');
    setReplyTo(null);
    sendChiefOfStaffMessage(text, selectedAppId.value);
  }

  function handleReply(role: string, text: string) {
    const excerpt = text.length > 120 ? text.slice(0, 120) : text;
    setReplyTo({ role, text: excerpt });
    inputRef.current?.focus();
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
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      handleDragMove(ev, COS_PANEL_ID, dragStart.current, dragMoved);
    };
    const onUp = () => {
      dragging.current = false;
      wrapperRef.current?.classList.remove('popout-dragging');
      snapGuides.value = [];
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
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
  if (panel) {
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

  return (
    <>
      {floatingButton && (
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

      {open && activeAgent && panel && panel.visible && (
        <div
          ref={wrapperRef}
          class={`${isDocked ? `popout-docked${isLeftDocked ? ' docked-left' : ''}` : 'popout-floating'}${isMinimized ? ' minimized' : ''}${panel.alwaysOnTop ? ' always-on-top' : ''} cos-popout`}
          style={panelStyle as any}
          data-panel-id={COS_PANEL_ID}
          onMouseDown={() => { bringToFront(COS_PANEL_ID); }}
        >
          <div class="popout-tab-bar" onMouseDown={onHeaderDragStart}>
            <div class="popout-tab-scroll">
              {agents.map((a) => {
                const isActiveTab = a.id === activeId && !showSettings;
                return (
                  <button
                    key={a.id}
                    class={`popout-tab ${isActiveTab ? 'active' : ''}`}
                    onClick={() => { chiefOfStaffActiveId.value = a.id; setShowSettings(false); }}
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
            <div class="popout-window-controls">
              <button class="btn-close-panel" onClick={toggleChiefOfStaff} title="Hide panel">&times;</button>
            </div>
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
              ) : (
                <>
                  {activeAgent.messages.length > 0 && (
                    <div class="cos-scroll-toolbar">
                      <div class="cos-view-segmented" role="tablist" aria-label="View mode">
                        <button
                          type="button"
                          class={`cos-view-seg${viewMode === 'summary' ? ' cos-view-seg-active' : ''}`}
                          onClick={() => setViewMode('summary')}
                          aria-pressed={viewMode === 'summary'}
                          title="Prose-first view; artifacts collapsed, tool calls hidden"
                        >
                          Summary
                        </button>
                        <button
                          type="button"
                          class={`cos-view-seg${viewMode === 'full' ? ' cos-view-seg-active' : ''}`}
                          onClick={() => setViewMode('full')}
                          aria-pressed={viewMode === 'full'}
                          title="Full view; artifacts expanded"
                        >
                          Full
                        </button>
                      </div>
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
                      <button
                        type="button"
                        class={`cos-scroll-toolbar-btn${showLearnings ? ' cos-scroll-toolbar-btn-active' : ''}`}
                        onClick={() => {
                          const next = !showLearnings;
                          setShowLearnings(next);
                          if (next) void loadCosLearnings();
                        }}
                        title="Wiggum self-reflection learnings"
                        aria-pressed={showLearnings}
                      >
                        Learnings{cosLearnings.value.length > 0 ? ` (${cosLearnings.value.length})` : ''}
                      </button>
                    </div>
                  )}
                  {activeAgent.messages.length === 0 && (
                    <div class="cos-scroll-toolbar cos-scroll-toolbar-thin">
                      <button
                        type="button"
                        class={`cos-scroll-toolbar-btn${showLearnings ? ' cos-scroll-toolbar-btn-active' : ''}`}
                        onClick={() => {
                          const next = !showLearnings;
                          setShowLearnings(next);
                          if (next) void loadCosLearnings();
                        }}
                        title="Wiggum self-reflection learnings"
                        aria-pressed={showLearnings}
                      >
                        Learnings{cosLearnings.value.length > 0 ? ` (${cosLearnings.value.length})` : ''}
                      </button>
                    </div>
                  )}
                  {showLearnings && (
                    <LearningsPanel onClose={() => setShowLearnings(false)} />
                  )}

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
                    {threads.map((t, i) => (
                      <ThreadBlock
                        key={t.userIdx ?? `pre-${i}`}
                        thread={t}
                        collapsed={t.userIdx !== null && collapsedThreads.has(t.userIdx)}
                        onToggle={() => t.userIdx !== null && toggleThread(t.userIdx)}
                        showTools={showTools}
                        expandArtifacts={expandArtifacts}
                        onReply={handleReply}
                      />
                    ))}
                    {error && (
                      <div class="cos-error">{error}</div>
                    )}
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
                    <textarea
                      ref={inputRef}
                      class="cos-input"
                      value={input}
                      placeholder={`Message ${activeAgent.name}…`}
                      onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
                      onKeyDown={onKeyDown}
                      rows={1}
                      style={inputHeight !== null ? { height: inputHeight + 'px', maxHeight: 'none' } : undefined}
                    />
                    <div class="cos-input-buttons">
                      {inFlight > 0 && (
                        <button
                          class="cos-stop"
                          onClick={() => void interruptActiveAgent()}
                          title="Stop (interrupt)"
                          type="button"
                        >
                          &#9632;
                        </button>
                      )}
                      <button
                        class="cos-send"
                        onClick={submit}
                        disabled={!input.trim()}
                        title="Send (Enter)"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M5 12l14-7-7 14-2-5z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {!isMinimized && (isDocked ? (
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
    </>
  );
}
