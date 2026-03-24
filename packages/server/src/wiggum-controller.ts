import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { mkdir, writeFile } from 'node:fs/promises';
import { db, schema } from './db/index.js';
import { dispatchHarnessSession } from './dispatch.js';
import { sendCommand } from './sessions.js';
import { sendAndWait, getLauncher } from './launcher-registry.js';
import type { ExecInHarness, ExecInHarnessResult, WiggumIteration } from '@prompt-widget/shared';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const SESSION_POLL_INTERVAL = 3_000;
const SESSION_TIMEOUT = 30 * 60 * 1_000;

const activeRuns = new Map<string, { abort: AbortController }>();

export function getActiveRunIds(): string[] {
  return [...activeRuns.keys()];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

function loadRun(runId: string) {
  return db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, runId)).get();
}

function updateRun(runId: string, data: Partial<typeof schema.wiggumRuns.$inferInsert>) {
  db.update(schema.wiggumRuns)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.wiggumRuns.id, runId))
    .run();
}

async function pollSessionCompletion(sessionId: string, signal: AbortSignal): Promise<{ exitCode: number | null }> {
  const deadline = Date.now() + SESSION_TIMEOUT;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('aborted');
    const session = db.select().from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId)).get();
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status === 'completed' || session.status === 'failed') {
      return { exitCode: session.exitCode };
    }
    await sleep(SESSION_POLL_INTERVAL, signal);
  }
  throw new Error(`Session ${sessionId} timed out after ${SESSION_TIMEOUT / 1000}s`);
}

async function takeScreenshot(widgetSessionId: string, runId: string, iteration: number): Promise<string | null> {
  try {
    const result = await sendCommand(widgetSessionId, 'screenshot', { includeWidget: false }) as { dataUrl?: string; mimeType?: string };
    if (!result?.dataUrl) return null;

    const base64 = result.dataUrl.split(',')[1];
    if (!base64) return null;
    const buffer = Buffer.from(base64, 'base64');
    const mimeType = result.mimeType || 'image/png';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';

    const screenshotId = ulid();
    const filename = `wiggum-${screenshotId}.${ext}`;

    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(`${UPLOAD_DIR}/${filename}`, buffer);

    db.insert(schema.wiggumScreenshots).values({
      id: screenshotId,
      runId,
      iteration,
      filename,
      mimeType,
      size: buffer.byteLength,
      createdAt: new Date().toISOString(),
    }).run();

    return screenshotId;
  } catch (err: any) {
    console.warn(`[wiggum] Screenshot failed for run ${runId} iter ${iteration}: ${err.message}`);
    return null;
  }
}

async function execDeploy(
  launcherId: string,
  sessionId: string,
  harnessConfigId: string,
  command: string,
  composeDir?: string,
): Promise<{ ok: boolean; output?: string }> {
  const msg: ExecInHarness = {
    type: 'exec_in_harness',
    sessionId,
    harnessConfigId,
    command,
    composeDir,
    timeout: 120_000,
  };
  const result = await sendAndWait(launcherId, msg, 'exec_in_harness_result', 130_000) as ExecInHarnessResult;
  return { ok: result.ok, output: result.output };
}

