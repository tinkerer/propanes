#!/usr/bin/env node
// propanes — native-terminal client for Propanes agent sessions.
//
// Rides the same authenticated /ws/agent-session WebSocket the admin web
// terminal uses, through the normal HTTPS ingress: no kubectl, no SSH, no
// local server. Commands:
//
//   propanes login [--server URL] [--username U] [--password P | --token JWT]
//   propanes login --web [--server URL]     (browser login; works behind SSO)
//   propanes login --workbench [--server URL] (Workbench SSO device flow)
//   propanes attach <sessionId> [--server URL]
//   propanes sessions [--server URL]
//   propanes feedback <feedbackId> | -l | --session <sessionId>
//   propanes open-url <propanes://attach?session=..&server=..>
//   propanes install-protocol        (macOS: register the propanes:// handler)
//
// Config lives in ~/.config/propanes/config.json, tokens keyed by server
// origin. open-url only ever uses tokens for servers you have logged into —
// a web page cannot point the CLI at an attacker-controlled server.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
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
  // PROPANES_API_URL is preset in dispatched agent sessions — lets the CLI
  // work there without a login step (paired with the PROPANES_TOKEN fallback).
  const raw = flags.server || process.env.PROPANES_SERVER || process.env.PROPANES_API_URL || cfg.defaultServer;
  if (!raw) {
    if (required) die('No server configured. Run: propanes login --server https://your-propanes-host');
    return null;
  }
  return normalizeServer(raw);
}

