import WebSocket from 'ws';
import * as os from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { execSync, execFileSync } from 'node:child_process';
import type {
  LauncherRegister,
  LauncherHeartbeat,
  LauncherSessionStarted,
  LauncherSessionOutput,
  LauncherSessionEnded,
  HarnessStatusUpdate,
  ServerToLauncherMessage,
  LauncherCapabilities,
  SequencedOutput,
  SessionOutputData,
  LaunchHarnessSession,
  ImportSessionFiles,
  ImportSessionFilesResult,
  ExportSessionFiles,
  ExportSessionFilesResult,
  SyncCodebase,
  SyncCodebaseResult,
  SyncCodebaseToContainer,
  SyncCodebaseToContainerResult,
  ListTmuxSessionsResult,
  CheckClaudeAuthResult,
  CheckContainerClaudeResult,
  LauncherHealthCheckResult,
  SendKeysResult,
  CapturePaneResult,
} from '@prompt-widget/shared';
import {
  isTmuxAvailable,
  spawnInTmux,
  reattachTmux,
  tmuxSessionExists,
  killTmuxSession,
  captureTmuxPane,
  listPwTmuxSessions,
  listDefaultTmuxSessions,
  attachDefaultTmuxSession,
  detachTmuxClients,
} from './tmux-pty.js';
import {
  computeJsonlDir,
  exportSessionFiles as exportSessionFilesLocal,
  extractArtifactPaths,
} from './jsonl-utils.js';

const SERVER_WS_URL = process.env.SERVER_WS_URL || 'ws://localhost:3001/ws/launcher';
const LAUNCHER_ID = process.env.LAUNCHER_ID || `launcher-${os.hostname()}`;
const LAUNCHER_NAME = process.env.LAUNCHER_NAME || os.hostname();
const LAUNCHER_AUTH_TOKEN = process.env.LAUNCHER_AUTH_TOKEN || '';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);
const MACHINE_ID = process.env.MACHINE_ID || undefined;
const LAUNCHER_VERSION = (globalThis as any).__LAUNCHER_VERSION__ || '0.1.0';

const MAX_OUTPUT_LOG = 500 * 1024;

interface LocalSession {
  sessionId: string;
  ptyProcess: pty.IPty;
  outputBuffer: string;
  totalBytes: number;
  outputSeq: number;
  status: 'running' | 'completed' | 'failed' | 'killed';
}

const sessions = new Map<string, LocalSession>();

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let shuttingDown = false;

function buildClaudeArgs(
  prompt: string,
  permissionProfile: string,
  allowedTools?: string | null,
  claudeSessionId?: string,
  resumeSessionId?: string,
): { command: string; args: string[] } {
  // When resuming, use --resume only — no --session-id (it conflicts)
  if (resumeSessionId) {
    const args = ['--resume', resumeSessionId];
    if (prompt) args.push(prompt);
    return { command: 'claude', args };
  }

  switch (permissionProfile) {
    case 'interactive': {
      const args: string[] = [];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (allowedTools) args.push('--allowedTools', allowedTools);
      if (prompt) args.push(prompt);
      return { command: 'claude', args };
    }
    case 'auto': {
      const args = ['-p', prompt];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (allowedTools) args.push('--allowedTools', allowedTools);
      return { command: 'claude', args };
    }
    case 'yolo': {
      const args = ['-p', prompt, '--dangerously-skip-permissions'];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      return { command: 'claude', args };
    }
    case 'plain': {
      return { command: process.env.SHELL || '/bin/bash', args: [] };
    }
    default: {
      const args: string[] = [];
      if (claudeSessionId) args.push('--session-id', claudeSessionId);
      if (prompt) args.push(prompt);
      return { command: 'claude', args };
    }
  }
}

