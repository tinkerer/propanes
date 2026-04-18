/**
 * FAFO Controller — execution engine for multi-path swarm generations.
 *
 * Handles: worktree lifecycle, vite-per-port, per-path Claude dispatch,
 * LLM-based visual evaluation, meta-optimizer, survivor selection.
 */

import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { db, schema } from './db/index.js';
import { startWiggumRun } from './wiggum-controller.js';
import { dispatchAgentSession } from './dispatch.js';

interface FAFOPath {
  id: string;
  name: string;
  prompt: string;
  files: string | null;
  focusLines: string | null;
  cropRegion: string | null;
  fitnessMetric: string | null;
  fitnessCommand: string | null;
  worktreePort: number | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  status: string;
  order: number;
}

// Active generation trackers
const activeGenerations = new Map<string, { abort: AbortController }>();

/**
 * Seed wiki directory from LESSONS.md or copy from previous generation.
 */
function seedWiki(runRoot: string, prevRunRoot: string | null): void {
  const wikiDir = `${runRoot}/wiki`;
  mkdirSync(wikiDir, { recursive: true });

  // If a previous generation wiki exists, copy it forward
  if (prevRunRoot) {
    const prevWiki = `${prevRunRoot}/wiki`;
    if (existsSync(prevWiki)) {
      try {
        cpSync(prevWiki, wikiDir, { recursive: true });
        console.log(`[fafo] Copied wiki from ${prevWiki} to ${wikiDir}`);
        return;
      } catch (err: any) {
        console.warn(`[fafo] Failed to copy previous wiki:`, err.message);
      }
    }
  }

  // Initial generation: seed from LESSONS.md
  const lessonsPath = '/tmp/fafo-runs/LESSONS.md';
  let lessons = '';
  if (existsSync(lessonsPath)) {
    try { lessons = readFileSync(lessonsPath, 'utf-8'); } catch { /* ignore */ }
  }

  writeFileSync(`${wikiDir}/what-works.md`, `# What Works\nTechniques that improved the diff score.\n\n${
    lessons.includes('What\'s Done') ? lessons.split('## Exact Ground Truth')[0] : '(no prior data)'
  }\n`);

  writeFileSync(`${wikiDir}/what-fails.md`, `# What Fails\nTechniques that made things worse.\n\n(no prior data)\n`);

  writeFileSync(`${wikiDir}/open-questions.md`, `# Open Questions\nThings we haven't tried yet.\n\n(no prior data)\n`);

  writeFileSync(`${wikiDir}/approach-log.md`, `# Approach Log\nAppend-only log of all approaches tried across generations. DO NOT repeat these.\n\n`);

  writeFileSync(`${wikiDir}/task-assignments.md`, `# Task Assignments\nDirected sub-problems for workers. Updated by the aggregator between generations.\n\n(initial generation — no directed tasks yet, explore freely)\n`);

  writeFileSync(`${wikiDir}/task-status.md`, `# Task Status\nTracks which sub-problems are solved vs open.\n\n`);

  writeFileSync(`${wikiDir}/coordinates.md`, `# Coordinates\nExact pixel/SVG coordinates of all elements.\n\n${
    lessons.includes('## Coordinates') ? lessons.slice(lessons.indexOf('## Coordinates')) .split('\n## Workflow')[0] : '(no prior data)'
  }\n`);

  writeFileSync(`${wikiDir}/style-params.md`, `# Style Parameters\nCurrent style values and what the target expects.\n\n${
    lessons.includes('## Exact Ground Truth') ? lessons.slice(lessons.indexOf('## Exact Ground Truth')).split('\n## API Field')[0] : '(no prior data)'
  }\n`);

  console.log(`[fafo] Seeded wiki at ${wikiDir}`);
}

/**
 * Extract specific lines from a file.
 */
function extractLines(filePath: string, lineSpec: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    // Parse spec like "100-200" or "100-200,300-350"
    const result: string[] = [];
    for (const range of lineSpec.split(',')) {
      const parts = range.trim().split('-').map(Number);
      const start = Math.max(1, parts[0]) - 1;
      const end = parts.length > 1 ? Math.min(lines.length, parts[1]) : start + 1;
      for (let i = start; i < end; i++) {
        result.push(`${i + 1}: ${lines[i]}`);
      }
    }
    return result.join('\n');
  } catch {
    return '(could not extract lines)';
  }
}

/**
 * LLM-based visual evaluation: have Claude compare two images and return
 * a structured score + description of differences.
 * Replaces pixel-diff metrics as primary fitness signal.
 */
async function llmEvaluate(
  targetPath: string,
  candidatePath: string,
  context?: string,
): Promise<{ score: number; differences: string[]; priority_fix: string; raw: string }> {
  const prompt = [
    `Read these two images with the Read tool and compare them visually.`,
    `Target (what we want): ${targetPath}`,
    `Candidate (what we have): ${candidatePath}`,
    context ? `Context: ${context}` : '',
    ``,
    `Compare every visual aspect: shapes, positions, sizes, colors, stroke widths, elements present/missing, alignment, spacing.`,
    ``,
    `Output ONLY valid JSON (no markdown, no backticks, no explanation):`,
    `{"score": <0-100 where 100=perfect match>, "differences": ["diff1", "diff2", ...], "priority_fix": "single most impactful thing to fix next"}`,
  ].filter(Boolean).join('\n');

  try {
    const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const result = execSync(
      `claude -p "${escaped}" --max-turns 3 --allowedTools "Read"`,
      { encoding: 'utf-8', timeout: 180_000 },
    ).trim();

    // Extract JSON from response (may have surrounding text)
    const jsonMatch = result.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { ...parsed, raw: result };
    }
    return { score: 0, differences: ['Could not parse LLM response'], priority_fix: 'unknown', raw: result };
  } catch (err: any) {
    console.error('[fafo] llmEvaluate failed:', err.message);
    return { score: 0, differences: ['LLM evaluation failed'], priority_fix: 'unknown', raw: err.message };
  }
}

