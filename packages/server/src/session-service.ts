import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import * as pty from 'node-pty';
import { eq, desc } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from './db/index.js';
import type { AgentRuntime, PermissionProfile, SequencedOutput, SessionOutputData } from '@propanes/shared';
import { STREAM_PROFILE_PTY_COLS } from '@propanes/shared';
import { MessageBuffer } from './message-buffer.js';
import { safeDir, isTmuxAvailable, spawnInTmux, reattachTmux, tmuxSessionExists, captureTmuxPane, sendKeysToTmux, listPwTmuxSessions, getTmuxPaneCommand, detachTmuxClients } from './tmux-pty.js';
import { detectClaudeAuthRequired, detectClaudeTrustPrompt, stripTerminalControl } from './claude-auth-detect.js';
import { mergePrUrls } from './pr-detect.js';

const PORT = parseInt(process.env.SESSION_SERVICE_PORT || '3002', 10);

// Strip CLAUDECODE env var so spawned Claude sessions don't think they're nested
delete process.env.CLAUDECODE;
const MAX_OUTPUT_LOG = 500 * 1024; // 500KB
const FLUSH_INTERVAL = 10_000; // 10s

// Safety net: node-pty's onData fires synchronously during a ReadStream read;
// any throw from a handler bubbles up as an uncaughtException and kills the
// whole session-service, dropping every live AgentTerminal's WebSocket. Log
// and keep running instead — individual callers still catch their own
// expected errors, this is the last-resort guard against bugs.
process.on('uncaughtException', (err) => {
  console.error('[session-service] uncaughtException (continuing):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[session-service] unhandledRejection (continuing):', reason);
});

// ---------- Message buffer ----------

const messageBuffer = new MessageBuffer();

// ---------- PTY process management ----------

// Claude Code signals state via OSC 0 (Set Window Title):
//   Spinner chars (⠐⠂⠈⠠ etc.) = actively working → 'active'
//   ✳ prefix = done working → 'idle' or 'waiting'
// We parse these from the onData stream for real-time detection.
// To distinguish idle vs waiting, we check the recent output buffer
// for permission prompt indicators ("Esc to cancel") at the moment of transition.

const BRAILLE_SPINNERS = new Set('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠈⠠⡀⢀⠁⠄⠑⠒');

// Parse OSC 0 title sequences from raw PTY data.
// Returns the last title found in the chunk, or null.
function extractOscTitle(data: string): string | null {
  let lastTitle: string | null = null;
  let idx = 0;
  while (idx < data.length) {
    // Look for ESC ] 0 ;
    const oscStart = data.indexOf('\x1b]0;', idx);
    if (oscStart === -1) break;
    const contentStart = oscStart + 4;
    // Find BEL terminator
    const belEnd = data.indexOf('\x07', contentStart);
    // Find ST terminator (ESC \)
    const stEnd = data.indexOf('\x1b\\', contentStart);
    let end = -1;
    if (belEnd !== -1 && stEnd !== -1) end = Math.min(belEnd, stEnd);
    else if (belEnd !== -1) end = belEnd;
    else if (stEnd !== -1) end = stEnd;
    if (end === -1) break;
    lastTitle = data.slice(contentStart, end);
    idx = end + 1;
  }
  return lastTitle;
}

// Classify a title as active, idle, or waiting.
// When the title indicates idle (✳), check the LAST FEW LINES of visible text
// for permission prompts or interactive selection prompts.
// Only checking the tail avoids false positives when an agent's output text
// *discusses* these patterns (e.g. "arrow keys" appearing in code analysis).
function classifyFromTitle(title: string, visibleText: string): InputState {
  const firstChar = title.charAt(0);
  if (BRAILLE_SPINNERS.has(firstChar)) return 'active';
  if (firstChar !== '✳') return 'active'; // unknown title = assume active

  // Only check the last ~8 lines where actual prompts appear
  const lines = visibleText.trimEnd().split('\n');
  const tail = lines.slice(-8).join('\n');

  if (/Do you want to .+\?/.test(tail)) return 'waiting';
  if (tail.includes('Would you like to proceed')) return 'waiting';
  // Claude Code tool permission prompts (Allow/Deny buttons, Yes/No)
  if (/\bAllow\b.*\bDeny\b/.test(tail)) return 'waiting';
  if (/\bYes\b.*\bNo\b/.test(tail)) return 'waiting';
  if (/Esc to cancel/i.test(tail)) return 'waiting';
  // Interactive selection prompts (fzf, inquirer, Claude Code menus)
  if (/enter to select/i.test(tail)) return 'waiting';
  if (/arrow keys/i.test(tail)) return 'waiting';
  if (/use the arrows/i.test(tail)) return 'waiting';
  if (/↑.*↓|↓.*↑/.test(tail)) return 'waiting';
  return 'idle';
}

type InputState = 'active' | 'idle' | 'waiting';

interface AgentProcess {
  sessionId: string;
  runtime: AgentRuntime;
  permissionProfile: PermissionProfile;
  cwd: string;
  ptyProcess: pty.IPty;
  outputBuffer: string;
  totalBytes: number;
  outputSeq: number;
  lastInputAckSeq: number;
  adminSockets: Set<WebSocket>;
  /**
   * Per-connected-client requested PTY size. The tmux/PTY is a single shared
   * resource but multiple browsers/panes attach to it at different viewport
   * sizes. We size the PTY to the LARGEST requested dimensions (per-axis max)
   * so no viewer is ever truncated — mirroring tmux `window-size largest`.
   * Last-writer-wins (the old behaviour) let a short pane shrink the PTY and
   * leave taller panes painting blank rows below the content.
   */
  clientSizes: Map<WebSocket, { cols: number; rows: number }>;
  status: 'running' | 'completed' | 'failed' | 'killed';
  flushTimer: ReturnType<typeof setInterval>;
  inputState: InputState;
  hasStarted: boolean;
  /** Last OSC title seen — used to re-classify when new output arrives without a title change */
  lastTitle: string;
  /**
   * True once Claude has emitted a real working title (✳ idle or braille spinner).
   * The first-run "trust this folder" prompt strictly *precedes* any working title,
   * so once we've seen one the prompt is behind us and trust-prompt detection must
   * stop — otherwise later agent output that merely *mentions* the prompt text
   * (e.g. an agent editing the detector itself) re-triggers a false 'waiting'.
   */
  sawWorkingTitle: boolean;
  /** Timer for debouncing transitions away from 'waiting' state */
  waitingDebounce: ReturnType<typeof setTimeout> | null;
  /** Timestamp of last state broadcast (for throttling) */
  lastStateBroadcast: number;
  authCompanionStarted: boolean;
  suppressAuthCompanion: boolean;
  tmuxSessionName: string | null;
  /** JSON array of GitHub PR URLs detected in output (mirrors the pr_urls column) */
  prUrlsJson: string | null;
}

