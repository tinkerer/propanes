import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { feedbackRoutes } from './routes/feedback.js';
import { adminRoutes } from './routes/admin.js';
import { imageRoutes } from './routes/images.js';
import { audioRoutes } from './routes/audio.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agent.js';
import { applicationRoutes } from './routes/applications.js';
import { agentSessionRoutes } from './routes/agent-sessions.js';
import { aggregateRoutes } from './routes/aggregate.js';
import launcherRoutes from './routes/launchers.js';
import machineRoutes from './routes/machines.js';
import harnessConfigRoutes from './routes/harness-configs.js';
import spriteConfigRoutes from './routes/sprites.js';
import { gettingStartedMarkdown } from './getting-started.js';

export const app = new Hono();

app.use('*', logger());
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  })
);

app.get('/api/v1/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
);

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
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/images', imageRoutes);
app.route('/api/v1/audio', audioRoutes);
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/agent', agentRoutes);
app.route('/api/v1/admin/applications', applicationRoutes);
app.route('/api/v1/admin/agent-sessions', agentSessionRoutes);
app.route('/api/v1/admin/aggregate', aggregateRoutes);
app.route('/api/v1/admin/launchers', launcherRoutes);
app.route('/api/v1/admin/machines', machineRoutes);
app.route('/api/v1/admin/harness-configs', harnessConfigRoutes);
app.route('/api/v1/admin/sprite-configs', spriteConfigRoutes);

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
prompt-widget-host{pointer-events:auto;}</style></head>
<body>
<script src="${baseUrl}/widget/prompt-widget.js"
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

// Serve widget JS from the widget package build output
app.use('/widget/*', serveStatic({ root: '../widget/dist/', rewriteRequestPath: (path) => path.replace('/widget', '') }));

// Serve admin SPA from the admin package build output
app.use('/admin/*', serveStatic({ root: '../admin/dist/', rewriteRequestPath: (path) => path.replace('/admin', '') }));
// SPA fallback for admin routes
app.get('/admin/*', serveStatic({ root: '../admin/dist/', path: 'index.html' }));

// Serve test page and other static files
app.use('/*', serveStatic({ root: './public/' }));
