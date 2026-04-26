import { useState, useEffect, useMemo } from 'preact/hooks';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import type { ParsedMessage } from '../lib/output-parser.js';
import { openFileViewer } from '../lib/file-viewer.js';
import { isMobile, useNarrow } from '../lib/viewport.js';
import { CopyCommand } from './CopyCommand.js';
import { AskUserQuestionPrompt, type Question } from './InteractivePrompt.js';

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(text: string): any {
  const html = marked.parse(text);
  if (typeof html !== 'string') return text;
  return <div class="sm-md-rendered" dangerouslySetInnerHTML={{ __html: html }} />;
}

// --- Language detection ---

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
  makefile: 'makefile', dockerfile: 'dockerfile',
  diff: 'diff', patch: 'diff', md: 'markdown', mdx: 'markdown',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const MARKDOWN_EXTS = new Set(['md', 'mdx', 'markdown']);

function getFileExt(path: string): string {
  const basename = path.split('/').pop() || '';
  if (basename.toLowerCase() === 'makefile') return 'makefile';
  if (basename.toLowerCase() === 'dockerfile') return 'dockerfile';
  return basename.split('.').pop()?.toLowerCase() || '';
}

function getLangFromPath(path: string): string | undefined {
  return EXT_TO_LANG[getFileExt(path)];
}

// --- Syntax highlighting ---

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightCode(content: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value;
    }
    // hljs.highlightAuto is O(N×languages) and freezes mobile Safari with
    // many large blocks. Fall back to escaped plain text when the language
    // isn't known — readable, just not colored.
    return escapeHtml(content);
  } catch {
    return escapeHtml(content);
  }
}

function HighlightedCode({ content, lang, maxLines }: { content: string; lang?: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split('\n');
  const truncatable = maxLines && lines.length > maxLines && !expanded;
  const displayContent = truncatable ? lines.slice(0, maxLines).join('\n') : content;
  const highlighted = useMemo(() => highlightCode(displayContent, lang), [displayContent, lang]);
  const displayLines = highlighted.split('\n');

  return (
    <div class="sm-highlighted-code">
      <pre class="sm-hl-pre"><code class="hljs">{displayLines.map((line, i) => (
        <div key={i} class="sm-hl-line">
          <span class="sm-hl-line-num">{i + 1}</span>
          <span class="sm-hl-line-text" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
        </div>
      ))}</code></pre>
      {truncatable && (
        <div class="sm-truncated" onClick={() => setExpanded(true)}>
          ... {lines.length - maxLines!} more lines (click to expand)
        </div>
      )}
    </div>
  );
}

// --- Props ---

/**
 * Chat-mode rendering options. Pass when consuming the same JSONL pipeline
 * inside a chat surface (e.g. the Chief-of-Staff bubble) instead of the
 * full session log viewer. Activates a denser layout that:
 *   • collapses tool_use+tool_result pairs into one compact chip
 *   • drops `tool_result`, `thinking`, and `system` entries entirely
 *   • runs assistant text through `textFilter` so the surface can apply
 *     its own visibility rules (e.g. extracting `<cos-reply>` content).
 *
 * Omit to render in the default full-detail mode.
 */
export interface ChatRenderOpts {
  /** Filter / transform assistant text. Return an empty string to suppress
   *  the message entirely. Identity (`(t) => t`) is the no-op default. */
  textFilter?: (rawText: string) => string;
  /** Optional callback fired when a clickable artifact marker is activated
   *  inside an assistant message. Reserved for the bubble's existing
   *  artifact popout flow; ignored by default. */
  onArtifactPopout?: (artifactId: string) => void;
}

interface Props {
  message: ParsedMessage;
  messages?: ParsedMessage[];
  index?: number;
  // Session context for interactive prompts. When the message is the last
  // AskUserQuestion in the stream AND the session is waiting for input, we
  // render buttons/inputs that send responses via send-keys.
  sessionId?: string;
  interactive?: boolean;
  /** When set, render in compact chat-mode (see ChatRenderOpts). */
  chat?: ChatRenderOpts;
}

function findPrecedingToolUse(messages: ParsedMessage[], index: number): ParsedMessage | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === 'tool_use') return messages[i];
    if (messages[i].role !== 'tool_result') break;
  }
  return undefined;
}