const activeSessions = new Map<string, AgentProcess>();
const pendingConnections = new Map<string, Set<WebSocket>>();

// Debounce delay before transitioning away from 'waiting' state.
// Claude Code briefly flashes spinner titles even while at a permission prompt,
// causing rapid waiting→active→waiting flicker on the UI status dots.
const WAITING_EXIT_DEBOUNCE_MS = 1500;

// Minimum interval between any state broadcasts to prevent rapid blinking.
// Real-time OSC detection can fire many times per second; throttle to ~2 updates/sec.
const STATE_BROADCAST_MIN_INTERVAL_MS = 500;

function applyInputState(proc: AgentProcess, newState: InputState): void {
  if (newState === proc.inputState) {
    // Same state — cancel any pending debounce
    if (proc.waitingDebounce) { clearTimeout(proc.waitingDebounce); proc.waitingDebounce = null; }
    return;
  }
  // Transitioning away from 'waiting' — debounce to avoid flicker
  if (proc.inputState === 'waiting' && newState !== 'waiting') {
    if (!proc.waitingDebounce) {
      proc.waitingDebounce = setTimeout(() => {
        proc.waitingDebounce = null;
        // Re-check: if still not waiting after debounce, apply
        if (proc.inputState === 'waiting') {
          commitInputState(proc, newState);
        }
      }, WAITING_EXIT_DEBOUNCE_MS);
    }
    return;
  }
  // Transitioning TO waiting (or between active/idle) — apply with throttle
  if (proc.waitingDebounce) { clearTimeout(proc.waitingDebounce); proc.waitingDebounce = null; }
  commitInputState(proc, newState);
}

/** Actually update state + broadcast, but throttle to avoid flooding the client. */
function commitInputState(proc: AgentProcess, newState: InputState): void {
  const now = Date.now();
  const elapsed = now - (proc.lastStateBroadcast || 0);
  if (elapsed < STATE_BROADCAST_MIN_INTERVAL_MS) {
    // Schedule a deferred broadcast if not already pending
    if (!proc.waitingDebounce) {
      proc.waitingDebounce = setTimeout(() => {
        proc.waitingDebounce = null;
        // Apply whatever the latest desired state is at fire time
        if (proc.inputState !== newState) {
          proc.inputState = newState;
          proc.lastStateBroadcast = Date.now();
          sendSequenced(proc, { kind: 'input_state', state: newState });
        }
      }, STATE_BROADCAST_MIN_INTERVAL_MS - elapsed);
    }
    return;
  }
  proc.inputState = newState;
  proc.lastStateBroadcast = now;
  sendSequenced(proc, { kind: 'input_state', state: newState });
}

// Profile names follow `<mode>-<perms>` (see packages/shared/src/constants.ts).
// `plain` is the only exception (raw shell, no agent).
const PIPE_PROFILES = new Set<PermissionProfile>([
  'headless-yolo',
  'headless-stream-yolo',
  'headless-stream-require',
]);
const SKIP_PROFILES = new Set<PermissionProfile>([
  'interactive-yolo',
  'headless-yolo',
  'headless-stream-yolo',
]);
const STREAM_PROFILES = new Set<PermissionProfile>([
  'headless-stream-yolo',
  'headless-stream-require',
]);

// Stream profiles read stream-json from the PTY; tmux/PTY would hard-wrap
// lines at the column boundary and fragment each JSON line, making
// JSON.parse fail downstream (cos-turn-consumer.ts). Use a very wide
// terminal so individual events stay on one line. Interactive profiles
// keep a normal width because the user sees the TUI.
//
// IMPORTANT: must equal STREAM_PROFILE_PTY_COLS (10000) from
// @propanes/shared — tmux hard-caps window width at 10000. Asking the
// attach client for anything wider (the old 32768) leaves the client
// permanently larger than the window, and tmux pads the dead zone with
// `·` fill on every repaint — the source of the dot/line rendering
// corruption in the admin terminal.
const STREAM_PROFILE_COLS = STREAM_PROFILE_PTY_COLS;
const DEFAULT_COLS = 120;
const MAX_INTERACTIVE_COLS = 300;
const MAX_INTERACTIVE_ROWS = 120;
function needsWideStreamPty(runtime: AgentRuntime, profile: PermissionProfile): boolean {
  return runtime === 'claude' && STREAM_PROFILES.has(profile);
}

function ptyColsForSession(runtime: AgentRuntime, profile: PermissionProfile): number {
  return needsWideStreamPty(runtime, profile) ? STREAM_PROFILE_COLS : DEFAULT_COLS;
}

// A live command "wants" the wide stream PTY only if it speaks stream-json
// (stream profiles or headless `-p` with --output-format stream-json). Anything
// else is an interactive TUI that must stay at a normal width, or tmux paints
// full-window-width separator lines that wrap into dozens of rows.
function commandSpeaksStreamJson(cmd: string): boolean {
  return /--input-format\s+stream-json|--output-format\s+stream-json|(^|\s)-p(\s|$)/.test(cmd);
}

// Reconcile a stored permission profile against what the pane is really
// running. Returns the profile that matches the live command so the PTY width
// is derived from reality, not a stale DB row. See getTmuxPaneCommand and the
// project-tmux-stream-pty-width memory note.
function reconcileProfileWithLiveCommand(
  sessionId: string,
  storedProfile: PermissionProfile,
): PermissionProfile {
  // Only stream/headless profiles trigger the wide PTY, so only they can drift
  // into corruption. Interactive profiles are already narrow — nothing to fix.
  if (!STREAM_PROFILES.has(storedProfile) && storedProfile !== 'headless-yolo') {
    return storedProfile;
  }
  const liveCmd = getTmuxPaneCommand(sessionId);
  if (!liveCmd || commandSpeaksStreamJson(liveCmd)) return storedProfile;

  // DB says stream/headless but the pane is an interactive TUI — the source of
  // the 10000-col wrapped-line corruption. Correct to the matching interactive
  // profile and persist it so future recoveries stay healthy.
  const corrected: PermissionProfile = liveCmd.includes('--dangerously-skip-permissions')
    ? 'interactive-yolo'
    : 'interactive-require';
  console.warn(`[session-service] Profile drift on ${sessionId}: DB=${storedProfile} but live pane is an interactive TUI; correcting to ${corrected} (was painting wide-window separator lines)`);
  try {
    db.update(schema.agentSessions)
      .set({ permissionProfile: corrected })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  } catch (err) {
    console.error(`[session-service] Failed to persist corrected profile for ${sessionId}:`, err);
  }
  return corrected;
}

