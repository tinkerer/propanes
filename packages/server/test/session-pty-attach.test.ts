import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { isTmuxAvailable, killTmuxSession, getTmuxPaneArgv } from '../src/tmux-pty.js';

test('attaching repairs a live interactive pane that replaced a stream agent', {
  skip: !isTmuxAvailable() && 'tmux required', timeout: 20_000,
}, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pty-attach-'));
  process.env.DB_PATH = join(temp, 'test.db');
  const { db, schema, sqlite, runMigrations } = await import('../src/db/index.js');
  runMigrations();
  const id = `profile-test-${process.pid}`;
  const cliDir = join(temp, '@anthropic-ai', 'claude-code');
  mkdirSync(cliDir, { recursive: true });
  const cli = join(cliDir, 'cli.js');
  writeFileSync(cli, 'console.log("STATIC CONVERSATION\\nREADY PROMPT"); setInterval(() => {}, 1000);');
  const tmux = (...args: string[]) => execFileSync('tmux', ['-u', '-L', 'propanes', ...args], { encoding: 'utf8' });
  const portServer = createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  let service: ReturnType<typeof spawn> | undefined;
  let ws: WebSocket | undefined;
  let log = '';
  try {
    tmux('new-session', '-d', '-s', `pw-${id}`, '-x', '120', '-y', '24',
      process.execPath, cli, '--print');
    db.insert(schema.agentSessions).values({
      id, runtime: 'claude', permissionProfile: 'headless-stream-yolo',
      status: 'running', tmuxSessionName: `pw-${id}`, cwd: temp,
      outputBytes: 0, createdAt: new Date().toISOString(),
    }).run();
    service = spawn(process.execPath, ['--import', 'tsx', 'src/session-service.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, SESSION_SERVICE_PORT: String(port), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout?.on('data', data => { log += data; });
    service.stderr?.on('data', data => { log += data; });
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!condition() && Date.now() < deadline) await delay(25);
      assert.ok(condition(), log);
    };
    await waitFor(() => log.includes('Running on http://'));
    assert.equal(tmux('display-message', '-p', '-t', `pw-${id}`, '#{pane_width}').trim(), '10000');
    tmux('respawn-pane', '-k', '-t', `pw-${id}`, process.execPath, cli,
      '--dangerously-skip-permissions', 'Please fix --output-format stream-json and -p');
    await waitFor(() => getTmuxPaneArgv(id).some(argv => argv.includes('--dangerously-skip-permissions')));
    const pid = tmux('display-message', '-p', '-t', `pw-${id}`, '#{pane_pid}').trim();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-session?sessionId=${id}`);
    const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    await waitFor(() => messages.some(m => m.type === 'history'));
    assert.equal(messages.find(m => m.type === 'history').cols, 120);
    assert.equal((sqlite.prepare('SELECT permission_profile FROM agent_sessions WHERE id = ?').get(id) as any).permission_profile, 'interactive-yolo');
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await waitFor(() => messages.some(m => m.type === 'pty_size' && m.cols === 80));
    assert.equal(tmux('display-message', '-p', '-t', `pw-${id}`, '#{pane_width}').trim(), '80');
    assert.equal(tmux('display-message', '-p', '-t', `pw-${id}`, '#{pane_pid}').trim(), pid, 'agent was not restarted');
  } finally {
    ws?.terminate();
    if (service && service.exitCode === null) {
      service.kill('SIGTERM');
      await once(service, 'exit');
    }
    killTmuxSession(id);
    sqlite.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