function tokenFor(cfg, server) {
  const entry = cfg.servers?.[server];
  if (entry?.token && !(entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now())) {
    return entry.token;
  }
  return process.env.PROPANES_TOKEN || null;
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
  if (!hidden) {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  // Hidden input via raw mode — readline's line-redraw would echo typed
  // characters (muting only the initial prompt write is not enough).
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk.toString('utf8')) {
        if (c === '\r' || c === '\n') {
          stdin.off('data', onData);
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\x03') { // ctrl-c
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\x7f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function isEdgeRedirect(res) {
  return res.status >= 300 && res.status < 400;
}

// fetch that (a) attaches a stored Workbench edge session cookie so requests
// pass the SSO proxy, (b) transparently refreshes that cookie via the stored
// Workbench CLI token when it has expired, and (c) fails loudly (rather than
// parsing an HTML login page as JSON) when the host is still edge-gated.
async function apiFetch(url, opts = {}) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  const withCookie = (extra) => {
    const headers = { ...(opts.headers || {}) };
    const cookie = edgeCookieHeader(loadConfig(), origin);
    const merged = [opts.headers?.Cookie, cookie, extra]
      .filter(Boolean)
      .join("; ");
    if (merged) headers.Cookie = merged;
    return headers;
  };

  let res = await fetch(url, {
    ...opts,
    headers: withCookie(),
    redirect: "manual",
  });

  // Edge session missing/expired — if we hold a Workbench CLI token, mint a
  // fresh wb_session and retry once before giving up.
  if (isEdgeRedirect(res) && origin && hasWorkbench(loadConfig(), origin)) {
    const fresh = await refreshWbSession(origin).catch(() => null);
    if (fresh) {
      res = await fetch(url, {
        ...opts,
        headers: withCookie(fresh),
        redirect: "manual",
      });
    }
  }

  if (isEdgeRedirect(res)) {
    const loc = res.headers.get("location") || "(unknown)";
    die(`The server redirected this request to: ${loc}

That usually means the host is behind a browser SSO proxy (edge auth) that
blocks non-browser clients before they reach Propanes. Options:
  - connect through Workbench SSO (recommended for *.myworkbench.ai):
      propanes login --workbench --server ${origin || "<host>"}
  - or tunnel through the SSH gateway:
      propanes login --web --server <host> --gateway <gateway-host>`);
  }
  const ct = res.headers.get("content-type") || "";
  if (res.ok && !ct.includes("application/json")) {
    die(
      `Expected JSON from ${url} but got ${ct || "unknown content"} — is this really a Propanes server URL?`,
    );
  }
  return res;
}

// Decode a JWT payload without verifying (we trust it — it came from our own
// browser handoff or the server's login response). Used only to show the
// username and pick up expiry for local staleness checks.
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// SSH gateway address for a server, as "host" or "host:port". Lets the CLI
// reach sessions on hosts whose HTTP/WS API is behind a browser-SSO edge:
// the gateway is propanes-native auth on a raw TCP LoadBalancer that the edge
// never sees. Resolution order: --gateway flag, env, stored config.
function normalizeGateway(input) {
  if (!input || input === true) return null;
  const s = String(input).replace(/^ssh:\/\//, '');
  const m = s.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : 22 };
}

function gatewayFor(flags, cfg, server) {
  const raw = flags.gateway || process.env.PROPANES_GATEWAY || cfg.servers?.[server]?.gateway;
  return normalizeGateway(raw);
}

// Canonical "host:port" string to persist in config, preserving an existing
// value when --gateway isn't passed this run.
function normGw(flags, cfg, server) {
  const raw = (flags.gateway && flags.gateway !== true ? flags.gateway : null)
    || cfg.servers?.[server]?.gateway;
  const g = normalizeGateway(raw);
  return g ? `${g.host}:${g.port}` : undefined;
}

function knownHostsPath() {
  return join(CONFIG_DIR, 'known_hosts');
}

// Run a command on the SSH gateway, feeding the stored JWT as the SSH password
// non-interactively via SSH_ASKPASS (OpenSSH >= 8.4). tty:true allocates a PTY
// and inherits stdio (used for `attach`); otherwise stdout is captured.
function sshGateway(server, gw, token, username, remoteArgs, { tty = false } = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const askpass = join(CONFIG_DIR, `askpass-${process.pid}.sh`);
  writeFileSync(askpass, '#!/bin/sh\nprintf %s "$PROPANES_ASKPASS_TOKEN"\n', { mode: 0o700 });
  const args = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHostsPath()}`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-p', String(gw.port),
  ];
  if (tty) args.push('-t');
  args.push(`${username}@${gw.host}`, ...remoteArgs);
  const env = {
    ...process.env,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    PROPANES_ASKPASS_TOKEN: token,
  };
  const child = spawn('ssh', args, { env, stdio: tty ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
  const cleanup = () => { try { rmSync(askpass, { force: true }); } catch {} };
  child.on('exit', cleanup);
  child.on('error', cleanup);
  return child;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------- Workbench SSO (edge) ---------------------------------------------
// Hosts under *.myworkbench.ai are fronted by the Workbench SSO edge, which
// 302s any non-browser request. These helpers drive the Workbench CLI
// device-authorization flow (workbenchai/workbench#811): a browser-approved
// login yields a long-lived `wbcli_` token, which we exchange per host for the
// short-lived `wb_session` cookie the edge accepts — the same cookie a signed-in
// browser carries. Stored per propanes server under `.workbench` / `.wbSession`.

const DEFAULT_WB_EDGE = "https://app.myworkbench.ai";

function workbenchFor(cfg, server) {
  return cfg.servers?.[server]?.workbench || null;
}

function hasWorkbench(cfg, server) {
  return !!workbenchFor(cfg, server)?.token;
}

// Returns "wb_session=…" if a fresh cached edge session exists, else null.
function edgeCookieHeader(cfg, server) {
  const s = cfg.servers?.[server]?.wbSession;
  if (!s?.cookie) return null;
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return null;
  return s.cookie;
}

// Exchange the stored wbcli_ token for a fresh wb_session cookie for `server`'s
// host and cache it. Returns the cookie string or null.
async function refreshWbSession(server) {
  const cfg = loadConfig();
  const wb = workbenchFor(cfg, server);
  if (!wb?.token) return null;
  const host = wb.host || new URL(server).host;
  const res = await fetch(`${wb.edge}/auth/cli/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${wb.token}`,
    },
    body: JSON.stringify({ host }),
  });
  if (res.status === 401)
    die(
      `Workbench session rejected — re-run: propanes login --workbench --server ${server}`,
    );
  if (!res.ok) return null;
  const { sso_url } = await res.json().catch(() => ({}));
  if (!sso_url) return null;
  // GET the /sso/callback URL; the edge gateway answers with Set-Cookie
  // wb_session and a redirect — we want only the cookie, so don't follow it.
  const cb = await fetch(sso_url, { redirect: "manual" });
  const cookies =
    typeof cb.headers.getSetCookie === "function"
      ? cb.headers.getSetCookie()
      : [cb.headers.get("set-cookie") || ""];
  let cookie = null;
  let maxAge = null;
  for (const raw of cookies) {
    const m = raw && raw.match(/wb_session=([^;]+)/);
    if (m) {
      cookie = `wb_session=${m[1]}`;
      const ma = raw.match(/max-age=(\d+)/i);
      if (ma) maxAge = Number(ma[1]);
      break;
    }
  }
  if (!cookie) return null;
  // Default to 6 days if the cookie didn't advertise its own lifetime (the
  // edge issues 7-day sessions); we refresh proactively before it lapses.
  const ttlMs = (maxAge || 6 * 24 * 3600) * 1000;
  const next = loadConfig();
  next.servers[server] = next.servers[server] || {};
  next.servers[server].wbSession = {
    cookie,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  saveConfig(next);
  return cookie;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollWorkbenchToken(edge, deviceCode, intervalSec) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let interval = Math.max(2, intervalSec || 5);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let r, j;
    try {
      r = await fetch(`${edge}/auth/cli/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      j = await r.json().catch(() => ({}));
    } catch {
      continue; // network blip — keep polling until the deadline
    }
    if (r.ok && j.access_token) return j.access_token;
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (j.error === "access_denied") die("Authorization was denied in the browser.");
    if (j.error === "expired_token")
      die("The request expired before approval. Run login --workbench again.");
    // Transient (5xx / server_error / anything unexpected): a single blip —
    // e.g. a control-plane replica cycling — must not abort the whole login.
    if (r.status >= 500 || j.error === "server_error") continue;
    die(`Workbench authorization failed: ${j.error || `HTTP ${r.status}`}`);
  }
  die("Timed out waiting for browser approval (15 min).");
}