function buildAgentCommand(
  runtime: AgentRuntime,
  prompt: string,
  permissionProfile: PermissionProfile,
  allowedTools?: string | null,
  claudeSessionId?: string,
  resumeSessionId?: string,
  appendSystemPrompt?: string,
): { command: string; args: string[] } {
  if (runtime === 'codex') {
    const command = process.env.CODEX_BIN || 'codex';
    const args: string[] = [];
    // Codex has no interactive/headless/stream separation the way claude does —
    // `exec` is the only headless subcommand and it's one-shot. The stream
    // profiles fall back to `exec` too (codex doesn't yet expose a
    // bidirectional JSON protocol we can drive from here).
    if (PIPE_PROFILES.has(permissionProfile)) args.push('exec');
    if (SKIP_PROFILES.has(permissionProfile)) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (prompt) args.push(prompt);
    return { command, args };
  }

  // When resuming, use --resume — no --session-id (it conflicts)
  if (resumeSessionId) {
    const args = ['--resume', resumeSessionId];
    if (SKIP_PROFILES.has(permissionProfile)) {
      args.push('--dangerously-skip-permissions');
    }
    if (permissionProfile === 'headless-yolo') {
      args.push('--output-format', 'stream-json', '--verbose');
    }
    if (STREAM_PROFILES.has(permissionProfile)) {
      args.push('--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose');
    }
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
    if (prompt) args.push(prompt);
    return { command: process.env.CLAUDE_BIN || 'claude', args };
  }

  switch (permissionProfile) {
    case 'interactive-require': {
      const args: string[] = [];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (allowedTools) args.push(`--allowedTools=${allowedTools}`);
      if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
      if (prompt) args.push(prompt);
      return { command: process.env.CLAUDE_BIN || 'claude', args };
    }
    case 'interactive-yolo': {
      const args: string[] = ['--dangerously-skip-permissions'];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (allowedTools) args.push(`--allowedTools=${allowedTools}`);
      if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
      if (prompt) args.push(prompt);
      return { command: process.env.CLAUDE_BIN || 'claude', args };
    }
    case 'headless-yolo': {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (allowedTools) args.push(`--allowedTools=${allowedTools}`);
      if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
      return { command: process.env.CLAUDE_BIN || 'claude', args };
    }
    case 'headless-stream-yolo':
    case 'headless-stream-require': {
      // Bidirectional streaming JSON. Persistent stdin/stdout session; caller
      // feeds user turns as stream-json and reads assistant/tool deltas back.
      // --print is required for stream-json I/O but --input-format stream-json
      // keeps the session open across turns. The `-require` variant omits the
      // skip-permissions flag, so permission prompts arrive as JSON events for
      // the admin UI to approve.
      const args = [
        '--print',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
      ];
      if (SKIP_PROFILES.has(permissionProfile)) {
        args.push('--dangerously-skip-permissions');
      }
      if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
      if (prompt) args.push(prompt);
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (allowedTools) args.push(`--allowedTools=${allowedTools}`);
      return { command: process.env.CLAUDE_BIN || 'claude', args };
    }
    case 'plain': {
      const shell = process.env.SHELL || '/bin/bash';
      return { command: shell, args: [] };
    }
    default: {
      throw new Error(`Unknown permission profile: ${permissionProfile}. This usually means the session-service is running stale code — restart it. Known: interactive-require | interactive-yolo | headless-yolo | headless-stream-yolo | headless-stream-require | plain.`);
    }
  }
}

function syncFeedbackDispatchStatus(sessionId: string, sessionStatus: string): void {
  try {
    const session = db
      .select({ feedbackId: schema.agentSessions.feedbackId })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .get();
    if (!session?.feedbackId) return;

    const latestSession = db
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.feedbackId, session.feedbackId))
      .orderBy(desc(schema.agentSessions.createdAt))
      .limit(1)
      .get();
    if (!latestSession || latestSession.id !== sessionId) return;

    let dispatchStatus: string;
    if (sessionStatus === 'completed') dispatchStatus = 'completed';
    else if (sessionStatus === 'killed') dispatchStatus = 'killed';
    else dispatchStatus = 'failed';

    db.update(schema.feedbackItems)
      .set({ dispatchStatus, updatedAt: new Date().toISOString() })
      .where(eq(schema.feedbackItems.id, session.feedbackId))
      .run();
  } catch {
    // best-effort
  }
}

function appendSessionAuditMarker(sessionId: string, marker: string): void {
  const existing = db
    .select({ outputLog: schema.agentSessions.outputLog })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  const line = `\n\n[propanes ${new Date().toISOString()}] ${marker}\n`;
  db.update(schema.agentSessions)
    .set({ outputLog: `${existing?.outputLog || ''}${line}`.slice(-MAX_OUTPUT_LOG) })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();
}

function appendProcAuditMarker(proc: AgentProcess, marker: string): void {
  const line = `\n\n[propanes ${new Date().toISOString()}] ${marker}\n`;
  proc.outputBuffer = `${proc.outputBuffer}${line}`.slice(-MAX_OUTPUT_LOG);
  proc.totalBytes += Buffer.byteLength(line);
}

// Scan the accumulated output for GitHub PR URLs (flush-time, not per-chunk —
// a badge can lag up to one FLUSH_INTERVAL). Once a URL lands in prUrlsJson it
// sticks even after the buffer truncates past it.
function scanPrUrls(proc: AgentProcess): void {
  const updated = mergePrUrls(proc.prUrlsJson, proc.outputBuffer);
  if (updated) proc.prUrlsJson = updated;
}

function flushOutput(sessionId: string): void {
  const proc = activeSessions.get(sessionId);
  if (!proc) return;

  scanPrUrls(proc);
  db.update(schema.agentSessions)
    .set({
      outputLog: proc.outputBuffer.slice(-MAX_OUTPUT_LOG),
      outputBytes: proc.totalBytes,
      lastOutputSeq: proc.outputSeq,
      lastActivityAt: new Date().toISOString(),
      prUrls: proc.prUrlsJson,
    })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();
}

