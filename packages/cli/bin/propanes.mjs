#!/usr/bin/env node
// propanes — native-terminal client for Propanes agent sessions.
//
// Rides the same authenticated /ws/agent-session WebSocket the admin web
// terminal uses, through the normal HTTPS ingress: no kubectl, no SSH, no
// local server. Commands:
//
//   propanes login [--server URL] [--username U] [--password P | --token JWT]
//   propanes attach <sessionId> [--server URL]
//   propanes sessions [--server URL]
//   propanes open-url <propanes://attach?session=..&server=..>
//   propanes install-protocol        (macOS: register the propanes:// handler)
//
// Config lives in ~/.config/propanes/config.json, tokens keyed by server
// origin. open-url only ever uses tokens for servers you have logged into —
// a web page cannot point the CLI at an attacker-controlled server.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

const CONFIG_DIR = join(homedir(), '.config', 'propanes');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const DETACH_KEY = 0x1d; // ctrl-]

// ---------- config ----------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { defaultServer: null, servers: {} };
  }
}

function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function normalizeServer(input) {
  let url = input;
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  return new URL(url).origin;
}

function resolveServer(flags, cfg, { required = true } = {}) {
  const raw = flags.server || process.env.PROPANES_SERVER || cfg.defaultServer;
  if (!raw) {
    if (required) die('No server configured. Run: propanes login --server https://your-propanes-host');
    return null;
  }
  return normalizeServer(raw);
}

function tokenFor(cfg, server) {
  const entry = cfg.servers?.[server];
  if (!entry?.token) return null;
  if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) return null;
  return entry.token;
}

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------- prompts ----------

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Mute echo while the password is typed.
      const origWrite = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (str) => {
        if (str.includes(question)) origWrite(str);
      };
      rl.question(question, (answer) => {
        process.stdout.write('\n');
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ---------- commands ----------

async function cmdLogin(flags) {
  const cfg = loadConfig();
  const rawServer = flags.server || process.env.PROPANES_SERVER || cfg.defaultServer
    || (await prompt('Server URL: '));
  const server = normalizeServer(rawServer);

  if (flags.token) {
    const me = await fetch(`${server}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${flags.token}` },
    });
    if (!me.ok) die(`Token rejected by ${server} (HTTP ${me.status})`);
    const body = await me.json();
    cfg.servers = cfg.servers || {};
    cfg.servers[server] = { token: flags.token, username: body.user?.username || null, expiresAt: null };
    cfg.defaultServer = server;
    saveConfig(cfg);
    console.log(`Logged in to ${server} as ${body.user?.username || '(token)'}`);
    return;
  }

  const username = flags.username || process.env.PROPANES_USERNAME || (await prompt('Username: '));
  const password = flags.password || process.env.PROPANES_PASSWORD || (await prompt('Password: ', { hidden: true }));

  const res = await fetch(`${server}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    die(`Login failed: ${body.error || `HTTP ${res.status}`}`);
  }
  const body = await res.json();
  cfg.servers = cfg.servers || {};
  cfg.servers[server] = { token: body.token, expiresAt: body.expiresAt, username };
  cfg.defaultServer = server;
  saveConfig(cfg);
  console.log(`Logged in to ${server} as ${username}`);
}

async function cmdSessions(flags) {
  const cfg = loadConfig();
  const server = resolveServer(flags, cfg);
  const token = tokenFor(cfg, server);
  if (!token) die(`Not logged in to ${server}. Run: propanes login --server ${server}`);
  const res = await fetch(`${server}/api/v1/admin/agent-sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) die(`Token expired. Run: propanes login --server ${server}`);
  if (!res.ok) die(`Failed to list sessions (HTTP ${res.status})`);
  const sessions = await res.json();
  const live = sessions.filter((s) => s.status === 'running' || s.status === 'pending');
  if (live.length === 0) {
    console.log('No running sessions.');
    return;
  }
  for (const s of live) {
    console.log(`${s.id}  ${String(s.status).padEnd(8)}  ${s.title || s.agentName || ''}`);
  }
}

