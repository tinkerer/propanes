import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { createReadStream, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { db, schema } from '../db/index.js';
import {
  startWiggumRun,
  pauseWiggumRun,
  resumeWiggumRun,
  stopWiggumRun,
  getActiveRunIds,
} from '../wiggum-controller.js';
import { getLauncher, listLaunchers, sendAndWait } from '../launcher-registry.js';
import { startFAFOGeneration, cleanupWorktrees } from '../fafo-controller.js';
import { dispatchAgentSession } from '../dispatch.js';
import type { ExecInHarness, ExecInHarnessResult } from '@propanes/shared';

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const DEFAULT_PROMPT_DIR = '/data/altiumingest/viewer';

const app = new Hono();

function serializeRun(row: typeof schema.wiggumRuns.$inferSelect) {
  return {
    ...row,
    iterations: JSON.parse(row.iterations || '[]'),
  };
}

function findLauncherForHarness(config: typeof schema.harnessConfigs.$inferSelect) {
  let launcher = config.launcherId ? getLauncher(config.launcherId) : undefined;
  if (!launcher && config.machineId) {
    const all = listLaunchers();
    launcher = all.find(l => l.machineId === config.machineId && l.ws?.readyState === 1);
  }
  return launcher;
}

async function execInHarness(
  launcherId: string,
  harnessConfigId: string,
  command: string,
  composeDir?: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; output?: string; exitCode?: number }> {
  const msg: ExecInHarness = {
    type: 'exec_in_harness',
    sessionId: ulid(),
    harnessConfigId,
    command,
    composeDir,
    timeout: timeoutMs,
  };
  const result = await sendAndWait(launcherId, msg, 'exec_in_harness_result', timeoutMs + 10_000) as ExecInHarnessResult;
  return { ok: result.ok, output: result.output, exitCode: result.exitCode };
}

function deriveLabel(filename: string): string {
  if (filename === 'PROMPT.md') return 'General';
  return filename.replace(/^PROMPT_/, '').replace(/\.md$/, '');
}

// Discover prompt files from harness container
app.get('/prompts', async (c) => {
  const harnessConfigId = c.req.query('harnessConfigId');
  if (!harnessConfigId) return c.json({ error: 'harnessConfigId is required' }, 400);

  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, harnessConfigId)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);
  if (config.status !== 'running') return c.json({ error: 'Harness is not running' }, 400);

  const launcher = findLauncherForHarness(config);
  if (!launcher || launcher.ws.readyState !== 1) return c.json({ error: 'No connected launcher' }, 400);

  const promptDir = c.req.query('promptDir') || DEFAULT_PROMPT_DIR;
  const cmd = `for f in ${promptDir}/PROMPT*.md; do [ -f "$f" ] && echo "---FILE:$(basename "$f")---" && head -2 "$f"; done`;

  try {
    const result = await execInHarness(launcher.id, harnessConfigId, cmd, config.composeDir || undefined, 30_000);
    if (!result.ok || !result.output) return c.json([]);

    const files: { filename: string; label: string; excerpt: string }[] = [];
    const parts = result.output.split(/---FILE:([^-]+)---/).filter(Boolean);

    for (let i = 0; i < parts.length - 1; i += 2) {
      const filename = parts[i].trim();
      const excerpt = parts[i + 1].trim();
      if (filename.match(/^PROMPT[A-Z0-9_]*\.md$/)) {
        files.push({ filename, label: deriveLabel(filename), excerpt });
      }
    }

    // Cross-reference with existing runs
    const allRuns = db.select().from(schema.wiggumRuns)
      .where(eq(schema.wiggumRuns.harnessConfigId, harnessConfigId)).all();
    const activeIds = getActiveRunIds();

    const enriched = files.map(f => {
      const matchingRuns = allRuns.filter(r => r.promptFile === f.filename);
      const activeRun = matchingRuns.find(r => activeIds.includes(r.id) || r.status === 'running' || r.status === 'paused');
      const lastRun = matchingRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return {
        ...f,
        activeRunId: activeRun?.id || null,
        activeRunStatus: activeRun?.status || null,
        lastRunId: lastRun?.id || null,
        lastRunStatus: lastRun?.status || null,
        totalRuns: matchingRuns.length,
      };
    });

    return c.json(enriched);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Read a single prompt file from harness container
app.get('/prompt-file', async (c) => {
  const harnessConfigId = c.req.query('harnessConfigId');
  const filename = c.req.query('filename');
  if (!harnessConfigId || !filename) return c.json({ error: 'harnessConfigId and filename required' }, 400);
  if (!/^PROMPT[A-Z0-9_]*\.md$/.test(filename)) return c.json({ error: 'Invalid filename pattern' }, 400);

  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, harnessConfigId)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);
  if (config.status !== 'running') return c.json({ error: 'Harness is not running' }, 400);

  const launcher = findLauncherForHarness(config);
  if (!launcher || launcher.ws.readyState !== 1) return c.json({ error: 'No connected launcher' }, 400);

  const promptDir = c.req.query('promptDir') || DEFAULT_PROMPT_DIR;
  try {
    const result = await execInHarness(launcher.id, harnessConfigId, `cat ${promptDir}/${filename}`, config.composeDir || undefined, 30_000);
    if (!result.ok) return c.json({ error: 'Failed to read file', output: result.output }, 500);
    return c.json({ filename, content: result.output || '' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Update a prompt file in harness container
app.put('/prompt-file', async (c) => {
  const body = await c.req.json();
  const { harnessConfigId, filename, content } = body;
  if (!harnessConfigId || !filename || content == null) return c.json({ error: 'harnessConfigId, filename, content required' }, 400);
  if (!/^PROMPT[A-Z0-9_]*\.md$/.test(filename)) return c.json({ error: 'Invalid filename pattern' }, 400);

  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, harnessConfigId)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);
  if (config.status !== 'running') return c.json({ error: 'Harness is not running' }, 400);

  const launcher = findLauncherForHarness(config);
  if (!launcher || launcher.ws.readyState !== 1) return c.json({ error: 'No connected launcher' }, 400);

  const promptDir = body.promptDir || DEFAULT_PROMPT_DIR;
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  const cmd = `echo '${b64}' | base64 -d > ${promptDir}/${filename}`;

  try {
    const result = await execInHarness(launcher.id, harnessConfigId, cmd, config.composeDir || undefined, 30_000);
    if (!result.ok) return c.json({ error: 'Failed to write file', output: result.output }, 500);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Batch create and start runs from prompt files
app.post('/batch', async (c) => {
  const body = await c.req.json();
  const { harnessConfigId, promptFiles } = body;
  if (!harnessConfigId || !Array.isArray(promptFiles) || promptFiles.length === 0) {
    return c.json({ error: 'harnessConfigId and promptFiles[] required' }, 400);
  }

  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, harnessConfigId)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);
  if (config.status !== 'running') return c.json({ error: 'Harness is not running' }, 400);

  const launcher = findLauncherForHarness(config);
  if (!launcher || launcher.ws.readyState !== 1) return c.json({ error: 'No connected launcher' }, 400);

  const promptDir = body.promptDir || DEFAULT_PROMPT_DIR;
  const maxIterations = body.maxIterations ?? 10;
  const deployCommand = body.deployCommand || null;
  const widgetSessionId = body.widgetSessionId || null;
  const screenshotDelayMs = body.screenshotDelayMs ?? 3000;
  const now = new Date().toISOString();

  const created: any[] = [];
  for (const filename of promptFiles) {
    if (!/^PROMPT[A-Z0-9_]*\.md$/.test(filename)) continue;

    try {
      const fileResult = await execInHarness(launcher.id, harnessConfigId, `cat ${promptDir}/${filename}`, config.composeDir || undefined, 30_000);
      if (!fileResult.ok || !fileResult.output) continue;

      const label = deriveLabel(filename);
      const logFile = `/tmp/wiggum-${label.toLowerCase()}-log.txt`;
      const id = ulid();

      db.insert(schema.wiggumRuns).values({
        id,
        harnessConfigId,
        prompt: fileResult.output,
        promptFile: filename,
        logFile,
        agentLabel: label,
        deployCommand,
        maxIterations,
        widgetSessionId,
        screenshotDelayMs,
        status: 'pending',
        currentIteration: 0,
        iterations: '[]',
        createdAt: now,
        updatedAt: now,
      }).run();

      startWiggumRun(id).catch((err) => {
        console.error(`[wiggum] Failed to start batch run ${id}:`, err.message);
      });

      const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
      created.push(serializeRun(row!));
    } catch (err: any) {
      console.error(`[wiggum] Batch: failed to process ${filename}:`, err.message);
    }
  }

  return c.json(created, 201);
});

// Batch action on multiple runs
app.post('/batch-action', async (c) => {
  const body = await c.req.json();
  const { action, runIds } = body;
  if (!action || !Array.isArray(runIds) || runIds.length === 0) {
    return c.json({ error: 'action and runIds[] required' }, 400);
  }
  if (!['stop', 'pause', 'resume'].includes(action)) {
    return c.json({ error: 'action must be stop, pause, or resume' }, 400);
  }

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of runIds) {
    try {
      if (action === 'stop') stopWiggumRun(id);
      else if (action === 'pause') pauseWiggumRun(id);
      else if (action === 'resume') resumeWiggumRun(id);
      results.push({ id, ok: true });
    } catch (err: any) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  return c.json({ results });
});

// Tail log file from harness container
app.get('/log', async (c) => {
  const harnessConfigId = c.req.query('harnessConfigId');
  const logFile = c.req.query('logFile');
  if (!harnessConfigId || !logFile) return c.json({ error: 'harnessConfigId and logFile required' }, 400);

  const config = db.select().from(schema.harnessConfigs).where(eq(schema.harnessConfigs.id, harnessConfigId)).get();
  if (!config) return c.json({ error: 'Harness config not found' }, 404);

  const launcher = findLauncherForHarness(config);
  if (!launcher || launcher.ws.readyState !== 1) return c.json({ error: 'No connected launcher' }, 400);

  try {
    const result = await execInHarness(launcher.id, harnessConfigId, `tail -100 ${logFile} 2>/dev/null || echo "(no log file yet)"`, config.composeDir || undefined, 15_000);
    return c.json({ logFile, content: result.output || '' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// List wiggum runs (optionally filtered by parentSessionId)
app.get('/', (c) => {
  const parentSessionId = c.req.query('parentSessionId');
  const query = parentSessionId
    ? db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.parentSessionId, parentSessionId))
    : db.select().from(schema.wiggumRuns);
  const rows = query.all();
  const activeIds = getActiveRunIds();
  return c.json(rows.map((r) => ({
    ...serializeRun(r),
    isActive: activeIds.includes(r.id),
  })));
});

// Create and start a new run
app.post('/', async (c) => {
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = ulid();

  if (!body.harnessConfigId) {
    return c.json({ error: 'harnessConfigId is required' }, 400);
  }
  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }

  db.insert(schema.wiggumRuns).values({
    id,
    agentEndpointId: body.agentEndpointId || null,
    harnessConfigId: body.harnessConfigId,
    feedbackId: body.feedbackId || null,
    appId: body.appId || null,
    prompt: body.prompt,
    deployCommand: body.deployCommand || null,
    maxIterations: body.maxIterations ?? 10,
    widgetSessionId: body.widgetSessionId || null,
    screenshotDelayMs: body.screenshotDelayMs ?? 3000,
    parentSessionId: body.parentSessionId || null,
    promptFile: body.promptFile || null,
    logFile: body.logFile || null,
    agentLabel: body.agentLabel || null,
    status: 'pending',
    currentIteration: 0,
    iterations: '[]',
    createdAt: now,
    updatedAt: now,
  }).run();

  // Start the run in the background
  startWiggumRun(id).catch((err) => {
    console.error(`[wiggum] Failed to start run ${id}:`, err.message);
  });

  const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(row!), 201);
});

// =====================
// FAFO Swarm endpoints (must be before /:id routes)
// =====================

app.get('/swarms', (c) => {
  const appIdFilter = c.req.query('appId');
  const query = appIdFilter
    ? db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.appId, appIdFilter))
    : db.select().from(schema.wiggumSwarms);
  return c.json(query.all());
});

app.post('/swarms', async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const now = new Date().toISOString();
  const id = ulid();
  const mode = body.mode || 'single';
  const isolation = body.isolation ? JSON.stringify(body.isolation) : null;
  db.insert(schema.wiggumSwarms).values({
    id, name: body.name, mode, promptFile: body.promptFile || null,
    fitnessCommand: body.fitnessCommand || null, targetArtifact: body.targetArtifact || null,
    artifactType: body.artifactType || 'screenshot',
    fitnessMetric: body.fitnessMetric || 'pixel-diff',
    knowledgeFile: body.knowledgeFile || null,
    knowledgeContent: body.knowledgeContent || '', fanOut: body.fanOut ?? 6, generationCount: 0,
    harnessConfigId: body.harnessConfigId || null, appId: body.appId || null,
    isolation, status: 'pending', createdAt: now, updatedAt: now,
  }).run();

  // Create paths for multi-path mode
  if (mode === 'multi-path' && Array.isArray(body.paths)) {
    const basePort = body.isolation?.basePort ?? 5200;
    for (let i = 0; i < body.paths.length; i++) {
      const p = body.paths[i];
      db.insert(schema.wiggumSwarmPaths).values({
        id: ulid(),
        swarmId: id,
        name: p.name || `path-${i}`,
        prompt: p.prompt || '',
        files: p.files ? JSON.stringify(p.files) : null,
        focusLines: p.focusLines || null,
        cropRegion: p.cropRegion ? JSON.stringify(p.cropRegion) : null,
        fitnessMetric: p.fitnessMetric || null,
        fitnessCommand: p.fitnessCommand || null,
        worktreePort: basePort + i,
        worktreeBranch: `fafo-${id.slice(-8)}-${p.name || i}`,
        status: 'pending',
        order: i,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  }

  const row = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, id)).get();
  const paths = db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.swarmId, id)).all();
  return c.json({ ...row!, paths }, 201);
});

app.get('/swarms/:id', (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const runs = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.swarmId, swarm.id)).all();
  const activeIds = getActiveRunIds();
  const allPaths = db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.swarmId, swarm.id)).all();
  const pathById = new Map(allPaths.map(p => [p.id, p]));

  // Build a map of generation -> runRoot directories
  const swarmShortId = swarm.id.slice(-8);
  const genDirCache = new Map<number, string | null>();
  function findGenDir(gen: number): string | null {
    if (genDirCache.has(gen)) return genDirCache.get(gen)!;
    try {
      const prefix = `swarm-${swarmShortId}-gen${gen}-`;
      const entries = execSync(`ls -d /tmp/fafo-runs/${prefix}* 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      const dir = entries.length > 0 ? entries[entries.length - 1] : null;
      genDirCache.set(gen, dir);
      return dir;
    } catch { genDirCache.set(gen, null); return null; }
  }

  const generations: Record<number, any[]> = {};
  for (const r of runs) {
    const gen = r.generation ?? 0;
    if (!generations[gen]) generations[gen] = [];

    // Get DB screenshots
    let screenshots = db.select().from(schema.wiggumScreenshots).where(eq(schema.wiggumScreenshots.runId, r.id)).all() as any[];

    // If no DB screenshots, scan filesystem for PNGs in the child directory
    if (screenshots.length === 0) {
      const genDir = findGenDir(gen);
      const path = r.pathId ? pathById.get(r.pathId) : null;
      if (genDir && path) {
        const childDir = `${genDir}/child-${path.name}`;
        try {
          if (existsSync(childDir)) {
            const pngs = readdirSync(childDir).filter(f => f.endsWith('.png')).sort((a, b) => {
              try { return statSync(`${childDir}/${b}`).mtimeMs - statSync(`${childDir}/${a}`).mtimeMs; } catch { return 0; }
            });
            screenshots = pngs.map((f, i) => ({
              id: `fs-${r.id.slice(-8)}-${i}`,
              runId: r.id,
              iteration: i,
              filename: f,
              mimeType: 'image/png',
              size: statSync(`${childDir}/${f}`).size,
              // Serve via a new route
              url: `/api/v1/admin/wiggum/swarms/${swarm.id}/gen/${gen}/path/${path.name}/file/${f}`,
            }));
          }
        } catch { /* ignore */ }
      }
    }

    generations[gen].push({ ...serializeRun(r), isActive: activeIds.includes(r.id), screenshots });
  }
  for (const gen in generations) {
    generations[gen].sort((a: any, b: any) => {
      if (a.fitnessScore == null && b.fitnessScore == null) return 0;
      if (a.fitnessScore == null) return 1;
      if (b.fitnessScore == null) return -1;
      return a.fitnessScore - b.fitnessScore;
    });
  }
  return c.json({ ...swarm, generations, paths: allPaths });
});

app.patch('/swarms/:id', async (c) => {
  const id = c.req.param('id');
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, id)).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json();
  const now = new Date().toISOString();
  const updates: Record<string, any> = { updatedAt: now };
  if ('isolation' in body) updates.isolation = typeof body.isolation === 'string' ? body.isolation : JSON.stringify(body.isolation);
  for (const f of ['name', 'mode', 'promptFile', 'fitnessCommand', 'fitnessMetric', 'targetArtifact', 'artifactType', 'knowledgeFile', 'knowledgeContent', 'fanOut', 'harnessConfigId', 'appId', 'status']) {
    if (f in body) updates[f] = body[f];
  }
  db.update(schema.wiggumSwarms).set(updates).where(eq(schema.wiggumSwarms.id, id)).run();
  return c.json(db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, id)).get()!);
});

// List paths for a swarm
app.get('/swarms/:id/paths', (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const paths = db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.swarmId, swarm.id)).all();
  return c.json(paths);
});

// Add a path to a swarm
app.post('/swarms/:id/paths', async (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json();
  if (!body.name || !body.prompt) return c.json({ error: 'name and prompt are required' }, 400);
  const now = new Date().toISOString();
  const id = ulid();
  const existingPaths = db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.swarmId, swarm.id)).all();
  const isolation = swarm.isolation ? JSON.parse(swarm.isolation) : {};
  const basePort = isolation.basePort ?? 5200;
  db.insert(schema.wiggumSwarmPaths).values({
    id, swarmId: swarm.id, name: body.name, prompt: body.prompt,
    files: body.files ? JSON.stringify(body.files) : null,
    focusLines: body.focusLines || null,
    cropRegion: body.cropRegion ? JSON.stringify(body.cropRegion) : null,
    fitnessMetric: body.fitnessMetric || null,
    fitnessCommand: body.fitnessCommand || null,
    worktreePort: body.worktreePort ?? (basePort + existingPaths.length),
    worktreeBranch: body.worktreeBranch || `fafo-${swarm.id.slice(-8)}-${body.name}`,
    status: 'pending', order: existingPaths.length,
    createdAt: now, updatedAt: now,
  }).run();
  return c.json(db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.id, id)).get()!, 201);
});

// Update a path
app.patch('/swarms/:id/paths/:pathId', async (c) => {
  const pathRow = db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.id, c.req.param('pathId'))).get();
  if (!pathRow || pathRow.swarmId !== c.req.param('id')) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json();
  const now = new Date().toISOString();
  const updates: Record<string, any> = { updatedAt: now };
  for (const f of ['name', 'prompt', 'focusLines', 'fitnessMetric', 'fitnessCommand', 'worktreePort', 'worktreeBranch', 'worktreePath', 'status', 'order']) {
    if (f in body) updates[f] = body[f];
  }
  if ('files' in body) updates.files = body.files ? JSON.stringify(body.files) : null;
  if ('cropRegion' in body) updates.cropRegion = body.cropRegion ? JSON.stringify(body.cropRegion) : null;
  db.update(schema.wiggumSwarmPaths).set(updates).where(eq(schema.wiggumSwarmPaths.id, pathRow.id)).run();
  return c.json(db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.id, pathRow.id)).get()!);
});

// Delete a path
app.delete('/swarms/:id/paths/:pathId', (c) => {
  const pathRow = db.select().from(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.id, c.req.param('pathId'))).get();
  if (!pathRow || pathRow.swarmId !== c.req.param('id')) return c.json({ error: 'Not found' }, 404);
  db.delete(schema.wiggumSwarmPaths).where(eq(schema.wiggumSwarmPaths.id, pathRow.id)).run();
  return c.json({ ok: true });
});

app.get('/swarms/:id/knowledge', (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  return c.json({ knowledge: swarm.knowledgeContent || '' });
});

app.post('/swarms/:id/next-generation', async (c) => {
  const swarmId = c.req.param('id');
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, swarmId)).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await startFAFOGeneration(swarmId, {
      keepCount: body.keepCount,
      lessonsLearned: body.lessonsLearned,
      knobs: body.knobs,
      fanOut: body.fanOut,
    });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete('/swarms/:id', (c) => {
  const id = c.req.param('id');
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, id)).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  cleanupWorktrees(id);
  const runs = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.swarmId, id)).all();
  for (const r of runs) { if (r.status === 'running' || r.status === 'paused') stopWiggumRun(r.id); }
  for (const r of runs) db.delete(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, r.id)).run();
  db.delete(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, id)).run();
  return c.json({ ok: true });
});

// ─── FAFO filesystem screenshot serving ──────────────

app.get('/swarms/:id/gen/:gen/path/:pathName/file/:filename', (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const gen = c.req.param('gen');
  const pathName = c.req.param('pathName');
  const filename = c.req.param('filename');
  // Prevent path traversal
  if (filename.includes('..') || pathName.includes('..') || pathName.includes('/')) {
    return c.json({ error: 'Invalid path' }, 400);
  }
  const swarmShortId = swarm.id.slice(-8);
  try {
    const entries = execSync(`ls -d /tmp/fafo-runs/swarm-${swarmShortId}-gen${gen}-* 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    if (entries.length === 0) return c.json({ error: 'Generation dir not found' }, 404);
    const genDir = entries[entries.length - 1];
    const filePath = `${genDir}/child-${pathName}/${filename}`;
    if (!existsSync(filePath)) return c.json({ error: 'File not found' }, 404);
    const buf = readFileSync(filePath);
    return new Response(buf, {
      headers: {
        'Content-Type': filename.endsWith('.png') ? 'image/png' : 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
});

// Also serve the target image for a swarm
app.get('/swarms/:id/target', (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  if (swarm.targetArtifact && existsSync(swarm.targetArtifact)) {
    const buf = readFileSync(swarm.targetArtifact);
    return new Response(buf, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(buf.length),
      },
    });
  }
  return c.json({ error: 'No target' }, 404);
});

// ─── FAFO Feedback endpoints ─────────────────────────

app.post('/swarms/:id/feedback', async (c) => {
  const swarmId = c.req.param('id');
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, swarmId)).get();
  if (!swarm) return c.json({ error: 'Swarm not found' }, 404);

  const body = await c.req.json();
  const id = ulid();
  const now = new Date().toISOString();

  db.insert(schema.fafoFeedback).values({
    id,
    swarmId,
    runId: body.runId || null,
    generation: body.generation ?? swarm.generationCount,
    rating: body.rating ?? 0,
    annotation: body.annotation || null,
    regionX: body.regionX ?? null,
    regionY: body.regionY ?? null,
    regionW: body.regionW ?? null,
    regionH: body.regionH ?? null,
    screenshotRef: body.screenshotRef || null,
    createdAt: now,
  }).run();

  return c.json({ id, createdAt: now }, 201);
});