// propanes login --workbench [--server URL] [--edge https://app.myworkbench.ai]
async function cmdLoginWorkbench(flags) {
  const cfg = loadConfig();
  const server = resolveServer(flags, cfg);
  const edge = normalizeServer(
    flags.edge || process.env.PROPANES_WORKBENCH_EDGE || DEFAULT_WB_EDGE,
  );
  const host = new URL(server).host;

  const start = await fetch(`${edge}/auth/cli/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "propanes-cli" }),
  });
  if (!start.ok)
    die(
      `Couldn't start Workbench sign-in (HTTP ${start.status}). Is ${edge} the Workbench login host?`,
    );
  const grant = await start.json();
  console.log(`\nTo authorize this CLI, open:\n  ${grant.verification_uri}`);
  console.log(`and enter the code:  ${grant.user_code}\n`);
  openBrowser(grant.verification_uri_complete || grant.verification_uri);
  console.log("Waiting for you to approve in the browser…");

  const token = await pollWorkbenchToken(
    edge,
    grant.device_code,
    grant.interval,
  );
  const next = loadConfig();
  next.servers[server] = next.servers[server] || {};
  next.servers[server].workbench = { edge, token, host };
  next.defaultServer = next.defaultServer || server;
  saveConfig(next);

  const cookie = await refreshWbSession(server);
  if (!cookie)
    die(
      `Signed in to Workbench, but couldn't obtain an edge session for ${host}. ` +
        `Your account may not have access to that workspace.`,
    );
  console.log(
    `\nWorkbench SSO connected for ${host}. Propanes commands now pass the edge automatically.`,
  );
  const tok = tokenFor(next, server);
  if (!tok)
    console.log(
      `Next, sign in to Propanes itself:  propanes login --server ${server}`,
    );
}

// ---------- commands ----------