function cmdAttach(flags, sessionId) {
  if (!sessionId) die('Usage: propanes attach <sessionId>');
  sessionId = sessionId.replace(/^pw-/, '');
  const cfg = loadConfig();
  const server = resolveServer(flags, cfg);
  const token = tokenFor(cfg, server);
  if (!token) die(`Not logged in to ${server}. Run: propanes login --server ${server}`);

  const wsBase = server.replace(/^http/, 'ws');
  const isTty = process.stdin.isTTY && process.stdout.isTTY;

  let ws = null;
  let inputSeq = 0;
  let lastOutputSeq = 0;
  let sawHistory = false;
  let exiting = false;
  let reconnectDelay = 300;
  const pendingInputs = new Map();

  function cleanupAndExit(code, msg) {
    if (exiting) return;
    exiting = true;
    if (isTty) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    if (msg) process.stderr.write(`\n${msg}\n`);
    process.exit(code);
  }

  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendInput(data) {
    inputSeq++;
    const msg = JSON.stringify({
      type: 'sequenced_input',
      sessionId,
      seq: inputSeq,
      content: { kind: 'input', data },
      timestamp: new Date().toISOString(),
    });
    pendingInputs.set(inputSeq, msg);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }

  function sendResize() {
    const cols = process.stdout.columns;
    const rows = process.stdout.rows;
    if (!cols || !rows) return;
    inputSeq++;
    const msg = JSON.stringify({
      type: 'sequenced_input',
      sessionId,
      seq: inputSeq,
      content: { kind: 'resize', cols, rows },
      timestamp: new Date().toISOString(),
    });
    pendingInputs.set(inputSeq, msg);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }

  function connect() {
    ws = new WebSocket(`${wsBase}/ws/agent-session?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`);

    ws.on('open', () => {
      reconnectDelay = 300;
      if (lastOutputSeq > 0) sendJson({ type: 'replay_request', sessionId, fromSeq: lastOutputSeq });
      for (const [, serialized] of pendingInputs) ws.send(serialized);
      sendResize();
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.type) {
        case 'history':
          if (typeof msg.lastInputAckSeq === 'number' && msg.lastInputAckSeq > inputSeq) {
            inputSeq = msg.lastInputAckSeq;
          }
          if (msg.data) {
            process.stdout.write((sawHistory ? '\x1bc' : '') + msg.data);
            sawHistory = true;
          }
          break;
        case 'sequenced_output': {
          const seq = msg.seq;
          if (seq <= lastOutputSeq) break;
          lastOutputSeq = seq;
          const content = msg.content || {};
          if (content.kind === 'output' && content.data) {
            process.stdout.write(content.data);
          } else if (content.kind === 'error' && content.data) {
            process.stderr.write(`\n${content.data}\n`);
          } else if (content.kind === 'exit') {
            sendJson({ type: 'output_ack', sessionId, ackSeq: seq });
            cleanupAndExit(0, `--- Session exited (code: ${content.exitCode ?? 'unknown'}) ---`);
          }
          sendJson({ type: 'output_ack', sessionId, ackSeq: seq });
          break;
        }
        case 'input_ack':
          pendingInputs.delete(msg.ackSeq);
          break;
        case 'output':
          if (msg.data) process.stdout.write(msg.data);
          break;
        case 'exit':
          cleanupAndExit(0, `--- Session exited (code: ${msg.exitCode ?? 'unknown'}) ---`);
          break;
      }
    });

    ws.on('close', (code, reason) => {
      if (exiting) return;
      if (code === 4003) cleanupAndExit(1, `Token rejected. Run: propanes login --server ${server}`);
      if (code === 4004) cleanupAndExit(1, `Session not found: ${sessionId}`);
      // Transient (4010 service restart, network blip) — reconnect with replay.
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });

    ws.on('error', () => {
      // close handler drives the retry
    });
  }

  if (isTty) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      if (data.length === 1 && data[0] === DETACH_KEY) {
        cleanupAndExit(0, 'Detached.');
        return;
      }
      sendInput(data.toString('utf8'));
    });
    process.on('SIGWINCH', sendResize);
    process.stderr.write(`Attaching to ${sessionId} on ${server} (detach: ctrl-])\n`);
  }
  process.on('SIGINT', () => sendInput('\x03')); // forward ctrl-c to the session
  process.on('SIGTERM', () => cleanupAndExit(0));

  connect();
}