export function MessageRenderer({ message, messages, index, sessionId, interactive, chat }: Props) {
  const prevToolUse = (message.role === 'tool_result' && messages && index !== undefined)
    ? findPrecedingToolUse(messages, index)
    : undefined;

  if (chat) {
    switch (message.role) {
      case 'tool_use':
        return <ChatToolChip message={message} />;
      case 'tool_result':
      case 'thinking':
      case 'system':
        return null;
      case 'assistant': {
        const raw = message.content || '';
        const filtered = chat.textFilter ? chat.textFilter(raw) : raw;
        if (!filtered) return null;
        return <AssistantMessage message={{ ...message, content: filtered }} />;
      }
      case 'user_input':
        return <UserInputMessage message={message} />;
      default:
        return null;
    }
  }

  switch (message.role) {
    case 'tool_use':
      return <ToolUseMessage message={message} sessionId={sessionId} interactive={interactive} />;
    case 'tool_result':
      return <ToolResultMessage message={message} prevToolUse={prevToolUse} />;
    case 'assistant':
      return <AssistantMessage message={message} />;
    case 'user_input':
      return <UserInputMessage message={message} />;
    case 'thinking':
      return <ThinkingMessage message={message} />;
    case 'system':
      return <SystemMessage message={message} />;
    default:
      return null;
  }
}

