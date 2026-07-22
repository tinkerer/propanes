import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { feedbackRoutes } from './routes/feedback.js';
import { adminRoutes } from './routes/admin/index.js';
import { imageRoutes } from './routes/images.js';
import { screenshotRoutes } from './routes/screenshots.js';
import { uploadRoutes } from './routes/uploads.js';
import { audioRoutes } from './routes/audio.js';
import { voiceRoutes } from './routes/voice.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agent.js';
import { applicationRoutes } from './routes/applications.js';
import { agentSessionRoutes } from './routes/agent-sessions.js';
import { aggregateRoutes } from './routes/aggregate.js';
import launcherRoutes from './routes/launchers.js';
import machineRoutes from './routes/machines.js';
import harnessConfigRoutes from './routes/harness-configs.js';
import spriteConfigRoutes from './routes/sprites.js';
import wiggumRoutes from './routes/wiggum.js';
import localRoutes from './routes/local.js';
import { gettingStartedMarkdown } from './getting-started.js';
import { requireAdminAuth } from './admin-auth.js';

export const app = new Hono();

app.use('*', logger());
// Reflect the request Origin header instead of returning "*". A wildcard
// Access-Control-Allow-Origin is rejected by browsers whenever the request
// uses credentials-mode "include" (cookies, auth headers on cross-origin
// fetches) — which is what happens when the widget is embedded on a page
// at a different origin than the propanes server. Reflecting the origin
// makes the response compatible with both credentialed and plain CORS
// requests.
app.use(
  '/api/*',
  cors({
    origin: (origin) => origin || '*',
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  })
);

