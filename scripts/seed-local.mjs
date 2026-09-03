#!/usr/bin/env node
//
// Register the local checkout as a Propanes application plus one claude and one
// codex yolo agent endpoint, then report whether those runtimes can actually
// dispatch. Idempotent: matches on name, patches instead of duplicating.
//
//   node scripts/seed-local.mjs [--port 3001] [--profile interactive-yolo]

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = flag('port', process.env.PORT || '3001');
const BASE = `http://localhost:${PORT}`;
const PROFILE = flag('profile', 'interactive-yolo');
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin';
const APP_NAME = flag('app-name', 'ProPanes Admin');

const C = process.stdout.isTTY
  ? { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m' }
  : { b: '', d: '', g: '', y: '', r: '', x: '' };
const ok = (m) => console.log(`  ${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`  ${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`  ${C.r}✗${C.x} ${m}`);
const info = (m) => console.log(`    ${C.d}${m}${C.x}`);

let token;
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const detail = typeof json === 'string' ? json : JSON.stringify(json);
    throw new Error(`${method} ${path} -> ${res.status} ${detail}`);
  }
  return json;
}

const PROMPT_TEMPLATE = [
  'You are working on {{app.name}} ({{app.projectDir}}).',
  '',
  'App description: {{app.description}}',
  '',
  'A user reported feedback from their browser session at {{session.url}} (viewport {{session.viewport}}).',
  '',
  'Title: {{feedback.title}}',
  'Description: {{feedback.description}}',
  '',
  'Console logs:',
  '{{feedback.consoleLogs}}',
  '',
  'Network errors:',
  '{{feedback.networkErrors}}',
  '',
  'Custom data:',
  '{{feedback.data}}',
  '',
  'Tags: {{feedback.tags}}',
  '',
  'Additional instructions:',
  '{{instructions}}',
  '',
  `The ProPanes server is at ${BASE}. The browser session may still be live -- inspect and drive it`,
  `via ${BASE}/api/v1/agent/sessions/<sessionId>/ (screenshot, dom, execute, mouse/click, keyboard/type, batch, waitFor).`,
  '',
  'Available hooks the app exposes: {{app.hooks}}',
].join('\n');