function touchActivity(sessionId: string): void {
  db.update(schema.agentSessions)
    .set({ lastActivityAt: new Date().toISOString() })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();
}

function sendSequenced(proc: AgentProcess, content: SessionOutputData): void {
  proc.outputSeq++;
  const msg: SequencedOutput = {
    type: 'sequenced_output',
    sessionId: proc.sessionId,
    seq: proc.outputSeq,
    content,
    timestamp: new Date().toISOString(),
  };

  const serialized = JSON.stringify(msg);

  messageBuffer.append(proc.sessionId, 'output', proc.outputSeq, serialized);

  for (const ws of proc.adminSockets) {
    try {
      ws.send(serialized);
    } catch {
      proc.adminSockets.delete(ws);
    }
  }
}

function spawnSession(params: {
  sessionId: string;
  prompt?: string;
  cwd: string;
  runtime?: AgentRuntime;
  permissionProfile: PermissionProfile;
  allowedTools?: string | null;
  claudeSessionId?: string;
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  suppressAuthCompanion?: boolean;
}): void {
  const { sessionId, cwd, runtime = 'claude', permissionProfile, allowedTools, claudeSessionId, resumeSessionId, appendSystemPrompt, suppressAuthCompanion = false } = params;
  // NFC-normalize: decomposed unicode (NFD accents from macOS clipboards, etc.)
  // crossing a wrap boundary crashes Claude Code's TUI with "Failed to find
  // wrapped line in text" (anthropic/claude-code#395, #678, #34380).
  const prompt = (params.prompt || '').normalize('NFC');

  if (activeSessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} is already running`);
  }

  const { command, args } = buildAgentCommand(
    runtime,
    prompt,
    permissionProfile,
    allowedTools,
    claudeSessionId,
    resumeSessionId,
    appendSystemPrompt,
  );

  console.log(`[session-service] Spawning session ${sessionId}: runtime=${runtime}, command=${command}, profile=${permissionProfile}, cwd=${cwd}, tmux=${isTmuxAvailable()}`);

  let ptyProcess: pty.IPty;
  let tmuxSessionName: string | null = null;
  const cols = ptyColsForSession(runtime, permissionProfile);

  if (isTmuxAvailable()) {
    const result = spawnInTmux({
      sessionId,
      command,
      args,
      cwd,
      cols,
      rows: 40,
    });
    ptyProcess = result.ptyProcess;
    tmuxSessionName = result.tmuxSessionName;
  } else {
    const { CLAUDECODE, ...cleanedEnv } = process.env as Record<string, string>;
    ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows: 40,
      cwd: safeDir(cwd),
      env: { ...cleanedEnv, TERM: 'xterm-256color' },
    });
  }

  // Seed PR detection from the row so a flush never clobbers URLs a previous
  // run of this session already recorded.
  const existingRow = db
    .select({ prUrls: schema.agentSessions.prUrls })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();

  const proc: AgentProcess = {
    sessionId,
    runtime,
    permissionProfile,
    cwd,
    ptyProcess,
    outputBuffer: '',
    totalBytes: 0,
    outputSeq: 0,
    lastInputAckSeq: 0,
    adminSockets: new Set(),
    clientSizes: new Map(),
    status: 'running',
    flushTimer: setInterval(() => flushOutput(sessionId), FLUSH_INTERVAL),
    inputState: 'active' as InputState,
    hasStarted: false,
    lastTitle: '',
    sawWorkingTitle: false,
    waitingDebounce: null,
    lastStateBroadcast: 0,
    authCompanionStarted: false,
    suppressAuthCompanion,
    tmuxSessionName,
    prUrlsJson: existingRow?.prUrls || null,
  };

  activeSessions.set(sessionId, proc);


  // Attach any WS connections that arrived before the PTY was ready
  const pending = pendingConnections.get(sessionId);
  if (pending) {
    for (const ws of pending) {
      if (ws.readyState === WebSocket.OPEN) {
        proc.adminSockets.add(ws);
      }
    }
    pendingConnections.delete(sessionId);
  }

  const now = new Date().toISOString();
  db.update(schema.agentSessions)
    .set({
      status: 'running',
      pid: ptyProcess.pid,
      startedAt: now,
      completedAt: null,
      exitCode: null,
      lastOutputSeq: 0,
      lastInputSeq: 0,
      outputBytes: 0,
      tmuxSessionName,
    })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();

  wireOnData(proc, ptyProcess);
  wireOnExit(proc, ptyProcess);

  // Schedule startup health check for Claude sessions
  if (permissionProfile !== 'plain') {
    scheduleStartupCheck(sessionId);
  }
}

// Shared onData handler: output buffering + OSC title-based state detection
function wireOnData(proc: AgentProcess, ptyProcess: pty.IPty): void {
  ptyProcess.onData((data: string) => {
    if (isFillOnlyFrame(data)) return;
    data = stripTerminalFillRuns(data);
    if (!data) return;

    proc.outputBuffer += data;
    proc.totalBytes += Buffer.byteLength(data);

    if (proc.outputBuffer.length > MAX_OUTPUT_LOG) {
      proc.outputBuffer = proc.outputBuffer.slice(-MAX_OUTPUT_LOG);
    }

    if (!proc.hasStarted && proc.totalBytes > 100) {
      proc.hasStarted = true;
    }

    // Real-time input state detection via OSC title sequences
    if (proc.permissionProfile !== 'plain') {
      const title = extractOscTitle(data);
      if (title !== null) {
        proc.lastTitle = title;
        // A ✳ idle or braille-spinner title means Claude is running its own loop,
        // which only happens *after* the first-run trust prompt is dismissed.
        const fc = title.charAt(0);
        if (fc === '✳' || BRAILLE_SPINNERS.has(fc)) proc.sawWorkingTitle = true;
      }
      // Classify when we have a new title OR when stuck in 'idle' (re-check with
      // updated buffer). This handles the race where the ✳ title arrives in one
      // chunk (→ idle) but the permission prompt text arrives in a later chunk.
      // Without re-classifying on subsequent data, the session stays stuck in 'idle'.
      if (title !== null || (proc.lastTitle && proc.inputState === 'idle')) {
        const visibleTail = proc.outputBuffer.slice(-4000)
          .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')  // CSI sequences (including DECSET ?-prefixed)
          .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences
          .replace(/\x1b\([A-Z]/g, '')                 // character set designators
          .replace(/\x1b[>=][0-9;]*[a-zA-Z]/g, '')    // DEC private sequences (DA2 etc.)
          .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, ''); // remaining 2-char ESC sequences
        const newState = classifyFromTitle(proc.lastTitle, visibleTail);
        applyInputState(proc, newState);
      }
      // Claude Code's first-run "trust this folder" prompt appears before the
      // ✳ idle title, so classifyFromTitle can't catch it. Detect it directly
      // (title-independent) and force 'waiting' so the session surfaces as
      // needing input. Only scan during the startup window — once Claude has
      // emitted any working title (sawWorkingTitle) the prompt is behind us, so
      // we stop, otherwise later agent output that merely mentions the prompt
      // text re-triggers a false 'waiting'. classifyFromTitle then owns state.
      if (proc.runtime === 'claude' && !proc.sawWorkingTitle && detectClaudeTrustPrompt(proc.outputBuffer)) {
        applyInputState(proc, 'waiting');
      }
    }

    maybeOpenClaudeLoginCompanion(proc);
    sendSequenced(proc, { kind: 'output', data });
  });
}

function isFillOnlyFrame(data: string): boolean {
  if (data.length < 100) return false;
  const visible = data
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\([A-Z]/g, '')
    .replace(/\x1b[>=][0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '')
    .replace(/[\s\r\n\t]/g, '');
  if (!visible) return false;
  const dots = (visible.match(/\u00b7/g) || []).length;
  return visible.length >= 100 && dots / visible.length > 0.95;
}

function stripTerminalFillRuns(data: string): string {
  return data.replace(/\u00b7{20,}/g, '');
}

function maybeOpenClaudeLoginCompanion(proc: AgentProcess): void {
  if (proc.runtime !== 'claude') return;
  if (proc.permissionProfile === 'plain') return;
  if (proc.suppressAuthCompanion || proc.authCompanionStarted) return;
  if (!detectClaudeAuthRequired(proc.outputBuffer)) return;

  proc.authCompanionStarted = true;
  applyInputState(proc, 'waiting');

  const existing = db
    .select({ companionSessionId: schema.agentSessions.companionSessionId })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, proc.sessionId))
    .get();
  if (existing?.companionSessionId) {
    sendSequenced(proc, {
      kind: 'login_required',
      companionSessionId: existing.companionSessionId,
      data: 'Claude authentication is required. Opened the linked login terminal.',
    });
    return;
  }

  const companionSessionId = ulid();
  const now = new Date().toISOString();
  db.insert(schema.agentSessions)
    .values({
      id: companionSessionId,
      feedbackId: null,
      agentEndpointId: null,
      runtime: 'claude',
      permissionProfile: 'interactive-require',
      parentSessionId: proc.sessionId,
      status: 'pending',
      outputBytes: 0,
      cwd: proc.cwd || null,
      title: `Claude login ${proc.sessionId.slice(-6)}`,
      createdAt: now,
    })
    .run();
  db.update(schema.agentSessions)
    .set({ companionSessionId })
    .where(eq(schema.agentSessions.id, proc.sessionId))
    .run();

  console.log(`[session-service] Claude auth required for ${proc.sessionId}; spawned login companion ${companionSessionId}`);
  sendSequenced(proc, {
    kind: 'login_required',
    companionSessionId,
    data: 'Claude authentication is required. Opened an interactive login terminal.',
  });
  spawnSession({
    sessionId: companionSessionId,
    prompt: '',
    cwd: proc.cwd,
    runtime: 'claude',
    permissionProfile: 'interactive-require',
    suppressAuthCompanion: true,
  });
}

function wireOnExit(proc: AgentProcess, ptyProcess: pty.IPty): void {
  ptyProcess.onExit(({ exitCode }) => {
    if (proc.status === 'killed') return;

    proc.status = exitCode === 0 ? 'completed' : 'failed';
    clearInterval(proc.flushTimer);

    sendSequenced(proc, { kind: 'exit', exitCode, status: proc.status });

    scanPrUrls(proc);
    const completedAt = new Date().toISOString();
    db.update(schema.agentSessions)
      .set({
        status: proc.status,
        exitCode: exitCode,
        outputLog: proc.outputBuffer.slice(-MAX_OUTPUT_LOG),
        outputBytes: proc.totalBytes,
        lastOutputSeq: proc.outputSeq,
        completedAt,
        prUrls: proc.prUrlsJson,
      })
      .where(eq(schema.agentSessions.id, proc.sessionId))
      .run();

    syncFeedbackDispatchStatus(proc.sessionId, proc.status);
    activeSessions.delete(proc.sessionId);
  });
}

const STARTUP_CHECK_DELAY = 45_000; // 45 seconds

function isSessionHealthy(proc: AgentProcess): boolean {
  // Strip ANSI escape sequences to get visible text
  const visible = stripTerminalControl(proc.outputBuffer);
  if (visible.length > 200) return true;
  if (/Claude|Codex|OpenAI|>|Type your/i.test(visible)) return true;
  return false;
}

function scheduleStartupCheck(sessionId: string): void {
  setTimeout(() => {
    const proc = activeSessions.get(sessionId);
    if (!proc || proc.status !== 'running') return;

    if (!isSessionHealthy(proc)) {
      console.log(`[session-service] Startup check failed for ${sessionId}: ${proc.totalBytes} bytes, no meaningful output — killing`);
      appendProcAuditMarker(proc, `session-service startup health check killed session; bytes=${proc.totalBytes}`);
      killSessionProcess(sessionId);
    } else {
      console.log(`[session-service] Startup check passed for ${sessionId}: ${proc.totalBytes} bytes`);
    }
  }, STARTUP_CHECK_DELAY);
}

function killSessionProcess(sessionId: string): boolean {
  const proc = activeSessions.get(sessionId);
  if (!proc || proc.status !== 'running') return false;

  proc.status = 'killed';
  appendProcAuditMarker(proc, 'session-service killSessionProcess marked session killed');
  proc.ptyProcess.kill();
  clearInterval(proc.flushTimer);
  sendSequenced(proc, { kind: 'exit', exitCode: -1, status: 'killed' });

  const now = new Date().toISOString();
  db.update(schema.agentSessions)
    .set({
      status: 'killed',
      outputLog: proc.outputBuffer.slice(-MAX_OUTPUT_LOG),
      outputBytes: proc.totalBytes,
      lastOutputSeq: proc.outputSeq,
      completedAt: now,
    })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();

  syncFeedbackDispatchStatus(sessionId, 'killed');
  activeSessions.delete(sessionId);
  return true;
}

function resizeSessionProcess(sessionId: string, cols: number, rows: number, ws?: WebSocket): void {
  const proc = activeSessions.get(sessionId);
  if (!proc || proc.status !== 'running') return;

  const safeRows = Math.max(2, Math.min(Number(rows) || 40, MAX_INTERACTIVE_ROWS));
  const safeCols = Math.max(20, Math.min(Number(cols) || DEFAULT_COLS, MAX_INTERACTIVE_COLS));

  // Record this client's requested size so the shared PTY can be sized to the
  // largest attached viewer (see clientSizes). A resize with no originating
  // socket (HTTP /resize, recovery) is applied directly without being recorded.
  if (ws) proc.clientSizes.set(ws, { cols: safeCols, rows: safeRows });

  applyEffectiveSize(proc, { cols: safeCols, rows: safeRows });
}

// Resize the shared PTY to the per-axis maximum of every connected client's
// requested size, so the tallest/widest viewer always gets a fully-painted TUI
// and no viewer is truncated. `fallback` is used when no client size is on
// record (e.g. an HTTP resize before any socket registered, or recovery).
function applyEffectiveSize(
  proc: AgentProcess,
  fallback?: { cols: number; rows: number },
): void {
  if (proc.status !== 'running') return;

  // Drop sizes for sockets that are no longer attached so a closed pane can't
  // keep the PTY pinned to its (possibly larger) dimensions forever.
  for (const sock of proc.clientSizes.keys()) {
    if (!proc.adminSockets.has(sock)) proc.clientSizes.delete(sock);
  }

  let cols = fallback?.cols ?? 0;
  let rows = fallback?.rows ?? 0;
  for (const size of proc.clientSizes.values()) {
    if (size.cols > cols) cols = size.cols;
    if (size.rows > rows) rows = size.rows;
  }
  if (cols <= 0 || rows <= 0) return;

  // Stream profiles parse stream-json from PTY output. Narrowing the PTY would
  // cause tmux to hard-wrap each JSON line at the column boundary, breaking
  // JSON.parse in cos-turn-consumer.ts. Pin cols to the wide value regardless
  // of what the frontend xterm requested.
  const effectiveCols = needsWideStreamPty(proc.runtime, proc.permissionProfile) ? STREAM_PROFILE_COLS : cols;
  proc.ptyProcess.resize(effectiveCols, rows);
}

function writeToSession(sessionId: string, data: string): void {
  const proc = activeSessions.get(sessionId);
  if (proc && proc.status === 'running') {
    proc.ptyProcess.write(data);
    markUserInput(sessionId, proc, data);
  }
}

function sendKeysToSession(sessionId: string, keys: string, enter = true): void {
  const proc = activeSessions.get(sessionId);
  if (!proc || proc.status !== 'running') return;

  // See spawnSession: NFD unicode in TUI input triggers the wrapped-line crash.
  keys = keys.normalize('NFC');

  if (proc.tmuxSessionName && tmuxSessionExists(sessionId) && sendKeysToTmux(sessionId, keys, enter)) {
    markUserInput(sessionId, proc, keys);
    return;
  }

  writeToSession(sessionId, keys);
  if (enter) {
    setTimeout(() => writeToSession(sessionId, '\r'), 150);
  }
}

function markUserInput(sessionId: string, proc: AgentProcess, data: string): void {
  // Immediately clear waiting/idle on real user input (not xterm.js escape responses)
  // Bypass debounce — user explicitly typed, so transition is intentional.
  if (proc.inputState !== 'active' && !data.startsWith('\x1b')) {
    if (proc.waitingDebounce) { clearTimeout(proc.waitingDebounce); proc.waitingDebounce = null; }
    proc.inputState = 'active';
    sendSequenced(proc, { kind: 'input_state', state: 'active' });
  }
  if (!data.startsWith('\x1b')) touchActivity(sessionId);
}

function tryRecoverSession(session: typeof schema.agentSessions.$inferSelect): boolean {
  if (!isTmuxAvailable()) return false;
  if (!tmuxSessionExists(session.id)) return false;

  console.log(`[session-service] Recovering tmux session for ${session.id}`);

  try {
    const recoverRuntime = session.runtime as AgentRuntime;
    // Trust the live pane over the DB row: a profile that drifted to a stream
    // value while running an interactive TUI would otherwise be reattached at
    // 10000 cols and paint wrapped separator lines. reconcile fixes the row.
    const recoverProfile = reconcileProfileWithLiveCommand(
      session.id,
      session.permissionProfile as PermissionProfile,
    );
    const recoverCols = ptyColsForSession(recoverRuntime, recoverProfile);
    // Drop any zombie clients (e.g. a stale wide attach that survived a crash)
    // so window-size=latest can't keep the window pinned wider than our new
    // attach. Reattaching a single correctly-sized client then pulls the
    // window to the right width on its own (window-size follows the latest
    // active client) — no explicit resize-window, which would flip the window
    // to manual sizing and stop it reflowing on browser resize.
    detachTmuxClients(session.id);
    const ptyProcess = reattachTmux({ sessionId: session.id, cols: recoverCols, rows: 40 });
    const captured = stripTerminalFillRuns(captureTmuxPane(session.id));

    const proc: AgentProcess = {
      sessionId: session.id,
      runtime: session.runtime as AgentRuntime,
      permissionProfile: recoverProfile,
      cwd: session.cwd || process.cwd(),
      ptyProcess,
      outputBuffer: captured,
      totalBytes: captured.length,
      outputSeq: session.lastOutputSeq ?? 0,
      lastInputAckSeq: session.lastInputSeq ?? 0,
      adminSockets: new Set(),
      clientSizes: new Map(),
      status: 'running',
      flushTimer: setInterval(() => flushOutput(session.id), FLUSH_INTERVAL),
      inputState: 'active' as InputState,
      hasStarted: true,
      lastTitle: '',
      // Recovered sessions are reattaches to an already-running agent — the
      // first-run trust prompt is long past, so disable trust detection.
      sawWorkingTitle: true,
      waitingDebounce: null,
      lastStateBroadcast: 0,
      authCompanionStarted: !!session.companionSessionId,
      suppressAuthCompanion: false,
      tmuxSessionName: session.tmuxSessionName || `pw-${session.id}`,
      prUrlsJson: session.prUrls || null,
    };

    activeSessions.set(session.id, proc);
    wireOnData(proc, ptyProcess);
    wireOnExit(proc, ptyProcess);
    return true;
  } catch (err) {
    console.error(`[session-service] Failed to recover session ${session.id}:`, err);
    return false;
  }
}

function markSessionStale(sessionId: string): void {
  const now = new Date().toISOString();
  appendSessionAuditMarker(sessionId, 'session-service WebSocket attach could not recover running DB row; marked failed');
  db.update(schema.agentSessions)
    .set({ status: 'failed', completedAt: now })
    .where(eq(schema.agentSessions.id, sessionId))
    .run();
}

function attachAdminSocket(sessionId: string, ws: WebSocket): boolean {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    // Send full history + lastInputAckSeq so client can resume its counter.
    // cols/rows = current PTY size, so the client can skip redundant resize
    // bounces when its pane already matches (avoids TUI repaint flicker).
    ws.send(JSON.stringify({ type: 'history', data: stripTerminalFillRuns(proc.outputBuffer), lastInputAckSeq: proc.lastInputAckSeq, inputState: proc.inputState, cols: proc.ptyProcess.cols, rows: proc.ptyProcess.rows }));
    proc.adminSockets.add(ws);
    return true;
  }

  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .get();
  if (session) {
    if (session.status === 'pending') {
      ws.send(JSON.stringify({ type: 'history', data: '' }));
      if (!pendingConnections.has(sessionId)) {
        pendingConnections.set(sessionId, new Set());
      }
      pendingConnections.get(sessionId)!.add(ws);
      return true;
    }

    if (session.status === 'running') {
      // DB says running but not in activeSessions — try tmux recovery
      if (tryRecoverSession(session)) {
        const recovered = activeSessions.get(sessionId)!;
        ws.send(JSON.stringify({ type: 'history', data: stripTerminalFillRuns(recovered.outputBuffer), cols: recovered.ptyProcess.cols, rows: recovered.ptyProcess.rows }));
        recovered.adminSockets.add(ws);
        return true;
      }
      const tmuxAvailable = isTmuxAvailable();
      const tmuxExists = tmuxAvailable ? tmuxSessionExists(sessionId) : false;
      if (!tmuxAvailable || tmuxExists) {
        appendSessionAuditMarker(
          sessionId,
          `session-service WebSocket attach could not recover running DB row; left running because tmuxAvailable=${tmuxAvailable} tmuxExists=${tmuxExists}`
        );
        ws.send(JSON.stringify({ type: 'history', data: stripTerminalFillRuns(session.outputLog || '') }));
        return true;
      }
      // Recovery failed and the backing tmux session is definitively gone.
      markSessionStale(sessionId);
      ws.send(JSON.stringify({ type: 'history', data: stripTerminalFillRuns(session.outputLog || '') }));
      ws.send(JSON.stringify({
        type: 'exit',
        exitCode: -1,
        status: 'failed',
      }));
      return true;
    }

    // Completed/failed/killed — send history + exit
    ws.send(JSON.stringify({ type: 'history', data: stripTerminalFillRuns(session.outputLog || '') }));
    ws.send(JSON.stringify({
      type: 'exit',
      exitCode: session.exitCode,
      status: session.status,
    }));
    return true;
  }

  return false;
}

function handleReplayRequest(sessionId: string, fromSeq: number, ws: WebSocket): void {
  const unacked = messageBuffer.getUnacked(sessionId, 'output', fromSeq);
  for (const entry of unacked) {
    try {
      ws.send(entry.content);
    } catch {
      break;
    }
  }
}

function detachAdminSocket(sessionId: string, ws: WebSocket): void {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    proc.adminSockets.delete(ws);
    // Drop this viewer's size and shrink the PTY back to the remaining viewers
    // so a closed large pane doesn't leave the PTY pinned wider/taller than any
    // pane still showing the session.
    if (proc.clientSizes.delete(ws) && proc.clientSizes.size > 0) {
      applyEffectiveSize(proc);
    }
  }
  const pending = pendingConnections.get(sessionId);
  if (pending) {
    pending.delete(ws);
    if (pending.size === 0) pendingConnections.delete(sessionId);
  }
}

// ---------- Session recovery ----------

function recoverSessions(): void {
  if (!isTmuxAvailable()) {
    // No tmux is an inconclusive service health state, not proof every
    // persisted session has exited. Leave DB rows running so they can recover
    // after tmux becomes available; main-server cleanup also treats this as
    // inconclusive.
    const runningCount = db.select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.status, 'running'))
      .all().length;
    if (runningCount > 0) {
      console.warn(`[session-service] Recovery skipped: tmux unavailable; leaving ${runningCount} running DB sessions unchanged`);
    }
    return;
  }

  // Try to recover each running session from its tmux session
  const running = db.select().from(schema.agentSessions)
    .where(eq(schema.agentSessions.status, 'running'))
    .all();

  let recovered = 0;
  let markedFailed = 0;
  let leftRecoverable = 0;
  for (const session of running) {
    if (tryRecoverSession(session)) {
      recovered++;
    } else {
      const tmuxStillExists = tmuxSessionExists(session.id);
      if (tmuxStillExists) {
        appendSessionAuditMarker(session.id, 'session-service startup recovery could not attach, but tmux still exists; left running');
        leftRecoverable++;
        continue;
      }
      appendSessionAuditMarker(session.id, 'session-service startup recovery found no tmux session; marked failed');
      db.update(schema.agentSessions)
        .set({ status: 'failed', completedAt: new Date().toISOString() })
        .where(eq(schema.agentSessions.id, session.id))
        .run();
      markedFailed++;
    }
  }

  if (running.length > 0) {
    console.log(`[session-service] Recovery: ${recovered}/${running.length} sessions recovered from tmux; markedFailed=${markedFailed}; leftRecoverable=${leftRecoverable}`);
  }
}

// ---------- HTTP API ----------

const app = new Hono();

app.get('/health', (c) => {
  return c.json({
    ok: true,
    activeSessions: activeSessions.size,
    sessions: Array.from(activeSessions.keys()),
    tmuxAvailable: isTmuxAvailable(),
    tmuxSessions: isTmuxAvailable() ? listPwTmuxSessions() : [],
  });
});

app.get('/waiting', (c) => {
  const states: Record<string, { inputState: InputState }> = {};
  for (const [id, proc] of activeSessions) {
    if (proc.inputState !== 'active') {
      states[id] = { inputState: proc.inputState };
    }
  }
  return c.json(states);
});

app.post('/spawn', async (c) => {
  const body = await c.req.json();
  const { sessionId, prompt, cwd, runtime, permissionProfile, allowedTools, claudeSessionId, resumeSessionId, appendSystemPrompt } = body;

  if (!sessionId || !cwd || !permissionProfile) {
    return c.json({ error: 'Missing required fields' }, 400);
  }
  if (permissionProfile === 'headless-yolo' && !prompt && !resumeSessionId) {
    return c.json({ error: 'Prompt required for headless sessions' }, 400);
  }

  try {
    spawnSession({ sessionId, prompt, cwd, runtime, permissionProfile, allowedTools, claudeSessionId, resumeSessionId, appendSystemPrompt });
    return c.json({ ok: true, sessionId });
  } catch (err) {
    const pending = pendingConnections.get(sessionId);
    if (pending) {
      for (const ws of pending) {
        try {
          ws.send(JSON.stringify({ type: 'exit', exitCode: -1, status: 'failed' }));
        } catch { /* ignore */ }
      }
      pendingConnections.delete(sessionId);
    }
    const msg = err instanceof Error ? err.message : 'Spawn failed';
    return c.json({ error: msg }, 400);
  }
});

app.post('/kill/:id', (c) => {
  const id = c.req.param('id');
  const killed = killSessionProcess(id);
  if (!killed) {
    return c.json({ error: 'Session not running or not found' }, 404);
  }
  return c.json({ ok: true, id });
});

app.post('/resize/:id', async (c) => {
  const id = c.req.param('id');
  const { cols, rows } = await c.req.json();
  resizeSessionProcess(id, cols, rows);
  return c.json({ ok: true });
});

app.post('/input/:id', async (c) => {
  const id = c.req.param('id');
  const { data } = await c.req.json();
  writeToSession(id, data);
  return c.json({ ok: true });
});

app.post('/send-keys/:id', async (c) => {
  const id = c.req.param('id');
  const { keys, enter } = await c.req.json();
  sendKeysToSession(id, String(keys || ''), enter !== false);
  return c.json({ ok: true });
});

app.get('/status/:id', (c) => {
  const id = c.req.param('id');
  const proc = activeSessions.get(id);
  if (proc) {
    return c.json({
      status: proc.status,
      active: true,
      outputSeq: proc.outputSeq,
      totalBytes: proc.totalBytes,
      healthy: isSessionHealthy(proc),
      inputState: proc.inputState,
    });
  }
  const session = db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, id))
    .get();
  if (session) {
    if (session.status === 'running') {
      const recoveryAttempted = true;
      const tmuxAvailable = isTmuxAvailable();
      const recoverySucceeded = tryRecoverSession(session);
      if (recoverySucceeded) {
        const recovered = activeSessions.get(id)!;
        return c.json({
          status: recovered.status,
          active: true,
          outputSeq: recovered.outputSeq,
          totalBytes: recovered.totalBytes,
          healthy: isSessionHealthy(recovered),
          inputState: recovered.inputState,
          tmuxExists: true,
          tmuxAvailable,
          recoveryAttempted,
          recoverySucceeded,
        });
      }
      const tmuxExists = tmuxAvailable ? tmuxSessionExists(id) : undefined;
      return c.json({
        status: session.status,
        active: false,
        outputSeq: session.lastOutputSeq,
        totalBytes: session.outputBytes || 0,
        healthy: tmuxAvailable && tmuxExists === false ? false : null,
        tmuxAvailable,
        tmuxExists,
        recoveryAttempted,
        recoverySucceeded,
      });
    }
    return c.json({
      status: session.status,
      active: false,
      outputSeq: session.lastOutputSeq,
      totalBytes: session.outputBytes || 0,
      healthy: session.status === 'running' ? false : null,
    });
  }
  return c.json({ error: 'Not found' }, 404);
});

app.get('/capture/:id', (c) => {
  const id = c.req.param('id');
  const proc = activeSessions.get(id);
  if (proc) {
    return c.json({ ok: true, content: proc.outputBuffer.slice(-10000) });
  }
  const session = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id)).get();
  if (session?.outputLog) {
    return c.json({ ok: true, content: session.outputLog.slice(-10000) });
  }
  return c.json({ error: 'Not found' }, 404);
});


// ---------- WebSocket server ----------

const wsServer = new WebSocketServer({ noServer: true });

wsServer.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    ws.close(4001, 'Missing sessionId');
    return;
  }

  const attached = attachAdminSocket(sessionId, ws);
  if (!attached) {
    ws.close(4004, 'Session not found');
    return;
  }

  console.log(`[session-service] WS attached to session: ${sessionId}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        // Legacy messages
        case 'input':
          writeToSession(sessionId, msg.data);
          break;
        case 'resize':
          resizeSessionProcess(sessionId, msg.cols, msg.rows, ws);
          break;
        case 'kill':
          killSessionProcess(sessionId);
          break;

        // Sequenced protocol messages
        case 'sequenced_input': {
          const proc = activeSessions.get(sessionId);
          if (!proc) break;
          // Dedup: only process if seq is new
          if (msg.seq > proc.lastInputAckSeq) {
            proc.lastInputAckSeq = msg.seq;
            const content = msg.content;
            if (content.kind === 'input' && content.data) {
              writeToSession(sessionId, content.data);
            } else if (content.kind === 'resize' && content.cols && content.rows) {
              resizeSessionProcess(sessionId, content.cols, content.rows, ws);
            } else if (content.kind === 'kill') {
              killSessionProcess(sessionId);
            }
          }
          // Always send ack
          ws.send(JSON.stringify({
            type: 'input_ack',
            sessionId,
            ackSeq: msg.seq,
          }));
          break;
        }

        case 'output_ack':
          messageBuffer.ack(sessionId, 'output', msg.ackSeq);
          break;

        case 'replay_request':
          handleReplayRequest(sessionId, msg.fromSeq, ws);
          break;
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    detachAdminSocket(sessionId, ws);
    console.log(`[session-service] WS detached from session: ${sessionId}`);
  });
});

// ---------- Start ----------

recoverSessions();

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[session-service] Running on http://localhost:${PORT}`);
});

(server as unknown as Server).on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/ws/agent-session') {
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------- Graceful shutdown ----------

function shutdown() {
  console.log('[session-service] Shutting down...');
  for (const [sessionId, proc] of activeSessions) {
    clearInterval(proc.flushTimer);
    flushOutput(sessionId);
    console.log(`[session-service] Detaching PTY client for session ${sessionId}`);
    try { proc.ptyProcess.kill(); } catch { /* already dead */ }
  }
  messageBuffer.destroy();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