// Browser-assisted login: open /cli-auth in the user's browser (which carries
// any edge-SSO cookie the host requires) and receive the propanes JWT back on
// a loopback listener. Works on hosts whose API is behind a browser-SSO proxy
// that blocks direct CLI password login.
function cmdLoginWeb(flags) {
  const cfg = loadConfig();
  const rawServer = flags.server || process.env.PROPANES_SERVER || cfg.defaultServer;
  if (!rawServer) die('Specify the server: propanes login --web --server https://your-propanes-host');
  const server = normalizeServer(rawServer);
  const state = randomBytes(16).toString('hex');

  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const token = u.searchParams.get('token');
    const gotState = u.searchParams.get('state');
    const ok = token && gotState === state;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;background:#0f1420;color:#e6e9ef;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}</style><div><h2>${ok ? '✓ Propanes CLI connected' : '✗ Login failed'}</h2><p>${ok ? 'You can close this tab and return to your terminal.' : 'State mismatch — re-run propanes login --web.'}</p></div>`);
    srv.close();
    if (!ok) die('Login failed: state mismatch (possible CSRF) — please retry.');
    const claims = decodeJwt(token);
    cfg.servers = cfg.servers || {};
    cfg.servers[server] = {
      ...cfg.servers[server], // preserve workbench / wbSession
      token,
      username: claims.username || null,
      expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
      gateway: normGw(flags, cfg, server),
    };
    cfg.defaultServer = server;
    saveConfig(cfg);
    console.log(`\nLogged in to ${server} as ${claims.username || '(token)'}`);
    process.exit(0);
  });

  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    const authUrl = `${server}/cli-auth?port=${port}&state=${state}`;
    console.log('Opening your browser to complete login…');
    console.log(`If it doesn't open, visit:\n  ${authUrl}\n`);
    openBrowser(authUrl);
    console.log('Waiting for the browser to hand back your session (ctrl-c to cancel)…');
  });

  setTimeout(() => die('Timed out waiting for browser login (3 min).'), 180_000).unref();
}

async function cmdLogin(flags) {
  if (flags.workbench) return cmdLoginWorkbench(flags);
  if (flags.web) return cmdLoginWeb(flags);

  const cfg = loadConfig();
  const rawServer = flags.server || process.env.PROPANES_SERVER || cfg.defaultServer
    || (await prompt('Server URL: '));
  const server = normalizeServer(rawServer);

  if (flags.token) {
    const me = await apiFetch(`${server}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${flags.token}` },
    });
    if (!me.ok) die(`Token rejected by ${server} (HTTP ${me.status})`);
    const body = await me.json();
    cfg.servers = cfg.servers || {};
    cfg.servers[server] = { ...cfg.servers[server], token: flags.token, username: body.user?.username || null, expiresAt: null, gateway: normGw(flags, cfg, server) };
    cfg.defaultServer = server;
    saveConfig(cfg);
    console.log(`Logged in to ${server} as ${body.user?.username || '(token)'}`);
    return;
  }

  const username = flags.username || process.env.PROPANES_USERNAME || (await prompt('Username: '));
  const password = flags.password || process.env.PROPANES_PASSWORD || (await prompt('Password: ', { hidden: true }));

  const res = await apiFetch(`${server}/api/v1/auth/login`, {
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
  cfg.servers[server] = { ...cfg.servers[server], token: body.token, expiresAt: body.expiresAt, username, gateway: normGw(flags, cfg, server) };
  cfg.defaultServer = server;
  saveConfig(cfg);
  console.log(`Logged in to ${server} as ${username}`);
}

async function cmdSessions(flags) {
  const cfg = loadConfig();
  const server = resolveServer(flags, cfg);
  const token = tokenFor(cfg, server);
  if (!token) die(`Not logged in to ${server}. Run: propanes login --server ${server}`);

  // When a gateway is configured, list over it — the HTTP API may be behind an
  // SSO edge that blocks us. The gateway's own `list` is workspace-scoped too.
  const gw = gatewayFor(flags, cfg, server);
  if (gw) {
    const username = cfg.servers[server]?.username || decodeJwt(token).username;
    if (!username) die('No username on file for the gateway; re-run propanes login.');
    const child = sshGateway(server, gw, token, username, ['list']);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { process.stdout.write(out); process.exit(code || 0); });
    return;
  }

  const res = await adminGet(server, token, '/api/v1/admin/agent-sessions');
  if (!res.ok) die(`Failed to list sessions (HTTP ${res.status})`);
  const sessions = await res.json();
  const live = sessions.filter((s) => s.status === 'running' || s.status === 'pending');
  if (live.length === 0) {
    console.log('No running sessions.');
    return;
  }
  // <sessionId>  <status>  <feedbackId|->  <truncated feedback title>
  const cols = process.stdout.columns || 120;
  const headWidth = 26 + 2 + 8 + 2 + 26 + 2; // ULID + status + feedback ULID + gaps
  for (const s of live) {
    const title = s.feedbackTitle || s.title || s.agentName || '';
    console.log(
      `${s.id}  ${String(s.status).padEnd(8)}  ${(s.feedbackId || '-').padEnd(26)}  ${truncate(title, Math.max(24, cols - headWidth))}`,
    );
  }
  if (process.stdout.isTTY) {
    console.log('\nFull feedback: propanes feedback <feedback-id>   (or: propanes feedback --session <session-id>, propanes feedback -l)');
  }
}