export function getActiveGenerationIds(): string[] {
  return [...activeGenerations.keys()];
}

/**
 * Start a new FAFO generation for a swarm.
 * For multi-path: creates worktrees, starts vite, dispatches Claude per path.
 * For single-mode: creates N wiggum runs with varied knobs.
 */
export async function startFAFOGeneration(
  swarmId: string,
  opts: {
    keepCount?: number;
    lessonsLearned?: string;
    knobs?: Record<string, any>;
    fanOut?: number;
  } = {},
): Promise<{
  swarm: any;
  generation: number;
  survivors: string[];
  dropped: string[];
  newRuns: any[];
  worktrees: { path: string; port: number; branch: string }[];
}> {
  const swarm = db.select().from(schema.wiggumSwarms)
    .where(eq(schema.wiggumSwarms.id, swarmId)).get();
  if (!swarm) throw new Error(`Swarm ${swarmId} not found`);

  const paths = db.select().from(schema.wiggumSwarmPaths)
    .where(eq(schema.wiggumSwarmPaths.swarmId, swarmId))
    .all()
    .sort((a, b) => a.order - b.order);

  const currentGen = swarm.generationCount;
  const now = new Date().toISOString();

  // ── Score & select survivors from current generation ──
  const currentRuns = db.select().from(schema.wiggumRuns)
    .where(eq(schema.wiggumRuns.swarmId, swarmId))
    .all()
    .filter(r => r.generation === currentGen);

  const scoredRuns = currentRuns
    .filter(r => r.fitnessScore != null)
    .sort((a, b) => (a.fitnessScore ?? Infinity) - (b.fitnessScore ?? Infinity));

  const keepCount = opts.keepCount ?? Math.max(1, Math.ceil(scoredRuns.length / 2));
  const survivors = scoredRuns.slice(0, keepCount);
  const dropped = scoredRuns.slice(keepCount);

  for (const r of survivors) {
    db.update(schema.wiggumRuns)
      .set({ survived: true, updatedAt: now })
      .where(eq(schema.wiggumRuns.id, r.id)).run();
  }
  for (const r of dropped) {
    db.update(schema.wiggumRuns)
      .set({ survived: false, updatedAt: now })
      .where(eq(schema.wiggumRuns.id, r.id)).run();
  }

  // ── Append knowledge ──
  if (opts.lessonsLearned) {
    const updated = (swarm.knowledgeContent || '') + `\n\n## Generation ${currentGen}\n\n` + opts.lessonsLearned;
    db.update(schema.wiggumSwarms)
      .set({ knowledgeContent: updated, updatedAt: now })
      .where(eq(schema.wiggumSwarms.id, swarmId)).run();
  }

  // ── Bump generation ──
  const nextGen = currentGen + 1;
  db.update(schema.wiggumSwarms)
    .set({ generationCount: nextGen, status: 'running', updatedAt: now })
    .where(eq(schema.wiggumSwarms.id, swarmId)).run();

  // ── Resolve project dir ──
  const isolation = swarm.isolation ? JSON.parse(swarm.isolation) : {};
  const repoDir = isolation.repoDir || process.cwd();
  const baseBranch = isolation.baseBranch || 'HEAD';
  const basePort = isolation.basePort ?? 5200;

  // ── Create run dir ──
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runRoot = `/tmp/fafo-runs/swarm-${swarmId.slice(-8)}-gen${nextGen}-${ts}`;
  mkdirSync(runRoot, { recursive: true });

  // Copy target artifact if specified
  if (swarm.targetArtifact && existsSync(swarm.targetArtifact)) {
    try {
      execSync(`cp "${swarm.targetArtifact}" "${runRoot}/target.png"`, { stdio: 'pipe' });
    } catch { /* ignore */ }
  }

  // Write lightweight pixel-diff tool (secondary signal only — LLM visual eval is primary)
  writeFileSync(`${runRoot}/diff.py`, `#!/usr/bin/env python3
"""Quick pixel diff — secondary signal only. LLM visual comparison is primary."""
import sys, json
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size: b = b.resize(a.size)
d = ImageChops.difference(a, b)
px = list(d.getdata())
mean = sum(sum(p) for p in px) / (len(px) * 3)
print(json.dumps({"mean": round(mean, 3), "bbox": list(d.getbbox() or [])}))
`, { mode: 0o755 });

  // Find previous generation's run root for wiki copying + best-worker propagation
  let prevRunRoot: string | null = null;
  let bestWorkerCommit: string | null = null;
  if (currentGen > 0) {
    try {
      const parentDir = '/tmp/fafo-runs';
      const prefix = `swarm-${swarmId.slice(-8)}-gen${currentGen}-`;
      const entries = execSync(`ls -d ${parentDir}/${prefix}* 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      if (entries.length > 0) {
        prevRunRoot = entries[entries.length - 1];

        // Read meta-verdict to find best worker's commit for code propagation
        const verdictPath = `${prevRunRoot}/meta-verdict.json`;
        if (existsSync(verdictPath)) {
          try {
            const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
            if (verdict.best_worker) {
              const bestWorkDir = `${prevRunRoot}/child-${verdict.best_worker}/work`;
              if (existsSync(bestWorkDir)) {
                bestWorkerCommit = execSync(`cd "${bestWorkDir}" && git rev-parse HEAD 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5_000 }).trim();
                if (bestWorkerCommit) {
                  console.log(`[fafo] Best worker "${verdict.best_worker}" commit: ${bestWorkerCommit.slice(0, 8)} (score: ${verdict.score})`);
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // Use best worker's commit as base for next generation if available
  const effectiveBaseBranch = bestWorkerCommit || baseBranch;

  // Seed wiki
  seedWiki(runRoot, prevRunRoot);

  // Write swarm metadata
  writeFileSync(`${runRoot}/swarm.json`, JSON.stringify({
    swarmId, name: swarm.name, generation: nextGen,
    mode: swarm.mode, createdAt: now, target: 'target.png',
  }, null, 2));

  // Write knowledge file
  const knowledgeContent = db.select().from(schema.wiggumSwarms)
    .where(eq(schema.wiggumSwarms.id, swarmId)).get()?.knowledgeContent || '';
  if (knowledgeContent) {
    writeFileSync(`${runRoot}/KNOWLEDGE.md`, knowledgeContent);
  }

  const newRuns: any[] = [];
  const worktrees: { path: string; port: number; branch: string }[] = [];

  if (swarm.mode === 'multi-path' && paths.length > 0) {
    // ── Multi-path: one worktree + worker per path ──
    for (const path of paths) {
      const port = path.worktreePort || (basePort + path.order);
      const branch = path.worktreeBranch || `fafo-${swarmId.slice(-8)}-${path.name}`;
      const childDir = `${runRoot}/child-${path.name}`;
      const workDir = `${childDir}/work`;
      mkdirSync(childDir, { recursive: true });

      // Create worktree
      try {
        execSync(`cd "${repoDir}" && git worktree add "${workDir}" -b "${branch}-g${nextGen}" ${effectiveBaseBranch} 2>&1 || git worktree add "${workDir}" ${effectiveBaseBranch} --detach 2>&1`, {
          stdio: 'pipe', timeout: 30_000,
        });
      } catch (err: any) {
        console.error(`[fafo] Failed to create worktree for ${path.name}:`, err.message);
        writeFileSync(`${childDir}/error.txt`, err.message);
        continue;
      }

      // Symlink node_modules
      const repoNodeModules = resolve(repoDir, 'node_modules');
      const workNodeModules = resolve(workDir, 'node_modules');
      if (existsSync(repoNodeModules) && !existsSync(workNodeModules)) {
        try { symlinkSync(repoNodeModules, workNodeModules); } catch { /* ignore */ }
      }

      // Update path record with worktree path
      db.update(schema.wiggumSwarmPaths)
        .set({ worktreePath: workDir, worktreePort: port, worktreeBranch: `${branch}-g${nextGen}`, status: 'running', updatedAt: now })
        .where(eq(schema.wiggumSwarmPaths.id, path.id)).run();

      // Start vite on the assigned port
      try {
        const viteProc = spawn('./node_modules/.bin/vite', ['--port', String(port), '--host', '0.0.0.0'], {
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env: { ...process.env, VITE_PORT: String(port) },
        });
        viteProc.unref();
        writeFileSync(`${childDir}/vite.pid`, String(viteProc.pid));
        console.log(`[fafo] Started vite for ${path.name} on port ${port} (pid=${viteProc.pid})`);
      } catch (err: any) {
        console.warn(`[fafo] Failed to start vite for ${path.name}:`, err.message);
      }

      // Write snap.sh for this child
      writeFileSync(`${childDir}/snap.sh`, `#!/usr/bin/env bash
set -e
OUT="$1"
URL="\${2:-http://localhost:${port}/#BMS%20electronics/DB10005_USBSerial.SchDoc?focus=USART1}"
TMP=$(mktemp --suffix=.png)
node /tmp/fafo-runs/snap-port.mjs "$TMP" "$URL"
${path.cropRegion ? (() => {
  try {
    let cr = JSON.parse(path.cropRegion!);
    if (typeof cr === 'string') cr = JSON.parse(cr);
    const [x, y, w, h] = cr;
    return `python3 -c "from PIL import Image; img=Image.open('$TMP'); img.crop((${x},${y},${x + w},${y + h})).save('$OUT')"`;
  } catch { return `cp "$TMP" "$OUT"`; }
})() : `cp "$TMP" "$OUT"`}
rm -f "$TMP"
echo "saved $OUT"
`, { mode: 0o755 });

      // ── Pre-compute baseline screenshot ──
      try {
        // Wait 5 seconds for vite to be ready
        execSync('sleep 5');
        execSync(`bash ${childDir}/snap.sh ${childDir}/baseline.png`, {
          stdio: 'pipe', timeout: 30_000,
        });
        console.log(`[fafo] Baseline screenshot taken for ${path.name}`);
      } catch (err: any) {
        console.warn(`[fafo] Baseline screenshot failed for ${path.name}:`, err.message);
      }

      // ── Determine wiki files relevant to this path ──
      // Dynamic routing: parse task-assignments.md for path-specific tasks,
      // then include wiki files referenced in those assignments.
      const wikiDir = `${runRoot}/wiki`;
      const wikiFilesForPath: string[] = [];
      const allWikiFiles = ['what-works.md', 'what-fails.md', 'coordinates.md', 'style-params.md', 'open-questions.md'];

      try {
        const taskAssignments = readFileSync(`${wikiDir}/task-assignments.md`, 'utf-8');
        const pathNameLower = path.name.toLowerCase();
        // Check if this path has a directed task assignment
        const hasAssignment = taskAssignments.toLowerCase().includes(pathNameLower);
        if (hasAssignment) {
          // Path has specific tasks — give all relevant wiki files
          wikiFilesForPath.push(...allWikiFiles.map(f => `${wikiDir}/${f}`));
        } else {
          // No specific assignment — give core wiki files
          wikiFilesForPath.push(`${wikiDir}/what-works.md`, `${wikiDir}/what-fails.md`);
        }
      } catch {
        // No task assignments yet — give all wiki files
        wikiFilesForPath.push(...allWikiFiles.map(f => `${wikiDir}/${f}`));
      }
      // Always include approach-log so workers don't repeat past attempts
      wikiFilesForPath.push(`${wikiDir}/approach-log.md`);

      // Build prompt from path config + knowledge
      let files: string[] = [];
      if (path.files) {
        try {
          let parsed = JSON.parse(path.files);
          // Handle double-encoded JSON strings
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          files = Array.isArray(parsed) ? parsed : [];
        } catch { files = []; }
      }

      // Extract code snippet if focusLines specified
      let codeSnippetSection = '';
      if (path.focusLines && files.length > 0) {
        const primaryFile = files[0].startsWith('/') ? files[0] : `${workDir}/${files[0]}`;
        if (existsSync(primaryFile)) {
          const snippet = extractLines(primaryFile, path.focusLines);
          if (snippet && snippet !== '(could not extract lines)') {
            codeSnippetSection = `## Current code (lines ${path.focusLines})\n\`\`\`tsx\n${snippet}\n\`\`\``;
          }
        }
      }

      const promptParts = [
        `You are FAFO Gen ${nextGen} worker "${path.name}". You have your OWN vite on port ${port}.`,
        `Edit files ONLY in your worktree at: ${workDir}`,
        '',
        `## IMPORTANT: The code already has harness rendering. Do NOT start from scratch.`,
        `The SchematicRenderer.tsx already renders harness connectors (Layer 11.5), signal harness wires with pill connectors, ports with hexagonal shapes, entry dots, etc. Your job is to REFINE the existing rendering to better match the target image. Do NOT rebuild or remove existing harness code.`,
        '',
        `## Your specific task`,
        path.prompt,
        '',
        files.length > 0 ? `## Focus files\n${files.join('\n')}` : '',
        path.focusLines ? `## Focus lines: ${path.focusLines}` : '',
        codeSnippetSection,
        '',
        `## Wiki knowledge`,
        `Read these wiki files for context:`,
        ...wikiFilesForPath.map(f => `- ${f}`),
        '',
        `## Workflow: Visual Compare → Targeted Fix → Verify`,
        ``,
        `YOUR EYES ARE THE JUDGE. Do NOT compute numeric fitness scores. Use the Read tool to look at images directly.`,
        ``,
        `1. Read the baseline screenshot: ${childDir}/baseline.png`,
        `2. Read the target image: ${runRoot}/target.png`,
        `3. DESCRIBE IN WORDS every visual difference you see between them:`,
        `   - Shape differences (curves, lines, angles)`,
        `   - Position/alignment differences`,
        `   - Size/scale differences`,
        `   - Color/stroke/fill differences`,
        `   - Missing or extra elements`,
        `4. Pick the SINGLE highest-impact visual difference`,
        `5. Make ONE focused edit to fix it in ${workDir}/src/components/SchematicRenderer.tsx`,
        `6. Wait 2 seconds for HMR, then take a screenshot:`,
        `   bash ${childDir}/snap.sh ${childDir}/iter-1.png`,
        `7. Read your new screenshot with the Read tool and compare to target again`,
        `8. If it looks better, keep. If worse, revert: cd ${workDir} && git checkout src/`,
        `9. Repeat steps 4-8 up to 20 times, incrementing the screenshot number each time`,
        `   (iter-1.png, iter-2.png, iter-3.png, etc.)`,
        ``,
        `After EACH iteration, append a line to ${childDir}/iteration-log.md:`,
        `  "Iter N: [what you changed] → [better/worse/same] — [why]"`,
        ``,
        existsSync(`${runRoot}/KNOWLEDGE.md`) ? `## Knowledge from prior generations\nRead ${runRoot}/KNOWLEDGE.md for important context and lessons learned.` : '',
        existsSync(`${runRoot}/wiki/approach-log.md`) ? `## Approach log (DO NOT repeat these)\nRead ${runRoot}/wiki/approach-log.md to see what has already been tried across generations.` : '',
        existsSync(`${runRoot}/wiki/task-assignments.md`) ? `## Directed task assignments\nRead ${runRoot}/wiki/task-assignments.md for specific sub-problems assigned to your path.` : '',
        '',
        `## Output (required)`,
        `1. Write ${childDir}/summary.md — what you tried, what worked, what failed`,
        `2. Write ${childDir}/iteration-log.md — one line per iteration (built up during workflow)`,
        `3. Save code changes: cd ${workDir} && git add -A && git diff HEAD > ${childDir}/changes.diff`,
        `4. Take final screenshot: bash ${childDir}/snap.sh ${childDir}/iter-final.png`,
        `5. Update wiki: ${wikiDir}/what-works.md and ${wikiDir}/what-fails.md with your learnings`,
      ];
      const fullPrompt = promptParts.filter(Boolean).join('\n');
      writeFileSync(`${childDir}/prompt.md`, fullPrompt);

      // Create a wiggum run record
      const runId = ulid();
      const parentRun = survivors[path.order % Math.max(survivors.length, 1)];
      db.insert(schema.wiggumRuns).values({
        id: runId,
        harnessConfigId: swarm.harnessConfigId || null,
        appId: swarm.appId || null,
        prompt: fullPrompt,
        swarmId: swarm.id,
        pathId: path.id,
        generation: nextGen,
        parentRunId: parentRun?.id || null,
        knobs: JSON.stringify({ port, branch: `${branch}-g${nextGen}`, worktree: workDir }),
        status: 'pending',
        currentIteration: 0,
        iterations: '[]',
        maxIterations: 20,
        screenshotDelayMs: 3000,
        createdAt: now,
        updatedAt: now,
      }).run();

      // Dispatch Claude session for this path
      try {
        // Create a feedback item to anchor the agent session
        const fbId = ulid();
        db.insert(schema.feedbackItems).values({
          id: fbId,
          type: 'manual',
          status: 'new',
          title: `FAFO Gen ${nextGen}: ${path.name}`,
          description: `Worker for swarm "${swarm.name}", path "${path.name}"`,
          appId: swarm.appId || null,
          createdAt: now,
          updatedAt: now,
        }).run();

        // Find the default agent endpoint
        const agents = db.select().from(schema.agentEndpoints).all();
        const appAgent = swarm.appId ? agents.find(a => a.isDefault && a.appId === swarm.appId) : null;
        const globalAgent = agents.find(a => a.isDefault && !a.appId);
        const agent = appAgent || globalAgent || agents[0];

        if (!agent) {
          throw new Error('No agent endpoints configured — create one in Settings > Agents');
        }

        const { sessionId } = await dispatchAgentSession({
          feedbackId: fbId,
          agentEndpointId: agent.id,
          prompt: fullPrompt,
          cwd: workDir,
          permissionProfile: 'yolo',
        });

        // Update run with session ID
        db.update(schema.wiggumRuns)
          .set({ status: 'running', sessionId, startedAt: now, updatedAt: now })
          .where(eq(schema.wiggumRuns.id, runId)).run();

        console.log(`[fafo] Dispatched worker "${path.name}" as session ${sessionId}`);
      } catch (err: any) {
        console.error(`[fafo] Failed to dispatch worker for ${path.name}:`, err.message);
        db.update(schema.wiggumRuns)
          .set({ status: 'failed', errorMessage: err.message, updatedAt: now })
          .where(eq(schema.wiggumRuns.id, runId)).run();
      }

      const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, runId)).get();
      if (row) newRuns.push({ ...row, iterations: JSON.parse(row.iterations || '[]') });
      worktrees.push({ path: workDir, port, branch: `${branch}-g${nextGen}` });
    }
  } else {
    // ── Single-mode: fan-out N identical runs with varied knobs ──
    const fanOut = opts.fanOut ?? swarm.fanOut;
    for (let i = 0; i < fanOut; i++) {
      const runId = ulid();
      const parentRun = survivors[i % Math.max(survivors.length, 1)];
      const prompt = swarm.promptFile
        ? `[FAFO Gen ${nextGen}, Slot ${i}] ${swarm.promptFile}`
        : `[FAFO Gen ${nextGen}, Slot ${i}] No prompt configured`;

      db.insert(schema.wiggumRuns).values({
        id: runId,
        harnessConfigId: swarm.harnessConfigId || null,
        appId: swarm.appId || null,
        prompt,
        swarmId: swarm.id,
        generation: nextGen,
        parentRunId: parentRun?.id || null,
        knobs: JSON.stringify({ ...(opts.knobs || {}), slot: i }),
        status: 'pending',
        currentIteration: 0,
        iterations: '[]',
        maxIterations: 20,
        screenshotDelayMs: 3000,
        createdAt: now,
        updatedAt: now,
      }).run();

      if (swarm.harnessConfigId) {
        // Harness-based: start via wiggum controller
        startWiggumRun(runId).catch(err => {
          console.error(`[fafo] Failed to start run ${runId}:`, err.message);
        });
      } else {
        // No harness: dispatch directly via agent session (local or remote launcher)
        try {
          const agents = db.select().from(schema.agentEndpoints).all();
          const appAgent = swarm.appId ? agents.find(a => a.isDefault && a.appId === swarm.appId) : null;
          const globalAgent = agents.find(a => a.isDefault && !a.appId);
          const agent = appAgent || globalAgent || agents[0];
          if (!agent) throw new Error('No agent endpoints configured');

          const fbId = ulid();
          db.insert(schema.feedbackItems).values({
            id: fbId,
            type: 'manual',
            status: 'new',
            title: `FAFO Gen ${nextGen}, Slot ${i}: ${swarm.name}`,
            description: `Single-mode worker for swarm "${swarm.name}"`,
            appId: swarm.appId || null,
            createdAt: now,
            updatedAt: now,
          }).run();

          db.update(schema.wiggumRuns)
            .set({ feedbackId: fbId })
            .where(eq(schema.wiggumRuns.id, runId)).run();

          const { sessionId } = await dispatchAgentSession({
            feedbackId: fbId,
            agentEndpointId: agent.id,
            prompt,
            cwd: repoDir,
            permissionProfile: 'yolo',
          });

          db.update(schema.wiggumRuns)
            .set({ status: 'running', sessionId, startedAt: now, updatedAt: now })
            .where(eq(schema.wiggumRuns.id, runId)).run();

          console.log(`[fafo] Dispatched single-mode worker slot ${i} as session ${sessionId}`);
        } catch (err: any) {
          console.error(`[fafo] Failed to dispatch single-mode worker slot ${i}:`, err.message);
          db.update(schema.wiggumRuns)
            .set({ status: 'failed', errorMessage: err.message, updatedAt: now })
            .where(eq(schema.wiggumRuns.id, runId)).run();
        }
      }

      const row = db.select().from(schema.wiggumRuns).where(eq(schema.wiggumRuns.id, runId)).get();
      if (row) newRuns.push({ ...row, iterations: JSON.parse(row.iterations || '[]') });
    }
  }

  const updatedSwarm = db.select().from(schema.wiggumSwarms)
    .where(eq(schema.wiggumSwarms.id, swarmId)).get();

  return {
    swarm: updatedSwarm,
    generation: nextGen,
    survivors: survivors.map(r => r.id),
    dropped: dropped.map(r => r.id),
    newRuns,
    worktrees,
  };
}

