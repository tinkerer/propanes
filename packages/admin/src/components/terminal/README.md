# Terminal Components

Three-view agent session viewer with raw terminal emulation, parsed message structure, and live interrupt capability.

## Purpose

Provides session display modes for Claude Code agent execution:
- **Terminal (xterm)**: Raw PTY stream via WebSocket—full ANSI escape sequence support, Ctrl+click text selection, right-click copy menu with link detection. Most resource-intensive; Chrome freezes when mounting multiple instances.
- **Structured**: Parsed JSONL conversation log with collapsible turns, tool clusters, role/tool filtering. Lightweight client-side rendering; no WebSocket.
- **Split (55/45)**: Structured view on left, terminal on right. Desktop only; mobile forced to structured.

Additionally handles:
- **InterruptBar**: Composer for killing running headless sessions or resuming terminated ones with new prompt + rich context (screenshots, DOM picks, console logs, voice transcripts).
- **InteractivePrompt**: Permission request UI for AskUserQuestion tool calls and Claude CLI's numbered-choice prompts (approval, deny, etc.). Sends responses via send-keys.

## Component Map

| File | Lines | Responsibility |
|------|-------|-----------------|
| **AgentTerminal.tsx** | 809 | xterm.js terminal with WebSocket stream, text selection overlay, context menu. Staggered mount queue (2 concurrent, 150ms between) + resize ownership token. Max 40KB history truncation per mount. |
| **InteractivePrompt.tsx** | 262 | AskUserQuestionPrompt (multi-line text, single/multi-select radio/checkbox) + ChoicePrompt (y/n/approve-all style). Sends answers via api.sendKeys. |
| **InterruptBar.tsx** | 175 | Mode toggle (interrupt headless / resume terminated). UnifiedComposer wrapper. Serializes context: screenshots, DOM elements, console, voice capture. Calls resumeSession. |
| **JsonlView.tsx** | 369 | Full session log viewer. Filter bar (roles: assistant/thinking/system/user_input; tools: Edit/Read/Bash/Task/Search/Web). Draws two-level drawers (Tasks / Files). Fetches JSONL via useTranscriptStream, groups messages, renders MessageRenderer per turn. |
| **MessageRenderer.tsx** | 1138 | 15+ tool renderers (Bash, Edit, Write, Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, AskUserQuestion, generic MCP) + role renderers (assistant, user_input, thinking, system, tool_result). Chat mode: collapses pairs, hides thinking/system, runs text through filter. Result image detection (base64 / HTTPS). |
| **SessionViewToggle.tsx** | 51 | Mode dispatcher. Picks effective mode based on isMobile. Stacks AgentTerminal + JsonlView + InterruptBar. |
| **StructuredView.tsx** | 626 | Live JSONL viewer (chat-mode output from CoS bubble or full session log). Windowed on mobile (initial 30 groups); load-earlier sentinel at top. Polls terminal for Claude CLI permission prompts. Detects pending tool + asks-for-input state. |
| **SubagentBlock.tsx** | 78 | Collapsible subagent transcript (spawned by Task tool). Summarizes input description + subagent_type. Shows msg/tool counts. |

## AgentTerminal

**xterm.js + WebSocket streaming**

Mounts one Terminal per session inside a container ref. FitAddon handles PTY dimension sync; ResizeObserver + requestAnimationFrame throttle at 100ms intervals. Global `resizeOwners` map ensures only the focused terminal instance sends SIGWINCH (prevents thrashing when two AgentTerminals show the same session, e.g., main + autojump popout).

**Strict lazy mounting** (AgentTerminal.tsx:12–59):
- At most 2 xterm instances initialize simultaneously (MOUNT_CONCURRENCY=2).
- Rest queue in FIFO; each waits MOUNT_STAGGER_MS=150ms after the previous finishes.
- Mount slot released after 150ms, not held for terminal lifetime (allows subsequent mounts to proceed).
- If mount is cancelled before its turn, removed from queue without incrementing counter.
- **Critical gotcha**: Each Terminal instance parses every byte in the buffer, so MAX_HISTORY_BYTES=40KB is enforced. Old scrollback beyond that is dropped to avoid 500KB+ escape sequence chains freezing page load.