export async function startWiggumRun(runId: string): Promise<void> {
  const run = loadRun(runId);
  if (!run) throw new Error(`Wiggum run ${runId} not found`);
  if (!run.harnessConfigId) throw new Error('No harnessConfigId configured');

  const harnessConfig = db.select().from(schema.harnessConfigs)
    .where(eq(schema.harnessConfigs.id, run.harnessConfigId)).get();
  if (!harnessConfig) throw new Error(`Harness config ${run.harnessConfigId} not found`);
  if (harnessConfig.status !== 'running') throw new Error(`Harness "${harnessConfig.name}" is not running`);

  const launcherId = harnessConfig.launcherId;
  if (!launcherId) throw new Error('Harness has no launcher');
  const launcher = getLauncher(launcherId);
  if (!launcher || launcher.ws.readyState !== 1) throw new Error('Launcher not connected');

  const abort = new AbortController();
  activeRuns.set(runId, { abort });

  updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });

  try {
    const iterations: WiggumIteration[] = JSON.parse(run.iterations || '[]');

    for (let i = run.currentIteration + 1; i <= run.maxIterations; i++) {
      if (abort.signal.aborted) {
        const freshRun = loadRun(runId);
        if (freshRun?.status === 'stopped') break;
        updateRun(runId, { status: 'paused' });
        break;
      }

      updateRun(runId, { currentIteration: i });

      const prompt = i === 1
        ? run.prompt
        : `${run.prompt}\n\nThis is iteration ${i} of ${run.maxIterations}. Check the current state of the application and continue improving it.`;

      console.log(`[wiggum] Run ${runId} starting iteration ${i}/${run.maxIterations}`);

      const iterStartedAt = new Date().toISOString();
      const { sessionId } = await dispatchHarnessSession({
        harnessConfigId: run.harnessConfigId!,
        launcherId,
        prompt,
        composeDir: harnessConfig.composeDir || undefined,
        permissionProfile: 'auto',
        feedbackId: run.feedbackId,
        agentEndpointId: run.agentEndpointId,
      });

      const { exitCode } = await pollSessionCompletion(sessionId, abort.signal);

      let screenshotId: string | null = null;

      if (run.deployCommand) {
        console.log(`[wiggum] Run ${runId} iter ${i}: deploying`);
        const deployResult = await execDeploy(
          launcherId, ulid(), run.harnessConfigId!, run.deployCommand,
          harnessConfig.composeDir || undefined,
        );
        if (!deployResult.ok) {
          console.warn(`[wiggum] Deploy failed for run ${runId} iter ${i}: ${deployResult.output}`);
        }
      }

      if (run.widgetSessionId) {
        await sleep(run.screenshotDelayMs, abort.signal);
        screenshotId = await takeScreenshot(run.widgetSessionId, runId, i);
      }

      iterations.push({
        iteration: i,
        sessionId,
        screenshotId,
        startedAt: iterStartedAt,
        completedAt: new Date().toISOString(),
        exitCode,
      });

      updateRun(runId, { iterations: JSON.stringify(iterations) });
      console.log(`[wiggum] Run ${runId} completed iteration ${i}/${run.maxIterations} (exit=${exitCode})`);
    }

    const finalRun = loadRun(runId);
    if (finalRun?.status === 'running') {
      updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() });
    }
  } catch (err: any) {
    if (err.message === 'aborted') {
      const freshRun = loadRun(runId);
      if (freshRun?.status === 'stopped' || freshRun?.status === 'paused') return;
      updateRun(runId, { status: 'paused' });
    } else {
      console.error(`[wiggum] Run ${runId} failed:`, err.message);
      updateRun(runId, { status: 'failed', errorMessage: err.message, completedAt: new Date().toISOString() });
    }
  } finally {
    activeRuns.delete(runId);
  }
}

export function pauseWiggumRun(runId: string): boolean {
  const entry = activeRuns.get(runId);
  if (!entry) return false;
  updateRun(runId, { status: 'paused' });
  entry.abort.abort();
  return true;
}

export function resumeWiggumRun(runId: string): void {
  const run = loadRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== 'paused') throw new Error(`Run ${runId} is not paused (status: ${run.status})`);
  startWiggumRun(runId).catch((err) => {
    console.error(`[wiggum] Resume failed for run ${runId}:`, err.message);
  });
}

export function stopWiggumRun(runId: string): boolean {
  updateRun(runId, { status: 'stopped', completedAt: new Date().toISOString() });
  const entry = activeRuns.get(runId);
  if (entry) {
    entry.abort.abort();
    return true;
  }
  return false;
}