/**
 * Clean up worktrees for a swarm generation.
 */
export function cleanupWorktrees(swarmId: string) {
  const paths = db.select().from(schema.wiggumSwarmPaths)
    .where(eq(schema.wiggumSwarmPaths.swarmId, swarmId)).all();

  for (const path of paths) {
    if (path.worktreePath && existsSync(path.worktreePath)) {
      try {
        // Kill vite if running
        const pidFile = resolve(dirname(path.worktreePath), 'vite.pid');
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
          if (pid) try { process.kill(pid); } catch { /* already dead */ }
        }
        // Remove worktree
        const repoDir = resolve(path.worktreePath, '..', '..'); // guess repo parent
        execSync(`git -C "${repoDir}" worktree remove "${path.worktreePath}" --force 2>/dev/null || rm -rf "${path.worktreePath}"`, {
          stdio: 'pipe', timeout: 15_000,
        });
      } catch (err: any) {
        console.warn(`[fafo] Cleanup failed for ${path.name}:`, err.message);
      }
    }
  }
}

/**
 * Unified meta-optimizer: runs via `claude -p` CLI call (~60-90s) instead of
 * dispatching a full Claude session (~10min). Replaces both the old aggregator
 * and meta-manager. Reads all worker screenshots + target visually, identifies
 * best worker, writes directed task assignments for next gen.
 */
