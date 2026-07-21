import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { lastTerminalInput } from '../../lib/sessions.js';
import { copyText } from '../../lib/clipboard.js';
import { openUrlCompanion } from '../../lib/companion-state.js';
import { recordPerfEntry } from '../../lib/perf.js';
import { useSessionFileDrop, SessionDropOverlay } from './SessionFileDrop.js';
import type { InputState } from '../../lib/sessions.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BACKOFF_CAP_MS = 30_000;

// Stagger terminal mounts to avoid overwhelming the browser on page load.
// At most MOUNT_CONCURRENCY xterm instances initialize simultaneously; the
// rest wait in a FIFO queue with MOUNT_STAGGER_MS between grants.
const MOUNT_CONCURRENCY = 2;
const MOUNT_STAGGER_MS = 150;
let _mountActive = 0;
const _mountQueue: Array<() => void> = [];

function drainMountQueue() {
  while (_mountActive < MOUNT_CONCURRENCY && _mountQueue.length > 0) {
    const next = _mountQueue.shift()!;
    _mountActive++;
    setTimeout(next, MOUNT_STAGGER_MS);
  }
}

// Acquire a mount slot. `granted` resolves when it's this caller's turn.
// `release` returns the slot (idempotent); if called before grant, removes
// the waiter from the queue without touching _mountActive.
function acquireMountSlot(): { granted: Promise<void>; release: () => void } {
  let grantResolve!: () => void;
  const granted = new Promise<void>((resolve) => { grantResolve = resolve; });
  let state: 'waiting' | 'granted' | 'released' = 'waiting';
  const grant = () => {
    if (state !== 'waiting') return;
    state = 'granted';
    grantResolve();
  };
  const release = () => {
    if (state === 'released') return;
    if (state === 'granted') {
      state = 'released';
      _mountActive = Math.max(0, _mountActive - 1);
      drainMountQueue();
    } else {
      state = 'released';
      const idx = _mountQueue.indexOf(grant);
      if (idx >= 0) _mountQueue.splice(idx, 1);
    }
  };
  if (_mountActive < MOUNT_CONCURRENCY) {
    _mountActive++;
    grant();
  } else {
    _mountQueue.push(grant);
  }
  return { granted, release };
}

// Truncate history data to last N bytes before writing to terminal.
// xterm.js has to parse every byte even with scrollback: 0, so writing
// 500KB of escape sequences per terminal is very expensive on page load.
const MAX_HISTORY_BYTES = 40_000;
function truncateHistory(data: string): string {
  if (data.length <= MAX_HISTORY_BYTES) return data;
  return data.slice(-MAX_HISTORY_BYTES);
}

const MAX_TERMINAL_WRITE_BATCH_BYTES = 32_000;
const SLOW_TERMINAL_WRITE_MS = 80;

// Global resize ownership: only one terminal instance per session sends resize
// commands to the server. When two AgentTerminals show the same session (e.g.
// main pane + autojump popout), competing resizes with different dimensions
// cause the PTY to thrash and the content to blink. The most recently focused
// terminal claims ownership.
const resizeOwners = new Map<string, symbol>();

interface AgentTerminalProps {
  sessionId: string;
  isActive?: boolean;
  onExit?: (exitCode: number, terminalText: string) => void;
  onInputStateChange?: (state: InputState) => void;
  onLoginRequired?: (companionSessionId: string) => void;
}