app.get('/swarms/:id/feedback', (c) => {
  const swarmId = c.req.param('id');
  const gen = c.req.query('generation');
  let rows = db.select().from(schema.fafoFeedback)
    .where(eq(schema.fafoFeedback.swarmId, swarmId)).all();
  if (gen != null) {
    const genNum = parseInt(gen);
    rows = rows.filter(r => r.generation === genNum);
  }
  return c.json(rows);
});

app.delete('/swarms/:id/feedback/:feedbackId', (c) => {
  const feedbackId = c.req.param('feedbackId');
  db.delete(schema.fafoFeedback).where(eq(schema.fafoFeedback.id, feedbackId)).run();
  return c.json({ ok: true });
});

// ─── Individual Run endpoints ─────────────────────────

// Get run details
app.get('/:id', (c) => {
  const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const screenshots = db.select().from(schema.wiggumScreenshots)
    .where(eq(schema.wiggumScreenshots.runId, row.id)).all();

  return c.json({
    ...serializeRun(row),
    isActive: getActiveRunIds().includes(row.id),
    screenshots,
  });
});

// Pause a running run
app.post('/:id/pause', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);
  if (run.status !== 'running') return c.json({ error: `Cannot pause run in status: ${run.status}` }, 400);

  pauseWiggumRun(id);
  const updated = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(updated!));
});