async function runMetaOptimizer(swarmId: string, runRoot: string): Promise<{
  bestWorker: string | null;
  score: number;
}> {
  const swarm = db.select().from(schema.wiggumSwarms)
    .where(eq(schema.wiggumSwarms.id, swarmId)).get();
  if (!swarm) return { bestWorker: null, score: 0 };

  const currentGen = swarm.generationCount;
  const wikiDir = `${runRoot}/wiki`;

  // Collect child directories
  const childDirs: string[] = [];
  try {
    const entries = execSync(`ls -d ${runRoot}/child-* 2>/dev/null || true`, { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    childDirs.push(...entries);
  } catch { /* ignore */ }

  if (childDirs.length === 0) return { bestWorker: null, score: 0 };

  // Collect worker summaries and iteration logs
  const workerSections: string[] = [];
  const screenshotPaths: string[] = [];
  for (const childDir of childDirs) {
    const name = childDir.split('/').pop()?.replace('child-', '') || 'unknown';
    let summary = '', iterLog = '', codeDiff = '';

    try { summary = readFileSync(`${childDir}/summary.md`, 'utf-8'); } catch { summary = '(no summary)'; }
    try { iterLog = readFileSync(`${childDir}/iteration-log.md`, 'utf-8'); } catch { iterLog = '(no log)'; }

    // Collect git diff
    try {
      const diffPath = `${childDir}/changes.diff`;
      if (existsSync(diffPath)) {
        const raw = readFileSync(diffPath, 'utf-8');
        codeDiff = raw.length > 3000 ? raw.slice(0, 3000) + '\n...(truncated)' : raw;
      } else {
        const workDir = `${childDir}/work`;
        if (existsSync(workDir)) {
          try {
            const diff = execSync(`cd "${workDir}" && git diff HEAD 2>/dev/null || true`, { encoding: 'utf-8', timeout: 10_000 }).trim();
            if (diff) {
              writeFileSync(diffPath, diff);
              codeDiff = diff.length > 3000 ? diff.slice(0, 3000) + '\n...(truncated)' : diff;
            }
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    // Find best screenshot for this worker
    const finalScreenshot = existsSync(`${childDir}/iter-final.png`) ? `${childDir}/iter-final.png` :
      (() => {
        try {
          const pngs = execSync(`ls ${childDir}/iter-*.png 2>/dev/null || ls ${childDir}/after*.png 2>/dev/null || true`, { encoding: 'utf-8' })
            .trim().split('\n').filter(Boolean);
          return pngs.length > 0 ? pngs[pngs.length - 1] : `${childDir}/baseline.png`;
        } catch { return `${childDir}/baseline.png`; }
      })();
    screenshotPaths.push(finalScreenshot);

    workerSections.push([
      `### Worker: ${name}`,
      `Final screenshot: ${finalScreenshot}`,
      `Summary: ${summary}`,
      `Iteration log: ${iterLog}`,
      codeDiff ? `Code changes:\n\`\`\`diff\n${codeDiff}\n\`\`\`` : '',
    ].filter(Boolean).join('\n'));
  }

  // Collect human feedback
  let humanFeedback = '';
  try {
    const feedback = db.select().from(schema.fafoFeedback)
      .where(eq(schema.fafoFeedback.swarmId, swarmId))
      .all()
      .filter(f => f.generation === currentGen || f.generation === null);
    if (feedback.length > 0) {
      humanFeedback = '\n## Human Feedback (PRIORITY)\n' +
        feedback.map(f => {
          const rating = f.rating === 1 ? 'GOOD' : f.rating === -1 ? 'BAD' : 'NEUTRAL';
          return `- ${rating}: ${f.annotation || '(no annotation)'}`;
        }).join('\n');
    }
  } catch { /* ignore */ }

  // Read current wiki
  const wikiFiles = ['what-works.md', 'what-fails.md', 'approach-log.md', 'task-assignments.md'];
  const wikiContent = wikiFiles.map(f => {
    try { return `### ${f}\n${readFileSync(`${wikiDir}/${f}`, 'utf-8')}`; }
    catch { return ''; }
  }).filter(Boolean).join('\n\n');

  // Get paths for task assignment
  const paths = db.select().from(schema.wiggumSwarmPaths)
    .where(eq(schema.wiggumSwarmPaths.swarmId, swarmId))
    .all()
    .sort((a, b) => a.order - b.order);
  const pathNames = paths.map(p => p.name).join(', ');

  // Check for convergence history
  let convergenceHistory = '';
  try {
    const parentDir = '/tmp/fafo-runs';
    for (let g = Math.max(1, currentGen - 3); g < currentGen; g++) {
      const prefix = `swarm-${swarmId.slice(-8)}-gen${g}-`;
      const prevDirs = execSync(`ls -d ${parentDir}/${prefix}* 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      if (prevDirs.length > 0) {
        const verdictPath = `${prevDirs[prevDirs.length - 1]}/meta-verdict.json`;
        if (existsSync(verdictPath)) {
          try {
            const v = JSON.parse(readFileSync(verdictPath, 'utf-8'));
            convergenceHistory += `Gen ${g}: score=${v.score}, best=${v.best_worker}\n`;
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  // Build meta-optimizer prompt
  const metaPrompt = [
    `You are the FAFO Meta-Optimizer for Gen ${currentGen} of swarm "${swarm.name}".`,
    `Your job: visually compare all worker results to the target, identify the best, and direct next generation.`,
    ``,
    `## STEP 1: Visual Comparison`,
    `Read the target image and ALL worker final screenshots with the Read tool.`,
    `- Target: ${runRoot}/target.png`,
    ...screenshotPaths.map((p, i) => `- Worker ${childDirs[i]?.split('/').pop()?.replace('child-', '') || i}: ${p}`),
    ``,
    `## STEP 2: Worker Results`,
    ...workerSections,
    humanFeedback,
    ``,
    convergenceHistory ? `## Convergence History (last 3 gens)\n${convergenceHistory}` : '',
    `## Current Wiki\n${wikiContent}`,
    ``,
    `## STEP 3: Your Tasks`,
    `After reading ALL images:`,
    ``,
    `1. Which worker's output is VISUALLY closest to the target? Why?`,
    `2. What specific visual differences remain between the best worker and target?`,
    `3. Write ${wikiDir}/what-works.md — distilled, deduplicated techniques that helped`,
    `4. Write ${wikiDir}/what-fails.md — approaches that made things worse and WHY`,
    `5. Append to ${wikiDir}/approach-log.md — all approaches tried this gen:`,
    `   "Gen ${currentGen} / <worker>: <approach> → <better/worse/same>"`,
    `6. Write ${wikiDir}/task-assignments.md — SPECIFIC directed sub-tasks for next gen:`,
    `   ## Task: <name>`,
    `   - Assigned to: <path-name from: ${pathNames}>`,
    `   - What to fix: <specific visual difference>`,
    `   - What to try: <specific code change with values>`,
    `   - What NOT to try: <failed approaches>`,
    `7. Write ${runRoot}/meta-verdict.json with ONLY valid JSON:`,
    `   {"best_worker": "<name>", "score": <0-100>, "remaining_diffs": ["diff1", ...], "strategy": "<next gen strategy>", "plateau": <true if score hasn't improved in 3 gens>}`,
    ``,
    `## Rules`,
    `- LOOK at the images. Visual comparison is the primary evaluation method.`,
    `- Be specific: exact parameter values, pixel coordinates, CSS properties.`,
    `- Human feedback overrides everything else.`,
    convergenceHistory.includes('plateau') ? `- PLATEAU DETECTED: Pivot strategy significantly. Try a completely different approach.` : '',
  ].filter(Boolean).join('\n');

  // Write prompt for debugging
  writeFileSync(`${runRoot}/meta-optimizer-prompt.md`, metaPrompt);

  // Run via claude CLI — synchronous, ~60-90s
  console.log(`[fafo] Running meta-optimizer for gen ${currentGen} via claude CLI...`);
  try {
    const escaped = metaPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$');
    execSync(
      `claude -p "${escaped}" --max-turns 8 --allowedTools "Read,Write"`,
      { encoding: 'utf-8', timeout: 300_000, cwd: runRoot },
    );
    console.log(`[fafo] Meta-optimizer completed for gen ${currentGen}`);
  } catch (err: any) {
    console.error(`[fafo] Meta-optimizer CLI failed:`, err.message?.slice(0, 500));
    // Write fallback verdict
    writeFileSync(`${runRoot}/meta-verdict.json`, JSON.stringify({
      best_worker: childDirs[0]?.split('/').pop()?.replace('child-', '') || 'unknown',
      score: 0,
      remaining_diffs: ['meta-optimizer failed'],
      strategy: 'retry with same approach',
      plateau: false,
    }));
  }

  // Read verdict
  try {
    const verdict = JSON.parse(readFileSync(`${runRoot}/meta-verdict.json`, 'utf-8'));
    return { bestWorker: verdict.best_worker, score: verdict.score ?? 0 };
  } catch {
    return { bestWorker: null, score: 0 };
  }
}

/**
 * Poll running swarms and auto-advance to the next generation when all
 * runs complete. Uses synchronous meta-optimizer (claude CLI) instead of
 * async aggregator sessions — no waiting between generations.
 */
let pollerRunning = false;
export function startFAFOPoller(intervalMs = 15_000) {
  if (pollerRunning) return;
  pollerRunning = true;
  console.log(`[fafo] Auto-advance poller started (every ${intervalMs / 1000}s)`);

  setInterval(async () => {
    try {
      const swarms = db.select().from(schema.wiggumSwarms)
        .where(eq(schema.wiggumSwarms.status, 'running'))
        .all();

      for (const swarm of swarms) {
        const maxGen = (swarm as any).maxGenerations;
        if (maxGen == null) continue; // manual-only swarm
        if (swarm.generationCount >= maxGen) {
          db.update(schema.wiggumSwarms)
            .set({ status: 'completed', updatedAt: new Date().toISOString() })
            .where(eq(schema.wiggumSwarms.id, swarm.id)).run();
          console.log(`[fafo] Swarm "${swarm.name}" reached max generation ${maxGen}, marking completed`);
          continue;
        }

        // Check if all runs in current generation are done
        const currentRuns = db.select().from(schema.wiggumRuns)
          .where(eq(schema.wiggumRuns.swarmId, swarm.id))
          .all()
          .filter(r => r.generation === swarm.generationCount);

        if (currentRuns.length === 0) continue;

        // Sync run status from session status
        for (const run of currentRuns) {
          if (run.status !== 'running' || !run.sessionId) continue;
          try {
            const resp = await fetch(`http://localhost:3001/api/v1/admin/agent-sessions/${run.sessionId}`);
            const sess = await resp.json() as any;
            if (sess.status === 'completed' || sess.status === 'failed' || sess.status === 'killed') {
              const newStatus = sess.status === 'completed' ? 'completed' : 'failed';
              db.update(schema.wiggumRuns)
                .set({ status: newStatus, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
                .where(eq(schema.wiggumRuns.id, run.id)).run();
              run.status = newStatus;
            }
          } catch { /* session-service may be unavailable */ }
        }

        const allDone = currentRuns.every(r =>
          r.status === 'completed' || r.status === 'failed' || r.status === 'killed'
        );
        if (!allDone) continue;

        // All workers done — run meta-optimizer synchronously, then advance
        console.log(`[fafo] Swarm "${swarm.name}" gen ${swarm.generationCount} complete (${currentRuns.length} runs), running meta-optimizer...`);

        try {
          const parentDir = '/tmp/fafo-runs';
          const prefix = `swarm-${swarm.id.slice(-8)}-gen${swarm.generationCount}-`;
          const entries = execSync(`ls -d ${parentDir}/${prefix}* 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
          if (entries.length > 0) {
            const runRoot = entries[entries.length - 1];
            const { bestWorker, score } = await runMetaOptimizer(swarm.id, runRoot);

            console.log(`[fafo] Meta-optimizer verdict: best=${bestWorker}, score=${score}`);

            // Convergence check
            if (score >= 90) {
              db.update(schema.wiggumSwarms)
                .set({ status: 'completed', updatedAt: new Date().toISOString() })
                .where(eq(schema.wiggumSwarms.id, swarm.id)).run();
              console.log(`[fafo] Swarm "${swarm.name}" CONVERGED at score ${score}!`);
              continue;
            }
          }

          // Advance to next generation
          await startFAFOGeneration(swarm.id, { keepCount: 1 });
        } catch (err: any) {
          console.error(`[fafo] Auto-advance failed for swarm "${swarm.name}":`, err.message);
        }
      }
    } catch (err: any) {
      console.error(`[fafo] Poller error:`, err.message);
    }
  }, intervalMs);
}