export function AgentTerminal({ sessionId, isActive, onExit, onInputStateChange, onLoginRequired }: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cleanedUp = useRef(false);
  const hasExited = useRef(false);
  const safeFitAndResizeRef = useRef<(bounce?: boolean) => void>(() => {});
  const [mountReady, setMountReady] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const fileDrop = useSessionFileDrop(sessionId);

  // Staggered mount: wait for our turn in the queue. The slot is held for
  // MOUNT_STAGGER_MS after we're allowed to mount, then released so the next
  // queued mount can start — we do NOT hold the slot for the lifetime of the
  // terminal (that would permanently cap mounts at MOUNT_CONCURRENCY).
  useEffect(() => {
    let cancelled = false;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const { granted, release } = acquireMountSlot();
    granted.then(() => {
      if (cancelled) {
        release();
        return;
      }
      setMountReady(true);
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        release();
      }, MOUNT_STAGGER_MS);
    });
    return () => {
      cancelled = true;
      if (releaseTimer) clearTimeout(releaseTimer);
      release();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!containerRef.current || !mountReady) return;
    cleanedUp.current = false;
    hasExited.current = false;

    // Claim resize ownership for this session instance
    const ownerToken = Symbol();
    resizeOwners.set(sessionId, ownerToken);
    const isResizeOwner = () => resizeOwners.get(sessionId) === ownerToken;
    const claimResizeOwnership = () => { resizeOwners.set(sessionId, ownerToken); };

    const term = new Terminal({
      cursorBlink: true,
      rightClickSelectsWord: false,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: "'SF Mono', Monaco, 'Cascadia Code', monospace",
      theme: {
        background: '#1e293b',
        foreground: '#e2e8f0',
        cursor: '#93c5fd',
        selectionBackground: '#334155',
        black: '#1e293b',
        red: '#f87171',
        green: '#facc15',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#fb923c',
        cyan: '#facc15',
        white: '#e2e8f0',
        brightBlack: '#64748b',
        brightRed: '#fca5a5',
        brightGreen: '#fde047',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#bae6fd',
        brightCyan: '#38bdf8',
        brightWhite: '#f8fafc',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // OSC 52 clipboard writes (write-only). TUIs that enable mouse reporting
    // (Claude Code) handle text selection themselves and copy via OSC 52;
    // xterm.js core ignores the sequence, so without this handler "highlight
    // then copy" silently does nothing. Queries ('?') are deliberately not
    // answered — no PTY app gets to read the user's clipboard.
    const osc52Dispose = term.parser.registerOscHandler(52, (data: string) => {
      const semi = data.indexOf(';');
      if (semi === -1) return true;
      const payload = data.slice(semi + 1);
      if (payload === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      } catch { /* malformed base64 — ignore */ }
      return true;
    });

    term.open(containerRef.current);

    // Only fit if container is visible (non-zero size); hidden tabs fit on activation
    if (containerRef.current.offsetWidth > 0) {
      fit.fit();
    }
    // Silently connect — no visible text to avoid flash on mount

    termRef.current = term;
    fitRef.current = fit;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 200;
    let reconnectAttempts = 0;
    let gotFirstOutput = false;
    let waitingDots: ReturnType<typeof setInterval> | null = null;
    let outputQueue = '';
    let outputWriteActive = false;
    let outputFlushScheduled = false;
    let outputFlushRaf = 0;
    let terminalDisposed = false;

    function scheduleOutputFlush(viaRaf = false) {
      if (terminalDisposed || outputFlushScheduled || outputWriteActive) return;
      outputFlushScheduled = true;
      // rAF is frozen in hidden tabs — scheduling the drain on it while the
      // tab is hidden stalls the queue, so hours of output pile up and then
      // replay chunk-by-chunk on return (visible as erratic scroll/flicker).
      if (viaRaf && !document.hidden) {
        outputFlushRaf = requestAnimationFrame(flushOutputQueue);
      } else {
        queueMicrotask(flushOutputQueue);
      }
    }

    function updateScrollState() {
      if (terminalDisposed) return;
      const buf = term.buffer.active;
      setShowScrollDown(buf.baseY - buf.viewportY > 1);
    }

    function flushOutputQueue() {
      outputFlushScheduled = false;
      outputFlushRaf = 0;
      if (terminalDisposed || outputWriteActive || !outputQueue) return;
      // Batching to 32KB keeps visible writes smooth, but each batch paints
      // (and auto-scrolls) once — replaying a large backlog that way flickers
      // for seconds. While hidden nothing paints, and for an oversized backlog
      // (tab was hidden/throttled) one big write is better: xterm slices
      // parsing internally and coalesces rendering on rAF, so the terminal
      // settles in a single jump instead of scrolling erratically.
      const batchBytes = document.hidden || outputQueue.length > MAX_TERMINAL_WRITE_BATCH_BYTES * 4
        ? outputQueue.length
        : MAX_TERMINAL_WRITE_BATCH_BYTES;
      const chunk = outputQueue.slice(0, batchBytes);
      outputQueue = outputQueue.slice(chunk.length);
      outputWriteActive = true;
      const writeStart = performance.now();
      term.write(chunk, () => {
        const duration = performance.now() - writeStart;
        if (duration >= SLOW_TERMINAL_WRITE_MS) {
          recordPerfEntry(`terminal:write:${Math.ceil(chunk.length / 1024)}KB`, duration);
        }
        outputWriteActive = false;
        updateScrollState();
        if (!terminalDisposed && outputQueue) scheduleOutputFlush(true);
      });
    }

    const scrollDispose = term.onScroll(updateScrollState);

    function writeTerminal(data: string) {
      if (terminalDisposed || !data) return;
      outputQueue += data;
      scheduleOutputFlush(false);
    }

    // Sequenced protocol state
    let lastOutputSeq = 0;
    let inputSeq = 0;
    const pendingInputs = new Map<number, string>();

    // Resize bookkeeping (see safeFitAndResize). serverPtySize comes from the
    // session-service history message; lastSentSize is per WebSocket connection
    // because the server tracks viewer sizes per socket.
    let serverPtySize: { cols: number; rows: number } | null = null;
    let historyTruncated = false;
    let lastSentSize: { cols: number; rows: number } | null = null;
    let sawHistoryData = false;

    function sendRawInput(data: string) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        inputSeq++;
        const msg = JSON.stringify({
          type: 'sequenced_input',
          sessionId,
          seq: inputSeq,
          content: { kind: 'input', data },
          timestamp: new Date().toISOString(),
        });
        pendingInputs.set(inputSeq, msg);
        ws.send(msg);
      }
    }

    function onContextMenu(e: Event) {
      e.preventDefault();
    }

    const xtermScreen = containerRef.current.querySelector('.xterm-screen');
    if (xtermScreen) {
      xtermScreen.addEventListener('contextmenu', onContextMenu);
    }

    // Cmd/Ctrl-C with no xterm selection: the browser's default action copies
    // the (empty) hidden helper textarea, wiping whatever is on the clipboard.
    // That clobbers the OSC 52 copy a TUI just made from its own selection —
    // the "highlight in claude, press Cmd-C, paste is empty" bug. With a real
    // xterm selection, xterm's own copy handler takes over before default.
    function onCopyGuard(e: Event) {
      if (!term.hasSelection()) e.preventDefault();
    }
    containerRef.current.addEventListener('copy', onCopyGuard);

    // ---- Ctrl+mouse: text selection & context menu ----
    const selOverlay = document.createElement('div');
    selOverlay.className = 'pty-sel-overlay';
    const xtermScreenEl = xtermScreen as HTMLElement | null;
    if (xtermScreenEl) xtermScreenEl.appendChild(selOverlay);

    const ctxMenu = document.createElement('div');
    ctxMenu.className = 'pty-ctx-menu';
    document.body.appendChild(ctxMenu);
    ctxMenu.style.display = 'none';

    let selStartPos: { row: number; col: number } | null = null;
    let selEndPos: { row: number; col: number } | null = null;
    let isDragSelecting = false;
    let ctrlSelectedText = '';

    function termPosFromEvent(ev: MouseEvent) {
      if (!xtermScreenEl) return { row: 0, col: 0 };
      const r = xtermScreenEl.getBoundingClientRect();
      return {
        col: Math.max(0, Math.min(term.cols - 1, Math.floor((ev.clientX - r.left) / (r.width / term.cols)))),
        row: Math.max(0, Math.min(term.rows - 1, Math.floor((ev.clientY - r.top) / (r.height / term.rows)))),
      };
    }

    function bufLineText(row: number): string {
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
      if (!line) return '';
      let t = '';
      for (let i = 0; i < term.cols; i++) {
        const c = line.getCell(i);
        t += c ? (c.getChars() || ' ') : ' ';
      }
      return t;
    }

    function rangeText(a: { row: number; col: number }, b: { row: number; col: number }): string {
      let r1 = a.row, c1 = a.col, r2 = b.row, c2 = b.col;
      if (r1 > r2 || (r1 === r2 && c1 > c2)) [r1, c1, r2, c2] = [r2, c2, r1, c1];
      const lines: string[] = [];
      for (let r = r1; r <= r2; r++) {
        const lt = bufLineText(r);
        lines.push(lt.slice(r === r1 ? c1 : 0, r === r2 ? c2 + 1 : lt.length));
      }
      return lines.map(l => l.trimEnd()).join('\n');
    }

    function wordAt(row: number, col: number): string {
      const ln = bufLineText(row);
      if (col >= ln.length || ln[col] === ' ') return '';
      const wc = /[a-zA-Z0-9_\-./~:@#?&=%+]/;
      let s = col, e = col;
      while (s > 0 && wc.test(ln[s - 1])) s--;
      while (e < ln.length - 1 && wc.test(ln[e + 1])) e++;
      return ln.slice(s, e + 1).trim();
    }

    function linkAt(row: number, col: number): string | null {
      const ln = bufLineText(row);
      const re = /https?:\/\/[^\s<>'")\]]+/g;
      let m;
      while ((m = re.exec(ln)) !== null) {
        if (col >= m.index && col < m.index + m[0].length) return m[0];
      }
      return null;
    }

    function selCellSize() {
      if (!xtermScreenEl) return { w: 8, h: 16 };
      const r = xtermScreenEl.getBoundingClientRect();
      return { w: r.width / term.cols, h: r.height / term.rows };
    }

    function renderSel() {
      selOverlay.innerHTML = '';
      if (!selStartPos || !selEndPos) return;
      let r1 = selStartPos.row, c1 = selStartPos.col, r2 = selEndPos.row, c2 = selEndPos.col;
      if (r1 > r2 || (r1 === r2 && c1 > c2)) [r1, c1, r2, c2] = [r2, c2, r1, c1];
      const { w: cw, h: ch } = selCellSize();
      for (let r = r1; r <= r2; r++) {
        const sc = r === r1 ? c1 : 0;
        const ec = r === r2 ? c2 : term.cols - 1;
        const hl = document.createElement('div');
        hl.className = 'pty-sel-hl';
        hl.style.cssText = `left:${sc * cw}px;top:${r * ch}px;width:${(ec - sc + 1) * cw}px;height:${ch}px`;
        selOverlay.appendChild(hl);
      }
    }

    function clearSel() {
      selStartPos = null;
      selEndPos = null;
      ctrlSelectedText = '';
      selOverlay.innerHTML = '';
    }

    function capturePaneText(): string {
      const lines: string[] = [];
      for (let i = 0; i < term.rows; i++) lines.push(bufLineText(i).trimEnd());
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    }

    function hideCtxMenu() { ctxMenu.style.display = 'none'; ctxMenu.innerHTML = ''; }

    function showCtxMenu(ev: MouseEvent) {
      const pos = termPosFromEvent(ev);
      const items: { label: string; action: () => void }[] = [];

      if (ctrlSelectedText) {
        items.push({ label: 'Copy selected text', action: () => copyText(ctrlSelectedText) });
      }

      const w = wordAt(pos.row, pos.col);
      if (w && w !== ctrlSelectedText) {
        const p = w.length > 30 ? w.slice(0, 30) + '\u2026' : w;
        items.push({ label: `Copy "${p}"`, action: () => copyText(w) });
      }

      const sentence = bufLineText(pos.row).trim();
      if (sentence && sentence !== w) {
        const p = sentence.length > 40 ? sentence.slice(0, 40) + '\u2026' : sentence;
        items.push({ label: `Copy "${p}"`, action: () => copyText(sentence) });
      }

      items.push({ label: 'Copy pane to clipboard', action: () => copyText(capturePaneText()) });

      const lnk = linkAt(pos.row, pos.col);
      if (lnk) {
        const p = lnk.length > 40 ? lnk.slice(0, 40) + '\u2026' : lnk;
        items.push({ label: `Open ${p}`, action: () => window.open(lnk, '_blank') });
      }

      // Detect file paths and offer to open in a pane via /files/* route
      const pathWord = w || '';
      if (/^(\/|~\/)/.test(pathWord) && pathWord.length > 1) {
        const filePath = pathWord.startsWith('~/') ? `/home/${pathWord.slice(2)}` : pathWord;
        const fileUrl = `/files${filePath}`;
        const pLabel = pathWord.length > 35 ? pathWord.slice(0, 35) + '\u2026' : pathWord;
        items.push({ label: `Open "${pLabel}" in pane`, action: () => {
          openUrlCompanion(`${location.protocol}//${location.host}${fileUrl}`);
        }});
      }

      ctxMenu.innerHTML = '';
      for (const it of items) {
        const btn = document.createElement('button');
        btn.textContent = it.label;
        btn.addEventListener('click', () => { it.action(); hideCtxMenu(); });
        ctxMenu.appendChild(btn);
      }
      ctxMenu.style.display = 'block';
      ctxMenu.style.left = `${ev.clientX}px`;
      ctxMenu.style.top = `${ev.clientY}px`;
      requestAnimationFrame(() => {
        const cr = ctxMenu.getBoundingClientRect();
        if (cr.right > window.innerWidth) ctxMenu.style.left = `${window.innerWidth - cr.width - 4}px`;
        if (cr.bottom > window.innerHeight) ctxMenu.style.top = `${window.innerHeight - cr.height - 4}px`;
      });
    }

    function onDragMove(ev: MouseEvent) {
      ev.preventDefault();
      selEndPos = termPosFromEvent(ev);
      renderSel();
    }

    function onDragEnd(ev: MouseEvent) {
      isDragSelecting = false;
      selEndPos = termPosFromEvent(ev);
      renderSel();
      if (selStartPos && selEndPos && (selStartPos.row !== selEndPos.row || selStartPos.col !== selEndPos.col)) {
        ctrlSelectedText = rangeText(selStartPos, selEndPos);
      }
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
    }

    function onCtrlMouseDown(ev: MouseEvent) {
      hideCtxMenu();
      if (ev.ctrlKey && ev.button === 0) {
        ev.stopPropagation();
        ev.preventDefault();
        selStartPos = termPosFromEvent(ev);
        selEndPos = { ...selStartPos };
        isDragSelecting = true;
        ctrlSelectedText = '';
        renderSel();
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
      } else if (ev.ctrlKey && ev.button === 2) {
        ev.stopPropagation();
        const onCtrlRightUp = (upEv: MouseEvent) => {
          document.removeEventListener('mouseup', onCtrlRightUp);
          showCtxMenu(upEv);
        };
        document.addEventListener('mouseup', onCtrlRightUp);
      } else {
        clearSel();
      }
    }

    function onDocClickDismiss(ev: MouseEvent) {
      if (ctxMenu.style.display !== 'none' && !ctxMenu.contains(ev.target as Node)) hideCtxMenu();
    }

    function onEscDismiss(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        if (ctxMenu.style.display !== 'none') {
          hideCtxMenu();
          ev.stopPropagation();
          ev.preventDefault();
          return;
        }
        if (selStartPos) clearSel();
      }
    }

    const container = containerRef.current;
    container.addEventListener('mousedown', onCtrlMouseDown, true);
    document.addEventListener('click', onDocClickDismiss);
    document.addEventListener('keydown', onEscDismiss, true);

    function sendOutputAck(seq: number) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output_ack', sessionId, ackSeq: seq }));
      }
    }

    function sendReplayRequest() {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && lastOutputSeq > 0) {
        ws.send(JSON.stringify({ type: 'replay_request', sessionId, fromSeq: lastOutputSeq }));
      }
    }

    function resendPendingInputs() {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const [seq, serialized] of pendingInputs) {
        try { ws.send(serialized); } catch { break; }
      }
    }

    function handleOutput(data: string) {
      if (!gotFirstOutput) {
        gotFirstOutput = true;
        if (waitingDots) { clearInterval(waitingDots); waitingDots = null; }
        // First live output with no prior history means the session just
        // spawned (we may have attached while it was still pending, when
        // resizes are dropped server-side) — force a size re-send.
        lastSentSize = null;
        setTimeout(() => safeFitAndResize(true), 80);
      }
      writeTerminal(data);
    }

    function connect() {
      if (cleanedUp.current) return;

      // New socket = the server has no size on record for it yet.
      lastSentSize = null;

      const token = localStorage.getItem('pw-admin-token');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/agent-session?sessionId=${sessionId}&token=${token}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 200;
        reconnectAttempts = 0;
        sendReplayRequest();
        resendPendingInputs();
        // Sync terminal size with server on (re)connect. Send immediately so a
        // PTY at a different size starts reflowing before history even paints;
        // the delayed retry covers containers whose layout hadn't settled yet
        // (dedupe makes it a no-op when the first send went through).
        safeFitAndResize();
        setTimeout(() => safeFitAndResize(true), 50);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            // Sequenced protocol
            case 'sequenced_output': {
              const seq: number = msg.seq;
              if (seq <= lastOutputSeq) break; // dedup
              lastOutputSeq = seq;
              const content = msg.content;
              if (content.kind === 'output' && content.data) {
                handleOutput(content.data);
              } else if (content.kind === 'exit') {
                const paneText = capturePaneText();
                writeTerminal(`\r\n\x1b[33m--- Session exited (code: ${content.exitCode ?? 'unknown'}) ---\x1b[0m\r\n`);
                hasExited.current = true;
                onExit?.(content.exitCode ?? -1, paneText);
                onInputStateChange?.('active');
              } else if (content.kind === 'error' && content.data) {
                writeTerminal(`\r\n\x1b[31m${content.data}\x1b[0m\r\n`);
              } else if (content.kind === 'input_state') {
                onInputStateChange?.(content.state || 'active');
              } else if (content.kind === 'login_required' && content.companionSessionId) {
                onInputStateChange?.('waiting');
                onLoginRequired?.(content.companionSessionId);
              }
              sendOutputAck(seq);
              break;
            }

            case 'input_ack': {
              pendingInputs.delete(msg.ackSeq);
              break;
            }

            // Legacy messages
            case 'history':
              // Resume input seq from server's last acknowledged seq
              if (typeof msg.lastInputAckSeq === 'number' && msg.lastInputAckSeq > inputSeq) {
                inputSeq = msg.lastInputAckSeq;
              }
              if (msg.inputState) {
                onInputStateChange?.(msg.inputState);
              }
              if (typeof msg.cols === 'number' && typeof msg.rows === 'number' && msg.cols > 0 && msg.rows > 0) {
                serverPtySize = { cols: msg.cols, rows: msg.rows };
              }
              if (msg.data) {
                if (waitingDots) { clearInterval(waitingDots); waitingDots = null; }
                historyTruncated = msg.data.length > MAX_HISTORY_BYTES;
                // History is a full snapshot of the PTY. If the terminal
                // already has content — the main server sends a DB-snapshot
                // history and the session-service bridge then sends the live
                // buffer; reconnects re-send it too — the snapshot must
                // REPLACE the screen, not append after it (appending scrolls
                // the whole conversation through the pane on every reload).
                // RIS (\x1bc) goes through the write queue so it stays
                // ordered relative to any output already queued.
                const replacing = sawHistoryData || gotFirstOutput;
                sawHistoryData = true;
                gotFirstOutput = true;
                writeTerminal((replacing ? '\x1bc' : '') + truncateHistory(msg.data));
                // Popped-out / newly-mounted terminals can open with a 0-size
                // container (split pane not yet laid out), in which case the
                // initial fit.fit() in the mount effect was skipped. Once
                // history arrives the container is almost always sized — fit
                // + refresh so the buffered content actually paints instead
                // of sitting invisibly in an unrendered viewport. Using
                // safeFitAndResize (not bare fit) also corrects a PTY whose
                // size differs from this pane RIGHT NOW instead of waiting
                // for the delayed onopen resize — the shorter that window,
                // the shorter the mis-wrapped flash when loading a session
                // that was last viewed at a different size.
                queueMicrotask(() => {
                  const el = containerRef.current;
                  if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
                  try {
                    // History arriving proves the full pipeline (browser →
                    // main server → session-service) is up; a resize sent
                    // right at onopen may have raced a still-connecting hop
                    // and been dropped, so re-send unconditionally. A
                    // same-size resize is a server-side no-op (no SIGWINCH).
                    lastSentSize = null;
                    safeFitAndResize();
                    term.refresh(0, term.rows - 1);
                    term.scrollToBottom();
                  } catch { /* xterm may still be initializing */ }
                });
              }
              break;
            case 'output':
              handleOutput(msg.data);
              break;
            case 'login_required':
              if (msg.companionSessionId) {
                onInputStateChange?.('waiting');
                onLoginRequired?.(msg.companionSessionId);
              }
              break;
            case 'exit': {
              const legacyPaneText = capturePaneText();
              writeTerminal(`\r\n\x1b[33m--- Session exited (code: ${msg.exitCode ?? 'unknown'}) ---\x1b[0m\r\n`);
              hasExited.current = true;
              onExit?.(msg.exitCode ?? -1, legacyPaneText);
              break;
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        wsRef.current = null;
        if (cleanedUp.current) return;

        if (event.code === 4003) {
          localStorage.removeItem('pw-admin-token');
          window.location.hash = '#/login';
          return;
        }

        if (hasExited.current || event.code === 4004 || event.code === 4001) {
          writeTerminal(`\r\n\x1b[90m--- Disconnected (${event.reason || event.code}) ---\x1b[0m\r\n`);
          if (event.code === 4004) onExit?.(-1, capturePaneText());
          return;
        }

        // Session service disconnected — use slower reconnect to avoid hammering
        if (event.code === 4010) {
          reconnectAttempts++;
          if (reconnectAttempts > 3) {
            writeTerminal('\r\n\x1b[90m--- Session service unavailable. Click terminal or press any key to retry. ---\x1b[0m\r\n');
            const retryHandler = term.onData(() => {
              retryHandler.dispose();
              reconnectAttempts = 0;
              reconnectDelay = 200;
              writeTerminal('\x1b[90mReconnecting...\x1b[0m\r\n');
              connect();
            });
            return;
          }
          reconnectTimer = setTimeout(() => connect(), 5000);
          return;
        }

        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          writeTerminal('\r\n\x1b[31m--- Connection lost. Click terminal or press any key to retry. ---\x1b[0m\r\n');
          const retryHandler = term.onData(() => {
            retryHandler.dispose();
            reconnectAttempts = 0;
            reconnectDelay = 200;
            writeTerminal('\x1b[90mReconnecting...\x1b[0m\r\n');
            connect();
          });
          return;
        }

        writeTerminal('\r\n\x1b[90m--- Disconnected, reconnecting... ---\x1b[0m\r\n');
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_BACKOFF_CAP_MS);
          connect();
        }, reconnectDelay);
      };
    }

    connect();

    // Terminal auto-response sequences (DA1, DA2, DSR cursor position report).
    // xterm.js generates these in response to queries from the shell. On reconnect
    // they arrive after the shell has timed out, causing visible junk in the PTY input.
    const TERMINAL_RESPONSE_RE = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+;\d+R/g;

    let inputBuffer = '';

    function flushInputBuffer() {
      if (!inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = '';
      sendRawInput(data);
    }

    term.onData((data: string) => {
      const filtered = data.replace(TERMINAL_RESPONSE_RE, '');
      if (!filtered) return;
      lastTerminalInput.value = Date.now();
      inputBuffer += filtered;
      flushInputBuffer();
    });

    function safeFitAndResize(bounce = false) {
      const el = containerRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      fit.fit();
      // Only the resize owner sends resize commands to the server.
      // Another terminal instance for the same session may exist (e.g. autojump).
      if (!isResizeOwner()) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        if (term.cols > 300 || term.rows > 120) return;
        const cols = term.cols;
        const rows = term.rows;
        const sentMatches = lastSentSize !== null && lastSentSize.cols === cols && lastSentSize.rows === rows;
        const serverMatches = serverPtySize !== null && serverPtySize.cols === cols && serverPtySize.rows === rows;
        // A "bounce" (rows-1 then rows) forces a SIGWINCH so the TUI repaints
        // even when the PTY size is unchanged (the kernel skips the signal for
        // same-size TIOCSWINSZ). That forced repaint is only needed when the
        // replayed history snapshot may have rendered unfaithfully (truncated
        // tail). When the size actually changed, the real resize below causes
        // the repaint on its own; when it didn't and the snapshot was complete,
        // bouncing just makes every pane flicker/scroll on reload and refocus.
        const sizeUnchanged = sentMatches || (lastSentSize === null && serverMatches);
        const doBounce = bounce && sizeUnchanged && historyTruncated;
        if (doBounce) historyTruncated = false; // one forced repaint is enough
        // Size already registered on this socket and no repaint needed — no-op.
        if (!doBounce && sentMatches) return;
        if (doBounce && term.rows > 1) {
          inputSeq++;
          const bounceMsg = JSON.stringify({
            type: 'sequenced_input',
            sessionId,
            seq: inputSeq,
            content: { kind: 'resize', cols, rows: rows - 1 },
            timestamp: new Date().toISOString(),
          });
          pendingInputs.set(inputSeq, bounceMsg);
          ws.send(bounceMsg);
        }
        inputSeq++;
        const msg = JSON.stringify({
          type: 'sequenced_input',
          sessionId,
          seq: inputSeq,
          content: { kind: 'resize', cols, rows },
          timestamp: new Date().toISOString(),
        });
        pendingInputs.set(inputSeq, msg);
        ws.send(msg);
        lastSentSize = { cols, rows };
      }
    }

    safeFitAndResizeRef.current = safeFitAndResize;

    let resizeLastFired = 0;
    let resizeRaf = 0;
    let resizeTrailing: ReturnType<typeof setTimeout> | null = null;
    let hasPainted = false;
    const RESIZE_THROTTLE_MS = 100;
    function fireResize() {
      resizeLastFired = performance.now();
      safeFitAndResize();
      // First time the container has real dimensions, force a repaint of
      // the buffer. fit.fit() alone is a no-op if xterm happened to land
      // on the same cols/rows, leaving buffered history invisible.
      const el = containerRef.current;
      if (!hasPainted && el && el.offsetWidth > 0 && el.offsetHeight > 0) {
        hasPainted = true;
        try { term.refresh(0, term.rows - 1); term.scrollToBottom(); } catch { /* initializing */ }
      }
    }
    const observer = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const elapsed = performance.now() - resizeLastFired;
        if (elapsed >= RESIZE_THROTTLE_MS) {
          fireResize();
        } else if (!resizeTrailing) {
          // Throttled — schedule a trailing call so the FINAL size of a
          // continuous drag/window-resize always reaches the PTY. Dropping
          // it left the terminal stuck at an intermediate size until the
          // next unrelated fit trigger.
          resizeTrailing = setTimeout(() => {
            resizeTrailing = null;
            fireResize();
          }, RESIZE_THROTTLE_MS - elapsed);
        }
      });
    });
    observer.observe(containerRef.current);

    // Bounce resize when terminal gets focus (click into it, tab into it, etc.)
    // Also claim resize ownership — the focused terminal should control sizing.
    function onTermFocus() { claimResizeOwnership(); safeFitAndResize(true); }
    term.textarea?.addEventListener('focus', onTermFocus);

    // Bounce resize when browser tab/window regains visibility
    function onVisibilityChange() {
      if (document.hidden) {
        // A flush parked on rAF freezes with the tab — reschedule it as a
        // microtask so output keeps draining while hidden instead of piling
        // up and replaying (with flicker) when the user comes back.
        if (outputFlushRaf) {
          cancelAnimationFrame(outputFlushRaf);
          outputFlushRaf = 0;
          outputFlushScheduled = false;
          scheduleOutputFlush(false);
        }
        return;
      }
      setTimeout(() => safeFitAndResize(true), 50);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Bounce resize when browser window regains focus
    function onWindowFocus() { setTimeout(() => safeFitAndResize(true), 50); }
    window.addEventListener('focus', onWindowFocus);

    return () => {
      cleanedUp.current = true;
      safeFitAndResizeRef.current = () => {};
      terminalDisposed = true;
      outputQueue = '';
      // Release resize ownership if we still hold it
      if (resizeOwners.get(sessionId) === ownerToken) resizeOwners.delete(sessionId);
      onInputStateChange?.('active');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (waitingDots) clearInterval(waitingDots);
      if (xtermScreen) {
        xtermScreen.removeEventListener('contextmenu', onContextMenu);
      }
      osc52Dispose.dispose();
      container.removeEventListener('copy', onCopyGuard);
      container.removeEventListener('mousedown', onCtrlMouseDown, true);
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      document.removeEventListener('click', onDocClickDismiss);
      document.removeEventListener('keydown', onEscDismiss, true);
      selOverlay.remove();
      ctxMenu.remove();
      term.textarea?.removeEventListener('focus', onTermFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
      flushInputBuffer();
      if (outputFlushRaf) cancelAnimationFrame(outputFlushRaf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (resizeTrailing) clearTimeout(resizeTrailing);
      scrollDispose.dispose();
      observer.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, mountReady]);

  useEffect(() => {
    if (!isActive || !fitRef.current || !termRef.current || !containerRef.current) return;
    const term = termRef.current;
    // Decide whether it's safe to focus this terminal as it becomes active.
    // We steal focus when either:
    //   (a) focus is already inside this terminal's panel (the user navigated
    //       here — e.g. clicked a tab in this panel), or
    //   (b) nothing meaningful currently holds focus (activeElement is body /
    //       html / null) — this is the case when a session is opened from the
    //       sidebar or via auto-jump, where focus is *not* in the panel yet but
    //       the user also isn't typing anywhere. Without (b) the PTY never
    //       receives focus on activation and the operator has to switch tabs
    //       and back before they can type into it.
    // We must NOT steal focus when the user is actively typing in some *other*
    // input/terminal (a signal-driven re-render can flip isActive on a pane the
    // user isn't looking at — e.g. syncAutoJumpPanel updating panel state).
    const container = containerRef.current;
    const panelEl = container.closest('[data-panel-id]') || container.closest('.global-terminal-panel');
    const focusInPanel = panelEl?.contains(document.activeElement) ?? false;
    const active = document.activeElement;
    const focusIdle = !active || active === document.body || active === document.documentElement;
    const shouldFocus = focusInPanel || focusIdle;
    // Wait for the browser to lay out the newly-visible container before fitting.
    // On macOS the kernel skips SIGWINCH when PTY size is unchanged, so we use
    // bounce=true to briefly send rows-1 then correct rows, forcing the PTY to
    // re-render.  Also call term.refresh() to repaint the xterm.js canvas
    // (content written while the tab was display:none may leave it stale).
    let cancelled = false;
    let rafId = 0;
    const attemptFitAndFocus = () => {
      if (cancelled) return;
      const rect = container.getBoundingClientRect();
      // If the container has no dimensions yet, the browser hasn't finished
      // laying out the newly-visible element. Retry next frame.
      if (rect.width === 0 || rect.height === 0) {
        rafId = requestAnimationFrame(attemptFitAndFocus);
        return;
      }
      safeFitAndResizeRef.current(true);
      term.refresh(0, term.rows - 1);
      if (shouldFocus) term.focus();
    };
    rafId = requestAnimationFrame(attemptFitAndFocus);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
    // mountReady: isActive may already be true when the terminal is still
    // queued for mount. Re-run once the main mount effect has populated
    // termRef/fitRef so the initial fit happens even without a tab toggle.
  }, [isActive, mountReady]);

  return (
    <div
      class="agent-terminal-wrap"
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onDragEnter={fileDrop.onDragEnter}
      onDragOver={fileDrop.onDragOver}
      onDragLeave={fileDrop.onDragLeave}
      onDrop={fileDrop.onDrop}
      onPasteCapture={fileDrop.onPaste}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} onClick={() => termRef.current?.focus()} />
      <SessionDropOverlay drop={fileDrop} />
      {showScrollDown && (
        <button
          type="button"
          class="cos-scroll-down-btn"
          onClick={() => {
            termRef.current?.scrollToBottom();
            setShowScrollDown(false);
            termRef.current?.focus();
          }}
          title="Scroll to latest"
          aria-label="Scroll to latest output"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}
