import { Hono } from 'hono';

const localRoutes = new Hono();

// Bridge page — opened via window.open from remote admins to bypass Private Network Access.
// Communicates results back via postMessage, then auto-closes.
localRoutes.get('/bridge', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Local Bridge</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #16213e; border-radius: 12px; padding: 24px 32px; text-align: center;
          box-shadow: 0 4px 24px rgba(0,0,0,0.4); max-width: 400px; }
  .status { margin-top: 12px; font-size: 14px; color: #8b8fa3; }
  .ok { color: #facc15; }
  .err { color: #f87171; }
</style></head><body>
<div class="card">
  <div style="font-size:20px;font-weight:600">Local Terminal Bridge</div>
  <div class="status" id="status">Ready</div>
</div>
<script>
const el = document.getElementById('status');
const openerOrigin = '*';

function post(type, data) {
  if (window.opener) window.opener.postMessage({ source: 'pw-local-bridge', type, ...data }, openerOrigin);
}

async function handleOpenTerminal(params, reqId) {
  try {
    el.textContent = 'Opening terminal...';
    el.className = 'status';
    const res = await fetch('/api/v1/local/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.ok) {
      el.textContent = 'Terminal opened';
      el.className = 'status ok';
      post('result', { reqId, ok: true, command: data.command });
      setTimeout(() => window.close(), 1000);
    } else {
      el.textContent = data.error || 'Unknown error';
      el.className = 'status err';
      post('result', { reqId, ok: false, error: data.error });
      setTimeout(() => window.close(), 3000);
    }
  } catch (e) {
    el.textContent = e.message;
    el.className = 'status err';
    post('result', { reqId, ok: false, error: e.message });
    setTimeout(() => window.close(), 3000);
  }
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'pw-local-bridge-cmd') return;
  if (d.type === 'open-terminal') handleOpenTerminal(d.params || {}, d.reqId);
  else if (d.type === 'ping') post('pong', {});
});

// Handle legacy hash params (one-shot open, then stay alive)
if (location.hash.length > 1) {
  try {
    const params = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    handleOpenTerminal(params, 'legacy');
  } catch {}
}

post('ready', {});
</script></body></html>`);
});

localRoutes.post('/open-terminal', async (c) => {
  if (process.platform !== 'darwin') {
    return c.json({ error: 'Open in Terminal.app is only supported on macOS' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { command, sshUser, sshHost, sshPort, sessionId } = body as {
    command?: string;
    sshUser?: string;
    sshHost?: string;
    sshPort?: number;
    sessionId?: string;
  };

  let finalCommand: string;

  if (sshUser && sshHost && sessionId) {
    if (!/^[a-zA-Z0-9._-]+$/.test(sshUser)) return c.json({ error: 'Invalid sshUser' }, 400);
    if (!/^[a-zA-Z0-9._-]+$/.test(sshHost)) return c.json({ error: 'Invalid sshHost' }, 400);
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
    const portFlag = sshPort ? ` -p ${Number(sshPort)}` : '';
    finalCommand = `ssh ${sshUser}@${sshHost}${portFlag} -t "tmux -L propanes attach-session -t pw-${sessionId}"`;
  } else if (command) {
    // Validate it looks like an SSH+tmux command (not arbitrary shell)
    if (!/^ssh\s/.test(command) && !/^tmux\s/.test(command)) {
      return c.json({ error: 'Only ssh and tmux commands are allowed' }, 400);
    }
    finalCommand = command;
  } else if (sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
    finalCommand = `tmux -L propanes attach-session -t pw-${sessionId}`;
  } else {
    return c.json({ error: 'Provide {command} or {sshUser, sshHost, sessionId}' }, 400);
  }

  const { exec } = await import('node:child_process');
  const escaped = finalCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  exec(`osascript -e 'tell application "Terminal" to do script "${escaped}"' -e 'tell application "Terminal" to activate'`);
  return c.json({ ok: true, command: finalCommand });
});

// Mic bridge — loaded in a popup window opened from insecure (HTTP) pages so
// that SpeechRecognition + getUserMedia can run in a secure localhost context.
// The opener communicates via postMessage; transcript segments and ambient
// windows are sent back the same way. The popup stays open on error so the
// failure is inspectable; on a clean stop it self-closes after a short delay
// (extended via ?keepOpen=1 for debugging).
localRoutes.get('/mic-bridge', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mic Bridge</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0;
         margin: 0; padding: 12px; box-sizing: border-box; min-height: 100vh; }
  .card { text-align: center; padding: 8px 0; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
         background: #ef4444; margin-right: 8px; vertical-align: middle;
         animation: pulse 1.6s ease-in-out infinite; }
  .dot.idle { animation: none; background: #6b7280; }
  .dot.error { animation: none; background: #f87171; }
  .dot.stopped { animation: none; background: #facc15; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
  .status { margin-top: 6px; font-size: 12px; color: #8b8fa3; }
  .status.error { color: #f87171; font-weight: 600; }
  .log { margin-top: 10px; background: #0f1626; border: 1px solid #2a2f4a;
         border-radius: 6px; padding: 6px 8px; font-family: ui-monospace, Menlo, Consolas, monospace;
         font-size: 10.5px; line-height: 1.35; color: #cbd5e1; text-align: left;
         max-height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
  .log .lvl-warn  { color: #fbbf24; }
  .log .lvl-error { color: #f87171; }
  .log .lvl-debug { color: #94a3b8; }
  .log .ts { color: #475569; }
  .row { display: flex; gap: 6px; justify-content: center; margin-top: 8px; }
  .btn { background: #1f2937; color: #e0e0e0; border: 1px solid #334155;
         border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .btn:hover { background: #2a3548; }
  .picker { margin-top: 10px; display: flex; flex-direction: column; gap: 4px;
            align-items: stretch; padding: 0 4px; }
  .picker label { font-size: 10.5px; color: #8b8fa3; text-align: left; }
  .picker select { background: #0f1626; color: #e0e0e0; border: 1px solid #334155;
                   border-radius: 4px; padding: 4px 6px; font-size: 11.5px;
                   font-family: inherit; }
  .picker select:focus { outline: none; border-color: #4b5d80; }
</style>
</head>
<body>
<div class="card">
  <div><span class="dot" id="dot"></span><span style="font-size:14px;font-weight:600">Mic bridge</span></div>
  <div class="status" id="status">Booting…</div>
  <div class="picker">
    <label for="micSelect">Microphone</label>
    <select id="micSelect"><option value="">System default</option></select>
  </div>
  <div class="row">
    <button class="btn" id="copyBtn" type="button">Copy log</button>
    <button class="btn" id="closeBtn" type="button">Close</button>
  </div>
</div>
<div class="log" id="log"></div>
<script>
// ----- Logging -----
// Every meaningful step writes a line that is (1) console.log'd in this
// popup's devtools, (2) appended to the visible log area below, and (3)
// forwarded to the opener so it lands in the parent's console too. The
// popup stays open on error so the user has time to read or copy the log.
const params = new URLSearchParams(location.search);
const KEEP_OPEN = params.get('keepOpen') === '1';
const STOP_CLOSE_DELAY_MS = KEEP_OPEN ? -1 : 1500;

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const closeBtn = document.getElementById('closeBtn');
const copyBtn = document.getElementById('copyBtn');
const micSelect = document.getElementById('micSelect');

// ----- Device picker -----
// Persist the user's chosen audio input across popup launches. The popup
// always runs on localhost:3001, so this localStorage key is shared regardless
// of which host page opened us. Empty string = "let the browser pick the
// system default" (the original behavior).
const DEVICE_STORAGE_KEY = 'pw-mic-bridge:audioInputDeviceId';
function loadSavedDeviceId() {
  try { return localStorage.getItem(DEVICE_STORAGE_KEY) || ''; } catch { return ''; }
}
function saveDeviceId(id) {
  try {
    if (id) localStorage.setItem(DEVICE_STORAGE_KEY, id);
    else localStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {}
}

async function refreshDeviceList() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    log('warn', 'enumerateDevices not available');
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const saved = loadSavedDeviceId();
    micSelect.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'System default';
    micSelect.appendChild(defOpt);
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      // Labels are blank until permission has been granted at least once;
      // fall back to a generic placeholder so the count is still useful.
      opt.textContent = d.label || ('Microphone ' + (i + 1));
      micSelect.appendChild(opt);
    });
    const found = saved && inputs.some(d => d.deviceId === saved);
    micSelect.value = found ? saved : '';
    log('debug', 'devices refreshed:',
      inputs.map(d => ({ idHead: d.deviceId.slice(0, 8), label: d.label || '(no label)' })));
  } catch (e) {
    log('warn', 'enumerateDevices failed:', e);
  }
}

micSelect.addEventListener('change', () => {
  const value = micSelect.value;
  const label = micSelect.options[micSelect.selectedIndex].textContent;
  saveDeviceId(value);
  log('log', 'device selected:', label, value ? '(' + value.slice(0, 8) + '…)' : '(default)');
  if (running) {
    log('log', 'restarting recognition with new device');
    restartWithCurrentDevice();
  }
});

const logBuffer = [];
const MAX_LOG_LINES = 500;

function fmt(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function log(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const message = fmt(args);
  // 1. devtools console for this popup
  const fn = console[level] || console.log;
  fn.call(console, '[mic-bridge ' + ts + ']', ...args);
  // 2. visible log area
  const line = document.createElement('div');
  line.className = 'lvl-' + level;
  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = ts + ' ';
  line.appendChild(tsSpan);
  line.appendChild(document.createTextNode(message));
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  // 3. relay to opener so the parent console sees it too
  logBuffer.push(ts + ' [' + level + '] ' + message);
  post('log', { level, ts, message });
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', kind === 'error');
  if (kind) dotEl.className = 'dot ' + kind;
  else dotEl.className = 'dot';
}

// ----- Ambient listen state -----
let recognition = null;
let stream = null;
let running = false;
let windowMs = 30000;
let silenceMs = 10000;
let maxLength = 500;
let windowIndex = 0;
let windowStart = 0;
let windowBuffer = [];
let flushTimer = null;
let silenceTimer = null;
let lastLang = 'en-US';

// Posts go to whichever bridge transport opened us — popup uses window.opener,
// legacy iframe uses window.parent. Pick the one that's actually a separate window.
function getTarget() {
  if (window.opener && window.opener !== window) return window.opener;
  if (window.parent && window.parent !== window) return window.parent;
  return null;
}
const parentOrigin = '*'; // widget may be on any origin

function post(type, data) {
  const t = getTarget();
  if (t) {
    try { t.postMessage({ source: 'pw-mic-bridge', type, ...data }, parentOrigin); }
    catch (e) { /* parent may have gone */ }
  }
}

function showError(code, message) {
  log('error', 'error', code, message);
  setStatus(message + ' (' + code + ')', 'error');
  dotEl.className = 'dot error';
  post('error', { code, message });
  // Force keep-open on error so the user can read it.
  // closeBtn lets them dismiss when ready.
}

function resetSilenceTimer() {
  if (silenceTimer) clearTimeout(silenceTimer);
  if (!running || windowBuffer.length === 0) return;
  silenceTimer = setTimeout(() => {
    if (running && windowBuffer.length > 0) {
      log('debug', 'silence flush after', silenceMs + 'ms');
      flushWindow();
    }
  }, silenceMs);
}

function flushWindow() {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  const now = Date.now();
  const text = windowBuffer.join(' ').trim();
  const idx = windowIndex++;
  if (text.length > 0) {
    log('log', 'flush window', idx, '(' + text.length + ' chars):', text.slice(0, 80) + (text.length > 80 ? '…' : ''));
    post('ambientWindow', {
      windowIndex: idx,
      startedAt: new Date(windowStart).toISOString(),
      endedAt: new Date(now).toISOString(),
      text,
    });
  } else {
    log('debug', 'flush window', idx, '(empty, skipped)');
  }
  windowBuffer = [];
  windowStart = now;
  if (flushTimer) clearTimeout(flushTimer);
  if (running) {
    flushTimer = setTimeout(() => { if (running) flushWindow(); }, windowMs);
  }
}

function startAmbient(opts) {
  log('log', 'start cmd received', opts);
  if (running) { log('warn', 'already running, ignoring start'); return; }
  log('debug', 'env:', {
    secureContext: window.isSecureContext,
    href: location.href,
    userAgent: navigator.userAgent,
    hasMediaDevices: !!navigator.mediaDevices,
    hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  });

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showError('NOT_SUPPORTED', 'SpeechRecognition not available in this browser');
    return;
  }

  windowMs = opts.windowMs || 30000;
  silenceMs = opts.silenceMs || 10000;
  maxLength = opts.maxLength || 500;
  windowIndex = 0;
  windowStart = Date.now();
  windowBuffer = [];
  lastLang = opts.lang || 'en-US';

  setStatus('Requesting microphone…');
  const desiredId = loadSavedDeviceId();
  const audioConstraint = desiredId ? { deviceId: { exact: desiredId } } : true;
  log('log', 'requesting getUserMedia', { deviceId: desiredId ? desiredId.slice(0, 8) + '…' : '(default)' });
  navigator.mediaDevices.getUserMedia({ audio: audioConstraint }).then(s => {
    log('log', 'getUserMedia granted', { tracks: s.getAudioTracks().map(t => t.label) });
    stream = s;
    running = true;
    setStatus('Listening — keep this window open');
    dotEl.className = 'dot';
    // Labels are now unlocked; refresh the list so the dropdown shows real names.
    refreshDeviceList();
    startRecognitionLoop(SR);
  }).catch(err => {
    // If a previously-saved deviceId no longer exists (e.g. AirPods unpaired),
    // OverconstrainedError is what getUserMedia raises. Clear the pin and
    // fall back to system default automatically so the user isn't stuck.
    if ((err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') && desiredId) {
      log('warn', 'saved device unavailable, falling back to system default');
      saveDeviceId('');
      navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
        log('log', 'getUserMedia (fallback) granted', { tracks: s.getAudioTracks().map(t => t.label) });
        stream = s;
        running = true;
        setStatus('Listening (default device)');
        dotEl.className = 'dot';
        refreshDeviceList();
        startRecognitionLoop(SR);
      }).catch(err2 => {
        const code = err2.name === 'NotAllowedError' || err2.name === 'SecurityError' ? 'NOT_ALLOWED'
          : err2.name === 'NotFoundError' ? 'NOT_FOUND'
          : err2.name === 'NotReadableError' ? 'NOT_READABLE'
          : 'UNKNOWN';
        showError(code, err2.message || err2.name || 'getUserMedia failed');
      });
      return;
    }
    const code = err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'NOT_ALLOWED'
      : err.name === 'NotFoundError' ? 'NOT_FOUND'
      : err.name === 'NotReadableError' ? 'NOT_READABLE'
      : err.name === 'OverconstrainedError' ? 'OVERCONSTRAINED'
      : 'UNKNOWN';
    showError(code, err.message || err.name || 'getUserMedia failed');
  });
}

function startRecognitionLoop(SR) {
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lastLang;
  recognition.onstart = () => log('debug', 'recognition.onstart');
  recognition.onaudiostart = () => log('debug', 'recognition.onaudiostart');
  recognition.onsoundstart = () => log('debug', 'recognition.onsoundstart');
  recognition.onspeechstart = () => log('debug', 'recognition.onspeechstart');
  recognition.onspeechend = () => log('debug', 'recognition.onspeechend');
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const seg = { text: result[0].transcript, timestamp: Date.now() - windowStart, isFinal: result.isFinal };
      if (result.isFinal) {
        log('log', 'segment (final):', JSON.stringify(seg.text));
        windowBuffer.push(seg.text);
        resetSilenceTimer();
        if (windowBuffer.join(' ').length >= maxLength) flushWindow();
      }
      post('segment', { segment: seg });
    }
  };
  recognition.onend = () => {
    if (running) { try { recognition.start(); } catch (e) { log('warn', 'restart failed:', e); } }
  };
  recognition.onerror = (e) => {
    log('warn', 'recognition.onerror', e.error, e.message || '');
    if (e.error !== 'no-speech' && e.error !== 'aborted' && running) {
      try { recognition.start(); } catch (err) { log('warn', 'restart-after-error failed:', err); }
    }
  };
  try { recognition.start(); log('debug', 'recognition.start() called'); }
  catch (e) { log('error', 'recognition.start() threw:', e); }
  flushTimer = setTimeout(() => { if (running) flushWindow(); }, windowMs);
  post('started', {});
  log('log', 'started');
}

function restartWithCurrentDevice() {
  if (!running) return;
  // Stop the current stream + recognizer, then re-enter startAmbient with the
  // existing window-mode params. Don't fire 'stopped' — the parent still
  // thinks of us as running, and we want to keep window indices contiguous.
  if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  running = false;
  startAmbient({
    windowMs,
    silenceMs,
    maxLength,
    lang: lastLang,
  });
}

function stopAmbient(reason) {
  log('log', 'stop cmd received', reason || '');
  if (!running) {
    log('warn', 'not running, nothing to stop');
    return;
  }
  running = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  flushWindow();
  if (recognition) { try { recognition.stop(); } catch (e) { log('warn', 'recognition.stop threw:', e); } recognition = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  post('stopped', {});
  setStatus(KEEP_OPEN ? 'Stopped — keepOpen=1, click Close to dismiss' : 'Stopped — closing in ' + STOP_CLOSE_DELAY_MS + 'ms', 'stopped');
  if (STOP_CLOSE_DELAY_MS >= 0) {
    setTimeout(() => { try { window.close(); } catch {} }, STOP_CLOSE_DELAY_MS);
  }
}

closeBtn.addEventListener('click', () => {
  log('log', 'manual close');
  if (running) stopAmbient('manual-close');
  setTimeout(() => { try { window.close(); } catch {} }, 100);
});
copyBtn.addEventListener('click', async () => {
  const text = logBuffer.join('\\n');
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy log'; }, 1200);
  } catch (e) {
    log('warn', 'clipboard write failed:', e);
  }
});

// If the opener navigates away or closes, stop ourselves.
window.addEventListener('beforeunload', () => { if (running) stopAmbient('beforeunload'); });

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'pw-mic-bridge-cmd') return;
  if (d.type === 'start') startAmbient(d.opts || {});
  else if (d.type === 'stop') stopAmbient('parent-cmd');
  else if (d.type === 'flush') { if (running) { log('log', 'manual flush'); flushWindow(); } }
  else if (d.type === 'ping') post('pong', {});
});

window.addEventListener('error', (e) => {
  log('error', 'window.onerror:', e.message, 'at', e.filename + ':' + e.lineno + ':' + e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
  log('error', 'unhandledrejection:', e.reason);
});

setStatus('Connecting…', 'idle');
log('log', 'boot', { keepOpen: KEEP_OPEN, hasOpener: !!getTarget(), secureContext: window.isSecureContext });

// Populate the device picker on boot. Labels won't be available until
// permission has been granted at least once (we re-enumerate after the first
// successful getUserMedia), but this still surfaces the count + saved choice.
refreshDeviceList();
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    log('log', 'devicechange — refreshing device list');
    refreshDeviceList();
  });
}

post('ready', {});
</script>
</body></html>`);
});

export default localRoutes;