**WebSocket protocol** (sequenced_input / sequenced_output / input_ack):
- Client sends input with incrementing seq; server acks with ackSeq.
- Server can emit output replay requests on reconnect; client maintains pendingInputs map to resend unacked commands.
- Terminal response sequences (DA1/DA2/DSR) filtered to prevent junk input during reconnect timeouts.

**Ctrl+click text selection overlay** (AgentTerminal.tsx:210–426):
- createds SVG-like div highlighting over terminal grid.
- Right-click context menu detects words, links (http/https), file paths (^/~/).
- Copy to clipboard; open link in new tab; open file in pane via /files/* route.

## JsonlView → StructuredView → MessageRenderer

**Data path**:

1. **JsonlView** (JsonlView.tsx:49):
   - Calls useTranscriptStream(sessionId, { fileFilter }) → polls /api/v1/sessions/:id/transcript with optional \_file query param.
   - Fetches raw JSONL, pipes to parser (lib/output-parser.ts JsonOutputParser).

2. **Parser** (output-parser.ts:77–150):
   - JsonOutputParser: buffer chunks, split on \n, parse each line as JSON event.
   - Emits ParsedMessage[] with role (assistant/tool_use/tool_result/thinking/system/user_input), toolName, toolInput, content, timestamp, usage, subagentId.
   - TerminalOutputParser: legacy fallback for raw PTY capture (captures tool invocation patterns + results from ANSI).

3. **StructuredView** (StructuredView.tsx:374):
   - Groups messages: assistant/tool_use/tool_result/thinking → assistant_group; user_input → standalone.
   - Partitions: splits out subagent messages (marked \_subagentId) and reattaches inline at their spawning Task call.
   - Windowing on mobile: initial 30 groups; IntersectionObserver sentinel at top; load-earlier expansion restores scroll position via useLayoutEffect.

4. **MessageRenderer** (MessageRenderer.tsx:139):
   - Switch on message.role, delegate to specialized renderers.
   - Chat mode: collapses tool pairs, hides thinking/system, filters assistant text.

## Tool Renderers (19 total)

**Specialized renderers** (lines 382–823):
1. **Bash** (419): Command + description + timeout/background badge. Collapsible if >12 lines or >1KB. Copy button.
2. **Edit** (464): File path, diff stats (+lines/-lines), LCS diff visualization. Collapsible on mobile >4 lines.
3. **Write** (517): File path, line count badge, syntax-highlighted code. Collapsible.
4. **Read** (546): File path, optional offset/limit range info. No content (only input, result shown separately).
5. **Glob** (568): Pattern + optional path.
6. **Grep** (568): Pattern + optional path.
7. **TodoWrite** (584): Todo list with status badges (✓/→/○). Compact summary on mobile.
8. **WebSearch** (632): Query + allowed/blocked domain filter badges.
9. **WebFetch** (654): URL link + optional prompt.
10. **AskUserQuestion** (670): Interactive input form (text / single-select / multi-select) OR display with answers if already submitted.
11. **TaskCreate/TaskUpdate/TaskList/TaskGet/Task** (718): Task id, status, subject, description. Collapsible.
12. **GenericToolUse** (794): MCP tools (mcp__Gmail__send_email → "Gmail → send_email"). Input key/value pairs, collapsible.
13. **ChatToolChip** (192): Compact one-liner for chat mode (Bash command preview, file name, query, etc). Expandable on click to show full input + result.

**Tool result renderers** (845):
- Syntax-highlighted code with line numbers (HighlightedCode).
- Markdown rendering toggle for .md/.mdx files.
- Image extraction from base64 (data:image/png;base64,...) and HTTPS URLs. Inline thumbnails; lightbox on click.
- Collapsible preview (2–8 lines on mobile, 8 lines on desktop) for long outputs.
- Strips line-number prefixes from Read tool output (format: "   123→content").

## InterruptBar

**Mode**:
- Running + headless-yolo → "Interrupt" button (kills session, resumes with new prompt).
- Terminated (any profile) → "Resume" button (restarts with full context).
- Plain or running TTY → no bar.

**Input UI** via UnifiedComposer (components/feedback/UnifiedComposer.tsx):
- Textarea with Shift+Enter newline support.
- Paste / screenshot upload (batched upload to /api/v1/screenshots).
- DOM picker, console log capture, voice transcript + gesture screenshots.

**Serialization** (InterruptBar.tsx:52–142):
- Collects all images (pasted + voice gesture screenshots).
- Uploads batch, gets back URLs + tmp file paths.
- Builds extras block: screenshot URLs/paths + "Local tmp paths (if agent is on server host)".
- DOM elements: serializes tag + id + classes, bounding rect, textContent, childrenHTML.
- Console entries: formats log level + args, truncates to 4KB.
- Voice: transcript (final segments), interactions (type/selector/timestamp), gesture URLs, console during capture.
- Enriches final text: `text + "\n\n---\n" + extras.join("\n\n")`.

**Dispatch**:
- Calls resumeSession(sessionId, { additionalPrompt: enriched }).
- On success, new session id returns; composer resets.
- On error, inline banner shows error; textarea kept (user can retry).

## InteractivePrompt

**Two forms**:

1. **AskUserQuestionPrompt** (37–193):
   - Parses Question[] (question, options?, header?, multiSelect?).
   - Renders text textarea (Enter to submit) OR radio buttons (single-select) OR checkboxes (multi-select).
   - Answer serialization: text.trim() for free-form; option label for single; label1, label2 for multi.
   - Sends via api.sendKeys(sessionId, { keys, enter: true }). Delays 60ms between multi-question sends.
   - Focus auto-sets to first input after 80ms mount.

2. **ChoicePrompt** (213–261):
   - Displays title + prompt + ChoiceOption buttons (label + keys + kind).
   - Kind (approve/approve-all/deny/neutral) drives button styling.
   - Sends choice.keys via api.sendKeys on click.

## StructuredView Specifics

**Terminal capture + permission-prompt detection** (StructuredView.tsx:391–410):
- When session waiting for input, polls api.capturePane every 1500ms (not during JSONL load).
- Regex scans last 3000 chars for numbered-choice pattern: "❯ 1. Yes / 2. No (esc)".
- Detects title + prompt + options; maps to ChoicePrompt.
- Renders alongside message stream if detected and not already AskUserQuestion.

**Windowing behavior** (424–489):
- Initial window: 30 groups (mobile) / 200 (desktop).
- IntersectionObserver on load-more sentinel (top with 200px rootMargin).
- Expansion prepends earlier messages; scroll anchor preserved via useLayoutEffect.
- Auto-scroll disabled after expansion; re-enabled on new messages.

**Pending tool indicator** (614–621):
- Last message role === tool_use + no following tool_result → renders "Running: ToolName" badge.
- Suppressed if AskUserQuestion pending (AskUserQuestionPrompt takes precedence).

## Gotchas

1. **Lazy xterm mount**: Mounting 5 AgentTerminals on page load without stagger freezes Chrome for 10+ seconds. Mount concurrency + queue + stagger required.

2. **History truncation**: MAX_HISTORY_BYTES=40KB per terminal. Sessions with 500KB+ escape sequences render invisible without this cap.

3. **Resize ownership**: Global resizeOwners Map prevents dueling SIGWINCH when two terminals show the same session. Most recently focused terminal wins via Symbol token.

4. **Base64 image detection** (MessageRenderer.tsx:827–835): Regex extracts data:image/*/base64,... and https://*.{png|jpg|jpeg|gif|webp|svg|bmp} from result strings. Chat mode stashes result in message.toolInput.__chatExtras to suppress tool_result role.

5. **Mobile viewport**: StructuredView (not AgentTerminal) on phone. SessionViewToggle forces structured mode if isMobile.value.

6. **Polling cadence**: Permission-prompt scan every 1500ms only when isWaiting && !loading. Skip during JSONL load.

7. **Subagent partitioning**: Merges main + subagent transcripts in-memory; renders subagent inline at spawning Task call. Without this, every subagent line appears after main flow, burying it.

8. **Tool clusters**: Consecutive tool_use messages group into collapsible "N tools" header. Hidden filter badge shows dropped tools. Tool results folded into preceding use via enrichedById map.

9. **Thinking coalescing**: Consecutive thinking blocks merged into single "Thought for 42 seconds" collapse handle. Avoids rendering 100x repeated "Thinking" headers.

10. **Line number strip**: Read tool results prefixed "   NNN→" stripped before syntax highlighting so code looks normal. Regex: /^\s*\d+→/.