function truncate(s, n) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, Math.max(1, n - 1))}…` : flat;
}

// Authenticated admin GET with the shared 401 → "re-login" mapping.
async function adminGet(server, token, path) {
  const res = await apiFetch(`${server}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) die(`Token expired. Run: propanes login --server ${server}`);
  return res;
}

// propanes feedback <feedbackId>            full item + all sessions for it
// propanes feedback -l [--limit N]          list items with latest session status
// propanes feedback --session <sessionId>   the feedback item behind a session
async function cmdFeedback(flags, positional) {
  const cfg = loadConfig();
  const server = resolveServer(flags, cfg);
  const token = tokenFor(cfg, server);
  if (!token) die(`Not logged in to ${server}. Run: propanes login --server ${server}`);

  const listMode = !!flags.list || positional.includes('-l');
  let feedbackId = positional.find((p, i) => i > 0 && !p.startsWith('-')) || null;

  if (!listMode && flags.session) {
    if (flags.session === true) die('Usage: propanes feedback --session <session-id>');
    const res = await adminGet(server, token, `/api/v1/admin/agent-sessions/${encodeURIComponent(flags.session)}`);
    if (res.status === 404) die(`Session not found: ${flags.session}`);
    if (!res.ok) die(`Failed to load session (HTTP ${res.status})`);
    const session = await res.json();
    if (!session.feedbackId) die(`Session ${flags.session} has no linked feedback item.`);
    feedbackId = session.feedbackId;
  }

  if (listMode) {
    const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 20;
    const res = await adminGet(server, token, `/api/v1/admin/feedback?limit=${limit}`);
    if (!res.ok) die(`Failed to list feedback (HTTP ${res.status})`);
    const { items = [], total = 0 } = await res.json();
    if (items.length === 0) {
      console.log('No feedback items.');
      return;
    }
    // <feedbackId>  <latest session status>  <truncated title>
    const cols = process.stdout.columns || 120;
    for (const f of items) {
      const sess = f.latestSessionStatus || 'not dispatched';
      const extra = f.sessionCount > 1 ? ` (${f.sessionCount} sessions)` : '';
      console.log(`${f.id}  ${sess.padEnd(14)}  ${truncate(f.title, Math.max(24, cols - 26 - 14 - 6 - extra.length))}${extra}`);
    }
    if (total > items.length && process.stdout.isTTY) {
      console.log(`\nShowing ${items.length} of ${total} — use --limit N for more.`);
    }
    return;
  }

  if (!feedbackId) die('Usage: propanes feedback <feedback-id> | -l | --session <session-id>');

  const res = await adminGet(server, token, `/api/v1/admin/feedback/${encodeURIComponent(feedbackId)}`);
  if (res.status === 404) die(`Feedback not found: ${feedbackId}`);
  if (!res.ok) die(`Failed to load feedback (HTTP ${res.status})`);
  const fb = await res.json();

  const sessRes = await adminGet(server, token, `/api/v1/admin/agent-sessions?feedbackId=${encodeURIComponent(fb.id)}`);
  const sessions = sessRes.ok ? await sessRes.json() : [];

  console.log(`${fb.id}  [${fb.status}]`);
  console.log(`Title:       ${fb.title || '(untitled)'}`);
  console.log(`Type:        ${fb.type}`);
  if (fb.appId) console.log(`App:         ${fb.appId}`);
  console.log(`Created:     ${fb.createdAt}`);
  if (fb.dispatchedTo) {
    console.log(`Dispatched:  ${fb.dispatchedTo} at ${fb.dispatchedAt}${fb.dispatchStatus ? ` — ${fb.dispatchStatus}` : ''}`);
  }
  if (fb.tags?.length) console.log(`Tags:        ${fb.tags.join(', ')}`);
  if (fb.sourceUrl) console.log(`URL:         ${fb.sourceUrl}`);
  if (fb.description && fb.description !== fb.title) {
    console.log(`\nDescription:\n${fb.description}`);
  }
  console.log(`\nSessions (${sessions.length}):`);
  if (sessions.length === 0) {
    console.log('  (none — not dispatched yet)');
  } else {
    for (const s of sessions) {
      const when = s.startedAt || s.createdAt || '';
      console.log(`  ${s.id}  ${String(s.status).padEnd(9)}  ${s.agentName || s.runtime || ''}  ${when}`);
    }
    if (process.stdout.isTTY) console.log('\nAttach: propanes attach <session-id>');
  }
}

