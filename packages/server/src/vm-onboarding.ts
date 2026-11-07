// vm-onboarding.ts — run scripts/onboard-user.sh for a member from the admin UI,
// so linking someone's Slack account can also give them a workspace.
//
// The script needs root (it creates a Linux account and a system service), so
// this is opt-in per deployment: PROPANES_VM_ONBOARD_SCRIPT holds the script's
// absolute path and the server's account needs passwordless sudo. Unset, the
// feature is off and onboarding stays a manual step.
import { spawn as nodeSpawn } from 'node:child_process';

export type VmOnboardJob = {
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  /** Tail of the script's output, for the admin who started it. */
  log: string;
};

const LOG_TAIL_CHARS = 8000;
const TIMEOUT_MS = 15 * 60_000;
const jobs = new Map<string, VmOnboardJob>();

export function vmOnboardScript(): string | null {
  return process.env.PROPANES_VM_ONBOARD_SCRIPT?.trim() || null;
}

export function getVmOnboardJob(userId: string): VmOnboardJob | null {
  return jobs.get(userId) ?? null;
}

export function isVmOnboarding(userId: string): boolean {
  return jobs.get(userId)?.status === 'running';
}

export function startVmOnboarding(
  input: { userId: string; username: string; appIds: string[]; adminToken: string },
  spawn: typeof nodeSpawn = nodeSpawn,
): VmOnboardJob {
  const script = vmOnboardScript();
  if (!script) throw new Error('VM onboarding is not enabled on this server');
  if (isVmOnboarding(input.userId)) throw new Error('Onboarding is already running for this user');
  const job: VmOnboardJob = { status: 'running', startedAt: new Date().toISOString(), log: '' };
  jobs.set(input.userId, job);
  const finish = (ok: boolean, line?: string) => {
    if (job.status !== 'running') return;
    if (line) job.log = (job.log + line + '\n').slice(-LOG_TAIL_CHARS);
    job.status = ok ? 'succeeded' : 'failed';
    job.finishedAt = new Date().toISOString();
    console.log(`[vm-onboarding] ${input.username}: ${job.status}`);
  };
  const child = spawn('sudo', [
    '-n',
    '--preserve-env=PROPANES_TOKEN,PROPANES_API_URL,PROPANES_PUBLIC_URL,LAUNCHER_AUTH_TOKEN',
    script,
    '--user', input.username,
    ...input.appIds.flatMap((id) => ['--app', id]),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROPANES_TOKEN: input.adminToken,
      PROPANES_API_URL: process.env.PROPANES_API_URL || `http://localhost:${process.env.PORT || 3001}`,
    },
  });
  const collect = (chunk: Buffer) => { job.log = (job.log + chunk.toString()).slice(-LOG_TAIL_CHARS); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const timer = setTimeout(() => {
    finish(false, `timed out after ${TIMEOUT_MS / 60_000} minutes`);
    child.kill();
  }, TIMEOUT_MS);
  timer.unref?.();
  child.on('error', (err) => { clearTimeout(timer); finish(false, `could not start: ${err.message}`); });
  child.on('close', (code) => { clearTimeout(timer); finish(code === 0, code === 0 ? undefined : `exited with code ${code}`); });
  return job;
}