function which(bin) {
  try { return execFileSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// ---------- agent runtime readiness ----------

function reportClaude(projectDir) {
  const bin = which('claude');
  if (!bin) {
    bad('claude CLI not installed — claude endpoints cannot dispatch');
    info('install: https://claude.com/download');
    return;
  }
  ok(`claude CLI at ${bin}`);

  let cfg;
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')); }
  catch { warn('~/.claude.json unreadable — run `claude` once to finish first-run setup'); return; }

  if (!cfg.oauthAccount && !process.env.ANTHROPIC_API_KEY) {
    warn('claude is not logged in — run `claude` and sign in, or set ANTHROPIC_API_KEY');
  } else {
    ok('claude is authenticated');
  }

  // Two first-run gates block an unattended yolo session. Propanes detects them
  // and surfaces the session as waiting, but it cannot answer them for you.
  const proj = cfg.projects?.[projectDir];
  if (proj?.hasTrustDialogAccepted) {
    ok(`project folder trusted (${projectDir})`);
  } else {
    warn(`"trust this folder" not yet accepted for ${projectDir}`);
    info(`accept it once: (cd ${projectDir} && claude)`);
  }

  if (PROFILE.endsWith('-yolo')) {
    // Two independent ways to clear the Bypass Permissions gate: the one-time
    // acceptance recorded in ~/.claude.json, or skipDangerousModePermissionPrompt
    // in any settings.json that applies here. Checking only the former reports a
    // false warning on machines configured with the latter.
    const settingsFiles = [
      join(homedir(), '.claude', 'settings.json'),
      join(projectDir, '.claude', 'settings.json'),
      join(projectDir, '.claude', 'settings.local.json'),
    ];
    const skipViaSettings = settingsFiles.find((f) => {
      try { return JSON.parse(readFileSync(f, 'utf8')).skipDangerousModePermissionPrompt === true; }
      catch { return false; }
    });

    if (cfg.bypassPermissionsModeAccepted) {
      ok('Bypass Permissions mode accepted — yolo sessions start unattended');
    } else if (skipViaSettings) {
      ok(`Bypass Permissions prompt disabled via ${skipViaSettings}`);
    } else {
      warn('Bypass Permissions mode not accepted — the first yolo session will stall on a prompt');
      info(`accept it once:  (cd ${projectDir} && claude --dangerously-skip-permissions)`);
      info('or set "skipDangerousModePermissionPrompt": true in ~/.claude/settings.json');
      info('until then the session shows as waiting-for-input in the dashboard');
    }
  }
}

function reportCodex(projectDir) {
  const bin = which('codex');
  if (!bin) {
    bad('codex CLI not installed — codex endpoints cannot dispatch');
    info('install: npm i -g @openai/codex');
    return;
  }
  ok(`codex CLI at ${bin}`);
  const authPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  try {
    readFileSync(authPath);
    ok('codex is authenticated');
  } catch {
    warn('codex does not look logged in — run `codex login`');
  }
}

// ---------- main ----------

async function main() {
  console.log(`\n${C.b}Seeding ${BASE}${C.x}`);

  ({ token } = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { username: USER, password: PASS },
  }));
  ok(`authenticated as ${USER}`);

  // --- application ---
  const apps = await api('/api/v1/admin/applications');
  let app = apps.find((a) => a.name === APP_NAME);
  const appBody = {
    name: APP_NAME,
    projectDir: REPO_ROOT,
    serverUrl: `${BASE}/admin/`,
    description:
      'The ProPanes admin dashboard itself (Preact SPA served at /admin/). Dogfooding target: ' +
      'feedback filed here is about the ProPanes admin UI. Monorepo layout: admin SPA in ' +
      'packages/admin, Hono API + session service in packages/server, embeddable overlay in ' +
      'packages/widget, shared types and Zod schemas in packages/shared.',
    hooks: [],
  };

  if (app) {
    ok(`application "${APP_NAME}" already registered (${app.id})`);
  } else {
    const created = await api('/api/v1/admin/applications', { method: 'POST', body: appBody });
    app = { ...appBody, id: created.id, apiKey: created.apiKey };
    ok(`application "${APP_NAME}" created (${app.id})`);
  }

  // POST /applications validates defaultPermissionProfile but never persists
  // it -- only PATCH writes that column. Always follow up so the app's default
  // matches the profile we seeded the endpoints with.
  await api(`/api/v1/admin/applications/${app.id}`, {
    method: 'PATCH',
    body: { defaultPermissionProfile: PROFILE },
  });
  ok(`default permission profile: ${PROFILE}`);

  // --- agent endpoints ---
  // runMigrations() seeds the shared presets (Claude Interactive, Claude YOLO,
  // Codex YOLO) with app_id NULL. Endpoints are dispatch configuration, not
  // app-owned resources, so every app can use them -- creating per-app copies
  // here would just clutter the picker with duplicates. Verify they exist and
  // only create one if this server predates that seeding.
  const endpoints = await api('/api/v1/admin/agents');
  for (const [runtime, fallbackName] of [['claude', 'Claude YOLO'], ['codex', 'Codex YOLO']]) {
    const shared = endpoints.find(
      (e) => !e.appId && e.runtime === runtime && e.permissionProfile === PROFILE,
    );
    if (shared) {
      ok(`shared "${shared.name}" endpoint available (${runtime}, ${PROFILE})`);
      continue;
    }
    const created = await api('/api/v1/admin/agents', {
      method: 'POST',
      body: {
        name: fallbackName,
        runtime,
        mode: 'interactive',
        permissionProfile: PROFILE,
        isDefault: false,
        promptTemplate: PROMPT_TEMPLATE,
        isolation: 'shared',
      },
    });
    ok(`shared "${fallbackName}" endpoint created (${created.id})`);
  }

  console.log(`\n${C.b}Agent runtime readiness${C.x}`);
  reportClaude(REPO_ROOT);
  reportCodex(REPO_ROOT);

  if (app.apiKey) {
    console.log(`\n${C.b}Widget snippet${C.x}`);
    console.log(`  <script src="${BASE}/widget/propanes.js"`);
    console.log(`    data-endpoint="${BASE}"`);
    console.log(`    data-app-key="${app.apiKey}"></script>`);
  }
}

main().catch((err) => {
  console.error(`\n${C.r}seed failed:${C.x} ${err.message}`);
  process.exit(1);
});