app.get('/api/v1/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// Browser-assisted CLI login. The @propanes/cli `login --web` flow opens this
// page in the user's browser; because the browser already carries whatever
// edge/SSO cookie the host requires (and the propanes JWT the admin SPA stored
// in localStorage), this page can hand that JWT back to the CLI's loopback
// listener on 127.0.0.1 — letting the CLI authenticate on hosts whose API is
// behind a browser-SSO proxy that blocks non-browser clients directly.
//
// Security: the only value reflected into the redirect target is the numeric
// loopback port; the host is hard-pinned to 127.0.0.1, so this can't be turned
// into an open redirect. The token never leaves the user's machine (propanes
// origin → localhost).
app.get('/cli-auth', (c) => {
  const port = c.req.query('port') || '';
  const state = c.req.query('state') || '';
  if (!/^\d{1,5}$/.test(port) || !/^[a-zA-Z0-9_-]{8,64}$/.test(state)) {
    return c.html('<h3>Invalid CLI auth request</h3><p>Missing or malformed port/state. Re-run <code>propanes login --web</code>.</p>', 400);
  }
  const portJson = JSON.stringify(port);
  const stateJson = JSON.stringify(state);
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Propanes CLI login</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1420;color:#e6e9ef;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.card{background:#161c2b;border:1px solid #26304a;border-radius:12px;padding:28px 32px;max-width:440px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.4)}
h2{margin:0 0 10px;font-size:18px}p{color:#9aa4bd;font-size:14px;line-height:1.5;margin:8px 0}
a.btn,button.btn{display:inline-block;margin-top:14px;padding:9px 18px;border-radius:8px;border:none;background:#f5c542;color:#1a1a1a;font-weight:600;font-size:14px;cursor:pointer;text-decoration:none}
code{background:#0c111b;padding:2px 6px;border-radius:4px;font-size:12.5px}</style></head>
<body><div class="card" id="card">
<h2>Connecting the Propanes CLI…</h2>
<p id="status">Checking your browser session…</p>
<div id="actions"></div>
</div>
<script>
(function(){
  var PORT=${portJson}, STATE=${stateJson};
  var statusEl=document.getElementById('status'), actionsEl=document.getElementById('actions');
  function handoff(token){
    statusEl.textContent='Login found — returning to your terminal…';
    // Top-level navigation to the loopback (not fetch — avoids mixed-content
    // blocking of an http subresource from this https page).
    window.location.href='http://127.0.0.1:'+PORT+'/callback?state='+encodeURIComponent(STATE)+'&token='+encodeURIComponent(token);
  }
  function noToken(){
    statusEl.innerHTML='You are not logged in to Propanes in this browser yet.';
    actionsEl.innerHTML='<a class="btn" href="/admin" target="_blank" rel="noopener">Open Propanes admin to log in</a>'+
      '<p style="margin-top:14px">Then come back here and click Retry.</p>'+
      '<button class="btn" id="retry">Retry</button>';
    document.getElementById('retry').onclick=check;
  }
  function check(){
    var t=null; try{t=localStorage.getItem('pw-admin-token');}catch(e){}
    if(t) handoff(t); else noToken();
  }
  check();
})();
</script></body></html>`);
});

app.get('/api/v1/bookmarklet', (c) => {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host') || 'localhost:3001';
  const baseUrl = `${proto}://${host}`;
  // Use iframe approach to bypass CSP restrictions on target pages
  const js = `javascript:void((function(){var e=document.getElementById('pw-bookmarklet-frame');if(e){e.remove();return}var f=document.createElement('iframe');f.id='pw-bookmarklet-frame';f.src='${baseUrl}/widget/bookmarklet.html?host='+encodeURIComponent(location.href);f.style.cssText='position:fixed;bottom:0;right:0;width:420px;height:100%;border:none;z-index:2147483647;pointer-events:none;';f.allow='clipboard-write';window.addEventListener('message',function(m){if(m.data&&m.data.type==='pw-bookmarklet-remove'){var el=document.getElementById('pw-bookmarklet-frame');if(el)el.remove()}});document.body.appendChild(f)})())`;
  c.header('Content-Type', 'text/plain; charset=utf-8');
  return c.body(js);
});

app.route('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/admin/*', requireAdminAuth);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/images', imageRoutes);
app.route('/api/v1/screenshots', screenshotRoutes);
app.route('/api/v1/uploads', uploadRoutes);
app.route('/api/v1/audio', audioRoutes);
app.route('/api/v1/voice', voiceRoutes);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/agent', agentRoutes);
app.route('/api/v1/admin/applications', applicationRoutes);
app.route('/api/v1/admin/agent-sessions', agentSessionRoutes);
app.route('/api/v1/admin/aggregate', aggregateRoutes);
app.route('/api/v1/admin/launchers', launcherRoutes);
app.route('/api/v1/admin/machines', machineRoutes);
app.route('/api/v1/admin/harness-configs', harnessConfigRoutes);
app.route('/api/v1/admin/sprite-configs', spriteConfigRoutes);
app.route('/api/v1/admin/wiggum', wiggumRoutes);
app.route('/api/v1/local', localRoutes);

app.get('/GETTING_STARTED.md', (c) => {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host') || 'localhost:3001';
  const baseUrl = `${proto}://${host}`;
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  return c.body(gettingStartedMarkdown(baseUrl));
});

// Bookmarklet embed page — loads the widget inside an iframe to bypass CSP
app.get('/widget/bookmarklet.html', (c) => {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('host') || 'localhost:3001';
  const baseUrl = `${proto}://${host}`;
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;pointer-events:none;}
propanes-host{pointer-events:auto;}</style></head>
<body>
<script src="${baseUrl}/widget/propanes.js"
  data-endpoint="${baseUrl}/api/v1/feedback"
  data-mode="always"
  data-bookmarklet-host-url></script>
<script>
(function(){
  var params = new URLSearchParams(location.search);
  var hostUrl = params.get('host') || '';
  var s = document.querySelector('script[data-bookmarklet-host-url]');
  if (s) s.setAttribute('data-bookmarklet-host-url', hostUrl);
  // Pass host URL to widget via meta update after connect
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'pw-bookmarklet-close') {
      parent.postMessage({type:'pw-bookmarklet-remove'}, '*');
    }
  });
})();
</script>
</body></html>`);
});

// Serve static files from the filesystem (e.g. /tmp/foo.txt → /files/tmp/foo.txt)
app.get('/files/*', async (c) => {
  const filePath = c.req.path.replace('/files', '');
  // Block path traversal
  if (filePath.includes('..')) return c.text('Forbidden', 403);
  const { createReadStream, stat } = await import('node:fs');
  const { promisify } = await import('node:util');
  const fsStat = promisify(stat);
  try {
    const s = await fsStat(filePath);
    if (!s.isFile()) return c.text('Not a file', 400);
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const mimeMap: Record<string, string> = {
      html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
      json: 'application/json', txt: 'text/plain', md: 'text/plain',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', pdf: 'application/pdf', xml: 'application/xml',
      csv: 'text/csv', log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml',
      ts: 'text/plain', tsx: 'text/plain', py: 'text/plain', sh: 'text/plain',
      c: 'text/plain', cpp: 'text/plain', h: 'text/plain', rs: 'text/plain',
      go: 'text/plain', java: 'text/plain', rb: 'text/plain',
    };
    c.header('Content-Type', mimeMap[ext] || 'application/octet-stream');
    c.header('Content-Length', String(s.size));
    const { Readable } = await import('node:stream');
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    return new Response(webStream, { headers: c.res.headers });
  } catch {
    return c.text('Not found', 404);
  }
});

// Serve widget JS from the widget package build output
app.use('/widget/*', serveStatic({ root: '../widget/dist/', rewriteRequestPath: (path) => path.replace('/widget', '') }));

// Serve admin SPA from the admin package build output.
//
// The admin's index.html embeds the feedback widget with a hardcoded
// `data-app-key` that must match the admin app's current apiKey in the DB.
// Hardcoding drifts whenever the DB is reseeded — so we swap a sentinel
// (`__ADMIN_API_KEY__`) at serve time with the live key. Serves with
// no-cache to always pick up fresh builds + current key.
const ADMIN_DIST = resolvePath(process.cwd(), '../admin/dist');
const ADMIN_KEY_SENTINEL = '__ADMIN_API_KEY__';
const SELF_PROJECT_DIR = resolvePath(process.cwd(), '..', '..');

function resolveAdminAppApiKey(): string | null {
  const byDir = db
    .select({ apiKey: schema.applications.apiKey })
    .from(schema.applications)
    .where(eq(schema.applications.projectDir, SELF_PROJECT_DIR))
    .get();
  if (byDir?.apiKey) return byDir.apiKey;
  const byName = db
    .select({ apiKey: schema.applications.apiKey })
    .from(schema.applications)
    .where(eq(schema.applications.name, 'Propanes Admin'))
    .get();
  if (byName?.apiKey) return byName.apiKey;
  const any = db.select({ apiKey: schema.applications.apiKey }).from(schema.applications).get();
  return any?.apiKey ?? null;
}

async function serveAdminIndex(c: any) {
  const indexPath = resolvePath(ADMIN_DIST, 'index.html');
  let html: string;
  try {
    html = await readFile(indexPath, 'utf8');
  } catch {
    return c.text('admin/dist/index.html not found — run `pnpm -F @propanes/admin build`', 500);
  }
  const key = resolveAdminAppApiKey();
  if (key) html = html.split(ADMIN_KEY_SENTINEL).join(key);
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  return c.body(html);
}

app.get('/admin', serveAdminIndex);
app.get('/admin/', serveAdminIndex);
app.get('/admin/index.html', serveAdminIndex);

app.use('/admin/*', serveStatic({ root: '../admin/dist/', rewriteRequestPath: (path) => path.replace('/admin', '') }));
// SPA fallback for admin routes — any unmatched /admin/<route> gets the SPA shell.
app.get('/admin/*', serveAdminIndex);

// Per-user workspace paths: /<username> (e.g. /maksym) serves the same SPA
// shell. The build's asset base is /admin/, so index.html loads its JS/CSS/
// manifest from the absolute /admin/ path regardless of which user path the
// shell was served at; the SPA resolves the operator from its own JWT and
// routes internally via the URL hash. Reserved top-level segments fall through
// to their real handlers (static assets / the public catch-all).
const RESERVED_TOP = new Set([
  'api', 'admin', 'widget', 'files', 'public', 'sso', '_gw',
  'favicon.ico', 'GETTING_STARTED.md',
]);
const perUserShell = (c: any, next: any) => {
  const seg = c.req.path.split('/').filter(Boolean)[0] || '';
  return RESERVED_TOP.has(seg) ? next() : serveAdminIndex(c);
};
app.get('/:user', perUserShell);
app.get('/:user/*', perUserShell);

// The service root serves the SPA shell (which shows login when unauthenticated
// and, once signed in, sends the operator to their own /<username> workspace).
// No longer defaults to /admin — each user gets their own path.
app.get('/', serveAdminIndex);

// Serve test page and other static files
app.use('/*', serveStatic({ root: './public/' }));