function cmdAttach(flags, sessionId) {
  if (!sessionId) die('Usage: propanes attach <sessionId>');
  sessionId = sessionId.replace(/^pw-/, '');
  const cfg = loadConfig();
  const server = resolveServer(flags, cfg);
  const token = tokenFor(cfg, server);
  if (!token) die(`Not logged in to ${server}. Run: propanes login --server ${server}`);

  // Gateway path: attach natively over SSH (bypasses any SSO edge on the HTTP
  // ingress). ssh inherits the terminal; detach with the ssh escape `~.`.
  const gw = gatewayFor(flags, cfg, server);
  if (gw) {
    const username = cfg.servers[server]?.username || decodeJwt(token).username;
    if (!username) die('No username on file for the gateway; re-run propanes login.');
    if (process.stdin.isTTY) process.stderr.write(`Attaching to ${sessionId} via gateway ${gw.host} (detach: press Enter then ~.)\n`);
    const child = sshGateway(server, gw, token, username, ['attach', sessionId], { tty: true });
    child.on('exit', (code) => process.exit(code || 0));
    return;
  }

  const wsBase = server.replace(/^http/, 'ws');
  const isTty = process.stdin.isTTY && process.stdout.isTTY;

  let ws = null;
  let inputSeq = 0;
  let lastOutputSeq = 0;
  let sawHistory = false;
  let exiting = false;
  let reconnectDelay = 300;
  let edgeRetried = false;
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
    // Attach the Workbench edge session cookie (if any) so the WS upgrade
    // passes the SSO proxy; the app-level auth is still the ?token= query.
    const cookie = edgeCookieHeader(loadConfig(), server);
    const wsOpts = cookie ? { headers: { Cookie: cookie } } : undefined;
    ws = new WebSocket(`${wsBase}/ws/agent-session?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`, wsOpts);

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

    // An edge-SSO proxy answers the WS upgrade with a 3xx redirect. If we hold
    // a Workbench token, refresh the edge session and reconnect once; otherwise
    // surface it clearly instead of reconnect-looping forever.
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        if (hasWorkbench(loadConfig(), server) && !edgeRetried) {
          edgeRetried = true;
          refreshWbSession(server)
            .then((fresh) => {
              if (fresh) { try { ws.terminate(); } catch {} connect(); }
              else edgeBlockedExit(res);
            })
            .catch(() => edgeBlockedExit(res));
          return;
        }
        edgeBlockedExit(res);
      } else {
        cleanupAndExit(1, `WebSocket upgrade failed: HTTP ${res.statusCode}`);
      }
    });
  }

  function edgeBlockedExit(res) {
    cleanupAndExit(1, `WebSocket upgrade was redirected (HTTP ${res.statusCode} → ${res.headers.location || '?'}).
The host is behind a browser SSO proxy. Connect through Workbench SSO:
  propanes login --workbench --server ${server}
or tunnel through the SSH gateway (propanes login --web --gateway <host>).`);
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
    // osacompile omits CFBundleIdentifier on newer macOS — Set fails on a missing key.
    try {
      pb('Set :CFBundleIdentifier ai.propanes.launcher');
    } catch {
      pb('Add :CFBundleIdentifier string ai.propanes.launcher');
    }
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
  propanes login --workbench [--server URL] [--edge URL]
                                           Sign in through Workbench SSO so
                                           requests pass the *.myworkbench.ai edge
  propanes login --web [--server URL] [--gateway HOST[:PORT]]
                                           Log in via the browser (works when
                                           the API is behind a browser-SSO proxy);
                                           --gateway routes sessions/attach over
                                           the SSH gateway automatically
  propanes attach <sessionId> [--server URL]
  propanes sessions [--server URL]
  propanes feedback <feedbackId>           Show a feedback item + its sessions
  propanes feedback -l [--limit N]         List feedback with latest session status
  propanes feedback --session <sessionId>  Show the feedback behind a session
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
  case 'feedback':
  case 'fb':
    await cmdFeedback(flags, positional);
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