// Compact one-line tool chip used in chat-mode rendering. Picks a short
// summary from the tool input (Bash command's first line, file name for
// Edit/Write/Read, query for Grep/Glob, etc.) so a turn with many tool
// calls reads as a list of bullets instead of a wall of expanded blocks.
//
// Click the chip to expand and reveal the full input + result/error JSON.
// Result/error come from extras on the ParsedMessage's toolInput (the
// CoS bubble's synthetic conversion stashes call.result/.error there
// because tool_result entries are suppressed in chat mode).
function ChatToolChip({ message }: { message: ParsedMessage }) {
  const [expanded, setExpanded] = useState(false);
  const name = message.toolName || 'tool';
  const cat = toolCategory(name);
  const icon = toolIcon(name);
  const summary = chatToolSummary(name, message.toolInput);
  const extras = (message.toolInput as Record<string, unknown> | undefined)?.__chatExtras as
    | { result?: unknown; error?: string }
    | undefined;
  const cleanInput = useMemo(() => {
    if (!message.toolInput) return null;
    const { __chatExtras, ...rest } = message.toolInput as Record<string, unknown>;
    return rest;
  }, [message.toolInput]);
  const hasInput = cleanInput && Object.keys(cleanInput).length > 0;
  const hasResult = extras && extras.result !== undefined && extras.result !== null;
  const hasError = !!extras?.error;
  const expandable = !!(hasInput || hasResult || hasError);

  return (
    <div
      class={`sm-chat-tool-chip ${cat}${expanded ? ' sm-chat-tool-chip-expanded' : ''}${hasError ? ' sm-chat-tool-chip-error' : ''}`}
      title={name}
    >
      <button
        type="button"
        class="sm-chat-tool-chip-header"
        onClick={expandable ? () => setExpanded((e) => !e) : undefined}
        disabled={!expandable}
      >
        <span class="sm-chat-tool-icon">{icon}</span>
        <span class="sm-chat-tool-name">{name}</span>
        {summary && <span class="sm-chat-tool-summary">{summary}</span>}
        {expandable && <span class="sm-chat-tool-toggle">{expanded ? '▾' : '▸'}</span>}
      </button>
      {expanded && (
        <div class="sm-chat-tool-body">
          {hasInput && (
            <div class="sm-chat-tool-section">
              <div class="sm-chat-tool-section-label">input</div>
              <pre class="sm-chat-tool-pre">{JSON.stringify(cleanInput, null, 2)}</pre>
            </div>
          )}
          {hasError && (
            <div class="sm-chat-tool-section">
              <div class="sm-chat-tool-section-label">error</div>
              <pre class="sm-chat-tool-pre">{extras!.error}</pre>
            </div>
          )}
          {!hasError && hasResult && (
            <div class="sm-chat-tool-section">
              <div class="sm-chat-tool-section-label">result</div>
              <pre class="sm-chat-tool-pre">{
                typeof extras!.result === 'string'
                  ? extras!.result
                  : JSON.stringify(extras!.result, null, 2)
              }</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function chatToolSummary(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command || '').split('\n')[0].trim();
      // Prefer the explicit description if the command is gnarly (curl,
      // long pipelines, etc) — otherwise show the command itself.
      const desc = String(input.description || '').trim();
      const display = cmd.length > 80 && desc ? desc : cmd;
      return display.length > 80 ? display.slice(0, 80) + '…' : display;
    }
    case 'Edit':
    case 'Write':
    case 'Read': {
      const path = String(input.file_path || '');
      return path ? shortenPath(path) : '';
    }
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    case 'WebFetch':
    case 'WebSearch':
      return String(input.url || input.query || '');
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate':
      return String(input.description || input.prompt || '').slice(0, 80);
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todo${input.todos.length === 1 ? '' : 's'}` : '';
    case 'AskUserQuestion':
      return String(input.question || '').slice(0, 80);
    default: {
      // Generic: show the first scalar input value (often a path/url/text).
      // Skip the chip's private extras bag.
      const firstVal = Object.entries(input)
        .find(([k, v]) => k !== '__chatExtras' && typeof v === 'string')?.[1];
      return typeof firstVal === 'string' ? firstVal.slice(0, 80) : '';
    }
  }
}

// --- Clickable file path ---

function ClickableFilePath({ path }: { path: string }) {
  return (
    <span
      class="sm-file-path sm-file-path-clickable"
      title={`${path}\nClick to open current file`}
      onClick={(e) => { e.stopPropagation(); openFileViewer(path); }}
    >
      {shortenPath(path)}
    </span>
  );
}

// Tool-specific category colors
function toolCategory(name: string): string {
  switch (name) {
    case 'Bash': return 'tool-bash';
    case 'Edit': return 'tool-edit';
    case 'Write': return 'tool-write';
    case 'Read': return 'tool-read';
    case 'Glob':
    case 'Grep': return 'tool-search';
    case 'TodoWrite': return 'tool-todo';
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet': return 'tool-task';
    case 'WebFetch':
    case 'WebSearch': return 'tool-web';
    case 'AskUserQuestion': return 'tool-ask';
    default: return 'tool-default';
  }
}

function toolIcon(name: string): string {
  switch (name) {
    case 'Bash': return '$';
    case 'Edit': return '✎';
    case 'Write': return '✏';
    case 'Read': return '📄';
    case 'Glob': return '🔍';
    case 'Grep': return '⌕';
    case 'TodoWrite': return '☑';
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet': return '⚙';
    case 'WebFetch': return '🌐';
    case 'WebSearch': return '🔎';
    case 'AskUserQuestion': return '❓';
    default: return '▶';
  }
}

function ToolUseMessage({ message, sessionId, interactive }: { message: ParsedMessage; sessionId?: string; interactive?: boolean }) {
  const { toolName, toolInput } = message;
  if (!toolName) return null;

  const cat = toolCategory(toolName);

  switch (toolName) {
    case 'Bash':
      return <BashToolUse toolInput={toolInput} cat={cat} />;
    case 'Edit':
      return <EditToolUse toolInput={toolInput} cat={cat} />;
    case 'Write':
      return <WriteToolUse toolInput={toolInput} cat={cat} />;
    case 'Read':
      return <ReadToolUse toolInput={toolInput} cat={cat} />;
    case 'Glob':
    case 'Grep':
      return <SearchToolUse toolName={toolName} toolInput={toolInput} cat={cat} />;
    case 'TodoWrite':
      return <TodoToolUse toolInput={toolInput} cat={cat} />;
    case 'WebSearch':
      return <WebSearchToolUse toolInput={toolInput} cat={cat} />;
    case 'WebFetch':
      return <WebFetchToolUse toolInput={toolInput} cat={cat} />;
    case 'AskUserQuestion':
      return <AskUserQuestionToolUse toolInput={toolInput} cat={cat} sessionId={sessionId} interactive={interactive} />;
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'Task':
      return <TaskToolUse toolName={toolName} toolInput={toolInput} cat={cat} />;
    default:
      return <GenericToolUse toolName={toolName} toolInput={toolInput} cat={cat} />;
  }
}

function BashToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const command = String(toolInput?.command || '');
  const description = toolInput?.description ? String(toolInput.description) : null;
  const timeout = toolInput?.timeout ? Number(toolInput.timeout) : null;
  const background = toolInput?.run_in_background === true || toolInput?.run_in_background === 'true';

  const cmdLines = command ? command.split('\n') : [];
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  // In a narrow pane, even a single long line wraps into a wall of text.
  // Collapse aggressively there; keep desktop permissive only when the
  // command clearly spans many lines or exceeds ~1K chars.
  const collapsible = narrow
    ? (cmdLines.length > 1 || command.length > 80)
    : (cmdLines.length > 12 || command.length > 1000);
  const [expanded, setExpanded] = useState(false);
  const previewLimit = narrow ? 80 : 200;
  const preview = collapsible && !expanded
    ? cmdLines[0].slice(0, previewLimit) + (cmdLines.length > 1 || cmdLines[0].length > previewLimit ? ' …' : '')
    : command;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div
        class="sm-tool-header"
        onClick={collapsible ? () => setExpanded(!expanded) : undefined}
        style={collapsible ? { cursor: 'pointer' } : undefined}
      >
        <span class="sm-tool-icon">$</span>
        <span class="sm-tool-name">Bash</span>
        {background && <span class="sm-tool-badge bg">background</span>}
        {timeout && <span class="sm-tool-badge">timeout: {Math.round(timeout / 1000)}s</span>}
        {collapsible && <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>}
        <span class="sm-tool-spacer" />
        {command && <CopyCommand text={command} title="Copy command" />}
      </div>
      {description && <div class="sm-tool-desc">{description}</div>}
      {command && (
        collapsible && !expanded
          ? <pre class="sm-bash-command sm-bash-command-preview">{preview}</pre>
          : <pre class="sm-bash-command">{command}</pre>
      )}
    </div>
  );
}

function EditToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const filePath = String(toolInput?.file_path || '');
  const oldStr = String(toolInput?.old_string || '');
  const newStr = String(toolInput?.new_string || '');
  const replaceAll = toolInput?.replace_all === true || toolInput?.replace_all === 'true';

  const diffLines = computeDiff(oldStr, newStr);
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  const collapsible = narrow ? diffLines.length > 4 : diffLines.length > 40;
  const [expanded, setExpanded] = useState(!collapsible);

  // Keep expand state in sync when viewport flips between mobile/desktop
  useEffect(() => { if (!collapsible) setExpanded(true); }, [collapsible]);

  let added = 0, removed = 0;
  for (const dl of diffLines) {
    if (dl.type === 'added') added++;
    else if (dl.type === 'removed') removed++;
  }

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div
        class="sm-tool-header"
        onClick={collapsible ? () => setExpanded(!expanded) : undefined}
        style={collapsible ? { cursor: 'pointer' } : undefined}
      >
        <span class="sm-tool-icon">✎</span>
        <span class="sm-tool-name">Edit</span>
        {replaceAll && <span class="sm-tool-badge">replace all</span>}
        <ClickableFilePath path={filePath} />
        {collapsible && (
          <span class="sm-diff-stats">
            {added > 0 && <span class="sm-diff-stat-add">+{added}</span>}
            {removed > 0 && <span class="sm-diff-stat-del">-{removed}</span>}
          </span>
        )}
        {collapsible && <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>}
      </div>
      {expanded && diffLines.length > 0 && (
        <div class="sm-diff-view">
          {diffLines.map((dl, i) => (
            <div key={i} class={`sm-diff-line sm-diff-${dl.type}`}>
              <span class="sm-diff-marker">{dl.type === 'removed' ? '-' : dl.type === 'added' ? '+' : ' '}</span>
              <span class="sm-diff-text">{dl.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WriteToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const filePath = String(toolInput?.file_path || '');
  const content = String(toolInput?.content || '');
  const lines = content.split('\n');
  const lang = getLangFromPath(filePath);
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  const collapsible = narrow ? lines.length > 3 : lines.length > 30;
  const [expanded, setExpanded] = useState(!collapsible);

  useEffect(() => { if (!collapsible) setExpanded(true); }, [collapsible]);

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div
        class="sm-tool-header"
        onClick={collapsible ? () => setExpanded(!expanded) : undefined}
        style={collapsible ? { cursor: 'pointer' } : undefined}
      >
        <span class="sm-tool-icon">✏</span>
        <span class="sm-tool-name">Write</span>
        <ClickableFilePath path={filePath} />
        <span class="sm-tool-badge">{lines.length} lines</span>
        {collapsible && <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>}
      </div>
      {expanded && <HighlightedCode content={content} lang={lang} maxLines={narrow ? 8 : 20} />}
    </div>
  );
}

function ReadToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const filePath = String(toolInput?.file_path || '');
  const offset = toolInput?.offset ? Number(toolInput.offset) : null;
  const limit = toolInput?.limit ? Number(toolInput.limit) : null;

  let rangeInfo = '';
  if (offset && limit) rangeInfo = `lines ${offset}-${offset + limit}`;
  else if (offset) rangeInfo = `from line ${offset}`;
  else if (limit) rangeInfo = `first ${limit} lines`;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">📄</span>
        <span class="sm-tool-name">Read</span>
        <ClickableFilePath path={filePath} />
        {rangeInfo && <span class="sm-tool-badge">{rangeInfo}</span>}
      </div>
    </div>
  );
}

function SearchToolUse({ toolName, toolInput, cat }: { toolName: string; toolInput?: Record<string, unknown>; cat: string }) {
  const pattern = String(toolInput?.pattern || '');
  const path = toolInput?.path ? String(toolInput.path) : null;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">{toolName === 'Glob' ? '🔍' : '⌕'}</span>
        <span class="sm-tool-name">{toolName}</span>
        <code class="sm-search-pattern">{pattern}</code>
        {path && <span class="sm-file-path">{shortenPath(path)}</span>}
      </div>
    </div>
  );
}

function TodoToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const todos = toolInput?.todos as Array<{ content: string; status: string }> | undefined;
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  const collapsible = narrow && !!todos && todos.length > 0;
  const [expanded, setExpanded] = useState(!collapsible);

  useEffect(() => { if (!collapsible) setExpanded(true); }, [collapsible]);

  let done = 0, inProgress = 0, pending = 0;
  if (todos) {
    for (const t of todos) {
      if (t.status === 'completed') done++;
      else if (t.status === 'in_progress') inProgress++;
      else pending++;
    }
  }
  const summary = todos && todos.length > 0
    ? `${todos.length} item${todos.length !== 1 ? 's' : ''} · ${done}✓ ${inProgress}→ ${pending}○`
    : null;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div
        class="sm-tool-header"
        onClick={collapsible ? () => setExpanded(!expanded) : undefined}
        style={collapsible ? { cursor: 'pointer' } : undefined}
      >
        <span class="sm-tool-icon">☑</span>
        <span class="sm-tool-name">TodoWrite</span>
        {collapsible && summary && <span class="sm-tool-badge">{summary}</span>}
        {collapsible && <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>}
      </div>
      {expanded && todos && todos.length > 0 && (
        <div class="sm-todo-list">
          {todos.map((t, i) => (
            <div key={i} class={`sm-todo-item sm-todo-${t.status}`}>
              <span class="sm-todo-status">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'}
              </span>
              <span>{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WebSearchToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const query = String(toolInput?.query || '');
  const allowed = toolInput?.allowed_domains as string[] | undefined;
  const blocked = toolInput?.blocked_domains as string[] | undefined;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">🔎</span>
        <span class="sm-tool-name">WebSearch</span>
      </div>
      <div class="sm-web-query">{query}</div>
      {(allowed?.length || blocked?.length) ? (
        <div class="sm-web-filters">
          {allowed?.map((d, i) => <span key={`a${i}`} class="sm-web-filter-badge allow">+{d}</span>)}
          {blocked?.map((d, i) => <span key={`b${i}`} class="sm-web-filter-badge block">-{d}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function WebFetchToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const url = String(toolInput?.url || '');
  const prompt = toolInput?.prompt ? String(toolInput.prompt) : null;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">🌐</span>
        <span class="sm-tool-name">WebFetch</span>
      </div>
      <a class="sm-web-url" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
      {prompt && <div class="sm-tool-desc">{prompt}</div>}
    </div>
  );
}

function AskUserQuestionToolUse({ toolInput, cat, sessionId, interactive }: { toolInput?: Record<string, unknown>; cat: string; sessionId?: string; interactive?: boolean }) {
  const questions = toolInput?.questions as Question[] | undefined;
  const answers = toolInput?.answers as Record<string, string> | undefined;
  const hasAnswers = answers && Object.keys(answers).length > 0;

  // When session is waiting and no answers yet, render the interactive card.
  if (interactive && sessionId && questions && questions.length > 0 && !hasAnswers) {
    return (
      <div class={`sm-message sm-tool-use ${cat}`}>
        <AskUserQuestionPrompt sessionId={sessionId} questions={questions} />
      </div>
    );
  }

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">❓</span>
        <span class="sm-tool-name">AskUserQuestion</span>
        {questions && <span class="sm-tool-badge">{questions.length} question{questions.length !== 1 ? 's' : ''}</span>}
      </div>
      {questions?.map((q, qi) => (
        <div key={qi} class="sm-question-card">
          {q.header && <span class="sm-question-badge">{q.header}</span>}
          {q.multiSelect && <span class="sm-tool-badge">multi-select</span>}
          <div class="sm-question-text">{q.question}</div>
          {q.options && (
            <div class="sm-question-options">
              {q.options.map((opt, oi) => {
                const selected = answers?.[q.question]?.split(',').map(s => s.trim()).includes(opt.label);
                return (
                  <div key={oi} class={`sm-question-option ${selected ? 'selected' : ''}`}>
                    <span class="sm-option-icon">{selected ? '●' : '○'}</span>
                    <div>
                      <span class="sm-option-label">{opt.label}</span>
                      {opt.description && <span class="sm-option-desc">{opt.description}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TaskToolUse({ toolName, toolInput, cat }: { toolName: string; toolInput?: Record<string, unknown>; cat: string }) {
  const [expanded, setExpanded] = useState(false);

  const taskId = toolInput?.taskId as string | undefined;
  const subject = toolInput?.subject as string | undefined;
  const status = toolInput?.status as string | undefined;
  const description = toolInput?.description as string | undefined;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        <span class="sm-tool-icon">⚙</span>
        <span class="sm-tool-name">{toolName}</span>
        {taskId && <span class="sm-task-id">#{taskId}</span>}
        {status && <span class={`sm-task-status sm-task-status-${status}`}>{status}</span>}
        <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>
      </div>
      {subject && <div class="sm-task-subject">{subject}</div>}
      {expanded && description && <div class="sm-task-desc">{description}</div>}
      {expanded && toolInput && !description && (
        <pre class="sm-tool-summary">{JSON.stringify(toolInput, null, 2)}</pre>
      )}
    </div>
  );
}

// Parse MCP tool names like mcp__Gmail__send_email → { provider: 'Gmail', action: 'send_email' }
function parseMcpToolName(name: string): { provider: string; action: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const parts = name.split('__');
  // parts[0] = 'mcp', parts[1] = provider (possibly multi-segment), last = action
  if (parts.length < 3) return null;
  const action = parts[parts.length - 1];
  const provider = parts.slice(1, parts.length - 1).join(' ');
  return { provider, action };
}

// Build a short 1–2 key inline summary from toolInput
function buildInputSummary(toolInput: Record<string, unknown>): string {
  const MAX_LEN = 40;
  const entries = Object.entries(toolInput).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 2).map(([k, v]) => {
    const val = String(v);
    const truncated = val.length > MAX_LEN ? val.slice(0, MAX_LEN) + '…' : val;
    return `${k}: "${truncated}"`;
  });
  return parts.join(', ');
}

// Render a single value inline or as a collapsible sub-block
function KvValue({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === null || value === undefined) {
    return <span class="sm-kv-null">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span class="sm-kv-bool">{String(value)}</span>;
  }
  if (typeof value === 'number') {
    return <span class="sm-kv-number">{String(value)}</span>;
  }
  if (typeof value === 'string') {
    const display = value.length > 200 ? value.slice(0, 200) + '…' : value;
    return <span class="sm-kv-string">"{display}"</span>;
  }
  // Object or array — collapsible sub-block
  const label = Array.isArray(value) ? `[${(value as unknown[]).length} items]` : `{${Object.keys(value as object).length} keys}`;
  return (
    <span class="sm-kv-complex">
      <span class="sm-kv-toggle" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{open ? '▾' : '▸'} {label}</span>
      {open && <pre class="sm-kv-subblock">{JSON.stringify(value, null, 2)}</pre>}
    </span>
  );
}

function GenericToolUse({ toolName, toolInput, cat }: { toolName: string; toolInput?: Record<string, unknown>; cat: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasInput = toolInput && Object.keys(toolInput).length > 0;

  const mcp = parseMcpToolName(toolName);
  const icon = mcp ? '🔌' : toolIcon(toolName);
  const displayName = mcp ? `${mcp.provider} → ${mcp.action}` : toolName;
  const summary = hasInput ? buildInputSummary(toolInput!) : '';

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header" onClick={() => hasInput && setExpanded(!expanded)} style={hasInput ? { cursor: 'pointer' } : undefined}>
        <span class="sm-tool-icon">{icon}</span>
        <span class="sm-tool-name">{displayName}</span>
        {summary && !expanded && <span class="sm-tool-inline-summary">{summary}</span>}
        {hasInput && <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>}
      </div>
      {expanded && hasInput && (
        <div class="sm-kv-list">
          {Object.entries(toolInput!).map(([k, v]) => (
            <div key={k} class="sm-kv-row">
              <span class="sm-kv-key">{k}:</span>
              <span class="sm-kv-val"><KvValue value={v} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Tool Result with syntax highlighting ---

function extractImageUrls(content: string): string[] {
  const urls: string[] = [];
  const b64re = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g;
  let m;
  while ((m = b64re.exec(content)) !== null) urls.push(m[0]);
  const urlre = /https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)/gi;
  while ((m = urlre.exec(content)) !== null) urls.push(m[0]);
  return urls;
}

function stripLineNumbers(content: string): string {
  // Read tool output has format "   123→content" — strip the line number prefix
  const lines = content.split('\n');
  const hasLineNums = lines.length > 1 && lines.slice(0, 5).every(l => !l.trim() || /^\s*\d+→/.test(l));
  if (!hasLineNums) return content;
  return lines.map(l => l.replace(/^\s*\d+→/, '')).join('\n');
}

function ToolResultMessage({ message, prevToolUse }: { message: ParsedMessage; prevToolUse?: ParsedMessage }) {
  const isError = message.isError;
  const content = message.content;
  const lines = content.split('\n');
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  const longLineThreshold = narrow ? 4 : 12;
  const longCharThreshold = narrow ? 160 : 400;
  const previewLineCount = narrow ? 2 : 8;
  const isLong = lines.length > longLineThreshold || content.length > longCharThreshold;
  const [expanded, setExpanded] = useState(!isLong);
  const [viewMode, setViewMode] = useState<'raw' | 'highlighted' | 'markdown'>('highlighted');

  const imageUrls = extractImageUrls(content);
  const displayContent = expanded
    ? content
    : lines.slice(0, previewLineCount).join('\n') + (lines.length > previewLineCount ? '\n...' : '');

  // Detect language from preceding tool use
  const filePath = prevToolUse?.toolInput?.file_path as string | undefined;
  const toolName = prevToolUse?.toolName;
  const ext = filePath ? getFileExt(filePath) : '';
  const lang = filePath ? getLangFromPath(filePath) : undefined;
  const isImageFile = IMAGE_EXTS.has(ext);
  const isMarkdownFile = MARKDOWN_EXTS.has(ext);
  const isFileContent = toolName === 'Read' || toolName === 'Write';

  // For file content results, use syntax highlighting or markdown rendering
  const showHighlighted = !isError && isFileContent && !isImageFile && viewMode !== 'raw';
  const showMarkdown = showHighlighted && isMarkdownFile && viewMode === 'markdown';

  const cleanContent = useMemo(() => {
    if (!showHighlighted) return displayContent;
    return stripLineNumbers(expanded ? content : displayContent);
  }, [showHighlighted, displayContent, content, expanded]);

  return (
    <div class={`sm-message sm-tool-result ${isError ? 'sm-error' : ''}`}>
      <div class="sm-result-header" onClick={() => setExpanded(!expanded)}>
        <span class="sm-result-indicator">{expanded ? '▾' : '▸'}</span>
        <span class="sm-result-label">{isError ? 'Error' : 'Output'}</span>
        <span class="sm-result-meta">{lines.length} line{lines.length !== 1 ? 's' : ''}</span>
        {isFileContent && !isError && (
          <div class="sm-result-view-toggle" onClick={(e) => e.stopPropagation()}>
            <button
              class={`sm-view-btn ${viewMode === 'highlighted' ? 'active' : ''}`}
              onClick={() => setViewMode('highlighted')}
              title="Syntax highlighted"
            >Code</button>
            {isMarkdownFile && (
              <button
                class={`sm-view-btn ${viewMode === 'markdown' ? 'active' : ''}`}
                onClick={() => setViewMode('markdown')}
                title="Rendered markdown"
              >MD</button>
            )}
            <button
              class={`sm-view-btn ${viewMode === 'raw' ? 'active' : ''}`}
              onClick={() => setViewMode('raw')}
              title="Raw text"
            >Raw</button>
          </div>
        )}
      </div>
      {imageUrls.length > 0 && (
        <div class="sm-result-images">
          {imageUrls.map((url, i) => <ImageViewer key={i} src={url} />)}
        </div>
      )}
      {showMarkdown && expanded ? (
        <div class="sm-result-markdown">{renderMarkdown(cleanContent)}</div>
      ) : showHighlighted && (expanded || !isLong) ? (
        <HighlightedCode content={cleanContent} lang={lang} />
      ) : (expanded || !isLong) ? (
        <pre class="sm-result-content">{displayContent}</pre>
      ) : (
        <pre class="sm-result-content sm-result-truncated">{displayContent}</pre>
      )}
    </div>
  );
}

function ImageViewer({ src }: { src: string }) {
  const [lightbox, setLightbox] = useState(false);

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

  return (
    <>
      <img
        class="sm-image-thumb"
        src={src}
        alt="Image content"
        onClick={() => setLightbox(true)}
      />
      {lightbox && (
        <div class="sm-lightbox" onClick={() => setLightbox(false)}>
          <div class="sm-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img src={src} alt="Image content (full)" />
            <button class="sm-lightbox-close" onClick={() => setLightbox(false)}>&times;</button>
          </div>
        </div>
      )}
    </>
  );
}

function AssistantMessage({ message }: { message: ParsedMessage }) {
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  const content = message.content || '';
  const lines = content.split('\n');
  const longChars = narrow ? 360 : 1200;
  const longLines = narrow ? 6 : 20;
  const long = content.length > longChars || lines.length > longLines;
  const [expanded, setExpanded] = useState(!long);
  useEffect(() => { if (!long) setExpanded(true); }, [long]);

  if (!long) {
    return (
      <div class="sm-message sm-assistant">
        <div class="sm-assistant-content">{renderMarkdown(content)}</div>
      </div>
    );
  }

  const preview = lines.slice(0, narrow ? 2 : 6).join('\n');
  return (
    <div class="sm-message sm-assistant">
      <div class="sm-assistant-content">
        {expanded ? renderMarkdown(content) : renderMarkdown(preview + '\n\n…')}
      </div>
      <button class="sm-msg-toggle" onClick={() => setExpanded((e) => !e)}>
        {expanded ? '▾ Show less' : `▸ Show full message (${lines.length} lines)`}
      </button>
    </div>
  );
}

function ThinkingMessage({ message }: { message: ParsedMessage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="sm-message sm-thinking">
      <div class="sm-thinking-header" onClick={() => setExpanded(!expanded)}>
        <span class="sm-thinking-icon">💭</span>
        <span class="sm-thinking-label">Thinking</span>
        <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div class="sm-thinking-content">{renderMarkdown(message.content)}</div>
      )}
    </div>
  );
}

function UserInputMessage({ message }: { message: ParsedMessage }) {
  const containerNarrow = useNarrow(); const narrow = isMobile.value || containerNarrow;
  const content = message.content || '';
  const lines = content.split('\n');
  const longChars = narrow ? 280 : 800;
  const longLines = narrow ? 5 : 14;
  const long = content.length > longChars || lines.length > longLines;
  const [expanded, setExpanded] = useState(!long);
  useEffect(() => { if (!long) setExpanded(true); }, [long]);

  if (!long) {
    return (
      <div class="sm-message sm-user-input">
        <div class="sm-user-bubble">{content}</div>
      </div>
    );
  }

  const previewLines = lines.slice(0, narrow ? 2 : 4);
  return (
    <div class="sm-message sm-user-input">
      <div class={`sm-user-bubble${expanded ? '' : ' sm-user-bubble-preview'}`}>
        {expanded ? content : previewLines.join('\n') + (lines.length > previewLines.length ? ' …' : '')}
      </div>
      <button class="sm-msg-toggle" onClick={() => setExpanded((e) => !e)}>
        {expanded ? '▾ Show less' : `▸ Show full prompt (${lines.length} lines)`}
      </button>
    </div>
  );
}

function SystemMessage({ message }: { message: ParsedMessage }) {
  return (
    <div class="sm-message sm-system">
      <span class="sm-system-text">{message.content}</span>
    </div>
  );
}

// --- Utilities ---

function shortenPath(p: string): string {
  if (p.length <= 50) return p;
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-3).join('/');
}

interface DiffLine {
  type: 'context' | 'removed' | 'added';
  text: string;
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  if (!oldStr && !newStr) return [];
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m, j = n;
  const stack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'context', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'added', text: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: 'removed', text: oldLines[i - 1] });
      i--;
    }
  }

  stack.reverse();

  const hasChanges = stack.some(l => l.type !== 'context');
  if (!hasChanges) return [];

  for (let k = 0; k < stack.length; k++) {
    const line = stack[k];
    if (line.type !== 'context') {
      result.push(line);
    } else {
      const nearChange = stack.slice(Math.max(0, k - 3), k).some(l => l.type !== 'context') ||
                         stack.slice(k + 1, k + 4).some(l => l.type !== 'context');
      if (nearChange) {
        result.push(line);
      } else if (result.length > 0 && result[result.length - 1].type !== 'context') {
        result.push({ type: 'context', text: '···' });
      }
    }
  }

  return result;
}
