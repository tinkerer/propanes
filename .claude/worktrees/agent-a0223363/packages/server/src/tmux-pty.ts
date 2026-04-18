import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import * as pty from 'node-pty';

const TMUX_PREFIX = 'pw-';
const PW_TMUX_CONF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tmux-pw.conf');

let tmuxAvailable: boolean | null = null;

export function isTmuxAvailable(): boolean {
  if (tmuxAvailable !== null) return tmuxAvailable;
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
  }
  return tmuxAvailable;
}

function tmuxName(sessionId: string): string {
  return `${TMUX_PREFIX}${sessionId}`;
}

const TMUX_SOCKET = ['-L', 'prompt-widget'];

function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const { CLAUDECODE, ...rest } = process.env as Record<string, string>;
  return { ...rest, ...extra, TERM: 'xterm-256color' };
}

export function tmuxSessionExists(sessionId: string): boolean {
  const name = tmuxName(sessionId);
  const r = spawnSync('tmux', [...TMUX_SOCKET, 'has-session', '-t', name], { stdio: 'pipe' });
  return r.status === 0;
}

export function spawnInTmux(params: {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}): { ptyProcess: pty.IPty; tmuxSessionName: string } {
  const { sessionId, command, args, cwd, cols, rows, env } = params;
  const name = tmuxName(sessionId);

  const shellCmd = [command, ...args].map(a => {
    if (a.includes("'") || a.includes(' ') || a.includes('"') || a.includes('\\') || a.includes('$') || a.includes('\n') || a.includes('(') || a.includes(')') || a.includes('*')) {
      return `'${a.replace(/'/g, "'\\''")}'`;
    }
    return a;
  }).join(' ');

  // tmux new-session has a command length limit (~2KB). For long prompts,
  // write a launcher script and execute that instead.
  const TMUX_CMD_LIMIT = 1500;
  let tmuxCmd: string;
  let scriptPath: string | null = null;

  if (shellCmd.length > TMUX_CMD_LIMIT) {
    scriptPath = join(tmpdir(), `pw-launch-${sessionId}.sh`);
    writeFileSync(scriptPath, `#!/bin/bash\ncd ${cwd.replace(/'/g, "'\\''")}\nexec ${shellCmd}\n`);
    chmodSync(scriptPath, 0o755);
    tmuxCmd = scriptPath;
  } else {
    tmuxCmd = shellCmd;
  }

  try {
    execFileSync('tmux', [
      ...TMUX_SOCKET,
      '-f', PW_TMUX_CONF,
      'new-session', '-d',
      '-s', name,
      '-x', String(cols),
      '-y', String(rows),
      '-c', cwd,
      tmuxCmd,
    ], {
      stdio: 'pipe',
      env: cleanEnv(env),
    });
  } catch (err) {
    if (scriptPath) try { unlinkSync(scriptPath); } catch {}
    throw err;
  }

  const ptyProcess = pty.spawn('tmux', [...TMUX_SOCKET, 'attach-session', '-t', name], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: cleanEnv(env),
  });

  return { ptyProcess, tmuxSessionName: name };
}

export function reattachTmux(params: {
  sessionId: string;
  cols: number;
  rows: number;
}): pty.IPty {
  const { sessionId, cols, rows } = params;
  const name = tmuxName(sessionId);

  if (!tmuxSessionExists(sessionId)) {
    throw new Error(`tmux session ${name} does not exist`);
  }

  return pty.spawn('tmux', [...TMUX_SOCKET, 'attach-session', '-t', name], {
    name: 'xterm-256color',
    cols,
    rows,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
}

export function killTmuxSession(sessionId: string): boolean {
  const name = tmuxName(sessionId);
  const r = spawnSync('tmux', [...TMUX_SOCKET, 'kill-session', '-t', name], { stdio: 'pipe' });
  return r.status === 0;
}

export function captureTmuxPane(sessionId: string): string {
  const name = tmuxName(sessionId);
  try {
    const output = execFileSync('tmux', [
      ...TMUX_SOCKET, 'capture-pane', '-t', name, '-p', '-S', '-',
    ], { stdio: 'pipe', encoding: 'utf-8' });
    return output;
  } catch {
    return '';
  }
}

export function listPwTmuxSessions(): string[] {
  try {
    const output = execFileSync('tmux', [
      ...TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}',
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .split('\n')
      .filter(s => s.startsWith(TMUX_PREFIX))
      .map(s => s.slice(TMUX_PREFIX.length));
  } catch {
    return [];
  }
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export function listDefaultTmuxSessions(): TmuxSessionInfo[] {
  try {
    const output = execFileSync('tmux', [
      'list-sessions', '-F',
      '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}',
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter(line => !line.startsWith(TMUX_PREFIX))
      .map(line => {
        const [name, windows, created, attached] = line.split('\t');
        return {
          name,
          windows: parseInt(windows, 10) || 1,
          created: new Date(parseInt(created, 10) * 1000).toISOString(),
          attached: attached === '1',
        };
      });
  } catch {
    return [];
  }
}

export function attachDefaultTmuxSession(params: {
  sessionId: string;
  tmuxTarget: string;
  cols: number;
  rows: number;
}): { ptyProcess: pty.IPty; tmuxSessionName: string } {
  const { sessionId, tmuxTarget, cols, rows } = params;
  const pwName = tmuxName(sessionId);

  // Create a pw-prefixed tmux session in our socket that runs `tmux attach -t <target>` on the default server.
  // This lets us bridge the default tmux session into our prompt-widget PTY infrastructure.
  const attachCmd = `tmux attach-session -t ${tmuxTarget.replace(/'/g, "'\\''")}`;
  execFileSync('tmux', [
    ...TMUX_SOCKET,
    '-f', PW_TMUX_CONF,
    'new-session', '-d',
    '-s', pwName,
    '-x', String(cols),
    '-y', String(rows),
    attachCmd,
  ], {
    stdio: 'pipe',
    env: cleanEnv(),
  });

  const ptyProcess = pty.spawn('tmux', [...TMUX_SOCKET, 'attach-session', '-t', pwName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: cleanEnv(),
  });

  return { ptyProcess, tmuxSessionName: pwName };
}

export function detachTmuxClients(sessionId: string): void {
  const name = tmuxName(sessionId);
  spawnSync('tmux', [...TMUX_SOCKET, 'detach-client', '-s', name], { stdio: 'pipe' });
}

// Monitor a tmux pane for OSC 9/777 notifications (Claude Code waiting-for-input signals).
// Uses pipe-pane to see raw output before tmux strips OSC sequences.
export function installPipeMonitor(sessionId: string, port: number): void {
  const name = tmuxName(sessionId);
  // Only match OSC 9/777 notification sequences (Claude Code waiting-for-input signals).
  // Do NOT match bare \x07 — it's the terminator for all OSC sequences (window titles etc.)
  // and would fire constantly. The tmux alert-bell hook handles standalone BEL separately.
  const pipeCmd = `perl -ne 'if (/\\x1b\\](9;|777;notify;)/) { system("curl -s -X POST http://localhost:${port}/bell/${name} >/dev/null 2>&1 &") }'`;
  try {
    execFileSync('tmux', [...TMUX_SOCKET, 'pipe-pane', '-t', name, '-o', pipeCmd], { stdio: 'pipe' });
  } catch {}
}