function sendToServer(data: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendSequenced(session: LocalSession, content: SessionOutputData): void {
  session.outputSeq++;
  const msg: SequencedOutput = {
    type: 'sequenced_output',
    sessionId: session.sessionId,
    seq: session.outputSeq,
    content,
    timestamp: new Date().toISOString(),
  };

  const outMsg: LauncherSessionOutput = {
    type: 'launcher_session_output',
    sessionId: session.sessionId,
    output: msg,
  };
  sendToServer(outMsg);
}

function spawnSession(params: {
  sessionId: string;
  prompt: string;
  cwd: string;
  permissionProfile: string;
  allowedTools?: string | null;
  claudeSessionId?: string;
  resumeSessionId?: string;
  tmuxTarget?: string;
  cols: number;
  rows: number;
}): void {
  const { sessionId, prompt, permissionProfile, allowedTools, claudeSessionId, resumeSessionId, tmuxTarget, cols, rows } = params;
  // Resolve ~ to actual home directory, and fall back to home if cwd doesn't exist
  let cwd = params.cwd;
  if (cwd === '~' || cwd.startsWith('~/')) {
    cwd = cwd === '~' ? os.homedir() : cwd.replace(/^~/, os.homedir());
  }
  if (!existsSync(cwd)) cwd = os.homedir();

  if (sessions.has(sessionId)) {
    console.log(`[launcher] Session ${sessionId} already running`);
    return;
  }

  // Attach to an existing tmux session on the default server
  if (tmuxTarget) {
    console.log(`[launcher] Attaching session ${sessionId} to tmux target ${tmuxTarget}`);
    const result = attachDefaultTmuxSession({ sessionId, tmuxTarget, cols, rows });
    const ptyProcess = result.ptyProcess;
    const tmuxSessionName = result.tmuxSessionName;

    const session: LocalSession = {
      sessionId,
      ptyProcess,
      outputBuffer: '',
      totalBytes: 0,
      outputSeq: 0,
      status: 'running',
    };
    sessions.set(sessionId, session);

    const started: LauncherSessionStarted = {
      type: 'launcher_session_started',
      sessionId,
      pid: ptyProcess.pid,
      tmuxSessionName,
    };
    sendToServer(started);

    ptyProcess.onData((data: string) => {
      session.outputBuffer += data;
      session.totalBytes += Buffer.byteLength(data);
      if (session.outputBuffer.length > MAX_OUTPUT_LOG) {
        session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_LOG);
      }
      sendSequenced(session, { kind: 'output', data });
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.status = exitCode === 0 ? 'completed' : 'failed';
      sendSequenced(session, { kind: 'exit', exitCode, status: session.status });

      const ended: LauncherSessionEnded = {
        type: 'launcher_session_ended',
        sessionId,
        exitCode,
        status: session.status,
        outputLog: session.outputBuffer.slice(-MAX_OUTPUT_LOG),
      };
      sendToServer(ended);
      sessions.delete(sessionId);
    });

    return;
  }

  const { command, args } = buildClaudeArgs(prompt, permissionProfile, allowedTools, claudeSessionId, resumeSessionId);
  const useTmux = isTmuxAvailable();

  console.log(`[launcher] Spawning session ${sessionId}: profile=${permissionProfile}, cwd=${cwd}, tmux=${useTmux}`);

  let ptyProcess: pty.IPty;
  let tmuxSessionName: string | undefined;

  if (useTmux) {
    const result = spawnInTmux({ sessionId, command, args, cwd, cols, rows });
    ptyProcess = result.ptyProcess;
    tmuxSessionName = result.tmuxSessionName;
  } else {
    ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
  }

  const session: LocalSession = {
    sessionId,
    ptyProcess,
    outputBuffer: '',
    totalBytes: 0,
    outputSeq: 0,
    status: 'running',
  };
  sessions.set(sessionId, session);

  const started: LauncherSessionStarted = {
    type: 'launcher_session_started',
    sessionId,
    pid: ptyProcess.pid,
    tmuxSessionName,
  };
  sendToServer(started);

  ptyProcess.onData((data: string) => {
    session.outputBuffer += data;
    session.totalBytes += Buffer.byteLength(data);
    if (session.outputBuffer.length > MAX_OUTPUT_LOG) {
      session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_LOG);
    }
    sendSequenced(session, { kind: 'output', data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.status = exitCode === 0 ? 'completed' : 'failed';
    sendSequenced(session, { kind: 'exit', exitCode, status: session.status });

    const ended: LauncherSessionEnded = {
      type: 'launcher_session_ended',
      sessionId,
      exitCode,
      status: session.status,
      outputLog: session.outputBuffer.slice(-MAX_OUTPUT_LOG),
    };
    sendToServer(ended);
    sessions.delete(sessionId);
  });

}

function handleImportSessionFiles(msg: ImportSessionFiles): void {
  const { sessionId, claudeSessionId, projectDir, jsonlFiles, artifactFiles } = msg;
  try {
    const jsonlDir = computeJsonlDir(projectDir);
    let jsonlWritten = 0;
    for (const f of jsonlFiles) {
      const target = path.join(jsonlDir, f.relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf-8');
      jsonlWritten++;
    }

    let artifactWritten = 0;
    // Resolve cwd — same as spawnSession logic
    let cwd = projectDir;
    if (cwd === '~' || cwd.startsWith('~/')) {
      cwd = cwd === '~' ? os.homedir() : cwd.replace(/^~/, os.homedir());
    }
    for (const f of artifactFiles) {
      const normalized = path.normalize(f.path);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) continue;
      const target = path.join(cwd, normalized);
      if (!target.startsWith(cwd)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf-8');
      artifactWritten++;
    }

    const result: ImportSessionFilesResult = {
      type: 'import_session_files_result',
      sessionId,
      ok: true,
      jsonlFilesWritten: jsonlWritten,
      artifactFilesWritten: artifactWritten,
    };
    sendToServer(result);
    console.log(`[launcher] Imported ${jsonlWritten} JSONL + ${artifactWritten} artifact files for session ${sessionId}`);
  } catch (err: any) {
    const result: ImportSessionFilesResult = {
      type: 'import_session_files_result',
      sessionId,
      ok: false,
      jsonlFilesWritten: 0,
      artifactFilesWritten: 0,
      error: err.message,
    };
    sendToServer(result);
  }
}

function handleExportSessionFiles(msg: ExportSessionFiles): void {
  const { sessionId, claudeSessionId, projectDir, artifactPaths } = msg;
  try {
    // Resolve ~ in projectDir
    let resolvedDir = projectDir;
    if (resolvedDir === '~' || resolvedDir.startsWith('~/')) {
      resolvedDir = resolvedDir === '~' ? os.homedir() : resolvedDir.replace(/^~/, os.homedir());
    }

    const pkg = exportSessionFilesLocal(resolvedDir, claudeSessionId);

    // If caller also requested specific artifact paths (beyond what JSONL parsing found),
    // add those too
    if (artifactPaths.length > 0) {
      const extraPaths = extractArtifactPaths('', resolvedDir); // plans dir only
      const existingPaths = new Set(pkg.artifactFiles.map(f => f.path));
      for (const relPath of artifactPaths) {
        if (existingPaths.has(relPath)) continue;
        const normalized = path.normalize(relPath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) continue;
        const full = path.join(resolvedDir, normalized);
        if (!full.startsWith(resolvedDir)) continue;
        if (existsSync(full)) {
          try {
            pkg.artifactFiles.push({ path: relPath, content: readFileSync(full, 'utf-8') });
          } catch { /* skip */ }
        }
      }
    }

    const result: ExportSessionFilesResult = {
      type: 'export_session_files_result',
      sessionId,
      ok: true,
      jsonlFiles: pkg.jsonlFiles,
      artifactFiles: pkg.artifactFiles,
    };
    sendToServer(result);
    console.log(`[launcher] Exported ${pkg.jsonlFiles.length} JSONL + ${pkg.artifactFiles.length} artifact files for session ${sessionId}`);
  } catch (err: any) {
    const result: ExportSessionFilesResult = {
      type: 'export_session_files_result',
      sessionId,
      ok: false,
      error: err.message,
    };
    sendToServer(result);
  }
}

function handleSyncCodebase(msg: SyncCodebase): void {
  const { sessionId, branch, projectDir, gitRemoteUrl } = msg;
  try {
    let cwd = projectDir;
    if (cwd === '~' || cwd.startsWith('~/')) {
      cwd = cwd === '~' ? os.homedir() : cwd.replace(/^~/, os.homedir());
    }
    if (!existsSync(cwd)) {
      throw new Error(`Project directory ${cwd} does not exist`);
    }

    execSync(`git fetch "${gitRemoteUrl}" "${branch}"`, { cwd, stdio: 'pipe', timeout: 120_000 });
    execSync(`git checkout FETCH_HEAD --force`, { cwd, stdio: 'pipe', timeout: 30_000 });

    const result: SyncCodebaseResult = { type: 'sync_codebase_result', sessionId, ok: true };
    sendToServer(result);
    console.log(`[launcher] Synced codebase for session ${sessionId}: branch=${branch}`);
  } catch (err: any) {
    const result: SyncCodebaseResult = {
      type: 'sync_codebase_result',
      sessionId,
      ok: false,
      error: err.message?.slice(0, 500),
    };
    sendToServer(result);
    console.error(`[launcher] Failed to sync codebase for session ${sessionId}:`, err.message);
  }
}

function handleSyncCodebaseToContainer(msg: SyncCodebaseToContainer): void {
  const { sessionId, harnessConfigId, branch, gitRemoteUrl, containerPath, composeDir, serviceName } = msg;
  const svc = serviceName || 'pw-server';
  const projectName = `pw-${harnessConfigId}`.toLowerCase();

  try {
    // Clone to a temp directory on the host
    const tmpDir = execSync('mktemp -d', { stdio: 'pipe' }).toString().trim();
    try {
      console.log(`[launcher] Cloning ${branch} from ${gitRemoteUrl} to ${tmpDir}/project...`);
      execSync(`git clone --branch "${branch}" --depth 1 "${gitRemoteUrl}" "${tmpDir}/project"`, {
        stdio: 'pipe',
        timeout: 120_000,
      });

      // Get the container ID for the service
      const containerId = execSync(
        `docker compose -p ${projectName} ps -q ${svc}`,
        { stdio: 'pipe', timeout: 10_000, cwd: composeDir || undefined },
      ).toString().trim();

      if (!containerId) {
        throw new Error(`No running container found for service ${svc} in project ${projectName}`);
      }

      // Ensure target directory exists in container
      execSync(`docker exec "${containerId}" mkdir -p "${containerPath}"`, {
        stdio: 'pipe',
        timeout: 10_000,
      });

      // Copy project files into container
      console.log(`[launcher] Copying project files to container ${containerId}:${containerPath}...`);
      execSync(`docker cp "${tmpDir}/project/." "${containerId}:${containerPath}"`, {
        stdio: 'pipe',
        timeout: 120_000,
      });

      const result: SyncCodebaseToContainerResult = {
        type: 'sync_codebase_to_container_result',
        sessionId,
        ok: true,
      };
      sendToServer(result);
      console.log(`[launcher] Synced codebase to container for session ${sessionId}`);
    } finally {
      try { execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' }); } catch {}
    }
  } catch (err: any) {
    const result: SyncCodebaseToContainerResult = {
      type: 'sync_codebase_to_container_result',
      sessionId,
      ok: false,
      error: err.message?.slice(0, 500),
    };
    sendToServer(result);
    console.error(`[launcher] Failed to sync codebase to container for session ${sessionId}:`, err.message);
  }
}

function handleServerMessage(msg: ServerToLauncherMessage): void {
  switch (msg.type) {
    case 'launcher_registered':
      if (msg.ok) {
        console.log(`[launcher] Registered with server`);
      } else {
        console.error(`[launcher] Registration failed: ${msg.error}`);
      }
      break;

    case 'launch_session':
      spawnSession({
        sessionId: msg.sessionId,
        prompt: msg.prompt,
        cwd: msg.cwd,
        permissionProfile: msg.permissionProfile,
        allowedTools: msg.allowedTools,
        claudeSessionId: msg.claudeSessionId,
        resumeSessionId: msg.resumeSessionId,
        tmuxTarget: msg.tmuxTarget,
        cols: msg.cols,
        rows: msg.rows,
      });
      break;

    case 'kill_session': {
      const session = sessions.get(msg.sessionId);
      if (session && session.status === 'running') {
        session.status = 'killed';
        session.ptyProcess.kill();
        killTmuxSession(msg.sessionId);
      }
      break;
    }

    case 'resize_session': {
      const session = sessions.get(msg.sessionId);
      if (session && session.status === 'running') {
        session.ptyProcess.resize(msg.cols, msg.rows);
      }
      break;
    }

    case 'input_to_session': {
      const session = sessions.get(msg.sessionId);
      if (!session || session.status !== 'running') break;
      const input = msg.input;
      if ('data' in input && input.data) {
        session.ptyProcess.write(input.data);
      } else if ('content' in input) {
        const content = input.content;
        if (content.kind === 'input' && content.data) {
          session.ptyProcess.write(content.data);
        } else if (content.kind === 'resize' && content.cols && content.rows) {
          session.ptyProcess.resize(content.cols, content.rows);
        } else if (content.kind === 'kill') {
          session.status = 'killed';
          session.ptyProcess.kill();
          killTmuxSession(msg.sessionId);
        }
      }
      break;
    }

    case 'start_harness': {
      console.log(`[launcher] Starting harness ${msg.harnessConfigId}`);
      try {
        // Build env vars for docker compose
        const env: Record<string, string> = { ...msg.envVars };
        if (msg.appImage) env.APP_IMAGE = msg.appImage;
        if (msg.appPort) env.APP_PORT = String(msg.appPort);
        if (msg.appInternalPort) env.APP_INTERNAL_PORT = String(msg.appInternalPort);
        if (msg.serverPort) env.SERVER_PORT = String(msg.serverPort);
        if (msg.browserMcpPort) env.BROWSER_MCP_PORT = String(msg.browserMcpPort);
        if (msg.targetAppUrl) env.TARGET_APP_URL = msg.targetAppUrl;
        env.HARNESS_CONFIG_ID = msg.harnessConfigId;

        const claudeHome = msg.claudeHomePath || path.join(os.homedir(), '.claude');
        if (existsSync(claudeHome)) {
          env.CLAUDE_HOME = claudeHome;
        }
        if (msg.anthropicApiKey) {
          env.ANTHROPIC_API_KEY = msg.anthropicApiKey;
        }

        const projectName = `pw-${msg.harnessConfigId}`.toLowerCase();
        env.COMPOSE_PROJECT_NAME = projectName;
        const envStr = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
        const cwd = msg.composeDir || undefined;

        // Tear down any leftover containers/ports from a previous run
        try {
          execSync(`docker compose -p ${projectName} down --remove-orphans`, { stdio: 'pipe', timeout: 60_000, cwd });
        } catch {}

        execSync(`${envStr} docker compose up -d --remove-orphans`, { stdio: 'pipe', timeout: 300_000, cwd });

        const status: HarnessStatusUpdate = {
          type: 'harness_status',
          harnessConfigId: msg.harnessConfigId,
          status: 'running',
        };
        sendToServer(status);
      } catch (err: any) {
        console.error(`[launcher] Failed to start harness:`, err.message);
        const status: HarnessStatusUpdate = {
          type: 'harness_status',
          harnessConfigId: msg.harnessConfigId,
          status: 'error',
          errorMessage: err.message?.slice(0, 500),
        };
        sendToServer(status);
      }
      break;
    }

    case 'stop_harness': {
      console.log(`[launcher] Stopping harness ${msg.harnessConfigId}`);
      try {
        const cwd = msg.composeDir || undefined;
        const projectName = `pw-${msg.harnessConfigId}`.toLowerCase();
        execSync(`docker compose -p ${projectName} down --remove-orphans`, { stdio: 'pipe', timeout: 60_000, cwd });
        const status: HarnessStatusUpdate = {
          type: 'harness_status',
          harnessConfigId: msg.harnessConfigId,
          status: 'stopped',
        };
        sendToServer(status);
      } catch (err: any) {
        console.error(`[launcher] Failed to stop harness:`, err.message);
        const status: HarnessStatusUpdate = {
          type: 'harness_status',
          harnessConfigId: msg.harnessConfigId,
          status: 'error',
          errorMessage: `Stop failed: ${err.message?.slice(0, 500)}`,
        };
        sendToServer(status);
      }
      break;
    }

    case 'import_session_files':
      handleImportSessionFiles(msg);
      break;

    case 'export_session_files':
      handleExportSessionFiles(msg);
      break;

    case 'sync_codebase':
      handleSyncCodebase(msg);
      break;

    case 'sync_codebase_to_container':
      handleSyncCodebaseToContainer(msg);
      break;

    case 'list_tmux_sessions': {
      const tmuxSessions = listDefaultTmuxSessions();
      const result: ListTmuxSessionsResult = {
        type: 'list_tmux_sessions_result',
        sessionId: msg.sessionId,
        sessions: tmuxSessions,
      };
      sendToServer(result);
      break;
    }

    case 'restart_launcher': {
      console.log('[launcher] Restart requested, exiting for systemd restart...');
      shutdown();
      break;
    }

    case 'check_claude_auth': {
      const claudeHome = msg.claudeHomePath || path.join(os.homedir(), '.claude');
      const result: CheckClaudeAuthResult = {
        type: 'check_claude_auth_result',
        sessionId: msg.sessionId,
        hasClaudeDir: false,
        hasCredentials: false,
      };
      try {
        result.hasClaudeDir = existsSync(claudeHome);
        if (result.hasClaudeDir) {
          const credFiles = ['.credentials.json', 'credentials.json', 'auth.json'];
          result.hasCredentials = credFiles.some(f => existsSync(path.join(claudeHome, f)));
        }
        try {
          result.claudeVersion = execSync('claude --version', { stdio: 'pipe', timeout: 10_000 }).toString().trim();
        } catch {}
      } catch (err: any) {
        result.error = err.message;
      }
      sendToServer(result);
      break;
    }

    case 'check_container_claude': {
      const projectName = `pw-${msg.harnessConfigId}`.toLowerCase();
      const svc = msg.serviceName || 'pw-server';
      const cwd = msg.composeDir || undefined;
      const result: CheckContainerClaudeResult = {
        type: 'check_container_claude_result',
        sessionId: msg.sessionId,
        hasClaudeCli: false,
        hasCredentials: false,
      };
      try {
        const versionOut = execSync(
          `docker compose -p ${projectName} exec -T ${svc} claude --version`,
          { stdio: 'pipe', timeout: 15_000, cwd },
        ).toString().trim();
        result.hasClaudeCli = true;
        result.claudeVersion = versionOut;
      } catch {}
      try {
        const credCheck = execSync(
          `docker compose -p ${projectName} exec -T ${svc} sh -c 'test -f /root/.claude/.credentials.json || test -f /root/.claude/credentials.json || test -f /root/.claude/auth.json'`,
          { stdio: 'pipe', timeout: 10_000, cwd },
        );
        result.hasCredentials = true;
      } catch {}
      sendToServer(result);
      break;
    }

    case 'health_check': {
      const result: LauncherHealthCheckResult = {
        type: 'health_check_result',
        sessionId: msg.sessionId,
        uptime: process.uptime(),
        nodeVersion: process.version,
        launcherVersion: LAUNCHER_VERSION,
        platform: os.platform(),
        arch: os.arch(),
        memory: { total: os.totalmem(), free: os.freemem() },
        activeSessions: sessions.size,
        capabilities: {
          maxSessions: MAX_SESSIONS,
          hasTmux: isTmuxAvailable(),
          hasClaudeCli: false,
          hasDocker: false,
        },
        claudeHomeExists: existsSync(path.join(os.homedir(), '.claude')),
      };
      try { execSync('claude --version', { stdio: 'pipe', timeout: 5_000 }); result.capabilities.hasClaudeCli = true; result.claudeCliVersion = execSync('claude --version', { stdio: 'pipe', timeout: 5_000 }).toString().trim(); } catch {}
      try { result.dockerVersion = execSync('docker --version', { stdio: 'pipe', timeout: 5_000 }).toString().trim(); result.capabilities.hasDocker = true; } catch {}
      try { result.tmuxVersion = execSync('tmux -V', { stdio: 'pipe', timeout: 5_000 }).toString().trim(); } catch {}
      sendToServer(result);
      break;
    }

    case 'send_keys': {
      const targetId = msg.tmuxTarget || msg.targetSessionId;
      const tmuxName = targetId.startsWith('pw-') ? targetId : `pw-${targetId}`;
      try {
        const args = ['-L', 'prompt-widget', 'send-keys', '-t', tmuxName, msg.keys];
        if (msg.enter !== false) args.push('Enter');
        execFileSync('tmux', args, { stdio: 'pipe', timeout: 10_000 });
        const result: SendKeysResult = { type: 'send_keys_result', sessionId: msg.sessionId, ok: true };
        sendToServer(result);
      } catch (err: any) {
        const result: SendKeysResult = { type: 'send_keys_result', sessionId: msg.sessionId, ok: false, error: err.message?.slice(0, 500) };
        sendToServer(result);
      }
      break;
    }

    case 'capture_pane': {
      const targetId = msg.tmuxTarget || msg.targetSessionId;
      const tmuxName = targetId.startsWith('pw-') ? targetId : `pw-${targetId}`;
      try {
        const args = ['-L', 'prompt-widget', 'capture-pane', '-t', tmuxName, '-p'];
        if (msg.lastN) args.push('-S', String(-msg.lastN));
        const content = execFileSync('tmux', args, { stdio: 'pipe', timeout: 10_000 }).toString();
        const result: CapturePaneResult = { type: 'capture_pane_result', sessionId: msg.sessionId, ok: true, content };
        sendToServer(result);
      } catch (err: any) {
        const result: CapturePaneResult = { type: 'capture_pane_result', sessionId: msg.sessionId, ok: false, error: err.message?.slice(0, 500) };
        sendToServer(result);
      }
      break;
    }

    case 'launch_harness_session': {
      const { sessionId, harnessConfigId, prompt, composeDir, serviceName, permissionProfile, containerCwd, claudeSessionId, anthropicApiKey, cols, rows } = msg;
      const svc = serviceName || 'pw-server';

      console.log(`[launcher] Launching harness session ${sessionId} in ${composeDir || harnessConfigId}/${svc}${containerCwd ? ` (cwd=${containerCwd})` : ''}`);

      if (sessions.has(sessionId)) {
        console.log(`[launcher] Session ${sessionId} already running`);
        break;
      }

      const { command: innerCmd, args: innerArgs } = buildClaudeArgs(prompt, permissionProfile, undefined, claudeSessionId);
      // Claude always needs a TTY (even -p mode uses TUI internally).
      // Only disable TTY (-T) when there's no tmux/pty to provide one.
      const useTmux = isTmuxAvailable();
      const execFlags = useTmux ? [] : ['-T'];
      if (containerCwd) execFlags.push('-w', containerCwd);
      if (anthropicApiKey) execFlags.push('-e', `ANTHROPIC_API_KEY=${anthropicApiKey}`);
      const projectName = `pw-${harnessConfigId}`.toLowerCase();
      const dockerArgs = composeDir
        ? ['compose', '--project-directory', composeDir, '-p', projectName, 'exec', ...execFlags, svc, innerCmd, ...innerArgs]
        : ['compose', '-p', projectName, 'exec', ...execFlags, svc, innerCmd, ...innerArgs];

      let ptyProcess: pty.IPty;
      let tmuxSessionName: string | undefined;

      if (useTmux) {
        const result = spawnInTmux({ sessionId, command: 'docker', args: dockerArgs, cwd: composeDir || os.homedir(), cols, rows });
        ptyProcess = result.ptyProcess;
        tmuxSessionName = result.tmuxSessionName;
      } else {
        ptyProcess = pty.spawn('docker', dockerArgs, {
          name: 'xterm-256color',
          cols,
          rows,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
      }

      const session: LocalSession = {
        sessionId,
        ptyProcess,
        outputBuffer: '',
        totalBytes: 0,
        outputSeq: 0,
        status: 'running',
      };
      sessions.set(sessionId, session);

      const started: LauncherSessionStarted = {
        type: 'launcher_session_started',
        sessionId,
        pid: ptyProcess.pid,
        tmuxSessionName,
      };
      sendToServer(started);

      ptyProcess.onData((data: string) => {
        session.outputBuffer += data;
        session.totalBytes += Buffer.byteLength(data);
        if (session.outputBuffer.length > MAX_OUTPUT_LOG) {
          session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_LOG);
        }
        sendSequenced(session, { kind: 'output', data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        session.status = exitCode === 0 ? 'completed' : 'failed';
        sendSequenced(session, { kind: 'exit', exitCode, status: session.status });

        const ended: LauncherSessionEnded = {
          type: 'launcher_session_ended',
          sessionId,
          exitCode,
          status: session.status,
          outputLog: session.outputBuffer.slice(-MAX_OUTPUT_LOG),
        };
        sendToServer(ended);
        sessions.delete(sessionId);
      });

      break;
    }
  }
}

function connect(): void {
  if (shuttingDown) return;

  console.log(`[launcher] Connecting to ${SERVER_WS_URL}...`);
  ws = new WebSocket(SERVER_WS_URL);

  ws.on('open', () => {
    reconnectDelay = 1000;
    console.log(`[launcher] Connected, registering as ${LAUNCHER_ID}`);

    let hasDocker = false;
    try { execSync('docker --version', { stdio: 'pipe' }); hasDocker = true; } catch {}

    const caps: LauncherCapabilities = {
      maxSessions: MAX_SESSIONS,
      hasTmux: isTmuxAvailable(),
      hasClaudeCli: true,
      hasDocker,
    };

    const reg: LauncherRegister = {
      type: 'launcher_register',
      id: LAUNCHER_ID,
      name: LAUNCHER_NAME,
      hostname: os.hostname(),
      authToken: LAUNCHER_AUTH_TOKEN,
      capabilities: caps,
      machineId: MACHINE_ID,
      version: LAUNCHER_VERSION,
    };
    sendToServer(reg);

    heartbeatTimer = setInterval(() => {
      const hb: LauncherHeartbeat = {
        type: 'launcher_heartbeat',
        activeSessions: Array.from(sessions.keys()),
        timestamp: new Date().toISOString(),
      };
      sendToServer(hb);
    }, 30_000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ServerToLauncherMessage;
      handleServerMessage(msg);
    } catch {}
  });

  ws.on('close', () => {
    ws = null;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (shuttingDown) return;

    console.log(`[launcher] Disconnected, reconnecting in ${reconnectDelay}ms...`);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      connect();
    }, reconnectDelay);
  });

  ws.on('error', (err) => {
    console.error(`[launcher] WebSocket error:`, err.message);
  });
}

function shutdown(): void {
  shuttingDown = true;
  console.log('[launcher] Shutting down...');

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);

  for (const [sessionId, session] of sessions) {
    if (isTmuxAvailable() && tmuxSessionExists(sessionId)) {
      console.log(`[launcher] Detaching tmux session ${sessionId} (preserved)`);
      detachTmuxClients(sessionId);
      try { session.ptyProcess.kill(); } catch {}
    } else {
      console.log(`[launcher] Killing session ${sessionId}`);
      try { session.ptyProcess.kill(); } catch {}
    }
  }

  if (ws) {
    try { ws.close(); } catch {}
  }

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

connect();
console.log(`[launcher] Daemon started: id=${LAUNCHER_ID}, name=${LAUNCHER_NAME}`);