// Resume a paused run
app.post('/:id/resume', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);
  if (run.status !== 'paused') return c.json({ error: `Cannot resume run in status: ${run.status}` }, 400);

  resumeWiggumRun(id);
  const updated = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(updated!));
});

// Stop a run
app.post('/:id/stop', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);
  if (run.status !== 'running' && run.status !== 'paused') {
    return c.json({ error: `Cannot stop run in status: ${run.status}` }, 400);
  }

  stopWiggumRun(id);
  const updated = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  return c.json(serializeRun(updated!));
});

// Delete a run
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const run = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).get();
  if (!run) return c.json({ error: 'Not found' }, 404);

  // Stop if active
  if (run.status === 'running' || run.status === 'paused') {
    stopWiggumRun(id);
  }

  // Cascade will delete screenshots rows; files remain on disk
  db.delete(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, id)).run();
  return c.json({ ok: true });
});

// Serve a screenshot image
app.get('/:id/screenshots/:sid', async (c) => {
  const screenshot = db.select().from(schema.wiggumScreenshots)
    .where(eq(schema.wiggumScreenshots.id, c.req.param('sid'))).get();
  if (!screenshot || screenshot.runId !== c.req.param('id')) {
    return c.json({ error: 'Not found' }, 404);
  }

  const filePath = `${UPLOAD_DIR}/${screenshot.filename}`;
  try {
    const info = await stat(filePath);
    c.header('Content-Type', screenshot.mimeType);
    c.header('Content-Length', String(info.size));
    c.header('Cache-Control', 'public, max-age=86400');
    const stream = createReadStream(filePath);
    return new Response(stream as any, { headers: { 'Content-Type': screenshot.mimeType } });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// ─── Auto-decomposition: analyze target image to suggest paths ────

app.post('/swarms/:id/decompose', async (c) => {
  const swarmId = c.req.param('id');
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, swarmId)).get();
  if (!swarm) return c.json({ error: 'Swarm not found' }, 404);
  if (!swarm.targetArtifact || !existsSync(swarm.targetArtifact)) {
    return c.json({ error: 'No target artifact set or file missing' }, 400);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, any>;

  // Get existing paths for context
  const existingPaths = db.select().from(schema.wiggumSwarmPaths)
    .where(eq(schema.wiggumSwarmPaths.swarmId, swarmId))
    .all()
    .sort((a, b) => a.order - b.order);

  // Get knowledge for context
  const knowledge = swarm.knowledgeContent || '';

  // Build approach log context if available
  let approachLog = '';
  try {
    const swarmShortId = swarm.id.slice(-8);
    const entries = execSync(`ls -d /tmp/fafo-runs/swarm-${swarmShortId}-gen*-* 2>/dev/null | sort | tail -1`, {
      encoding: 'utf-8', timeout: 5_000,
    }).trim();
    if (entries) {
      try { approachLog = readFileSync(`${entries}/wiki/approach-log.md`, 'utf-8'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  const decompositionPrompt = `You are a FAFO decomposition agent. Analyze the target image and the current state of this swarm to produce an optimal set of worker paths for the next generation.

## Target Image
Read the target image at: ${swarm.targetArtifact}

## Current Swarm State
- Name: ${swarm.name}
- Mode: ${swarm.mode}
- Generations completed: ${swarm.generationCount}
- Current fitness metric: ${swarm.fitnessMetric}
${existingPaths.length > 0 ? `
## Existing Paths
${existingPaths.map(p => `- ${p.name}: ${p.prompt?.slice(0, 200) || '(no prompt)'}${p.cropRegion ? ` [crop: ${p.cropRegion}]` : ''}`).join('\n')}
` : ''}
${knowledge ? `## Accumulated Knowledge (${knowledge.length} chars)\n${knowledge.slice(0, 2000)}` : ''}
${approachLog ? `## Approach Log\n${approachLog.slice(0, 2000)}` : ''}
${body.context ? `## Additional Context\n${body.context}` : ''}

## Your Task

Analyze the target image and decompose it into independent sub-problems. For each sub-problem, output a JSON object describing a worker path.

Consider:
1. What distinct visual elements/regions exist in the target?
2. Which elements are independent enough to be worked on in parallel?
3. What specific code changes each worker should focus on?
4. What crop regions to use for per-element fitness scoring?

Write your analysis to stdout as a JSON array:
\`\`\`json
[
  {
    "name": "short-kebab-name",
    "prompt": "Detailed instructions for this worker...",
    "files": ["src/components/SomeFile.tsx"],
    "focusLines": "100-200",
    "cropRegion": [x, y, w, h],
    "rationale": "Why this decomposition makes sense"
  },
  ...
]
\`\`\`

Rules:
- 3-8 paths maximum
- Names must be short, unique, kebab-case
- Each path should target a specific visual element or region
- Include crop regions when possible for focused fitness scoring
- Prompts should be specific and actionable
- If existing paths are working well, keep them (possibly with refined prompts)
- If existing paths are NOT converging, try DIFFERENT decompositions
`;

  // Dispatch as an agent session
  try {
    const agents = db.select().from(schema.agentEndpoints).all();
    const appAgent = swarm.appId ? agents.find(a => a.isDefault && a.appId === swarm.appId) : null;
    const globalAgent = agents.find(a => a.isDefault && !a.appId);
    const agent = appAgent || globalAgent || agents[0];
    if (!agent) return c.json({ error: 'No agent endpoints configured' }, 500);

    const now = new Date().toISOString();
    const fbId = ulid();
    db.insert(schema.feedbackItems).values({
      id: fbId, type: 'manual', status: 'new',
      title: `FAFO Decomposition: ${swarm.name}`,
      description: `Auto-decomposition of target image into worker paths`,
      appId: swarm.appId || null,
      createdAt: now, updatedAt: now,
    }).run();

    const { sessionId } = await dispatchAgentSession({
      feedbackId: fbId,
      agentEndpointId: agent.id,
      prompt: decompositionPrompt,
      cwd: process.cwd(),
      permissionProfile: 'yolo',
    });

    return c.json({
      sessionId,
      message: `Decomposition agent dispatched. Monitor session ${sessionId} for results. The agent will output a JSON array of suggested paths.`,
    });
  } catch (err: any) {
    return c.json({ error: `Failed to dispatch decomposition agent: ${err.message}` }, 500);
  }
});

// ─── Serve git diff for a worker run ──────────────────

app.get('/swarms/:id/gen/:gen/path/:pathName/diff', (c) => {
  const swarm = db.select().from(schema.wiggumSwarms).where(eq(schema.wiggumSwarms.id, c.req.param('id'))).get();
  if (!swarm) return c.json({ error: 'Not found' }, 404);
  const gen = c.req.param('gen');
  const pathName = c.req.param('pathName');
  if (pathName.includes('..') || pathName.includes('/')) return c.json({ error: 'Invalid path' }, 400);

  const swarmShortId = swarm.id.slice(-8);
  try {
    const entries = execSync(`ls -d /tmp/fafo-runs/swarm-${swarmShortId}-gen${gen}-* 2>/dev/null || true`, { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    if (entries.length === 0) return c.json({ error: 'Generation dir not found' }, 404);
    const genDir = entries[entries.length - 1];
    const diffPath = `${genDir}/child-${pathName}/changes.diff`;
    if (!existsSync(diffPath)) {
      // Try generating from worktree
      const workDir = `${genDir}/child-${pathName}/work`;
      if (existsSync(workDir)) {
        try {
          const diff = execSync(`cd "${workDir}" && git diff HEAD 2>/dev/null || true`, { encoding: 'utf-8', timeout: 10_000 });
          return c.text(diff);
        } catch { /* ignore */ }
      }
      return c.json({ error: 'No diff available' }, 404);
    }
    return c.text(readFileSync(diffPath, 'utf-8'));
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
});

export default app;