// propanes://attach?session=<id>&server=<origin>
async function cmdOpenUrl(flags, rawUrl) {
  if (!rawUrl) die('Usage: propanes open-url <propanes://...>');
  let url;
  try { url = new URL(rawUrl); } catch { die(`Invalid URL: ${rawUrl}`); }
  if (url.protocol !== 'propanes:') die(`Unsupported protocol: ${url.protocol}`);
  const action = url.hostname || url.pathname.replace(/^\/+/, '');
  if (action !== 'attach') die(`Unsupported action: ${action}`);
  const sessionId = url.searchParams.get('session');
  const serverParam = url.searchParams.get('server');
  if (!sessionId || !serverParam) die('URL must include session and server params');

  const cfg = loadConfig();
  const server = normalizeServer(serverParam);
  // Only talk to servers this machine has explicitly logged into — a web page
  // must not be able to steer the CLI (and a token) to an arbitrary host.
  if (!cfg.servers?.[server]) {
    die(`Not logged in to ${server}.\nRun: propanes login --server ${server}\nThen retry from the browser.`);
  }
  cmdAttach({ server }, sessionId);
}

function cmdInstallProtocol() {
  if (process.platform !== 'darwin') {
    die('install-protocol is macOS-only for now. On Linux, register a propanes:// scheme handler that runs: propanes open-url %u');
  }
  const appDir = join(homedir(), 'Applications');
  const appPath = join(appDir, 'Propanes Launcher.app');
  const scriptPath = join(tmpdir(), `propanes-launcher-${process.pid}.applescript`);

  // The handler opens Terminal.app and runs the CLI there, resolving the
  // binary through the user's login-shell PATH (npm -g installs included).
  const applescript = `on open location theURL
	tell application "Terminal"
		activate
		do script "propanes open-url " & quoted form of theURL & " || { echo 'propanes CLI not found on PATH — npm install -g @propanes/cli'; }"
	end tell
end open location
`;

  try {
    mkdirSync(appDir, { recursive: true });
    writeFileSync(scriptPath, applescript);
    if (existsSync(appPath)) rmSync(appPath, { recursive: true, force: true });
    execFileSync('osacompile', ['-o', appPath, scriptPath]);
    const plist = join(appPath, 'Contents', 'Info.plist');
    const pb = (args) => execFileSync('/usr/libexec/PlistBuddy', ['-c', args, plist]);
    pb('Set :CFBundleIdentifier ai.propanes.launcher');
    pb('Add :CFBundleURLTypes array');
    pb('Add :CFBundleURLTypes:0 dict');
    pb('Add :CFBundleURLTypes:0:CFBundleURLName string Propanes');
    pb('Add :CFBundleURLTypes:0:CFBundleURLSchemes array');
    pb('Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string propanes');
    // Background app — no Dock icon flash when a link is clicked.
    pb('Add :LSUIElement bool true');
    // Register with LaunchServices.
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', appPath]);
    console.log(`Installed ${appPath}`);
    console.log('propanes:// links will now open Terminal.app attached to the session.');
  } catch (err) {
    die(`Failed to install protocol handler: ${err.message}\nYou can still attach manually: propanes attach <sessionId>`);
  } finally {
    try { rmSync(scriptPath, { force: true }); } catch {}
  }
}

function usage() {
  console.log(`propanes — native-terminal client for Propanes agent sessions

Usage:
  propanes login [--server URL] [--username U] [--password P | --token JWT]
  propanes attach <sessionId> [--server URL]
  propanes sessions [--server URL]
  propanes open-url <propanes://attach?session=..&server=..>
  propanes install-protocol      Register the propanes:// handler (macOS)

Detach from an attached session with ctrl-].`);
}

// ---------- dispatch ----------

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional[0];

switch (command) {
  case 'login':
    await cmdLogin(flags);
    break;
  case 'attach':
    cmdAttach(flags, positional[1]);
    break;
  case 'sessions':
  case 'ls':
    await cmdSessions(flags);
    break;
  case 'open-url':
    await cmdOpenUrl(flags, positional[1]);
    break;
  case 'install-protocol':
    cmdInstallProtocol();
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
