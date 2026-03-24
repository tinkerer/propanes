# Claude Code Portal - Message Rendering Analysis

A comprehensive guide to adapting claude-code-portal's structured message rendering for Preact/TSX.

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Message Grouping Logic](#message-grouping-logic)
3. [Tool-Specific Renderers](#tool-specific-renderers)
4. [Diff Algorithm (LCS)](#diff-algorithm-lcs)
5. [Markdown Rendering](#markdown-rendering)
6. [Color Scheme & Visual Hierarchy](#color-scheme--visual-hierarchy)
7. [CSS Patterns](#css-patterns)
8. [Preact/TSX Adaptation Patterns](#preacttsx-adaptation-patterns)

---

## Architecture Overview

### Core Components Structure

```
message_renderer.rs          # Main message dispatcher & grouping
├── tool_renderers/
│   ├── mod.rs              # Tool routing
│   ├── bash.rs             # Bash command renderer
│   ├── edit.rs             # Edit & Write tools
│   ├── search.rs           # Glob, Grep, WebFetch, WebSearch
│   ├── interactive.rs      # TodoWrite, AskUserQuestion
│   └── task.rs             # Task/Agent renderer
├── diff.rs                 # LCS-based diff algorithm
└── markdown.rs             # pulldown-cmark wrapper
```

### Message Type Hierarchy

```typescript
// Adapt this to Preact
type ClaudeMessage = 
  | { type: 'system', ... }
  | { type: 'assistant', message: { content: ContentBlock[] } }
  | { type: 'user', message: { content: ContentBlock[] } }
  | { type: 'result', ... }
  | { type: 'error', ... }
  | { type: 'portal', ... }
  | { type: 'rate_limit_event', ... }

type ContentBlock = 
  | { type: 'text', text: string }
  | { type: 'tool_use', name: string, input: object }
  | { type: 'tool_result', content: ToolResultContent, is_error: boolean }
  | { type: 'image', source: ImageSource }
  | { type: 'thinking', thinking: string }
```

---

## Message Grouping Logic

### Key Pattern: Consecutive Assistant Messages

The portal **groups consecutive assistant messages** and their **tool results** together to reduce visual clutter:

```rust
// From message_renderer.rs, lines 23-42
fn should_group_with_assistant(json: &str) -> bool {
    match serde_json::from_str::<ClaudeMessage>(json) {
        Ok(ClaudeMessage::Assistant(_)) => true,
        Ok(ClaudeMessage::User(msg)) => {
            // Tool results are user messages with ONLY tool_result blocks
            if msg.content.is_some() { return false; }
            if let Some(message) = &msg.message {
                if let Some(blocks) = &message.content {
                    return !blocks.is_empty() && blocks.iter()
                        .all(|b| matches!(b, ContentBlock::ToolResult { .. }));
                }
            }
            false
        }
        _ => false,
    }
}
```

### Grouping Algorithm

```rust
// From message_renderer.rs, lines 45-67
pub fn group_messages(messages: &[String]) -> Vec<MessageGroup> {
    let mut groups = Vec::new();
    let mut current_assistant_group: Vec<String> = Vec::new();

    for json in messages {
        if should_group_with_assistant(json) {
            current_assistant_group.push(json.clone());
        } else {
            if !current_assistant_group.is_empty() {
                groups.push(MessageGroup::AssistantGroup(
                    std::mem::take(&mut current_assistant_group)
                ));
            }
            groups.push(MessageGroup::Single(json.clone()));
        }
    }

    if !current_assistant_group.is_empty() {
        groups.push(MessageGroup::AssistantGroup(current_assistant_group));
    }
    groups
}
```

### Preact Adaptation

```tsx
type MessageGroup = 
  | { type: 'single', message: string }
  | { type: 'assistant_group', messages: string[] };

function shouldGroupWithAssistant(json: string): boolean {
  try {
    const msg = JSON.parse(json);
    
    // Assistant messages always group
    if (msg.type === 'assistant') return true;
    
    // User messages with ONLY tool_result blocks group
    if (msg.type === 'user') {
      if (msg.content) return false; // Has text content
      const blocks = msg.message?.content || [];
      return blocks.length > 0 && 
        blocks.every((b: any) => b.type === 'tool_result');
    }
    
    return false;
  } catch {
    return false;
  }
}

export function groupMessages(messages: string[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: string[] = [];
  
  for (const json of messages) {
    if (shouldGroupWithAssistant(json)) {
      currentGroup.push(json);
    } else {
      if (currentGroup.length > 0) {
        groups.push({ type: 'assistant_group', messages: currentGroup });
        currentGroup = [];
      }
      groups.push({ type: 'single', message: json });
    }
  }
  
  if (currentGroup.length > 0) {
    groups.push({ type: 'assistant_group', messages: currentGroup });
  }
  
  return groups;
}
```

---

## Tool-Specific Renderers

### Tool Routing

```typescript
// Adapted from tool_renderers/mod.rs
function renderToolUse(name: string, input: any): JSX.Element {
  switch (name) {
    case 'Edit': return <EditTool input={input} />;
    case 'Write': return <WriteTool input={input} />;
    case 'Bash': return <BashTool input={input} />;
    case 'Read': return <ReadTool input={input} />;
    case 'Glob': return <GlobTool input={input} />;
    case 'Grep': return <GrepTool input={input} />;
    case 'TodoWrite': return <TodoWriteTool input={input} />;
    case 'AskUserQuestion': return <AskUserQuestionTool input={input} />;
    case 'Task': return <TaskTool input={input} />;
    case 'WebFetch': return <WebFetchTool input={input} />;
    case 'WebSearch': return <WebSearchTool input={input} />;
    default: return <GenericTool name={name} input={input} />;
  }
}
```

### 1. Bash Tool

```tsx
// Adapted from tool_renderers/bash.rs
interface BashToolProps {
  input: {
    command: string;
    description?: string;
    timeout?: number;
    run_in_background?: boolean;
  };
}

function BashTool({ input }: BashToolProps) {
  const { command, description, timeout, run_in_background } = input;
  
  return (
    <div class="tool-use bash-tool">
      <div class="tool-use-header">
        <span class="tool-icon">$</span>
        <span class="tool-name">Bash</span>
        <code class="bash-command-inline">{command}</code>
        <span class="tool-header-spacer"></span>
        {run_in_background && (
          <span class="tool-badge background">background</span>
        )}
        {timeout && (
          <span class="tool-meta timeout">timeout={formatDuration(timeout)}</span>
        )}
      </div>
      {description && (
        <div class="bash-description">{description}</div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
```

### 2. Edit Tool (with Diff)

```tsx
// Adapted from tool_renderers/edit.rs
interface EditToolProps {
  input: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  };
}

function EditTool({ input }: EditToolProps) {
  const { file_path, old_string, new_string, replace_all } = input;
  
  return (
    <div class="tool-use edit-tool">
      <div class="tool-use-header">
        <span class="tool-icon">✏️</span>
        <span class="tool-name">Edit</span>
        <span class="edit-file-path">{file_path}</span>
        {replace_all && (
          <span class="edit-replace-all">(replace all)</span>
        )}
      </div>
      <div class="diff-container">
        <DiffView oldText={old_string} newText={new_string} />
      </div>
    </div>
  );
}
```

### 3. Write Tool (with Line Numbers)

```tsx
// Adapted from tool_renderers/edit.rs, lines 47-93
interface WriteToolProps {
  input: {
    file_path: string;
    content: string;
  };
}

function WriteTool({ input }: WriteToolProps) {
  const { file_path, content } = input;
  const lines = content.split('\n');
  const previewLines = lines.slice(0, 20);
  const truncated = lines.length > 20;
  
  return (
    <div class="tool-use write-tool">
      <div class="tool-use-header">
        <span class="tool-icon">📝</span>
        <span class="tool-name">Write</span>
        <span class="write-file-path">{file_path}</span>
        <span class="write-size">
          ({lines.length} lines, {content.length} bytes)
        </span>
      </div>
      <div class="write-preview">
        <pre class="write-content">
          {previewLines.map((line, i) => (
            <div key={i} class="write-line">
              <span class="line-number">{String(i + 1).padStart(4)}</span>
              <span class="line-content">{line}</span>
            </div>
          ))}
          {truncated && (
            <div class="write-truncated">
              ... {lines.length - 20} more lines
            </div>
          )}
        </pre>
      </div>
    </div>
  );
}
```

### 4. Read Tool

```tsx
// Adapted from tool_renderers/mod.rs, lines 41-72
interface ReadToolProps {
  input: {
    file_path: string;
    offset?: number;
    limit?: number;
  };
}

function ReadTool({ input }: ReadToolProps) {
  const { file_path, offset, limit } = input;
  
  const rangeInfo = offset !== undefined && limit !== undefined
    ? `lines ${offset}-${offset + limit}`
    : offset !== undefined
    ? `from line ${offset}`
    : limit !== undefined
    ? `first ${limit} lines`
    : null;
  
  return (
    <div class="tool-use read-tool">
      <div class="tool-use-header">
        <span class="tool-icon">📖</span>
        <span class="tool-name">Read</span>
        <span class="read-file-path">{file_path}</span>
        {rangeInfo && <span class="tool-meta">{rangeInfo}</span>}
      </div>
    </div>
  );
}
```

### 5. Search Tools (Glob, Grep)

```tsx
// Adapted from tool_renderers/search.rs
function GlobTool({ input }: { input: { pattern: string; path?: string } }) {
  return (
    <div class="tool-use glob-tool">
      <div class="tool-use-header">
        <span class="tool-icon">🔍</span>
        <span class="tool-name">Glob</span>
        <code class="glob-pattern-inline">{input.pattern}</code>
        {input.path && <span class="tool-meta">in {input.path}</span>}
      </div>
    </div>
  );
}

function GrepTool({ input }: { 
  input: { 
    pattern: string; 
    path?: string; 
    glob?: string;
    type?: string;
    '-i'?: boolean;
  } 
}) {
  const hasOptions = input.glob || input.type;
  
  return (
    <div class="tool-use grep-tool">
      <div class="tool-use-header">
        <span class="tool-icon">🔎</span>
        <span class="tool-name">Grep</span>
        <code class="grep-pattern-inline">/{input.pattern}/</code>
        {input['-i'] && <span class="tool-badge">-i</span>}
        {input.path && <span class="tool-meta">in {input.path}</span>}
      </div>
      {hasOptions && (
        <div class="grep-options">
          {input.glob && <span class="grep-option">--glob={input.glob}</span>}
          {input.type && <span class="grep-option">--type={input.type}</span>}
        </div>
      )}
    </div>
  );
}
```

### 6. TodoWrite Tool

```tsx
// Adapted from tool_renderers/interactive.rs, lines 4-39
interface Todo {
  status: 'pending' | 'in_progress' | 'completed';
  content: string;
  activeForm?: string;
}

function TodoWriteTool({ input }: { input: { todos: Todo[] } }) {
  const getIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '→';
      default: return '○';
    }
  };
  
  return (
    <div class="tool-use todowrite-tool">
      <div class="tool-use-header">
        <span class="tool-icon">📋</span>
        <span class="tool-name">TodoWrite</span>
        <span class="tool-meta">({input.todos.length} items)</span>
      </div>
      <div class="todo-list">
        {input.todos.map((todo, i) => (
          <div key={i} class={`todo-item ${todo.status}`}>
            <span class="todo-status">{getIcon(todo.status)}</span>
            <span class="todo-content">{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 7. AskUserQuestion Tool

```tsx
// Adapted from tool_renderers/interactive.rs, lines 41-142
interface Question {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{
    label: string;
    description?: string;
  }>;
}

function AskUserQuestionTool({ 
  input 
}: { 
  input: { 
    questions: Question[]; 
    answers?: Record<string, string>;
  } 
}) {
  return (
    <div class="tool-use askuserquestion-tool">
      <div class="tool-use-header">
        <span class="tool-icon">❓</span>
        <span class="tool-name">AskUserQuestion</span>
        <span class="tool-meta">
          ({input.questions.length} question{input.questions.length === 1 ? '' : 's'})
        </span>
      </div>
      <div class="question-list">
        {input.questions.map((q, i) => (
          <QuestionCard 
            key={i} 
            question={q} 
            answer={input.answers?.[q.question]} 
          />
        ))}
      </div>
    </div>
  );
}

function QuestionCard({ 
  question, 
  answer 
}: { 
  question: Question; 
  answer?: string;
}) {
  const isSelected = (label: string) => 
    answer?.split(',').map(s => s.trim()).includes(label) ?? false;
  
  return (
    <div class="question-card">
      <div class="question-header">
        {question.header && (
          <span class="question-badge">{question.header}</span>
        )}
        {question.multiSelect && (
          <span class="multi-select-badge">multi-select</span>
        )}
      </div>
      <div class="question-text">{question.question}</div>
      <div class="question-options">
        {question.options.map((opt, i) => {
          const selected = isSelected(opt.label);
          const icon = selected
            ? (question.multiSelect ? '☑' : '●')
            : (question.multiSelect ? '☐' : '○');
          
          return (
            <div key={i} class={`option-item ${selected ? 'selected' : ''}`}>
              <span class="option-icon">{icon}</span>
              <div class="option-content">
                <span class="option-label">{opt.label}</span>
                {opt.description && (
                  <span class="option-description">{opt.description}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {answer && (
        <div class="question-answer">
          <span class="answer-label">Answer: </span>
          <span class="answer-value">{answer}</span>
        </div>
      )}
    </div>
  );
}
```

---

## Diff Algorithm (LCS)

### Line-Based Diff with Longest Common Subsequence

```tsx
// Adapted from diff.rs
type DiffLine = 
  | { type: 'context', line: string }
  | { type: 'removed', line: string }
  | { type: 'added', line: string };

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff = computeLineDiff(oldLines, newLines);
  
  return (
    <div class="diff-view">
      {diff.map((change, i) => {
        const marker = change.type === 'context' ? ' ' 
          : change.type === 'removed' ? '-' 
          : '+';
        
        return (
          <div key={i} class={`diff-line ${change.type}`}>
            <span class="diff-marker">{marker}</span>
            <span class="diff-content">{change.line}</span>
          </div>
        );
      })}
    </div>
  );
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const lcs = longestCommonSubsequence(oldLines, newLines);
  const result: DiffLine[] = [];
  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;
  
  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length) {
      const [lcsOld, lcsNew] = lcs[lcsIdx];
      
      // Add removed lines before common line
      while (oldIdx < lcsOld) {
        result.push({ type: 'removed', line: oldLines[oldIdx] });
        oldIdx++;
      }
      
      // Add added lines before common line
      while (newIdx < lcsNew) {
        result.push({ type: 'added', line: newLines[newIdx] });
        newIdx++;
      }
      
      // Add common line
      result.push({ type: 'context', line: oldLines[oldIdx] });
      oldIdx++;
      newIdx++;
      lcsIdx++;
    } else {
      // No more common lines, add remaining as removed/added
      while (oldIdx < oldLines.length) {
        result.push({ type: 'removed', line: oldLines[oldIdx] });
        oldIdx++;
      }
      while (newIdx < newLines.length) {
        result.push({ type: 'added', line: newLines[newIdx] });
        newIdx++;
      }
    }
  }
  
  return result;
}

function longestCommonSubsequence(
  old: string[], 
  newArr: string[]
): Array<[number, number]> {
  const m = old.length;
  const n = newArr.length;
  
  if (m === 0 || n === 0) return [];
  
  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => 
    Array(n + 1).fill(0)
  );
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (old[i - 1] === newArr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  // Backtrack to find LCS indices
  const result: Array<[number, number]> = [];
  let i = m;
  let j = n;
  
  while (i > 0 && j > 0) {
    if (old[i - 1] === newArr[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  
  result.reverse();
  return result;
}
```

---

## Markdown Rendering

### Using `marked` or `react-markdown` in Preact

```tsx
// Adapted from markdown.rs
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked options
marked.setOptions({
  gfm: true,            // GitHub Flavored Markdown
  breaks: false,        // Don't convert \n to <br>
  headerIds: false,
  mangle: false,
});

function renderMarkdown(text: string): JSX.Element {
  // Linkify plain URLs before markdown parsing
  const linkedText = linkifyUrls(text);
  
  // Parse markdown
  const rawHtml = marked.parse(linkedText);
  
  // Sanitize HTML to prevent XSS
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 
      'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 
      'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 
      'tr', 'th', 'td', 'hr', 'img'
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'title', 'style'],
  });
  
  return <div dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}

// Auto-linkify URLs (adapted from markdown.rs lines 334-400)
function linkifyUrls(text: string): string {
  const urlRegex = /(https?:\/\/[^\s<>"]+[a-zA-Z0-9/_])/g;
  return text.replace(urlRegex, (url) => {
    // Trim trailing punctuation
    let cleanUrl = url.replace(/[.,;:!?]+$/, '');
    
    // Balance parentheses (for Wikipedia-style URLs)
    const openParens = (cleanUrl.match(/\(/g) || []).length;
    const closeParens = (cleanUrl.match(/\)/g) || []).length;
    if (closeParens > openParens) {
      cleanUrl = cleanUrl.replace(/\)+$/, '');
    }
    
    return `[${cleanUrl}](${cleanUrl})`;
  });
}
```

### Alternative: Component-Based Markdown (No `dangerouslySetInnerHTML`)

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function SafeMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown 
      remarkPlugins={[remarkGfm]}
      components={{
        // Custom renderers for links, code blocks, etc.
        a: ({ href, children }) => (
          <a 
            href={href} 
            target="_blank" 
            rel="noopener noreferrer"
            class="md-link"
          >
            {children}
          </a>
        ),
        code: ({ inline, className, children }) => {
          if (inline) {
            return <code class="md-inline-code">{children}</code>;
          }
          return (
            <pre class="md-code-block">
              <code class={className}>{children}</code>
            </pre>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
```

---

## Color Scheme & Visual Hierarchy

### Tokyo Night Theme Variables

```css
/* From base.css */
:root {
    --bg-dark: #1a1b26;
    --bg-darker: #16161e;
    --text-primary: #c0caf5;
    --text-secondary: #7f849c;
    --text-muted: #565f89;
    --accent: #7aa2f7;
    --accent-hover: #9eb3ff;
    --link-color: #bb9af7;
    --link-visited: #9d7cd8;
    --success: #9ece6a;
    --error: #f7768e;
    --border: #292e42;
    --font-mono: 'Courier New', Consolas, 'Liberation Mono', monospace;
}
```

### Message Type Color Coding

```css
/* From messages.css */

/* Assistant = Green */
.message-type-badge.assistant {
    background: rgba(158, 206, 106, 0.2);
    color: var(--success);
}

/* User = Blue */
.message-type-badge.user {
    background: rgba(122, 162, 247, 0.2);
    color: var(--accent);
}

/* System = Blue */
.message-type-badge.system {
    background: rgba(122, 162, 247, 0.2);
    color: var(--accent);
}

/* Error = Red */
.message-type-badge.result.error {
    background: rgba(247, 118, 142, 0.2);
    color: var(--error);
}

/* Portal = Purple */
.message-type-badge.portal {
    background: rgba(187, 154, 247, 0.2);
    color: var(--link-color);
}

/* Rate Limit / Overload = Orange */
.message-type-badge.overload,
.message-type-badge.rate-limit {
    background: rgba(224, 175, 104, 0.2);
    color: #e0af68;
}
```

### Tool Border Color Coding

```css
/* From tools.css */

/* Bash = Gray */
.bash-tool {
    background: rgba(127, 132, 156, 0.1);
    border-left-color: var(--text-secondary);
}

/* Read/Glob/Grep = Blue (search/read operations) */
.read-tool, .glob-tool, .grep-tool {
    background: rgba(122, 162, 247, 0.08);
    border-left-color: var(--accent);
}

/* Edit/Write = Purple (file modifications) */
.edit-tool, .write-tool {
    background: rgba(99, 102, 241, 0.05);
    border-left-color: var(--accent);
}

/* TodoWrite/Task = Green (success/action) */
.todowrite-tool, .task-tool {
    background: rgba(158, 206, 106, 0.08);
    border-left-color: var(--success);
}

/* AskUserQuestion = Blue (interactive) */
.askuserquestion-tool {
    background: rgba(122, 162, 247, 0.08);
    border-left-color: var(--accent);
}
```

---

## CSS Patterns

### 1. Message Container Structure

```css
/* From messages.css, lines 5-25 */
.claude-message {
    margin-bottom: 1rem;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-darker);
    border: 1px solid var(--border);
}

.claude-message .message-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: rgba(0, 0, 0, 0.2);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
}

.claude-message .message-body {
    padding: 1rem;
}
```

### 2. Badge Pattern (Reusable)

```css
/* From messages.css, lines 28-37 */
.message-type-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
```

### 3. Tool Header Layout (Flexbox with Ellipsis)

```css
/* From tools.css, lines 267-318 */
.bash-tool .tool-use-header {
    min-width: 0;
}

.bash-command-inline,
.glob-pattern-inline,
.grep-pattern-inline {
    flex: 0 1 auto;
    min-width: 0;
    padding: 0.15rem 0.4rem;
    background: rgba(0, 0, 0, 0.25);
    border-radius: 3px;
    color: var(--text-primary);
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.bash-command-inline {
    max-width: 70%;
}

.tool-header-spacer {
    flex: 1 1 auto;
}
```

### 4. Diff View Styling

```css
/* From markdown.css, lines 389-469 */
.diff-view {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    line-height: 1.5;
    max-height: 400px;
    overflow-y: auto;
}

.diff-line {
    display: flex;
    padding: 0 0.5rem;
    white-space: pre-wrap;
    word-break: break-all;
}

.diff-line.context {
    background: transparent;
    color: var(--text-secondary);
}

.diff-line.removed {
    background: rgba(239, 68, 68, 0.2);
    color: #fca5a5;
}

.diff-line.added {
    background: rgba(34, 197, 94, 0.2);
    color: #86efac;
}

.diff-marker {
    flex-shrink: 0;
    width: 1.5rem;
    text-align: center;
    user-select: none;
}
```

### 5. Todo Item State Styling

```css
/* From tools.css, lines 32-90 */
.todo-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.85rem;
}

.todo-item.pending .todo-status {
    color: var(--text-muted);
}

.todo-item.in-progress {
    background: rgba(224, 175, 104, 0.1);
}

.todo-item.in-progress .todo-status {
    color: #e0af68;
}

.todo-item.completed .todo-status {
    color: var(--success);
}

.todo-item.completed .todo-content {
    color: var(--text-muted);
    text-decoration: line-through;
}
```

### 6. Image Lightbox

```css
/* From markdown.css, lines 317-379 */
.image-lightbox {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
}

.image-lightbox-content {
    position: relative;
    max-width: 95vw;
    max-height: 95vh;
    display: flex;
    flex-direction: column;
    align-items: center;
}

.image-lightbox-content img {
    max-width: 95vw;
    max-height: 85vh;
    object-fit: contain;
    border-radius: 4px;
}
```

---

## Preact/TSX Adaptation Patterns

### Full Message Renderer Component

```tsx
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';

interface MessageRendererProps {
  json: string;
  sessionId?: string;
}

export function MessageRenderer({ json, sessionId }: MessageRendererProps) {
  const [message, setMessage] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    try {
      setMessage(JSON.parse(json));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [json]);
  
  if (error) {
    return <RawMessageRenderer json={json} reason={error} />;
  }
  
  if (!message) return null;
  
  switch (message.type) {
    case 'system':
      return <SystemMessage message={message} />;
    case 'assistant':
      return <AssistantMessage message={message} />;
    case 'user':
      return <UserMessage message={message} />;
    case 'result':
      return <ResultMessage message={message} />;
    case 'error':
      return <ErrorMessage message={message} />;
    case 'portal':
      return <PortalMessage message={message} />;
    case 'rate_limit_event':
      return <RateLimitMessage message={message} />;
    default:
      return <RawMessageRenderer json={json} reason={`Unknown type: ${message.type}`} />;
  }
}

function AssistantMessage({ message }: { message: any }) {
  const blocks = message.message?.content || [];
  const usage = message.message?.usage;
  const model = message.message?.model || '';
  
  const shortModel = shortenModelName(model);
  const usageTooltip = usage ? 
    `Input: ${usage.input_tokens || 0} | Output: ${usage.output_tokens || 0} | ` +
    `Cache read: ${usage.cache_read_input_tokens || 0} | ` +
    `Cache created: ${usage.cache_creation_input_tokens || 0}` 
    : '';
  
  return (
    <div class="claude-message assistant-message">
      <div class="message-header">
        <span class="message-type-badge assistant">Assistant</span>
        {shortModel && (
          <span class="model-name" title={model}>{shortModel}</span>
        )}
        {usage && (
          <span class="usage-badge" title={usageTooltip}>
            <span class="token-count">
              {usage.input_tokens || 0}↓ {usage.output_tokens || 0}↑
            </span>
          </span>
        )}
      </div>
      <div class="message-body">
        <ContentBlocks blocks={blocks} />
      </div>
    </div>
  );
}

function ContentBlocks({ blocks }: { blocks: any[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'text':
            return <div key={i} class="assistant-text">{renderMarkdown(block.text)}</div>;
          case 'tool_use':
            return <div key={i}>{renderToolUse(block.name, block.input)}</div>;
          case 'tool_result':
            return <ToolResult key={i} content={block.content} isError={block.is_error} />;
          case 'image':
            return <ImageViewer key={i} source={block.source} />;
          case 'thinking':
            return (
              <div key={i} class="thinking-block">
                <span class="thinking-label">thinking</span>
                <div class="thinking-content">{block.thinking}</div>
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function ToolResult({ content, isError }: { content: any; isError: boolean }) {
  const className = isError ? 'tool-result error' : 'tool-result';
  
  if (typeof content === 'string') {
    const display = content.length > 500 
      ? content.substring(0, 500) + '...' 
      : content;
    
    return (
      <div class={className}>
        <pre class="tool-result-content">{display}</pre>
      </div>
    );
  }
  
  // Handle structured content (array of blocks)
  if (Array.isArray(content)) {
    return (
      <div class={className}>
        {content.map((block, i) => (
          <div key={i}>{renderStructuredBlock(block)}</div>
        ))}
      </div>
    );
  }
  
  return <div class={className}></div>;
}

function shortenModelName(model: string): string | null {
  if (!model || model.startsWith('<')) return null;
  
  // Extract version (e.g., "4.5" from "claude-opus-4-5-20251101")
  const parts = model.split('-');
  let version = null;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const major = parseInt(parts[i]);
    const minor = parseInt(parts[i + 1]);
    
    if (!isNaN(major) && !isNaN(minor) && parts[i + 1].length < 8) {
      version = `${major}.${minor}`;
      break;
    }
  }
  
  if (model.includes('opus')) {
    return version ? `Opus ${version}` : 'Opus';
  } else if (model.includes('sonnet')) {
    return version ? `Sonnet ${version}` : 'Sonnet';
  } else if (model.includes('haiku')) {
    return version ? `Haiku ${version}` : 'Haiku';
  }
  
  return parts[0];
}
```

### Message Grouping Component

```tsx
export function MessageGroupRenderer({ group }: { group: MessageGroup }) {
  if (group.type === 'single') {
    return <MessageRenderer json={group.message} />;
  }
  
  // Assistant group - merge all blocks and sum tokens
  const allBlocks: any[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreated = 0;
  let modelName = '';
  
  for (const json of group.messages) {
    const msg = JSON.parse(json);
    
    if (msg.type === 'assistant') {
      const content = msg.message?.content || [];
      allBlocks.push(...content);
      
      const usage = msg.message?.usage;
      if (usage) {
        totalInputTokens += usage.input_tokens || 0;
        totalOutputTokens += usage.output_tokens || 0;
        totalCacheRead += usage.cache_read_input_tokens || 0;
        totalCacheCreated += usage.cache_creation_input_tokens || 0;
      }
      
      if (!modelName && msg.message?.model) {
        modelName = msg.message.model;
      }
    } else if (msg.type === 'user') {
      const content = msg.message?.content || [];
      allBlocks.push(...content);
    }
  }
  
  const count = group.messages.length;
  const usageTooltip = 
    `Input: ${totalInputTokens} | Output: ${totalOutputTokens} | ` +
    `Cache read: ${totalCacheRead} | Cache created: ${totalCacheCreated} | ` +
    `${count} messages`;
  
  return (
    <div class="claude-message assistant-message">
      <div class="message-header">
        <span class="message-type-badge assistant">Assistant</span>
        {count > 1 && (
          <span class="message-count" title={`${count} consecutive messages`}>
            {count} messages
          </span>
        )}
        {modelName && (
          <span class="model-name" title={modelName}>
            {shortenModelName(modelName)}
          </span>
        )}
        {totalInputTokens > 0 && (
          <span class="usage-badge" title={usageTooltip}>
            <span class="token-count">
              {totalInputTokens}↓ {totalOutputTokens}↑
            </span>
          </span>
        )}
      </div>
      <div class="message-body">
        <ContentBlocks blocks={allBlocks} />
      </div>
    </div>
  );
}
```

---

## Key Takeaways for Preact Implementation

### 1. **Message Grouping is Critical**
- Group consecutive assistant messages + their tool results
- Display a single combined header with summed token counts
- Reduces visual clutter in multi-turn conversations

### 2. **Tool Renderers are Independent Components**
- Each tool gets a specialized renderer
- Consistent header structure: icon + name + inline preview + metadata
- Use flexbox with ellipsis for long commands/paths

### 3. **LCS-Based Diff Algorithm**
- Line-by-line comparison using longest common subsequence
- Three diff line types: context, removed, added
- Color coding: red for removed, green for added

### 4. **Markdown is Just a Utility Function**
- Use `marked` or `react-markdown` for parsing
- Auto-linkify plain URLs before parsing
- Sanitize output to prevent XSS

### 5. **Consistent Color Language**
- Blue = user input, system messages, read operations
- Green = success, assistant responses, write operations
- Red = errors
- Purple = portal/special messages
- Orange = warnings, rate limits
- Gray = raw/unknown

### 6. **Responsive Tool Headers**
- Use `flex-wrap` to handle long paths gracefully
- Inline code snippets with `max-width` + `text-overflow: ellipsis`
- Spacer element (`flex: 1 1 auto`) pushes metadata to the right

### 7. **Truncation Strategy**
- Tool results: 500 chars max
- Write tool: 20 lines preview
- Diff view: 400px max-height with scroll
- Always show "X more lines/chars" indicator

### 8. **Accessibility**
- Use semantic HTML (`<code>`, `<pre>`, `<kbd>`)
- Provide `title` tooltips for truncated content
- Ensure sufficient color contrast (WCAG AA)
- Keyboard navigation for lightbox (Escape to close)

---

## File Structure Recommendation

```
src/components/messages/
├── MessageRenderer.tsx          # Main dispatcher
├── MessageGroupRenderer.tsx     # Grouping logic
├── types.ts                     # TypeScript interfaces
├── tools/
│   ├── BashTool.tsx
│   ├── EditTool.tsx
│   ├── WriteTool.tsx
│   ├── ReadTool.tsx
│   ├── GlobTool.tsx
│   ├── GrepTool.tsx
│   ├── TodoWriteTool.tsx
│   ├── AskUserQuestionTool.tsx
│   ├── TaskTool.tsx
│   └── GenericTool.tsx
├── blocks/
│   ├── ContentBlocks.tsx
│   ├── ToolResult.tsx
│   └── ImageViewer.tsx
├── diff/
│   ├── DiffView.tsx
│   └── lcs.ts
└── markdown/
    └── renderMarkdown.tsx

src/styles/
├── messages.css
├── tools.css
├── markdown.css
└── base.css
```

---

## Usage Example

```tsx
import { groupMessages, MessageGroupRenderer } from './components/messages';

function ConversationView({ messages }: { messages: string[] }) {
  const groups = groupMessages(messages);
  
  return (
    <div class="conversation">
      {groups.map((group, i) => (
        <MessageGroupRenderer key={i} group={group} />
      ))}
    </div>
  );
}
```

---

## References

- **Source Repository**: claude-code-portal (Yew/Rust)
- **Key Files**:
  - `frontend/src/components/message_renderer.rs`
  - `frontend/src/components/diff.rs`
  - `frontend/src/components/markdown.rs`
  - `frontend/src/components/tool_renderers/*.rs`
  - `frontend/styles/*.css`

---

**End of Analysis**
