import { useState, useEffect, useMemo } from 'preact/hooks';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import type { ParsedMessage } from '../lib/output-parser.js';
import { openFileViewer } from '../lib/file-viewer.js';

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

function highlightCode(content: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value;
    }
    return hljs.highlightAuto(content).value;
  } catch {
    return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

interface Props {
  message: ParsedMessage;
  messages?: ParsedMessage[];
  index?: number;
}

function findPrecedingToolUse(messages: ParsedMessage[], index: number): ParsedMessage | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role === 'tool_use') return messages[i];
    if (messages[i].role !== 'tool_result') break;
  }
  return undefined;
}

export function MessageRenderer({ message, messages, index }: Props) {
  const prevToolUse = (message.role === 'tool_result' && messages && index !== undefined)
    ? findPrecedingToolUse(messages, index)
    : undefined;

  switch (message.role) {
    case 'tool_use':
      return <ToolUseMessage message={message} />;
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

function ToolUseMessage({ message }: { message: ParsedMessage }) {
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
      return <AskUserQuestionToolUse toolInput={toolInput} cat={cat} />;
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

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">$</span>
        <span class="sm-tool-name">Bash</span>
        {background && <span class="sm-tool-badge bg">background</span>}
        {timeout && <span class="sm-tool-badge">timeout: {Math.round(timeout / 1000)}s</span>}
      </div>
      {description && <div class="sm-tool-desc">{description}</div>}
      <pre class="sm-bash-command">{command}</pre>
    </div>
  );
}

function EditToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const filePath = String(toolInput?.file_path || '');
  const oldStr = String(toolInput?.old_string || '');
  const newStr = String(toolInput?.new_string || '');
  const replaceAll = toolInput?.replace_all === true || toolInput?.replace_all === 'true';

  const diffLines = computeDiff(oldStr, newStr);

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">✎</span>
        <span class="sm-tool-name">Edit</span>
        {replaceAll && <span class="sm-tool-badge">replace all</span>}
        <ClickableFilePath path={filePath} />
      </div>
      {diffLines.length > 0 && (
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

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">✏</span>
        <span class="sm-tool-name">Write</span>
        <ClickableFilePath path={filePath} />
        <span class="sm-tool-badge">{lines.length} lines</span>
      </div>
      <HighlightedCode content={content} lang={lang} maxLines={20} />
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

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header">
        <span class="sm-tool-icon">☑</span>
        <span class="sm-tool-name">TodoWrite</span>
      </div>
      {todos && todos.length > 0 && (
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

function AskUserQuestionToolUse({ toolInput, cat }: { toolInput?: Record<string, unknown>; cat: string }) {
  const questions = toolInput?.questions as Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }> | undefined;
  const answers = toolInput?.answers as Record<string, string> | undefined;

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

function GenericToolUse({ toolName, toolInput, cat }: { toolName: string; toolInput?: Record<string, unknown>; cat: string }) {
  const icon = toolIcon(toolName);
  const [expanded, setExpanded] = useState(false);
  const hasInput = toolInput && Object.keys(toolInput).length > 0;

  return (
    <div class={`sm-message sm-tool-use ${cat}`}>
      <div class="sm-tool-header" onClick={() => hasInput && setExpanded(!expanded)} style={hasInput ? { cursor: 'pointer' } : undefined}>
        <span class="sm-tool-icon">{icon}</span>
        <span class="sm-tool-name">{toolName}</span>
        {hasInput && <span class="sm-expand-indicator">{expanded ? '▾' : '▸'}</span>}
      </div>
      {expanded && hasInput && (
        <pre class="sm-tool-summary">{JSON.stringify(toolInput, null, 2)}</pre>
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
  const isLong = lines.length > 15 || content.length > 500;
  const [expanded, setExpanded] = useState(!isLong);
  const [viewMode, setViewMode] = useState<'raw' | 'highlighted' | 'markdown'>('highlighted');

  const imageUrls = extractImageUrls(content);
  const displayContent = expanded ? content : lines.slice(0, 10).join('\n') + (lines.length > 10 ? '\n...' : '');

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
  return (
    <div class="sm-message sm-assistant">
      <div class="sm-assistant-content">{renderMarkdown(message.content)}</div>
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
  return (
    <div class="sm-message sm-user-input">
      <div class="sm-user-bubble">{message.content}</div>
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
