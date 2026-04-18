import { Hono } from 'hono';

const localRoutes = new Hono();

// Bridge page — opened via window.open from remote admins to bypass Private Network Access.
// Params come in the URL hash (never sent to server), parsed client-side, then POSTed same-origin.
localRoutes.get('/bridge', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Local Bridge</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #16213e; border-radius: 12px; padding: 24px 32px; text-align: center;
          box-shadow: 0 4px 24px rgba(0,0,0,0.4); max-width: 400px; }
  .status { margin-top: 12px; font-size: 14px; color: #8b8fa3; }
  .ok { color: #4ade80; }
  .err { color: #f87171; }
</style></head><body>
<div class="card">
  <div style="font-size:20px;font-weight:600">Local Terminal Bridge</div>
  <div class="status" id="status">Connecting...</div>
</div>
<script>
(async () => {
  const el = document.getElementById('status');
  try {
    const params = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    el.textContent = 'Opening terminal...';
    const res = await fetch('/api/v1/local/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.ok) {
      el.textContent = 'Terminal opened';
      el.className = 'status ok';
      setTimeout(() => window.close(), 1500);
    } else {
      el.textContent = data.error || 'Unknown error';
      el.className = 'status err';
    }
  } catch (e) {
    el.textContent = e.message;
    el.className = 'status err';
  }
})();
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

export default localRoutes;
