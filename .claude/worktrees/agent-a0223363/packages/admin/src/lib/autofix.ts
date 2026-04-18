import { signal } from '@preact/signals';
import { api } from './api.js';
import { allSessions, openSession, closeTab, loadAllSessions } from './sessions.js';

const AUTOFIX_STORAGE_KEY = 'pw-autofix-enabled';

export const autoFixEnabled = signal<boolean>((() => {
  try {
    const raw = localStorage.getItem(AUTOFIX_STORAGE_KEY);
    return raw === null ? false : JSON.parse(raw);
  } catch {
    return false;
  }
})());

export function setAutoFixEnabled(val: boolean) {
  autoFixEnabled.value = val;
  localStorage.setItem(AUTOFIX_STORAGE_KEY, JSON.stringify(val));
}

export type AutoFixPhase = 'idle' | 'pending' | 'launching' | 'active';

export interface AutoFixState {
  phase: AutoFixPhase;
  sessionId?: string;
  machineName?: string;
  exitCode?: number;
  countdown?: number;
}

export const autoFixState = signal<AutoFixState>({ phase: 'idle' });

const sessionOpenTimestamps = new Map<string, number>();
const sessionTerminalTexts = new Map<string, string>();
const offeredSessions = new Set<string>();
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let launchTimer: ReturnType<typeof setTimeout> | null = null;

// Exponential backoff state
let consecutiveFailures = 0;
let lastAutoFixTime = 0;
const BACKOFF_DELAYS = [1000, 5000, 10000]; // 1s, 5s, 10s then give up
const MAX_RETRIES = 3;

const ERROR_PATTERNS = [
  /can't find session/i,
  /session not found/i,
  /connection refused/i,
  /permission denied/i,
  /command not found: claude/i,
  /ECONNREFUSED/,
  /no such tmux session/i,
  /No such file or directory/i,
  /spawn .* ENOENT/i,
];

const MAX_SESSION_AGE_MS = 30_000;

export function trackSessionOpen(sessionId: string) {
  sessionOpenTimestamps.set(sessionId, Date.now());
}

function shouldAutoFix(sessionId: string, exitCode: number, terminalText: string): boolean {
  if (!autoFixEnabled.value) return false;
  if (exitCode === 0) return false;
  if (offeredSessions.has(sessionId)) return false;
  if (consecutiveFailures >= MAX_RETRIES) return false;

  // Enforce minimum interval between autofix attempts
  const backoffDelay = BACKOFF_DELAYS[Math.min(consecutiveFailures, BACKOFF_DELAYS.length - 1)] || 10000;
  if (Date.now() - lastAutoFixTime < backoffDelay) return false;

  const openedAt = sessionOpenTimestamps.get(sessionId);
  if (openedAt && Date.now() - openedAt > MAX_SESSION_AGE_MS) return false;

  return ERROR_PATTERNS.some((re) => re.test(terminalText));
}

export function handleSessionExit(sessionId: string, exitCode: number, terminalText: string) {
  if (!shouldAutoFix(sessionId, exitCode, terminalText)) return;

  offeredSessions.add(sessionId);
  sessionTerminalTexts.set(sessionId, terminalText);

  const sess = allSessions.value.find((s: any) => s.id === sessionId);
  const machineName = sess?.machineName || sess?.launcherHostname || 'unknown';

  // Show toast but require user click — no auto-launch
  autoFixState.value = {
    phase: 'pending',
    sessionId,
    machineName,
    exitCode,
  };
}

export async function launchAutoFix() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }

  const state = autoFixState.value;
  if (state.phase === 'idle') return;

  autoFixState.value = { ...state, phase: 'launching' };
  lastAutoFixTime = Date.now();

  const sess = allSessions.value.find((s: any) => s.id === state.sessionId);
  const machineName = sess?.machineName || sess?.launcherHostname || 'unknown';
  const machineId = sess?.machineId;

  const termText = sessionTerminalTexts.get(state.sessionId!) || 'No terminal text captured';

  const prompt = `A session on machine "${machineName}" failed immediately with exit code ${state.exitCode}. Please diagnose and fix the issue.

The session terminal output was:
\`\`\`
${termText}
\`\`\`

Check the machine configuration, launcher status, and tmux setup. Common issues: missing claude binary, stale tmux sessions, permission problems, SSH connectivity.`;

  try {
    const { sessionId: fixSessionId } = await api.setupAssist({
      request: prompt,
      entityType: 'machine',
      ...(machineId ? { entityId: machineId } : {}),
    });
    await loadAllSessions();

    if (state.sessionId) closeTab(state.sessionId);
    openSession(fixSessionId);

    consecutiveFailures = 0;
    autoFixState.value = { phase: 'active', sessionId: fixSessionId, machineName };
    setTimeout(() => {
      if (autoFixState.value.phase === 'active') {
        autoFixState.value = { phase: 'idle' };
      }
    }, 2000);
  } catch (err) {
    console.error('[autofix] Failed to launch:', err);
    consecutiveFailures++;
    autoFixState.value = { phase: 'idle' };
  }
}

export function dismissAutoFix() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }
  autoFixState.value = { phase: 'idle' };
}

export function resetAutoFixBackoff() {
  consecutiveFailures = 0;
  lastAutoFixTime = 0;
}
