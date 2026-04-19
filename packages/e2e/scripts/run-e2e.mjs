#!/usr/bin/env node
// Boots the propanes server against a temp SQLite DB on a free port,
// seeds a minimal app + feedback fixtures via the admin API, runs the
// Playwright suite, then tears the server down. Real infra, real DB —
// no mocks (per packages/e2e/README.md and the project test policy).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const E2E_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(E2E_DIR, '..', '..');
const SERVER_DIR = resolve(REPO_ROOT, 'packages', 'server');

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'e2e-admin-pass';

const passthroughArgs = process.argv.slice(2);

function findFreePort() {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectP);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolveP(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server health check timed out: ${lastErr?.message || 'no response'}`);
}

async function seed(baseUrl) {
  // 1. Login → admin token
  const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!loginRes.ok) {
    throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { token } = await loginRes.json();

  const authJson = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // 2. Create application (Propanes Admin under test)
  const appRes = await fetch(`${baseUrl}/api/v1/admin/applications`, {
    method: 'POST',
    headers: authJson,
    body: JSON.stringify({
      name: 'Propanes Admin (E2E)',
      projectDir: REPO_ROOT,
      description: 'E2E baseline harness target — auto-seeded on each run',
      hooks: [],
    }),
  });
  if (!appRes.ok) throw new Error(`app create failed: ${appRes.status} ${await appRes.text()}`);
  const { id: appId, apiKey } = await appRes.json();

  // 3. Create a default agent endpoint so DispatchDialog has something to render
  const agentRes = await fetch(`${baseUrl}/api/v1/admin/agents`, {
    method: 'POST',
    headers: authJson,
    body: JSON.stringify({
      name: 'E2E Local Agent',
      mode: 'interactive',
      permissionProfile: 'interactive',
      isDefault: true,
      appId,
    }),
  });
  if (!agentRes.ok) {
    // Not fatal — log and continue
    console.warn(`[e2e] agent create non-fatal failure: ${agentRes.status} ${await agentRes.text()}`);
  }

  // 4. Seed three feedback items
  const feedbackTitles = [
    'Baseline: empty card overflows on mobile',
    'Baseline: dispatch button alignment off in modal',
    'Baseline: structured view scroll jitter on long output',
  ];
  const feedbackIds = [];
  for (const title of feedbackTitles) {
    const fbRes = await fetch(`${baseUrl}/api/v1/admin/feedback`, {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({
        title,
        description: 'Seeded by `npm run test:e2e` — used as a stable target for golden-path tests.',
        type: 'manual',
        appId,
        tags: ['e2e', 'baseline'],
      }),
    });
    if (!fbRes.ok) throw new Error(`feedback create failed: ${fbRes.status} ${await fbRes.text()}`);
    const { id } = await fbRes.json();
    feedbackIds.push(id);
  }

  return { token, appId, apiKey, feedbackIds };
}

async function main() {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const tmpRoot = mkdtempSync(join(tmpdir(), 'propanes-e2e-'));
  const dbPath = join(tmpRoot, 'propanes-e2e.db');
  const uploadDir = join(tmpRoot, 'uploads');

  console.log(`[e2e] tmp dir: ${tmpRoot}`);
  console.log(`[e2e] booting server on ${baseUrl}`);

  // Run via `tsx` directly (no --watch) so we get a single deterministic
  // process. dev:server uses `tsx watch` which would restart on disk changes.
  const child = spawn(
    'npx',
    ['tsx', 'src/index.ts'],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        UPLOAD_DIR: uploadDir,
        ADMIN_USER,
        ADMIN_PASS,
        JWT_SECRET: 'e2e-jwt-secret-do-not-use-in-prod',
        NODE_ENV: 'test',
        NODE_OPTIONS: '--conditions=@propanes/source',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  );

  let cleaning = false;
  let exitCode = 1;
  const cleanup = (signal) => {
    if (cleaning) return;
    cleaning = true;
    try {
      if (!child.killed) child.kill(signal || 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
      // exitCode is set explicitly in main(); never let cleanup() override
      // it to 0 just because the server child exited gracefully.
      process.exit(exitCode);
    }, 500).unref();
  };

  process.on('SIGINT', () => { exitCode = 130; cleanup('SIGINT'); });
  process.on('SIGTERM', () => { exitCode = 143; cleanup('SIGTERM'); });
  child.on('exit', (code) => {
    if (!cleaning) {
      console.error(`[e2e] server exited unexpectedly with code ${code}`);
      exitCode = code ?? 1;
      cleanup();
    }
  });

  try {
    await waitForHealth(baseUrl, 30_000);
    console.log('[e2e] server up — seeding fixtures');
    const seedResult = await seed(baseUrl);
    console.log(`[e2e] seeded appId=${seedResult.appId} feedback=${seedResult.feedbackIds.length}`);

    const useUi = passthroughArgs.includes('--ui');
    const headed = passthroughArgs.includes('--headed');
    const update = passthroughArgs.includes('--update-snapshots');
    const extraArgs = passthroughArgs.filter(
      (a) => a !== '--ui' && a !== '--headed' && a !== '--update-snapshots'
    );

    const playwrightArgs = [
      'playwright',
      'test',
      ...(useUi ? ['--ui'] : []),
      ...(headed ? ['--headed'] : []),
      ...(update ? ['--update-snapshots'] : []),
      ...extraArgs,
    ];

    const result = await new Promise((resolveP) => {
      const pw = spawn('npx', playwrightArgs, {
        cwd: E2E_DIR,
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_BASE_URL: baseUrl,
          E2E_APP_ID: seedResult.appId,
          E2E_API_KEY: seedResult.apiKey,
          E2E_ADMIN_USER: ADMIN_USER,
          E2E_ADMIN_PASS: ADMIN_PASS,
          E2E_FEEDBACK_IDS: seedResult.feedbackIds.join(','),
        },
      });
      pw.on('exit', (code) => resolveP(code ?? 1));
    });

    exitCode = result;
    cleanup(exitCode === 0 ? 'SIGTERM' : 'SIGTERM');
  } catch (err) {
    console.error('[e2e] orchestrator error:', err);
    exitCode = 1;
    cleanup();
  }
}

main();
