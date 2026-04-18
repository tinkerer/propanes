import { useEffect, useRef } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { lastTerminalInput } from '../lib/sessions.js';
import { copyText } from '../lib/clipboard.js';
import type { InputState } from '../lib/sessions.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BACKOFF_CAP_MS = 30_000;

interface AgentTerminalProps {
  sessionId: string;
  isActive?: boolean;
  onExit?: (exitCode: number, terminalText: string) => void;
  onInputStateChange?: (state: InputState) => void;
}

export function AgentTerminal({ sessionId, isActive, onExit, onInputStateChange }: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const cleanedUp = useRef(false);
  const hasExited = useRef(false);
  const safeFitAndResizeRef = useRef<(bounce?: boolean) => void>(() => {});

  useEffect(() => {
    if (!containerRef.current) return;
    cleanedUp.current = false;
    hasExited.current = false;

    const term = new Terminal({
      cursorBlink: true,
      rightClickSelectsWord: false,
      scrollback: 0,
      fontSize: 13,
      fontFamily: "'SF Mono', Monaco, 'Cascadia Code', monospace",
      theme: {
        background: '#1e293b',
        foreground: '#e2e8f0',
        cursor: '#a5b4fc',
        selectionBackground: '#334155',
        black: '#1e293b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#64748b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    // Only fit if container is visible (non-zero size); hidden tabs fit on activation
    if (containerRef.current.offsetWidth > 0) {
      fit.fit();
    }
    term.write('\x1b[90mConnecting...\x1b[0m');

    termRef.current = term;
    fitRef.current = fit;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = 200;
    let reconnectAttempts = 0;
    let gotFirstOutput = false;
    let waitingDots: ReturnType<typeof setInterval> | null = null;

    // Sequenced protocol state
    let lastOutputSeq = 0;
    let inputSeq = 0;
    const pendingInputs = new Map<number, string>();

    // --- Mouse mode tracking & manual mousemove injection ---
    // xterm.js doesn't reliably send mousemove in DECSET 1003 (any-event mode)
    // when no button is held. We track the mode from terminal output and inject
    // SGR mouse sequences ourselves so tmux popup menus get hover highlights.
    let mouseMode = 0;   // 0=off, 9/1000/1002/1003
    let sgrEncoding = false; // DECSET 1006

    function trackMouseModes(data: string) {
      const re = /\x1b\[\?(\d+)([hl])/g;
      let m;
      while ((m = re.exec(data)) !== null) {
        const mode = parseInt(m[1], 10);
        const enable = m[2] === 'h';
        switch (mode) {
          case 9: case 1000: case 1002: case 1003:
            mouseMode = enable ? mode : 0;
            break;
          case 1006:
            sgrEncoding = enable;
            break;
        }
      }
    }

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

    function injectMouseEvent(e: MouseEvent, cb: number, press: boolean) {
      const screen = containerRef.current?.querySelector('.xterm-screen');
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - rect.left) / (rect.width / term.cols)) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - rect.top) / (rect.height / term.rows)) + 1));
      if (sgrEncoding) {
        sendRawInput(`\x1b[<${cb};${col};${row}${press ? 'M' : 'm'}`);
      } else {
        sendRawInput(`\x1b[M${String.fromCharCode(cb + 32, col + 32, row + 32)}`);
      }
    }

    let lastMoveCol = -1;
    let lastMoveRow = -1;
    // Suppress motion injection while a tmux display-menu is likely open.
    // Right-click opens the menu; motion events dismiss it prematurely.
    let suppressMotion = false;

    function onMouseMove(e: MouseEvent) {
      if (mouseMode !== 1003) return;
      if (suppressMotion) return;
      // Only inject no-button moves; xterm.js handles button-held moves via onData
      if (e.buttons !== 0) return;
      const screen = containerRef.current?.querySelector('.xterm-screen');
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - rect.left) / (rect.width / term.cols)) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - rect.top) / (rect.height / term.rows)) + 1));
      if (col === lastMoveCol && row === lastMoveRow) return;
      lastMoveCol = col;
      lastMoveRow = row;
      // cb=35: motion (32) + no button (3)
      injectMouseEvent(e, 35, true);
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button === 2) {
        // Right-click opens a tmux display-menu; suppress motion until dismissed
        suppressMotion = true;
      } else {
        suppressMotion = false;
      }
    }

    function onContextMenu(e: Event) {
      e.preventDefault();
    }

    const xtermScreen = containerRef.current.querySelector('.xterm-screen');
    if (xtermScreen) {
      xtermScreen.addEventListener('contextmenu', onContextMenu);
      xtermScreen.addEventListener('mousemove', onMouseMove as EventListener);
      xtermScreen.addEventListener('mousedown', onMouseDown as EventListener);
    }

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
      trackMouseModes(data);
      if (!gotFirstOutput) {
        gotFirstOutput = true;
        if (waitingDots) { clearInterval(waitingDots); waitingDots = null; }
        term.clear();
        // tmux just started rendering — bounce resize so it picks up correct dimensions
        setTimeout(() => safeFitAndResize(true), 80);
      }
      term.write(data);
    }

    function connect() {
      if (cleanedUp.current) return;

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
        // Sync terminal size with server on (re)connect — bounce to force SIGWINCH
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
                term.write(`\r\n\x1b[33m--- Session exited (code: ${content.exitCode ?? 'unknown'}) ---\x1b[0m\r\n`);
                hasExited.current = true;
                onExit?.(content.exitCode ?? -1, paneText);
                onInputStateChange?.('active');
              } else if (content.kind === 'error' && content.data) {
                term.write(`\r\n\x1b[31m${content.data}\x1b[0m\r\n`);
              } else if (content.kind === 'input_state') {
                onInputStateChange?.(content.state || 'active');
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
              if (msg.data) {
                if (waitingDots) { clearInterval(waitingDots); waitingDots = null; }
                gotFirstOutput = true;
                term.clear();
                term.write(msg.data);
              } else if (!gotFirstOutput) {
                term.write('\r\x1b[2K\x1b[90mStarting session...\x1b[0m');
                let dots = 0;
                waitingDots = setInterval(() => {
                  if (gotFirstOutput || cleanedUp.current) { clearInterval(waitingDots!); waitingDots = null; return; }
                  dots = (dots + 1) % 4;
                  term.write('\r\x1b[2K\x1b[90mStarting session' + '.'.repeat(dots + 1) + '\x1b[0m');
                }, 500);
              }
              break;
            case 'output':
              handleOutput(msg.data);
              break;
            case 'exit': {
              const legacyPaneText = capturePaneText();
              term.write(`\r\n\x1b[33m--- Session exited (code: ${msg.exitCode ?? 'unknown'}) ---\x1b[0m\r\n`);
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
          term.write(`\r\n\x1b[90m--- Disconnected (${event.reason || event.code}) ---\x1b[0m\r\n`);
          if (event.code === 4004) onExit?.(-1, capturePaneText());
          return;
        }

        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          term.write('\r\n\x1b[31m--- Connection lost. Click terminal or press any key to retry. ---\x1b[0m\r\n');
          const retryHandler = term.onData(() => {
            retryHandler.dispose();
            reconnectAttempts = 0;
            reconnectDelay = 200;
            term.write('\x1b[90mReconnecting...\x1b[0m\r\n');
            connect();
          });
          return;
        }

        term.write('\r\n\x1b[90m--- Disconnected, reconnecting... ---\x1b[0m\r\n');
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_BACKOFF_CAP_MS);
          connect();
        }, reconnectDelay);
      };
    }

    connect();

    // Terminal auto-response sequences (DA1, DA2, DSR cursor position report).
    // xterm.js generates these in response to queries from tmux/shell. On reconnect
    // they arrive after tmux has timed out, causing visible junk in the PTY input.
    // tmux infers capabilities from TERM=xterm-256color so these are unnecessary.
    const TERMINAL_RESPONSE_RE = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+;\d+R/g;

    let inputBuffer = '';
    let inputFlushRaf = 0;

    function flushInputBuffer() {
      inputFlushRaf = 0;
      if (!inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = '';
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

    term.onData((data: string) => {
      const filtered = data.replace(TERMINAL_RESPONSE_RE, '');
      if (!filtered) return;
      lastTerminalInput.value = Date.now();
      if (suppressMotion && !filtered.startsWith('\x1b[M') && !filtered.startsWith('\x1b[<')) {
        suppressMotion = false;
      }
      inputBuffer += filtered;
      if (!inputFlushRaf) {
        inputFlushRaf = requestAnimationFrame(flushInputBuffer);
      }
    });

    function safeFitAndResize(bounce = false) {
      const el = containerRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      fit.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        // On macOS, TIOCSWINSZ skips SIGWINCH when size is unchanged.
        // "Bounce" by sending rows-1 first to guarantee tmux gets a real
        // SIGWINCH and re-renders when we send the correct size immediately after.
        if (bounce && term.rows > 1) {
          inputSeq++;
          const bounceMsg = JSON.stringify({
            type: 'sequenced_input',
            sessionId,
            seq: inputSeq,
            content: { kind: 'resize', cols: term.cols, rows: term.rows - 1 },
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
          content: { kind: 'resize', cols: term.cols, rows: term.rows },
          timestamp: new Date().toISOString(),
        });
        pendingInputs.set(inputSeq, msg);
        ws.send(msg);
      }
    }

    safeFitAndResizeRef.current = safeFitAndResize;

    let resizeLastFired = 0;
    let resizeRaf = 0;
    const RESIZE_THROTTLE_MS = 100;
    const observer = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const now = performance.now();
        if (now - resizeLastFired >= RESIZE_THROTTLE_MS) {
          resizeLastFired = now;
          safeFitAndResize();
        }
      });
    });
    observer.observe(containerRef.current);

    // Bounce resize when terminal gets focus (click into it, tab into it, etc.)
    function onTermFocus() { safeFitAndResize(true); }
    term.textarea?.addEventListener('focus', onTermFocus);

    // Bounce resize when browser tab/window regains visibility
    function onVisibilityChange() {
      if (!document.hidden) setTimeout(() => safeFitAndResize(true), 50);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Bounce resize when browser window regains focus
    function onWindowFocus() { setTimeout(() => safeFitAndResize(true), 50); }
    window.addEventListener('focus', onWindowFocus);

    return () => {
      cleanedUp.current = true;
      safeFitAndResizeRef.current = () => {};
      onInputStateChange?.('active');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (waitingDots) clearInterval(waitingDots);
      if (xtermScreen) {
        xtermScreen.removeEventListener('contextmenu', onContextMenu);
        xtermScreen.removeEventListener('mousemove', onMouseMove as EventListener);
        xtermScreen.removeEventListener('mousedown', onMouseDown as EventListener);
      }
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
      if (inputFlushRaf) { cancelAnimationFrame(inputFlushRaf); flushInputBuffer(); }
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      observer.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!isActive || !fitRef.current || !termRef.current || !containerRef.current) return;
    const term = termRef.current;
    // Wait for the browser to lay out the newly-visible container before fitting.
    // On macOS the kernel skips SIGWINCH when PTY size is unchanged, so we use
    // bounce=true to briefly send rows-1 then correct rows, forcing tmux to
    // re-render.  Also call term.refresh() to repaint the xterm.js canvas
    // (content written while the tab was display:none may leave it stale).
    const rafId = requestAnimationFrame(() => {
      safeFitAndResizeRef.current(true);
      term.refresh(0, term.rows - 1);
      term.focus();
    });
    // No periodic resize — ResizeObserver, focus, and visibility handlers cover
    // all real scenarios. The old 5s setInterval caused visible flicker.
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isActive]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} onClick={() => termRef.current?.focus()} />;
}
